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
import { APP_NAME, LEGACY_APP_NAME } from '../core/appName';
import { cleanEnv, systemBin } from '../core/childEnv';
import {
  decideDirMove, nextSteps, parseMigrationState, reportOf, serializeMigrationState, type DirMove, type MigrationReport, type MigrationState, type MigrationStep,
} from '../core/nameMigration';
import { appPaths, rootList, stopRecorderForUninstall, type Roots } from './appInstall';
import { desktopEntryContent, execFromEntry, installDesktopEntry, isManagedEntry } from './desktopEntry';
import { LEGACY_UNIT_NAME } from './recorderService';
import { moveDirSafe, mountPointsOf, readFileSafe, removeFileSafe, removeLinkSafe, writeFileSafe } from './safeFs';

export type { MigrationReport };

/** systemctl --user synchrone (avant `ready`, rien d'autre ne tourne encore dans le main). */
export type SystemctlSync = (args: string[]) => { ok: boolean; stdout: string };

export const defaultSystemctlSync: SystemctlSync = (args) => {
  const bin = systemBin('systemctl', existsSync);
  if (!bin) return { ok: false, stdout: '' };
  // chemin absolu, environnement sans le montage /tmp de l'AppImage (I-A)
  const r = spawnSync(bin, ['--user', ...args], { timeout: 5000, env: cleanEnv(process.env), encoding: 'utf8' });
  return { ok: r.status === 0, stdout: String(r.stdout ?? '') };
};

