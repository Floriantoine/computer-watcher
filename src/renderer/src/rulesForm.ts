// Réglages › Règles (logique pure) : formulaire ↔ règle, nouvelle règle, résumé, statistiques, modifications de la config.
import { CATEGORIES, type Category } from '../../core/classify/categories';
import { MATCH_VALUE_RE, RULE_BOUNDS, RULE_NAME_MAX, validateRulesDetailed } from '../../core/rules/config';
import type { Rule, RuleCondition, RuleMode, RuleStats } from '../../core/rules/types';
import type { Config } from '../../core/types';
import { CATEGORY_META } from './categories';

export interface RuleForm {
  name: string;
  kind: 'memory' | 'inactive' | 'forecast';
  target: 'group' | 'instance';
  matchBy: 'name' | 'category';
  /** Nom à comparer : texte comparé tel quel (sans casse), jamais interprété. */
  matchValue: string;
  matchCategory: Category;
  overGB: string;
  forMin: string;
  categories: Category[];
  forHours: string;
  underMin: string;
  includeApps: string[];
}

export type RuleErrors = Partial<Record<keyof RuleForm, string>>;

const DEFAULT_FORM: RuleForm = {
  name: '', kind: 'memory', target: 'instance', matchBy: 'name', matchValue: '', matchCategory: 'test', overGB: '4', forMin: '5',
  categories: ['front', 'back'], forHours: '24', underMin: '3', includeApps: [],
};

/** « 4096 » → « 4 », « 4608 » → « 4,5 » (Go, deux décimales au plus). */
const gb = (mb: number) => String(Math.round((mb / 1024) * 100) / 100).replace('.', ',');

export function ruleToForm(r: Rule): RuleForm {
  const f: RuleForm = { ...DEFAULT_FORM, categories: [...DEFAULT_FORM.categories], includeApps: [], name: r.name, kind: r.condition.kind };
  const c = r.condition;
  if (c.kind === 'memory') {
    f.target = c.target;
    f.matchBy = c.match.by;
    if (c.match.by === 'name') f.matchValue = c.match.value;
    else f.matchCategory = c.match.value;
    f.overGB = gb(c.overMB);
    f.forMin = String(c.forMin);
  } else if (c.kind === 'inactive') {
    f.categories = [...c.categories];
    f.forHours = String(c.forHours);
  } else {
    f.underMin = String(c.underMin);
    f.includeApps = [...c.includeApps];
  }
  return f;
}

const intIn = (raw: string, [lo, hi]: readonly [number, number]): number | null => {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= lo && n <= hi ? n : null;
};

export function formToRule(f: RuleForm, base: { id: string; createdAt: number; enabled: boolean; mode: RuleMode }): { rule?: Rule; errors: RuleErrors } {
  const errors: RuleErrors = {};
  const name = f.name.trim();
  if (!name) errors.name = 'Nom requis';
  else if (name.length > RULE_NAME_MAX) errors.name = `${RULE_NAME_MAX} caractères au plus`;
  let condition: RuleCondition | null = null;
  if (f.kind === 'memory') {
    let match: Extract<RuleCondition, { kind: 'memory' }>['match'] | null = null;
    if (f.matchBy === 'name') {
      const v = f.matchValue.trim();
      if (!v) errors.matchValue = 'Nom requis';
      else if (!MATCH_VALUE_RE.test(v)) errors.matchValue = '100 caractères au plus : lettres, chiffres, espace et . _ + : @ / ( ) - seulement';
      else match = { by: 'name', value: v };
    } else match = { by: 'category', value: f.matchCategory };
    const g = Number(f.overGB.trim().replace(',', '.'));
    const overMB = f.overGB.trim() && Number.isFinite(g) && g >= 0.1 && g <= 64 ? Math.min(RULE_BOUNDS.overMB[1], Math.max(RULE_BOUNDS.overMB[0], Math.round(g * 1024))) : null;
    if (overMB === null) errors.overGB = 'Entre 0,1 et 64 Go';
    const forMin = intIn(f.forMin, RULE_BOUNDS.forMin);
    if (forMin === null) errors.forMin = `Un entier entre ${RULE_BOUNDS.forMin[0]} et ${RULE_BOUNDS.forMin[1]}`;
    if (match && overMB !== null && forMin !== null) condition = { kind: 'memory', target: f.target, match, overMB, forMin };
  } else if (f.kind === 'inactive') {
    const cats = CATEGORIES.filter((c) => f.categories.includes(c));
    if (!cats.length) errors.categories = 'Au moins une catégorie';
    const forHours = intIn(f.forHours, RULE_BOUNDS.forHours);
    if (forHours === null) errors.forHours = `Un entier entre ${RULE_BOUNDS.forHours[0]} et ${RULE_BOUNDS.forHours[1]}`;
    if (cats.length && forHours !== null) condition = { kind: 'inactive', categories: cats, forHours };
  } else {
    const underMin = intIn(f.underMin, RULE_BOUNDS.underMin);
    if (underMin === null) errors.underMin = `Un entier entre ${RULE_BOUNDS.underMin[0]} et ${RULE_BOUNDS.underMin[1]}`;
    else condition = { kind: 'forecast', underMin, includeApps: [...new Set(f.includeApps)].sort() };
  }
  if (Object.keys(errors).length || !condition) return { errors };
  const rule: Rule = { id: base.id, name, enabled: base.enabled, mode: base.mode, condition, createdAt: base.createdAt };
  // même validation stricte que le main et le service
  const issue = validateRulesDetailed({ enabled: true, list: [rule] }).issues[0];
  if (issue) return { errors: { name: issue.error } };
  return { rule, errors };
}

