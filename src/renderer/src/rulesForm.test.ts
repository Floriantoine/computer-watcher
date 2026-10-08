import { describe, expect, test } from 'vitest';
import { RULE_TEMPLATES, validateRulesDetailed } from '../../core/rules/config';
import type { Rule } from '../../core/rules/types';
import { formToRule, newRuleFrom, ruleSummary, ruleToForm, statsLabel, withRule, withoutRule, withRuleMode, type RuleForm } from './rulesForm';

const base = { id: 'r-a', createdAt: 5, enabled: true, mode: 'simulate' as const };
const templates: Rule[] = RULE_TEMPLATES.map((t, i) => ({ ...t, id: `t-${i}`, createdAt: 0 }));
const vitestForm = (): RuleForm => ruleToForm({ ...templates[0]!, ...base });

describe('ruleToForm / formToRule', () => {
  test.each(templates)('aller-retour : $name', (r) => {
    const back = formToRule(ruleToForm(r), { id: r.id, createdAt: r.createdAt, enabled: r.enabled, mode: r.mode });
    expect(back.errors).toEqual({});
    expect(back.rule).toEqual(r);
  });
  test("overGB '0,05' → « Entre 0,1 et 64 Go » ; '65' aussi ; 'abc' aussi", () => {
    for (const v of ['0,05', '65', 'abc', '']) expect(formToRule({ ...vitestForm(), overGB: v }, base).errors.overGB).toBe('Entre 0,1 et 64 Go');
  });
  test("overGB '4,5' → 4608 Mo ; '4.5' aussi", () => {
    for (const v of ['4,5', '4.5', ' 4,5 ']) expect(formToRule({ ...vitestForm(), overGB: v }, base).rule?.condition).toMatchObject({ overMB: 4608 });
  });
  test("forMin '0' → erreur ; '2,5' → erreur", () => {
    expect(formToRule({ ...vitestForm(), forMin: '0' }, base).errors.forMin).toBe('Un entier entre 1 et 120');
    expect(formToRule({ ...vitestForm(), forMin: '2,5' }, base).errors.forMin).toBe('Un entier entre 1 et 120');
  });
  test("matchValue '' → erreur ; caractères hors du jeu sûr → erreur ; texte gardé tel quel", () => {
    expect(formToRule({ ...vitestForm(), matchValue: '' }, base).errors.matchValue).toBe('Nom requis');
    expect(formToRule({ ...vitestForm(), matchValue: 'a;b' }, base).errors.matchValue).toMatch(/seulement/);
    expect(formToRule({ ...vitestForm(), matchValue: 'node (vitest)' }, base).rule?.condition).toMatchObject({ match: { by: 'name', value: 'node (vitest)' } });
  });
  test('nom vide → erreur ; inactive sans catégorie → erreur ; underMin 31 → erreur', () => {
    expect(formToRule({ ...vitestForm(), name: ' ' }, base).errors.name).toBe('Nom requis');
    expect(formToRule({ ...ruleToForm(templates[1]!), categories: [] }, base).errors.categories).toBe('Au moins une catégorie');
    expect(formToRule({ ...ruleToForm(templates[2]!), underMin: '31' }, base).errors.underMin).toBe('Un entier entre 1 et 30');
  });
  test('toute règle produite passe la validation stricte du main', () => {
    const r = formToRule({ ...vitestForm(), kind: 'memory', target: 'group', matchBy: 'category', matchCategory: 'db', overGB: '0,1' }, base).rule!;
    expect(validateRulesDetailed({ enabled: true, list: [r] }).issues).toEqual([]);
  });
});

describe('newRuleFrom', () => {
  test('mode simulate, désactivée, id unique, champs du modèle', () => {
    const ids = new Set(['r-' + (1000).toString(36)]);
    const r = newRuleFrom(RULE_TEMPLATES[0]!, ids, 1000);
    expect(r).toMatchObject({ mode: 'simulate', enabled: false, createdAt: 1000, name: RULE_TEMPLATES[0]!.name, condition: RULE_TEMPLATES[0]!.condition });
    expect(ids.has(r.id)).toBe(false);
    expect(r.id).toMatch(/^[a-z0-9-]{1,40}$/);
    expect(validateRulesDetailed({ enabled: true, list: [r, newRuleFrom(null, new Set([r.id]), 1000)] }).issues).toEqual([]);
  });
  test('modèle actif ou activé → toujours Simulation et désactivée', () => {
    const r = newRuleFrom({ ...RULE_TEMPLATES[0]!, mode: 'active', enabled: true }, new Set(), 1);
    expect(r).toMatchObject({ mode: 'simulate', enabled: false });
  });
});

