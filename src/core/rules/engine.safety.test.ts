// Revue de sécurité de la piste I : cas adverses (horloge, mise en veille, bruit de croissance, démons de session).
// Moteur pur : aucun signal possible ici. `now` = horloge monotone, `wallNow` = horloge murale.
import { describe, expect, test, vi } from 'vitest';
import { group, node, proc } from '../classify/testFixtures';
import type { GroupClassification } from '../classify/classify';
import type { Group, GroupKind, InstanceSummary, ProcInfo, ProcNode } from '../types';
import { emptyRuleState, evaluateRules, FORECAST_MIN_GROWTH_KB, restoreRuleState, type EvalInput, type RuleDecision } from './engine';
import { isNeverKillName } from './neverKill';
import type { Rule, RuleCondition } from './types';

const GB = 1024 * 1024;
const MB = 1024;
const MIN = 60_000;
const H = 3600_000;
const T = 100 * H;

function mkGroup(id: string, kind: GroupKind, roots: ProcNode[], label = id): Group {
  const g = group(id, kind, roots);
  const all: ProcInfo[] = [];
  const walk = (n: ProcNode) => { all.push(n.proc); n.children.forEach(walk); };
  roots.forEach(walk);
  g.label = label;
  g.rssKB = all.reduce((s, p) => s + p.rssKB, 0);
  g.swapKB = 0;
  return g;
}
const rule = (condition: RuleCondition, over: Partial<Rule> = {}): Rule => ({ id: 'r-a', name: 'r', enabled: true, mode: 'active', createdAt: 0, condition, ...over });
const input = (over: Partial<EvalInput>): EvalInput => ({
  now: 0, enabled: true, rules: [], groups: [], classification: null, forecast: null, procGrowthKB: null, inactive: null,
  isProtected: () => false, appRoot: null, currentUid: 1000, selfPid: 900, ...over,
});
const fires = (ds: RuleDecision[]) => ds.filter((d) => d.outcome === 'fire');
function world(extra: Group[]) {
  const s = proc('systemd', 'systemd --user', { pid: 500, ppid: 1 });
  const me = proc('node', 'node /x/out/main/recorder.js', { pid: 900, ppid: 500 });
  return [mkGroup('command:systemd', 'command', [node(s, node(me))], 'systemd'), ...extra];
}
function project(id = 'acme', pid = 700, gb = 5, kind: GroupKind = 'project') {
  const v = proc('node', 'node vitest', { pid, ppid: 500, startTicks: pid * 10, rssKB: gb * GB });
  return mkGroup(kind === 'project' ? `project:/home/u/${id}` : kind === 'app' ? `app:${id}` : `command:${id}`, kind, [node(v)], id);
}
/** Une instance par groupe (sa racine) et la croissance de son processus : attribution par instance. */
function attribute(groups: Group[], growth: [string, number][]) {
  const m = new Map(growth);
  const classification = new Map<string, GroupClassification>();
  const procGrowthKB = new Map<string, number>();
  for (const g of groups) {
    const p = g.roots[0]?.proc;
    if (!p || !m.has(g.id)) continue;
    const i: InstanceSummary = {
      key: `${g.id}#${p.pid}:${p.startTicks}`, groupId: g.id, project: g.id, category: 'back', source: 'command', signature: g.label, label: g.label,
      rootPid: p.pid, rootStartTicks: p.startTicks, pids: [p.pid], ports: [], ageSec: 100, rssKB: p.rssKB, swapKB: 0, cpuPercent: 0, duplicate: false, protected: false,
    };
    classification.set(g.id, { categories: ['back'], instances: [i], launcherPids: [] });
    procGrowthKB.set(`${p.pid}:${p.startTicks}`, m.get(g.id)!);
  }
  return { classification, procGrowthKB };
}
const memRule = (forMin = 1, over: Partial<Rule> = {}) => rule({ kind: 'memory', target: 'group', match: { by: 'name', value: 'acme' }, overMB: 4096, forMin }, over);

