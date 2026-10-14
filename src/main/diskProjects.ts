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
import { NothingRemovedError, type NodeModulesCandidate, type WorktreeCandidate } from '../core/disk/extras';
import type { DuFn } from '../core/disk/measure';
import { DAY_MS, lastSeenFor, nodeModulesVerdict, SOURCE_SKIP_DIRS } from '../core/disk/projects';
import { defaultBranchFrom, ignoredDirsToInspect, isSensitiveName, lostFilesText, parseStatusZ, parseWorktreeList, statusRefusal, worktreeExclusion } from '../core/disk/worktrees';
import { findProjectRoot, projectLabel } from '../core/grouping/projectRoot';
import { withNoAsar, type Holder } from './diskClean';
import { lastLine, riskyGitConfig, type GitRun } from './gitRun';
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
 * Racines de projets en chemins réels (dossiers seulement), jamais « / ». Racines par défaut (déduites de l'historique) :
 * refiltrées après résolution des liens, jamais HOME ni un de ses parents, jamais un dossier caché.
 */
export function realProjectRoots(roots: readonly string[], o: { home: string; isDefault: boolean; realpath?: (p: string) => string; isDir?: (p: string) => boolean }): string[] {
  const realpath = o.realpath ?? ((p: string) => realpathSync(p));
  const isDir = o.isDir ?? ((p: string) => lstatSync(p).isDirectory());
  let realHome = o.home;
  try {
    realHome = realpath(o.home);
  } catch {
    // HOME illisible : comparé tel quel
  }
  const homes = [o.home, realHome];
  return [...new Set(roots.flatMap((p) => {
    try {
      const r = realpath(p);
      if (r === '/' || !isDir(r)) return [];
      if (o.isDefault) {
        if (homes.some((h) => h === r || under(h, r))) return [];
        // dossier caché : composants sous HOME (HOME lui-même peut être n'importe où), tous les composants hors de HOME
        const h = homes.find((x) => under(r, x));
        if ((h ? r.slice(h.length + 1) : r).split('/').some((x) => x.startsWith('.'))) return [];
      }
      return [r];
    } catch {
      return [];
    }
  }))];
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

export interface NodeModulesScanDeps {
  home: string; seen: ReadonlyMap<string, number>; historyFrom: number | null; now: number; days: number; du: DuFn;
  /** Échéance globale (60 s par défaut) et nombre de projets examinés au plus (2000) : au-delà, le reste n'est pas proposé. */
  deadlineMs?: number; maxProjects?: number; clock?: () => number;
}

export const INTERRUPTED_TOO_LONG = 'analyse interrompue : trop long';

/** node_modules inactifs parmi ceux trouvés (un passage par projet pour les dates des fichiers), avec leur taille. */
export async function scanNodeModules(paths: readonly string[], d: NodeModulesScanDeps): Promise<{ nodeModules: NodeModulesCandidate[]; errors: string[] }> {
  const since = d.now - d.days * DAY_MS;
  const clock = d.clock ?? Date.now;
  const deadline = clock() + (d.deadlineMs ?? 60_000);
  const maxProjects = d.maxProjects ?? 2000;
  const mtimes = new Map<string, Promise<number | null | 'budget'>>();
  const out: NodeModulesCandidate[] = [];
  const errors: string[] = [];
  for (const path of paths) {
    if (clock() > deadline) {
      errors.push(`node_modules : ${INTERRUPTED_TOO_LONG}`);
      break;
    }
    const pkgDir = dirname(path);
    const projectDir = findProjectRoot(pkgDir, existsSync, d.home) ?? pkgDir;
    if (!mtimes.has(projectDir)) {
      if (mtimes.size >= maxProjects) {
        errors.push(`node_modules : analyse interrompue : plus de ${maxProjects} projets`);
        break;
      }
      mtimes.set(projectDir, newestMtime(projectDir, { since }));
    }
    const lastSeen = lastSeenFor(projectDir, d.seen);
    const v = nodeModulesVerdict({ lastSeen, newestMtime: await mtimes.get(projectDir)!, historyFrom: d.historyFrom, now: d.now, days: d.days });
    if (v.inactive) out.push({ path, projectDir, label: projectLabel(pkgDir, d.home), sizeKB: null, lastSeen, partialHistory: v.partialHistory });
  }
  const sizes = out.length ? await d.du(out.map((c) => c.path)) : new Map<string, number>();
  for (const c of out) c.sizeKB = sizes.get(c.path) ?? null;
  return { nodeModules: out.sort((a, b) => (b.sizeKB ?? -1) - (a.sizeKB ?? -1)), errors };
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

async function defaultBranch(git: GitRun, repo: string): Promise<{ ref: string; name: string } | null> {
  const o = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: repo });
  const l = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/main', 'refs/heads/master'], { cwd: repo });
  return defaultBranchFrom(o.code === 0 ? o.stdout.trim() : null, l.code === 0 ? l.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []);
}

async function isMerged(git: GitRun, repo: string, branch: string, ref: string): Promise<boolean | null> {
  const r = await git(['merge-base', '--is-ancestor', `refs/heads/${branch}`, ref], { cwd: repo });
  return r.code === 0 ? true : r.code === 1 ? false : null;
}

/** Dossier réel (ni lien, ni lien dans le chemin). */
function realDirRefusal(p: string): string | null {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return `${p} : lien symbolique, refusé (jamais suivi)`;
    if (!st.isDirectory()) return 'pas un dossier';
    return realpathSync(p) === p ? null : 'lien symbolique dans le chemin, refusé';
  } catch {
    return 'introuvable';
  }
}

