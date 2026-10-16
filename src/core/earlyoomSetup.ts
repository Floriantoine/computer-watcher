// Installation / activation d'earlyoom depuis l'app (B8 bis) : logique pure partagée par le main et le renderer.
import { buildEarlyoomArgs, buildEarlyoomLine, checkRegexPart, EARLYOOM_MAX_PREFER, ignoreFromLine, mergeIgnore, type EarlyoomSettings } from './earlyoom';

/** Seul paramètre de mode accepté du renderer et transmis au script root, comparé à l'identique (jamais interprété). */
export type EarlyoomSetupMode = 'install' | 'activate';
export const isSetupMode = (x: unknown): x is EarlyoomSetupMode => x === 'install' || x === 'activate';

/** `systemctl is-enabled earlyoom` réduit à ce qui compte ici. */
export type EarlyoomEnabled = 'enabled' | 'disabled' | 'masked' | 'other' | 'unknown';

export interface EarlyoomServiceState {
  installed: boolean;
  active: 'active' | 'inactive' | 'failed' | 'unknown';
  enabled: EarlyoomEnabled;
}

/**
 * Processus Node récents (jest, tsc, eslint, nest… lancés par npx / node 22+) : leur nom système (comm) est « MainThread »,
 * pas « node » ni « jest » — c'est ce que compare earlyoom. Avec tsc et eslint, tués en premier (gel du 15/10/2026 : des
 * onglets de 10 Mo tués pendant que des jest de 4 Go continuaient). Ajoutés par la mise à niveau des installations existantes.
 */
export const EARLYOOM_ANTIGEL_PREFER: readonly string[] = Object.freeze(['MainThread', 'tsc', 'eslint']);
/**
 * Processus préférés par earlyoom (tués en premier : les relancer ne coûte rien). Noms tels que /proc les donne
 * (15 caractères au plus, caractères spéciaux en « . »).
 */
export const EARLYOOM_TEST_PREFER: readonly string[] = Object.freeze([
  ...EARLYOOM_ANTIGEL_PREFER,
  'vitest', 'node..vitest.', 'jest', 'pytest', 'playwright', 'cypress', 'mocha', 'karma', 'headless_shell', 'chrome-headless',
]);
/** Seuil SIGTERM mémoire recommandé (%) : earlyoom réagissait trop tard à 8 %. */
export const EARLYOOM_RECOMMENDED_MEM_TERM = 10;
/** Valeurs par défaut de la ligne (formulaire de Réglages › earlyoom et installation) : 10,5 / 35,25, processus préférés. */
export const EARLYOOM_DEFAULT_SETTINGS: Readonly<EarlyoomSettings> = Object.freeze({
  memTerm: EARLYOOM_RECOMMENDED_MEM_TERM, memKill: 5, swapTerm: 35, swapKill: 25, prefer: [...EARLYOOM_TEST_PREFER],
});
/** Anciens défauts recommandés par l'app, du plus ancien au plus récent (reconnus tels quels par la mise à niveau). */
export const EARLYOOM_PREVIOUS_DEFAULTS: readonly Readonly<EarlyoomSettings>[] = Object.freeze([
  Object.freeze({ memTerm: 8, memKill: 5, swapTerm: 35, swapKill: 25, prefer: [] as string[] }),
  Object.freeze({
    memTerm: 8, memKill: 5, swapTerm: 35, swapKill: 25,
    prefer: ['vitest', 'node..vitest.', 'jest', 'pytest', 'playwright', 'cypress', 'mocha', 'karma', 'headless_shell', 'chrome-headless'],
  }),
]);

/** Proposition « Protection anti-gel à mettre à jour » : réglages fusionnés et ce qui change (pour l'affichage). */
export interface EarlyoomUpgrade {
  /** Réglages identiques à un ancien défaut recommandé. */
  oldDefaults: boolean;
  /** Motifs recommandés ajoutés en tête des préférences (ceux de l'utilisateur suivent, tous, dans leur ordre). */
  addedPrefer: string[];
  /** SIGTERM mémoire monté (jamais abaissé), ou null. */
  memTerm: { from: number; to: number } | null;
  settings: EarlyoomSettings;
}

