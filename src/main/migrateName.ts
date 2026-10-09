// Migration proc-watch → computer-watcher, une seule fois, au premier lancement de la nouvelle version (idempotente).
// Deux temps : avant `ready` (synchrone, avant toute lecture de la config, de la base ou du service : arrêt de l'ancien
// service, déplacement des dossiers) puis après `ready` (nouveau service, entrées du menu et du démarrage, copie AppImage).
// Échec fermé : une étape qui échoue n'est suivie d'aucune étape qui en dépend, rien n'est supprimé, et l'état
// (migration.json, dossier de config résolu) permet de réessayer. Écritures et suppressions par ./safeFs uniquement.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { appDir, legacyDir, newDir } from '../core/appDirs';
import { xdgFamilies } from '../core/paths';
import { APP_NAME, LEGACY_APP_NAME } from '../core/appName';
import { cleanEnv, systemBin } from '../core/childEnv';
import {
  decideDirMove, nextSteps, parseMigrationState, reportOf, serializeMigrationState, type DirMove, type MigrationReport, type MigrationState, type MigrationStep,
} from '../core/nameMigration';
import { DELETE_CONSENT_TTL_MS, parseOnboardingFile, serializeOnboarding } from '../core/onboarding';
import { appPaths, installAppImage, rootList, stopRecorderForUninstall, type Roots } from './appInstall';
import { isUsableAppImage } from './realAppImage';
import { desktopEntryContent, execFromEntry, installDesktopEntry, isManagedEntry } from './desktopEntry';
import { LEGACY_UNIT_NAME } from './recorderService';
import { hashNoFollow, moveDirSafe, mountPointsOf, readFileSafe, removeFileSafe, removeLinkSafe, writeFileSafe } from './safeFs';

export type { MigrationReport };

/** systemctl --user synchrone (avant `ready`, rien d'autre ne tourne encore dans le main). */
export type SystemctlSync = (args: string[]) => { ok: boolean; stdout: string };

let systemctlStalled = false;
/**
 * Avant `ready`, le démarrage attend systemctl : 5 s au plus par appel, puis 1 s seulement pour les appels suivants une fois
 * qu'un appel a dépassé son délai (gestionnaire systemd --user bloqué). Au pire, avec l'attente d'une ancienne instance ou
 * d'un dossier encore utilisé (10 s chacune, seulement lors d'une relance), une trentaine de secondes avant la fenêtre.
 */
export const defaultSystemctlSync: SystemctlSync = (args) => {
  const bin = systemBin('systemctl', existsSync);
  if (!bin) return { ok: false, stdout: '' };
  // chemin absolu, environnement sans le montage /tmp de l'AppImage (I-A)
  const r = spawnSync(bin, ['--user', ...args], { timeout: systemctlStalled ? 1000 : 5000, env: cleanEnv(process.env), encoding: 'utf8' });
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') systemctlStalled = true;
  return { ok: r.status === 0, stdout: String(r.stdout ?? '') };
};

/** Processus qui tient un dossier ou un verrou : affiché dans les messages (pid et nom). */
export interface Holder { pid: number; name: string }
const holderText = (h: Holder) => `${h.name} (pid ${h.pid})`;

export interface MigrateDeps {
  roots: Roots;
  /** PROC_WATCH_NO_RECORDER_SYNC (jamais de systemctl), XDG_* (cohérence des racines, voir xdgFamilies). */
  env: NodeJS.ProcessEnv;
  systemctl: SystemctlSync;
  mountinfo: () => string;
  /** Instance de l'app (ancienne ou nouvelle) qui tient le verrou de l'ancien dossier de config : migration différée. */
  legacyInstance: () => Holder | null;
  /** Processus de l'utilisateur, hors l'app elle-même, qui a son cwd, un fd ou un mmap sous ce dossier (realDirUser). */
  dirUser: (dir: string) => Holder | null;
  /** Relance (mise à jour, « Réessayer ») : l'instance précédente quitte ; on attend au plus 10 s qu'elle libère tout. */
  relaunching: boolean;
  sleep: (ms: number) => void;
  /** Écrit et active computer-watcher-recorder.service (ensureRecorderService, exécutable courant) ; erreur si impossible. */
  writeNewService: () => Promise<void>;
  /** Icône copiée avec la nouvelle entrée de menu. */
  iconPng?: string;
  /** AppImage de ce processus vérifiée par realAppImage(), ou null (lue au second temps seulement). */
  ownAppImage: () => string | null;
  /** Relance détachée depuis `target` (relaunchDetached) puis sortie ; rejetée si rien n'a démarré. */
  relaunch: (target: string) => Promise<void>;
  now: () => number;
}

