// Condition système (anti-gel) sur la pression mémoire (PSI « full » avg10) : le gel du 2026-10-22 rejoué (mémoire utilisée
// sous 95 %, pression 55 % tenue), une vérification à la fois, jamais Claude ni ses serveurs MCP, conditions d'avant la
// pression muettes.
import { describe, expect, test } from 'vitest';
import { group, node, proc } from '../classify/testFixtures';
import type { Group, GroupKind, ProcInfo, ProcNode } from '../types';
import { emptyRuleState, evaluateRules, RULE_COOLDOWN_MS, SYSTEM_STUCK_MS, type EvalInput, type RuleDecision, type RuleState } from './engine';
import { RECOMMENDED_RULES, REC_ANTIGEL_ID } from './recommended';
import type { Rule } from './types';

const GB = 1024 * 1024;
const SEC = 1000;
const NM = '/home/u/demo/node_modules';
const NPX = '/home/u/.npm/_npx';

function mkGroup(id: string, kind: GroupKind, roots: ProcNode[], label = id): Group {
  const g = group(id, kind, roots);
  const all: ProcInfo[] = [];
  const walk = (n: ProcNode) => { all.push(n.proc); n.children.forEach(walk); };
  roots.forEach(walk);
  g.label = label;
  g.rssKB = all.reduce((s, p) => s + p.rssKB, 0);
  return g;
}

/**
 * Machine de 32 Gio pendant le gel. Projet « demo » : jest (1 Gio + 4 workers « MainThread » de 1,5 Gio = 7 Gio) et vitest
 * (0,5 Gio + 2 workers de 1 Gio = 2,5 Gio) lancés depuis zsh dans Warp, vite (8 Gio, Front). Session Claude (1,2 Gio) avec un
 * très gros serveur MCP (Playwright, 12 Gio, le plus gros processus de la machine), un petit (context7) et un vitest lancé
 * par son outil Bash (2 Gio, visable : accord de l'utilisateur du 2026-10-19). Chrome 4 Gio. `dead` : pids déjà morts.
 */
function world(dead: ReadonlySet<number> = new Set()) {
  const sysd = proc('systemd', 'systemd --user', { pid: 500, ppid: 1 });
  const self = proc('node', 'node /x/out/main/recorder.js', { pid: 900 });
  const warp = proc('warp', 'warp', { pid: 600 });
  const zshA = proc('zsh', 'zsh', { pid: 601 });
  const zshB = proc('zsh', 'zsh', { pid: 602 });
  const zshC = proc('zsh', 'zsh', { pid: 603 });
  const jest = proc('node', `node ${NM}/jest/bin/jest.js`, { pid: 700, startTicks: 7000, rssKB: 1 * GB });
  const jw = [701, 702, 703, 704].map((pid) => proc('MainThread', `node ${NM}/jest-worker/build/workers/processChild.js`, { pid, rssKB: 1.5 * GB }));
  const vit = proc('node', `node ${NM}/vitest/vitest.mjs run`, { pid: 720, startTicks: 7200, rssKB: 0.5 * GB });
  const vw = [721, 722].map((pid) => proc('MainThread', `node ${NM}/vitest/dist/workers/forks.js`, { pid, rssKB: 1 * GB }));
  const vite = proc('node', `node ${NM}/vite/bin/vite.js`, { pid: 830, rssKB: 8 * GB });
  const claude = proc('claude', 'claude', { pid: 800, rssKB: 1.2 * GB });
  const mcpBig = proc('node', `node ${NPX}/1a2b3c/node_modules/@playwright/mcp/cli.js`, { pid: 820, rssKB: 12 * GB, swapKB: 2 * GB });
  const mcpSmall = proc('node', `node ${NPX}/4d5e6f/node_modules/.bin/context7-mcp`, { pid: 821, rssKB: 0.3 * GB });
  const czsh = proc('zsh', '/bin/zsh -c source /home/u/.claude/shell-snapshots/snapshot-zsh.sh && npx vitest run', { pid: 801 });
  const cvit = proc('node', `node ${NM}/vitest/vitest.mjs run`, { pid: 810, startTicks: 8100, rssKB: 2 * GB });
  const chrome = proc('chrome', '/opt/google/chrome/chrome', { pid: 650, rssKB: 4 * GB });

  const keep = (n: ProcNode): ProcNode | null => (dead.has(n.proc.pid) ? null : { proc: n.proc, children: n.children.map(keep).filter((c): c is ProcNode => !!c) });
  const roots = (...ns: ProcNode[]) => ns.map(keep).filter((n): n is ProcNode => !!n);
  const jestN = node(jest, ...jw.map((w) => node(w)));
  const vitN = node(vit, ...vw.map((w) => node(w)));
  const viteN = node(vite);
  const cvitN = node(cvit);
  jest.ppid = 601;
  vite.ppid = 601;
  vit.ppid = 602;
  cvit.ppid = 801;
  const project = mkGroup('project:/home/u/demo', 'project', roots(jestN, vitN, viteN, cvitN), 'demo');
  const term = mkGroup('app:warp', 'app', roots(node(warp, node(zshA), node(zshB), node(zshC))), 'Warp');
  warp.ppid = 500;
  const claudeG = mkGroup('claude', 'claude', roots(node(claude, node(mcpBig), node(mcpSmall), node(czsh))), 'Claude');
  claude.ppid = 603;
  const browser = mkGroup('app:chrome', 'app', roots(node(chrome)), 'Chrome');
  chrome.ppid = 500;
  const svc = mkGroup('command:systemd', 'command', roots(node(sysd, node(self))), 'systemd');
  return { groups: [project, term, claudeG, browser, svc] };
}

