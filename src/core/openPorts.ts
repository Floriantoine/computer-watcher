import type { ListenSocket } from './collector/ports';
import type { FullSnapshot } from './snapshot';
import type { Category, Group, InstanceSummary, ProcNode } from './types';

/** Un port en écoute tenu par un processus de l'utilisateur (une ligne par port et par pid). */
export interface OpenPort {
  port: number;
  pid: number;
  startTicks: number;
  /** Groupe le plus précis du processus (sous-groupe de « Autres » compris) */
  groupId: string;
  groupLabel: string;
  /**
   * Instance désignée : celle qui contient le processus dans un groupe projet / dossier supprimé, ou dont il est la racine ailleurs ;
   * null sinon (« Libérer » ne vise alors que ce processus).
   */
  instanceKey: string | null;
  category: Category | null;
  project: string | null;
  /** Libellé de l'instance, sinon nom du processus (le groupe est dans `groupLabel`) */
  label: string;
  /** Ancienneté de l'instance, sinon du processus */
  ageSec: number;
  protected: boolean;
}

/** Port en écoute d'un autre utilisateur : visible dans /proc/net/tcp, mais ni son processus ni ses fd ne sont lisibles. */
export interface OtherUserPort {
  port: number;
  uid: number;
}

/** Triés par port (puis pid / uid). */
export interface OpenPortsInfo {
  ports: OpenPort[];
  otherUsers: OtherUserPort[];
}

/**
 * Liste des ports ouverts : `portsByPid` (ports lus dans les fd des processus de l'utilisateur) rattachés à leur groupe et à leur
 * instance ; `sockets` (tous utilisateurs) donne les ports des autres utilisateurs, signalés à part et jamais arrêtables.
 */
export function openPorts(full: FullSnapshot, portsByPid: ReadonlyMap<number, number[]>, sockets: readonly ListenSocket[], currentUid: number): OpenPortsInfo {
  const ports: OpenPort[] = [];
  const instOf = new Map<number, InstanceSummary>();
  for (const c of full.classification.values()) for (const i of c.instances) for (const pid of i.pids) instOf.set(pid, i);
  const visit = (g: Group) => {
    const walk = (nodes: ProcNode[]) => {
      for (const { proc: p, children } of nodes) {
        const list = p.uid === currentUid ? portsByPid.get(p.pid) : undefined;
        if (list?.length) {
          // Dans un projet (ou dossier supprimé), une instance est un outil de dev : tout processus de l'instance la désigne.
          // Ailleurs (session Claude, navigateur…), seul le processus racine désigne son instance : un serveur lancé depuis une
          // session Claude ne doit pas proposer de tuer la session.
          const found = instOf.get(p.pid);
          const inst = found && (g.kind === 'project' || g.kind === 'deleted' || found.rootPid === p.pid) ? found : undefined;
          for (const port of list) {
            ports.push({
              port, pid: p.pid, startTicks: p.startTicks, groupId: g.id, groupLabel: g.label,
              instanceKey: inst?.key ?? null, category: inst?.category ?? null, project: inst?.project ?? null,
              label: inst?.label ?? p.name, ageSec: inst?.ageSec ?? p.ageSec, protected: (inst?.protected ?? false) || g.protected,
            });
          }
        }
        walk(children);
      }
    };
    walk(g.roots);
    g.subgroups.forEach(visit);
  };
  full.groups.forEach(visit);
  ports.sort((a, b) => a.port - b.port || a.pid - b.pid);
  const seen = new Set<string>();
  const otherUsers: OtherUserPort[] = [];
  for (const s of sockets) {
    const k = `${s.port}:${s.uid}`;
    if (s.uid === currentUid || seen.has(k)) continue;
    seen.add(k);
    otherUsers.push({ port: s.port, uid: s.uid });
  }
  otherUsers.sort((a, b) => a.port - b.port || a.uid - b.uid);
  return { ports, otherUsers };
}

/** Recherche `:port` : groupes (les plus précis) qui écoutent ce port, et autres utilisateurs qui l'écoutent. */
export function portMatches(info: OpenPortsInfo, port: number): { groupIds: string[]; otherUsers: OtherUserPort[] } {
  const groupIds = [...new Set(info.ports.filter((p) => p.port === port).map((p) => p.groupId))];
  return { groupIds, otherUsers: info.otherUsers.filter((o) => o.port === port) };
}
