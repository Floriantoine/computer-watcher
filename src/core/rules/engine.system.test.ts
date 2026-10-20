// Condition système (anti-gel) : tenue mémoire ou CPU, choix de la victime parmi les vérifications, une à la fois.
import { describe, expect, test } from 'vitest';
import type { GroupClassification } from '../classify/classify';
import { group, node, proc } from '../classify/testFixtures';
import type { Category, Group, GroupKind, InstanceSummary, ProcInfo, ProcNode } from '../types';
import {
  emptyRuleState, evaluateRules, MAX_ACTIONS_PER_HOUR, memUsedPercent, needsClassification, RULE_COOLDOWN_MS, SYSTEM_SETTLE_MS, SYSTEM_STUCK_MS,
  type EvalInput, type RuleDecision, type RuleState,
} from './engine';
import { RECOMMENDED_RULES, REC_ANTIGEL_ID } from './recommended';
import type { Rule } from './types';

const GB = 1024 * 1024;
const SEC = 1000;

function mkGroup(id: string, kind: GroupKind, roots: ProcNode[], label = id): Group {
  const g = group(id, kind, roots);
  const all: ProcInfo[] = [];
  const walk = (n: ProcNode) => { all.push(n.proc); n.children.forEach(walk); };
  roots.forEach(walk);
  g.label = label;
  g.rssKB = all.reduce((s, p) => s + p.rssKB, 0);
  return g;
}

function inst(g: Group, root: ProcNode, category: Category, label: string, over: Partial<InstanceSummary> = {}): InstanceSummary {
  const procs: ProcInfo[] = [];
  const walk = (n: ProcNode) => { procs.push(n.proc); n.children.forEach(walk); };
  walk(root);
  return {
    key: `${g.id}#${root.proc.pid}:${root.proc.startTicks}`, groupId: g.id, project: g.id.replace(/^project:/, ''), category, source: 'command',
    signature: label, label, rootPid: root.proc.pid, rootStartTicks: root.proc.startTicks, pids: procs.map((p) => p.pid), ports: [],
    ageSec: 100, rssKB: procs.reduce((s, p) => s + p.rssKB, 0), swapKB: procs.reduce((s, p) => s + p.swapKB, 0), cpuPercent: 0,
    duplicate: false, protected: false, ...over,
  };
}

const NM = '/home/u/demo/node_modules';

/**
 * Projet « demo » : jest (3 Go + worker MainThread 0,5 Go) et eslint (2 Go) lancés depuis zsh dans warp ; `npm run
 * typecheck` → `sh -c tsc --noEmit` → tsc (comm MainThread, 4,5 Go) ; un jest de 1,5 Go lancé par Claude (visable : accord
 * de l'utilisateur du 2026-10-19) ; vite (8 Go, Front).
 * `alive` : pids présents (les autres sont morts).
 */
