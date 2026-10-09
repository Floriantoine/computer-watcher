// Installation comme une app (AppImage → ~/Applications), démarrage avec la session, désinstallation propre.
// Toutes les racines (HOME, XDG_CONFIG_HOME, XDG_DATA_HOME) sont injectées : les tests ne touchent jamais les vrais dossiers.
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { chmod, lstat, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { copyFileAtomicAsync, writeFileAtomic } from './atomicFile';
import { desktopEntryContent, installDesktopEntry, isManagedEntry } from './desktopEntry';
import type { InstallOutcome, UninstallItem, UninstallKind, UninstallOptions, UninstallResult } from '../core/onboarding';
import { UNIT_NAME, type Systemctl } from './recorderService';

export type { InstallOutcome, UninstallItem, UninstallKind, UninstallOptions, UninstallResult };

export interface Roots { home: string; configHome: string; dataHome: string }

export function rootsFrom(env: NodeJS.ProcessEnv, home: string): Roots {
  return { home, configHome: env.XDG_CONFIG_HOME || join(home, '.config'), dataHome: env.XDG_DATA_HOME || join(home, '.local/share') };
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
  };
}

/**
 * AppImage réellement lancée : APPIMAGE (absolu, fichier) ET APPDIR, avec le binaire en cours (realpath) dans APPDIR
 * (realpath). APPIMAGE seul (variable héritée, posée à la main) ne suffit jamais.
 */
export function appImageSource(env: NodeJS.ProcessEnv, execPath: string): string | null {
  const img = env.APPIMAGE;
  const dir = env.APPDIR;
  if (!img || !dir || !isAbsolute(img) || !isAbsolute(dir)) return null;
  try {
    if (!lstatSync(img).isFile() && !lstatSync(img).isSymbolicLink()) return null;
    const root = realpathSync(dir);
    const exe = realpathSync(execPath);
    return exe.startsWith(root.endsWith(sep) ? root : root + sep) ? img : null;
  } catch {
    return null;
  }
}

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const errText = (e: unknown) => (code(e) ? `${code(e)}` : e instanceof Error ? e.message : String(e));

async function fileHash(p: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(p)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Même contenu (taille puis SHA-256, lu en flux). */
export async function sameContent(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a), stat(b)]);
  if (sa.size !== sb.size) return false;
  const [ha, hb] = await Promise.all([fileHash(a), fileHash(b)]);
  return ha === hb;
}

const realOrNull = async (p: string) => realpath(p).catch(() => null);

// ---------------------------------------------------------------- installation


/**
 * Copie `source` (l'AppImage lancée) dans ~/Applications/proc-watch.AppImage (0755, écriture atomique : temporaire, fsync,
 * rename), puis écrit l'entrée de menu (et l'icône) vers la copie. Idempotent : copie identique ou lancement depuis la copie
 * → rien n'est recopié. L'original n'est jamais touché ici.
 */
export async function installAppImage(o: { source: string; roots: Roots; iconPng?: string }): Promise<InstallOutcome> {
  const dest = appPaths(o.roots).appImage;
  if (!isAbsolute(o.source)) throw new Error(`AppImage introuvable : ${o.source}`);
  const st = await stat(o.source).catch(() => null);
  if (!st?.isFile()) throw new Error(`AppImage introuvable : ${o.source}`);
  const srcReal = await realpath(o.source);
  const destReal = await realOrNull(dest);
  const runningFromCopy = destReal === srcReal;
  let status: InstallOutcome['status'];
  if (runningFromCopy) status = 'already';
  else {
    const existing = await lstat(dest).catch(() => null);
    if (existing?.isFile() && (await sameContent(o.source, dest))) {
      status = 'already';
      if ((existing.mode & 0o777) !== 0o755) await chmod(dest, 0o755);
    } else {
      await copyFileAtomicAsync(o.source, dest, 0o755);
      status = existing ? 'updated' : 'installed';
    }
  }
  const desktopFile = installDesktopEntry(dest, { XDG_DATA_HOME: o.roots.dataHome }, o.roots.home, o.iconPng);
  let autostartUpdated = false;
  if (autostartState(o.roots).enabled) {
    setAutostart(true, dest, o.roots);
    autostartUpdated = true;
  }
  return { status, dest, desktopFile, source: o.source, runningFromCopy, canDeleteSource: !runningFromCopy, autostartUpdated };
}

