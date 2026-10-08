import type { OpenPort, OpenPortsInfo } from '../../core/openPorts';
import type { InstanceSummary, KillTarget, ProcInfo } from '../../core/types';
import type { KillRequest } from './viewModel';

export const freePortLabel = (port: number): string => `Libérer :${port}`;

export type FreePortAction = { kind: 'instance'; inst: InstanceSummary } | { kind: 'proc'; pid: number; startTicks: number; groupId: string };

/** Bouton d'une ligne : instance connue → kill de l'instance ; sinon kill du seul processus. Les ports d'autres utilisateurs n'ont pas de ligne. */
export function freePortAction(row: OpenPort, instances: ReadonlyMap<string, InstanceSummary>): FreePortAction {
  const inst = row.instanceKey === null ? undefined : instances.get(row.instanceKey);
  return inst ? { kind: 'instance', inst } : { kind: 'proc', pid: row.pid, startTicks: row.startTicks, groupId: row.groupId };
}

/**
 * Kill d'un processus sans instance qui écoute `port` : seulement s'il est toujours le même (pid et startTicks) et à l'utilisateur ;
 * confirmation toujours demandée (processus moins bien identifié qu'une instance). null → rien à viser.
 */
export function freePortRequest(port: number, target: KillTarget, procs: readonly ProcInfo[], isProtected: (n: string) => boolean, currentUid: number): KillRequest | null {
  const p = procs.find((x) => x.pid === target.pid);
  if (!p || p.startTicks !== target.startTicks || p.uid !== currentUid) return null;
  return {
    targets: [{ pid: p.pid, startTicks: p.startTicks }],
    title: `${freePortLabel(port)} : tuer « ${p.name} » (PID ${p.pid}) ?`,
    needsConfirm: true,
    protectedProcs: isProtected(p.name) ? [p] : [],
  };
}

/** Lignes du port cherché (processus de l'utilisateur seulement). */
export const portRowsFor = (info: OpenPortsInfo, port: number): OpenPort[] => info.ports.filter((p) => p.port === port);

/** Note de la liste : ports d'autres utilisateurs, visibles dans /proc/net mais pas leurs processus. */
export function otherUsersNote(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 port d'un autre utilisateur non affiché" : `${n} ports d'autres utilisateurs non affichés`;
}

/** Recherche `:port` sans ligne : port libre, ou tenu par un autre utilisateur (non arrêtable). */
export function portSearchEmpty(port: number, info: OpenPortsInfo): string {
  const uids = [...new Set(info.otherUsers.filter((o) => o.port === port).map((o) => o.uid))];
  if (uids.length === 0) return `Aucun processus n'écoute :${port}`;
  const who = uids.length === 1 ? `un autre utilisateur (uid ${uids[0]})` : `d'autres utilisateurs (uid ${uids.join(', ')})`;
  return `:${port} est écouté par ${who} : non arrêtable depuis proc-watch`;
}