const STATE_FILE = 'migration.json';
const NO_SYNC = 'ignoré (PROC_WATCH_NO_RECORDER_SYNC=1) : systemctl jamais appelé';
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Le chemin existe-t-il (lien symbolique compris, jamais suivi) ? */
function present(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

const rootsOf = (d: MigrateDeps): string[] => rootList(d.roots);

/** Dossier de config où l'état est tenu : celui que l'app utilise (nouveau s'il existe, sinon ancien, sinon nouveau). */
const stateDir = (d: MigrateDeps): string => appDir(d.roots.configHome, present);

function readState(d: MigrateDeps): MigrationState | null {
  try {
    return parseMigrationState(readFileSafe(rootsOf(d), join(stateDir(d), STATE_FILE)));
  } catch {
    return null;
  }
}

/** État enregistré ; impossible (dossier en lien, droits) : rien n'est perdu, la migration sera simplement refaite. */
function writeState(d: MigrateDeps, s: MigrationState): void {
  try {
    writeFileSafe(rootsOf(d), join(stateDir(d), STATE_FILE), serializeMigrationState(s), 0o600);
  } catch (e) {
    console.error(`migration : état non enregistré (${msg(e)})`);
  }
}

/**
 * Une ancienne installation est-elle là ? Ancre : seulement ce qui vit sous XDG_CONFIG_HOME (dossier de config, unité,
 * démarrage automatique). Une app d'essai lancée avec un XDG_CONFIG_HOME temporaire mais les vrais dossiers de données,
 * de cache ou d'exécution ne migre donc jamais ces derniers.
 */
function legacyPresent(d: MigrateDeps): boolean {
  const L = appPaths(d.roots).legacy;
  return [L.configDir, L.unit, L.autostart].some(present);
}

const emptyState = (): MigrationState => ({ version: 1, done: [], errors: {}, leftInPlace: [] });
const markDone = (s: MigrationState, step: MigrationStep) => {
  if (!s.done.includes(step)) s.done.push(step);
  delete s.errors[step];
  if (s.skipped) delete s.skipped[step];
};
const markSkipped = (s: MigrationState, step: MigrationStep, why: string) => {
  delete s.errors[step];
  s.skipped = { ...(s.skipped ?? {}), [step]: why };
};
const leave = (s: MigrationState, path: string) => {
  if (!s.leftInPlace.includes(path)) s.leftInPlace.push(path);
};
/** L'arrêt de l'ancien service est réglé (fait, ou ignoré sans systemctl) : les dossiers peuvent bouger. */
const serviceSettled = (s: MigrationState) => s.done.includes('stop-legacy-service') || !!s.skipped?.['stop-legacy-service'];

// ---------------------------------------------------------------- 1. arrêt de l'ancien service

function stopLegacyService(d: MigrateDeps, s: MigrationState): void {
  const step = 'stop-legacy-service';
  if (d.env.PROC_WATCH_NO_RECORDER_SYNC === '1') return markSkipped(s, step, NO_SYNC);
  const unit = appPaths(d.roots).legacy.unit;
  const fail = (e: string) => void (s.errors[step] = e);
  const show = d.systemctl(['show', '-p', 'FragmentPath', '--value', LEGACY_UNIT_NAME]);
  if (!show.ok) {
    // aucun gestionnaire systemd --user et aucune unité à nous : rien à arrêter
    if (!present(unit) && !d.systemctl(['show-environment']).ok) return markDone(s, step);
    return fail('systemctl --user show a échoué : ancien service laissé, rien déplacé (réessayer)');
  }
  const frag = show.stdout.trim();
  if (!frag) {
    const wants = join(dirname(unit), 'default.target.wants', LEGACY_UNIT_NAME);
    if (present(wants)) return fail(`unité non chargée mais ${wants} existe : laissée, rien déplacé (systemctl --user daemon-reload, puis réessayer)`);
    return markDone(s, step);
  }
  const same = (a: string, b: string) => {
    try {
      return realpathSync(a) === realpathSync(b);
    } catch {
      return a === b;
    }
  };
  if (!same(frag, unit)) return fail(`ancien service chargé depuis ${frag}, pas ${unit} : laissé, rien déplacé`);
  // état relevé, arrêt vérifié, puis désactivation ; un échec remet le service dans son état initial (relancé, réactivé)
  const wasEnabled = d.systemctl(['is-enabled', LEGACY_UNIT_NAME]).stdout.trim() === 'enabled';
  const wasActive = ['active', 'activating', 'reloading'].includes(d.systemctl(['is-active', LEGACY_UNIT_NAME]).stdout.trim());
  const restore = (why: string) => {
    if (wasActive) d.systemctl(['start', LEGACY_UNIT_NAME]);
    if (wasEnabled) d.systemctl(['enable', LEGACY_UNIT_NAME]);
    fail(`${why} : ancien service remis dans son état initial, rien déplacé (réessayer)`);
  };
  if (!d.systemctl(['stop', LEGACY_UNIT_NAME]).ok) return restore('systemctl --user stop a échoué');
  const state = d.systemctl(['is-active', LEGACY_UNIT_NAME]).stdout.trim();
  if (state !== 'inactive' && state !== 'failed') return restore(`ancien service toujours actif (${state || 'état inconnu'})`);
  if (!d.systemctl(['disable', LEGACY_UNIT_NAME]).ok) return restore('systemctl --user disable a échoué');
  markDone(s, step);
}

// ---------------------------------------------------------------- 2. dossiers

type LegacyKind = 'absent' | 'dir' | 'link' | 'mount' | 'other';
type NextKind = 'absent' | 'empty' | 'non-empty' | 'link' | 'other';

function inspectLegacy(path: string, mounts: readonly string[]): LegacyKind {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 'absent';
  }
  if (st.isSymbolicLink()) return 'link';
  if (!st.isDirectory()) return 'other';
  try {
    const real = join(realpathSync(dirname(path)), basename(path));
    if (st.dev !== lstatSync(dirname(path)).dev || mounts.some((m) => m === real || m.startsWith(`${real}/`))) return 'mount';
  } catch {
    return 'other';
  }
  return 'dir';
}