describe('I-1 : quotas, cooldown et pause échouent fermés', () => {
  test('E1a horloge qui recule : pas de 2ᵉ déclenchement dans les 5 min (cooldown)', () => {
    const groups = world([project()]);
    const st = emptyRuleState();
    const ev = (now: number) => fires(evaluateRules(input({ now, rules: [memRule()], groups }), st)).length;
    ev(T);
    expect(ev(T + MIN)).toBe(1);
    ev(T - 2 * H);
    expect(ev(T - 2 * H + MIN)).toBe(0);
    expect(ev(T - 2 * H + 3 * MIN)).toBe(0);
  });
  test('E1b horloge qui recule : le quota horaire (10) n’est pas oublié', () => {
    const groups = world([project()]);
    const r = memRule(1, { id: 'r-b' });
    const st = emptyRuleState();
    st.actions = Array.from({ length: 10 }, (_, i) => T - i * 1000);
    evaluateRules(input({ now: T - 2 * H, rules: [r], groups }), st);
    const jumped = evaluateRules(input({ now: T - 2 * H + MIN, rules: [r], groups }), st);
    expect(jumped[0]).toMatchObject({ outcome: 'skip', reason: 'hourly-quota' });
  });
  test('E1c horloge qui recule : la pause de quota n’est pas levée', () => {
    const groups = world([project()]);
    const st = emptyRuleState();
    st.pausedUntil.set('r-a', T + H);
    evaluateRules(input({ now: T - 2 * H, rules: [memRule()], groups }), st);
    expect(st.pausedUntil.get('r-a')).toBe(T + H);
    expect(evaluateRules(input({ now: T - 2 * H + 10 * MIN, rules: [memRule()], groups }), st)).toEqual([]);
  });
  test('restoreRuleState : un événement daté dans le futur compte comme « maintenant » (horloge monotone)', () => {
    const wall = 10 * H;
    const mono = 5000;
    const st = restoreRuleState(
      [
        { ts: wall + 2 * H, type: 'rule_action', ruleId: 'r-a', result: 'sigterm' },
        { ts: wall - 10 * MIN, type: 'rule_action', ruleId: 'r-b', result: 'sigterm' },
        { ts: wall + H, type: 'rule_action', ruleId: 'r-c', result: 'quota' },
        { ts: wall - 2 * H, type: 'rule_action', ruleId: 'r-d', result: 'sigterm' },
      ],
      wall,
      mono,
    );
    expect(st.lastFire.get('r-a')).toBe(mono);
    expect(st.lastFire.get('r-b')).toBe(mono - 10 * MIN);
    expect(st.actions).toEqual([mono - 10 * MIN, mono]);
    expect(st.pausedUntil.get('r-c')).toBe(mono + H);
    expect(st.lastFire.has('r-d')).toBe(false);
  });
});

