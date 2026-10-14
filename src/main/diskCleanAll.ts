// Ménage unifié de la page Disque : familles (lot 1) et éléments du lot 2 (node_modules, worktrees, dossiers inconnus de
// ~/.cache, actions Docker) dans une seule confirmation native. Chaque élément est revérifié avant la confirmation et juste
// avant d'agir ; un élément absent de la dernière analyse du main est refusé (le renderer n'apporte jamais de chemin).
import { existsSync, lstatSync } from 'node:fs';
import { DOCKER_LABELS, dockerPruneArgs, type DockerView } from '../core/disk/docker';
import type { CacheDirCandidate, DiskCleanAllResult, DiskCleanRequest, NodeModulesCandidate, WorktreeCandidate } from '../core/disk/extras';
import { familyDef, isFamilyId, type FamilyRoots } from '../core/disk/families';
import type { DiskCleanEvent } from '../core/history/events';
import { checkCacheDir, removeCacheDir } from './diskCacheDirs';
import { familyLines, fmtKB, prepareFamilies, runFamilies, statfsPoints, type CleanDeps, type Holder, type PreparedFamilies } from './diskClean';
import { checkDocker, dockerPrune, dockerStatus, type DockerRun } from './diskDocker';
import { checkNodeModules, checkWorktree, removeNodeModules, removeWorktree } from './diskProjects';
import type { GitRun } from './gitRun';

export interface CleanUnit {
  id: string;
  label: string;
  estimatedKB: number | null;
  /** Point où mesurer le libre (périphérique de l'élément). */
  statfsPath?: string;
  /** Raison de refus, ou null ; appelé avant la confirmation puis juste avant `run`. */
  check(): Promise<string | null>;
  /** Lignes de détail de la confirmation (chemins, commandes, éléments Docker). */
  detail(): string[];
  /** Agit ; lève en cas d'échec ; renvoie une note (branche gardée…) ou null. */
  run(): Promise<string | null>;
}

export interface ExtrasState {
  nodeModules: ReadonlyMap<string, NodeModulesCandidate>;
  worktrees: ReadonlyMap<string, WorktreeCandidate>;
  cacheDirs: ReadonlyMap<string, CacheDirCandidate>;
  docker: DockerView | null;
}
export const EMPTY_EXTRAS: ExtrasState = { nodeModules: new Map(), worktrees: new Map(), cacheDirs: new Map(), docker: null };

export interface UnitDeps {
  roots: FamilyRoots;
  projectRoots: readonly string[];
  mountinfo(): string;
  dirUser(dir: string): Holder | null;
  git: GitRun | null;
  docker: DockerRun | null;
  now(): number;
  days: number;
  seen(): ReadonlyMap<string, number>;
  historyFrom(): number | null;
}

const STALE = 'plus dans la liste : actualiser la page';
const refusedUnit = (id: string, label: string, reason: string): CleanUnit => ({
  id, label, estimatedKB: null, check: async () => reason, detail: () => [], run: async () => {
    throw new Error(reason);
  },
});
const listItems = (items: readonly string[]) => [...items.slice(0, 20), ...(items.length > 20 ? [`… et ${items.length - 20} autres`] : [])];

/** Unités d'une requête, chacune liée à l'élément trouvé par le main (jamais au chemin envoyé par le renderer). */
export function buildUnits(req: DiskCleanRequest, s: ExtrasState, d: UnitDeps): CleanUnit[] {
  const units: CleanUnit[] = [];
  for (const key of req.nodeModules) {
    const c = s.nodeModules.get(key);
    const id = `node_modules:${key}`;
    if (!c) {
      units.push(refusedUnit(id, `node_modules (${key})`, STALE));
      continue;
    }
    units.push({
      id, label: `node_modules de ${c.label}`, estimatedKB: c.sizeKB, statfsPath: c.projectDir,
      check: () => checkNodeModules(c, { projectRoots: d.projectRoots, mountinfo: d.mountinfo, dirUser: d.dirUser, seen: d.seen(), historyFrom: d.historyFrom(), now: d.now(), days: d.days }),
      detail: () => [c.path],
      run: async () => {
        removeNodeModules(c, { projectRoots: d.projectRoots, mountinfo: d.mountinfo });
        return null;
      },
    });
  }
  for (const key of req.worktrees) {
    const c = s.worktrees.get(key);
    const id = `worktree:${key}`;
    const git = d.git;
    if (!c || !git) {
      units.push(refusedUnit(id, `worktree (${key})`, !git ? 'git introuvable' : STALE));
      continue;
    }
    units.push({
      id, label: `worktree ${c.label}`, estimatedKB: c.sizeKB, statfsPath: c.repo,
      check: () => checkWorktree(c, { git, projectRoots: d.projectRoots, now: d.now(), dirUser: d.dirUser }),
      detail: () => [c.path, `git worktree remove, puis git branch -d ${c.branch} (jamais forcé)`],
      run: () => removeWorktree(c, git),
    });
  }
  for (const key of req.cacheDirs) {
    const c = s.cacheDirs.get(key);
    const id = `cache:${key}`;
    if (!c) {
      units.push(refusedUnit(id, `~/.cache/${key}`, STALE));
      continue;
    }
    units.push({
      id, label: `~/.cache/${c.name} (inconnu)`, estimatedKB: c.sizeKB, statfsPath: c.path,
      check: async () => checkCacheDir(d.roots, c.name, { mountinfo: d.mountinfo, dirUser: d.dirUser }),
      detail: () => [`${c.path} — inconnu : vérifie avant`],
      run: async () => {
        removeCacheDir(d.roots, c.name, { mountinfo: d.mountinfo });
        return null;
      },
    });
  }
  for (const a of req.docker) {
    const id = `docker:${a}`;
    const run = d.docker;
    let view = s.docker?.actions.find((x) => x.id === a) ?? null;
    if (!view || !run) {
      units.push(refusedUnit(id, DOCKER_LABELS[a], 'Docker indisponible'));
      continue;
    }
    units.push({
      id, label: DOCKER_LABELS[a], estimatedKB: view.reclaimKB, statfsPath: existsSync('/var/lib/docker') ? '/var/lib/docker' : undefined,
      check: async () => {
        const why = await checkDocker(run);
        if (why) return why;
        view = (await dockerStatus(run))?.actions.find((x) => x.id === a) ?? view; // détail à jour pour la confirmation
        return null;
      },
      detail: () => [`docker ${dockerPruneArgs(a).join(' ')}`, ...listItems(view!.items), ...(view!.note ? [view!.note] : [])],
      run: async () => {
        await dockerPrune(run, a);
        return null;
      },
    });
  }
  return units;
}