const antigel = (over: Partial<Rule> = {}): Rule => ({ ...RECOMMENDED_RULES.find((r) => r.id === REC_ANTIGEL_ID)!, ...over });

/** Mémoire utilisée 90 % (sous le seuil de 95 % : comme pendant le gel), CPU 30 % sur 16 cœurs, PSI full `psi`. */
const sys = (psi: number | null | undefined, mem = 90, cpu = 30): EvalInput['system'] => ({
  memUsedPercent: mem, cpuPercent: cpu, memTotalKB: 32 * GB, cpuCount: 16, ...(psi === undefined ? {} : { psiFull10: psi }),
});

function input(over: Partial<EvalInput>): EvalInput {
  return {
    now: 0, enabled: true, rules: [antigel()], groups: [], classification: null, forecast: null, procGrowthKB: null, inactive: null,
    isProtected: () => false, appRoot: null, currentUid: 1000, selfPid: 900, system: null, ...over,
  };
}

const fires = (ds: RuleDecision[]) => ds.filter((d): d is Extract<RuleDecision, { outcome: 'fire' }> => d.outcome === 'fire');
const victim = (ds: RuleDecision[]) => fires(ds).map((d) => d.target.targets.map((t) => t.pid));

/** Évalue à `now` avec la PSI full `psi` (%), les pids de `dead` morts. */
const step = (st: RuleState, now: number, psi: number | null | undefined, dead: ReadonlySet<number> = new Set(), over: Partial<EvalInput> = {}) =>
  evaluateRules(input({ now, ...world(dead), system: sys(psi), ...over }), st);

const JEST = [700, 701, 702, 703, 704];
const VITEST = [720, 721, 722];