describe('I-2 : la durée repart après un trou entre deux échantillons', () => {
  test('E2 mise en veille (horloge murale +40 min, monotone +5 s) → pas de déclenchement immédiat', () => {
    const groups = world([project()]);
    const st = emptyRuleState();
    const ev = (now: number, wallNow: number) => fires(evaluateRules(input({ now, wallNow, maxGapMs: 10_000, rules: [memRule(5)], groups }), st)).length;
    expect(ev(T, T)).toBe(0);
    expect(ev(T + 5000, T + 40 * MIN)).toBe(0);
    // le compte repart : 5 min observées à intervalle régulier après le réveil
    let n = 0;
    for (let s = 5; s <= 5 * 60 + 5; s += 5) n += ev(T + s * 1000 + 5000, T + 40 * MIN + s * 1000);
    expect(n).toBe(1);
  });
  test('saut en avant de l’horloge monotone (> 2 × intervalle) → la durée repart', () => {
    const groups = world([project()]);
    const st = emptyRuleState();
    const ev = (now: number) => fires(evaluateRules(input({ now, maxGapMs: 10_000, rules: [memRule(5)], groups }), st)).length;
    ev(T);
    expect(ev(T + 40 * MIN)).toBe(0);
  });
  test('prévision tenue : 30 s d’observation continue exigées après un trou', () => {
    const g = project('acme', 700, 1);
    const groups = world([g]);
    const st = emptyRuleState();
    const fc = { forecast: { etaMin: 1, decliningMinutes: 5 } as never, held: true };
    const r = rule({ kind: 'forecast', underMin: 3, includeApps: [] });
    const ev = (now: number, wallNow: number) =>
      fires(evaluateRules(input({ now, wallNow, maxGapMs: 10_000, rules: [r], groups, forecast: fc, ...attribute(groups, [[g.id, GB]]) }), st)).length;
    expect(ev(T, T)).toBe(0);
    expect(ev(T + 5000, T + H)).toBe(0); // réveil : le compte repart à T + 5 s
    let firstFire: number | null = null;
    for (let k = 1; k <= 12 && firstFire === null; k++) if (ev(T + 5000 + k * 5000, T + H + k * 5000)) firstFire = k * 5000;
    expect(firstFire).toBe(30_000);
  });
  test('inactivité : aucun appel ni déclenchement tant que la fenêtre contient un trou', () => {
    const p = proc('node', 'node server.js', { pid: 950, ppid: 500, startTicks: 9500, ageSec: 3 * 86400, rssKB: GB });
    const n = node(p);
    const g = mkGroup('project:/home/u/acme', 'project', [n], 'acme');
    const classification = new Map([[g.id, { categories: ['back' as const], instances: [{
      key: `${g.id}#950:9500`, groupId: g.id, project: g.id, category: 'back' as const, source: 'command' as const, signature: 's', label: 's', rootPid: 950,
      rootStartTicks: 9500, pids: [950], ports: [], ageSec: 3 * 86400, rssKB: GB, swapKB: 0, cpuPercent: 0, duplicate: false, protected: false,
    }], launcherPids: [] }]]);
    const groups = world([g]);
    const inactive = vi.fn(() => new Set<string>());
    const r = rule({ kind: 'inactive', categories: ['back'], forHours: 1 });
    const st = emptyRuleState();
    const ev = (now: number, wallNow: number) => evaluateRules(input({ now, wallNow, maxGapMs: 10_000, rules: [r], groups, classification, inactive }), st);
    ev(T, T);
    expect(inactive).toHaveBeenCalledTimes(1);
    st.lastFire.clear();
    st.actions = [];
    ev(T + 5000, T + 30 * MIN); // veille de 30 min
    let firstCallAfter: number | null = null;
    let fired = 0;
    for (let sec = 5; sec <= 3600 + 120; sec += 5) {
      const d = ev(T + 5000 + sec * 1000, T + 30 * MIN + sec * 1000);
      if (firstCallAfter === null && inactive.mock.calls.length > 1) firstCallAfter = sec;
      fired += fires(d).length;
    }
    // pas d'évaluation tant que l'heure observée contient le trou ; ensuite, évaluée et déclenchée une fois
    expect(firstCallAfter).toBeGreaterThanOrEqual(3600);
    expect(fired).toBe(1);
  });
});

