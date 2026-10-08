// Seconde revue de sécurité (piste I) : attribution de la croissance par instance (I-6), restauration après un saut
// d'horloge (m-1), tolérance aux ralentissements (m-2). Moteur pur : aucun signal possible ici.
import { describe, expect, test } from 'vitest';
import type { GroupClassification } from '../classify/classify';
import { group, node, proc } from '../classify/testFixtures';
import type { Category, Group, GroupKind, InstanceSummary, ProcInfo, ProcNode } from '../types';
import { emptyRuleState, evaluateRules, restoreRuleState, type EvalInput, type RuleDecision } from './engine';
import type { Rule, RuleCondition } from './types';

const GB = 1024 * 1024;
const MB = 1024;
const MIN = 60_000;
const H = 3600_000;

function mk(id: string, kind: GroupKind, roots: ProcNode[], label = id): Group {
  const g = group(id, kind, roots);
  const all: ProcInfo[] = [];
  const w = (n: ProcNode) => { all.push(n.proc); n.children.forEach(w); };
  roots.forEach(w);
  g.label = label;
  g.rssKB = all.reduce((a, p) => a + p.rssKB, 0);
  g.swapKB = 0;
  return g;
}
function inst(g: Group, root: ProcNode, category: Category, label: string, over: Partial<InstanceSummary> = {}): InstanceSummary {
  const procs: ProcInfo[] = [];
  const w = (n: ProcNode) => { procs.push(n.proc); n.children.forEach(w); };
  w(root);
  return {
    key: `${g.id}#${root.proc.pid}:${root.proc.startTicks}`, groupId: g.id, project: g.id, category, source: 'command', signature: label, label,
    rootPid: root.proc.pid, rootStartTicks: root.proc.startTicks, pids: procs.map((p) => p.pid), ports: [], ageSec: 100,
    rssKB: procs.reduce((a, p) => a + p.rssKB, 0), swapKB: 0, cpuPercent: 0, duplicate: false, protected: false, ...over,
  };
}
const cls = (entries: [Group, InstanceSummary[]][]) =>
  new Map<string, GroupClassification>(entries.map(([g, i]) => [g.id, { categories: [...new Set(i.map((x) => x.category))], instances: i, launcherPids: [] }]));
const rule = (condition: RuleCondition, over: Partial<Rule> = {}): Rule => ({ id: 'r-a', name: 'r', enabled: true, mode: 'active', createdAt: 0, condition, ...over });
const fires = (ds: RuleDecision[]) => ds.filter((d) => d.outcome === 'fire');
const key = (p: ProcInfo) => `${p.pid}:${p.startTicks}`;

/** Projet acme : vitest lancé par Claude (Warp → zsh → claude → zsh -c) et vite de l'utilisateur (Warp → zsh). */
function acmeWithClaude() {
  const sysd = proc('systemd', 'systemd --user', { pid: 500, ppid: 1 });
  const me = proc('node', 'node /x/out/main/recorder.js', { pid: 900, ppid: 500 });
  const warp = proc('warp', 'warp', { pid: 600, ppid: 500 });
  const zsh = proc('zsh', 'zsh', { pid: 601, ppid: 600 });
  const claude = proc('claude', 'claude', { pid: 610, ppid: 601 });
  const tool = proc('zsh', 'zsh -c vitest', { pid: 612, ppid: 610 });
  const vitest = proc('node', 'node vitest', { pid: 613, ppid: 612, rssKB: 6 * GB });
  const zsh2 = proc('zsh', 'zsh', { pid: 602, ppid: 600 });
  const vite = proc('node', 'node vite', { pid: 620, ppid: 602, rssKB: 0.4 * GB });
  const vitestN = node(vitest);
  const viteN = node(vite);
  const project = mk('project:/home/u/acme', 'project', [vitestN, viteN], 'acme');
  const groups = [
    mk('command:systemd', 'command', [node(sysd, node(me))]),
    mk('app:warp', 'app', [node(warp, node(zsh), node(zsh2))]),
    mk('claude', 'claude', [node(claude, node(tool))]),
    project,
  ];
  me.ppid = 500; zsh.ppid = 600; zsh2.ppid = 600; claude.ppid = 601; tool.ppid = 610; vitest.ppid = 612; vite.ppid = 602;
  const classification = cls([[project, [inst(project, vitestN, 'test', 'vitest', { launchedBy: 'claude' }), inst(project, viteN, 'front', 'vite')]]]);
  return { groups, classification, vitest, vite, project };
}

