import { describe, expect, test, vi } from 'vitest';
import type { GroupClassification } from '../classify/classify';
import { group, node, proc } from '../classify/testFixtures';
import type { Forecast } from '../forecast/forecast';
import type { Category, Group, GroupKind, InstanceSummary, ProcInfo, ProcNode } from '../types';
import {
  emptyRuleState, evaluateRules, INACTIVE_CHECK_MS, MAX_ACTIONS_PER_HOUR, needsClassification, RULE_COOLDOWN_MS, type EvalInput, type RuleDecision,
} from './engine';
import type { Rule, RuleCondition } from './types';

const GB = 1024 * 1024;
const MIN = 60_000;
const H = 3600_000;

// Arbre de base : systemd --user (500) → service (900, selfPid) ; terminal warp → zsh
const sysd = proc('systemd', 'systemd --user', { pid: 500, ppid: 1 });
const self = proc('node', 'node /x/out/main/recorder.js', { pid: 900, ppid: 500 });

function mkGroup(id: string, kind: GroupKind, roots: ProcNode[], label = id): Group {
  const g = group(id, kind, roots);
  const all: ProcInfo[] = [];
  const walk = (n: ProcNode) => { all.push(n.proc); n.children.forEach(walk); };
  roots.forEach(walk);
  g.label = label;
  g.rssKB = all.reduce((s, p) => s + p.rssKB, 0);
  g.swapKB = all.reduce((s, p) => s + p.swapKB, 0);
  return g;
}

function inst(g: Group, root: ProcNode, category: Category, label: string, over: Partial<InstanceSummary> = {}): InstanceSummary {
  const procs: ProcInfo[] = [];
  const walk = (n: ProcNode) => { procs.push(n.proc); n.children.forEach(walk); };
  walk(root);
  return {
    key: `${g.id}#${root.proc.pid}:${root.proc.startTicks}`, groupId: g.id, project: g.id.replace(/^project:/, ''), category, source: 'command',
    signature: label, label, rootPid: root.proc.pid, rootStartTicks: root.proc.startTicks, pids: procs.map((p) => p.pid), ports: [],
    ageSec: root.proc.ageSec, rssKB: procs.reduce((s, p) => s + p.rssKB, 0), swapKB: procs.reduce((s, p) => s + p.swapKB, 0), cpuPercent: 0,
    duplicate: false, protected: false, ...over,
  };
}

const cls = (entries: [Group, InstanceSummary[]][]) =>
  new Map<string, GroupClassification>(entries.map(([g, i]) => [g.id, { categories: [...new Set(i.map((x) => x.category))], instances: i, launcherPids: [] }]));

const rule = (condition: RuleCondition, over: Partial<Rule> = {}): Rule => ({
  id: 'r-a', name: 'règle', enabled: true, mode: 'simulate', createdAt: 0, condition, ...over,
});
const vitestRule = (over: Partial<Rule> = {}) =>
  rule({ kind: 'memory', target: 'instance', match: { by: 'name', value: 'vitest' }, overMB: 4096, forMin: 5 }, over);

/** Projet acme : vitest (racine + worker) lancé depuis zsh dans warp. */
function acme(vitestGB: number) {
  const warp = proc('warp', 'warp', { pid: 600, ppid: 500 });
  const zsh = proc('zsh', 'zsh', { pid: 601, ppid: 600 });
  const v = proc('node', 'node /home/u/acme/node_modules/.bin/vitest', { pid: 700, ppid: 601, startTicks: 7000, rssKB: vitestGB * GB - 100_000 });
  const w = proc('node', 'node worker', { pid: 701, ppid: 700, startTicks: 7010, rssKB: 100_000 });
  const vNode = node(v, node(w));
  const project = mkGroup('project:/home/u/acme', 'project', [vNode], 'acme');
  const term = mkGroup('app:warp', 'app', [node(warp, node(zsh))], 'Warp');
  zsh.ppid = 600;
  v.ppid = 601;
  const svc = mkGroup('command:systemd', 'command', [node(sysd, node(self))], 'systemd');
  self.ppid = 500;
  return { groups: [project, term, svc], classification: cls([[project, [inst(project, vNode, 'test', 'vitest')]]]), v, w, project };
}

function input(over: Partial<EvalInput>): EvalInput {
  return {
    now: 0, enabled: true, rules: [], groups: [], classification: null, forecast: null, growthKB: new Map(), inactive: null,
    isProtected: () => false, appRoot: null, currentUid: 1000, selfPid: 900, ...over,
  };
}