describe('pression mémoire : le gel rejoué', () => {
  test('PSI full 0 → 55 % tenue 25 s, mémoire utilisée 90 % : une victime (jest, le plus gros test), puis attente de sa mort avant la suivante', () => {
    const st = emptyRuleState();
    const dead = new Set<number>();
    // avant : PSI à 0 pendant 1 min
    for (let t = 0; t < 60 * SEC; t += 5 * SEC) expect(step(st, t, 0, dead)).toEqual([]);
    // étouffement dès 60 s : rien avant 20 s tenus
    for (let t = 60 * SEC; t < 80 * SEC; t += 5 * SEC) expect(step(st, t, 55, dead)).toEqual([]);
    const d = step(st, 80 * SEC, 55, dead);
    expect(victim(d)).toEqual([JEST]);
    const f = fires(d)[0]!;
    expect(f).toMatchObject({ ruleId: REC_ANTIGEL_ID, mode: 'active', trigger: 'pression mémoire 55 % depuis 20 s' });
    expect(f.target).toMatchObject({ label: 'jest (demo)', memKB: 7 * GB, verification: true });
    // 25 s tenus, jest toujours vivant : rien (une victime à la fois)
    expect(step(st, 85 * SEC, 55, dead)).toEqual([]);
    for (let t = 90 * SEC; t < 100 * SEC; t += 5 * SEC) expect(step(st, t, 60, dead)).toEqual([]);
    // jest mort : la suivante, toujours un test (vitest, 2,5 Gio), jamais vite (8 Gio) ni le serveur MCP (14 Gio)
    JEST.forEach((p) => dead.add(p));
    const d2 = step(st, 100 * SEC, 60, dead);
    expect(victim(d2)).toEqual([VITEST]);
    expect(fires(d2)[0]!.trigger).toBe('pression mémoire 60 % depuis 40 s');
    VITEST.forEach((p) => dead.add(p));
    // la pression retombe : plus rien, même si le vitest de Claude tourne encore
    for (let t = 105 * SEC; t < 10 * 60 * SEC; t += 5 * SEC) expect(step(st, t, 3, dead)).toEqual([]);
  });

  test('pression qui repasse sous le seuil : le compteur repart ; trou entre deux évaluations (veille) : aussi', () => {
    const st = emptyRuleState();
    step(st, 0, 55);
    step(st, 10 * SEC, 39.9);
    step(st, 15 * SEC, 55);
    expect(step(st, 30 * SEC, 55)).toEqual([]);
    expect(victim(step(st, 35 * SEC, 55))).toEqual([JEST]);
    const st2 = emptyRuleState();
    const gap = { maxGapMs: 20 * SEC };
    step(st2, 0, 55, new Set(), gap);
    step(st2, 10 * SEC, 55, new Set(), gap);
    expect(step(st2, 50 * SEC, 55, new Set(), gap)).toEqual([]); // 40 s sans évaluation : la tenue repart
    expect(step(st2, 65 * SEC, 55, new Set(), gap)).toEqual([]);
    expect(victim(step(st2, 70 * SEC, 55, new Set(), gap))).toEqual([JEST]);
  });

  test('PSI absente, illisible (null, NaN, Infinity négatif) ou noyau sans PSI : jamais tenue', () => {
    for (const psi of [undefined, null, Number.NaN, Number.NEGATIVE_INFINITY]) {
      const st = emptyRuleState();
      for (let t = 0; t <= 5 * 60 * SEC; t += 5 * SEC) expect(step(st, t, psi)).toEqual([]);
      expect(st.systemPsiSince.size).toBe(0);
    }
  });

  test('déclencheur : la mémoire d’abord, puis la pression, puis le CPU', () => {
    const st = emptyRuleState();
    const at = (t: number, mem: number, cpu: number) => evaluateRules(input({ now: t, ...world(), system: sys(70, mem, cpu) }), st);
    at(0, 99, 99);
    expect(fires(at(20 * SEC, 99, 99))[0]!.trigger).toBe('mémoire 99 % depuis 20 s');
    // CPU à 99 % depuis 0 s, pression à 70 % depuis 40 s : les deux tenues à 60 s, la pression est citée
    const st2 = emptyRuleState();
    const at2 = (t: number, psi: number) => evaluateRules(input({ now: t, ...world(), system: sys(psi, 50, 99) }), st2);
    for (let t = 0; t < 40 * SEC; t += 5 * SEC) expect(at2(t, 10)).toEqual([]);
    for (let t = 40 * SEC; t < 60 * SEC; t += 5 * SEC) expect(at2(t, 70)).toEqual([]);
    expect(fires(at2(60 * SEC, 70))[0]!.trigger).toBe('pression mémoire 70 % depuis 20 s');
  });
});

