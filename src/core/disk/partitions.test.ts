import { expect, test } from 'vitest';
import { watchedPartitions } from './partitions';

/** Ligne de /proc/self/mountinfo : id parent maj:min racine point options - type source superoptions. */
const line = (id: number, majmin: string, root: string, mount: string, fstype: string, source: string) =>
  `${id} 1 ${majmin} ${root} ${mount} rw,relatime shared:${id} - ${fstype} ${source} rw`;

test('ext4 / et ext4 /home sur deux périphériques : deux partitions', () => {
  const mi = [line(20, '259:2', '/', '/', 'ext4', '/dev/sda2'), line(21, '259:3', '/', '/home', 'ext4', '/dev/sda3')].join('\n');
  expect(watchedPartitions(mi)).toEqual([
    { mount: '/', device: '/dev/sda2', fstype: 'ext4' },
    { mount: '/home', device: '/dev/sda3', fstype: 'ext4' },
  ]);
});

test('btrfs à plusieurs sous-volumes du même périphérique : une seule partition, nommée par le montage le plus court', () => {
  const mi = [
    line(30, '0:28', '/@home', '/home', 'btrfs', '/dev/nvme0n1p2'),
    line(31, '0:28', '/@', '/', 'btrfs', '/dev/nvme0n1p2'),
    line(32, '0:28', '/@log', '/var/log', 'btrfs', '/dev/nvme0n1p2'),
    line(33, '0:28', '/@cache', '/var/cache', 'btrfs', '/dev/nvme0n1p2'),
    line(34, '0:28', '/@swap', '/swap', 'btrfs', '/dev/nvme0n1p2'),
  ].join('\n');
  expect(watchedPartitions(mi)).toEqual([{ mount: '/', device: '/dev/nvme0n1p2', fstype: 'btrfs' }]);
});

test('systèmes virtuels, AppImage, snap, docker, /boot et amovibles : ignorés', () => {
  const mi = [
    line(40, '259:2', '/', '/', 'ext4', '/dev/sda2'),
    line(41, '0:40', '/', '/tmp', 'tmpfs', 'tmpfs'),
    line(42, '0:41', '/', '/tmp/.mount_computer-watcherAbc', 'fuse.computer-watcher.AppImage', 'computer-watcher.AppImage'),
    line(43, '7:1', '/', '/snap/x/1', 'squashfs', '/dev/loop1'),
    line(44, '0:60', '/', '/var/lib/docker/rootfs/overlayfs/abc', 'overlay', 'overlay'),
    line(45, '259:1', '/', '/boot/efi', 'vfat', '/dev/sda1'),
    line(46, '259:5', '/', '/boot', 'ext4', '/dev/sda5'),
    line(47, '259:6', '/', '/efi', 'vfat', '/dev/sda6'),
    line(48, '8:17', '/', '/run/media/u/USB', 'ext4', '/dev/sdb1'),
    line(49, '8:33', '/', '/media/CLE', 'exfat', '/dev/sdc1'),
    line(50, '0:5', '/', '/dev', 'devtmpfs', 'dev'),
    line(51, '0:30', '/', '/home/u/distant', 'fuse.sshfs', 'u@h:/'),
    line(52, '0:31', '/', '/mnt/nfs', 'nfs4', 'h:/x'),
  ].join('\n');
  expect(watchedPartitions(mi)).toEqual([{ mount: '/', device: '/dev/sda2', fstype: 'ext4' }]);
});

test('point de montage avec espace échappé (\\040) : décodé', () => {
  const mi = [line(60, '259:2', '/', '/', 'ext4', '/dev/sda2'), line(61, '8:2', '/', '/mnt/Mes\\040données', 'xfs', '/dev/sdb2')].join('\n');
  expect(watchedPartitions(mi).map((p) => p.mount)).toEqual(['/', '/mnt/Mes données']);
});

test('vfat sous 1 Go (taille connue) : ignorée ; au-delà : surveillée', () => {
  const mi = [line(70, '259:2', '/', '/', 'ext4', '/dev/sda2'), line(71, '8:2', '/', '/mnt/petite', 'vfat', '/dev/sdb2'), line(72, '8:3', '/', '/mnt/grande', 'vfat', '/dev/sdb3')].join('\n');
  const size = (m: string) => (m === '/mnt/petite' ? 512 * 1024 : 64 * 1024 * 1024);
  expect(watchedPartitions(mi, size).map((p) => p.mount)).toEqual(['/', '/mnt/grande']);
});

test('lignes vides ou mal formées : ignorées sans planter', () => {
  expect(watchedPartitions('\n\nn importe quoi\n1 2 3\n')).toEqual([]);
});

test('partitionOf : partition surveillée qui contient un chemin (sous-volume btrfs compris)', async () => {
  const { partitionOf } = await import('./partitions');
  const mi = [
    line(30, '0:28', '/@', '/', 'btrfs', '/dev/nvme0n1p2'),
    line(31, '0:28', '/@home', '/home', 'btrfs', '/dev/nvme0n1p2'),
    line(32, '0:28', '/@cache', '/var/cache', 'btrfs', '/dev/nvme0n1p2'),
    line(33, '8:17', '/', '/data', 'ext4', '/dev/sdb1'),
    line(34, '0:40', '/', '/tmp', 'tmpfs', 'tmpfs'),
  ].join('\n');
  const parts = watchedPartitions(mi);
  expect(partitionOf(mi, '/home/u/.cache/uv', parts)?.mount).toBe('/');
  expect(partitionOf(mi, '/var/cache/pacman/pkg', parts)?.mount).toBe('/');
  expect(partitionOf(mi, '/data/x', parts)?.mount).toBe('/data');
  expect(partitionOf(mi, '/tmp/x', parts)).toBeNull();
});
