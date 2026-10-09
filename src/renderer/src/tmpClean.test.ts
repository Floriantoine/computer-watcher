import { expect, test } from 'vitest';
import { tmpCleanMessage, tmpSelection } from './tmpClean';

test('message du toast : libérés, refusés et raisons regroupées', () => {
  expect(tmpCleanMessage({ freedKB: 2 * 1024 * 1024, results: [{ name: 'a', ok: true }, { name: 'b', ok: true }] })).toEqual({
    kind: 'info',
    message: '2 éléments supprimés, 2,0 Go libérés',
  });
  const m = tmpCleanMessage({
    freedKB: 512,
    results: [
      { name: 'a', ok: true },
      { name: 'b', ok: false, reason: 'utilisé par jest (pid 12)' },
      { name: 'c', ok: false, reason: 'a changé depuis l’affichage' },
    ],
  });
  expect(m.kind).toBe('error');
  expect(m.message).toBe('1 élément supprimé, 512 Ko libérés, 2 refusés : b (utilisé par jest (pid 12)), c (a changé depuis l’affichage)');
});

test('sélection : seuls les éléments supprimables comptent, libellé « Supprimer la sélection (n · taille) »', () => {
  const e = (name: string, sizeKB: number, refusal: string | null = null) => ({ name, ino: '1', dev: '1', kind: 'dir' as const, sizeKB, cache: false, recent: false, refusal });
  const entries = [e('a', 1024), e('b', 2048), e('c', 4096, 'système')];
  const s = tmpSelection(entries, new Set(['a', 'b', 'c', 'disparu']));
  expect(s.items).toEqual([{ name: 'a', ino: '1', dev: '1' }, { name: 'b', ino: '1', dev: '1' }]);
  expect(s.sizeKB).toBe(3072);
  expect(s.label).toBe('Supprimer la sélection (2 · 3 Mo)');
  expect(tmpSelection(entries, new Set()).label).toBe('Supprimer la sélection');
});

test('toast : annulé à la confirmation du main, ou échec partiel signalé', () => {
  expect(tmpCleanMessage({ freedKB: 0, cancelled: true, results: [{ name: 'a', ok: false, reason: 'annulé' }] })).toEqual({ kind: 'info', message: 'Suppression annulée : rien n’a été touché' });
  const m = tmpCleanMessage({ freedKB: 0, partial: true, results: [{ name: 'a', ok: false, reason: 'échec : x ; le reste est dans /tmp/.proc-watch-trash-1' }] });
  expect(m.kind).toBe('error');
  expect(m.message).toMatch(/^Suppression partielle — 0 élément supprimé/);
});
