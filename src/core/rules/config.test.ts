import { describe, expect, test } from 'vitest';
import { checkRulesTransition, MAX_RULES, OPT_IN_APPS, RULE_TEMPLATES, validateRules, validateRulesDetailed } from './config';
import { RECOMMENDED_RULES } from './recommended';
import type { Rule, RulesConfig } from './types';

const vitest: Rule = {
  id: 'r-a', name: 'vitest > 4 Go', enabled: true, mode: 'simulate', createdAt: 1,
  condition: { kind: 'memory', target: 'instance', match: { by: 'name', value: 'vitest' }, overMB: 4096, forMin: 5 },
};
const withCond = (c: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ ...vitest, ...over, condition: { ...vitest.condition, ...c } });
const sys = { kind: 'system', memPercent: 95, memForSec: 15, cpuPercent: 95, cpuForSec: 60 };
const one = (r: unknown) => validateRulesDetailed({ enabled: true, list: [r], recommendedSeeded: true });

describe('validateRules', () => {
  test('section absente (config d’avant les règles) → recommandées ajoutées, interrupteur allumé', () => {
    expect(validateRules(undefined).list.map((r) => r.id)).toEqual(RECOMMENDED_RULES.map((r) => r.id));
    expect(validateRules(undefined).enabled).toBe(true);
    expect(RECOMMENDED_RULES).toHaveLength(3);
    expect(validateRulesDetailed(undefined).issues).toEqual([]);
  });

  test('les 4 modèles sont valides, désactivés et en Simulation', () => {
    expect(RULE_TEMPLATES).toHaveLength(4);
    const list = RULE_TEMPLATES.map((t, i) => ({ ...t, id: `t-${i}`, createdAt: 0 }));
    const r = validateRulesDetailed({ enabled: false, list, recommendedSeeded: true });
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
    ['système memPercent: 69', { ...vitest, condition: { ...sys, memPercent: 69 } }, /seuil mémoire/],
    ['système memPercent: 100', { ...vitest, condition: { ...sys, memPercent: 100 } }, /seuil mémoire/],
    ['système memPercent non entier', { ...vitest, condition: { ...sys, memPercent: 95.5 } }, /seuil mémoire/],
    ['système memPercent texte', { ...vitest, condition: { ...sys, memPercent: '95' } }, /seuil mémoire/],
    ['système memForSec: 4', { ...vitest, condition: { ...sys, memForSec: 4 } }, /durée mémoire/],
    ['système memForSec: 601', { ...vitest, condition: { ...sys, memForSec: 601 } }, /durée mémoire/],
    ['système cpuPercent: 101', { ...vitest, condition: { ...sys, cpuPercent: 101 } }, /seuil CPU/],
    ['système cpuPercent: NaN', { ...vitest, condition: { ...sys, cpuPercent: Number.NaN } }, /seuil CPU/],
    ['système cpuForSec: 9', { ...vitest, condition: { ...sys, cpuForSec: 9 } }, /durée CPU/],
    ['système cpuForSec: Infinity', { ...vitest, condition: { ...sys, cpuForSec: Number.POSITIVE_INFINITY } }, /durée CPU/],
    ['système champ absent', { ...vitest, condition: { kind: 'system', memPercent: 95, memForSec: 15, cpuPercent: 95 } }, /durée CPU/],
    ['pression psiPercent: 9', { ...vitest, condition: { ...sys, psiPercent: 9, psiForSec: 20 } }, /seuil de pression/],
    ['pression psiPercent: 91', { ...vitest, condition: { ...sys, psiPercent: 91, psiForSec: 20 } }, /seuil de pression/],
    ['pression psiPercent non entier', { ...vitest, condition: { ...sys, psiPercent: 40.5, psiForSec: 20 } }, /seuil de pression/],
    ['pression psiPercent texte', { ...vitest, condition: { ...sys, psiPercent: '40', psiForSec: 20 } }, /seuil de pression/],
    ['pression psiPercent null', { ...vitest, condition: { ...sys, psiPercent: null, psiForSec: 20 } }, /seuil de pression/],
    ['pression psiForSec: 4', { ...vitest, condition: { ...sys, psiPercent: 40, psiForSec: 4 } }, /durée de pression/],
    ['pression psiForSec: 301', { ...vitest, condition: { ...sys, psiPercent: 40, psiForSec: 301 } }, /durée de pression/],
    ['pression : seuil sans durée', { ...vitest, condition: { ...sys, psiPercent: 40 } }, /durée de pression/],
    ['pression : durée sans seuil', { ...vitest, condition: { ...sys, psiForSec: 20 } }, /seuil de pression/],
  ])('refusée : %s (seule cette règle, avec son erreur)', (_label, bad, msg) => {
    const ok = { ...vitest, id: 'r-ok' };
    const r = validateRulesDetailed({ enabled: true, list: [bad, ok], recommendedSeeded: true });
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
    const r = validateRulesDetailed({ enabled: true, list, recommendedSeeded: true });
    expect(r.rules.list).toHaveLength(MAX_RULES);
    expect(r.issues).toEqual([{ index: MAX_RULES, id: `r-${MAX_RULES}`, name: vitest.name, error: `au plus ${MAX_RULES} règles` }]);
  });

  test('ids dupliqués → la seconde refusée', () => {
    const r = validateRulesDetailed({ enabled: true, list: [vitest, { ...vitest, name: 'copie' }], recommendedSeeded: true });
    expect(r.rules.list).toEqual([vitest]);
    expect(r.issues[0]).toMatchObject({ index: 1, error: 'identifiant en double' });
  });

  test('condition système valide : reconstruite champ par champ (champ inconnu non recopié), bornes incluses', () => {
    const r = one({ ...vitest, condition: { ...sys, pids: [1], memPercent: 70, cpuPercent: 100, memForSec: 600, cpuForSec: 10 } });
    expect(r.issues).toEqual([]);
    expect(r.rules.list[0]!.condition).toEqual({ kind: 'system', memPercent: 70, memForSec: 600, cpuPercent: 100, cpuForSec: 10 });
  });

  test('condition système avec pression : reconstruite dans l’ordre (comparaisons JSON), bornes incluses', () => {
    for (const [psiPercent, psiForSec] of [[10, 5], [90, 300], [40, 20]]) {
      const r = one({ ...vitest, condition: { psiForSec, x: 1, psiPercent, ...sys } });
      expect(r.issues).toEqual([]);
      const c = r.rules.list[0]!.condition;
      expect(c).toEqual({ ...sys, psiPercent, psiForSec });
      expect(Object.keys(c)).toEqual(['kind', 'memPercent', 'memForSec', 'cpuPercent', 'cpuForSec', 'psiPercent', 'psiForSec']);
    }
  });

  test('condition système d’avant la pression (sans ses champs) : toujours valide, aucune pression ajoutée', () => {
    const r = one({ ...vitest, condition: sys });
    expect(r.issues).toEqual([]);
    expect(Object.keys(r.rules.list[0]!.condition)).toEqual(['kind', 'memPercent', 'memForSec', 'cpuPercent', 'cpuForSec']);
    expect(JSON.stringify(r.rules.list[0]!.condition)).toBe(JSON.stringify(sys));
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
      expect(r.rules).toEqual({ enabled: false, list: [], recommendedActive: true, recommendedInactive4h: true, recommendedSeeded: true });
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
    // crédit de Simulation enregistré par le service : ≥ 10 min et ≥ 1 évaluation, même condition
    const credit = (ms: number, evaluations = 3) => ({ 'r-a': { condition: JSON.stringify(vitest.condition), simulatedMs: ms, evaluations } });
    const next = { enabled: true, list: [{ ...vitest, mode: 'active' as const }] };
    expect(checkRulesTransition(prev, next, credit(10 * 60_000))).toBeNull();
    expect(checkRulesTransition(prev, next, credit(9 * 60_000))).toMatch(/Au moins 10 min.*encore 1 min/);
    expect(checkRulesTransition(prev, next, credit(60 * 60_000, 0))).toMatch(/aucune évaluation/);
    expect(checkRulesTransition(prev, next, null)).toMatch(/Au moins 10 min/);
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
  test('m-3 : un simulatedSince écrit à la main n’est pas recopié (aucun crédit)', () => {
    expect(one({ ...vitest, simulatedSince: 0 }).rules.list[0]).toEqual(vitest);
  });
  test('M-4 : 100 000 règles invalides → au plus 20 erreurs + une ligne « … et n autres »', () => {
    const list = Array.from({ length: 100_000 }, (_, i) => ({ ...vitest, id: `r-${i}`, mode: 'kill' }));
    const r = validateRulesDetailed({ enabled: true, list, recommendedSeeded: true });
    expect(r.issues).toHaveLength(21);
    expect(r.issues[20]).toEqual({ index: -1, id: null, name: null, error: '… et 99980 autres règles refusées' });
  });
});