function world(alive: (pid: number) => boolean = () => true, over: { eslintName?: string } = {}) {
  const sysd = proc('systemd', 'systemd --user', { pid: 500, ppid: 1 });
  const self = proc('node', 'node /x/out/main/recorder.js', { pid: 900, ppid: 500 });
  const warp = proc('warp', 'warp', { pid: 600, ppid: 500 });
  const zshA = proc('zsh', 'zsh', { pid: 601 });
  const zshB = proc('zsh', 'zsh', { pid: 602 });
  const zshC = proc('zsh', 'zsh', { pid: 603 });
  const jest = proc('node', `node ${NM}/jest/bin/jest.js`, { pid: 700, startTicks: 7000, rssKB: 3 * GB });
  const worker = proc('MainThread', `node ${NM}/jest-worker/build/workers/processChild.js`, { pid: 701, startTicks: 7010, rssKB: 0.5 * GB });
  const npm = proc('npm run typech', 'npm run typecheck', { pid: 610, rssKB: 50_000 });
  const sh = proc('sh', 'sh -c tsc --noEmit', { pid: 611, rssKB: 1000 });
  const tsc = proc('MainThread', `node ${NM}/typescript/bin/tsc --noEmit`, { pid: 612, startTicks: 6120, rssKB: 4 * GB, swapKB: 0.5 * GB, cpuPercent: 300 });
  const eslint = proc(over.eslintName ?? 'MainThread', `node ${NM}/eslint/bin/eslint.js src`, { pid: 620, startTicks: 6200, rssKB: 2 * GB });
  const claude = proc('claude', 'claude', { pid: 800, ppid: 603 });
  const czsh = proc('zsh', '/bin/zsh -c jest', { pid: 801 });
  const cjest = proc('node', `node ${NM}/jest/bin/jest.js`, { pid: 810, startTicks: 8100, rssKB: 1.5 * GB });
  const vite = proc('node', `node ${NM}/vite/bin/vite.js`, { pid: 830, ppid: 601, rssKB: 8 * GB });

  const jestN = node(jest, node(worker));
  jest.ppid = 601;
  const tscN = node(tsc);
  const shN = node(sh, tscN);
  const npmN = node(npm, shN);
  npm.ppid = 602;
  const eslintN = node(eslint);
  eslint.ppid = 603;
  const cjestN = node(cjest);
  cjest.ppid = 801;
  const viteN = node(vite);
  const keep = (n: ProcNode): ProcNode | null => (alive(n.proc.pid) ? { proc: n.proc, children: n.children.map(keep).filter((c): c is ProcNode => !!c) } : null);
  const roots = [jestN, npmN, eslintN, cjestN, viteN].map(keep).filter((n): n is ProcNode => !!n);
  const project = mkGroup('project:/home/u/demo', 'project', roots, 'demo');
  const term = mkGroup('app:warp', 'app', [node(warp, node(zshA), node(zshB), node(zshC))], 'Warp');
  zshA.ppid = 600; zshB.ppid = 600; zshC.ppid = 600;
  const claudeG = mkGroup('claude', 'claude', [node(claude, node(czsh))], 'Claude');
  claude.ppid = 603; czsh.ppid = 800;
  const svc = mkGroup('command:systemd', 'command', [node(sysd, node(self))], 'systemd');
  self.ppid = 500;
  const byRoot = new Map(roots.map((r) => [r.proc.pid, r]));
  const insts: InstanceSummary[] = [];
  const add = (pid: number, cat: Category, label: string, o: Partial<InstanceSummary> = {}) => {
    const r = byRoot.get(pid);
    if (r) insts.push(inst(project, r, cat, label, o));
  };
  add(700, 'test', 'jest');
  add(610, 'unknown', 'npm run typecheck'); // tsc non reconnu par le classement : instance « npm » avec tout son sous-arbre
  add(620, 'unknown', 'eslint');
  add(810, 'test', 'jest', { launchedBy: 'claude' });
  add(830, 'front', 'vite');
  const classification = new Map<string, GroupClassification>([[project.id, { categories: [...new Set(insts.map((i) => i.category))], instances: insts, launcherPids: [] }]]);
  return { groups: [project, term, claudeG, svc], classification };
}

const antigel = (over: Partial<Rule> = {}): Rule => ({ ...RECOMMENDED_RULES.find((r) => r.id === REC_ANTIGEL_ID)!, ...over });

function input(over: Partial<EvalInput>): EvalInput {
  return {
    now: 0, enabled: true, rules: [antigel()], groups: [], classification: null, forecast: null, procGrowthKB: null, inactive: null,
    isProtected: () => false, appRoot: null, currentUid: 1000, selfPid: 900, system: null, ...over,
  };
}

const fires = (ds: RuleDecision[]) => ds.filter((d): d is Extract<RuleDecision, { outcome: 'fire' }> => d.outcome === 'fire');
const victim = (ds: RuleDecision[]) => fires(ds).map((d) => d.target.targets.map((t) => t.pid));

/** Évalue à `now` avec la mémoire `mem` % et le CPU `cpu` % ; `alive` : pids encore là. */
const step = (st: RuleState, now: number, mem: number | null, cpu: number | null, alive?: (pid: number) => boolean, over: Partial<EvalInput> = {}) => {
  const w = world(alive);
  return evaluateRules(input({ now, groups: w.groups, classification: w.classification, system: { memUsedPercent: mem, cpuPercent: cpu }, ...over }), st);
};

