import { mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { ownerDead, parseRootName, selfOwner } from './tmpRoot';

test('les fichiers temporaires des tests vont dans la racine propre au lancement, sur disque sous ~/.cache/pw-vitest', () => {
  const root = process.env.PROC_WATCH_TEST_TMP;
  expect(root).toBeTruthy();
  expect(tmpdir()).toBe(root);
  expect(dirname(root!)).toBe(realpathSync(join(homedir(), '.cache', 'pw-vitest')));
  expect(root!.startsWith('/tmp/')).toBe(false); // /tmp est en RAM
  const d = mkdtempSync(join(tmpdir(), 'pw-hyg-'));
  expect(relative(root!, d).startsWith('..')).toBe(false);
});

test('le propriétaire inscrit dans le nom de la racine (processus principal de Vitest) est vivant : jamais purgée pendant le lancement', () => {
  const owner = parseRootName(basename(process.env.PROC_WATCH_TEST_TMP!));
  expect(owner).not.toBeNull();
  expect([process.pid, process.ppid]).toContain(owner!.pid); // workers : fils du processus principal (ou lui-même)
  expect(ownerDead(owner!, { ns: selfOwner().ns })).toBe(false);
});

let opened: DatabaseSync | null = null;
test('une base ouverte pendant un test…', () => {
  opened = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'pw-hyg-')), 'x.db'));
  expect(opened.isOpen).toBe(true);
});
test('…est fermée après ce test', () => {
  expect(opened?.isOpen).toBe(false);
});
