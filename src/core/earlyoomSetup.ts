// Installation / activation d'earlyoom depuis l'app (B8 bis) : logique pure partagée par le main et le renderer.
import { buildEarlyoomArgs, type EarlyoomSettings } from './earlyoom';

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

/** Valeurs par défaut de la ligne (formulaire de Réglages › earlyoom et installation) : 8,5 / 35,25, aucune préférence. */
/**
 * Processus de test préférés par earlyoom (tués en premier : les relancer ne coûte rien). Noms tels que /proc les
 * donne (15 caractères au plus, caractères spéciaux en « . »).
 */
export const EARLYOOM_TEST_PREFER: readonly string[] = Object.freeze([
  'vitest', 'node..vitest.', 'jest', 'pytest', 'playwright', 'cypress', 'mocha', 'karma', 'headless_shell', 'chrome-headless',
]);
export const EARLYOOM_DEFAULT_SETTINGS: Readonly<EarlyoomSettings> = Object.freeze({ memTerm: 8, memKill: 5, swapTerm: 35, swapKill: 25, prefer: [...EARLYOOM_TEST_PREFER] });

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

/** Pop-up du lancement : mode à proposer, ou null (rien à faire, « Plus tard » cliqué dans cette session, ou pause de 7 jours). */
export function reminderMode(o: { status: EarlyoomServiceState; snoozedAt: number | undefined; later: boolean; now: number }): EarlyoomSetupMode | null {
  if (o.later || reminderSnoozed(o.snoozedAt, o.now)) return null;
  return setupNeed(o.status);
}

/** Réglages de la ligne écrite : ceux du fichier existant s'ils respectent la politique, sinon les valeurs par défaut. */
export function setupSettings(file: { settings: EarlyoomSettings } | null): EarlyoomSettings {
  if (file && buildEarlyoomArgs(file.settings, []).ok) return { ...file.settings, prefer: [...file.settings.prefer] };
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
    // confold : un /etc/default/earlyoom déjà présent est gardé sans question (proc-watch l'écrit ensuite, avec .bak).
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
