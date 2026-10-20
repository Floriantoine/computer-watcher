import { describe, expect, test } from 'vitest';
import { MAX_FRIDGE_REQUESTS, MAX_FROZEN, fridgeRoot, mergeFridgeRequests, parseFridgeFields, parseFridgeRequests } from './fridgeState';
import { parseAntigelState } from './state';
import { sampleState } from './testFixtures';

const E = { unit: 'cwatch-p-alpha.slice', root: '/home/u/alpha', since: 1000, phase: 'frozen', reclaimedKB: 2048 };

describe('racine de projet', () => {
  test('chemin absolu normalisé seulement', () => {
    expect(fridgeRoot('/home/u/alpha')).toBe('/home/u/alpha');
    for (const r of ['/', 'home/u', '/home/u/alpha/', '/home/u/../alpha', '/home/u/./a', '/a\nb', '/a\x00b', 42, null, `/${'a'.repeat(1100)}`]) {
      expect(fridgeRoot(r), String(r)).toBeNull();
    }
  });
});

describe('champs fridge / fridgeNotice de l’état', () => {
  test('absents : état du lot 1 toujours valide, sans champ ajouté', () => {
    const s = parseAntigelState(JSON.stringify(sampleState()));
    expect(s).not.toBeNull();
    expect('fridge' in s!).toBe(false);
  });

  test('valides : reconstruits champ par champ', () => {
    const t = JSON.stringify(sampleState({
      fridge: [{ ...E, extra: 1 } as never], fridgeNotice: { root: '/home/u/alpha', text: 'Au frigo', ok: true, at: 5, __proto__x: 1 } as never,
    }));
    const s = parseAntigelState(t)!;
    expect(s.fridge).toEqual([E]);
    expect(s.fridgeNotice).toEqual({ root: '/home/u/alpha', text: 'Au frigo', ok: true, at: 5 });
    expect(parseAntigelState(JSON.stringify(sampleState({ fridgeNotice: null })))!.fridgeNotice).toBeNull();
  });

  test('invalides : l’état entier est refusé', () => {
    const bad: unknown[] = [
      { fridge: {} }, { fridge: [{ ...E, unit: 'cwatch.slice' }] }, { fridge: [{ ...E, unit: 'cwatch-p-autres.slice' }] },
      { fridge: [{ ...E, unit: 'cwatch-e2eab-a.slice' }] }, { fridge: [{ ...E, phase: 'gelé' }] }, { fridge: [{ ...E, root: null }] },
      { fridge: [{ ...E, reclaimedKB: -1 }] }, { fridge: Array.from({ length: MAX_FROZEN + 1 }, () => E) },
      { fridgeNotice: { root: '/a', text: 'x'.repeat(301), ok: true, at: 1 } }, { fridgeNotice: 'x' }, { fridgeNotice: { root: '/a', text: 'x', ok: 1, at: 1 } },
    ];
    for (const b of bad) expect(parseAntigelState(JSON.stringify({ ...sampleState(), ...(b as object) })), JSON.stringify(b).slice(0, 80)).toBeNull();
    expect(parseFridgeFields({ fridge: [E] })).toEqual({ fridge: [E] });
  });
});

describe('demandes', () => {
  test('lecture stricte : entrées invalides écartées, au plus 16', () => {
    const ok = { root: '/home/u/alpha', action: 'freeze', at: 10 };
    expect(parseFridgeRequests(JSON.stringify({ version: 1, requests: [ok, { ...ok, action: 'kill' }, { ...ok, root: '/' }, { ...ok, at: -1 }, 'x'] }))).toEqual([ok]);
    for (const t of [null, '', 'x', '[]', '{"version":2,"requests":[]}', JSON.stringify({ version: 1, requests: {} }), 'x'.repeat(70_000)]) {
      expect(parseFridgeRequests(t)).toEqual([]);
    }
    const many = Array.from({ length: 40 }, (_, i) => ({ root: `/p/${i}`, action: 'thaw', at: i }));
    expect(parseFridgeRequests(JSON.stringify({ version: 1, requests: many }))).toHaveLength(MAX_FRIDGE_REQUESTS);
  });

  test('fusion : une par racine, la dernière gagne', () => {
    let l = mergeFridgeRequests([], { root: '/a', action: 'freeze', at: 1 });
    l = mergeFridgeRequests(l, { root: '/b', action: 'freeze', at: 2 });
    l = mergeFridgeRequests(l, { root: '/a', action: 'thaw', at: 3 });
    expect(l).toEqual([{ root: '/b', action: 'freeze', at: 2 }, { root: '/a', action: 'thaw', at: 3 }]);
    for (let i = 0; i < 30; i++) l = mergeFridgeRequests(l, { root: `/p${i}`, action: 'thaw', at: i });
    expect(l).toHaveLength(MAX_FRIDGE_REQUESTS);
    expect(l.at(-1)!.root).toBe('/p29');
  });
});