const sameSettings = (a: Readonly<EarlyoomSettings>, b: Readonly<EarlyoomSettings>): boolean =>
  a.memTerm === b.memTerm && a.memKill === b.memKill && a.swapTerm === b.swapTerm && a.swapKill === b.swapKill &&
  a.prefer.length === b.prefer.length && a.prefer.every((p, i) => p === b.prefer[i]);

/** Le motif --prefer de l'utilisateur correspond-il déjà à ce nom (ex. « Main.* » couvre « MainThread ») ? */
function coveredBy(prefer: readonly string[]): (name: string) => boolean {
  if (!prefer.length) return () => false;
  // Motifs déjà validés par la politique (jetons [A-Za-z0-9_.-]+ suivis ou non de « .* ») : la regex compile toujours.
  const re = new RegExp(`^(${prefer.join('|')})$`);
  return (name) => re.test(name);
}

/**
 * Détection « à mettre à jour » sur la ligne lue dans /etc/default/earlyoom (sans privilège). Seulement si la ligne respecte
 * la politique de l'app (sinon : écrite à la main ou illisible, on ne propose rien), et si ses réglages sont un ancien défaut
 * recommandé ou si MainThread, tsc ou eslint n'y sont pas visés. Fusion : motifs recommandés manquants ajoutés en tête,
 * ceux de l'utilisateur gardés ; SIGTERM mémoire monté à 10 s'il est plus bas ; rien d'autre ne change.
 * Si les 30 motifs ne laissent pas la place à toute la liste : seulement MainThread, tsc, eslint ; sinon rien.
 */
export function earlyoomUpgrade(file: { settings: EarlyoomSettings; line: string } | null): EarlyoomUpgrade | null {
  const kept = file ? ignoreFromLine(file.line) : null;
  if (!file || kept === null) return null;
  const s = file.settings;
  // Motif de plus de 100 caractères (accepté par la grammaire, refusé à la reconstruction) : proposition jamais applicable.
  if ([...kept, ...s.prefer].some((t) => checkRegexPart(t) !== null)) return null;
  const covered = coveredBy(s.prefer);
  const oldDefaults = EARLYOOM_PREVIOUS_DEFAULTS.some((d) => sameSettings(d, s));
  const antigelMissing = EARLYOOM_ANTIGEL_PREFER.filter((p) => !covered(p));
  if (!oldDefaults && antigelMissing.length === 0) return null;
  const allMissing = EARLYOOM_TEST_PREFER.filter((p) => !covered(p));
  const addedPrefer = s.prefer.length + allMissing.length <= EARLYOOM_MAX_PREFER ? allMissing
    : s.prefer.length + antigelMissing.length <= EARLYOOM_MAX_PREFER ? antigelMissing
      : null;
  if (addedPrefer === null) return null;
  const memTerm = s.memTerm < EARLYOOM_RECOMMENDED_MEM_TERM ? { from: s.memTerm, to: EARLYOOM_RECOMMENDED_MEM_TERM } : null;
  if (addedPrefer.length === 0 && memTerm === null) return null;
  return {
    oldDefaults,
    addedPrefer: [...addedPrefer],
    memTerm,
    settings: { ...s, memTerm: memTerm ? memTerm.to : s.memTerm, prefer: [...addedPrefer, ...s.prefer] },
  };
}

/**
 * Ligne de la mise à niveau : réglages fusionnés, exclusions du fichier toutes gardées telles quelles (jamais retirées),
 * suivies des noms de la liste protégée qui y manquent. Validée par la même politique que le script root.
 */
export function upgradeLine(
  file: { settings: EarlyoomSettings; line: string } | null,
  protectedList: readonly string[],
): { ok: true; line: string; upgrade: EarlyoomUpgrade } | { ok: false; errors: string[] } {
  const upgrade = earlyoomUpgrade(file);
  const kept = file ? ignoreFromLine(file.line) : null;
  if (!upgrade || !kept) return { ok: false, errors: ['Rien à mettre à jour'] };
  const built = buildEarlyoomLine(upgrade.settings, mergeIgnore(kept, protectedList));
  return built.ok ? { ok: true, line: built.line, upgrade } : built;
}