async function safeCheck(u: CleanUnit): Promise<string | null> {
  try {
    return await u.check();
  } catch (e) {
    return `vérification impossible (${(e as Error).message})`;
  }
}

function confirmAll(fam: PreparedFamilies | null, units: readonly CleanUnit[], refused: DiskCleanAllResult['refused'], sizes: CleanDeps['sizes']) {
  const known = [...(fam?.ok ?? []).map((id) => sizes?.[id]), ...units.map((u) => u.estimatedKB)].filter((v): v is number => typeof v === 'number');
  const n = (fam?.ok.length ?? 0) + units.length;
  const message = known.length ? `Libérer ≈ ${fmtKB(known.reduce((s, v) => s + v, 0))} ?` : `Libérer l’espace de ${n} élément${n > 1 ? 's' : ''} ?`;
  const lines = fam ? familyLines(fam, sizes) : [];
  for (const u of units) lines.push([`• ${u.label} — ${u.estimatedKB === null ? 'taille inconnue' : `≈ ${fmtKB(u.estimatedKB)}`}`, ...u.detail().map((l) => `    ${l}`)].join('\n'));
  for (const r of refused) lines.push(`Refusé : ${r.label} — ${r.reason}`);
  lines.push('', 'C’est définitif : la corbeille ne libérerait rien.');
  return { message, detail: lines.join('\n') };
}

/** Un point de mesure par périphérique. */
function byDevice(paths: readonly string[]): string[] {
  const seen = new Map<number, string>();
  for (const p of paths) {
    try {
      const dev = lstatSync(p).dev;
      if (!seen.has(dev)) seen.set(dev, p);
    } catch {
      // absent
    }
  }
  return [...seen.values()];
}

export async function cleanDisk(req: DiskCleanRequest, d: { fam: CleanDeps; units: CleanUnit[] }): Promise<DiskCleanAllResult> {
  const fam = req.families.length ? await prepareFamilies(req.families, d.fam) : null;
  const refused: DiskCleanAllResult['refused'] = (fam?.refused ?? []).map((x) => ({ id: x.id, label: familyDef(x.id).label, reason: x.reason }));
  const ok: CleanUnit[] = [];
  for (const u of d.units) {
    const why = await safeCheck(u);
    if (why) refused.push({ id: u.id, label: u.label, reason: why });
    else ok.push(u);
  }
  const famOk = fam?.ok ?? [];
  if (!famOk.length && !ok.length) return { freedKB: 0, done: [], refused, notes: [], cancelled: false };
  d.fam.onPhase?.('confirming');
  if (!(await d.fam.confirm(confirmAll(fam, ok, refused, d.fam.sizes)))) return { freedKB: 0, done: [], refused, notes: [], cancelled: true };
  d.fam.onPhase?.('cleaning');
  const points = byDevice([...statfsPoints(famOk, d.fam.roots), ...ok.flatMap((u) => (u.statfsPath ? [u.statfsPath] : []))]);
  const avail = () => points.map((p) => {
    try {
      return d.fam.statfs(p).availKB;
    } catch {
      return null;
    }
  });
  const before = avail();
  const done: string[] = [];
  const notes: DiskCleanAllResult['notes'] = [];
  if (fam && famOk.length) {
    const r = await runFamilies(fam, d.fam);
    done.push(...r.done);
    for (const x of r.refused) refused.push({ id: x.id, label: familyDef(x.id).label, reason: x.reason });
  }
  for (const u of ok) {
    const why = await safeCheck(u);
    if (why) {
      refused.push({ id: u.id, label: u.label, reason: why });
      continue;
    }
    try {
      const note = await u.run();
      done.push(u.id);
      if (note) notes.push({ id: u.id, label: u.label, note });
    } catch (e) {
      refused.push({ id: u.id, label: u.label, reason: `${(e as Error).message} (arrêté ; une partie a pu être supprimée)` });
    }
  }
  const after = avail();
  const freedKB = Math.max(0, before.reduce<number>((s, b, i) => (b === null || after[i] === null ? s : s + (after[i]! - b)), 0));
  const estimatedKB = done.reduce((t, id) => t + ((isFamilyId(id) ? d.fam.sizes?.[id] : ok.find((u) => u.id === id)?.estimatedKB) ?? 0), 0);
  return { freedKB, ...(estimatedKB > 0 ? { estimatedKB } : {}), done, refused, notes, cancelled: false };
}

/** Événement d'historique (app-events.jsonl) : rien si aucun élément traité ni refusé (annulé). */
export function diskCleanAllEvent(r: DiskCleanAllResult, ts: number): DiskCleanEvent | null {
  if (!r.done.length && !r.refused.length) return null;
  return { ts, type: 'disk_clean', groupKey: null, detail: { freedKB: r.freedKB, done: [...r.done], refused: r.refused.map((x) => ({ id: x.id, reason: x.reason })) } };
}