describe('condition système : tenue', () => {
  test('mémoire ≥ 95 % : rien avant 15 s, puis la plus grosse vérification (tsc, 4,5 Go, sans npm ni sh)', () => {
    const st = emptyRuleState();
    expect(step(st, 0, 96, 10)).toEqual([]);
    expect(step(st, 14 * SEC, 97, 10)).toEqual([]);
    const d = step(st, 15 * SEC, 96, 10);
    expect(victim(d)).toEqual([[612]]);
    const f = fires(d)[0]!;
    expect(f).toMatchObject({ mode: 'active', ruleId: REC_ANTIGEL_ID });
    expect(f.target.targets).toEqual([{ pid: 612, startTicks: 6120 }]);
    expect(f.target.memKB).toBe(4.5 * GB);
    expect(f.target.label).toBe('tsc (demo)');
    expect(f.trigger).toMatch(/^mémoire 96 %/);
  });

  test('mémoire qui repasse sous le seuil : le compteur repart', () => {
    const st = emptyRuleState();
    step(st, 0, 96, 10);
    step(st, 10 * SEC, 94, 10);
    step(st, 11 * SEC, 96, 10);
    expect(step(st, 25 * SEC, 96, 10)).toEqual([]);
    expect(victim(step(st, 26 * SEC, 96, 10))).toEqual([[612]]);
  });

  test('CPU ≥ 95 % pendant 60 s (mémoire basse) : déclenche ; une baisse remet à zéro', () => {
    const st = emptyRuleState();
    const cpu = (now: number, v: number) => {
      const w = world();
      return evaluateRules(input({ now, groups: w.groups, classification: w.classification, system: { memUsedPercent: 40, cpuPercent: v, cpuCount: 16 } }), st);
    };
    cpu(0, 99);
    cpu(30 * SEC, 50);
    cpu(31 * SEC, 99);
    expect(cpu(90 * SEC, 99)).toEqual([]);
    const d = cpu(91 * SEC, 99);
    expect(victim(d)).toEqual([[612]]);
    expect(fires(d)[0]!.trigger).toMatch(/^CPU 99 %/);
  });

  test('mesures absentes ou illisibles (null, NaN, Infinity négatif) : jamais tenue', () => {
    for (const [mem, cpu] of [[null, null], [Number.NaN, Number.NaN], [Number.NEGATIVE_INFINITY, null]] as const) {
      const st = emptyRuleState();
      for (let t = 0; t <= 600 * SEC; t += 5 * SEC) expect(step(st, t, mem, cpu)).toEqual([]);
    }
    const st = emptyRuleState();
    const w = world();
    for (let t = 0; t <= 120 * SEC; t += 5 * SEC) {
      expect(evaluateRules(input({ now: t, groups: w.groups, classification: w.classification, system: null }), st)).toEqual([]);
    }
  });

  test('sans classement : agit quand même (cibles reconnues à leur ligne de commande)', () => {
    const st = emptyRuleState();
    const w = world();
    evaluateRules(input({ now: 0, groups: w.groups, classification: null, system: { memUsedPercent: 99, cpuPercent: 10 } }), st);
    expect(victim(evaluateRules(input({ now: 15 * SEC, groups: w.groups, classification: null, system: { memUsedPercent: 99, cpuPercent: 10 } }), st))).toEqual([[612]]);
  });

  test('trou entre deux évaluations (veille) : la tenue repart', () => {
    const st = emptyRuleState();
    step(st, 0, 96, 10, undefined, { maxGapMs: 20 * SEC });
    step(st, 10 * SEC, 96, 10, undefined, { maxGapMs: 20 * SEC });
    // 40 s sans évaluation : trou
    expect(step(st, 50 * SEC, 96, 10, undefined, { maxGapMs: 20 * SEC })).toEqual([]);
    expect(step(st, 60 * SEC, 96, 10, undefined, { maxGapMs: 20 * SEC })).toEqual([]);
    expect(victim(step(st, 65 * SEC, 96, 10, undefined, { maxGapMs: 20 * SEC }))).toEqual([[612]]);
  });

  test('memUsedPercent : d’après MemAvailable ; meminfo incohérent → null', () => {
    expect(memUsedPercent({ memTotalKB: 1000, memAvailableKB: 50 })).toBe(95);
    expect(memUsedPercent({ memTotalKB: 1000, memAvailableKB: 2000 })).toBe(0);
    // ligne MemAvailable absente (parseMeminfo met 0) : inconnu, jamais « 100 % »
    expect(memUsedPercent({ memTotalKB: 1000, memAvailableKB: 0, memAvailableKnown: false })).toBeNull();
    for (const [t, a] of [[0, 0], [-5, 1], [Number.NaN, 1], [1000, -1], [1000, Number.NaN], [Number.POSITIVE_INFINITY, 1]]) {
      expect(memUsedPercent({ memTotalKB: t!, memAvailableKB: a! })).toBeNull();
    }
  });

  test('needsClassification : inutile pour l’anti-gel (lignes de commande)', () => {
    expect(needsClassification([antigel()])).toBe(false);
    expect(needsClassification([antigel({ enabled: false })])).toBe(false);
  });
});

