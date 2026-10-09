// Ménage du disque (page Disque, lot 1) : tout se décide ici, dans le main. Le renderer n'envoie que des ids de familles ;
// les chemins sont recalculés depuis HOME / XDG. Avant la confirmation native, puis de nouveau juste avant de supprimer :
// existence, type, jamais de lien, même disque que le dossier personnel, aucun point de montage dessous, personne ne
// l'utilise (cwd, fd ou mmap d'un processus de l'utilisateur ; outil de la famille en cours). Suppression par descripteurs
// (safeFs : O_NOFOLLOW, jamais de lien suivi ni de montage traversé). Familles root : script figé via pkexec (diskRoot.ts).
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { cacheSignature, familyDef, familyPaths, familyRootRefusal, isFamilyRequest, toolName, JOURNAL_DIR, PKG_CACHE_DIRS, usedByText, type FamilyId, type FamilyRoots } from '../core/disk/families';
import { browserDropPaths } from '../core/disk/measure';
import type { DiskCleanEvent } from '../core/history/events';
import { rootUnavailable, type RootAction } from './diskRoot';
import { listDirSafe, mountPointsOf, removeTreeSafe } from './safeFs';

export type { RootAction };
export interface Holder { pid: number; name: string }

/**
 * `freedKB` : place libérée mesurée (statfs avant / après) ; `estimatedKB` : somme des estimations des familles traitées
 * (certains systèmes de fichiers, btrfs notamment, ne montrent la place libérée qu'après quelques secondes).
 */
export interface CleanResult { freedKB: number; estimatedKB?: number; done: FamilyId[]; refused: { id: FamilyId; reason: string }[]; cancelled: boolean }

export interface CleanDeps {
  roots: FamilyRoots;
  /** Confirmation native unique (récapitulatif) ; vrai pour supprimer. */
  confirm(summary: { message: string; detail: string }): Promise<boolean>;
  /** Processus de l'utilisateur (hors l'app) qui a son cwd, un fd ou un mmap sous ce dossier (realDirUser). */
  dirUser(dir: string): Holder | null;
  /** Processus de l'utilisateur dont le nom (comm) est dans la liste. */
  procByName(names: readonly string[]): Holder | null;
  statfs(p: string): { availKB: number };
  runRoot(action: RootAction): Promise<{ ok: boolean; cancelled: boolean; error?: string }>;
  /** Contenu de /proc/self/mountinfo. */
  mountinfo(): string;
  /** Place libérée estimée par famille (dernière mesure), pour la confirmation. */
  sizes?: Partial<Record<FamilyId, number | null>>;
  /** Famille root présente sur ce système (défaut : son dossier existe). */
  rootPresent?(id: RootAction): boolean;
  /** Taille de chaque chemin à supprimer, pour la confirmation (absent : « taille inconnue »). */
  pathSizes?(paths: string[]): Promise<Map<string, number>>;
  /** Famille root indisponible (outil manquant) : raison, ou null (défaut : rootUnavailable de diskRoot.ts). */
  rootUnavailable?(id: RootAction): string | null;
}

const fmt = (kb: number) =>
  kb >= 1024 * 1024 ? `${(kb / (1024 * 1024)).toFixed(1).replace('.', ',')} Go` : kb >= 1024 ? `${Math.round(kb / 1024)} Mo` : `${Math.round(kb)} Ko`;

const isUnder = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

const exists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

const defaultRootPresent = (id: RootAction) =>
  id === 'pkg-cache' ? PKG_CACHE_DIRS.some((d) => existsSync(d)) : existsSync(JOURNAL_DIR) || existsSync('/run/log/journal');

/** Racine safeFs d'un chemin de famille : la racine XDG la plus longue qui le contient. */
function rootOf(r: FamilyRoots, p: string): string {
  return [r.cacheHome, r.dataHome, r.configHome, r.home].filter((x) => p.startsWith(`${x.replace(/\/+$/, '')}/`)).sort((a, b) => b.length - a.length)[0] ?? r.home;
}

