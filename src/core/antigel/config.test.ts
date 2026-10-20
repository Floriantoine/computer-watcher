import { describe, expect, test } from 'vitest';
import { BUDGET_MIN_MB, MAX_BUDGETS, RESERVE_MAX_MB, budgetKey, validateAntigel } from './config';

describe('validateAntigel', () => {
  test('absente : allumé, réserve automatique, aucun budget (nouvel objet à chaque fois)', () => {
    const a = validateAntigel(undefined);
    expect(a).toEqual({ enabled: true, reserveMB: null, budgets: {} });
    expect(validateAntigel(undefined)!.budgets).not.toBe(a!.budgets);
  });
  test('valeurs gardées, racines normalisées', () => {
    expect(validateAntigel({ enabled: false, reserveMB: 6144, budgets: { '/home/u/alpha/': 4096, '/home/u/b/../beta': 256 } }))
      .toEqual({ enabled: false, reserveMB: 6144, budgets: { '/home/u/alpha': 4096, '/home/u/beta': 256 } });
    expect(validateAntigel({ enabled: true })).toEqual({ enabled: true, reserveMB: null, budgets: {} });
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
    expect(validateAntigel({ enabled: true, desk: false })).toEqual({ enabled: true, reserveMB: null, budgets: {}, desk: false });
    expect(validateAntigel({ enabled: true, desk: true })?.desk).toBe(true);
    expect(validateAntigel({ enabled: true, desk: 'non' })).toBeNull();
  });
  test('budgetKey', () => {
    expect(budgetKey('/home/u/alpha/')).toBe('/home/u/alpha');
    expect(budgetKey('/')).toBeNull();
    expect(budgetKey('/a/..')).toBeNull();
    expect(budgetKey('/a\0b')).toBeNull();
    expect(budgetKey(`/${'x'.repeat(1100)}`)).toBeNull();
  });
});