describe('condition système : victimes', () => {
  test('ordre : tsc (4,5 Go) → jest (3,5 Go, instance entière) → eslint (2 Go) → jest de Claude (1,5 Go) ; jamais vite, jamais Claude ni son shell, jamais zsh/npm/sh', () => {
    const st = emptyRuleState();
    const dead = new Set<number>();
    const alive = (pid: number) => !dead.has(pid);
    const got: number[][] = [];
    let t = 0;
    step(st, t, 99, 99, alive);
    for (let i = 0; i < 6; i++) {
      t += 20 * SEC;
      const d = step(st, t, 99, 99, alive);
      for (const v of victim(d)) {
        got.push(v);
        v.forEach((p) => dead.add(p));
      }
    }
    expect(got).toEqual([[612], [700, 701], [620], [810]]);
    const all = got.flat();
    for (const pid of [600, 601, 602, 603, 610, 611, 800, 801, 830, 900, 500]) expect(all).not.toContain(pid);
  });

  test('plus rien à arrêter (seulement vite, un Front) : un « rien à arrêter » au plus par cooldown, aucun déclenchement', () => {
    const st = emptyRuleState();
    const alive = (pid: number) => ![612, 610, 611, 700, 701, 620, 810].includes(pid);
    const out: RuleDecision[] = [];
    for (let t = 0; t <= 10 * 60 * SEC; t += 5 * SEC) out.push(...step(st, t, 99, 99, alive));
    expect(fires(out)).toEqual([]);
    const skips = out.filter((d) => d.outcome === 'skip');
    expect(skips.length).toBe(2); // 0 + 5 min
    expect(skips[0]).toMatchObject({ reason: 'guard' }); // le jest de Claude, refusé par les garde-fous
  });

  test('processus protégé (liste protégée) : jamais visé, le suivant l’est', () => {
    const st = emptyRuleState();
    const run = (now: number, alive: (pid: number) => boolean) => {
      const x = world(alive, { eslintName: 'eslint' });
      return evaluateRules(input({ now, groups: x.groups, classification: x.classification, system: { memUsedPercent: 99, cpuPercent: 10 }, isProtected: (n) => n === 'eslint' }), st);
    };
    const dead = new Set([612, 610, 611, 700, 701, 810]);
    run(0, (p) => !dead.has(p));
    const d = run(15 * SEC, (p) => !dead.has(p));
    expect(victim(d)).toEqual([]);
    expect(d[0]).toMatchObject({ outcome: 'skip', reason: 'guard' });
  });

  test('une victime à la fois : rien tant que la précédente vit (moins de SYSTEM_STUCK_MS), ni avant SYSTEM_SETTLE_MS', () => {
    const st = emptyRuleState();
    step(st, 0, 99, 99);
    expect(victim(step(st, 15 * SEC, 99, 99))).toEqual([[612]]);
    // tsc toujours vivant : rien
    for (let t = 20 * SEC; t < 15 * SEC + SYSTEM_STUCK_MS; t += 5 * SEC) expect(step(st, t, 99, 99)).toEqual([]);
    // tsc mort tout de suite, mais délai de stabilisation
    const st2 = emptyRuleState();
    const gone = (p: number) => p !== 612;
    step(st2, 0, 99, 99);
    step(st2, 15 * SEC, 99, 99);
    expect(step(st2, 15 * SEC + SYSTEM_SETTLE_MS - 1, 99, 99, gone)).toEqual([]);
    expect(victim(step(st2, 15 * SEC + SYSTEM_SETTLE_MS, 99, 99, gone))).toEqual([[700, 701]]);
  });

  test('victime morte et condition retombée : rien de plus', () => {
    const st = emptyRuleState();
    const gone = (p: number) => p !== 612;
    step(st, 0, 99, 10);
    step(st, 15 * SEC, 99, 10);
    for (let t = 20 * SEC; t < 120 * SEC; t += 5 * SEC) expect(step(st, t, 80, 10, gone)).toEqual([]);
  });

  test('victime qui ne meurt pas (signal refusé) : écartée après SYSTEM_STUCK_MS, jamais revisée tant qu’elle vit', () => {
    const st = emptyRuleState();
    step(st, 0, 99, 99);
    expect(victim(step(st, 15 * SEC, 99, 99))).toEqual([[612]]);
    const t1 = 15 * SEC + SYSTEM_STUCK_MS;
    expect(victim(step(st, t1, 99, 99))).toEqual([[700, 701]]);
    const gone = (p: number) => p !== 700 && p !== 701;
    expect(victim(step(st, t1 + SYSTEM_SETTLE_MS, 99, 99, gone))).toEqual([[620]]);
    // tsc encore vivant, eslint et le jest de Claude morts : tsc n'est plus visé ; il ne reste rien
    const gone2 = (p: number) => ![700, 701, 620, 810].includes(p);
    const d = step(st, t1 + 2 * SYSTEM_SETTLE_MS, 99, 99, gone2);
    expect(victim(d)).toEqual([]);
  });

  test('anti-boucle : au plus MAX_ACTIONS_PER_HOUR victimes par heure, puis pause', () => {
    const st = emptyRuleState();
    let n = 0;
    let quota = 0;
    for (let t = 0; t < 3600 * SEC; t += 20 * SEC) {
      // les vérifications réapparaissent sans fin (relancées par une boucle)
      const w = world();
      const d = evaluateRules(input({ now: t, groups: w.groups, classification: w.classification, system: { memUsedPercent: 99, cpuPercent: 99 } }), st);
      n += fires(d).length;
      quota += d.filter((x) => x.outcome === 'skip' && x.reason === 'hourly-quota').length;
      // la victime vient de mourir : on fait comme si un nouveau processus avait pris sa place
      st.systemPending.forEach((p) => { p.keys = []; });
    }
    expect(n).toBe(MAX_ACTIONS_PER_HOUR);
    expect(quota).toBe(1);
  });
});

