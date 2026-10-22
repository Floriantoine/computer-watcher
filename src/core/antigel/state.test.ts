import { describe, expect, test } from 'vitest';
import { MAX_STATE_BYTES, antigelView, parseAntigelState } from './state';
import { sampleState } from './testFixtures';

const proj = (unit: string, root: string | null = null) => ({ unit, root, procs: 1, currentKB: 1, budgetMB: null, throttled: false });

describe('antigel-state.json', () => {
  test('aller-retour', () => {
    expect(parseAntigelState(JSON.stringify(sampleState()))).toEqual(sampleState());
    expect(parseAntigelState(JSON.stringify(sampleState({ status: 'unavailable', reason: 'busctl introuvable (/usr/bin/busctl)', slice: null, projects: [], reserveKB: null })))?.reason).toMatch(/busctl/);
  });
  test('mémoire hors budget (capturée tard) : aller-retour, absente tolérée, refusée si invalide', () => {
    const late = { ...proj('cwatch-p-alpha.slice', '/home/u/alpha'), outsideKB: 4_500_000 };
    expect(parseAntigelState(JSON.stringify(sampleState({ projects: [late] })))?.projects).toEqual([late]);
    expect(parseAntigelState(JSON.stringify(sampleState()))?.projects[0]).not.toHaveProperty('outsideKB');
    for (const bad of [-1, '4 Go', null]) expect(parseAntigelState(JSON.stringify(sampleState({ projects: [{ ...late, outsideKB: bad as never }] })))).toBeNull();
  });
  test('freinage récent (plafond global, budget, part de la dernière minute) : aller-retour, absent toléré, refusé si invalide', () => {
    const slice = { ...sampleState().slice!, throttled: true, stallPct: 35 };
    const p = { ...proj('cwatch-p-alpha.slice', '/home/u/alpha'), budgetThrottled: true, stallPct: 80 };
    const ok = parseAntigelState(JSON.stringify(sampleState({ slice, projects: [p] })));
    expect(ok?.slice).toEqual(slice);
    expect(ok?.projects).toEqual([p]);
    expect(parseAntigelState(JSON.stringify(sampleState()))?.slice).not.toHaveProperty('stallPct');
    for (const bad of [{ slice: { ...slice, stallPct: 101 } }, { slice: { ...slice, stallPct: -1 } }, { slice: { ...slice, throttled: 'oui' } },
      { projects: [{ ...p, stallPct: '3' }] }, { projects: [{ ...p, budgetThrottled: 1 }] }]) {
      expect(parseAntigelState(JSON.stringify(sampleState(bad as never))), JSON.stringify(bad)).toBeNull();
    }
  });
  test('plafond dur en place sur la slice d’un projet (maxKB) : aller-retour, absent toléré, refusé si invalide', () => {
    const p = { ...proj('cwatch-p-alpha.slice', '/home/u/alpha'), budgetMB: 5120, maxKB: 6400 * 1024 };
    expect(parseAntigelState(JSON.stringify(sampleState({ projects: [p] })))?.projects).toEqual([p]);
    expect(parseAntigelState(JSON.stringify(sampleState()))?.projects[0]).not.toHaveProperty('maxKB');
    for (const bad of [-1, '6 Go', null, Number.MAX_SAFE_INTEGER * 2]) {
      expect(parseAntigelState(JSON.stringify(sampleState({ projects: [{ ...p, maxKB: bad as never }] }))), String(bad)).toBeNull();
    }
  });
  test('budget par défaut (budgetDefault) : aller-retour, absent toléré, refusé si invalide', () => {
    const p = { ...proj('cwatch-p-alpha.slice', '/home/u/alpha'), budgetMB: 5120, budgetDefault: true };
    expect(parseAntigelState(JSON.stringify(sampleState({ projects: [p] })))?.projects).toEqual([p]);
    expect(parseAntigelState(JSON.stringify(sampleState()))?.projects[0]).not.toHaveProperty('budgetDefault');
    expect(parseAntigelState(JSON.stringify(sampleState({ projects: [{ ...p, budgetDefault: 'oui' as never }] })))).toBeNull();
  });
  test('bureau prioritaire : aller-retour, absent toléré, refusé si invalide (unité, statut, champ manquant)', () => {
    const desk = { status: 'active', reason: null, cpu: true, io: false, memory: 'ineffective', units: ['session.slice', 'app.slice', 'cwatch.slice'], truncated: false, restoring: 0 } as const;
    expect(parseAntigelState(JSON.stringify(sampleState({ desk: { ...desk, units: [...desk.units] } })))?.desk).toEqual(desk);
    expect(parseAntigelState(JSON.stringify(sampleState()))).not.toHaveProperty('desk');
    for (const bad of [{ ...desk, units: ['cwatch-p-a.slice'] }, { ...desk, units: ['../x.slice'] }, { ...desk, status: 'gelé' }, { ...desk, memory: 'oui' }, { ...desk, restoring: -1 }, { ...desk, cpu: undefined }]) {
      expect(parseAntigelState(JSON.stringify(sampleState({ desk: bad as never }))), JSON.stringify(bad)).toBeNull();
    }
  });
  test('attribution slice de projet → racine : champ « slices » (l’ancien nom « scopes » est refusé)', () => {
    const t = JSON.parse(JSON.stringify(sampleState()));
    expect(t.slices).toEqual({ 'cwatch-p-alpha.slice': '/home/u/alpha', 'cwatch-p-autres.slice': null });
    expect(t).not.toHaveProperty('scopes');
    expect(parseAntigelState(JSON.stringify(t))?.slices).toEqual(t.slices);
    const { slices, ...rest } = t;
    expect(parseAntigelState(JSON.stringify({ ...rest, scopes: slices }))).toBeNull();
  });
  test('refus : version, statut, unité, racine relative, nombres, taille, JSON cassé', () => {
    const bad = [
      { ...sampleState(), version: 2 }, { ...sampleState(), status: 'gelé' },
      sampleState({ projects: [proj('../x.slice')] }),
      sampleState({ projects: [proj('cwatch-p-a.slice', 'relatif')] }),
      sampleState({ slices: { 'app.slice': null } }), { ...sampleState(), at: Number.NaN }, { ...sampleState(), tickMs: -1 },
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
  test('l\'attribution slices : clés = slices de projet seulement', () => {
    expect(parseAntigelState(JSON.stringify(sampleState({ slices: { 'cwatch-p-alpha-1.scope': null } })))).toBeNull();
    expect(parseAntigelState(JSON.stringify(sampleState({ slices: { 'cwatch-p-alpha.slice': 'relatif' } })))).toBeNull();
  });
  test('noms de test cwatch-e2e jamais acceptés dans l\'état de production', () => {
    for (const unit of ['cwatch-e2eabc.slice', 'cwatch-e2eabc-x.slice', 'cwatch-e2eabc-x.scope']) {
      expect(parseAntigelState(JSON.stringify(sampleState({ projects: [proj(unit)] }))), unit).toBeNull();
      expect(parseAntigelState(JSON.stringify(sampleState({ slices: { [unit]: null } }))), unit).toBeNull();
    }
  });
  test('racines : forme normalisée, sans caractère de contrôle', () => {
    for (const r of ['/a/../b', '/a//b', '/a/./b', '/a/', '/a\nb', '/a\tb', '/a\u0001']) {
      expect(parseAntigelState(JSON.stringify(sampleState({ projects: [proj('cwatch-p-a.slice', r)] }))), JSON.stringify(r)).toBeNull();
    }
    expect(parseAntigelState(JSON.stringify(sampleState({ projects: [proj('cwatch-p-a.slice', '/home/u/a b')] })))).not.toBeNull();
  });
  test('nombres : entiers pour les compteurs, plafond plausible', () => {
    const p = (o: object) => JSON.stringify(sampleState({ projects: [{ ...proj('cwatch-p-a.slice'), ...o }] }));
    expect(parseAntigelState(p({ procs: 1.5 }))).toBeNull();
    expect(parseAntigelState(p({ currentKB: 2 ** 53 }))).toBeNull();
    const sl = sampleState().slice!;
    expect(parseAntigelState(JSON.stringify(sampleState({ slice: { ...sl, throttles: 0.5 } })))).toBeNull();
    expect(parseAntigelState(JSON.stringify(sampleState({ slice: { ...sl, oomKills: 1.2 } })))).toBeNull();
    expect(parseAntigelState(JSON.stringify(sampleState({ tickMs: 2 ** 60 })))).toBeNull();
  });
  test('__proto__, propriétés en plus, bornes de tailles', () => {
    const base = JSON.parse(JSON.stringify(sampleState()));
    expect(parseAntigelState(JSON.stringify(base).replace('"slices":{', '"slices":{"__proto__":null,'))).toBeNull();
    const withExtra = JSON.parse(JSON.stringify(base));
    withExtra.projects[0].extra = 'x';
    withExtra.slice.extra = 'y';
    const out = parseAntigelState(JSON.stringify(withExtra))!;
    expect(out).toEqual(sampleState());
    expect(Object.keys(out.projects[0]!)).not.toContain('extra');
    expect(Object.keys(out.slice!)).not.toContain('extra');
    const protoProj = JSON.stringify(base).replace('"unit":', '"__proto__":{"x":1},"unit":');
    expect(Object.prototype.hasOwnProperty.call(parseAntigelState(protoProj)!.projects[0], '__proto__')).toBe(false);
    const many = (n: number) => Array.from({ length: n }, (_, i) => proj(`cwatch-p-p${i}.slice`));
    expect(parseAntigelState(JSON.stringify(sampleState({ projects: many(200) })))).not.toBeNull();
    expect(parseAntigelState(JSON.stringify(sampleState({ projects: many(201) })))).toBeNull();
    expect(parseAntigelState(JSON.stringify(sampleState({ reason: 'x'.repeat(300), lastError: 'y'.repeat(300) })))).not.toBeNull();
    expect(parseAntigelState(JSON.stringify(sampleState({ lastError: 'y'.repeat(301) })))).toBeNull();
    // octets et non unités UTF-16 : 100 000 « é » = 200 000 o ; 140 000 = 280 000 o > 256 Kio
    const pad = (n: number) => JSON.stringify({ ...base, pad: 'é'.repeat(n) });
    expect(pad(100_000).length).toBeLessThan(MAX_STATE_BYTES);
    expect(parseAntigelState(pad(100_000))).not.toBeNull();
    expect(pad(140_000).length).toBeLessThan(MAX_STATE_BYTES);
    expect(parseAntigelState(pad(140_000))).toBeNull();
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