function evalTwice(over: Partial<EvalInput>) {
  const base: EvalInput = {
    now: 0, enabled: true, rules: [rule({ kind: 'forecast', underMin: 3, includeApps: [] })], groups: [], classification: null,
    forecast: { forecast: { etaMin: 1, decliningMinutes: 5 } as never, held: true }, procGrowthKB: null, inactive: null,
    isProtected: () => false, appRoot: null, currentUid: 1000, selfPid: 900, ...over,
  };
  const st = emptyRuleState();
  evaluateRules(base, st);
  return evaluateRules({ ...base, now: 31_000 }, st);
}

describe('I-6 : (c) attribue la croissance par instance', () => {
  test('C-att : le vitest lancé par Claude grossit de 3 Go → le vite de l’utilisateur n’est PAS tué, rien n’est visé', () => {
    const a = acmeWithClaude();
    const out = evalTwice({ groups: a.groups, classification: a.classification, procGrowthKB: new Map([[key(a.vitest), 3 * GB], [key(a.vite), 10 * MB]]) });
    expect(fires(out)).toEqual([]);
  });
  test('le vite de l’utilisateur grossit lui-même de 200 Mo → c’est lui qui est visé (croissance attribuable)', () => {
    const a = acmeWithClaude();
    const out = evalTwice({ groups: a.groups, classification: a.classification, procGrowthKB: new Map([[key(a.vitest), 3 * GB], [key(a.vite), 200 * MB]]) });
    expect(fires(out).map((d) => d.outcome === 'fire' && d.target.targets.map((t) => t.pid))).toEqual([[620]]);
  });
  test('instance contenant un processus refusé (protégé) → écartée entière, même si une autre partie grossit', () => {
    const root = proc('node', 'node server', { pid: 700, ppid: 1, rssKB: GB });
    const pg = proc('postgres', 'postgres', { pid: 701, ppid: 700, rssKB: GB });
    const rn = node(root, node(pg));
    const g = mk('project:/home/u/beta', 'project', [rn], 'beta');
    const out = evalTwice({
      groups: [g], classification: cls([[g, [inst(g, rn, 'back', 'server')]]]), isProtected: (n) => n === 'postgres',
      procGrowthKB: new Map([[key(root), 2 * GB], [key(pg), 0]]),
    });
    expect(fires(out)).toEqual([]);
  });
  test('la plus forte croissance attribuable ≥ 100 Mio gagne ; sous 100 Mio → rien ; sans croissance connue → rien', () => {
    const p1 = proc('node', 'node a', { pid: 701, ppid: 1, rssKB: 3 * GB });
    const p2 = proc('node', 'node b', { pid: 702, ppid: 1, rssKB: 1 * GB });
    const n1 = node(p1);
    const n2 = node(p2);
    const g = mk('project:/home/u/c', 'project', [n1, n2], 'c');
    const classification = cls([[g, [inst(g, n1, 'back', 'a'), inst(g, n2, 'front', 'b')]]]);
    const pick = (m: Map<string, number> | null) => fires(evalTwice({ groups: [g], classification, procGrowthKB: m })).map((d) => d.outcome === 'fire' && d.target.key);
    expect(pick(new Map([[key(p1), 150 * MB], [key(p2), 900 * MB]]))).toEqual([`${g.id}#702:${p2.startTicks}`]);
    expect(pick(new Map([[key(p1), 99 * MB], [key(p2), 99 * MB]]))).toEqual([]);
    expect(pick(null)).toEqual([]);
  });
  test('groupe de commande ou appli non cochée → jamais, même avec instance en croissance', () => {
    const p = proc('node', 'node x', { pid: 703, ppid: 1, rssKB: GB });
    const n = node(p);
    const g = mk('command:node', 'command', [n], 'node');
    expect(fires(evalTwice({ groups: [g], classification: cls([[g, [inst(g, n, 'unknown', 'x')]]]), procGrowthKB: new Map([[key(p), GB]]) }))).toEqual([]);
  });
});