/** Ce que change la mise à niveau, en clair (confirmation native, carte de Réglages, pop-up). */
export function upgradeChanges(u: EarlyoomUpgrade): string[] {
  return [
    ...(u.addedPrefer.length ? [`Tués en premier : ${u.addedPrefer.join(', ')} (vos motifs restent).`] : []),
    ...(u.memTerm ? [`SIGTERM dès ${u.memTerm.to} % de mémoire disponible (${u.memTerm.from} % → ${u.memTerm.to} %) : earlyoom réagit avant le gel.`] : []),
    'Aucune exclusion retirée (terminaux, Claude, session, liste protégée) ; vos autres réglages restent.',
  ];
}

/** Mise à niveau à proposer : earlyoom installé, actif et lancé au démarrage (ni à installer, ni à activer, ni masqué). */
export function upgradeNeed(s: EarlyoomServiceState & { file?: { settings: EarlyoomSettings; line: string } | null }): EarlyoomUpgrade | null {
  if (!s.installed || s.active !== 'active' || s.enabled === 'masked' || setupNeed(s) !== null) return null;
  return earlyoomUpgrade(s.file ?? null);
}

/** Ce que le pop-up du lancement propose : installation, activation (script root d'installation) ou mise à niveau (« Appliquer »). */
export type EarlyoomReminderKind = EarlyoomSetupMode | 'upgrade';

/**
 * Ce qu'il reste à faire : installer (binaire absent), activer (installé mais arrêté, ou pas lancé au démarrage) ou rien.
 * Masqué : choix délibéré de l'utilisateur, on ne propose rien. État inconnu (systemctl absent ou muet) : rien non plus.
 */
export function setupNeed(s: EarlyoomServiceState): EarlyoomSetupMode | null {
  if (!s.installed) return 'install';
  if (s.enabled === 'masked') return null;
  if (s.active === 'inactive' || s.active === 'failed' || s.enabled === 'disabled') return 'activate';
  return null;
}

export const EARLYOOM_REMINDER_SNOOZE_MS = 7 * 24 * 3600_000;

/** Config : « Ne plus rappeler pendant 7 jours » cliqué à `snoozedAt` (horodatage du main, jamais du renderer). */
export interface EarlyoomReminderConfig { snoozedAt: number }

/** Entrée de config illisible → absente (le rappel revient) ; jamais une raison d'invalider toute la config. */
export function validateEarlyoomReminder(raw: unknown): EarlyoomReminderConfig | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const t = (raw as Record<string, unknown>).snoozedAt;
  return Number.isSafeInteger(t) && (t as number) >= 0 ? { snoozedAt: t as number } : undefined;
}

/** Pause en cours : cliquée il y a moins de 7 jours. Un horodatage futur (horloge reculée, fichier édité) est ignoré : la pause ne dépasse jamais 7 jours. */
export function reminderSnoozed(snoozedAt: number | undefined, now: number): boolean {
  if (snoozedAt === undefined || !Number.isSafeInteger(snoozedAt) || snoozedAt < 0) return false;
  return snoozedAt <= now && now - snoozedAt < EARLYOOM_REMINDER_SNOOZE_MS;
}

/**
 * Pop-up du lancement : mode à proposer, ou null (rien à faire, « Plus tard » cliqué dans cette session, ou pause de 7 jours).
 * Installer / activer d'abord ; sinon la mise à niveau des réglages si le fichier lu en a besoin.
 */
export function reminderMode(o: {
  status: EarlyoomServiceState & { file?: { settings: EarlyoomSettings; line: string } | null };
  snoozedAt: number | undefined;
  later: boolean;
  now: number;
}): EarlyoomReminderKind | null {
  if (o.later || reminderSnoozed(o.snoozedAt, o.now)) return null;
  return setupNeed(o.status) ?? (upgradeNeed(o.status) ? 'upgrade' : null);
}