/**
 * Supprime le fichier téléchargé, après accord explicite : exactement `source` (jamais un lien symbolique), distinct de la
 * copie, et seulement si la copie installée a le même contenu.
 */
export async function deleteOriginal(o: { source: string; dest: string }): Promise<void> {
  const [srcReal, destReal] = await Promise.all([realOrNull(o.source), realOrNull(o.dest)]);
  if (!srcReal) throw new Error(`Fichier introuvable : ${o.source}`);
  if (srcReal === destReal) throw new Error('C’est la copie installée : non supprimée');
  const l = await lstat(o.source);
  if (l.isSymbolicLink()) throw new Error(`${o.source} est un lien symbolique : non supprimé`);
  if (!l.isFile()) throw new Error(`${o.source} n’est pas un fichier ordinaire : non supprimé`);
  const d = await lstat(o.dest).catch(() => null);
  if (!d?.isFile() || !(await sameContent(o.source, o.dest))) throw new Error('La copie installée ne correspond pas au fichier téléchargé : rien supprimé');
  await unlink(o.source);
}

// ---------------------------------------------------------------- démarrage avec la session

/**
 * Programme à lancer (démarrage automatique) : la copie installée si l'app tourne en AppImage et qu'elle existe, sinon
 * l'AppImage lancée, sinon le binaire empaqueté (.deb) ; null en version de développement.
 */
export function launchTarget(o: { roots: Roots; appImage?: string; packaged: boolean; execPath: string }): string | null {
  if (o.appImage) {
    const copy = appPaths(o.roots).appImage;
    try {
      if (lstatSync(copy).isFile()) return copy;
    } catch {
      // pas installée
    }
    return o.appImage;
  }
  return o.packaged ? o.execPath : null;
}

export function autostartState(r: Roots): { enabled: boolean; path: string } {
  const path = appPaths(r).autostart;
  try {
    lstatSync(path);
    return { enabled: true, path };
  } catch {
    return { enabled: false, path };
  }
}

/** Retire un fichier de proc-watch : dernier élément jamais suivi (lien symbolique refusé), absent → false. */
function removeOwnFile(path: string): boolean {
  let parent: string;
  try {
    parent = realpathSync(dirname(path));
  } catch (e) {
    if (code(e) === 'ENOENT') return false;
    throw e;
  }
  const target = join(parent, basename(path));
  let st;
  try {
    st = lstatSync(target);
  } catch (e) {
    if (code(e) === 'ENOENT') return false;
    throw e;
  }
  if (st.isSymbolicLink()) throw new Error(`${path} est un lien symbolique : non suivi, laissé en place`);
  if (!st.isFile()) throw new Error(`${path} n’est pas un fichier ordinaire : laissé en place`);
  unlinkSync(target);
  return true;
}

/** Entrée .desktop écrite par proc-watch (X-ProcWatch-Managed=1) ? Lue sans suivre de lien ; illisible → non. */
function managedEntry(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) return false;
    return isManagedEntry(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}

/** ~/.config/autostart/proc-watch.desktop avec `--hidden` (écriture atomique), ou retiré. */
export function setAutostart(on: boolean, target: string | null, r: Roots): void {
  const path = appPaths(r).autostart;
  if (!on) {
    if (present(path) && !lstatSync(path).isSymbolicLink() && !managedEntry(path)) throw new Error(`${path} n’a pas été créé par proc-watch : laissé en place`);
    removeOwnFile(path);
    return;
  }
  if (!target) throw new Error('Disponible uniquement dans la version installée (AppImage ou .deb)');
  writeFileAtomic(path, desktopEntryContent(target, { args: ['--hidden'], autostart: true }));
}

