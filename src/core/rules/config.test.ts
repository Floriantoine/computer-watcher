import { describe, expect, test } from 'vitest';
import { checkRulesTransition, MAX_RULES, OPT_IN_APPS, RULE_TEMPLATES, validateRules, validateRulesDetailed } from './config';
import type { Rule, RulesConfig } from './types';

const vitest: Rule = {
  id: 'r-a', name: 'vitest > 4 Go', enabled: true, mode: 'simulate', createdAt: 1,
  condition: { kind: 'memory', target: 'instance', match: { by: 'name', value: 'vitest' }, overMB: 4096, forMin: 5 },
};
const withCond = (c: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ ...vitest, ...over, condition: { ...vitest.condition, ...c } });
const one = (r: unknown) => validateRulesDetailed({ enabled: true, list: [r] });

describe('validateRules', () => {
  test('section absente → éteint, liste vide', () => {
    expect(validateRules(undefined)).toEqual({ enabled: false, list: [] });
    expect(validateRulesDetailed(undefined).issues).toEqual([]);
  });

  test('les 3 modèles sont valides, désactivés et en Simulation', () => {
    expect(RULE_TEMPLATES).toHaveLength(3);
    const list = RULE_TEMPLATES.map((t, i) => ({ ...t, id: `t-${i}`, createdAt: 0 }));
    const r = validateRulesDetailed({ enabled: false, list });
    expect(r.issues).toEqual([]);
    expect(r.rules.list).toEqual(list);
    for (const t of RULE_TEMPLATES) expect(t).toMatchObject({ enabled: false, mode: 'simulate' });
  });

  test.each([
    ['overMB: 50', withCond({ overMB: 50 }), /seuil/],
    ['overMB non entier', withCond({ overMB: 4096.5 }), /seuil/],
    ['forMin: 0', withCond({ forMin: 0 }), /durée/],
    ['forMin: 121', withCond({ forMin: 121 }), /durée/],
    ['underMin: 31', { ...vitest, condition: { kind: 'forecast', underMin: 31, includeApps: [] } }, /délai/],
    ['forHours: 0', { ...vitest, condition: { kind: 'inactive', categories: ['back'], forHours: 0 } }, /durée/],
    ['catégorie inconnue', { ...vitest, condition: { kind: 'inactive', categories: ['frontend'], forHours: 24 } }, /catégorie/],
    ['catégories vides', { ...vitest, condition: { kind: 'inactive', categories: [], forHours: 24 } }, /catégorie/],
    ['catégorie de correspondance inconnue', withCond({ match: { by: 'category', value: 'gpu' } }), /catégorie/],
    ['match.by regex', withCond({ match: { by: 'regex', value: 'vit.*' } }), /correspondance/],
    ['value avec \\n', withCond({ match: { by: 'name', value: 'vitest\nrm' } }), /nom à comparer/],
    ['value avec ;', withCond({ match: { by: 'name', value: 'a;rm -rf' } }), /nom à comparer/],
    ['value avec *', withCond({ match: { by: 'name', value: 'vit*' } }), /nom à comparer/],
    ['value vide', withCond({ match: { by: 'name', value: '' } }), /nom à comparer/],
    ['value trop longue', withCond({ match: { by: 'name', value: 'a'.repeat(101) } }), /nom à comparer/],
    ['id A B', { ...vitest, id: 'A B' }, /identifiant/],
    ['mode inconnu', { ...vitest, mode: 'kill' }, /mode/],
    ['nom vide', { ...vitest, name: ' ' }, /nom invalide/],
    ['nom avec contrôle', { ...vitest, name: 'a\u0007b' }, /nom invalide/],
    ['type inconnu', { ...vitest, condition: { kind: 'shell', cmd: 'rm' } }, /type de condition/],
    ['appli non autorisée (warp)', { ...vitest, condition: { kind: 'forecast', underMin: 3, includeApps: ['warp'] } }, /applis/],
    ['appli non autorisée (claude-desktop)', { ...vitest, condition: { kind: 'forecast', underMin: 3, includeApps: ['claude-desktop'] } }, /applis/],
    ['appli non autorisée (electron)', { ...vitest, condition: { kind: 'forecast', underMin: 3, includeApps: ['electron'] } }, /applis/],
    ['createdAt négatif', { ...vitest, createdAt: -1 }, /création/],
  ])('refusée : %s (seule cette règle, avec son erreur)', (_label, bad, msg) => {
    const ok = { ...vitest, id: 'r-ok' };
    const r = validateRulesDetailed({ enabled: true, list: [bad, ok] });
    expect(r.rules.list).toEqual([ok]);
    expect(r.rules.enabled).toBe(true);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ index: 0 });
    expect(r.issues[0]!.error).toMatch(msg);
  });

  test("valeur '^(.*)$' acceptée comme texte (jamais une regex)", () => {
    // jeu de caractères sûr : ^ $ * ne sont pas admis, donc une valeur « regex » est refusée…
    expect(one(withCond({ match: { by: 'name', value: '^(.*)$' } })).issues).toHaveLength(1);
    // …et une valeur admise reste du texte, comparée telle quelle par le moteur
    expect(one(withCond({ match: { by: 'name', value: 'vit.(est)' } })).rules.list[0]!.condition).toMatchObject({ match: { by: 'name', value: 'vit.(est)' } });
  });

  test(`${MAX_RULES + 1} règles → les ${MAX_RULES} premières gardées, la suivante refusée`, () => {
    const list = Array.from({ length: MAX_RULES + 1 }, (_, i) => ({ ...vitest, id: `r-${i}` }));
    const r = validateRulesDetailed({ enabled: true, list });
    expect(r.rules.list).toHaveLength(MAX_RULES);
    expect(r.issues).toEqual([{ index: MAX_RULES, id: `r-${MAX_RULES}`, name: vitest.name, error: `au plus ${MAX_RULES} règles` }]);
  });

  test('ids dupliqués → la seconde refusée', () => {
    const r = validateRulesDetailed({ enabled: true, list: [vitest, { ...vitest, name: 'copie' }] });
    expect(r.rules.list).toEqual([vitest]);
    expect(r.issues[0]).toMatchObject({ index: 1, error: 'identifiant en double' });
  });

  test("champ inconnu (action: 'rm') ignoré, non recopié", () => {
    const r = one({ ...vitest, action: 'rm', condition: { ...vitest.condition, exec: 'rm -rf /' } });
    expect(r.issues).toEqual([]);
    expect(r.rules.list[0]).toEqual(vitest);
    expect(JSON.stringify(r.rules)).not.toMatch(/rm/);
  });

  test('section mal formée → règles éteintes avec une erreur, jamais une exception', () => {
    for (const raw of ['oui', null, [], { enabled: 'yes', list: [] }, { enabled: true, list: {} }]) {
      const r = validateRulesDetailed(raw);
      expect(r.rules).toEqual({ enabled: false, list: [] });
      expect(r.issues).toHaveLength(1);
    }
  });

  test('applis à inclure : seulement des applis connues hors liste « jamais tuer »', () => {
    expect(OPT_IN_APPS).toContain('firefox');
    expect(OPT_IN_APPS).not.toContain('warp');
    expect(OPT_IN_APPS).not.toContain('claude-desktop');
    const r = one({ ...vitest, condition: { kind: 'forecast', underMin: 3, includeApps: ['firefox', 'chrome', 'firefox'] } });
    expect(r.rules.list[0]!.condition).toEqual({ kind: 'forecast', underMin: 3, includeApps: ['chrome', 'firefox'] });
  });
});