/**
 * Raison de refus d'un chemin de famille (null : supprimable). Absent : null (rien à faire pour ce chemin).
 * Échec fermé : toute erreur de vérification refuse.
 */
function checkPath(p: string, homeDev: number, d: CleanDeps): string | null {
  // affichage : chemin abrégé sous le dossier personnel (« ~/.cache/uv »)
  const home = d.roots.home.replace(/\/+$/, '');
  const shown = p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p;
  let st;
  try {
    st = lstatSync(p);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : `vérification impossible (${(e as Error).message})`;
  }
  if (st.isSymbolicLink()) return `${shown} : lien symbolique, refusé (jamais suivi)`;
  if (!st.isDirectory()) return `${shown} : pas un dossier`;
  if (st.dev !== homeDev) return `${shown} : sur un autre disque que le dossier personnel`;
  let real: string;
  try {
    real = realpathSync(p);
    // aucun lien entre la racine (HOME ou XDG, qui peut en être un : choix de l'utilisateur) et le dossier
    const root = rootOf(d.roots, p);
    if (real !== join(realpathSync(root), p.slice(root.replace(/\/+$/, '').length + 1))) return `${shown} : lien symbolique dans le chemin, refusé`;
  } catch (e) {
    return `vérification impossible (${(e as Error).message})`;
  }
  let mounts: string[];
  try {
    mounts = mountPointsOf(d.mountinfo());
  } catch {
    return 'points de montage illisibles';
  }
  const m = mounts.find((x) => isUnder(x, real));
  if (m) return `point de montage sous ${shown}`;
  const user = d.dirUser(p);
  return user ? usedByText(user) : null;
}

/** Noms d'un dossier réel (jamais à travers un lien) ; null : absent, lien ou illisible. */
function lsReal(p: string): string[] | null {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink() ? readdirSync(p) : null;
  } catch {
    return null;
  }
}

/** Ce qui sera supprimé, chemin par chemin (affiché dans la confirmation). Corbeille : le contenu de ses dossiers. */
function targetsOf(id: FamilyId, r: FamilyRoots): { path: string; contents?: true }[] {
  if (id === 'test-browsers') return browserDropPaths(r).map((path) => ({ path }));
  if (id === 'trash') return familyPaths(id, r).filter(exists).map((path) => ({ path, contents: true as const }));
  return familyPaths(id, r).filter(exists).map((path) => ({ path }));
}

/** Revérification complète d'une famille : null si supprimable, 'absent' si aucun de ses chemins n'existe, sinon la raison. */
function checkFamily(id: FamilyId, homeDev: number, d: CleanDeps): string | null | 'absent' {
  const def = familyDef(id);
  if (def.root) {
    if (!(d.rootPresent ?? defaultRootPresent)(id as RootAction)) return 'absent';
    const missing = (d.rootUnavailable ?? ((x: RootAction) => rootUnavailable(x, existsSync)))(id as RootAction);
    if (missing) return missing;
  } else {
    const xdg = familyRootRefusal(id, d.roots);
    if (xdg) return xdg;
    const paths = familyPaths(id, d.roots);
    if (!paths.some(exists)) return 'absent';
    for (const p of paths) {
      const why = checkPath(p, homeDev, d);
      if (why) return why;
      // signature de l'outil (lecture des noms seulement ; checkPath a écarté liens et autres disques)
      if (exists(p) && !cacheSignature(id, p, lsReal)) return `ne ressemble pas à un cache de ${toolName[id]}`;
    }
  }
  const busy = def.processNames.length ? d.procByName(def.processNames) : null;
  return busy ? usedByText(busy) : null;
}

/** Supprime une famille hors root (déjà revérifiée) ; lève en cas d'échec (une partie a pu être supprimée). */
function removeFamily(id: FamilyId, d: CleanDeps): void {
  const mountinfo = d.mountinfo();
  const r = d.roots;
  if (id === 'test-browsers') {
    // anciennes versions seulement, une par une
    for (const p of browserDropPaths(r)) removeTreeSafe([rootOf(r, p)], p, { mountinfo });
    return;
  }
  if (id === 'trash') {
    // contenu de files et info, élément par élément ; les dossiers restent
    for (const dir of familyPaths('trash', r)) {
      const root = rootOf(r, dir);
      for (const name of listDirSafe([root], dir)) removeTreeSafe([root], join(dir, name), { mountinfo, allowTopLink: true });
    }
    return;
  }
  for (const p of familyPaths(id, r)) removeTreeSafe([rootOf(r, p)], p, { mountinfo });
}