/**
 * Réglages de la ligne écrite : ceux du fichier existant s'ils respectent la politique (mis à niveau s'ils en ont besoin :
 * activer et mettre à jour en une seule saisie du mot de passe), sinon les valeurs par défaut.
 */
export function setupSettings(file: { settings: EarlyoomSettings; line?: string } | null): EarlyoomSettings {
  if (file && buildEarlyoomArgs(file.settings, []).ok) {
    const up = file.line === undefined ? null : earlyoomUpgrade({ settings: file.settings, line: file.line });
    const s = up ? up.settings : file.settings;
    return { ...s, prefer: [...s.prefer] };
  }
  return { ...EARLYOOM_DEFAULT_SETTINGS, prefer: [...EARLYOOM_DEFAULT_SETTINGS.prefer] };
}

/**
 * Gestionnaires de paquets reconnus (chemins absolus, jamais le PATH), commande d'installation non interactive et familles
 * de distributions (`ID` / `ID_LIKE` de /etc/os-release) qui les désignent quand plusieurs sont présents. Le script root
 * est généré depuis cette constante (paquet constant : earlyoom).
 * Ni paquets recommandés ni suppressions : apt-get --no-install-recommends --no-remove (s'arrête avant toute suppression),
 * dnf install_weak_deps=False, zypper --no-recommends ; pacman --needed (rien d'autre que earlyoom et ses dépendances).
 */
export const PACKAGE_MANAGERS = [
  { name: 'pacman', varName: 'pacman', path: '/usr/bin/pacman', distros: ['arch'], args: ['-S', '--needed', '--noconfirm', 'earlyoom'] },
  {
    name: 'apt-get', varName: 'apt_get', path: '/usr/bin/apt-get', distros: ['debian', 'ubuntu'],
    // confold : un /etc/default/earlyoom déjà présent est gardé sans question (l'app l'écrit ensuite, avec .bak).
    args: ['-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', 'install', '-y', '--no-install-recommends', '--no-remove', 'earlyoom'],
  },
  { name: 'dnf', varName: 'dnf', path: '/usr/bin/dnf', distros: ['fedora', 'rhel'], args: ['install', '-y', '--setopt=install_weak_deps=False', 'earlyoom'] },
  { name: 'zypper', varName: 'zypper', path: '/usr/bin/zypper', distros: ['suse', 'opensuse'], args: ['--non-interactive', 'install', '--no-recommends', 'earlyoom'] },
] as const;
export type PackageManagerName = (typeof PACKAGE_MANAGERS)[number]['name'];

export const OS_RELEASE = '/etc/os-release';

/** Mots de `ID` et `ID_LIKE` (guillemets retirés), comme les lit le script root. */
export function osReleaseIds(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^(ID|ID_LIKE)=(.*)$/.exec(line);
    if (m) out.push(...m[2].replace(/["']/g, '').split(/[ \t]+/).filter(Boolean));
  }
  return out;
}

export type PackageManagerChoice = { ok: true; pm: PackageManagerName } | { ok: false; reason: 'none' | 'ambiguous' };

/**
 * Un seul gestionnaire présent : celui-là. Plusieurs : celui que désigne /etc/os-release (ID, ID_LIKE), à condition qu'il
 * soit présent et le seul désigné ; sinon (fichier absent, distribution inconnue, plusieurs familles) : ambigu, on refuse.
 * Même règle dans le script root ; ici, pour la confirmation et pour refuser avant le mot de passe.
 */
export function detectPackageManager(exists: (p: string) => boolean, osRelease: string | null): PackageManagerChoice {
  const present = PACKAGE_MANAGERS.filter((m) => exists(m.path));
  if (present.length === 0) return { ok: false, reason: 'none' };
  if (present.length === 1) return { ok: true, pm: present[0]!.name };
  const ids = osRelease === null ? [] : osReleaseIds(osRelease);
  const chosen = present.filter((m) => m.distros.some((d) => ids.includes(d)));
  return chosen.length === 1 ? { ok: true, pm: chosen[0]!.name } : { ok: false, reason: 'ambiguous' };
}
