import { describe, expect, test } from 'vitest';
import { BUDGET_MAX_MB, BUDGET_MIN_MB, DEFAULT_BUDGET_MB, MAX_BUDGETS, RESERVE_MAX_MB, budgetKey, effectiveBudget, validateAntigel } from './config';

describe('validateAntigel', () => {
  test('absente : allumé, réserve automatique, aucun budget (nouvel objet à chaque fois)', () => {
    const a = validateAntigel(undefined);
    expect(a).toEqual({ enabled: true, reserveMB: null, budgets: {}, defaultBudgetMB: DEFAULT_BUDGET_MB });
    expect(validateAntigel(undefined)!.budgets).not.toBe(a!.budgets);
  });
  test('valeurs gardées, racines normalisées', () => {
    expect(validateAntigel({ enabled: false, reserveMB: 6144, budgets: { '/home/u/alpha/': 4096, '/home/u/b/../beta': 256 } }))
      .toEqual({ enabled: false, reserveMB: 6144, budgets: { '/home/u/alpha': 4096, '/home/u/beta': 256 }, defaultBudgetMB: DEFAULT_BUDGET_MB });
    expect(validateAntigel({ enabled: true })).toEqual({ enabled: true, reserveMB: null, budgets: {}, defaultBudgetMB: DEFAULT_BUDGET_MB });
  });
  test('refus : types, bornes, racines relatives, « / », __proto__, trop de budgets', () => {
    for (const bad of [
      null, [], 'oui', { enabled: 'oui' }, { enabled: true, reserveMB: 1023 }, { enabled: true, reserveMB: RESERVE_MAX_MB + 1 },
      { enabled: true, reserveMB: 4096.5 }, { enabled: true, budgets: [] }, { enabled: true, budgets: { 'relatif': 4096 } },
      { enabled: true, budgets: { '/': 4096 } }, { enabled: true, budgets: { '/a': BUDGET_MIN_MB - 1 } }, { enabled: true, budgets: { '/a': '4096' } },
      JSON.parse('{"enabled":true,"budgets":{"__proto__":4096}}'),
      { enabled: true, budgets: Object.fromEntries(Array.from({ length: MAX_BUDGETS + 1 }, (_, i) => [`/p${i}`, 4096])) },
    ]) expect(validateAntigel(bad), JSON.stringify(bad)).toBeNull();
  });
  test('bureau prioritaire : absent = allumé (champ omis), booléen gardé, autre type refusé', () => {
    expect(validateAntigel({ enabled: true })).not.toHaveProperty('desk');
    expect(validateAntigel({ enabled: true, desk: false })).toEqual({ enabled: true, reserveMB: null, budgets: {}, defaultBudgetMB: DEFAULT_BUDGET_MB, desk: false });
    expect(validateAntigel({ enabled: true, desk: true })?.desk).toBe(true);
    expect(validateAntigel({ enabled: true, desk: 'non' })).toBeNull();
  });
  test('budget par défaut : 5 Go si absent (nouvelle installation comme config existante), choix écrit respecté, null compris', () => {
    expect(DEFAULT_BUDGET_MB).toBe(5120);
    expect(validateAntigel({ enabled: true })?.defaultBudgetMB).toBe(5120);
    expect(validateAntigel({ enabled: true, defaultBudgetMB: null })?.defaultBudgetMB).toBeNull();
    expect(validateAntigel({ enabled: true, defaultBudgetMB: 8192 })?.defaultBudgetMB).toBe(8192);
    expect(validateAntigel({ enabled: true, defaultBudgetMB: BUDGET_MIN_MB })?.defaultBudgetMB).toBe(BUDGET_MIN_MB);
    expect(validateAntigel({ enabled: true, defaultBudgetMB: BUDGET_MAX_MB })?.defaultBudgetMB).toBe(BUDGET_MAX_MB);
    for (const bad of [BUDGET_MIN_MB - 1, BUDGET_MAX_MB + 1, 4096.5, '5120', true, 0]) {
      expect(validateAntigel({ enabled: true, defaultBudgetMB: bad }), String(bad)).toBeNull();
    }
  });
  test('projets explicitement sans budget : racines normalisées, sans doublon ; refus des mauvaises racines', () => {
    expect(validateAntigel({ enabled: true, noBudget: ['/home/u/demo/', '/home/u/demo', '/home/u/x/../projet-a'] })?.noBudget)
      .toEqual(['/home/u/demo', '/home/u/projet-a']);
    expect(validateAntigel({ enabled: true })).not.toHaveProperty('noBudget');
    for (const bad of [{}, 'x', ['relatif'], ['/'], [4], Array.from({ length: MAX_BUDGETS + 1 }, (_, i) => `/p${i}`)]) {
      expect(validateAntigel({ enabled: true, noBudget: bad }), JSON.stringify(bad)).toBeNull();
    }
  });
  test('effectiveBudget : explicite > sans budget > défaut ; hors projet : aucun', () => {
    const c = { enabled: true, reserveMB: null, budgets: { '/home/u/demo': 2048 }, defaultBudgetMB: 5120, noBudget: ['/home/u/libre', '/home/u/demo'] };
    expect(effectiveBudget(c, '/home/u/demo')).toEqual({ mb: 2048, source: 'explicit' });
    expect(effectiveBudget(c, '/home/u/libre')).toBeNull();
    expect(effectiveBudget(c, '/home/u/projet-a')).toEqual({ mb: 5120, source: 'default' });
    expect(effectiveBudget(c, null)).toBeNull();
    expect(effectiveBudget({ ...c, defaultBudgetMB: null }, '/home/u/projet-a')).toBeNull();
    // champ absent d'un objet en mémoire (la migration à 5 Go se fait dans validateAntigel) : aucun
    expect(effectiveBudget({ enabled: true, reserveMB: null, budgets: {} }, '/home/u/projet-a')).toBeNull();
    expect(effectiveBudget(c, '__proto__')).toBeNull();
  });
  test('budgetKey', () => {
    expect(budgetKey('/home/u/alpha/')).toBe('/home/u/alpha');
    expect(budgetKey('/')).toBeNull();
    expect(budgetKey('/a/..')).toBeNull();
    expect(budgetKey('/a\0b')).toBeNull();
    expect(budgetKey(`/${'x'.repeat(1100)}`)).toBeNull();
  });
});
