// Page Disque, lot 2 (pur) : lecture des sorties de git pour les worktrees fusionnés (décisions « 1a » de la spec).

export interface WorktreeEntry { path: string; head: string | null; branch: string | null; bare: boolean; detached: boolean; locked: boolean; prunable: boolean }

/** `git worktree list --porcelain -z` : attributs séparés par NUL, entrées séparées par un champ vide. */
export function parseWorktreeList(out: string): WorktreeEntry[] {
  const list: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const field of out.split('\0')) {
    if (field === '') {
      if (cur) list.push(cur);
      cur = null;
      continue;
    }
    const sp = field.indexOf(' ');
    const k = sp < 0 ? field : field.slice(0, sp);
    const v = sp < 0 ? '' : field.slice(sp + 1);
    if (k === 'worktree') {
      if (cur) list.push(cur);
      cur = { path: v, head: null, branch: null, bare: false, detached: false, locked: false, prunable: false };
      continue;
    }
    if (!cur) continue;
    if (k === 'HEAD') cur.head = v;
    else if (k === 'branch') cur.branch = v.startsWith('refs/heads/') ? v.slice('refs/heads/'.length) : null;
    else if (k === 'bare') cur.bare = true;
    else if (k === 'detached') cur.detached = true;
    else if (k === 'locked') cur.locked = true;
    else if (k === 'prunable') cur.prunable = true;
  }
  if (cur) list.push(cur);
  return list;
}

/** Nom de branche ordinaire (jamais une option, jamais de « .. », de caractère de contrôle ni d'espace). */
export function isSafeBranchName(b: string): boolean {
  return /^[A-Za-z0-9._/-]{1,200}$/.test(b) && !b.startsWith('-') && !b.includes('..') && !b.includes('//') && !b.endsWith('/') && !b.endsWith('.lock') && !b.startsWith('/');
}

/** Raison pour laquelle un worktree n'est jamais proposé (null : candidat, sous réserve de fusion et d'état propre). */
export function worktreeExclusion(e: WorktreeEntry, index: number, defaultBranch: string): string | null {
  if (index === 0) return 'worktree principal';
  if (e.bare) return 'dépôt nu';
  if (e.detached || !e.branch) return 'détaché (sans branche)';
  if (e.locked) return 'verrouillé';
  if (e.prunable) return 'à élaguer (prunable)';
  if (e.branch === defaultBranch) return 'branche par défaut';
  if (!isSafeBranchName(e.branch)) return 'nom de branche inhabituel';
  return null;
}

/** Branche par défaut : cible de origin/HEAD, sinon main, sinon master (branches locales), sinon null. */
export function defaultBranchFrom(originHead: string | null, locals: readonly string[]): { ref: string; name: string } | null {
  const m = originHead ? /^origin\/(.+)$/.exec(originHead) : null;
  if (m && isSafeBranchName(m[1])) return { ref: `refs/remotes/origin/${m[1]}`, name: m[1] };
  for (const name of ['main', 'master']) if (locals.includes(name)) return { ref: `refs/heads/${name}`, name };
  return null;
}

export interface StatusEntry { code: string; path: string }

/** `git status --porcelain=v1 -z` : « XY chemin » ; un renommage ou une copie est suivi de l'ancien chemin. */
export function parseStatusZ(out: string): StatusEntry[] {
  const fields = out.split('\0');
  const list: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4) continue;
    const code = f.slice(0, 2);
    list.push({ code, path: f.slice(3) });
    if (code[0] === 'R' || code[0] === 'C') i++;
  }
  return list;
}

/** Fichiers ignorés qui se reconstruisent (dépendances, sorties de build, caches d'outils) : leur perte est sans risque. */
export const REBUILDABLE_IGNORED: ReadonlySet<string> = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.vite', '.cache', 'coverage', 'target', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.eslintcache', '.parcel-cache', '.svelte-kit', '.angular', '.DS_Store',
]);
const rebuildable = (p: string) => {
  const name = p.replace(/\/+$/, '').split('/').pop() ?? '';
  return REBUILDABLE_IGNORED.has(name) || /\.(tsbuildinfo|pyc)$/.test(name);
};

/** Liste des fichiers qui seraient perdus, 5 au plus affichés. */
export function lostFilesText(paths: readonly string[]): string {
  const shown = paths.slice(0, 5).join(', ');
  return `fichiers ignorés qui seraient perdus : ${shown}${paths.length > 5 ? ` et ${paths.length - 5} autres` : ''}`;
}

/**
 * Refus d'après `git status --ignored` : toute modification ou fichier non suivi (git worktree remove refuserait), ou un
 * fichier ignoré qui ne se reconstruit pas (`.env`, données locales : git worktree remove les supprimerait sans rien dire).
 */
export function statusRefusal(entries: readonly StatusEntry[]): string | null {
  if (entries.some((e) => e.code !== '!!')) return 'modifications ou fichiers non suivis';
  const keep = entries.filter((e) => !rebuildable(e.path)).map((e) => e.path);
  return keep.length ? lostFilesText(keep) : null;
}

/** Dossiers ignorés reconstructibles jamais inspectés (dépendances, caches de lint ou de bytecode). */
export const IGNORED_NOT_INSPECTED: ReadonlySet<string> = new Set([
  'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.eslintcache',
]);

/**
 * Entrées ignorées « reconstructibles » à inspecter : git n'affiche que `dist/`, pas le `.env` qu'il contient. Chemins
 * relatifs au worktree, sans « / » final.
 */
export function ignoredDirsToInspect(entries: readonly StatusEntry[]): string[] {
  return entries
    .filter((e) => e.code === '!!' && rebuildable(e.path))
    .map((e) => e.path.replace(/\/+$/, ''))
    .filter((p) => p && !IGNORED_NOT_INSPECTED.has(p.split('/').pop()!));
}

/** Nom de fichier sensible : `.env*`, clé (`*.pem`, `*.key`), base de données (`*.db`, `*.sqlite*`). */
export function isSensitiveName(n: string): boolean {
  return n.startsWith('.env') || /\.(pem|key|db)$/i.test(n) || /\.sqlite/i.test(n);
}