describe('checkRulesTransition', () => {
  const prev: RulesConfig = { enabled: true, list: [vitest] };
  test('nouvelle règle active → « Une nouvelle règle démarre en Simulation »', () => {
    expect(checkRulesTransition(prev, { enabled: true, list: [vitest, { ...vitest, id: 'r-b', mode: 'active' }] })).toMatch(/^Une nouvelle règle démarre en Simulation/);
  });
  test('règle existante passée de simulate à active → null', () => {
    const simulated = { enabled: true, list: [{ ...vitest, simulatedSince: 0 }] };
    expect(checkRulesTransition(simulated, { enabled: true, list: [{ ...vitest, mode: 'active' }] }, 10 * 60_000)).toBeNull();
    expect(checkRulesTransition(simulated, { enabled: true, list: [{ ...vitest, mode: 'active' }] }, 9 * 60_000)).toMatch(/Au moins 10 min/);
  });
  test('règle nouvelle en simulation → null', () => {
    expect(checkRulesTransition(prev, { enabled: true, list: [vitest, { ...vitest, id: 'r-b' }] })).toBeNull();
  });
  test('règle active dont la condition change sans repasser en Simulation → refus', () => {
    const active = { ...vitest, mode: 'active' as const };
    const changed = { ...active, condition: { ...vitest.condition, overMB: 200 } } as Rule;
    expect(checkRulesTransition({ enabled: true, list: [active] }, { enabled: true, list: [changed] })).toMatch(/repasse en Simulation/);
    expect(checkRulesTransition({ enabled: true, list: [active] }, { enabled: true, list: [{ ...changed, mode: 'simulate' }] })).toBeNull();
  });
  test('ids dupliqués → refus', () => {
    expect(checkRulesTransition(prev, { enabled: true, list: [vitest, vitest] })).toMatch(/double/);
  });
});

describe('revue de sécurité', () => {
  test('simulatedSince : optionnel, entier ≥ 0, gardé', () => {
    expect(one({ ...vitest, simulatedSince: 5 }).rules.list[0]!.simulatedSince).toBe(5);
    expect(one({ ...vitest, simulatedSince: -1 }).issues[0]!.error).toMatch(/simulation/);
    expect(one({ ...vitest, simulatedSince: 'hier' }).issues).toHaveLength(1);
  });
  test('M-4 : 100 000 règles invalides → au plus 20 erreurs + une ligne « … et n autres »', () => {
    const list = Array.from({ length: 100_000 }, (_, i) => ({ ...vitest, id: `r-${i}`, mode: 'kill' }));
    const r = validateRulesDetailed({ enabled: true, list });
    expect(r.issues).toHaveLength(21);
    expect(r.issues[20]).toEqual({ index: -1, id: null, name: null, error: '… et 99980 autres règles refusées' });
  });
});