describe('ruleSummary', () => {
  test('les 3 modèles (texte exact)', () => {
    expect(templates.map(ruleSummary)).toEqual([
      'Si vitest dépasse 4 Go pendant 5 min → arrêter',
      'Si une instance Front ou Back de projet est inactive depuis 1 j → arrêter',
      "Si la mémoire doit s'épuiser dans moins de 3 min → arrêter le plus gros groupe qui grossit",
    ]);
  });
  test('groupe, catégorie, Mo, heures, applis incluses', () => {
    const mem = (c: object) => ruleSummary({ ...templates[0]!, condition: { ...(templates[0]!.condition as object), ...c } as Rule['condition'] });
    expect(mem({ target: 'group', match: { by: 'name', value: 'acme' }, overMB: 512 })).toBe('Si le groupe acme dépasse 512 Mo pendant 5 min → arrêter ses processus');
    expect(mem({ match: { by: 'category', value: 'test' }, overMB: 4608 })).toBe('Si une instance Tests dépasse 4,5 Go pendant 5 min → arrêter');
    expect(ruleSummary({ ...templates[1]!, condition: { kind: 'inactive', categories: ['db'], forHours: 36 } })).toBe('Si une instance BDD de projet est inactive depuis 36 h → arrêter');
    expect(ruleSummary({ ...templates[2]!, condition: { kind: 'forecast', underMin: 2, includeApps: ['firefox'] } })).toBe(
      "Si la mémoire doit s'épuiser dans moins de 2 min → arrêter le plus gros groupe qui grossit (applis incluses : firefox)",
    );
  });
});

describe('statsLabel', () => {
  const now = 10 * 86400_000;
  test('jamais, minutes, heures, jours', () => {
    expect(statsLabel(undefined, now)).toBe('jamais déclenchée');
    expect(statsLabel({ lastTs: null, lastResult: null, count7d: 0 }, now)).toBe('jamais déclenchée');
    expect(statsLabel({ lastTs: now - 30_000, lastResult: 'dry_run', count7d: 1 }, now)).toBe("dernière : à l'instant · 1 fois sur 7 j");
    expect(statsLabel({ lastTs: now - 5 * 60_000, lastResult: 'dry_run', count7d: 2 }, now)).toBe('dernière : il y a 5 min · 2 fois sur 7 j');
    expect(statsLabel({ lastTs: now - 2 * 3600_000, lastResult: 'sigterm', count7d: 3 }, now)).toBe('dernière : il y a 2 h · 3 fois sur 7 j');
    expect(statsLabel({ lastTs: now - 3 * 86400_000, lastResult: 'sigterm', count7d: 3 }, now)).toBe('dernière : il y a 3 j · 3 fois sur 7 j');
  });
});

describe('modifications de la config', () => {
  const cfg = { rules: { enabled: true, list: [templates[0]!] } } as never;
  test('withRule remplace ou ajoute ; withoutRule retire ; withRuleMode change le mode', () => {
    const r2 = { ...templates[1]!, id: 'x' };
    expect(withRule(cfg, r2).rules.list.map((r: Rule) => r.id)).toEqual(['t-0', 'x']);
    expect(withRule(cfg, { ...templates[0]!, name: 'n' }).rules.list.map((r: Rule) => r.name)).toEqual(['n']);
    expect(withoutRule(cfg, 't-0').rules.list).toEqual([]);
    expect(withRuleMode(cfg, 't-0', 'active').rules.list[0].mode).toBe('active');
  });
  test('withRule : condition d’une règle active modifiée → repasse en Simulation', () => {
    const active = { rules: { enabled: true, list: [{ ...templates[0]!, mode: 'active' }] } } as never;
    const changed = { ...templates[0]!, mode: 'active' as const, condition: { ...(templates[0]!.condition as object), overMB: 200 } as Rule['condition'] };
    expect(withRule(active, changed).rules.list[0].mode).toBe('simulate');
    expect(withRule(active, { ...templates[0]!, mode: 'active', name: 'autre nom' }).rules.list[0].mode).toBe('active');
  });
});