/**
 * Fichiers sensibles (`.env*`, clés, bases) sous les dossiers ignorés « reconstructibles » (`dist/`, `build/`, `.cache/`…),
 * que git status ne détaille pas. Parcours borné, sans suivre de lien ni changer de périphérique, sans entrer dans un
 * `*.asar`. Chemins relatifs au worktree ; 'budget' si trop d'entrées.
 */
export async function sensitiveIgnored(wt: string, dirs: readonly string[], maxEntries = 20_000): Promise<string[] | 'budget'> {
  const found: string[] = [];
  let count = 0;
  for (const rel of dirs) {
    if (hasAsarPart(rel)) continue;
    const top = await lstatOrNull(join(wt, rel));
    if (!top?.isDirectory()) continue; // lien ou fichier : git worktree remove n'en supprime que l'entrée
    const stack = [rel];
    while (stack.length) {
      const d = stack.pop()!;
      let entries: Dirent[];
      try {
        entries = await readdir(join(wt, d), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (++count > maxEntries) return 'budget';
        const r = `${d}/${e.name}`;
        if (isSensitiveName(e.name)) found.push(r);
        if (isAsarName(e.name) || (!e.isDirectory() && !typeUnknown(e))) continue;
        const st = await lstatOrNull(join(wt, r));
        if (st?.isDirectory() && st.dev === top.dev) stack.push(r);
      }
    }
  }
  return found.sort();
}

/**
 * Ce que git worktree remove perdrait ou exécuterait : filtre configuré (jamais de git status alors), modification ou
 * fichier non suivi, fichier ignoré non reconstructible ou sensible caché dans un dossier ignoré reconstructible.
 */
async function ignoredRefusal(git: GitRun, wt: string): Promise<string | null> {
  const risky = await riskyGitConfig(git, wt);
  if (risky) return risky;
  const s = await git(['status', '--porcelain=v1', '-z', '--ignored=traditional', '--untracked-files=normal'], { cwd: wt });
  if (s.code !== 0) return `git status impossible : ${lastLine(s.stderr)}`;
  const entries = parseStatusZ(s.stdout);
  const why = statusRefusal(entries);
  if (why) return why;
  const hidden = await sensitiveIgnored(wt, ignoredDirsToInspect(entries));
  if (hidden === 'budget') return 'trop de fichiers ignorés à vérifier';
  return hidden.length ? lostFilesText(hidden) : null;
}

/** État du worktree : propre (fichiers ignorés reconstructibles seulement) et rien de modifié depuis 24 h. */
async function worktreeStateRefusal(git: GitRun, wt: string, now: number): Promise<string | null> {
  const why = await ignoredRefusal(git, wt);
  if (why) return why;
  const newest = await newestMtime(wt, { since: now - DAY_MS, maxEntries: 50_000 });
  if (newest === 'budget') return 'trop de fichiers pour juger de l’activité';
  if (newest !== null && newest >= now - DAY_MS) return 'modifié il y a moins de 24 h';
  return null;
}

export interface WorktreeScanDeps {
  git: GitRun; projectRoots: readonly string[]; now: number; du: DuFn;
  /** Échéance globale (60 s par défaut) : au-delà, le reste n'est pas proposé. */
  deadlineMs?: number; clock?: () => number;
}

/**
 * Worktrees fusionnés des dépôts trouvés : branche ancêtre de la branche par défaut, sous les dossiers de projets ; jamais
 * le principal, un détaché, un verrouillé, un « prunable », la branche par défaut. `refusal` : listé mais pas supprimable.
 */
export async function scanWorktrees(repos: readonly string[], d: WorktreeScanDeps): Promise<{ worktrees: WorktreeCandidate[]; errors: string[] }> {
  const worktrees: WorktreeCandidate[] = [];
  const errors: string[] = [];
  const clock = d.clock ?? Date.now;
  const deadline = clock() + (d.deadlineMs ?? 60_000);
  let late = false;
  const tooLate = () => {
    if (!late && clock() > deadline) {
      late = true;
      errors.push(`worktrees : ${INTERRUPTED_TOO_LONG}`);
    }
    return late;
  };
  for (const repo of repos) {
    if (tooLate()) break;
    const def = await defaultBranch(d.git, repo);
    if (!def) {
      errors.push(`${repo} : branche par défaut introuvable (ni origin/HEAD, ni main, ni master)`);
      continue;
    }
    const l = await d.git(['worktree', 'list', '--porcelain', '-z'], { cwd: repo });
    if (l.code !== 0) {
      errors.push(`${repo} : git worktree list impossible (${lastLine(l.stderr)})`);
      continue;
    }
    const entries = parseWorktreeList(l.stdout);
    for (const [i, e] of entries.entries()) {
      if (tooLate()) break;
      if (worktreeExclusion(e, i, def.name) || !rootFor(e.path, d.projectRoots)) continue;
      if ((await isMerged(d.git, repo, e.branch!, def.ref)) !== true) continue;
      const refusal = realDirRefusal(e.path) ?? (await worktreeStateRefusal(d.git, e.path, d.now));
      worktrees.push({ path: e.path, repo, branch: e.branch!, head: e.head ?? '', label: `${basename(repo)} › ${e.branch}`, sizeKB: null, refusal });
    }
  }
  const sizes = worktrees.length ? await d.du(worktrees.map((c) => c.path)) : new Map<string, number>();
  for (const c of worktrees) c.sizeKB = sizes.get(c.path) ?? null;
  return { worktrees, errors };
}

export interface WorktreeCheckDeps { git: GitRun; projectRoots: readonly string[]; now: number; dirUser(dir: string): Holder | null }

/** Revérification complète d'un worktree avant la confirmation, puis juste avant git worktree remove. */
export async function checkWorktree(c: WorktreeCandidate, d: WorktreeCheckDeps): Promise<string | null> {
  if (!rootFor(c.path, d.projectRoots)) return 'hors des dossiers de projets';
  const def = await defaultBranch(d.git, c.repo);
  if (!def) return 'branche par défaut introuvable';
  const l = await d.git(['worktree', 'list', '--porcelain', '-z'], { cwd: c.repo });
  if (l.code !== 0) return `git worktree list impossible : ${lastLine(l.stderr)}`;
  const entries = parseWorktreeList(l.stdout);
  const i = entries.findIndex((e) => e.path === c.path);
  if (i < 0) return 'plus dans git worktree list';
  const ex = worktreeExclusion(entries[i], i, def.name);
  if (ex) return ex;
  if (entries[i].branch !== c.branch || entries[i].head !== c.head) return 'a changé depuis l’analyse : actualiser';
  if ((await isMerged(d.git, c.repo, c.branch, def.ref)) !== true) return 'branche plus fusionnée';
  const why = realDirRefusal(c.path) ?? (await worktreeStateRefusal(d.git, c.path, d.now));
  if (why) return why;
  const user = d.dirUser(c.path);
  return user ? usedByText(user) : null;
}

/**
 * `git worktree remove <chemin>` (jamais --force : git refuse lui-même un worktree sale), puis `git branch -d -- <branche>`
 * (jamais -D). Refus de la suppression du worktree : erreur. Refus de la branche : le worktree reste supprimé, note renvoyée.
 *
 * Juste avant git worktree remove, filtres configurés (dépôt et worktree) et fichiers ignorés sensibles sont revérifiés
 * (checkWorktree vient de le faire, mais git worktree remove efface les ignorés sans rien dire). Fenêtre résiduelle : un
 * fichier ignoré créé entre cette revérification et l'effacement par git (quelques millisecondes) serait perdu ; git
 * refuse en revanche tout fichier non suivi ou modifié apparu entre-temps.
 */
export async function removeWorktree(c: WorktreeCandidate, git: GitRun): Promise<string | null> {
  const why = realDirRefusal(c.path) ?? (await riskyGitConfig(git, c.repo)) ?? (await ignoredRefusal(git, c.path));
  if (why) throw new NothingRemovedError(why);
  const r1 = await git(['worktree', 'remove', c.path], { cwd: c.repo, timeoutMs: 10 * 60_000 });
  if (r1.code !== 0) throw new Error(`git a refusé de supprimer le worktree : ${lastLine(r1.stderr)}`);
  const r2 = await git(['branch', '-d', '--', c.branch], { cwd: c.repo });
  return r2.code === 0 ? null : `worktree supprimé ; branche ${c.branch} gardée : ${lastLine(r2.stderr)}`;
}