/** Points où mesurer le libre (un par périphérique) : le dossier personnel et les dossiers des familles root. */
function statfsPoints(ids: readonly FamilyId[], r: FamilyRoots): string[] {
  const byDev = new Map<number, string>();
  const add = (p: string) => {
    try {
      const dev = lstatSync(p).dev;
      if (!byDev.has(dev)) byDev.set(dev, p);
    } catch {
      // absent
    }
  };
  add(r.home);
  for (const id of ids) if (familyDef(id).root) familyPaths(id, r).forEach(add);
  return [...byDev.values()];
}

function confirmSummary(
  ids: readonly FamilyId[], refused: CleanResult['refused'], sizes: CleanDeps['sizes'], targets: Map<FamilyId, { path: string; contents?: true }[]>, pathKB: Map<string, number>,
): { message: string; detail: string } {
  const known = ids.map((id) => sizes?.[id]).filter((v): v is number => typeof v === 'number');
  const total = known.reduce((s, v) => s + v, 0);
  const n = ids.length;
  const message = known.length ? `Libérer ≈ ${fmt(total)} ?` : `Libérer l’espace de ${n} famille${n > 1 ? 's' : ''} ?`;
  const lines = ids.map((id) => {
    const def = familyDef(id);
    const s = sizes?.[id];
    const head = `• ${def.label} — ${typeof s === 'number' ? `≈ ${fmt(s)}` : 'taille inconnue'}${def.root ? ' (administrateur : mot de passe demandé)' : ''}`;
    // chemins exacts, chacun avec sa taille
    const paths = (targets.get(id) ?? []).map((t) => {
      const kb = pathKB.get(t.path);
      return `    ${t.contents ? 'contenu de ' : ''}${t.path} (${kb === undefined ? 'taille inconnue' : fmt(kb)})`;
    });
    return [head, ...paths].join('\n');
  });
  for (const r of refused) lines.push(`Refusé : ${familyDef(r.id).label} — ${r.reason}`);
  lines.push('', 'C’est définitif : la corbeille ne libérerait rien.');
  return { message, detail: lines.join('\n') };
}

export async function cleanFamilies(ids: readonly FamilyId[], d: CleanDeps): Promise<CleanResult> {
  if (!isFamilyRequest(ids)) throw new Error('requête refusée : familles inconnues ou en double');
  const homeDev = lstatSync(d.roots.home).dev;
  const refused: CleanResult['refused'] = [];
  const ok: FamilyId[] = [];
  for (const id of ids) {
    const why = checkFamily(id, homeDev, d);
    if (why === 'absent') refused.push({ id, reason: 'introuvable' });
    else if (why) refused.push({ id, reason: why });
    else ok.push(id);
  }
  if (!ok.length) return { freedKB: 0, done: [], refused, cancelled: false };
  const targets = new Map(ok.filter((id) => !familyDef(id).root).map((id) => [id, targetsOf(id, d.roots)] as const));
  let pathKB = new Map<string, number>();
  try {
    if (d.pathSizes) pathKB = await d.pathSizes([...targets.values()].flat().map((t) => t.path));
  } catch {
    // tailles inconnues
  }
  if (!(await d.confirm(confirmSummary(ok, refused, d.sizes, targets, pathKB)))) return { freedKB: 0, done: [], refused, cancelled: true };

  const points = statfsPoints(ok, d.roots);
  const avail = () => points.map((p) => {
    try {
      return d.statfs(p).availKB;
    } catch {
      return null;
    }
  });
  const before = avail();
  const done: FamilyId[] = [];
  // hors root d'abord, puis root (une fenêtre pkexec par action)
  for (const id of [...ok.filter((x) => !familyDef(x).root), ...ok.filter((x) => familyDef(x).root)]) {
    // revérification juste avant : la situation a pu changer pendant la confirmation
    const why = checkFamily(id, homeDev, d);
    if (why) {
      refused.push({ id, reason: why === 'absent' ? 'introuvable' : why });
      continue;
    }
    if (familyDef(id).root) {
      const r = await d.runRoot(id as RootAction);
      if (r.ok) done.push(id);
      else refused.push({ id, reason: r.cancelled ? 'annulé' : r.error ?? 'échec' });
      continue;
    }
    // revue m-1 : archives .asar désactivées seulement pendant la suppression, synchrone (jamais pendant la
    // confirmation ni pendant pkexec) ; un fichier .asar d'un cache est alors un fichier comme un autre
    const proc = process as unknown as { noAsar?: boolean };
    const noAsar = proc.noAsar;
    try {
      proc.noAsar = true;
      removeFamily(id, d);
      done.push(id);
    } catch (e) {
      refused.push({ id, reason: `${(e as Error).message} (arrêté ; une partie a pu être supprimée)` });
    } finally {
      proc.noAsar = noAsar;
    }
  }
  const after = avail();
  const freedKB = Math.max(0, before.reduce<number>((s, b, i) => (b === null || after[i] === null ? s : s + (after[i]! - b)), 0));
  const estimatedKB = done.reduce((t, id) => t + (d.sizes?.[id] ?? 0), 0);
  return { freedKB, ...(estimatedKB > 0 ? { estimatedKB } : {}), done, refused, cancelled: false };
}

