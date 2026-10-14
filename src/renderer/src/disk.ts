// Page Disque (logique pure) : sélection des familles, liens soleil ↔ familles, fil d'Ariane, textes, géométrie du soleil.
import { familyDef, isFamilyId, type FamilyDef, type FamilyId, type FamilyMeasure } from '../../core/disk/families';
import type { DockerAction, DockerActionView } from '../../core/disk/docker';
import type { DiskCleanRequest, ExtrasView, NodeModulesCandidate } from '../../core/disk/extras';
import type { SunNode } from '../../core/disk/sunTree';
import { formatKB } from './format';

export type FamilyPaths = Partial<Record<FamilyId, string[]>>;

const within = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

/** Place libérée estimée des familles cochées (tailles inconnues ignorées). */
export function selectedTotal(measures: readonly FamilyMeasure[], selected: ReadonlySet<FamilyId>): number {
  return measures.reduce((s, m) => s + (selected.has(m.id) && m.reclaimKB !== null ? m.reclaimKB : 0), 0);
}

/** Famille d'un segment du soleil : son chemin est un chemin de famille ou se trouve dedans (jamais un dossier parent). */
export function familyOfPath(path: string, paths: FamilyPaths): FamilyId | null {
  for (const [id, list] of Object.entries(paths) as [FamilyId, string[]][]) if (list.some((d) => within(path, d))) return id;
  return null;
}

/** Segments à surligner : ceux des familles cochées. */
export function highlighted(selected: ReadonlySet<FamilyId>, paths: FamilyPaths): (path: string) => boolean {
  const dirs = [...selected].flatMap((id) => paths[id] ?? []);
  return (path) => dirs.some((d) => within(path, d));
}

export interface Crumb { label: string; path: string }

/** Fil d'Ariane de la racine (« ~ ») au dossier affiché. */
export function breadcrumb(root: string, current: string): Crumb[] {
  const out: Crumb[] = [{ label: '~', path: root }];
  if (current === root || !current.startsWith(`${root}/`)) return out;
  let p = root;
  for (const part of current.slice(root.length + 1).split('/').filter(Boolean)) {
    p = `${p}/${part}`;
    out.push({ label: part, path: p });
  }
  return out;
}

export const refusalText = (id: FamilyId, reason: string) => `${familyDef(id).label} : ${reason}`;

export function badgeText(b: FamilyDef['badge']): string {
  return b === 'rebuild' ? 'se reconstruit' : b === 'root' ? 'root' : 'garde la plus récente';
}

const p2 = (n: number) => String(n).padStart(2, '0');
/** « mesuré à 09:05 » le jour même, sinon « mesuré le 08/10 à 09:05 ». */
export function measuredAt(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return d.toDateString() === n.toDateString() ? `mesuré à ${hm}` : `mesuré le ${p2(d.getDate())}/${p2(d.getMonth() + 1)} à ${hm}`;
}

/** Résultat du ménage : `id` = id de famille ou clé d'élément (`node_modules:<chemin>`…) ; `label` fourni par le main. */
export interface CleanOutcome {
  freedKB: number;
  estimatedKB?: number;
  done: string[];
  refused: { id: string; label?: string; reason: string }[];
  notes?: { label: string; note: string }[];
  cancelled: boolean;
}

const refusedLabel = (x: { id: string; label?: string }) => x.label ?? (isFamilyId(x.id) ? familyDef(x.id).label : x.id);

/** Toast après « Libérer… » : place libérée (statfs avant / après), refus, notes (branche gardée) ; rien si annulé. */
export function freedToast(r: CleanOutcome): { text: string; kind: 'info' | 'error' } | null {
  if (r.cancelled && !r.refused.length) return null;
  const refused = r.refused.map((x) => `${refusedLabel(x)} : ${x.reason}`).join(' ; ');
  const notes = (r.notes ?? []).map((n) => n.note).join(' ; ');
  // place pas encore visible par statfs (btrfs la montre après quelques secondes) : l'estimation, annoncée comme telle
  const est = r.estimatedKB ?? 0;
  const head = !r.done.length
    ? 'Rien libéré'
    : est > 0 && r.freedKB < est / 2
      ? `≈ ${formatKB(Math.round(est))} libérés (estimation)`
      : `${formatKB(Math.round(r.freedKB))} libérés`;
  return { text: [head, refused && `refusé : ${refused}`, notes].filter(Boolean).join(' · '), kind: r.done.length ? 'info' : 'error' };
}

/** Lot 2 : éléments cochés (clés renvoyées au main, qui ne supprime que ce que sa dernière analyse a trouvé). */
export interface ExtraSelection { nodeModules: ReadonlySet<string>; worktrees: ReadonlySet<string>; cacheDirs: ReadonlySet<string>; docker: ReadonlySet<DockerAction> }
export type ExtraKind = keyof ExtraSelection;
export const emptyExtraSelection = (): ExtraSelection => ({ nodeModules: new Set(), worktrees: new Set(), cacheDirs: new Set(), docker: new Set() });

export function toggleExtra(s: ExtraSelection, kind: ExtraKind, key: string): ExtraSelection {
  const next = new Set<string>(s[kind] as ReadonlySet<string>);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return { ...s, [kind]: next } as ExtraSelection;
}

export const extraCount = (s: ExtraSelection) => s.nodeModules.size + s.worktrees.size + s.cacheDirs.size + s.docker.size;

