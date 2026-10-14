// Page Disque, lot 2 : dossiers de projets (node_modules inactifs ; dépôts git pour les worktrees, voir plus bas).
// Parcours asynchrone (la boucle d'événements reste libre), budget de dossiers et de temps, jamais de lien suivi, jamais
// d'autre périphérique que celui de la racine. Le main ne supprime que ce qu'il a trouvé ici, après revérification.
//
// Archives .asar : sous Electron, `fs` traite un fichier `.asar` comme un dossier (lstat compris). Le parcours décide donc
// de la nature d'une entrée par le type renvoyé par readdir (getdents, jamais intercepté pour un vrai dossier) et ne lit
// jamais une entrée dont le nom finit par `.asar` ; la suppression, elle, se fait sous `process.noAsar = true`.
import { existsSync, lstatSync, realpathSync, type Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { usedByText } from '../core/disk/families';
import type { NodeModulesCandidate } from '../core/disk/extras';
import type { DuFn } from '../core/disk/measure';
import { DAY_MS, lastSeenFor, nodeModulesVerdict, SOURCE_SKIP_DIRS } from '../core/disk/projects';
import { findProjectRoot, projectLabel } from '../core/grouping/projectRoot';
import { withNoAsar, type Holder } from './diskClean';
import { mountPointsOf, removeTreeSafe } from './safeFs';

const MAX_DEPTH = 6;
const under = (p: string, dir: string) => p.startsWith(`${dir}/`);
const isAsarName = (n: string) => n.toLowerCase().endsWith('.asar');
/** Un composant du chemin finit par `.asar` : jamais lu ni supprimé hors noAsar (Electron le lirait comme une archive). */
const hasAsarPart = (p: string) => p.split('/').some(isAsarName);

async function lstatOrNull(p: string) {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
}

/** Le type de readdir ne dit rien (DT_UNKNOWN, certains systèmes de fichiers) : il faut un lstat. */
const typeUnknown = (e: Dirent) =>
  !e.isFile() && !e.isDirectory() && !e.isSymbolicLink() && !e.isFIFO() && !e.isSocket() && !e.isBlockDevice() && !e.isCharacterDevice();

/** Racine (chemin réel) la plus longue qui contient `p`, ou null. */
export function rootFor(p: string, roots: readonly string[]): string | null {
  return roots.filter((r) => under(p, r)).sort((a, b) => b.length - a.length)[0] ?? null;
}

/**
 * node_modules (avec un package.json voisin) et dépôts git (dossier `.git` réel) sous les racines, en chemins réels.
 * Jamais dans un node_modules, un .git ou un dossier caché (sauf `.worktrees`), jamais à travers un lien ou un montage.
 */
export async function findProjectDirs(
  roots: readonly string[], o: { maxDirs?: number; deadlineMs?: number; now?: () => number } = {},
): Promise<{ nodeModules: string[]; repos: string[]; truncated: boolean }> {
  const now = o.now ?? Date.now;
  const maxDirs = o.maxDirs ?? 50_000;
  const deadline = now() + (o.deadlineMs ?? 30_000);
  const real = [...new Set(roots.flatMap((r) => {
    try {
      if (hasAsarPart(r)) return [];
      const p = realpathSync(r);
      return !hasAsarPart(p) && lstatSync(p).isDirectory() ? [p] : [];
    } catch {
      return [];
    }
  }))].sort();
  const tops = real.filter((p) => !real.some((q) => q !== p && under(p, q)));
  const nodeModules: string[] = [];
  const repos: string[] = [];
  let seen = 0;
  let truncated = false;
  const walk = async (dir: string, depth: number, dev: number): Promise<void> => {
    if (truncated) return;
    if (++seen > maxDirs || now() > deadline) {
      truncated = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((e) => e.name));
    if (names.has('.git') && (await lstatOrNull(join(dir, '.git')))?.isDirectory()) repos.push(dir);
    if (names.has('node_modules') && names.has('package.json')) {
      const st = await lstatOrNull(join(dir, 'node_modules'));
      if (st?.isDirectory() && st.dev === dev) nodeModules.push(join(dir, 'node_modules'));
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const n = e.name;
      if (n === 'node_modules' || n === '.git' || (n.startsWith('.') && n !== '.worktrees') || isAsarName(n)) continue;
      if (!e.isDirectory() && !typeUnknown(e)) continue; // lien, fichier… : jamais suivi
      const st = await lstatOrNull(join(dir, n));
      if (!st?.isDirectory() || st.dev !== dev) continue; // lstat : un lien n'est jamais un dossier
      await walk(join(dir, n), depth + 1, dev);
    }
  };
  for (const r of tops) {
    const st = await lstatOrNull(r);
    if (st?.isDirectory()) await walk(r, 0, st.dev);
  }
  return { nodeModules, repos, truncated };
}

/**
 * Fichier le plus récemment modifié sous `dir` (hors `skip`, sans suivre de lien ni changer de périphérique). S'arrête au
 * premier fichier modifié depuis `since` (il suffit à dire « actif ») ; budget d'entrées dépassé sans en trouver : 'budget'.
 * Les `.asar` sont ignorés (sous Electron, leur date lue par `fs` serait celle de l'archive vue comme un dossier).
 */
export async function newestMtime(dir: string, o: { since: number; maxEntries?: number; skip?: ReadonlySet<string> }): Promise<number | null | 'budget'> {
  const max = o.maxEntries ?? 20_000;
  const skip = o.skip ?? SOURCE_SKIP_DIRS;
  if (hasAsarPart(dir)) return null;
  const top = await lstatOrNull(dir);
  if (!top?.isDirectory()) return null;
  let count = 0;
  let newest: number | null = null;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++count > max) return 'budget';
      if (isAsarName(e.name)) continue;
      const p = join(d, e.name);
      const unknown = typeUnknown(e);
      if (!e.isDirectory() && !e.isFile() && !unknown) continue; // lien, socket… : jamais suivi
      if (e.isDirectory() && skip.has(e.name)) continue;
      const st = await lstatOrNull(p);
      if (!st) continue;
      if (st.isDirectory()) {
        if (!skip.has(e.name) && st.dev === top.dev) stack.push(p);
        continue;
      }
      if (!st.isFile()) continue;
      if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
      if (st.mtimeMs >= o.since) return st.mtimeMs;
    }
  }
  return newest;
}