describe('condition système : Simulation', () => {
  test('mode simulate : décision « simulate », cooldown habituel (pas d’attente de la victime), même victime', () => {
    const st = emptyRuleState();
    const rules = [antigel({ mode: 'simulate' })];
    step(st, 0, 99, 10, undefined, { rules });
    const d = step(st, 15 * SEC, 99, 10, undefined, { rules });
    expect(fires(d)).toHaveLength(1);
    expect(fires(d)[0]).toMatchObject({ mode: 'simulate' });
    expect(st.systemPending.size).toBe(0);
    for (let t = 20 * SEC; t < 15 * SEC + RULE_COOLDOWN_MS; t += 30 * SEC) {
      expect(fires(step(st, t, 99, 10, undefined, { rules }))).toEqual([]);
    }
    expect(victim(step(st, 15 * SEC + RULE_COOLDOWN_MS, 99, 10, undefined, { rules }))).toEqual([[612]]);
  });

  test('règle retirée ou désactivée : son état (tenue, victime en cours) est oublié', () => {
    const st = emptyRuleState();
    step(st, 0, 99, 99);
    step(st, 15 * SEC, 99, 99);
    expect(st.systemPending.size).toBe(1);
    step(st, 20 * SEC, 99, 99, undefined, { rules: [antigel({ enabled: false })] });
    expect(st.systemPending.size).toBe(0);
    expect(st.systemMemSince.size).toBe(0);
    expect(st.systemCpuSince.size).toBe(0);
  });
});

