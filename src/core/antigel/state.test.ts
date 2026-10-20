import { describe, expect, test } from 'vitest';
import { MAX_STATE_BYTES, antigelView, parseAntigelState } from './state';
import { sampleState } from './testFixtures';

const proj = (unit: string, root: string | null = null) => ({ unit, root, procs: 1, currentKB: 1, budgetMB: null, throttled: false });

describe('antigel-state.json', () => {
  test('aller-retour', () => {
    expect(parseAntigelState(JSON.stringify(sampleState()))).toEqual(sampleState());
    expect(parseAntigelState(JSON.stringify(sampleState({ status: 'unavailable', reason: 'busctl introuvable (/usr/bin/busctl)', slice: null, projects: [], reserveKB: null })))?.reason).toMatch(/busctl/);
  });
  test('refus : version, statut, unité, racine relative, nombres, taille, JSON cassé', () => {
    const bad = [
      { ...sampleState(), version: 2 }, { ...sampleState(), status: 'gelé' },
      sampleState({ projects: [proj('../x.slice')] }),
      sampleState({ projects: [proj('cwatch-p-a.slice', 'relatif')] }),
      sampleState({ scopes: { 'app.slice': null } }), { ...sampleState(), at: Number.NaN }, { ...sampleState(), tickMs: -1 },
      sampleState({ reason: 'x'.repeat(400) }),
    ];
    for (const b of bad) expect(parseAntigelState(JSON.stringify(b)), JSON.stringify(b).slice(0, 80)).toBeNull();
    expect(parseAntigelState('{')).toBeNull();
    expect(parseAntigelState(' '.repeat(MAX_STATE_BYTES + 1))).toBeNull();
  });
  test('l\'unité d\'un projet doit être une slice de projet (ni scope, ni slice racine, ni niveau imbriqué)', () => {
    for (const unit of ['cwatch-p-alpha-1.scope', 'cwatch.slice', 'cwatch-p-alpha-xyz.slice', 'cwatch-p-.slice', 42]) {
      const s = sampleState({ projects: [proj('cwatch-p-alpha.slice'), { ...proj('x'), unit: unit as string }] });
      expect(parseAntigelState(JSON.stringify(s)), String(unit)).toBeNull();
    }
    const ok = sampleState({ projects: [proj('cwatch-p-alpha.slice'), proj('cwatch-p-beta_0a1b2c.slice')] });
    expect(parseAntigelState(JSON.stringify(ok))?.projects).toHaveLength(2);
  });
  test('l\'attribution scopes : clés = slices de projet seulement', () => {
    expect(parseAntigelState(JSON.stringify(sampleState({ scopes: { 'cwatch-p-alpha-1.scope': null } })))).toBeNull();
    expect(parseAntigelState(JSON.stringify(sampleState({ scopes: { 'cwatch-p-alpha.slice': 'relatif' } })))).toBeNull();
  });
  test('fraîcheur : moins de 3 intervalles (+ 5 s), jamais dans le futur lointain', () => {
    const text = JSON.stringify(sampleState({ at: 1_000_000 }));
    expect(antigelView(text, 1_000_000 + 20_000, 5)).toMatchObject({ fresh: true });
    expect(antigelView(text, 1_000_000 + 20_001, 5)).toMatchObject({ fresh: false });
    expect(antigelView(text, 1_000_000 - 60_000, 5)).toMatchObject({ fresh: false });
    expect(antigelView(null, 0, 5)).toEqual({ state: null, fresh: false });
    expect(antigelView('{', 0, 5)).toEqual({ state: null, fresh: false });
  });
});
