// Partitions surveillées par la page Disque et l'alerte disk_low (pur) : systèmes de fichiers réels de /proc/self/mountinfo,
// une entrée par disque réel (sous-volumes btrfs et montages liés regroupés).
import { parseMountinfo } from '../mountinfo';

export interface Partition { mount: string; device: string; fstype: string }

/** Systèmes de fichiers sur disque ; tout le reste (tmpfs, overlay, squashfs, fuse.*, nfs, proc…) est ignoré. */
const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'btrfs', 'xfs', 'f2fs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'zfs', 'bcachefs', 'jfs', 'reiserfs', 'nilfs2']);
/** Petites partitions FAT (ESP…) : ignorées sous 1 Go quand la taille est connue. */
const SMALL_FAT_KB = 1024 * 1024;

const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
const ignoredMount = (m: string) => /^\/boot(\/|$|[^/]*$)/.test(m) || under(m, '/efi') || under(m, '/run/media') || under(m, '/media') || under(m, '/snap');

/**
 * Partitions réelles surveillées, triées par point de montage. Dédupliquées par périphérique (`maj:min`, ou même source
 * `/dev/…`) : le point de montage le plus court nomme la partition. `sizeKB` (facultatif) : taille d'un montage, pour
 * écarter les petites FAT.
 */
export function watchedPartitions(mountinfo: string, sizeKB?: (mount: string) => number | null): Partition[] {
  const byKey = new Map<string, Partition>();
  const keyOf = new Map<string, string>();
  for (const e of parseMountinfo(mountinfo)) {
    if (!REAL_FS.has(e.fstype) || !e.mount.startsWith('/') || ignoredMount(e.mount)) continue;
    if (e.fstype === 'vfat' && sizeKB) {
      const s = sizeKB(e.mount);
      if (s !== null && s < SMALL_FAT_KB) continue;
    }
    const src = e.source.startsWith('/dev/') ? `src:${e.source}` : null;
    const key = keyOf.get(`dev:${e.majmin}`) ?? (src ? keyOf.get(src) : undefined) ?? `dev:${e.majmin}`;
    keyOf.set(`dev:${e.majmin}`, key);
    if (src) keyOf.set(src, key);
    const prev = byKey.get(key);
    if (!prev || e.mount.length < prev.mount.length) byKey.set(key, { mount: e.mount, device: e.source, fstype: e.fstype });
  }
  return [...byKey.values()].sort((a, b) => (a.mount < b.mount ? -1 : a.mount > b.mount ? 1 : 0));
}

/**
 * Partition surveillée qui contient `path` : le montage le plus long qui le contient, rattaché par périphérique (`maj:min`
 * ou source `/dev/…`) à une partition de `parts`. Système virtuel (tmpfs…) ou inconnu : null.
 */
export function partitionOf(mountinfo: string, path: string, parts: readonly Partition[]): Partition | null {
  const entries = parseMountinfo(mountinfo);
  const inside = (m: string) => m === '/' || path === m || path.startsWith(`${m}/`);
  const host = entries.filter((e) => inside(e.mount)).sort((a, b) => b.mount.length - a.mount.length)[0];
  if (!host) return null;
  for (const p of parts) {
    const same = entries.some((e) => e.mount === p.mount && (e.majmin === host.majmin || (e.source.startsWith('/dev/') && e.source === host.source)));
    if (same) return p;
  }
  return null;
}