/** Nouvelle règle (vide ou d'après un modèle) : toujours désactivée et en Simulation, id unique `r-<base36>`. */
export function newRuleFrom(template: Omit<Rule, 'id' | 'createdAt'> | null, existingIds: ReadonlySet<string>, now: number): Rule {
  const stem = `r-${Math.max(0, Math.floor(now)).toString(36)}`;
  let id = stem;
  for (let i = 1; existingIds.has(id); i++) id = `${stem}-${i}`;
  const t = template ?? {
    name: 'Nouvelle règle',
    condition: { kind: 'memory', target: 'instance', match: { by: 'category', value: 'test' }, overMB: 4096, forMin: 10 } as RuleCondition,
  };
  return { id, name: t.name, enabled: false, mode: 'simulate', condition: structuredClone(t.condition), createdAt: now };
}

const size = (mb: number) => (mb >= 1024 ? `${gb(mb)} Go` : `${mb} Mo`);
const duration = (h: number) => (h % 24 === 0 ? `${h / 24} j` : `${h} h`);
const catList = (cats: readonly Category[]) => {
  const labels = cats.map((c) => CATEGORY_META[c].label);
  return labels.length <= 1 ? labels.join('') : `${labels.slice(0, -1).join(', ')} ou ${labels[labels.length - 1]}`;
};

/** « Si vitest dépasse 4 Go pendant 5 min → arrêter » */
export function ruleSummary(r: Rule): string {
  const c = r.condition;
  if (c.kind === 'memory') {
    const over = `dépasse ${size(c.overMB)} pendant ${c.forMin} min`;
    if (c.target === 'group') {
      return c.match.by === 'name'
        ? `Si le groupe ${c.match.value} ${over} → arrêter ses processus`
        : `Si un groupe avec une instance ${CATEGORY_META[c.match.value].label} ${over} → arrêter ses processus`;
    }
    return c.match.by === 'name' ? `Si ${c.match.value} ${over} → arrêter` : `Si une instance ${CATEGORY_META[c.match.value].label} ${over} → arrêter`;
  }
  if (c.kind === 'inactive') return `Si une instance ${catList(c.categories)} de projet est inactive depuis ${duration(c.forHours)} → arrêter`;
  const apps = c.includeApps.length ? ` (applis incluses : ${c.includeApps.join(', ')})` : '';
  return `Si la mémoire doit s'épuiser dans moins de ${c.underMin} min → arrêter le plus gros groupe qui grossit${apps}`;
}

/** « jamais déclenchée » | « dernière : il y a 2 h · 3 fois sur 7 j » */
export function statsLabel(s: RuleStats | undefined, now: number): string {
  if (!s || s.lastTs === null) return 'jamais déclenchée';
  const ms = Math.max(0, now - s.lastTs);
  const ago = ms < 60_000 ? "à l'instant" : ms < 3600_000 ? `il y a ${Math.floor(ms / 60_000)} min` : ms < 86400_000 ? `il y a ${Math.floor(ms / 3600_000)} h` : `il y a ${Math.floor(ms / 86400_000)} j`;
  return `dernière : ${ago} · ${s.count7d} fois sur 7 j`;
}

const sameCondition = (a: RuleCondition, b: RuleCondition) => JSON.stringify(a) === JSON.stringify(b);

/** Ajoute ou remplace la règle ; une règle active dont la condition change repasse en Simulation (comme l'exige le main). */
export function withRule(c: Config, rule: Rule): Config {
  const old = c.rules.list.find((r) => r.id === rule.id);
  const next = old && rule.mode === 'active' && !sameCondition(old.condition, rule.condition) ? { ...rule, mode: 'simulate' as const } : rule;
  const list = old ? c.rules.list.map((r) => (r.id === rule.id ? next : r)) : [...c.rules.list, next];
  return { ...c, rules: { ...c.rules, list } };
}

export function withoutRule(c: Config, id: string): Config {
  return { ...c, rules: { ...c.rules, list: c.rules.list.filter((r) => r.id !== id) } };
}

export function withRuleMode(c: Config, id: string, mode: RuleMode): Config {
  return { ...c, rules: { ...c.rules, list: c.rules.list.map((r) => (r.id === id ? { ...r, mode } : r)) } };
}

export function withRuleEnabled(c: Config, id: string, enabled: boolean): Config {
  return { ...c, rules: { ...c.rules, list: c.rules.list.map((r) => (r.id === id ? { ...r, enabled } : r)) } };
}

export function withRulesEnabled(c: Config, enabled: boolean): Config {
  return { ...c, rules: { ...c.rules, enabled } };
}