/** Place estimée des éléments cochés (tailles inconnues ignorées). */
export function extrasTotal(s: ExtraSelection, x: ExtrasView | null): number {
  if (!x) return 0;
  const kb = (v: number | null) => v ?? 0;
  return (
    x.nodeModules.reduce((t, c) => t + (s.nodeModules.has(c.path) ? kb(c.sizeKB) : 0), 0) +
    x.worktrees.reduce((t, c) => t + (s.worktrees.has(c.path) ? kb(c.sizeKB) : 0), 0) +
    x.cacheDirs.dirs.reduce((t, c) => t + (s.cacheDirs.has(c.name) ? kb(c.sizeKB) : 0), 0) +
    (x.docker?.actions ?? []).reduce((t, a) => t + (s.docker.has(a.id) ? kb(a.reclaimKB) : 0), 0)
  );
}

/** Action Docker sans rien à retirer (taille nulle ou inconnue, aucun élément) : case désactivée. */
export const dockerActionEmpty = (a: DockerActionView): boolean => !a.items.length && !a.reclaimKB;

/** Compteur de requêtes : seule la réponse de la dernière requête lancée est appliquée. */
export function createLatest(): { next(): number; isLatest(n: number): boolean } {
  let last = 0;
  return { next: () => ++last, isLatest: (n) => n === last };
}

/** Après une nouvelle analyse : ne garder coché que ce qui est encore proposé et sans refus. */
export function pruneExtras(s: ExtraSelection, x: ExtrasView | null): ExtraSelection {
  if (!x) return emptyExtraSelection();
  const keep = <T extends string>(set: ReadonlySet<T>, ok: ReadonlySet<string>) => new Set([...set].filter((k) => ok.has(k)));
  return {
    nodeModules: keep(s.nodeModules, new Set(x.nodeModules.map((c) => c.path))),
    worktrees: keep(s.worktrees, new Set(x.worktrees.filter((c) => !c.refusal).map((c) => c.path))),
    cacheDirs: keep(s.cacheDirs, new Set(x.cacheDirs.dirs.filter((c) => !c.refusal).map((c) => c.name))),
    docker: keep(s.docker, new Set((x.docker?.actions ?? []).filter((a) => !dockerActionEmpty(a)).map((a) => a.id))),
  };
}

/** Chemins des éléments cochés, pour les surligner dans le soleil. */
export function extraPaths(s: ExtraSelection, x: ExtrasView | null): string[] {
  if (!x) return [];
  return [
    ...x.nodeModules.filter((c) => s.nodeModules.has(c.path)).map((c) => c.path),
    ...x.worktrees.filter((c) => s.worktrees.has(c.path)).map((c) => c.path),
    ...x.cacheDirs.dirs.filter((c) => s.cacheDirs.has(c.name)).map((c) => c.path),
  ];
}

export const cleanRequest = (families: ReadonlySet<FamilyId>, s: ExtraSelection): DiskCleanRequest => ({
  families: [...families], nodeModules: [...s.nodeModules], worktrees: [...s.worktrees], cacheDirs: [...s.cacheDirs], docker: [...s.docker],
});

/** « aucun processus vu, aucun fichier modifié depuis 30 j (historique partiel) ». */
export function inactiveText(c: NodeModulesCandidate, days: number, now = Date.now()): string {
  const seen = c.lastSeen === null ? 'aucun processus vu' : `dernier processus il y a ${Math.floor((now - c.lastSeen) / 86_400_000)} j`;
  return `${seen}, aucun fichier modifié depuis ${days} j${c.partialHistory ? ' (historique partiel)' : ''}`;
}

/** Teintes des dossiers de premier niveau (maquette A). */
const PALETTE = ['#8b6cff', '#5cc8ff', '#ff8a5c', '#5cffb0', '#ffd65c', '#c39cff', '#ff5c8a', '#7bd88f'];
export const OTHER_COLOR = '#3a3d52';

/** Couleur d'un segment : celle de son dossier de premier niveau ; « autres » en gris. */
export function sunColors(tree: SunNode): (path: string) => string {
  const top = tree.children.filter((c) => !c.other);
  return (path) => {
    if (path.includes('\u0000')) return OTHER_COLOR;
    const i = top.findIndex((c) => within(path, c.path));
    return i < 0 ? OTHER_COLOR : PALETTE[i % PALETTE.length];
  };
}

const pt = (cx: number, cy: number, r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
};

/** Chemin SVG d'un segment d'anneau (angles en degrés, 0° en haut, sens horaire). */
export function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  if (a1 - a0 >= 359.999) return `${arcPath(cx, cy, r0, r1, a0, a0 + 180)} ${arcPath(cx, cy, r0, r1, a0 + 180, a1)}`;
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${pt(cx, cy, r1, a0)} A${r1},${r1} 0 ${large} 1 ${pt(cx, cy, r1, a1)} L${pt(cx, cy, r0, a1)} A${r0},${r0} 0 ${large} 0 ${pt(cx, cy, r0, a0)} Z`;
}

export type CleanPhase = 'measuring' | 'confirming' | 'cleaning';

/** Libellé du bouton « Libérer… » (revue n-3 : la mesure des tailles avant la confirmation est signalée). */
export function freeButtonLabel(count: number, totalKB: number, phase: CleanPhase | null): string {
  if (phase === 'measuring') return 'Mesure des tailles…';
  if (phase === 'confirming') return 'Confirmation…';
  if (phase === 'cleaning') return 'Suppression…';
  return count ? `Libérer ≈ ${formatKB(totalKB)}…` : 'Libérer…';
}