describe('pression mémoire : victimes', () => {
  test('jamais la session Claude, ni un très gros serveur MCP (le plus gros processus), ni le terminal, le bureau ou le service', () => {
    const st = emptyRuleState();
    const dead = new Set<number>();
    const got: number[][] = [];
    const skips: RuleDecision[] = [];
    for (let t = 0; t <= 10 * 60 * SEC; t += 5 * SEC) {
      const d = step(st, t, 80, dead);
      for (const v of victim(d)) {
        got.push(v);
        v.forEach((p) => dead.add(p));
      }
      skips.push(...d.filter((x) => x.outcome === 'skip'));
    }
    // jest (7 Gio), vitest (2,5 Gio), puis le vitest lancé par Claude (2 Gio) : rien d'autre, jamais
    expect(got).toEqual([JEST, VITEST, [810]]);
    for (const pid of [800, 820, 821, 801, 600, 601, 602, 603, 650, 830, 500, 900]) expect(got.flat()).not.toContain(pid);
    // il ne reste que des intouchables : « rien à arrêter », au plus une fois par cooldown, sans cible
    expect(skips.length).toBeGreaterThan(0);
    expect(skips.length).toBeLessThanOrEqual(Math.ceil((10 * 60 * SEC) / RULE_COOLDOWN_MS) + 1);
    for (const s of skips) expect(s).toMatchObject({ outcome: 'skip', reason: 'guard', target: null });
  });

  test('la victime doit peser (≥ 512 Mio et 5 % de la RAM) : un petit test sous pression n’est jamais arrêté', () => {
    const st = emptyRuleState();
    // il ne reste qu'un petit test (vitest de Claude réduit à 1 Gio, sous 5 % de 32 Gio) et des intouchables
    const dead = new Set([...JEST, ...VITEST]);
    const small = (over: Partial<EvalInput> = {}) => {
      const w = world(dead);
      for (const g of w.groups) for (const r of g.roots) if (r.proc.pid === 810) r.proc.rssKB = 1 * GB;
      return { ...w, ...over };
    };
    const out: RuleDecision[] = [];
    for (let t = 0; t <= 60 * SEC; t += 5 * SEC) out.push(...evaluateRules(input({ now: t, ...small(), system: sys(80) }), st));
    expect(fires(out)).toEqual([]);
  });

  test('victime qui ne meurt pas : la suivante seulement après SYSTEM_STUCK_MS, la bloquée n’est plus visée', () => {
    const st = emptyRuleState();
    step(st, 0, 80);
    expect(victim(step(st, 20 * SEC, 80))).toEqual([JEST]);
    for (let t = 25 * SEC; t < 20 * SEC + SYSTEM_STUCK_MS; t += 5 * SEC) expect(step(st, t, 80)).toEqual([]);
    expect(victim(step(st, 20 * SEC + SYSTEM_STUCK_MS, 80))).toEqual([VITEST]);
  });
});

describe('pression mémoire : compatibilité et état', () => {
  test('condition système perso d’avant la pression (sans ses champs) : jamais déclenchée par la pression', () => {
    const st = emptyRuleState();
    const rules = [antigel({ id: 'r-perso', name: 'perso', condition: { kind: 'system', memPercent: 95, memForSec: 15, cpuPercent: 95, cpuForSec: 60 } })];
    for (let t = 0; t <= 10 * 60 * SEC; t += 5 * SEC) expect(step(st, t, 90, new Set(), { rules })).toEqual([]);
    expect(st.systemPsiSince.size).toBe(0);
    // la mémoire, elle, déclenche toujours
    const st2 = emptyRuleState();
    evaluateRules(input({ now: 0, ...world(), rules, system: sys(90, 97) }), st2);
    expect(victim(evaluateRules(input({ now: 15 * SEC, ...world(), rules, system: sys(90, 97) }), st2))).toEqual([JEST]);
  });

  test('Simulation : « aurait arrêté » avec le déclencheur, aucune attente de la victime', () => {
    const st = emptyRuleState();
    const rules = [antigel({ mode: 'simulate' })];
    step(st, 0, 50, new Set(), { rules });
    const d = step(st, 20 * SEC, 50, new Set(), { rules });
    expect(fires(d)).toEqual([expect.objectContaining({ mode: 'simulate', trigger: 'pression mémoire 50 % depuis 20 s' })]);
    expect(st.systemPending.size).toBe(0);
  });

  test('règle retirée ou désactivée : sa tenue de pression est oubliée', () => {
    const st = emptyRuleState();
    step(st, 0, 80);
    expect(st.systemPsiSince.size).toBe(1);
    step(st, 5 * SEC, 80, new Set(), { rules: [antigel({ enabled: false })] });
    expect(st.systemPsiSince.size).toBe(0);
  });
});