/** Événement d'historique (app-events.jsonl) : rien si aucune famille traitée ni refusée (annulé). */
export function diskCleanEvent(r: CleanResult, ts: number): DiskCleanEvent | null {
  if (!r.done.length && !r.refused.length) return null;
  return { ts, type: 'disk_clean', groupKey: null, detail: { freedKB: r.freedKB, done: [...r.done], refused: r.refused.map((x) => ({ id: x.id, reason: x.reason })) } };
}

/**
 * Processus de l'utilisateur (hors l'app : `selfPid` et ses descendants) dont le nom (/proc/<pid>/comm, 15 caractères)
 * est dans la liste. Lecture de /proc seulement.
 */
export function realProcByName(names: readonly string[], o: { selfPid?: number; uid?: number; procRoot?: string } = {}): Holder | null {
  const proc = o.procRoot ?? '/proc';
  const want = new Set(names.map((n) => n.slice(0, 15)));
  const selfPid = o.selfPid ?? process.pid;
  const uid = o.uid ?? process.getuid!();
  let pids: number[];
  try {
    pids = readdirSync(proc).filter((e) => /^\d+$/.test(e)).map(Number);
  } catch {
    return null;
  }
  const parent = new Map<number, number>();
  const comm = new Map<number, string>();
  for (const pid of pids) {
    try {
      const st = readFileSync(`${proc}/${pid}/stat`, 'utf8');
      parent.set(pid, Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]));
      comm.set(pid, readFileSync(`${proc}/${pid}/comm`, 'utf8').trim());
    } catch {
      // disparu
    }
  }
  const ours = new Set([selfPid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [pid, pp] of parent) if (!ours.has(pid) && ours.has(pp)) (ours.add(pid), (changed = true));
  }
  for (const [pid, name] of comm) {
    if (ours.has(pid) || !want.has(name)) continue;
    try {
      if (lstatSync(`${proc}/${pid}`).uid !== uid) continue;
    } catch {
      continue;
    }
    return { pid, name };
  }
  return null;
}

/** Raison de refus visible sans parcourir les processus (lien, autre disque, montage) : pour la liste de la page. */
export function staticRefusal(id: FamilyId, d: Pick<CleanDeps, 'roots' | 'mountinfo' | 'rootPresent' | 'rootUnavailable'>): string | null {
  const why = checkFamily(id, lstatSync(d.roots.home).dev, { ...d, dirUser: () => null, procByName: () => null } as unknown as CleanDeps);
  return why === 'absent' ? null : why;
}