const fires = (ds: RuleDecision[]) => ds.filter((d) => d.outcome === 'fire');

describe('mémoire', () => {
  test('instance vitest à 4,5 Go : rien avant 5 min, fire à 5 min avec les processus de l’instance (startTicks)', () => {
    const a = acme(4.5);
    const st = emptyRuleState();
    const at = (now: number) => evaluateRules(input({ now, rules: [vitestRule()], groups: a.groups, classification: a.classification }), st);
    expect(at(0)).toEqual([]);
    expect(at(4 * MIN + 59_000)).toEqual([]);
    const d = at(5 * MIN);
    expect(fires(d)).toHaveLength(1);
    expect(d[0]).toMatchObject({ outcome: 'fire', mode: 'simulate', ruleId: 'r-a' });
    if (d[0]!.outcome !== 'fire') throw new Error();
    expect(d[0].target.targets).toEqual([{ pid: 700, startTicks: 7000 }, { pid: 701, startTicks: 7010 }]);
    expect(d[0].target.names).toEqual(['node', 'node']);
    expect(d[0].target.memKB).toBe(4.5 * GB);
  });

  test('repasse à 3 Go à 3 min puis remonte → le compteur repart', () => {
    const st = emptyRuleState();
    const at = (now: number, gb: number) => {
      const a = acme(gb);
      return evaluateRules(input({ now, rules: [vitestRule()], groups: a.groups, classification: a.classification }), st);
    };
    at(0, 4.5);
    at(3 * MIN, 3);
    at(4 * MIN, 4.5);
    expect(at(5 * MIN, 4.5)).toEqual([]);
    expect(at(8 * MIN + 59_000, 4.5)).toEqual([]);
    expect(fires(at(9 * MIN, 4.5))).toHaveLength(1);
  });

  test('règle enabled: false → aucune décision', () => {
    const a = acme(5);
    const st = emptyRuleState();
    for (const now of [0, 10 * MIN]) expect(evaluateRules(input({ now, rules: [vitestRule({ enabled: false })], groups: a.groups, classification: a.classification }), st)).toEqual([]);
  });

  test('interrupteur général éteint → aucune décision, aucun appel, état intact', () => {
    const a = acme(5);
    const st = emptyRuleState();
    const inactive = vi.fn(() => new Set<string>());
    const isProtected = vi.fn(() => false);
    for (const now of [0, 10 * MIN]) {
      expect(evaluateRules(input({ now, enabled: false, rules: [vitestRule()], groups: a.groups, classification: a.classification, inactive, isProtected }), st)).toEqual([]);
    }
    expect(inactive).not.toHaveBeenCalled();
    expect(isProtected).not.toHaveBeenCalled();
    expect(st).toEqual(emptyRuleState());
  });

  test('nom comparé tel quel : « vit.* » ne vise pas vitest ; casse ignorée (« VITEST » vise vitest)', () => {
    const a = acme(5);
    const run = (value: string) => {
      const st = emptyRuleState();
      const r = rule({ kind: 'memory', target: 'instance', match: { by: 'name', value }, overMB: 4096, forMin: 1 });
      evaluateRules(input({ now: 0, rules: [r], groups: a.groups, classification: a.classification }), st);
      return fires(evaluateRules(input({ now: MIN, rules: [r], groups: a.groups, classification: a.classification }), st));
    };
    expect(run('vit.*')).toHaveLength(0);
    expect(run('VITEST')).toHaveLength(1);
  });

  test('cible groupe par catégorie : processus du groupe, moins la liste « jamais tuer »', () => {
    const a = acme(5);
    const r = rule({ kind: 'memory', target: 'group', match: { by: 'name', value: 'acme' }, overMB: 4096, forMin: 1 });
    const st = emptyRuleState();
    evaluateRules(input({ now: 0, rules: [r], groups: a.groups, classification: a.classification }), st);
    const d = fires(evaluateRules(input({ now: MIN, rules: [r], groups: a.groups, classification: a.classification }), st));
    expect(d).toHaveLength(1);
    if (d[0]!.outcome !== 'fire') throw new Error();
    expect(d[0].target.targets.map((t) => t.pid)).toEqual([700, 701]);
  });
});