describe('condition système : workers « MainThread » rangés à part', () => {
  /**
   * Comme le gel du 15/10 : les processus Node au comm « MainThread » (workers de jest, tsc, eslint) ne sont pas des
   * outils de dev pour le regroupement : ils forment un groupe de commande « MainThread », hors du projet.
   */
  function mainThreadWorld() {
    const sysd = proc('systemd', 'systemd --user', { pid: 500, ppid: 1 });
    const self = proc('node', 'node /x/out/main/recorder.js', { pid: 900, ppid: 500 });
    const warp = proc('warp', 'warp', { pid: 600, ppid: 500 });
    const zsh = proc('zsh', 'zsh', { pid: 601, ppid: 600 });
    const jest = proc('node', `node ${NM}/jest/bin/jest.js`, { pid: 700, ppid: 601, rssKB: 0.3 * GB });
    const w1 = proc('MainThread', `node ${NM}/jest-worker/build/workers/processChild.js`, { pid: 701, ppid: 700, rssKB: 2.5 * GB });
    const w2 = proc('MainThread', `node ${NM}/jest-worker/build/workers/processChild.js`, { pid: 702, ppid: 700, rssKB: 2.5 * GB });
    const tsc = proc('MainThread', `node ${NM}/typescript/bin/tsc --noEmit`, { pid: 710, ppid: 601, rssKB: 4 * GB });
    const claude = proc('claude', 'claude', { pid: 800, ppid: 601 });
    const czsh = proc('zsh', '/bin/zsh -c tsc', { pid: 801, ppid: 800 });
    const ctsc = proc('MainThread', `node ${NM}/typescript/bin/tsc --noEmit`, { pid: 810, ppid: 801, rssKB: 9 * GB });
    const jestN = { proc: jest, children: [] };
    const project = mkGroup('project:/home/u/demo', 'project', [jestN], 'demo');
    const mt = mkGroup('command:MainThread', 'command', [{ proc: w1, children: [] }, { proc: w2, children: [] }, { proc: tsc, children: [] }, { proc: ctsc, children: [] }], 'MainThread');
    const term = mkGroup('app:warp', 'app', [{ proc: warp, children: [{ proc: zsh, children: [] }] }], 'Warp');
    const claudeG = mkGroup('claude', 'claude', [{ proc: claude, children: [{ proc: czsh, children: [] }] }], 'Claude');
    const svc = mkGroup('command:systemd', 'command', [{ proc: sysd, children: [{ proc: self, children: [] }] }], 'systemd');
    // le groupe « MainThread » entier est une seule instance (groupe non-projet), de catégorie inconnue
    const mtInst = { ...inst(mt, mt.roots[0]!, 'unknown', 'MainThread'), pids: [701, 702, 710, 810] };
    const classification = new Map<string, GroupClassification>([
      [project.id, { categories: ['test'], instances: [inst(project, jestN, 'test', 'jest')], launcherPids: [] }],
      [mt.id, { categories: ['unknown'], instances: [mtInst], launcherPids: [] }],
    ]);
    return { groups: [project, mt, term, claudeG, svc], classification };
  }

  test('le tsc lancé par Claude (9 Go) d’abord, puis jest et ses workers (5,3 Go), puis tsc (4 Go) ; jamais Claude, son shell, ni le groupe MainThread entier', () => {
    const st = emptyRuleState();
    const w = mainThreadWorld();
    const run = (now: number, dead: number[] = []) => {
      const groups = w.groups.map((g) => ({ ...g, roots: g.roots.filter((r) => !dead.includes(r.proc.pid)) }));
      return evaluateRules(input({ now, groups, classification: w.classification, system: { memUsedPercent: 99, cpuPercent: 99 } }), st);
    };
    run(0);
    const d0 = run(15 * SEC);
    expect(victim(d0)).toEqual([[810]]);
    expect(fires(d0)[0]!.target.verification).toBe(true);
    const d1 = run(30 * SEC, [810]);
    expect(victim(d1)).toEqual([[700, 701, 702]]);
    expect(fires(d1)[0]!.target.memKB).toBe(5.3 * GB);
    expect(fires(d1)[0]!.target.label).toBe('jest (demo)');
    const d2 = run(45 * SEC, [810, 700, 701, 702]);
    expect(victim(d2)).toEqual([[710]]);
    expect(fires(d2)[0]!.target.label).toBe('tsc');
    const d3 = run(60 * SEC, [810, 700, 701, 702, 710]);
    expect(victim(d3)).toEqual([]);
    expect(d3[0]).toMatchObject({ outcome: 'skip', reason: 'guard' });
    for (const d of [d0, d1, d2]) for (const pid of [800, 801, 601, 600]) expect(victim(d).flat()).not.toContain(pid);
  });
});

