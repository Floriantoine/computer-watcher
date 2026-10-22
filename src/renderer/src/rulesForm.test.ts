import { describe, expect, test } from 'vitest';
import { RULE_TEMPLATES, validateRulesDetailed } from '../../core/rules/config';
import type { Rule } from '../../core/rules/types';
import { checkRulesTransition } from '../../core/rules/config';
import { formToRule, newRuleFrom, ruleSummary, ruleToForm, statsLabel, withRecommended, withRule, withoutRule, withRuleMode, type RuleForm } from './rulesForm';

const base = { id: 'r-a', createdAt: 5, enabled: true, mode: 'simulate' as const };
const templates: Rule[] = RULE_TEMPLATES.map((t, i) => ({ ...t, id: `t-${i}`, createdAt: 0 }));
const vitestRule: Rule = { ...templates[0]!, condition: { kind: 'memory', target: 'instance', match: { by: 'name', value: 'vitest' }, overMB: 4096, forMin: 5 } };
const vitestForm = (): RuleForm => ruleToForm({ ...vitestRule, ...base });

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

describe('condition système (anti-gel)', () => {
  const sysForm = (): RuleForm => ruleToForm({ ...templates[3]!, ...base });
  test('formulaire : les 6 champs, valeurs par défaut', () => {
    expect(sysForm()).toMatchObject({ kind: 'system', memPercent: '95', memForSec: '15', cpuPercent: '95', cpuForSec: '60', psiPercent: '40', psiForSec: '20' });
    // une règle Mémoire passée en « Système » part des valeurs par défaut, pression comprise
    expect(formToRule({ ...vitestForm(), kind: 'system' }, base).rule?.condition).toEqual({
      kind: 'system', memPercent: 95, memForSec: 15, cpuPercent: 95, cpuForSec: 60, psiPercent: 40, psiForSec: 20,
    });
  });
  test('pression : les deux champs vides → pas de condition de pression ; un seul rempli, ou hors bornes → erreur', () => {
    const err = (patch: Partial<RuleForm>) => formToRule({ ...sysForm(), ...patch }, base).errors;
    const off = formToRule({ ...sysForm(), psiPercent: ' ', psiForSec: '' }, base).rule!.condition;
    expect(Object.keys(off)).toEqual(['kind', 'memPercent', 'memForSec', 'cpuPercent', 'cpuForSec']);
    expect(err({ psiPercent: '9' }).psiPercent).toBe('Un entier entre 10 et 90, ou les deux champs de pression vides');
    expect(err({ psiPercent: '40,5' }).psiPercent).toBe('Un entier entre 10 et 90, ou les deux champs de pression vides');
    expect(err({ psiForSec: '301' }).psiForSec).toBe('Un entier entre 5 et 300, ou les deux champs de pression vides');
    expect(err({ psiPercent: '' }).psiPercent).toBe('Un entier entre 10 et 90, ou les deux champs de pression vides');
    expect(err({ psiForSec: '' }).psiForSec).toBe('Un entier entre 5 et 300, ou les deux champs de pression vides');
    expect(formToRule({ ...sysForm(), psiPercent: '55', psiForSec: '30' }, base).rule?.condition).toMatchObject({ psiPercent: 55, psiForSec: 30 });
  });
  test('règle perso d’avant la pression : aller-retour sans pression (champs vides), condition inchangée', () => {
    const old: Rule = { ...templates[3]!, ...base, condition: { kind: 'system', memPercent: 90, memForSec: 20, cpuPercent: 99, cpuForSec: 120 } };
    const f = ruleToForm(old);
    expect(f).toMatchObject({ psiPercent: '', psiForSec: '' });
    expect(JSON.stringify(formToRule(f, base).rule!.condition)).toBe(JSON.stringify(old.condition));
  });
  test('bornes : chaque champ hors bornes ou non entier → son erreur', () => {
    const err = (patch: Partial<RuleForm>) => formToRule({ ...sysForm(), ...patch }, base).errors;
    expect(err({ memPercent: '69' }).memPercent).toBe('Un entier entre 70 et 99');
    expect(err({ memPercent: '100' }).memPercent).toBe('Un entier entre 70 et 99');
    expect(err({ memForSec: '4' }).memForSec).toBe('Un entier entre 5 et 600');
    expect(err({ cpuPercent: '95,5' }).cpuPercent).toBe('Un entier entre 70 et 100');
    expect(err({ cpuForSec: '' }).cpuForSec).toBe('Un entier entre 10 et 600');
    expect(err({ cpuForSec: '601' }).cpuForSec).toBe('Un entier entre 10 et 600');
    expect(formToRule({ ...sysForm(), memPercent: '90', cpuForSec: '120' }, base).rule?.condition).toEqual({
      kind: 'system', memPercent: 90, memForSec: 15, cpuPercent: 95, cpuForSec: 120, psiPercent: 40, psiForSec: 20,
    });
  });
  test('résumé : secondes ou minutes ; pression seulement si la règle en a une', () => {
    expect(ruleSummary({ ...templates[3]!, condition: { kind: 'system', memPercent: 90, memForSec: 30, cpuPercent: 99, cpuForSec: 90 } })).toBe(
      'Si la mémoire dépasse 90 % pendant 30 s ou le CPU 99 % pendant 90 s → arrêter la plus grosse vérification (tests, tsc, eslint), une à la fois',
    );
    expect(ruleSummary({ ...templates[3]!, condition: { kind: 'system', memPercent: 90, memForSec: 30, cpuPercent: 99, cpuForSec: 90, psiPercent: 50, psiForSec: 120 } })).toBe(
      'Si la mémoire dépasse 90 % pendant 30 s, le CPU 99 % pendant 90 s ou la pression mémoire 50 % pendant 2 min → arrêter la plus grosse vérification (tests, tsc, eslint), une à la fois',
    );
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
  test('les 4 modèles (texte exact)', () => {
    expect(templates.map(ruleSummary)).toEqual([
      'Si une instance Tests dépasse 4 Go pendant 5 min → arrêter',
      'Si une instance Front ou Back de projet est inactive depuis 4 h → arrêter',
      "Si la mémoire doit s'épuiser dans moins de 3 min → arrêter le plus gros groupe qui grossit",
      'Si la mémoire dépasse 95 % pendant 15 s, le CPU 95 % pendant 1 min ou la pression mémoire 40 % pendant 20 s → arrêter la plus grosse vérification (tests, tsc, eslint), une à la fois',
    ]);
    expect(ruleSummary(vitestRule)).toBe('Si vitest dépasse 4 Go pendant 5 min → arrêter');
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
  test('withRecommended : ajoute les 3 recommandées manquantes, puis rien (idempotent) ; accepté par le main', () => {
    const c = { version: 1, rules: { enabled: false, list: [templates[0]!] } } as never;
    const once = withRecommended(c, 42);
    expect(once.added).toBe(3);
    expect(once.config.rules.list.map((r: Rule) => r.id)).toEqual(['t-0', 'rec-inactive-front-back', 'rec-test-memory', 'rec-antigel']);
    expect(once.config.rules.enabled).toBe(false);
    expect(checkRulesTransition((c as { rules: never }).rules, once.config.rules)).toBeNull();
    const twice = withRecommended(once.config, 43);
    expect(twice.added).toBe(0);
    expect(twice.config.rules).toEqual(once.config.rules);
  });
});