describe('cooldown et quotas', () => {
  test('2ᵉ dépassement 4 min après un fire → skip/cooldown ; à 5 min → fire', () => {
    const a = acme(5);
    const st = emptyRuleState();
    const r = rule({ kind: 'memory', target: 'instance', match: { by: 'name', value: 'vitest' }, overMB: 4096, forMin: 1 });
    const at = (now: number) => evaluateRules(input({ now, rules: [r], groups: a.groups, classification: a.classification }), st);
    at(0);
    expect(fires(at(MIN))).toHaveLength(1);
    at(MIN + 1000); // le dépassement recommence (overSince effacé au fire)
    expect(at(MIN + 4 * MIN)).toEqual([expect.objectContaining({ outcome: 'skip', reason: 'cooldown' })]);
    expect(fires(at(MIN + RULE_COOLDOWN_MS))).toHaveLength(1);
  });

  test('11 règles actives distinctes dans la même heure → 10 fire puis skip/hourly-quota (règle mise en pause)', () => {
    const a = acme(5);
    const st = emptyRuleState();
    const rules = Array.from({ length: 11 }, (_, i) =>
      rule({ kind: 'memory', target: 'instance', match: { by: 'name', value: 'vitest' }, overMB: 4096, forMin: 1 }, { id: `r-${i}`, mode: 'active' }));
    evaluateRules(input({ now: 0, rules, groups: a.groups, classification: a.classification }), st);
    const d = evaluateRules(input({ now: MIN, rules, groups: a.groups, classification: a.classification }), st);
    expect(fires(d)).toHaveLength(MAX_ACTIONS_PER_HOUR);
    expect(d[10]).toMatchObject({ ruleId: 'r-10', outcome: 'skip', reason: 'hourly-quota' });
    // en pause : plus aucune décision pour elle pendant l'heure
    expect(evaluateRules(input({ now: 2 * MIN, rules: [rules[10]!], groups: a.groups, classification: a.classification }), st)).toEqual([]);
    expect(st.pausedUntil.get('r-10')).toBe(MIN + H);
  });

  test('les simulations ne consomment pas le quota des actions réelles (10 + 10 dans l’heure → tout passe)', () => {
    const a = acme(5);
    const st = emptyRuleState();
    const mk = (i: number, mode: 'active' | 'simulate') =>
      rule({ kind: 'memory', target: 'instance', match: { by: 'name', value: 'vitest' }, overMB: 4096, forMin: 1 }, { id: `r-${mode}-${i}`, mode });
    const rules = [...Array.from({ length: 10 }, (_, i) => mk(i, 'simulate')), ...Array.from({ length: 10 }, (_, i) => mk(i, 'active'))];
    evaluateRules(input({ now: 0, rules, groups: a.groups, classification: a.classification }), st);
    expect(fires(evaluateRules(input({ now: MIN, rules, groups: a.groups, classification: a.classification }), st))).toHaveLength(20);
  });
});

