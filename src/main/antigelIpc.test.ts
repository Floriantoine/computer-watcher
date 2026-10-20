import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { sampleState } from '../core/antigel/testFixtures';
import { readAntigelView } from './antigelIpc';

test('lecture bornée de antigel-state.json : absent, valide, trop gros, invalide', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-antigel-ipc-'));
  expect(readAntigelView(dir, 0, 5)).toEqual({ state: null, fresh: false });
  writeFileSync(join(dir, 'antigel-state.json'), JSON.stringify(sampleState({ at: 1000 })));
  expect(readAntigelView(dir, 2000, 5)).toMatchObject({ fresh: true, state: { status: 'active' } });
  writeFileSync(join(dir, 'antigel-state.json'), 'x'.repeat(300 * 1024));
  expect(readAntigelView(dir, 2000, 5)).toEqual({ state: null, fresh: false });
  writeFileSync(join(dir, 'antigel-state.json'), '{"version":1}');
  expect(readAntigelView(dir, 2000, 5)).toEqual({ state: null, fresh: false });
});

test('état périmé : conservé mais non frais (service arrêté)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-antigel-ipc-'));
  writeFileSync(join(dir, 'antigel-state.json'), JSON.stringify(sampleState({ at: 1000 })));
  // limite : 3 intervalles de 5 s + 5 s = 20 s
  expect(readAntigelView(dir, 1000 + 20_000, 5).fresh).toBe(true);
  const old = readAntigelView(dir, 1000 + 20_001, 5);
  expect(old.fresh).toBe(false);
  expect(old.state).toMatchObject({ status: 'active' });
  // horloge reculée : état « du futur » non frais
  expect(readAntigelView(dir, 1000 - 5001, 5).fresh).toBe(false);
});

test('ne lit pas au-delà de la borne : fichier géant (8 Mio) refusé', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-antigel-ipc-'));
  writeFileSync(join(dir, 'antigel-state.json'), Buffer.alloc(8 * 1024 * 1024, 0x20));
  expect(readAntigelView(dir, 0, 5)).toEqual({ state: null, fresh: false });
});

test('un FIFO à la place du fichier ne bloque pas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-antigel-ipc-'));
  execFileSync('mkfifo', [join(dir, 'antigel-state.json')]);
  expect(readAntigelView(dir, 0, 5)).toEqual({ state: null, fresh: false });
}, 2000);

test('un lien symbolique vers un état valide est refusé', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-antigel-ipc-'));
  writeFileSync(join(dir, 'vrai.json'), JSON.stringify(sampleState({ at: 1000 })));
  symlinkSync(join(dir, 'vrai.json'), join(dir, 'antigel-state.json'));
  expect(readAntigelView(dir, 2000, 5)).toEqual({ state: null, fresh: false });
});
