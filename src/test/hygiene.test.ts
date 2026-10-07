import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';

test('les fichiers temporaires des tests vont dans la racine propre au lancement', () => {
  const root = process.env.PROC_WATCH_TEST_TMP;
  expect(root).toBeTruthy();
  expect(tmpdir()).toBe(root);
  const d = mkdtempSync(join(tmpdir(), 'pw-hyg-'));
  expect(relative(root!, d).startsWith('..')).toBe(false);
});

let opened: DatabaseSync | null = null;
test('une base ouverte pendant un test…', () => {
  opened = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'pw-hyg-')), 'x.db'));
  expect(opened.isOpen).toBe(true);
});
test('…est fermée après ce test', () => {
  expect(opened?.isOpen).toBe(false);
});
