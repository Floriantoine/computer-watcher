// Installation comme une app (AppImage → ~/Applications), démarrage avec la session, désinstallation propre.
// Toutes les racines (HOME, XDG_CONFIG_HOME, XDG_DATA_HOME) sont injectées : les tests ne touchent jamais les vrais dossiers.
import { closeSync, constants as C, lstatSync, realpathSync } from 'node:fs';
import { access, lstat, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { desktopEntryContent, installDesktopEntry, isManagedEntry } from './desktopEntry';
import { isUsableAppImage } from './realAppImage';
import {
  chmodSafe, copyFileSafe, fdPath, hashNoFollow, listDirSafe, openParent, readFileSafe, removeDirIfEmptySafe, removeFileSafe, removeTreeSafe, writeFileSafe,
} from './safeFs';
import type { InstallOutcome, UninstallItem, UninstallKind, UninstallOptions, UninstallResult } from '../core/onboarding';
import { UNIT_NAME, type Systemctl } from './recorderService';
import { xdgHome } from '../core/paths';
import { systemBin } from '../core/childEnv';

export type { InstallOutcome, UninstallItem, UninstallKind, UninstallOptions, UninstallResult };

export interface Roots { home: string; configHome: string; dataHome: string; cacheHome: string }

export function rootsFrom(env: NodeJS.ProcessEnv, home: string): Roots {
  return {
    home,
    // M-2 : une valeur XDG non absolue est ignorée (spécification XDG)
    configHome: xdgHome(env, 'XDG_CONFIG_HOME', join(home, '.config')),
    dataHome: xdgHome(env, 'XDG_DATA_HOME', join(home, '.local/share')),
    cacheHome: xdgHome(env, 'XDG_CACHE_HOME', join(home, '.cache')),
  };
}

export function appPaths(r: Roots) {
  return {
    appImage: join(r.home, 'Applications', 'proc-watch.AppImage'),
    autostart: join(r.configHome, 'autostart', 'proc-watch.desktop'),
    desktop: join(r.dataHome, 'applications', 'proc-watch.desktop'),
    icon: join(r.dataHome, 'icons/hicolor/512x512/apps', 'proc-watch.png'),
    unit: join(r.configHome, 'systemd/user', UNIT_NAME),
    configDir: join(r.configHome, 'proc-watch'),
    dataDir: join(r.dataHome, 'proc-watch'),
    /** Cache d'electron-updater (updaterCacheDirName d'app-update.yml : `${nom}-updater`). */
    updaterCache: join(r.cacheHome, 'proc-watch-updater'),
  };
}

/** Racines sous lesquelles proc-watch écrit (chaque dossier en dessous est ouvert sans suivre de lien). */
export const rootList = (r: Roots) => [r.home, r.configHome, r.dataHome, r.cacheHome];

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const realOrNull = async (p: string) => realpath(p).catch(() => null);

/** Entrée .desktop écrite par proc-watch (X-ProcWatch-Managed=1), lue sans suivre de lien. */
function managedEntry(r: Roots, path: string): boolean {
  const t = readFileSafe(rootList(r), path);
  return t !== null && isManagedEntry(t);
}

/** Le chemin existe-t-il (lien symbolique compris, jamais suivi) ? */
function present(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

const foreign = (path: string) => `${path} n’a pas été créé par proc-watch (sans X-ProcWatch-Managed=1) : laissé en place`;

// ---------------------------------------------------------------- installation

/** SHA-256 de la copie installée (dossiers ouverts sans suivre de lien), ou null si absente / pas un fichier ordinaire. */
async function destInfo(r: Roots): Promise<{ sha256: string } | null> {
  let parent;
  try {
    parent = openParent(rootList(r), appPaths(r).appImage, false);
  } catch {
    return null;
  }
  if (!parent) return null;
  try {
    return await hashNoFollow(fdPath(parent.fd, parent.name));
  } catch {
    return null;
  } finally {
    closeSync(parent.fd);
  }
}

/**
 * Copie `source` (l'AppImage lancée, déjà vérifiée par realAppImage) dans ~/Applications/proc-watch.AppImage (0755) :
 * dossiers ouverts sans suivre de lien, temporaire exclusif, fchmod, fsync, rename ; la copie relue a le même SHA-256.
 * Idempotent (lancée depuis la copie, ou copie identique). Entrée de menu vers la copie, et démarrage automatique repointé,
 * seulement s'ils sont absents ou écrits par proc-watch ; sinon laissés et signalés (`warnings`). L'original n'est jamais touché ici.
 */
export async function installAppImage(o: { source: string; roots: Roots; iconPng?: string }): Promise<InstallOutcome> {
  const roots = rootList(o.roots);
  const dest = appPaths(o.roots).appImage;
  if (!isAbsolute(o.source)) throw new Error(`AppImage introuvable : ${o.source}`);
  let src;
  try {
    src = await hashNoFollow(o.source);
  } catch {
    throw new Error(`AppImage introuvable : ${o.source}`);
  }
  const srcReal = await realpath(o.source);
  const runningFromCopy = (await realOrNull(dest)) === srcReal;
  let status: InstallOutcome['status'];
  const existing = await destInfo(o.roots);
  if (runningFromCopy || existing?.sha256 === src.sha256) {
    status = 'already';
    chmodSafe(roots, dest, 0o755); // fchmod sur un fd O_NOFOLLOW
  } else {
    const copied = await copyFileSafe(roots, o.source, dest, 0o755);
    if (copied.sha256 !== src.sha256) throw new Error('La copie ne correspond pas à l’AppImage lancée (modifiée pendant la copie ?)');
    status = present(dest) && existing ? 'updated' : 'installed';
  }
  const executable = await access(dest, C.X_OK).then(() => true, () => false);
  const warnings: string[] = [];
  if (!executable) warnings.push(`${dest} n’est pas exécutable (dossier monté en noexec ?) : relance impossible depuis la copie`);
  let desktopFile: string | null = null;
  try {
    desktopFile = installDesktopEntry(dest, { XDG_DATA_HOME: o.roots.dataHome }, o.roots.home, o.iconPng);
  } catch (e) {
    warnings.push(`Entrée de menu : ${msg(e)}`);
  }
  let autostartUpdated = false;
  const auto = appPaths(o.roots).autostart;
  if (present(auto)) {
    try {
      setAutostart(true, dest, o.roots);
      autostartUpdated = true;
    } catch (e) {
      warnings.push(`Démarrage avec la session : ${msg(e)}`);
    }
  }
  return { status, dest, desktopFile, source: o.source, runningFromCopy, canDeleteSource: !runningFromCopy, autostartUpdated, sha256: src.sha256, executable, warnings };
}

// ---------------------------------------------------------------- suppression du fichier téléchargé (après relance)

/**
 * Dans la copie relancée (le main vérifie d'abord realAppImage() === la copie), avec l'accord lu une seule fois dans
 * onboarding.json : supprime exactement `path` s'il est toujours un fichier ordinaire (jamais un lien), du même inode que
 * lors de l'accord, distinct de la copie, avec l'en-tête AppImage, et d'empreinte égale à celle de l'accord ET à celle de
 * la copie en cours d'exécution. Un accord falsifié ne peut donc désigner qu'un double exact de l'app : aucune perte.
 */
export async function verifyAndDeleteOriginal(o: { path: string; sha256: string; ino: number; copy: string }): Promise<void> {
  if (!isAbsolute(o.path)) throw new Error(`Chemin refusé : ${o.path}`);
  let l;
  try {
    l = await lstat(o.path);
  } catch {
    throw new Error(`Fichier introuvable : ${o.path}`);
  }
  if (l.isSymbolicLink()) throw new Error(`${o.path} est un lien symbolique : non supprimé`);
  if (!l.isFile()) throw new Error(`${o.path} n’est pas un fichier ordinaire : non supprimé`);
  if (l.ino !== o.ino) throw new Error(`${o.path} a été remplacé depuis l’accord : non supprimé`);
  // f1 : identité par dev+ino (un lien physique ou un second montage du même fichier a un autre chemin réel)
  const copySt = await stat(o.copy).catch(() => null);
  if (!copySt || (copySt.dev === l.dev && copySt.ino === l.ino)) throw new Error('C’est la copie installée (même fichier) : non supprimée');
  if (!isUsableAppImage(o.path)) throw new Error(`${o.path} n’est pas une AppImage : non supprimé`);
  const [h, running] = await Promise.all([hashNoFollow(o.path), hashNoFollow(o.copy)]);
  if (h.sha256 !== o.sha256) throw new Error(`${o.path} a changé depuis l’accord (empreinte différente) : non supprimé`);
  if (h.sha256 !== running.sha256) throw new Error(`${o.path} n’est pas identique à la copie en cours d’exécution : non supprimé`);
  if ((await lstat(o.path)).ino !== h.ino || h.ino !== o.ino) throw new Error(`${o.path} a été remplacé : non supprimé`);
  await unlink(o.path);
}

// ---------------------------------------------------------------- démarrage avec la session

/**
 * Programme à lancer (démarrage automatique) : la copie installée si l'app tourne en AppImage et qu'elle existe, sinon
 * l'AppImage lancée, sinon le binaire empaqueté (.deb) ; null en version de développement.
 */
export function launchTarget(o: { roots: Roots; appImage?: string; packaged: boolean; execPath: string }): string | null {
  if (o.appImage) {
    const copy = appPaths(o.roots).appImage;
    // R2 : seulement une copie utilisable (en-tête AppImage, non vide), jamais le fichier vide d'une mise à jour ratée
    return isUsableAppImage(copy) ? copy : o.appImage;
  }
  return o.packaged ? o.execPath : null;
}

export function autostartState(r: Roots): { enabled: boolean; path: string } {
  const path = appPaths(r).autostart;
  return { enabled: present(path), path };
}

/**
 * ~/.config/autostart/proc-watch.desktop avec `--hidden`, ou retiré. Un fichier présent sans X-ProcWatch-Managed=1 n'est
 * jamais écrasé ni retiré ; dossiers ouverts sans suivre de lien.
 */
export function setAutostart(on: boolean, target: string | null, r: Roots): void {
  const path = appPaths(r).autostart;
  if (!on) {
    let isLink = false;
    try {
      isLink = lstatSync(path).isSymbolicLink();
    } catch {
      return; // absent
    }
    if (!isLink && !managedEntry(r, path)) throw new Error(foreign(path));
    removeFileSafe(rootList(r), path);
    return;
  }
  if (!target) throw new Error('Disponible uniquement dans la version installée (AppImage ou .deb)');
  writeFileSafe(rootList(r), path, desktopEntryContent(target, { args: ['--hidden'], autostart: true }), 0o644, {
    guard: (current) => (current !== null && !isManagedEntry(current) ? foreign(path) : null),
  });
}

// ---------------------------------------------------------------- désinstallation


/** Fichiers du dossier de données que proc-watch (app et service) crée ; tout autre fichier y reste. */
const DATA_FILES = [
  'metrics.db', 'metrics.db-wal', 'metrics.db-shm', 'recorder-status.json', 'app-events.jsonl', 'app-events.jsonl.ingest', 'clear-request',
  'forecast-snooze.json', 'rules-simulation.json', 'app-focus.json', 'tmp-set-aside.json',
];
/** `.updaterId` : identifiant écrit par electron-updater dans le dossier de l'app. */
const CONFIG_FILES = ['config.json', 'config.json.bak', 'onboarding.json', 'updater.json', 'test-app-update.yml', '.updaterId'];
/**
 * Profil Chromium de l'app (le dossier de config est aussi son `userData`) : noms connus seulement, retirés en
 * arborescence sans suivre de lien. Tout autre nom reste.
 */
const CHROMIUM_TREES = [
  'Cache', 'Code Cache', 'Crashpad', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Dictionaries', 'GPUCache', 'GPUPersistentCache', 'Local Storage',
  'Session Storage', 'Shared Dictionary', 'blob_storage', 'IndexedDB', 'WebStorage', 'Service Worker', 'shared_proto_db', 'VideoDecodeStats',
  'Partitions', 'Network', 'DIPS', 'DIPS-wal', 'DIPS-journal', 'DevToolsActivePort', 'Trust Tokens', 'Trust Tokens-journal', 'Preferences',
  'Local State', 'Network Persistent State', 'TransportSecurity', 'Cookies', 'Cookies-journal', 'declarative_performance_observer.db',
  'declarative_performance_observer.db-journal', 'SharedStorage', 'SharedStorage-wal',
];
/** Liens symboliques de Chromium (verrou d'instance) : retirés eux-mêmes, jamais suivis. */
const CHROMIUM_LINKS = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tmpOf = (names: string[]) => new RegExp(`^(?:${names.map(esc).join('|')})\\.\\d+\\.tmp$`);
const DATA_PATTERNS = [/^metrics\.db\.(?:pre-v\d+|bak)-\d{8}T\d{6}(?:-wal|-shm)?$/, tmpOf(DATA_FILES)];
const CONFIG_PATTERNS = [tmpOf(CONFIG_FILES)];

const LABELS: Record<UninstallKind, string> = {
  autostart: 'Démarrage automatique',
  desktop: 'Entrée de menu',
  icon: 'Icône',
  service: 'Service d’enregistrement',
  history: 'Historique',
  config: 'Configuration',
  cache: 'Cache des mises à jour',
  appimage: 'Application',
};

const allowedName = (name: string, files: string[], patterns: RegExp[]) => files.includes(name) || patterns.some((p) => p.test(name));

/** Fichiers connus d'un dossier de proc-watch ; dossier remplacé par un lien → son contenu n'est jamais lu. */
function ownFiles(r: Roots, dir: string, files: string[], patterns: RegExp[]): string[] {
  try {
    return listDirSafe(rootList(r), dir).filter((n) => allowedName(n, files, patterns)).sort().map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/**
 * Ce qui sera retiré, dans l'ordre : démarrage automatique, entrée de menu, icône, service, (historique), (configuration),
 * puis la copie ~/Applications/proc-watch.AppImage en dernier. Seulement des chemins de la liste autorisée qui existent.
 * earlyoom n'en fait jamais partie.
 */
export function uninstallPlan(r: Roots, o: UninstallOptions): UninstallItem[] {
  const p = appPaths(r);
  const item = (kind: UninstallKind, path: string, dir = false): UninstallItem => ({ kind, path, label: LABELS[kind], ...(dir ? { dir } : {}) });
  const out: UninstallItem[] = [];
  for (const [kind, path] of [['autostart', p.autostart], ['desktop', p.desktop], ['icon', p.icon], ['service', p.unit]] as const) {
    if (!present(path)) continue;
    // .desktop : seulement ceux que proc-watch a écrits (un lien symbolique est listé pour être signalé, jamais suivi)
    if ((kind === 'autostart' || kind === 'desktop') && !lstatSync(path).isSymbolicLink() && !managedEntry(r, path)) continue;
    out.push(item(kind, path));
  }
  if (o.history) {
    for (const f of ownFiles(r, p.dataDir, DATA_FILES, DATA_PATTERNS)) out.push(item('history', f));
    if (present(p.dataDir)) out.push(item('history', p.dataDir, true));
  }
  if (o.config) {
    for (const f of ownFiles(r, p.configDir, CONFIG_FILES, CONFIG_PATTERNS)) out.push(item('config', f));
    for (const f of ownFiles(r, p.configDir, [...CHROMIUM_TREES, ...CHROMIUM_LINKS], [])) out.push({ ...item('config', f), tree: true });
    if (present(p.configDir)) out.push(item('config', p.configDir, true));
    // cache d'electron-updater : arborescence retirée sans suivre de lien ; s'il est un lien, le lien seul
    if (present(p.updaterCache)) out.push({ ...item('cache', p.updaterCache), tree: true });
  }
  if (present(p.appImage)) out.push(item('appimage', p.appImage));
  return out;
}

/** L'élément fait-il partie de la liste autorisée (chemin exact, ou nom connu directement dans le dossier de proc-watch) ? */
function allowed(r: Roots, i: UninstallItem): boolean {
  const p = appPaths(r);
  switch (i.kind) {
    case 'autostart': return i.path === p.autostart && !i.dir;
    case 'desktop': return i.path === p.desktop && !i.dir;
    case 'icon': return i.path === p.icon && !i.dir;
    case 'service': return i.path === p.unit && !i.dir;
    case 'appimage': return i.path === p.appImage && !i.dir;
    case 'history': return i.dir ? i.path === p.dataDir : dirname(i.path) === p.dataDir && allowedName(basename(i.path), DATA_FILES, DATA_PATTERNS);
    case 'cache': return i.path === p.updaterCache && !!i.tree && !i.dir;
    case 'config':
      if (i.dir) return i.path === p.configDir;
      if (dirname(i.path) !== p.configDir) return false;
      return i.tree ? [...CHROMIUM_TREES, ...CHROMIUM_LINKS].includes(basename(i.path)) : allowedName(basename(i.path), CONFIG_FILES, CONFIG_PATTERNS);
    default: return false;
  }
}


/** Réponse de l'arrêt du service : null (fait ou rien à arrêter), un message d'erreur, ou `keep` (unité laissée, dit). */
export type ServiceStop = string | null | { error?: string | null; keep?: string; stopped?: boolean };

export interface UninstallDeps {
  /** Arrête et désactive le service avant de retirer son unité. */
  service: { stop(unitPath: string): Promise<ServiceStop>; reload(): Promise<void> };
  /** Avant le premier fichier d'historique : fermer la base ouverte par l'app. */
  beforeHistory?: () => void;
  onRemoved?: (path: string) => void;
}

/**
 * Exécute un plan confirmé. Chaque élément est revérifié : dans la liste autorisée ; chaque dossier ouvert sans suivre de
 * lien et le fichier retiré relativement à lui (jamais de realpath) ; un dossier n'est retiré que vide. La copie de
 * l'AppImage n'est retirée qu'en dernier, et seulement si rien n'a échoué ni n'est resté (unité) avant.
 */
export async function runUninstall(plan: readonly UninstallItem[], r: Roots, deps: UninstallDeps): Promise<UninstallResult> {
  const res: UninstallResult = { removed: [], failed: [], kept: [], done: false };
  const roots = rootList(r);
  const fail = (path: string, error: string) => res.failed.push({ path, error });
  const removed = (path: string) => {
    res.removed.push(path);
    deps.onRemoved?.(path);
  };
  let historyClosed = false;
  let blocker: string | null = null;
  const ordered = [...plan.filter((i) => i.kind !== 'appimage'), ...plan.filter((i) => i.kind === 'appimage')];
  for (const i of ordered) {
    if (!allowed(r, i)) {
      fail(i.path, 'hors de la liste des fichiers de proc-watch : refusé');
      continue;
    }
    if (i.kind === 'appimage' && (res.failed.length || blocker)) {
      res.kept.push({ path: i.path, reason: blocker ?? 'gardée : des éléments n’ont pas pu être retirés (réessayer après correction)' });
      continue;
    }
    if (i.kind === 'history' && !historyClosed) {
      historyClosed = true;
      deps.beforeHistory?.();
    }
    try {
      if (i.dir) {
        const d = removeDirIfEmptySafe(roots, i.path);
        if (d === 'removed') removed(i.path);
        else if (d === 'not-empty') res.kept.push({ path: i.path, reason: 'dossier non vide : fichiers inconnus laissés' });
        continue;
      }
      if (i.kind === 'service') {
        let l;
        try {
          l = lstatSync(i.path);
        } catch {
          continue; // déjà absente
        }
        if (l.isSymbolicLink()) {
          fail(i.path, `${i.path} : lien symbolique, refusé (jamais suivi)`);
          continue;
        }
        const s = await deps.service.stop(i.path);
        const err = typeof s === 'string' ? s : s?.error ?? null;
        if (err) {
          fail(i.path, err);
          continue;
        }
        if (s && typeof s === 'object' && s.keep) {
          res.kept.push({ path: i.path, reason: s.keep });
          blocker = 'gardée : le service d’enregistrement est resté en place';
          continue;
        }
        if (removeFileSafe(roots, i.path) === 'removed') removed(i.path);
        await deps.service.reload();
        continue;
      }
      if ((i.kind === 'autostart' || i.kind === 'desktop') && present(i.path) && !lstatSync(i.path).isSymbolicLink() && !managedEntry(r, i.path)) {
        res.kept.push({ path: i.path, reason: 'pas créé par proc-watch (sans X-ProcWatch-Managed=1) : laissé' });
        continue;
      }
      if (i.tree) {
        const topLink = i.kind === 'cache' || CHROMIUM_LINKS.includes(basename(i.path));
        if (removeTreeSafe(roots, i.path, { allowTopLink: topLink }) === 'removed') removed(i.path);
        continue;
      }
      if (removeFileSafe(roots, i.path) === 'removed') removed(i.path);
    } catch (e) {
      fail(i.path, e instanceof Error && !code(e) ? e.message : `${code(e) ?? msg(e)}`);
    }
  }
  res.done = res.failed.length === 0 && !res.kept.some((k) => k.path === appPaths(r).appImage);
  return res;
}

/** Texte de la confirmation native : exactement ce qui sera retiré. */
export function uninstallSummary(plan: readonly UninstallItem[], o: { deb: boolean }): { message: string; detail: string } {
  const lines = plan.length ? plan.map((i) => `• ${i.label}${i.dir ? ' (dossier, s’il est vide)' : i.tree ? ' (profil de l’app, avec son contenu)' : ''} : ${i.path}`) : ['• (aucun fichier de proc-watch trouvé)'];
  const kept: string[] = [];
  const hasHistory = plan.some((i) => i.kind === 'history');
  const hasConfig = plan.some((i) => i.kind === 'config');
  if (!hasHistory && !hasConfig) kept.push('Historique et configuration : gardés.');
  else if (!hasHistory) kept.push('Historique : gardé.');
  else if (!hasConfig) kept.push('Configuration : gardée.');
  return {
    message: 'Désinstaller proc-watch ?',
    detail: [
      'Seront supprimés :',
      ...lines,
      '',
      ...kept,
      'earlyoom n’est pas modifié.',
      ...(o.deb ? ['Le paquet .deb reste installé : le retirer avec « sudo apt remove proc-watch ».'] : []),
      'proc-watch se fermera ensuite.',
    ].join('\n'),
  };
}

/**
 * Arrête le service avant de retirer son unité, en échouant fermé :
 * - PROC_WATCH_NO_RECORDER_SYNC=1 : aucun appel systemctl, l'unité est laissée (et c'est dit) ;
 * - `systemctl --user show` en échec : erreur (unité et AppImage gardées) ;
 * - unité chargée depuis un autre fichier : erreur, jamais arrêtée ;
 * - unité non chargée : retirée seulement sans lien default.target.wants restant ;
 * - notre unité : `disable --now`.
 */
export async function stopRecorderForUninstall(o: { unitPath: string; run: Systemctl; disabled: boolean }): Promise<{ stopped: boolean; error: string | null; keep?: string }> {
  if (o.disabled) return { stopped: false, error: null, keep: 'laissée : synchronisation du service désactivée (PROC_WATCH_NO_RECORDER_SYNC=1), systemctl jamais appelé' };
  const show = await o.run(['show', '-p', 'FragmentPath', '--value', UNIT_NAME]);
  if (!show.ok) return { stopped: false, error: 'systemctl --user show a échoué : service et unité laissés (réessayer)' };
  const frag = show.stdout.trim();
  if (!frag) {
    const wants = join(dirname(o.unitPath), 'default.target.wants', UNIT_NAME);
    if (present(wants)) return { stopped: false, error: `unité non chargée mais ${wants} existe : laissée (systemctl --user daemon-reload, puis réessayer)` };
    return { stopped: false, error: null };
  }
  const same = (a: string, b: string) => {
    try {
      return realpathSync(a) === realpathSync(b);
    } catch {
      return a === b;
    }
  };
  if (!same(frag, o.unitPath)) return { stopped: false, error: `service chargé depuis ${frag}, pas ${o.unitPath} : laissé` };
  const d = await o.run(['disable', '--now', UNIT_NAME]);
  return d.ok ? { stopped: true, error: null } : { stopped: false, error: 'systemctl --user disable --now a échoué : service laissé en place' };
}

/**
 * Dernier passage, juste avant de quitter après une désinstallation complète avec « configuration » cochée : Chromium
 * réécrit une partie de son profil (Session Storage…) en cours de route. Configuration seulement, mêmes règles.
 */
export function configSweepPlan(r: Roots): UninstallItem[] {
  return uninstallPlan(r, { history: false, config: true }).filter((i) => i.kind === 'config');
}

export interface SweepTools { sleep: string; rm: string; rmdir: string }

/** sleep, rm et rmdir par chemin absolu (/usr/bin, sinon /bin) ; l'un manque : null (pas de nettoyage d'après sortie). */
export function sweepTools(exists: (p: string) => boolean): SweepTools | null {
  const sleep = systemBin('sleep', exists);
  const rm = systemBin('rm', exists);
  const rmdir = systemBin('rmdir', exists);
  return sleep && rm && rmdir ? { sleep, rm, rmdir } : null;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Chromium recrée « Session Storage » (base vide) en quittant, après le dernier passage : un /bin/sh détaché (hors du
 * montage de l'AppImage, qui disparaît avec elle) attend la fin du processus (10 s au plus), puis :
 * - `cd -P` dans le dossier de config et vérifie `pwd -P` = `realDir` (chemin réel relevé avant) ; sinon rien (M-1) ;
 * - retire « Session Storage » en relatif s'il n'est pas un lien (rm sans suivre de lien, même système de fichiers) ;
 * - puis le dossier de config s'il est vide.
 * Aucun PATH hérité : environnement fixe et outils par chemin absolu (I-A). Chemins passés en arguments, jamais
 * interpolés dans le script.
 */
export function postExitSweepCommand(pid: number, realDir: string, t: SweepTools): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const script = [
    'pid=$1; d=$2; i=0',
    `while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 100 ]; do ${shq(t.sleep)} 0.1; i=$((i+1)); done`,
    'cd -P -- "$d" 2>/dev/null || exit 0',
    '[ "$(pwd -P)" = "$d" ] || exit 0',
    `if [ -d "Session Storage" ] && [ ! -L "Session Storage" ]; then ${shq(t.rm)} -rf --one-file-system -- "Session Storage"; fi`,
    'cd / || exit 0',
    `${shq(t.rmdir)} -- "$d" 2>/dev/null`,
    'exit 0',
  ].join('\n');
  return { cmd: '/bin/sh', args: ['-c', script, 'sh', String(pid), realDir], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } };
}
