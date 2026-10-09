// Page Disque (logique pure) : sélection des familles, liens soleil ↔ familles, fil d'Ariane, textes, géométrie du soleil.
import { familyDef, type FamilyDef, type FamilyId, type FamilyMeasure } from '../../core/disk/families';
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

export interface CleanOutcome { freedKB: number; estimatedKB?: number; done: FamilyId[]; refused: { id: FamilyId; reason: string }[]; cancelled: boolean }

/** Toast après « Libérer… » : place libérée (statfs avant / après) et refus ; rien si annulé. */
export function freedToast(r: CleanOutcome): { text: string; kind: 'info' | 'error' } | null {
  if (r.cancelled && !r.refused.length) return null;
  const refused = r.refused.map((x) => refusalText(x.id, x.reason)).join(' ; ');
  // place pas encore visible par statfs (btrfs la montre après quelques secondes) : l'estimation, annoncée comme telle
  const est = r.estimatedKB ?? 0;
  const head = !r.done.length
    ? 'Rien libéré'
    : est > 0 && r.freedKB < est / 2
      ? `≈ ${formatKB(Math.round(est))} libérés (estimation)`
      : `${formatKB(Math.round(r.freedKB))} libérés`;
  return { text: refused ? `${head} · refusé : ${refused}` : head, kind: r.done.length ? 'info' : 'error' };
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