describe('m-1 : un redémarrage ne libère jamais quota ni cooldown', () => {
  test('saut en avant de 2 h entre l’arrêt et le redémarrage : l’action d’il y a 2 min (ancienne heure) compte encore', () => {
    const lastSample = 50 * H; // dernière mesure enregistrée avant l'arrêt (ancienne heure)
    const wallNow = lastSample + 2 * H + 2 * MIN; // heure murale après le saut
    const st = restoreRuleState([{ ts: lastSample - MIN, type: 'rule_action', ruleId: 'r-a', result: 'sigterm' }], wallNow, 1000, lastSample);
    expect(st.lastFire.get('r-a')).toBe(1000 - MIN);
    expect(st.actions).toEqual([1000 - MIN]);
  });
  test('sans dernière mesure : référence = l’heure murale', () => {
    const st = restoreRuleState([{ ts: 10 * H - 30 * MIN, type: 'rule_action', ruleId: 'r-a', result: 'sigterm' }], 10 * H, 0);
    expect(st.actions).toEqual([-30 * MIN]);
  });
});

describe('m-2 : un ralentissement (horloges qui avancent ensemble) tolère 4 × l’intervalle', () => {
  const p = proc('node', 'node vitest', { pid: 700, ppid: 1, rssKB: 5 * GB });
  const g = mk('project:/home/u/acme', 'project', [node(p)], 'acme');
  const r = rule({ kind: 'memory', target: 'group', match: { by: 'name', value: 'acme' }, overMB: 4096, forMin: 5 });
  test('un tick retardé de 61 s chaque minute (intervalle 30 s) → la règle finit par agir', () => {
    const st = emptyRuleState();
    let n = 0;
    let t = 0;
    for (let k = 0; k < 12; k++) { // ~9 min : un seul déclenchement possible
      t += k % 2 ? 61_000 : 30_000;
      n += fires(evaluateRules({
        now: t, wallNow: t, maxGapMs: 120_000, maxSkewMs: 60_000, enabled: true, rules: [r], groups: [g], classification: null, forecast: null,
        procGrowthKB: null, inactive: null, isProtected: () => false, appRoot: null, currentUid: 1000, selfPid: 900,
      }, st)).length;
    }
    expect(n).toBe(1);
  });
  test('saut d’horloge murale (écart murale/monotone > 2 × intervalle) → la durée repart', () => {
    const st = emptyRuleState();
    const ev = (now: number, wallNow: number) => fires(evaluateRules({
      now, wallNow, maxGapMs: 120_000, maxSkewMs: 60_000, enabled: true, rules: [r], groups: [g], classification: null, forecast: null,
      procGrowthKB: null, inactive: null, isProtected: () => false, appRoot: null, currentUid: 1000, selfPid: 900,
    }, st)).length;
    ev(0, 0);
    expect(ev(30_000, 30_000 + 10 * MIN)).toBe(0);
    let n = 0;
    for (let s = 60_000; s < 30_000 + 5 * MIN; s += 30_000) n += ev(s, s + 10 * MIN);
    expect(n).toBe(0); // 5 min pas encore observées depuis le saut
    expect(ev(30_000 + 5 * MIN, 30_000 + 15 * MIN)).toBe(1);
  });
});