describe('garde-fous', () => {
  const memRule = (value: string, target: 'group' | 'instance' = 'group') =>
    rule({ kind: 'memory', target, match: { by: 'name', value }, overMB: 1024, forMin: 1 });
  const twice = (r: Rule, groups: Group[], classification: ReturnType<typeof cls> | null = null, over: Partial<EvalInput> = {}) => {
    const st = emptyRuleState();
    evaluateRules(input({ now: 0, rules: [r], groups, classification, ...over }), st);
    return evaluateRules(input({ now: MIN, rules: [r], groups, classification, ...over }), st);
  };

  test('groupe claude de 6 Go avec une règle nom « claude » → aucun fire', () => {
    const c = proc('claude', 'claude', { pid: 800, ppid: 601, rssKB: 6 * GB });
    const tool = proc('node', 'node mcp', { pid: 801, ppid: 800, rssKB: GB });
    const g = mkGroup('claude', 'claude', [node(c, node(tool))], 'Claude');
    g.rootName = 'claude';
    expect(fires(twice(memRule('claude'), [g]))).toEqual([]);
  });

  test('instance contenant un zsh : le zsh (et son lanceur) retirés, rien d’autre → skip/guard « rien à arrêter »', () => {
    const z = proc('zsh', 'zsh', { pid: 820, ppid: 500, rssKB: 2 * GB });
    const g = mkGroup('command:zsh', 'command', [node(z)], 'zsh');
    const d = twice(memRule('zsh'), [g]);
    expect(d).toEqual([expect.objectContaining({ outcome: 'skip', reason: 'guard' })]);
  });

  test('instance où un processus est protégé par la config : celui-ci retiré, les autres visés', () => {
    const root = proc('node', 'node server', { pid: 830, ppid: 500, rssKB: GB });
    const pg = proc('postgres', 'postgres', { pid: 831, ppid: 500, rssKB: GB });
    const g = mkGroup('project:/home/u/beta', 'project', [node(root), node(pg)], 'beta');
    const d = twice(memRule('beta'), [g], null, { isProtected: (n) => n === 'postgres' });
    expect(fires(d)).toHaveLength(1);
    if (d[0]!.outcome !== 'fire') throw new Error();
    expect(d[0].target.targets.map((t) => t.pid)).toEqual([830]);
  });

  test('tous les processus protégés → skip/guard', () => {
    const pg = proc('postgres', 'postgres', { pid: 831, ppid: 500, rssKB: 2 * GB });
    const g = mkGroup('command:postgres', 'command', [node(pg)], 'postgres');
    expect(twice(memRule('postgres'), [g], null, { isProtected: (n) => n === 'postgres' })).toEqual([expect.objectContaining({ outcome: 'skip', reason: 'guard' })]);
  });

  test('processus d’uid 0 ou d’un autre utilisateur → exclus', () => {
    const r0 = proc('node', 'node a', { pid: 840, ppid: 1, uid: 0, rssKB: 2 * GB });
    const r1 = proc('node', 'node b', { pid: 841, ppid: 1, uid: 1001, rssKB: 2 * GB });
    const g = mkGroup('command:node', 'command', [node(r0), node(r1)], 'node');
    expect(fires(twice(memRule('node'), [g]))).toEqual([]);
  });

  test('groupe « others » → jamais visé', () => {
    const p = proc('node', 'node a', { pid: 850, ppid: 500, rssKB: 2 * GB });
    const g = mkGroup('others', 'others', [node(p)], 'Autres');
    g.rootName = 'node';
    expect(twice(memRule('node'), [g])).toEqual([]);
  });

  test('nom « node » d’un groupe dont la racine est l’app proc-watch (cmdline) → exclu', () => {
    const app = proc('node', 'electron /home/u/Delivery/app-x', { pid: 860, ppid: 500, rssKB: 2 * GB });
    const g = mkGroup('command:node', 'command', [node(app)], 'node');
    expect(fires(twice(memRule('node'), [g], null, { appRoot: '/home/u/Delivery/app-x' }))).toEqual([]);
  });

  test('processus avec un ancêtre claude (outil de dev lancé par Claude) → exclu', () => {
    const c = proc('claude', 'claude', { pid: 870, ppid: 500, rssKB: 1000 });
    const v = proc('node', 'node vitest', { pid: 871, ppid: 870, rssKB: 5 * GB });
    const cg = mkGroup('claude', 'claude', [node(c)], 'Claude');
    const vn = node(v);
    v.ppid = 870;
    const pg = mkGroup('project:/home/u/acme', 'project', [vn], 'acme');
    const classification = cls([[pg, [inst(pg, vn, 'test', 'vitest', { launchedBy: 'claude' })]]]);
    expect(fires(twice(memRule('vitest', 'instance'), [cg, pg], classification))).toEqual([]);
  });

  test('guard journalisé au plus une fois par 5 min', () => {
    const z = proc('zsh', 'zsh', { pid: 820, ppid: 500, rssKB: 2 * GB });
    const g = mkGroup('command:zsh', 'command', [node(z)], 'zsh');
    const r = memRule('zsh');
    const st = emptyRuleState();
    const at = (now: number) => evaluateRules(input({ now, rules: [r], groups: [g] }), st);
    at(0);
    expect(at(MIN)).toHaveLength(1);
    expect(at(2 * MIN)).toEqual([]);
    expect(at(MIN + RULE_COOLDOWN_MS)).toHaveLength(1);
  });
});

