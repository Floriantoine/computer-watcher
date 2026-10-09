import { describe, expect, test } from 'vitest';
import { DEFAULT_TMP_SORT, quarantineMessage, sortTmpEntries, tmpCleanMessage, tmpSelection, tmpTiles } from './tmpClean';

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

test('toast « Vider la quarantaine »', () => {
  expect(quarantineMessage({ freedKB: 0, results: [{ name: 'q', ok: true }] })).toEqual({ kind: 'info', message: 'Quarantaine vidée' });
  expect(quarantineMessage({ freedKB: 0, cancelled: true, results: [] })).toEqual({ kind: 'info', message: 'Suppression annulée : rien n’a été touché' });
  expect(quarantineMessage({ freedKB: 0, partial: true, results: [{ name: 'q', ok: false, reason: 'x : échec' }] })).toEqual({ kind: 'error', message: 'Quarantaine vidée en partie : q (x : échec)' });
});

describe('page /tmp : tri de la liste', () => {
  const e = (name: string, sizeKB: number) => ({ name, ino: name, dev: '1', kind: 'dir' as const, sizeKB, cache: false, recent: false, refusal: null });
  const entries = [e('feature-x', 10), e('Acme', 300), e('build-cache', 300), e('zeta', 50)];

  test('par taille décroissante (défaut), à taille égale par nom', () => {
    expect(sortTmpEntries(entries, 'size').map((x) => x.name)).toEqual(['Acme', 'build-cache', 'zeta', 'feature-x']);
  });
  test('par nom, sans tenir compte de la casse ; la liste reçue n’est pas modifiée', () => {
    const before = entries.map((x) => x.name);
    expect(sortTmpEntries(entries, 'name').map((x) => x.name)).toEqual(['Acme', 'build-cache', 'feature-x', 'zeta']);
    expect(entries.map((x) => x.name)).toEqual(before);
  });
  test('tri par défaut : taille', () => {
    expect(DEFAULT_TMP_SORT).toBe('size');
  });
});

describe('page /tmp : tuiles', () => {
  const GB = 1024 * 1024;
  const listing = (quarantines: { name: string; eligible: boolean }[] = [], disabled: string | null = null) => ({
    root: '/tmp', entries: [], truncated: false, uninspectable: [], disabled, quarantines,
  });

  test('occupé / taille, part de la RAM, quarantaine vide', () => {
    const t = tmpTiles({ stats: { root: '/tmp', sizeKB: 8 * GB, usedKB: 2 * GB, memTotalKB: 16 * GB, inRam: true }, statsError: null, listing: listing(), listingError: null });
    expect(t.used).toEqual({ value: '2,0 Go / 8,0 Go', sub: '25 % occupé' });
    expect(t.ram).toEqual({ value: '12,5 %', sub: 'de 16,0 Go de RAM' });
    expect(t.quarantine).toEqual({ value: '0', sub: 'rien n’est mis à l’écart', canEmpty: false });
  });

  test('quarantaine : nombre d’éléments, bouton seulement si vidable et suppression disponible', () => {
    const q = [{ name: '.proc-watch-trash-1', eligible: true }, { name: '.proc-watch-trash-2', eligible: false }];
    const base = { stats: null, statsError: null, listingError: null };
    expect(tmpTiles({ ...base, listing: listing(q) }).quarantine).toEqual({ value: '2', sub: 'éléments mis à l’écart', canEmpty: true });
    expect(tmpTiles({ ...base, listing: listing(q.slice(0, 1)) }).quarantine).toEqual({ value: '1', sub: 'élément mis à l’écart', canEmpty: true });
    expect(tmpTiles({ ...base, listing: listing(q.slice(1)) }).quarantine.canEmpty).toBe(false);
    expect(tmpTiles({ ...base, listing: listing(q, 'GNU rm introuvable') }).quarantine.canEmpty).toBe(false);
  });

  test('en cours de calcul : « … », sans valeur inventée', () => {
    const t = tmpTiles({ stats: null, statsError: null, listing: null, listingError: null });
    expect(t.used.value).toBe('…');
    expect(t.ram.value).toBe('…');
    expect(t.quarantine).toEqual({ value: '…', canEmpty: false });
  });

  test('/tmp illisible : l’erreur s’affiche dans les tuiles, « — » à la place des valeurs', () => {
    const t = tmpTiles({ stats: null, statsError: 'accès refusé (EACCES)', listing: null, listingError: 'lecture impossible' });
    expect(t.used).toEqual({ value: '—', sub: 'Lecture impossible : accès refusé (EACCES)', error: true });
    expect(t.ram).toEqual({ value: '—', sub: 'Lecture impossible : accès refusé (EACCES)', error: true });
    expect(t.quarantine).toEqual({ value: '—', sub: 'Lecture impossible : lecture impossible', error: true, canEmpty: false });
  });

  test('racine qui n’est pas un tmpfs (disque) : pas de part de la RAM', () => {
    const t = tmpTiles({ stats: { root: '/tmp', sizeKB: 400 * GB, usedKB: 300 * GB, memTotalKB: 16 * GB, inRam: false }, statsError: null, listing: null, listingError: null });
    expect(t.ram).toEqual({ value: '—', sub: 'pas en RAM : système de fichiers sur disque' });
  });

  test('RAM totale inconnue : part « — »', () => {
    const t = tmpTiles({ stats: { root: '/tmp', sizeKB: 4 * GB, usedKB: GB, memTotalKB: 0, inRam: true }, statsError: null, listing: null, listingError: null });
    expect(t.ram.value).toBe('—');
  });
});
