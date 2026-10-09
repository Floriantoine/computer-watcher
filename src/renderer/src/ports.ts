import { APP_DISPLAY_NAME } from '../../core/appName';
import type { OpenPort, OpenPortsInfo } from '../../core/openPorts';
import type { GroupKind, InstanceSummary } from '../../core/types';

export const freePortLabel = (port: number): string => `Libérer :${port}`;

const NOT_FREEABLE = "« Libérer » n'est proposé que pour les instances non protégées d'un projet";

/**
 * Garde du clic sur « Libérer :port » (défense en profondeur : le bouton n'est rendu que sur les lignes `freeable`).
 * Seule une instance non protégée d'un groupe projet / dossier supprimé est visée, et seulement si elle tient toujours ce port
 * d'après la dernière liste (`current`, sinon les ports de l'instance). Le kill passe ensuite par le chemin habituel de l'instance.
 */
export function freePortCheck(
  row: OpenPort,
  current: OpenPortsInfo | null,
  instances: ReadonlyMap<string, InstanceSummary>,
  groupKind: (groupId: string) => GroupKind | undefined,
): { ok: true; inst: InstanceSummary } | { ok: false; message: string } {
  if (!row.freeable || row.instanceKey === null) return { ok: false, message: NOT_FREEABLE };
  const inst = instances.get(row.instanceKey);
  if (!inst) return { ok: false, message: `L'instance « ${row.label} » a disparu` };
  const kind = groupKind(inst.groupId);
  if (!instanceFreeable(kind, { ...inst, ports: [row.port] })) return { ok: false, message: NOT_FREEABLE };
  const holds = current ? current.ports.some((p) => p.port === row.port && p.instanceKey === inst.key) : inst.ports.includes(row.port);
  if (!holds) return { ok: false, message: `« ${row.label} » ne tient plus :${row.port}` };
  return { ok: true, inst };
}

/** Bouton « Libérer :port » d'une instance (détail) : instance non protégée, qui écoute, d'un groupe projet / dossier supprimé. */
export function instanceFreeable(groupKind: GroupKind | undefined, inst: InstanceSummary): boolean {
  return (groupKind === 'project' || groupKind === 'deleted') && !inst.protected && inst.ports.length > 0;
}

/** Lignes du port cherché (processus de l'utilisateur seulement). */
export const portRowsFor = (info: OpenPortsInfo, port: number): OpenPort[] => info.ports.filter((p) => p.port === port);

/** Note de la liste : ports d'autres utilisateurs, visibles dans /proc/net mais pas leurs processus. */
export function otherUsersNote(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 port d'un autre utilisateur non affiché" : `${n} ports d'autres utilisateurs non affichés`;
}

/** Note de la liste : ports à soi dont aucun processus lisible ne tient le socket. */
export function unreadableNote(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? '1 port sans processus lisible' : `${n} ports sans processus lisible`;
}

/** Note de la liste : processus à trop de fd pour être lus sans bloquer l'app. */
export function tooBigNote(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? '1 processus trop gros pour être lu' : `${n} processus trop gros pour être lus`;
}

/** Recherche `:port` sans ligne : port libre, tenu par un autre utilisateur, ou par un de ses processus illisible. */
export function portSearchEmpty(port: number, info: OpenPortsInfo): string {
  const uids = [...new Set(info.otherUsers.filter((o) => o.port === port).map((o) => o.uid))];
  if (uids.length > 0) {
    const who = uids.length === 1 ? `un autre utilisateur (uid ${uids[0]})` : `d'autres utilisateurs (uid ${uids.join(', ')})`;
    return `:${port} est écouté par ${who} : non arrêtable depuis ${APP_DISPLAY_NAME}`;
  }
  if (info.unreadable.includes(port)) return `:${port} est écouté par un de vos processus illisible (processus trop gros, conteneur, autre espace de noms…) : non arrêtable depuis ${APP_DISPLAY_NAME}`;
  return `Aucun processus n'écoute :${port}`;
}
