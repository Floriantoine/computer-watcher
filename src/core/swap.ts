// Explorateur du swap (④) : lignes par groupe / instance triées par swap cumulé, état actif / endormi / inconnu. Pur.
import { flattenGroup, type FullSnapshot } from './snapshot';
import type { Category, Group, GroupKind, InstanceSummary, ProcInfo } from './types';

/** Seuil d'activité CPU (même valeur que « inactives » : ACTIVE_CPU_PERCENT de l'historique). */
const ACTIVE_CPU = 1;
/** « Endormi » : aucun CPU ≥ 1 % depuis 1 jour. */
export const SWAP_IDLE_MS = 86_400_000;

export type SleepState = { kind: 'active' } | { kind: 'sleeping'; sinceTs: number | null } | { kind: 'unknown' };

export interface SwapRow {
  /** Id du groupe, ou clé de l'instance pour une ligne enfant. */
  key: string;
  groupId: string;
  label: string;
  kind: GroupKind;
  category: Category | null;
  project: string | null;
  swapKB: number;
  rssKB: number;
  /** Instance de la ligne (enfant, ou instance unique classée d'un groupe hors projet). */
  instanceKey: string | null;
  state: SleepState;
  /** Proposée par « Arrêter les endormis » : instance endormie, non protégée, d'un projet / dossier supprimé tuable, pas lancée par Claude. */
  bulkEligible: boolean;
  protected: boolean;
  /** Groupe tuable depuis la vue (bouton « Arrêter » individuel) : jamais Claude, jamais protégé. */
  killable: boolean;
  children: SwapRow[];
}

export interface SwapView {
  swapUsedKB: number;
  swapTotalKB: number;
  shmemKB: number | null;
  /** Premier instant couvert par l'historique (« endormi depuis plus de … ») ; null sans historique. */
  historyFrom: number | null;
  rows: SwapRow[];
  /** Clés des instances `bulkEligible`, dans l'ordre des lignes. */
  sleepingKeys: string[];
}

export interface SwapInput {
  full: FullSnapshot;
  /** Dernière activité CPU ≥ 1 % par `pid:startTicks` ; null sans base d'historique. */
  lastActive: ReadonlyMap<string, number | null> | null;
  historyFrom: number | null;
  now: number;
  minSwapKB: number;
  idleMs: number;
}

const sum = (procs: readonly ProcInfo[], f: (p: ProcInfo) => number) => procs.reduce((s, p) => s + f(p), 0);

/** Groupes listés : ceux de premier niveau, et les sous-groupes de « Autres » à la place de « Autres ». */
function listedGroups(groups: readonly Group[]): Group[] {
  return groups.flatMap((g) => (g.kind === 'others' ? g.subgroups : [g]));
}

/**
 * État d'un ensemble de processus : CPU en direct ≥ 1 % → actif ; swap cumulé ≤ seuil → actif (non concerné) ; lancé depuis
 * moins de `idleMs` → actif ; historique absent ou trop court → inconnu ; dernière activité avant `now − idleMs` (ou aucune
 * dans la fenêtre) → endormi ; sinon actif.
 */
function sleepState(procs: readonly ProcInfo[], swapKB: number, ageSec: number, i: SwapInput): SleepState {
  if (sum(procs, (p) => p.cpuPercent) >= ACTIVE_CPU) return { kind: 'active' };
  if (swapKB <= i.minSwapKB) return { kind: 'active' };
  if (ageSec * 1000 < i.idleMs) return { kind: 'active' };
  if (i.lastActive === null || i.historyFrom === null || i.historyFrom > i.now - i.idleMs) return { kind: 'unknown' };
  let latest: number | null = null;
  for (const p of procs) {
    const ts = i.lastActive.get(`${p.pid}:${p.startTicks}`) ?? null;
    if (ts !== null && (latest === null || ts > latest)) latest = ts;
  }
  if (latest !== null && latest >= i.now - i.idleMs) return { kind: 'active' };
  return { kind: 'sleeping', sinceTs: latest };
}

const bySwap = (a: SwapRow, b: SwapRow) => b.swapKB - a.swapKB;

export function swapView(i: SwapInput): SwapView {
  const { full } = i;
  const rows: SwapRow[] = [];
  for (const g of listedGroups(full.groups)) {
    const procs = flattenGroup(g);
    const swapKB = sum(procs, (p) => p.swapKB);
    if (swapKB <= 0) continue;
    const instances = full.classification.get(g.id)?.instances ?? [];
    const isProject = g.kind === 'project' || g.kind === 'deleted';
    const killable = g.killable && !g.protected && g.kind !== 'claude';
    const children: SwapRow[] = [];
    if (isProject) {
      const byPid = new Map(procs.map((p) => [p.pid, p]));
      for (const inst of instances) {
        const own = inst.pids.flatMap((pid) => byPid.get(pid) ?? []);
        const kb = sum(own, (p) => p.swapKB);
        if (kb <= 0) continue;
        const state = sleepState(own, kb, byPid.get(inst.rootPid)?.ageSec ?? inst.ageSec, i);
        children.push({
          key: inst.key, groupId: g.id, label: inst.label, kind: g.kind, category: inst.category, project: inst.project,
          swapKB: kb, rssKB: sum(own, (p) => p.rssKB), instanceKey: inst.key, state,
          bulkEligible: state.kind === 'sleeping' && killable && !inst.protected && inst.launchedBy !== 'claude',
          protected: inst.protected, killable: false, children: [],
        });
      }
      children.sort(bySwap);
    }
    const single: InstanceSummary | null = !isProject && instances.length === 1 ? instances[0]! : null;
    rows.push({
      key: g.id, groupId: g.id, label: g.label, kind: g.kind, category: single?.category ?? null, project: isProject ? g.label : null,
      swapKB, rssKB: sum(procs, (p) => p.rssKB), instanceKey: single?.key ?? null,
      state: sleepState(procs, swapKB, Math.max(0, ...procs.map((p) => p.ageSec)), i),
      bulkEligible: false, protected: g.protected, killable: !isProject && killable, children,
    });
  }
  rows.sort(bySwap);
  return {
    swapUsedKB: full.system.swapTotalKB - full.system.swapFreeKB,
    swapTotalKB: full.system.swapTotalKB,
    shmemKB: full.system.shmemKB ?? null,
    historyFrom: i.historyFrom,
    rows,
    sleepingKeys: rows.flatMap((r) => r.children.filter((c) => c.bulkEligible).map((c) => c.key)),
  };
}

/** Processus dont la dernière activité doit être lue : ceux des groupes listés au-dessus du seuil de swap (leurs instances comprises). */
export function swapTargets(full: FullSnapshot, minSwapKB: number): { pid: number; startTicks: number }[] {
  const out: { pid: number; startTicks: number }[] = [];
  for (const g of listedGroups(full.groups)) {
    const procs = flattenGroup(g);
    if (sum(procs, (p) => p.swapKB) <= minSwapKB) continue;
    for (const p of procs) out.push({ pid: p.pid, startTicks: p.startTicks });
  }
  return out;
}