describe('I-3 : (c) seulement une vraie croissance (≥ 100 Mio), classée par croissance', () => {
  const fc = { forecast: { etaMin: 2, decliningMinutes: 4 } as never, held: true };
  const r = rule({ kind: 'forecast', underMin: 3, includeApps: [] });
  const evalWith = (groups: Group[], growth: [string, number][]) => {
    const st = emptyRuleState();
    evaluateRules(input({ now: 0, rules: [r], groups, forecast: fc, ...attribute(groups, growth) }), st);
    return evaluateRules(input({ now: 30_000, rules: [r], groups, forecast: fc, ...attribute(groups, growth) }), st);
  };
  test('E3 bruit : +4 Ko ne compte pas ; le vrai coupable (+2 Go) est visé', () => {
    const big = project('big', 1200, 3);
    const culprit = project('acme', 700, 0.6);
    const out = evalWith(world([big, culprit]), [[big.id, 4], [culprit.id, 2 * GB]]);
    expect(fires(out).map((d) => d.outcome === 'fire' && d.target.groupKey)).toEqual([culprit.id]);
  });
  test('classement par croissance puis par taille', () => {
    const a = project('a', 1001, 3);
    const b = project('b', 1002, 6);
    const c = project('c', 1003, 9);
    const out = evalWith(world([a, b, c]), [[a.id, 2 * GB], [b.id, 500 * MB], [c.id, 2 * GB]]);
    expect(fires(out)[0]).toMatchObject({ target: { groupKey: c.id } }); // même croissance que A, plus gros
  });
  test('rien ne grossit d’au moins 100 Mio → rien', () => {
    const a = project('a', 1001, 3);
    expect(evalWith(world([a]), [[a.id, FORECAST_MIN_GROWTH_KB - 1]])).toEqual([]);
    expect(FORECAST_MIN_GROWTH_KB).toBe(100 * MB);
  });
});

describe('I-4 : démons de session jamais tués ; (c) seulement projets par défaut', () => {
  test('E4 noms réels (tronqués à 15 caractères) tous couverts', () => {
    const names = ['startplasma-way', 'plasma_session', 'kscreenlocker_g', 'ksecretd', 'kwalletd6', 'polkit-kde-auth', 'kglobalacceld',
      'org_kde_powerde', 'kactivitymanage', 'krunner', 'xdg-permission-', 'xdg-document-po', 'at-spi-bus-laun', 'at-spi2-registr', 'dconf-service',
      'gpg-agent', 'ssh-agent', 'kwin_killer_hel', 'kded6', 'xembedsniproxy', 'gmenudbusmenupr', 'kaccess', 'baloo_file', 'kiod6', 'dbus-broker-lau',
      'Xwayland', 'kwin_wayland_wr', 'warp', 'warp-terminal', 'claude', 'kdeconnectd', 'gvfsd', 'ibus-daemon', 'fcitx5', 'kscreen_backend'];
    expect(names.filter((n) => !isNeverKillName(n))).toEqual([]);
  });
  test('préfixe : un nom de 15 caractères qui commence un nom complet de la liste est couvert ; un nom court ne l’est pas par préfixe', () => {
    expect(isNeverKillName('gnome-terminal-')).toBe(true); // gnome-terminal-server
    expect(isNeverKillName('gmenudbusmenupr')).toBe(true); // gmenudbusmenuproxy
    expect(isNeverKillName('s')).toBe(false);
    expect(isNeverKillName('node')).toBe(false);
  });
  test('(c) ne vise ni une commande (krunner, démon) ni une appli non choisie, même en forte croissance', () => {
    const fc = { forecast: { etaMin: 2, decliningMinutes: 4 } as never, held: true };
    const cmd = project('mydaemon', 1300, 4, 'command');
    const app = project('firefox', 1301, 6, 'app');
    const st = emptyRuleState();
    const r = rule({ kind: 'forecast', underMin: 3, includeApps: [] });
    const growth = attribute(world([cmd, app]), [[cmd.id, 2 * GB], [app.id, 2 * GB]]);
    evaluateRules(input({ now: 0, rules: [r], groups: world([cmd, app]), forecast: fc, ...growth }), st);
    expect(evaluateRules(input({ now: 30_000, rules: [r], groups: world([cmd, app]), forecast: fc, ...growth }), st)).toEqual([]);
    const r2 = rule({ kind: 'forecast', underMin: 3, includeApps: ['firefox'] });
    const st2 = emptyRuleState();
    evaluateRules(input({ now: 0, rules: [r2], groups: world([cmd, app]), forecast: fc, ...growth }), st2);
    expect(fires(evaluateRules(input({ now: 30_000, rules: [r2], groups: world([cmd, app]), forecast: fc, ...growth }), st2))[0])
      .toMatchObject({ target: { groupKey: 'app:firefox' } });
  });
});
