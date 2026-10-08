// Explorateur du swap (④) : lignes par groupe / instance triées par swap cumulé, état actif / endormi / inconnu. Pur.
import { flattenGroup, type FullSnapshot } from './snapshot';
import type { Category, Group, GroupKind, InstanceSummary, ProcInfo } from './types';

import type { HistoryCoverage } from './history/queries';

/** « Endormi » : aucun CPU ≥ seuil depuis 1 jour. */
export const SWAP_IDLE_MS = 86_400_000;
/** Fenêtre lue dans l'historique, quelle que soit la rétention : au-delà, « endormi depuis plus de 7 j » (lecture à froid bornée). */
export const SWAP_LOOKBACK_MS = 7 * 86_400_000;

/**
 * Pourquoi l'état est inconnu : pas d'historique (base absente ou vide), service d'enregistrement arrêté (dernier échantillon
 * plus vieux que 2 intervalles), trou de plus de 10 min dans le dernier jour, ou historique plus court qu'un jour.
 */
export type UnknownReason = 'none' | 'stopped' | 'gap' | 'short';
export type SleepState = { kind: 'active' } | { kind: 'sleeping'; sinceTs: number | null } | { kind: 'unknown'; reason: UnknownReason };

/**
 * Services de la session de bureau : jamais d'« Arrêter » depuis la vue swap, même classés en appli (liste locale, à unifier
 * avec la liste « jamais tuer » des règles). Motifs sur le nom du processus, `*` = préfixe.
 */
const SESSION_SERVICES = [
  'xdg-desktop-portal*', 'kwalletd*', 'pipewire*', 'wireplumber', 'kded*', 'plasmashell', 'kwin*', 'Xwayland', 'dbus*', 'systemd*', 'gvfs*', 'at-spi*',
];
export function isSessionService(name: string): boolean {
  return SESSION_SERVICES.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
}

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
  /** Bouton « Arrêter » individuel possible : groupe `app` tuable, non protégé, sans service de session (jamais Claude ni `command`). */
  killable: boolean;
  /** Instance lancée par une session Claude encore ouverte : jamais proposée. */
  launchedBy?: 'claude';
  children: SwapRow[];
}

export interface SwapView {
  swapUsedKB: number;
  swapTotalKB: number;
  shmemKB: number | null;
  /** Début de la couverture continue de l'historique, au plus 7 j (« endormi depuis plus de … ») ; null sans historique. */
  coveredFrom: number | null;
  /** Seuil d'activité CPU appliqué (%) : max(1, procMinCpuPercent). */
  activeCpu: number;
  rows: SwapRow[];
  /** Clés des instances `bulkEligible`, dans l'ordre des lignes. */
  sleepingKeys: string[];
}

export interface SwapInput {
  full: FullSnapshot;
  /** Dernière activité CPU ≥ `activeCpu` par `pid:startTicks` ; null sans base d'historique. */
  lastActive: ReadonlyMap<string, number | null> | null;
  /** Couverture de l'historique sur la fenêtre lue ; null sans base. */
  coverage: HistoryCoverage | null;
  now: number;
  minSwapKB: number;
  idleMs: number;
  /** Intervalle d'enregistrement : au-delà de 2 intervalles sans échantillon, le service est jugé arrêté. */
  intervalMs: number;
  /** Seuil d'activité CPU (%), max(1, procMinCpuPercent) : en dessous, un processus peut ne pas être enregistré du tout. */
  activeCpu: number;
}

const sum = (procs: readonly ProcInfo[], f: (p: ProcInfo) => number) => procs.reduce((s, p) => s + f(p), 0);

/** Groupes listés : ceux de premier niveau, et les sous-groupes de « Autres » à la place de « Autres ». */
function listedGroups(groups: readonly Group[]): Group[] {
  return groups.flatMap((g) => (g.kind === 'others' ? g.subgroups : [g]));
}

/** Historique utilisable pour affirmer « aucune activité depuis `idleMs` » ? Sinon la raison de l'état inconnu. */
function historyProblem(i: SwapInput): UnknownReason | null {
  const c = i.coverage;
  if (i.lastActive === null || !c || c.latestTs === null || c.coveredFrom === null) return 'none';
  if (i.now - c.latestTs > 2 * i.intervalMs) return 'stopped';
  if (c.coveredFrom > i.now - i.idleMs) return c.gap ? 'gap' : 'short';
  return null;
}

/**
 * État d'un ensemble de processus : CPU en direct (somme) ≥ seuil → actif ; swap cumulé ≤ seuil → actif (non concerné) ;
 * lancé depuis moins de `idleMs` → actif ; historique absent, service arrêté, trou ou historique trop court → inconnu ;
 * dernière activité (par processus) avant `now − idleMs`, ou aucune → endormi (`sinceTs` null si avant la couverture continue) ;
 * sinon actif. La somme en direct et le maximum par processus penchent tous deux vers « actif ».
 */
function sleepState(procs: readonly ProcInfo[], swapKB: number, ageSec: number, i: SwapInput): SleepState {
  if (sum(procs, (p) => p.cpuPercent) >= i.activeCpu) return { kind: 'active' };
  if (swapKB <= i.minSwapKB) return { kind: 'active' };
  if (ageSec * 1000 < i.idleMs) return { kind: 'active' };
  const problem = historyProblem(i);
  if (problem) return { kind: 'unknown', reason: problem };
  let latest: number | null = null;
  for (const p of procs) {
    const ts = i.lastActive!.get(`${p.pid}:${p.startTicks}`) ?? null;
    if (ts !== null && (latest === null || ts > latest)) latest = ts;
  }
  if (latest !== null && latest >= i.now - i.idleMs) return { kind: 'active' };
  return { kind: 'sleeping', sinceTs: latest !== null && latest >= i.coverage!.coveredFrom! ? latest : null };
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
    /** Groupe tuable (kill groupé des instances de projet, ou « Arrêter » d'une appli). */
    const groupKillable = g.killable && !g.protected && g.kind !== 'claude';
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
          bulkEligible: state.kind === 'sleeping' && groupKillable && !inst.protected && inst.launchedBy !== 'claude',
          protected: inst.protected, killable: false, children: [],
          ...(inst.launchedBy === 'claude' ? { launchedBy: 'claude' as const } : {}),
        });
      }
      children.sort(bySwap);
    }
    const single: InstanceSummary | null = !isProject && instances.length === 1 ? instances[0]! : null;
    rows.push({
      key: g.id, groupId: g.id, label: g.label, kind: g.kind, category: single?.category ?? null, project: isProject ? g.label : null,
      swapKB, rssKB: sum(procs, (p) => p.rssKB), instanceKey: single?.key ?? null,
      state: sleepState(procs, swapKB, Math.max(0, ...procs.map((p) => p.ageSec)), i),
      bulkEligible: false, protected: g.protected, killable: g.kind === 'app' && groupKillable && !procs.some((p) => isSessionService(p.name)), children,
    });
  }
  rows.sort(bySwap);
  return {
    swapUsedKB: full.system.swapTotalKB - full.system.swapFreeKB,
    swapTotalKB: full.system.swapTotalKB,
    shmemKB: full.system.shmemKB ?? null,
    coveredFrom: i.coverage?.coveredFrom ?? null,
    activeCpu: i.activeCpu,
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