describe('inactive (b)', () => {
  function project(kind: GroupKind = 'project', category: Category = 'back', over: Partial<InstanceSummary> = {}) {
    const p = proc('node', 'node server.js', { pid: 900 + 50, ppid: 500, startTicks: 9500, ageSec: 2 * 86400, rssKB: GB });
    const n = node(p);
    p.ppid = 500;
    const g = mkGroup(kind === 'project' ? 'project:/home/u/acme' : 'deleted', kind, [n], 'acme');
    const i = inst(g, n, category, 'node server.js', over);
    return { groups: [g], classification: cls([[g, [i]]]), key: `${p.pid}:${p.startTicks}` };
  }
  const r = rule({ kind: 'inactive', categories: ['back'], forHours: 24 });

  test('instance back de projet âgée de 2 j, ensemble actif vide → fire', () => {
    const pj = project();
    const inactive = vi.fn(() => new Set<string>());
    const d = evaluateRules(input({ now: 10 * H, rules: [r], ...pj, inactive }), emptyRuleState());
    expect(fires(d)).toHaveLength(1);
    expect(inactive).toHaveBeenCalledWith([{ pid: 950, startTicks: 9500 }], 10 * H - 24 * H);
  });
  test('dossier supprimé aussi visé', () => {
    const pj = project('deleted');
    expect(fires(evaluateRules(input({ now: 10 * H, rules: [r], ...pj, inactive: () => new Set() }), emptyRuleState()))).toHaveLength(1);
  });
  test('active → rien ; pas d’historique (null) → rien ; sans fonction → rien', () => {
    const pj = project();
    expect(evaluateRules(input({ now: 10 * H, rules: [r], ...pj, inactive: () => new Set([pj.key]) }), emptyRuleState())).toEqual([]);
    expect(evaluateRules(input({ now: 10 * H, rules: [r], ...pj, inactive: () => null }), emptyRuleState())).toEqual([]);
    expect(evaluateRules(input({ now: 10 * H, rules: [r], ...pj, inactive: null }), emptyRuleState())).toEqual([]);
  });
  test('seulement project/deleted : une instance d’un groupe command ou app → jamais', () => {
    const pj = project();
    pj.groups[0]!.kind = 'command';
    const inactive = vi.fn(() => new Set<string>());
    expect(evaluateRules(input({ now: 10 * H, rules: [r], ...pj, inactive }), emptyRuleState())).toEqual([]);
    pj.groups[0]!.kind = 'app';
    expect(evaluateRules(input({ now: 10 * H, rules: [r], ...pj, inactive }), emptyRuleState())).toEqual([]);
  });
  test('trop jeune, autre catégorie, lancée par Claude → rien', () => {
    const young = project('project', 'back', { ageSec: 3600 });
    expect(evaluateRules(input({ now: 10 * H, rules: [r], ...young, inactive: () => new Set() }), emptyRuleState())).toEqual([]);
    const front = project('project', 'front');
    expect(evaluateRules(input({ now: 10 * H, rules: [r], ...front, inactive: () => new Set() }), emptyRuleState())).toEqual([]);
    const byClaude = project('project', 'back', { launchedBy: 'claude' });
    expect(evaluateRules(input({ now: 10 * H, rules: [r], ...byClaude, inactive: () => new Set() }), emptyRuleState())).toEqual([]);
  });
  test('deux appels à 30 s d’intervalle → inactive appelé une seule fois', () => {
    const pj = project();
    const inactive = vi.fn(() => new Set([pj.key]));
    const st = emptyRuleState();
    evaluateRules(input({ now: 10 * H, rules: [r], ...pj, inactive }), st);
    evaluateRules(input({ now: 10 * H + 30_000, rules: [r], ...pj, inactive }), st);
    expect(inactive).toHaveBeenCalledTimes(1);
    evaluateRules(input({ now: 10 * H + INACTIVE_CHECK_MS, rules: [r], ...pj, inactive }), st);
    expect(inactive).toHaveBeenCalledTimes(2);
  });
});