describe('condition système : groupe de commande classé Test d’après sa racine', () => {
  test('« MainThread » dont la racine est vitest : seulement vitest et ses descendants, jamais un serveur voisin', () => {
    const vit = proc('MainThread', `node ${NM}/vitest/vitest.mjs run`, { pid: 720, ppid: 1, rssKB: 1 * GB });
    const vw = proc('MainThread', `node ${NM}/vitest/dist/workers/forks.js`, { pid: 721, ppid: 720, rssKB: 1 * GB });
    const srv = proc('MainThread', `node ${NM}/next/dist/server/next-server.js`, { pid: 730, ppid: 1, rssKB: 6 * GB });
    const mt = mkGroup('command:MainThread', 'command', [{ proc: vit, children: [{ proc: vw, children: [] }] }, { proc: srv, children: [] }], 'MainThread');
    const one = { ...inst(mt, mt.roots[0]!, 'test', 'vitest'), pids: [720, 721, 730] };
    const classification = new Map<string, GroupClassification>([[mt.id, { categories: ['test'], instances: [one], launcherPids: [] }]]);
    const st = emptyRuleState();
    const run = (now: number) => evaluateRules(input({ now, groups: [mt], classification, system: { memUsedPercent: 99, cpuPercent: 10 } }), st);
    run(0);
    const d = run(15 * SEC);
    expect(victim(d)).toEqual([[720, 721]]);
    expect(fires(d)[0]!.target.label).toBe('vitest');
  });
});