function inspectNext(path: string): NextKind {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 'absent';
  }
  if (st.isSymbolicLink()) return 'link';
  if (!st.isDirectory()) return 'other';
  try {
    return readdirSync(path).length ? 'non-empty' : 'empty';
  } catch {
    return 'other';
  }
}

/**
 * Paires ancien → nouveau, toujours dans le même dossier parent. Jamais le dossier d'exécution ($XDG_RUNTIME_DIR) : il ne
 * contient que des fichiers éphémères, la nouvelle version recrée le sien.
 */
function dirMoves(d: MigrateDeps): DirMove[] {
  const r = d.roots;
  return [
    { from: legacyDir(r.configHome), to: newDir(r.configHome) },
    { from: legacyDir(r.dataHome), to: newDir(r.dataHome) },
    { from: join(r.cacheHome, `${LEGACY_APP_NAME}-updater`), to: join(r.cacheHome, `${APP_NAME}-updater`) },
  ];
}

const REFUSALS: Record<string, string> = {
  link: 'lien symbolique, refusé (jamais suivi)',
  mount: 'point de montage (ou en contient un), refusé',
  other: 'pas un dossier, refusé',
};

function moveDirs(d: MigrateDeps, s: MigrationState, started: boolean): void {
  const step = 'move-dirs';
  const mountinfo = d.mountinfo();
  const mounts = mountPointsOf(mountinfo);
  const [cfg, data, ...rest] = dirMoves(d);
  // ancre : les données et le cache ne bougent qu'avec l'ancien dossier de config (ou une migration déjà commencée), et
  // seulement si les trois racines sont de la même famille (vérifié par migrateEarly)
  const anchored = started || present(cfg!.from);
  const errors: string[] = [];
  for (const m of anchored ? [cfg!, data!, ...rest] : []) {
    const legacy = inspectLegacy(m.from, mounts);
    const next = inspectNext(m.to);
    const decision = decideDirMove({ legacy, next });
    if (decision === 'skip-absent') continue;
    if (decision === 'keep-both') {
      leave(s, m.from);
      continue;
    }
    if (decision === 'refuse') {
      errors.push(`${legacy !== 'dir' ? m.from : m.to} : ${REFUSALS[legacy !== 'dir' ? legacy : next] ?? 'refusé'} ; rien déplacé`);
      continue;
    }
    // jamais sous un processus vivant (ancien service, ancienne instance), y compris sous PROC_WATCH_NO_RECORDER_SYNC où
    // l'arrêt du service n'est pas confirmé ; lors d'une relance, l'instance précédente a 10 s pour tout libérer
    const user = waitWhile({ busy: () => d.dirUser(m.from), wait: d.relaunching, sleep: d.sleep });
    if (user) {
      errors.push(`${m.from} est utilisé par ${holderText(user)} : laissé en place, rien déplacé (le quitter, puis réessayer)`);
      continue;
    }
    try {
      moveDirSafe(rootsOf(d), m.from, m.to, { mountinfo }); // revérifié par descripteurs juste avant le rename
    } catch (e) {
      errors.push(msg(e));
    }
  }
  if (errors.length) s.errors[step] = errors.join(' ; ');
  else markDone(s, step);
}