// ---------------------------------------------------------------- désinstallation


/** Fichiers du dossier de données que proc-watch (app et service) crée ; tout autre fichier y reste. */
const DATA_FILES = [
  'metrics.db', 'metrics.db-wal', 'metrics.db-shm', 'recorder-status.json', 'app-events.jsonl', 'app-events.jsonl.ingest', 'clear-request',
  'forecast-snooze.json', 'rules-simulation.json', 'app-focus.json', 'tmp-set-aside.json',
];
const CONFIG_FILES = ['config.json', 'config.json.bak', 'onboarding.json'];
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
  appimage: 'Application',
};

const allowedName = (name: string, files: string[], patterns: RegExp[]) => files.includes(name) || patterns.some((p) => p.test(name));

/** Le chemin existe-t-il (lien symbolique compris, jamais suivi) ? */
function present(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Fichiers connus d'un dossier de proc-watch ; dossier remplacé par un lien symbolique → son contenu n'est jamais lu. */
function ownFiles(dir: string, files: string[], patterns: RegExp[]): string[] {
  try {
    if (!lstatSync(dir).isDirectory()) return [];
    return readdirSync(dir).filter((n) => allowedName(n, files, patterns)).sort().map((n) => join(dir, n));
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
    if ((kind === 'autostart' || kind === 'desktop') && !lstatSync(path).isSymbolicLink() && !managedEntry(path)) continue;
    out.push(item(kind, path));
  }
  if (o.history) {
    for (const f of ownFiles(p.dataDir, DATA_FILES, DATA_PATTERNS)) out.push(item('history', f));
    if (present(p.dataDir)) out.push(item('history', p.dataDir, true));
  }
  if (o.config) {
    for (const f of ownFiles(p.configDir, CONFIG_FILES, CONFIG_PATTERNS)) out.push(item('config', f));
    if (present(p.configDir)) out.push(item('config', p.configDir, true));
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
    case 'config': return i.dir ? i.path === p.configDir : dirname(i.path) === p.configDir && allowedName(basename(i.path), CONFIG_FILES, CONFIG_PATTERNS);
    default: return false;
  }
}


export interface UninstallDeps {
  /** Arrête et désactive le service avant de retirer son unité ; renvoie un message d'erreur ou null. */
  service: { stop(unitPath: string): Promise<string | null>; reload(): Promise<void> };
  /** Avant le premier fichier d'historique : fermer la base ouverte par l'app. */
  beforeHistory?: () => void;
  onRemoved?: (path: string) => void;
}

/** Dossier de proc-watch : jamais un lien symbolique (son contenu serait ailleurs). */
function ownDirOk(dir: string): string | null {
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) return `${dir} est un lien symbolique : non suivi, laissé en place`;
    if (!st.isDirectory()) return `${dir} n’est pas un dossier : laissé en place`;
    return null;
  } catch (e) {
    return code(e) === 'ENOENT' ? null : errText(e);
  }
}

/**
 * Exécute un plan confirmé. Chaque élément est revérifié : dans la liste autorisée, dernier élément jamais suivi (lstat),
 * parent résolu par realpath ; un dossier n'est retiré que vide. La copie de l'AppImage n'est retirée qu'en dernier et
 * seulement si rien n'a échoué avant (sinon elle reste, pour réessayer). Les échecs sont rapportés un par un.
 */