export interface NodeModulesScanDeps { home: string; seen: ReadonlyMap<string, number>; historyFrom: number | null; now: number; days: number; du: DuFn }

/** node_modules inactifs parmi ceux trouvés (un passage par projet pour les dates des fichiers), avec leur taille. */
export async function scanNodeModules(paths: readonly string[], d: NodeModulesScanDeps): Promise<NodeModulesCandidate[]> {
  const since = d.now - d.days * DAY_MS;
  const mtimes = new Map<string, Promise<number | null | 'budget'>>();
  const out: NodeModulesCandidate[] = [];
  for (const path of paths) {
    const pkgDir = dirname(path);
    const projectDir = findProjectRoot(pkgDir, existsSync, d.home) ?? pkgDir;
    if (!mtimes.has(projectDir)) mtimes.set(projectDir, newestMtime(projectDir, { since }));
    const lastSeen = lastSeenFor(projectDir, d.seen);
    const v = nodeModulesVerdict({ lastSeen, newestMtime: await mtimes.get(projectDir)!, historyFrom: d.historyFrom, now: d.now, days: d.days });
    if (v.inactive) out.push({ path, projectDir, label: projectLabel(pkgDir, d.home), sizeKB: null, lastSeen, partialHistory: v.partialHistory });
  }
  const sizes = out.length ? await d.du(out.map((c) => c.path)) : new Map<string, number>();
  for (const c of out) c.sizeKB = sizes.get(c.path) ?? null;
  return out.sort((a, b) => (b.sizeKB ?? -1) - (a.sizeKB ?? -1));
}

export interface NodeModulesCheckDeps {
  /** Racines de projets en chemins réels (celles du parcours). */
  projectRoots: readonly string[];
  mountinfo(): string;
  dirUser(dir: string): Holder | null;
  seen: ReadonlyMap<string, number>;
  historyFrom: number | null;
  now: number;
  days: number;
}

/** Revérification complète (avant la confirmation, puis juste avant de supprimer) : null si supprimable, sinon la raison. */
export async function checkNodeModules(c: NodeModulesCandidate, d: NodeModulesCheckDeps): Promise<string | null> {
  if (basename(c.path) !== 'node_modules' || dirname(c.path) === c.path || hasAsarPart(c.path)) return 'chemin refusé';
  if (!rootFor(c.path, d.projectRoots)) return 'hors des dossiers de projets';
  let st;
  try {
    st = lstatSync(c.path);
  } catch {
    return 'introuvable';
  }
  if (st.isSymbolicLink()) return `${c.path} : lien symbolique, refusé (jamais suivi)`;
  if (!st.isDirectory()) return 'pas un dossier';
  try {
    if (realpathSync(c.path) !== c.path) return 'lien symbolique dans le chemin, refusé';
  } catch (e) {
    return `vérification impossible (${(e as Error).message})`;
  }
  if (!existsSync(join(dirname(c.path), 'package.json'))) return 'plus de package.json à côté';
  let mounts: string[];
  try {
    mounts = mountPointsOf(d.mountinfo());
  } catch {
    return 'points de montage illisibles';
  }
  if (mounts.some((m) => m === c.path || under(m, c.path))) return `point de montage sous ${c.path}`;
  const user = d.dirUser(c.projectDir);
  if (user) return usedByText(user);
  const newest = await newestMtime(c.projectDir, { since: d.now - d.days * DAY_MS });
  const v = nodeModulesVerdict({ lastSeen: lastSeenFor(c.projectDir, d.seen), newestMtime: newest, historyFrom: d.historyFrom, now: d.now, days: d.days });
  return v.inactive ? null : `plus inactif : ${v.reason}`;
}

/**
 * Suppression par descripteurs, archives .asar désactivées. Le chemin doit être sous une racine de projets (chemin réel),
 * mais les descripteurs partent de « / » : chaque composant est ouvert en O_NOFOLLOW, si bien qu'un lien posé entre la
 * revérification et la suppression (node_modules, projet ou racine de projets remplacé par un lien) est refusé, jamais
 * suivi.
 */
export function removeNodeModules(c: NodeModulesCandidate, d: { projectRoots: readonly string[]; mountinfo(): string; remove?: typeof removeTreeSafe }): void {
  if (basename(c.path) !== 'node_modules' || hasAsarPart(c.path)) throw new Error('chemin refusé');
  if (!rootFor(c.path, d.projectRoots)) throw new Error('hors des dossiers de projets');
  withNoAsar(() => (d.remove ?? removeTreeSafe)(['/'], c.path, { mountinfo: d.mountinfo() }));
}