// ---------------------------------------------------------------- 3. nouveau service

async function newService(d: MigrateDeps, s: MigrationState): Promise<void> {
  const step = 'new-service';
  if (d.env.PROC_WATCH_NO_RECORDER_SYNC === '1') return markSkipped(s, step, NO_SYNC);
  if (!s.done.includes('stop-legacy-service')) return; // ancien service pas arrêté : rien (son erreur le dit)
  const roots = rootsOf(d);
  const unit = appPaths(d.roots).legacy.unit;
  // pas d'ancienne unité : la synchronisation habituelle crée (ou non) le nouveau service selon les réglages
  if (!present(unit)) return markDone(s, step);
  if (lstatSync(unit).isSymbolicLink()) {
    s.errors[step] = `${unit} : lien symbolique, refusé (jamais suivi)`;
    return;
  }
  try {
    await d.writeNewService();
  } catch (e) {
    s.errors[step] = `nouveau service non écrit (${msg(e)}) : ancienne unité gardée, arrêtée`;
    return;
  }
  // ancienne unité retirée seulement si c'est la nôtre (même contrôle que la désinstallation)
  const check = await stopRecorderForUninstall({ unitPath: unit, run: async (a) => d.systemctl(a), disabled: false });
  if (check.error) {
    s.errors[step] = `ancienne unité gardée : ${check.error}`;
    return;
  }
  try {
    removeFileSafe(roots, unit);
    removeLinkSafe(roots, join(dirname(unit), 'default.target.wants', LEGACY_UNIT_NAME));
  } catch (e) {
    s.errors[step] = `ancienne unité : ${msg(e)}`;
    return;
  }
  d.systemctl(['daemon-reload']);
  markDone(s, step);
}

// ---------------------------------------------------------------- 4. entrées du menu et du démarrage automatique