describe('prévision (c)', () => {
  const f = (etaMin: number, decliningMinutes: number): Forecast => ({ marginKB: GB, floorKB: 2 * GB, slopeKBPerMin: -GB, etaMin, decliningMinutes, spanMin: 5 });
  const r = rule({ kind: 'forecast', underMin: 3, includeApps: [] });
  function world() {
    const mk = (id: string, kind: GroupKind, pid: number, gb: number, name = 'node') => {
      const p = proc(name, `${name} ${id}`, { pid, ppid: 500, rssKB: gb * GB });
      return mkGroup(id, kind, [node(p)], id);
    };
    const groups = [
      mk('project:/a', 'project', 1001, 3), mk('project:/b', 'project', 1002, 6), mk('project:/c', 'project', 1003, 9),
      mk('command:postgres', 'command', 1004, 10, 'postgres'), mk('app:firefox', 'app', 1005, 12, 'firefox'), mk('claude', 'claude', 1006, 20, 'claude'),
    ];
    const growthKB = new Map([
      ['project:/a', 2 * GB], ['project:/b', 0.5 * GB], ['project:/c', -GB], ['command:postgres', 3 * GB], ['app:firefox', GB], ['claude', 5 * GB],
    ]);
    return { groups, growthKB };
  }
  const target = (d: RuleDecision[]) => (d[0]?.outcome === 'fire' ? d[0].target.key : null);

  test('ETA 2 min, 4 minutes en baisse, condition tenue → B (le plus gros qui grossit, hors protégé, appli non choisie, Claude)', () => {
    const d = evaluateRules(input({ rules: [r], ...world(), forecast: { forecast: f(2, 4), held: true }, isProtected: (n) => n === 'postgres' }), emptyRuleState());
    expect(target(d)).toBe('project:/b');
  });
  test('appli choisie explicitement (firefox) → visée', () => {
    const r2 = rule({ kind: 'forecast', underMin: 3, includeApps: ['firefox'] });
    const d = evaluateRules(input({ rules: [r2], ...world(), forecast: { forecast: f(2, 4), held: true }, isProtected: (n) => n === 'postgres' }), emptyRuleState());
    expect(target(d)).toBe('app:firefox');
  });
  test('ETA 2 min mais 1 minute en baisse → rien ; condition pas tenue (stepAlert) → rien ; ETA 4 min → rien', () => {
    expect(evaluateRules(input({ rules: [r], ...world(), forecast: { forecast: f(2, 1), held: true } }), emptyRuleState())).toEqual([]);
    expect(evaluateRules(input({ rules: [r], ...world(), forecast: { forecast: f(2, 4), held: false } }), emptyRuleState())).toEqual([]);
    expect(evaluateRules(input({ rules: [r], ...world(), forecast: { forecast: f(4, 4), held: true } }), emptyRuleState())).toEqual([]);
  });
  test('aucun groupe qui grossit → rien', () => {
    const w = world();
    const d = evaluateRules(input({ rules: [r], groups: w.groups, growthKB: new Map([...w.growthKB].map(([k]) => [k, -1])), forecast: { forecast: f(2, 4), held: true } }), emptyRuleState());
    expect(d).toEqual([]);
  });
});

describe('pureté', () => {
  test('n’appelle que inactive et isProtected, ne modifie pas input', () => {
    const a = acme(5);
    const isProtected = vi.fn(() => false);
    const inactive = vi.fn(() => new Set<string>());
    const rules = [vitestRule(), rule({ kind: 'inactive', categories: ['test'], forHours: 1 }, { id: 'r-b' })];
    const inp = input({ now: 0, rules, groups: a.groups, classification: a.classification, isProtected, inactive });
    const before = JSON.stringify({ ...inp, classification: [...a.classification], growthKB: [...inp.growthKB] });
    const spyNow = vi.spyOn(Date, 'now');
    evaluateRules(inp, emptyRuleState());
    evaluateRules({ ...inp, now: 10 * MIN }, emptyRuleState());
    expect(spyNow).not.toHaveBeenCalled();
    spyNow.mockRestore();
    expect(JSON.stringify({ ...inp, classification: [...a.classification], growthKB: [...inp.growthKB] })).toBe(before);
  });

  test('needsClassification : règle activée de type instance, catégorie ou inactive ; interrupteur éteint → non', () => {
    expect(needsClassification([vitestRule()], true)).toBe(true);
    expect(needsClassification([vitestRule({ enabled: false })], true)).toBe(false);
    expect(needsClassification([vitestRule()], false)).toBe(false);
    expect(needsClassification([rule({ kind: 'memory', target: 'group', match: { by: 'name', value: 'x' }, overMB: 200, forMin: 1 })], true)).toBe(false);
    expect(needsClassification([rule({ kind: 'memory', target: 'group', match: { by: 'category', value: 'test' }, overMB: 200, forMin: 1 })], true)).toBe(true);
    expect(needsClassification([rule({ kind: 'inactive', categories: ['back'], forHours: 1 })], true)).toBe(true);
    expect(needsClassification([rule({ kind: 'forecast', underMin: 3, includeApps: [] })], true)).toBe(false);
  });
});