export async function runUninstall(plan: readonly UninstallItem[], r: Roots, deps: UninstallDeps): Promise<UninstallResult> {
  const res: UninstallResult = { removed: [], failed: [], kept: [], done: false };
  const fail = (path: string, error: string) => res.failed.push({ path, error });
  let historyClosed = false;
  const ordered = [...plan.filter((i) => i.kind !== 'appimage'), ...plan.filter((i) => i.kind === 'appimage')];
  for (const i of ordered) {
    if (!allowed(r, i)) {
      fail(i.path, 'hors de la liste des fichiers de proc-watch : refusé');
      continue;
    }
    if (i.kind === 'appimage' && res.failed.length) {
      res.kept.push({ path: i.path, reason: 'gardée : des éléments n’ont pas pu être retirés (réessayer après correction)' });
      continue;
    }
    if (i.kind === 'history' && !historyClosed) {
      historyClosed = true;
      deps.beforeHistory?.();
    }
    if ((i.kind === 'history' || i.kind === 'config') && !i.dir) {
      const bad = ownDirOk(dirname(i.path));
      if (bad) {
        fail(i.path, bad);
        continue;
      }
    }
    try {
      if (i.dir) {
        const bad = ownDirOk(i.path);
        if (bad) {
          fail(i.path, bad);
          continue;
        }
        try {
          rmdirSync(i.path);
          res.removed.push(i.path);
          deps.onRemoved?.(i.path);
        } catch (e) {
          if (code(e) === 'ENOENT') continue;
          if (code(e) === 'ENOTEMPTY' || code(e) === 'EEXIST') res.kept.push({ path: i.path, reason: 'dossier non vide : fichiers inconnus laissés' });
          else fail(i.path, errText(e));
        }
        continue;
      }
      if (i.kind === 'service') {
        if (!present(i.path)) continue;
        const l = lstatSync(i.path);
        if (l.isSymbolicLink()) {
          fail(i.path, `${i.path} est un lien symbolique : non suivi, laissé en place`);
          continue;
        }
        const err = await deps.service.stop(i.path);
        if (err) {
          fail(i.path, err);
          continue;
        }
        if (removeOwnFile(i.path)) {
          res.removed.push(i.path);
          deps.onRemoved?.(i.path);
        }
        await deps.service.reload();
        continue;
      }
      if ((i.kind === 'autostart' || i.kind === 'desktop') && present(i.path) && !lstatSync(i.path).isSymbolicLink() && !managedEntry(i.path)) {
        res.kept.push({ path: i.path, reason: 'pas créé par proc-watch (sans X-ProcWatch-Managed=1) : laissé' });
        continue;
      }
      if (removeOwnFile(i.path)) {
        res.removed.push(i.path);
        deps.onRemoved?.(i.path);
      }
    } catch (e) {
      fail(i.path, e instanceof Error && !code(e) ? e.message : errText(e));
    }
  }
  res.done = res.failed.length === 0 && !res.kept.some((k) => k.path === appPaths(r).appImage);
  return res;
}

/** Texte de la confirmation native : exactement ce qui sera retiré. */
export function uninstallSummary(plan: readonly UninstallItem[], o: { deb: boolean }): { message: string; detail: string } {
  const lines = plan.length ? plan.map((i) => `• ${i.label}${i.dir ? ' (dossier, s’il est vide)' : ''} : ${i.path}`) : ['• (aucun fichier de proc-watch trouvé)'];
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
 * Arrête le service avant de retirer son unité. Jamais d'appel systemctl avec PROC_WATCH_NO_RECORDER_SYNC ; jamais d'arrêt
 * d'une unité chargée depuis un autre fichier (ex. app de test avec un XDG_CONFIG_HOME temporaire : le vrai service reste).
 */
export async function stopRecorderForUninstall(o: { unitPath: string; run: Systemctl; disabled: boolean }): Promise<{ stopped: boolean; error: string | null }> {
  if (o.disabled) return { stopped: false, error: null };
  const show = await o.run(['show', '-p', 'FragmentPath', '--value', UNIT_NAME]);
  const frag = show.ok ? show.stdout.trim() : '';
  if (!frag) return { stopped: false, error: null };
  const same = (a: string, b: string) => {
    try {
      return realpathSync(a) === realpathSync(b);
    } catch {
      return a === b;
    }
  };
  if (!same(frag, o.unitPath)) return { stopped: false, error: null };
  const d = await o.run(['disable', '--now', UNIT_NAME]);
  return d.ok ? { stopped: true, error: null } : { stopped: false, error: 'systemctl --user disable --now a échoué : service laissé en place' };
}