/** Contenu d'une entrée à l'ancien nom écrite par l'app (fichier ordinaire marqué), sinon null. */
function managedLegacy(d: MigrateDeps, path: string): string | null {
  try {
    if (lstatSync(path).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const t = readFileSafe(rootsOf(d), path);
  return t !== null && isManagedEntry(t) ? t : null;
}

/** Cible des nouvelles entrées : l'ancienne copie installée devient la nouvelle dès qu'elle existe (étape appimage). */
const retarget = (d: MigrateDeps, exec: string): string => {
  const p = appPaths(d.roots);
  return exec === p.legacy.appImage && present(p.appImage) ? p.appImage : exec;
};

function desktopEntries(d: MigrateDeps, s: MigrationState): void {
  const step = 'desktop';
  const p = appPaths(d.roots);
  const L = p.legacy;
  const roots = rootsOf(d);
  const errors: string[] = [];
  // menu
  if (present(L.desktop)) {
    const text = managedLegacy(d, L.desktop);
    const exec = text === null ? null : execFromEntry(text);
    if (!exec) leave(s, L.desktop);
    else {
      try {
        installDesktopEntry(retarget(d, exec.path), { XDG_DATA_HOME: d.roots.dataHome }, d.roots.home, d.iconPng);
        if (managedLegacy(d, L.desktop) !== null) removeFileSafe(roots, L.desktop);
        // icône à l'ancien nom : écrite avec l'entrée marquée, retirée avec elle (fichier ordinaire seulement)
        if (present(L.icon) && lstatSync(L.icon).isFile()) removeFileSafe(roots, L.icon);
      } catch (e) {
        errors.push(msg(e));
      }
    }
  }
  // démarrage automatique : seulement s'il existait, avec ses arguments (--hidden)
  if (present(L.autostart)) {
    const text = managedLegacy(d, L.autostart);
    const exec = text === null ? null : execFromEntry(text);
    if (!exec) leave(s, L.autostart);
    else {
      try {
        writeFileSafe(roots, p.autostart, desktopEntryContent(retarget(d, exec.path), { args: exec.args, autostart: true }), 0o644, {
          guard: (cur) => (cur !== null && !isManagedEntry(cur) ? `${p.autostart} n’a pas été créé par Computer Watcher (sans X-ProcWatch-Managed=1) : laissé en place` : null),
        });
        if (managedLegacy(d, L.autostart) !== null) removeFileSafe(roots, L.autostart);
      } catch (e) {
        errors.push(msg(e));
      }
    }
  }
  if (errors.length) s.errors[step] = errors.join(' ; ');
  else markDone(s, step);
}

// ---------------------------------------------------------------- 5. copie AppImage

/** onboarding.json du dossier de config, avec ou sans l'accord de suppression de l'ancienne copie. */
function writeConsent(d: MigrateDeps, consent: { path: string; sha256: string; ino: number; expires: number } | null): void {
  const file = join(stateDir(d), 'onboarding.json');
  const cur = parseOnboardingFile(readFileSafe(rootsOf(d), file));
  const { deleteOriginal: _old, ...rest } = cur ?? { version: 1 as const, done: true };
  writeFileSafe(rootsOf(d), file, serializeOnboarding({ ...rest, ...(consent ? { deleteOriginal: consent } : {}) }), 0o600);
}

/**
 * Lancée depuis ~/Applications/proc-watch.AppImage : copie vers ~/Applications/computer-watcher.AppImage par le chemin
 * « Installer comme une app » (SHA-256 vérifié, 0755, écriture par descripteur ; menu et démarrage repointés), unité
 * repointée, accord de suppression de l'ancienne copie écrit dans onboarding.json (usage unique, 5 min, inode + SHA-256),
 * puis relance depuis la nouvelle copie, qui supprime l'ancienne (deletePendingOriginal). Relance impossible : accord
 * retiré, ancienne copie gardée, l'app reste ouverte.
 */
async function appImageStep(d: MigrateDeps, s: MigrationState): Promise<void> {
  const step = 'appimage';
  if (!(['move-dirs', 'desktop'] as const).every((x) => s.done.includes(x))) return;
  if (!s.done.includes('new-service') && !s.skipped?.['new-service']) return;
  const p = appPaths(d.roots);
  const own = d.ownAppImage();
  // pas lancée depuis l'ancienne copie installée (ou ancienne copie inutilisable) : rien à faire
  if (own !== p.legacy.appImage || !isUsableAppImage(own)) return markDone(s, step);
  try {
    const out = await installAppImage({ source: own, roots: d.roots, iconPng: d.iconPng });
    if (!out.executable) throw new Error(`${out.dest} n’est pas exécutable (dossier monté en noexec ?)`);
    if (out.warnings.length) throw new Error(out.warnings.join(' ; '));
    if (d.env.PROC_WATCH_NO_RECORDER_SYNC !== '1' && present(p.unit)) await d.writeNewService(); // ExecStart → la nouvelle copie
    const h = await hashNoFollow(own);
    if (h.sha256 !== out.sha256) throw new Error(`${own} a changé pendant la copie : rien supprimé`);
    writeConsent(d, { path: own, sha256: h.sha256, ino: h.ino, expires: d.now() + DELETE_CONSENT_TTL_MS });
  } catch (e) {
    s.errors[step] = `copie vers ${p.appImage} : ${msg(e)} ; ancienne copie gardée`;
    return;
  }
  // fait avant la relance : la nouvelle instance ne recommence pas
  markDone(s, step);
  writeState(d, s);
  try {
    await d.relaunch(p.appImage);
  } catch (e) {
    s.done = s.done.filter((x) => x !== step);
    s.errors[step] = `relance depuis ${p.appImage} impossible (${msg(e)}) : ancienne copie gardée ; lancer Computer Watcher depuis le menu`;
    try {
      writeConsent(d, null);
    } catch (e2) {
      s.errors[step] += ` ; accord de suppression non retiré (${msg(e2)})`;
    }
  }
}

// ---------------------------------------------------------------- enchaînement

/** Bilan sans rien faire (Réglages › À propos) : l'état enregistré, sinon « rien ». */
export function migrationState(d: Pick<MigrateDeps, 'roots' | 'env'>): MigrationReport {
  const s = readState(d as MigrateDeps);
  return s ? reportOf(s) : { status: 'nothing', done: [], errors: {}, leftInPlace: [], skipped: {} };
}

const NOTHING: MigrationReport = { status: 'nothing', done: [], errors: {}, leftInPlace: [], skipped: {} };
const deferred = (detail: string): MigrationReport => ({ status: 'deferred', done: [], errors: {}, leftInPlace: [], skipped: {}, detail });

/** Racines XDG de familles différentes : texte du report « différée » (journal et Réglages › À propos). */
function xdgPartial(env: NodeJS.ProcessEnv): string | null {
  const f = xdgFamilies(env);
  if (f.consistent) return null;
  const show = (k: 'XDG_CONFIG_HOME' | 'XDG_DATA_HOME' | 'XDG_CACHE_HOME') => `${k} ${env[k] && isAbsolute(env[k]!) ? env[k] : 'par défaut'}`;
  return `XDG partiel (${show('XDG_CONFIG_HOME')}, ${show('XDG_DATA_HOME')}, ${show('XDG_CACHE_HOME')}) : rien n'est migré tant que ces trois racines ne sont pas toutes par défaut ou toutes définies`;
}

/** Avant `ready`, synchrone : arrêt de l'ancien service puis dossiers. Rien à faire → 'nothing' ; ancienne instance → 'deferred'. */
export function migrateEarly(d: MigrateDeps): MigrationReport {
  const s0 = readState(d);
  const legacy = legacyPresent(d);
  if (nextSteps(s0, { legacyPresent: legacy, legacyInstanceAlive: false }) === 'nothing') return NOTHING;
  // XDG partiel (app d'essai) : aucune étape n'agit
  const partial = xdgPartial(d.env);
  if (partial) {
    console.error(`migration : différée : ${partial}`);
    return deferred(partial);
  }
  // instance de l'app (ancienne ou nouvelle) qui tient encore l'ancien dossier ; lors d'une relance, on l'attend au plus 10 s
  const holder = waitWhile({ busy: () => d.legacyInstance(), wait: d.relaunching, sleep: d.sleep });
  const plan = nextSteps(s0, { legacyPresent: legacy, legacyInstanceAlive: !!holder });
  if (plan === 'nothing') return NOTHING;
  if (plan === 'deferred') return deferred(`l'ancien dossier est encore utilisé par ${holderText(holder!)} ; quitter cette instance, puis relancer Computer Watcher`);
  const s = s0 ?? emptyState();
  if (plan.includes('stop-legacy-service')) stopLegacyService(d, s);
  if (plan.includes('move-dirs') && serviceSettled(s)) moveDirs(d, s, s0 !== null);
  writeState(d, s);
  return reportOf(s);
}

/** Après `ready` : nouveau service, entrées, copie AppImage (les étapes qui restent, dans l'ordre). */
export async function migrateLate(d: MigrateDeps): Promise<MigrationReport> {
  const s = readState(d);
  if (!s) return NOTHING;
  const plan = nextSteps(s, { legacyPresent: true, legacyInstanceAlive: false });
  if (plan === 'nothing' || plan === 'deferred') return reportOf(s);
  if (plan.includes('new-service')) await newService(d, s);
  if (plan.includes('desktop')) desktopEntries(d, s);
  if (plan.includes('appimage')) await appImageStep(d, s);
  writeState(d, s);
  return reportOf(s);
}

/** Les deux temps à la suite (tests, « Réessayer » de Réglages › À propos). */
export async function migrateName(d: MigrateDeps): Promise<MigrationReport> {
  const early = migrateEarly(d);
  if (early.status === 'nothing' || early.status === 'deferred') return early;
  const late = await migrateLate(d);
  return late.status === 'nothing' ? early : late; // état illisible (non enregistré) : le bilan du premier temps
}

// ---------------------------------------------------------------- ancienne instance, dossier utilisé

const APP_COMMS = [LEGACY_APP_NAME, APP_NAME.slice(0, 15), 'electron'];

/**
 * Qui tient le verrou d'instance unique de l'ancien dossier (SingletonLock de Chromium, lien vers « <hôte>-<pid> ») ? Seulement
 * sur cette machine, pas nous, et un processus de l'app : comm proc-watch (empaquetée), computer-watche (nouveau nom, tronqué
 * à 15 caractères), electron (version de développement), ou le même exécutable que nous. Un verrou périmé (processus
 * disparu, pid réutilisé par autre chose) ne bloque rien.
 */
export function legacyLockHolder(o: {
  lockTarget: string | null;
  hostname: string;
  selfPid: number;
  comm: (pid: number) => string | null;
  exe?: (pid: number) => string | null;
  selfExe?: string | null;
}): Holder | null {
  const m = o.lockTarget === null ? null : /^(.*)-(\d+)$/.exec(o.lockTarget);
  if (!m || m[1] !== o.hostname) return null;
  const pid = Number(m[2]);
  if (pid === o.selfPid) return null;
  const c = o.comm(pid);
  if (c === null) return null;
  if (APP_COMMS.includes(c)) return { pid, name: c };
  const exe = o.exe?.(pid);
  return exe && o.selfExe && exe === o.selfExe ? { pid, name: c } : null;
}

const readOr = (f: () => string): string | null => {
  try {
    return f();
  } catch {
    return null;
  }
};

/** Instance réelle : verrou SingletonLock de l'ancien dossier de config, lu sans le suivre ; /proc/<pid>/comm et exe. */
export function realLegacyInstance(configHome: string): Holder | null {
  return legacyLockHolder({
    lockTarget: readOr(() => readlinkSync(join(legacyDir(configHome), 'SingletonLock'))),
    hostname: hostname(),
    selfPid: process.pid,
    comm: (pid) => readOr(() => readFileSync(`/proc/${pid}/comm`, 'utf8').trim()),
    exe: (pid) => readOr(() => readlinkSync(`/proc/${pid}/exe`)),
    selfExe: readOr(() => readlinkSync('/proc/self/exe')),
  });
}

/** Noms des processus dont un /proc/<pid>/fd illisible (même utilisateur) compte comme « utilisé » : échec fermé. */
const SUSPECT_UNREADABLE = new Set([...APP_COMMS, 'node']);

/**
 * Processus de l'utilisateur, hors l'app elle-même (`selfPid` et ses descendants), qui a son cwd, un fd ouvert ou un mmap
 * sous `dir` (comme scanTmpUsers, en synchrone : avant `ready`). Un processus de l'app ou node dont les fd sont illisibles
 * compte comme utilisateur (échec fermé). Dossier absent : null.
 */
export function realDirUser(dir: string, o: { selfPid?: number; uid?: number } = {}): Holder | null {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return null;
  }
  const prefix = `${real}/`;
  const hit = (l: string | null) => {
    if (!l) return false;
    const p = l.replace(/ \(deleted\)$/, '');
    return p === real || p.startsWith(prefix);
  };
  const selfPid = o.selfPid ?? process.pid;
  const uid = o.uid ?? process.getuid!();
  const pids = readdirSync('/proc').filter((e) => /^\d+$/.test(e)).map(Number);
  const parent = new Map<number, number>();
  for (const pid of pids) {
    const st = readOr(() => readFileSync(`/proc/${pid}/stat`, 'utf8'));
    if (st) parent.set(pid, Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]));
  }
  const ours = new Set([selfPid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [pid, pp] of parent) if (!ours.has(pid) && ours.has(pp)) (ours.add(pid), (changed = true));
  }
  for (const pid of pids) {
    if (ours.has(pid)) continue;
    const dirp = `/proc/${pid}`;
    try {
      if (lstatSync(dirp).uid !== uid) continue;
    } catch {
      continue;
    }
    const name = readOr(() => readFileSync(`${dirp}/comm`, 'utf8').trim()) || '?';
    if (hit(readOr(() => readlinkSync(`${dirp}/cwd`)))) return { pid, name };
    let fds: string[];
    try {
      fds = readdirSync(`${dirp}/fd`);
    } catch (e) {
      if (SUSPECT_UNREADABLE.has(name) && (e as NodeJS.ErrnoException).code === 'EACCES') return { pid, name: `${name}, illisible` };
      continue;
    }
    for (const fd of fds) if (hit(readOr(() => readlinkSync(`${dirp}/fd/${fd}`)))) return { pid, name };
    const maps = readOr(() => readFileSync(`${dirp}/maps`, 'utf8')) ?? '';
    if (maps.includes(` ${prefix}`) || maps.split('\n').some((l) => l.endsWith(` ${real}`))) return { pid, name };
  }
  return null;
}

/**
 * Tant que `busy()` renvoie quelque chose : lancement ordinaire, on ne l'attend pas ; relance (`wait`), on attend au plus
 * 10 s. Renvoie ce qui occupe encore, ou null.
 */
export function waitWhile<T>(o: { busy: () => T | null; wait: boolean; sleep: (ms: number) => void }): T | null {
  let b = o.busy();
  if (!b || !o.wait) return b;
  for (let waited = 0; waited < 10_000; waited += 250) {
    o.sleep(250);
    b = o.busy();
    if (!b) return null;
  }
  return b;
}

/** « Réessayer » : attend que l'instance précédente (pid) ait réellement quitté (absente, ou zombie). Vrai si c'est fait. */
export function waitPidGone(o: { pid: number; sleep: (ms: number) => void; maxMs?: number }): boolean {
  const alive = () => {
    const st = readOr(() => readFileSync(`/proc/${o.pid}/stat`, 'utf8'));
    return !!st && st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3) !== 'Z';
  };
  for (let waited = 0; alive(); waited += 100) {
    if (waited >= (o.maxMs ?? 10_000)) return false;
    o.sleep(100);
  }
  return true;
}
