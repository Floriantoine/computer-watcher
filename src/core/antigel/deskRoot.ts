// Bureau prioritaire, mise à niveau root (pur, sans import Node : lu aussi par le renderer). Le noyau borne la protection
// « low » d'un cgroup par celle de ses ancêtres : sans memory.low sur user.slice, user-<uid>.slice et user@<uid>.service
// (unités système, root seulement), la MemoryLow posée par le service dans la session est sans effet. Trois drop-ins
// systemd identiques (même nom, même valeur) la posent à ces trois niveaux ; `systemctl daemon-reload` l'applique tout de
// suite aux unités en cours (vérifié sur systemd 261), et le retrait des fichiers la remet à 0.

const MiB = 1024 * 1024;
/** Borne basse : en dessous, aucune protection utile du bureau. */
export const DESK_ROOT_MIN_MB = 256;
/** Borne haute (contrôlée aussi par le script root) : 1 Tio. */
export const DESK_ROOT_MAX_MB = 1_048_576;
/** Jamais plus de la moitié de la RAM protégée au niveau système (le reste du système garde de quoi vivre). */
const MAX_RAM_SHARE = 0.5;

export const DESK_ROOT_ETC = '/etc/systemd/system';
export const DESK_ROOT_NAME = 'computer-watcher-desk.conf';
/** user-.slice.d s'applique à chaque user-<uid>.slice et user@.service.d à chaque user@<uid>.service (drop-ins de modèle). */
export const DESK_ROOT_DROPINS = [
  { dir: 'user.slice.d', section: 'Slice' },
  { dir: 'user-.slice.d', section: 'Slice' },
  { dir: 'user@.service.d', section: 'Service' },
] as const;
export type DeskRootSection = (typeof DESK_ROOT_DROPINS)[number]['section'];

/** En-tête des fichiers, écrit à l'identique par le script root (aucun guillemet, $, ` ni \ : il y est entre guillemets doubles). */
export const DESK_ROOT_HEADER = [
  '# Computer Watcher : protection mémoire du bureau prioritaire (Réglages › Plafond de travail).',
  '# Retrait : depuis l’app, ou supprimer ce fichier puis « systemctl daemon-reload ».',
] as const;
for (const l of DESK_ROOT_HEADER) if (/["$`\\]/.test(l)) throw new Error('en-tête deskRoot : caractère interdit');

export const isDeskRootMB = (mb: unknown): mb is number => Number.isInteger(mb) && (mb as number) >= DESK_ROOT_MIN_MB && (mb as number) <= DESK_ROOT_MAX_MB;

/** Valeur à poser (Mo) : réserve du bureau arrondie au Mo supérieur, au plus la moitié de la RAM ; null : inconnue. */
export function deskRootTargetMB(reserveBytes: number | null, memTotalBytes: number): number | null {
  if (reserveBytes === null || !Number.isFinite(reserveBytes) || reserveBytes <= 0 || !Number.isFinite(memTotalBytes) || memTotalBytes <= 0) return null;
  const cap = Math.floor((memTotalBytes * MAX_RAM_SHARE) / MiB);
  if (cap < DESK_ROOT_MIN_MB) return null;
  const mb = Math.min(Math.max(Math.ceil(reserveBytes / MiB), DESK_ROOT_MIN_MB), cap, DESK_ROOT_MAX_MB);
  return isDeskRootMB(mb) ? mb : null;
}

export function deskRootContent(section: DeskRootSection, mb: number): string {
  if (!isDeskRootMB(mb)) throw new Error(`protection système refusée : ${mb}`);
  return `${DESK_ROOT_HEADER.join('\n')}\n[${section}]\nMemoryLow=${mb}M\n`;
}

/** Valeur (Mo) d'un fichier écrit par l'app, à l'octet près ; null : absent, ou contenu qui n'est pas le nôtre. */
export function parseDeskRootFile(text: string | null, section: DeskRootSection): number | null {
  if (text === null) return null;
  const m = /\nMemoryLow=(\d{1,7})M\n$/.exec(text);
  if (!m) return null;
  const mb = Number(m[1]);
  return isDeskRootMB(mb) && text === deskRootContent(section, mb) ? mb : null;
}

export const deskRootPaths = (etc: string): string[] => DESK_ROOT_DROPINS.map((d) => `${etc}/${d.dir}/${DESK_ROOT_NAME}`);

/** Niveaux système au-dessus de la session (cgroups relatifs à /sys/fs/cgroup). */
export function deskRootLevels(uid: number): { unit: string; cgroup: string }[] {
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error(`uid refusé : ${uid}`);
  return [
    { unit: 'user.slice', cgroup: '/user.slice' },
    { unit: `user-${uid}.slice`, cgroup: `/user.slice/user-${uid}.slice` },
    { unit: `user@${uid}.service`, cgroup: `/user.slice/user-${uid}.slice/user@${uid}.service` },
  ];
}

export interface DeskRootStatus {
  /** absent : aucun fichier ; installed : les trois, à la valeur voulue ; obsolete : autre valeur, partiel ou modifié. */
  files: 'absent' | 'installed' | 'obsolete';
  /** Valeur commune des trois fichiers (Mo) ; null si absente ou différente d'un fichier à l'autre. */
  installedMB: number | null;
  /** Valeur voulue (Mo) d'après la réserve ; null : inconnue. */
  targetMB: number | null;
  /** memory.low lu à chaque niveau (octets ; null : illisible ; Infinity : max). */
  levels: { unit: string; low: number | null }[];
  /** Chaque niveau a une protection : la MemoryLow posée dans la session peut agir. */
  effective: boolean;
  /** Option de montage memory_recursiveprot (la protection descend aussi aux unités sans MemoryLow propre). */
  recursiveprot: boolean;
  paths: string[];
  /** Simulation (développement) : rien n'est écrit dans /etc. */
  fake?: boolean;
}

export function deskRootStatus(i: {
  files: readonly (string | null)[];
  lows: readonly (number | null)[];
  targetMB: number | null;
  uid: number;
  recursiveprot: boolean;
  etc?: string;
}): DeskRootStatus {
  const values = DESK_ROOT_DROPINS.map((d, k) => parseDeskRootFile(i.files[k] ?? null, d.section));
  const same = values.every((v) => v !== null && v === values[0]) ? values[0]! : null;
  const files = i.files.every((f) => f === null || f === undefined)
    ? 'absent'
    : same !== null && (i.targetMB === null || same === i.targetMB) ? 'installed' : 'obsolete';
  const levels = deskRootLevels(i.uid).map((l, k) => ({ unit: l.unit, low: i.lows[k] ?? null }));
  return {
    files, installedMB: same, targetMB: i.targetMB, levels, effective: levels.every((l) => l.low !== null && l.low > 0),
    recursiveprot: i.recursiveprot, paths: deskRootPaths(i.etc ?? DESK_ROOT_ETC),
  };
}

/** Résultat de l'action (installation, mise à jour, retrait), avec l'état relu après. */
export interface DeskRootResult {
  ok: boolean;
  reason?: 'cancelled' | 'invalid' | 'stale' | 'failed' | 'unavailable';
  message: string;
  status?: DeskRootStatus;
}