export interface MigrateDeps {
  roots: Roots;
  /** PROC_WATCH_NO_RECORDER_SYNC (jamais de systemctl), XDG_RUNTIME_DIR (dossier d'exécution). */
  env: NodeJS.ProcessEnv;
  systemctl: SystemctlSync;
  mountinfo: () => string;
  /** Une ancienne instance (proc-watch) tient encore ses dossiers : la migration est différée. */
  legacyInstanceAlive: () => boolean;
  /** Écrit et active computer-watcher-recorder.service (ensureRecorderService, exécutable courant) ; erreur si impossible. */
  writeNewService: () => Promise<void>;
  /** Icône copiée avec la nouvelle entrée de menu. */
  iconPng?: string;
  /** AppImage de ce processus vérifiée par realAppImage(), ou null (lue au second temps seulement). */
  ownAppImage: () => string | null;
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

const runtimeBase = (env: NodeJS.ProcessEnv): string | null => (env.XDG_RUNTIME_DIR && isAbsolute(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : null);
const rootsOf = (d: MigrateDeps): string[] => {
  const run = runtimeBase(d.env);
  return [...rootList(d.roots), ...(run ? [run] : [])];
};

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
  // disable avant stop : un Restart= ne le relance pas au prochain démarrage de session ; puis vérifié arrêté
  if (!d.systemctl(['disable', LEGACY_UNIT_NAME]).ok) return fail('systemctl --user disable a échoué : ancien service laissé, rien déplacé');
  if (!d.systemctl(['stop', LEGACY_UNIT_NAME]).ok) return fail('systemctl --user stop a échoué : ancien service laissé, rien déplacé');
  const state = d.systemctl(['is-active', LEGACY_UNIT_NAME]).stdout.trim();
  if (state !== 'inactive' && state !== 'failed') return fail(`ancien service toujours actif (${state || 'état inconnu'}) : rien déplacé (réessayer)`);
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

/** Paires ancien → nouveau, toujours dans le même dossier parent. */
function dirMoves(d: MigrateDeps): DirMove[] {
  const r = d.roots;
  const run = runtimeBase(d.env);
  return [
    { from: legacyDir(r.configHome), to: newDir(r.configHome) },
    { from: legacyDir(r.dataHome), to: newDir(r.dataHome) },
    { from: join(r.cacheHome, `${LEGACY_APP_NAME}-updater`), to: join(r.cacheHome, `${APP_NAME}-updater`) },
    ...(run ? [{ from: legacyDir(run), to: newDir(run) }] : []),
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
  // ancre : les données, le cache et le dossier d'exécution ne bougent qu'avec l'ancien dossier de config (ou une migration
  // déjà commencée) ; une app d'essai à XDG_CONFIG_HOME temporaire ne touche jamais les vrais.
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

function appImageStep(d: MigrateDeps, s: MigrationState): void {
  const step = 'appimage';
  const before: MigrationStep[] = ['move-dirs', 'desktop'];
  if (!before.every((x) => s.done.includes(x))) return;
  if (!s.done.includes('new-service') && !s.skipped?.['new-service']) return;
  // pas lancée depuis l'ancienne copie installée : rien à faire
  if (d.ownAppImage() !== appPaths(d.roots).legacy.appImage) return markDone(s, step);
  markDone(s, step);
}

// ---------------------------------------------------------------- enchaînement

/** Bilan sans rien faire (Réglages › À propos) : l'état enregistré, sinon « rien ». */
export function migrationState(d: Pick<MigrateDeps, 'roots' | 'env'>): MigrationReport {
  const s = readState(d as MigrateDeps);
  return s ? reportOf(s) : { status: 'nothing', done: [], errors: {}, leftInPlace: [], skipped: {} };
}

const NOTHING: MigrationReport = { status: 'nothing', done: [], errors: {}, leftInPlace: [], skipped: {} };
const DEFERRED: MigrationReport = { status: 'deferred', done: [], errors: {}, leftInPlace: [], skipped: {} };

/** Avant `ready`, synchrone : arrêt de l'ancien service puis dossiers. Rien à faire → 'nothing' ; ancienne instance → 'deferred'. */
export function migrateEarly(d: MigrateDeps): MigrationReport {
  const s0 = readState(d);
  const legacy = legacyPresent(d);
  const complete = s0 !== null && nextSteps(s0, { legacyPresent: true, legacyInstanceAlive: false }) === 'nothing';
  // recherche d'une ancienne instance seulement s'il reste quelque chose à faire
  const alive = !complete && (s0 !== null || legacy) && d.legacyInstanceAlive();
  const plan = nextSteps(s0, { legacyPresent: legacy, legacyInstanceAlive: alive });
  if (plan === 'nothing') return NOTHING;
  if (plan === 'deferred') return DEFERRED;
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
  if (plan.includes('appimage')) appImageStep(d, s);
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

// ---------------------------------------------------------------- ancienne instance

/**
 * Le verrou d'instance unique de l'ancien dossier (SingletonLock de Chromium, lien vers « <hôte>-<pid> ») est-il tenu par
 * une app vivante ? Seulement sur cette machine, pas nous, et un processus nommé proc-watch (empaquetée) ou electron (version
 * de développement) : un verrou périmé (processus disparu, pid réutilisé) ne bloque rien.
 */
export function legacyLockHolderAlive(o: { lockTarget: string | null; hostname: string; selfPid: number; comm: (pid: number) => string | null }): boolean {
  const m = o.lockTarget === null ? null : /^(.*)-(\d+)$/.exec(o.lockTarget);
  if (!m || m[1] !== o.hostname) return false;
  const pid = Number(m[2]);
  if (pid === o.selfPid) return false;
  const c = o.comm(pid);
  return c === LEGACY_APP_NAME || c === 'electron';
}

/**
 * Relance (mise à jour, installation) : l'ancienne instance quitte juste après avoir lancé celle-ci ; on l'attend au plus
 * 10 s. Lancement ordinaire : pas d'attente. Vrai si elle tourne toujours.
 */
export function aliveAfterWait(o: { alive: () => boolean; relaunch: boolean; sleep: (ms: number) => void }): boolean {
  if (!o.alive()) return false;
  if (!o.relaunch) return true;
  for (let waited = 0; waited < 10_000; waited += 250) {
    o.sleep(250);
    if (!o.alive()) return false;
  }
  return true;
}

/** Ancienne instance réelle : verrou SingletonLock de l'ancien dossier de config, lu sans le suivre ; /proc/<pid>/comm. */
export function realLegacyInstanceAlive(configHome: string): boolean {
  let lockTarget: string | null = null;
  try {
    lockTarget = readlinkSync(join(legacyDir(configHome), 'SingletonLock'));
  } catch {
    // pas de verrou : aucune ancienne instance avec ces dossiers
  }
  return legacyLockHolderAlive({
    lockTarget,
    hostname: hostname(),
    selfPid: process.pid,
    comm: (pid) => {
      try {
        return readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      } catch {
        return null;
      }
    },
  });
}
