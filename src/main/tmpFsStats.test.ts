import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { tmpFsStats } from './tmpFsStats';

// statfs d'un tmpfs de 4 Go (blocs de 4 Kio) dont 1 Go est occupé.
const TMPFS_MAGIC = 0x01021994;
const fakeStatfs = async () => ({ type: TMPFS_MAGIC, bsize: 4096, blocks: 1_048_576, bfree: 786_432, bavail: 786_432 });

test('taille et occupation de la racine (statfs), RAM totale : en Ko', async () => {
  const s = await tmpFsStats('/tmp', { statfs: fakeStatfs, memTotalKB: () => 16 * 1024 * 1024 });
  expect(s).toEqual({ root: '/tmp', sizeKB: 4 * 1024 * 1024, usedKB: 1024 * 1024, memTotalKB: 16 * 1024 * 1024, inRam: true });
});

test('racine sur disque (ext4) : pas en RAM', async () => {
  const s = await tmpFsStats('/tmp', { statfs: async () => ({ ...(await fakeStatfs()), type: 0xef53 }), memTotalKB: () => 1 });
  expect(s.inRam).toBe(false);
});

test('racine illisible : erreur lisible (code système), jamais de valeurs inventées', async () => {
  const statfs = async () => {
    throw Object.assign(new Error('EACCES: permission denied, statfs'), { code: 'EACCES' });
  };
  await expect(tmpFsStats('/tmp', { statfs })).rejects.toThrow('accès refusé (EACCES)');
  const missing = async () => {
    throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  };
  await expect(tmpFsStats('/tmp', { statfs: missing })).rejects.toThrow('introuvable (ENOENT)');
});

test('vrai statfs sur une racine de test : taille non nulle, occupé ≤ taille', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pw-statfs-'));
  const s = await tmpFsStats(root);
  expect(s.root).toBe(root);
  expect(s.sizeKB).toBeGreaterThan(0);
  expect(s.usedKB).toBeGreaterThanOrEqual(0);
  expect(s.usedKB).toBeLessThanOrEqual(s.sizeKB);
  expect(s.memTotalKB).toBeGreaterThan(0);
});