describe('revue de sécurité', () => {
  const sysd = () => proc('systemd', 'systemd --user', { pid: 500, ppid: 1 });
  const evalAt = (st: RuleState, now: number, groups: Group[], system: EvalInput['system'], rules = [antigel()]) =>
    evaluateRules(input({ now, groups, classification: null, system, rules }), st);

  test('I-1 : orchestrateur non reconnu (python run_all) avec pytest, uvicorn et postgres : seulement pytest', () => {
    const run = proc('python3', 'python3 tools/run_all.py', { pid: 530, ppid: 500, rssKB: 50_000 });
    const pyt = proc('python3', 'python3 -m pytest', { pid: 540, rssKB: 3 * GB });
    const uvi = proc('python3', 'python3 -m uvicorn app.main:app', { pid: 550, rssKB: 1 * GB });
    const pg = proc('postgres', 'postgres -D /var/db', { pid: 560, rssKB: 1 * GB });
    const project = mkGroup('project:/home/u/demo', 'project', [node(run, node(pyt), node(uvi))], 'demo');
    const pgG = mkGroup('command:postgres', 'command', [{ proc: pg, children: [] }], 'postgres');
    pg.ppid = 530;
    const sv = mkGroup('command:systemd', 'command', [node(sysd())], 'systemd');
    const st = emptyRuleState();
    evalAt(st, 0, [project, pgG, sv], { memUsedPercent: 99, cpuPercent: 10 });
    expect(victim(evalAt(st, 15 * SEC, [project, pgG, sv], { memUsedPercent: 99, cpuPercent: 10 }))).toEqual([[540]]);
  });

  test('I-2 : Node ≥ 24 (comm MainThread) : jest rangé dans le terminal (groupe d’appli) est visé, pas le terminal', () => {
    const warp = proc('warp', 'warp', { pid: 600, ppid: 500 });
    const zsh = proc('zsh', 'zsh', { pid: 601 });
    const jest = proc('MainThread', `node ${NM}/jest/bin/jest.js`, { pid: 700, rssKB: 2 * GB });
    const app = mkGroup('app:warp', 'app', [node(warp, node(zsh, node(jest)))], 'Warp');
    const sv = mkGroup('command:systemd', 'command', [node(sysd())], 'systemd');
    const st = emptyRuleState();
    evalAt(st, 0, [app, sv], { memUsedPercent: 99, cpuPercent: 10 });
    const d = evalAt(st, 15 * SEC, [app, sv], { memUsedPercent: 99, cpuPercent: 10 });
    expect(victim(d)).toEqual([[700]]);
    expect(fires(d)[0]!.target.label).toBe('jest');
  });

  test('I-4 : la victime doit peser — mémoire : < 512 Mio ou < 5 % de la RAM, jamais ; CPU : < 10 % de la machine, jamais', () => {
    const lint = proc('MainThread', `node ${NM}/eslint/bin/eslint.js .`, { pid: 620, ppid: 500, rssKB: 80_000, cpuPercent: 0 });
    const g = mkGroup('command:MainThread', 'command', [{ proc: lint, children: [] }], 'MainThread');
    const sv = mkGroup('command:systemd', 'command', [node(sysd())], 'systemd');
    // mémoire pleine, eslint de 80 Mo : rien à arrêter
    const st = emptyRuleState();
    evalAt(st, 0, [g, sv], { memUsedPercent: 99, cpuPercent: 10, memTotalKB: 32 * GB });
    const d = evalAt(st, 15 * SEC, [g, sv], { memUsedPercent: 99, cpuPercent: 10, memTotalKB: 32 * GB });
    expect(fires(d)).toEqual([]);
    expect(d[0]).toMatchObject({ outcome: 'skip', reason: 'guard', target: null });
    // 1 Gio sur 32 Gio : sous 5 % de la RAM
    lint.rssKB = 1 * GB;
    const st2 = emptyRuleState();
    evalAt(st2, 0, [g, sv], { memUsedPercent: 99, cpuPercent: 10, memTotalKB: 32 * GB });
    expect(fires(evalAt(st2, 15 * SEC, [g, sv], { memUsedPercent: 99, cpuPercent: 10, memTotalKB: 32 * GB }))).toEqual([]);
    // 2 Gio : au-dessus des deux seuils
    lint.rssKB = 2 * GB;
    expect(victim(evalAt(st2, 20 * SEC, [g, sv], { memUsedPercent: 99, cpuPercent: 10, memTotalKB: 32 * GB }))).toEqual([[620]]);
    // CPU saturé par autre chose, eslint gros mais inactif : rien ; puis à 2 cœurs sur 16 (12,5 %) : visé
    const st3 = emptyRuleState();
    const cpu = (now: number) => evalAt(st3, now, [g, sv], { memUsedPercent: 40, cpuPercent: 99, cpuCount: 16 });
    cpu(0);
    expect(fires(cpu(60 * SEC))).toEqual([]);
    lint.cpuPercent = 200;
    expect(victim(cpu(65 * SEC))).toEqual([[620]]);
    // nombre de cœurs inconnu : jamais par le CPU
    const st4 = emptyRuleState();
    evalAt(st4, 0, [g, sv], { memUsedPercent: 40, cpuPercent: 99 });
    expect(fires(evalAt(st4, 60 * SEC, [g, sv], { memUsedPercent: 40, cpuPercent: 99 }))).toEqual([]);
  });

  test('I-6 : deux règles système Actives : une seule victime à la fois en tout', () => {
    const st = emptyRuleState();
    const rules = [antigel(), antigel({ id: 'r-copie', name: 'copie' })];
    step(st, 0, 99, 10, undefined, { rules });
    const d = step(st, 15 * SEC, 99, 10, undefined, { rules });
    expect(fires(d)).toHaveLength(1);
    for (let t = 20 * SEC; t < 15 * SEC + SYSTEM_STUCK_MS; t += 5 * SEC) expect(fires(step(st, t, 99, 10, undefined, { rules }))).toEqual([]);
  });
});
