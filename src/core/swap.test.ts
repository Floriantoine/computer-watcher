import { describe, expect, test } from 'vitest';
import type { GroupClassification } from './classify/classify';
import { group, node, proc } from './classify/testFixtures';
import type { FullSnapshot } from './snapshot';
import { isSessionService, SWAP_IDLE_MS, swapTargets, swapView, type SwapInput } from './swap';
import type { Group, InstanceSummary, ProcInfo, SystemInfo } from './types';

const H = 3600_000;
const D = 24 * H;
const MB = 1024;
const NOW = 100 * D;

const system: SystemInfo = {
  memTotalKB: 32_000_000, memAvailableKB: 16_000_000, swapTotalKB: 20_000_000, swapFreeKB: 9_000_000, load1: 1, psiSome10: 0, shmemKB: 2_000_000,
};

/** Processus endormi : 0 % de CPU, lancé il y a 5 j. */
const sleeper = (name: string, swapMB: number, over: Partial<ProcInfo> = {}) => proc(name, name, { swapKB: swapMB * MB, cpuPercent: 0, ageSec: 5 * 86400, ...over });

function instance(g: Group, procs: ProcInfo[], over: Partial<InstanceSummary> = {}): InstanceSummary {
  const root = procs[0]!;
  return {
    key: `${g.id}#${root.pid}:${root.startTicks}`, groupId: g.id, project: g.label, category: 'back', source: 'command', signature: root.name, label: root.name,
    rootPid: root.pid, rootStartTicks: root.startTicks, pids: procs.map((p) => p.pid), ports: [], ageSec: root.ageSec, rssKB: 0, swapKB: 0, cpuPercent: 0,
    duplicate: false, protected: false, ...over,
  };
}

function full(groups: Group[], instances: InstanceSummary[] = []): FullSnapshot {
  const classification = new Map<string, GroupClassification>();
  for (const g of groups) classification.set(g.id, { categories: [], instances: instances.filter((i) => i.groupId === g.id), launcherPids: [] });
  return { takenAt: NOW, currentUid: 1000, system, groups, classification };
}

/** Dernière activité de chaque processus (clé pid:startTicks). */
const last = (entries: [ProcInfo, number | null][]) => new Map(entries.map(([p, ts]) => [`${p.pid}:${p.startTicks}`, ts]));

/** Historique continu sur toute la fenêtre (7 j), dernier échantillon il y a 3 s. */
const COVERED = { latestTs: NOW - 3000, coveredFrom: NOW - 7 * D, gap: false };

function input(f: FullSnapshot, lastActive: SwapInput['lastActive'], over: Partial<SwapInput> = {}): SwapInput {
  return { full: f, lastActive, coverage: COVERED, now: NOW, minSwapKB: 100 * MB, idleMs: SWAP_IDLE_MS, intervalMs: 5000, activeCpu: 1, ...over };
}

/** Projet acme avec une instance (processus fournis). */
function project(procs: ProcInfo[], instOver: Partial<InstanceSummary> = {}, groupOver: Partial<Group> = {}) {
  const g = { ...group('project:/home/u/acme', 'project', [node(procs[0]!, ...procs.slice(1).map((p) => node(p)))]), ...groupOver };
  const inst = instance(g, procs, instOver);
  return { g, inst, f: full([g], [inst]) };
}

describe('swapView', () => {
  test('instance de projet 300 Mo de swap, dernier CPU il y a 3 j, historique depuis 10 j → endormie, éligible', () => {
    const p = sleeper('nest', 300);
    const { inst, f } = project([p]);
    const v = swapView(input(f, last([[p, NOW - 3 * D]])));
    expect(v.rows).toHaveLength(1);
    const row = v.rows[0]!;
    expect(row.kind).toBe('project');
    expect(row.swapKB).toBe(300 * MB);
    expect(row.children).toHaveLength(1);
    const child = row.children[0]!;
    expect(child.key).toBe(inst.key);
    expect(child.instanceKey).toBe(inst.key);
    expect(child.state).toEqual({ kind: 'sleeping', sinceTs: NOW - 3 * D });
    expect(child.bulkEligible).toBe(true);
    expect(v.sleepingKeys).toEqual([inst.key]);
    expect(v.swapUsedKB).toBe(11_000_000);
    expect(v.swapTotalKB).toBe(20_000_000);
    expect(v.shmemKB).toBe(2_000_000);
  });

  test('swap 80 Mo : sous le seuil → actif (non concerné)', () => {
    const p = sleeper('nest', 80);
    const { f } = project([p]);
    const v = swapView(input(f, last([[p, NOW - 3 * D]])));
    expect(v.rows[0]!.children[0]!.state).toEqual({ kind: 'active' });
    expect(v.sleepingKeys).toEqual([]);
  });

  test('deux processus 60 + 60 Mo : cumul 120 Mo → endormie', () => {
    const a = sleeper('nest', 60);
    const b = sleeper('node', 60);
    const { inst, f } = project([a, b]);
    const v = swapView(input(f, last([[a, NOW - 3 * D], [b, null]])));
    expect(v.rows[0]!.children[0]!.swapKB).toBe(120 * MB);
    expect(v.rows[0]!.children[0]!.state).toEqual({ kind: 'sleeping', sinceTs: NOW - 3 * D });
    expect(v.sleepingKeys).toEqual([inst.key]);
  });

  test('historique depuis 3 h seulement → inconnu, pas dans sleepingKeys', () => {
    const p = sleeper('nest', 300);
    const { f } = project([p]);
    const v = swapView(input(f, last([[p, null]]), { coverage: { ...COVERED, coveredFrom: NOW - 3 * H } }));
    expect(v.rows[0]!.children[0]!.state).toEqual({ kind: 'unknown', reason: 'short' });
    expect(v.rows[0]!.children[0]!.bulkEligible).toBe(false);
    expect(v.sleepingKeys).toEqual([]);
  });

  test('pas de base (lastActive null) ou historique vide → inconnu', () => {
    const p = sleeper('nest', 300);
    const { f } = project([p]);
    expect(swapView(input(f, null)).rows[0]!.children[0]!.state).toEqual({ kind: 'unknown', reason: 'none' });
    expect(swapView(input(f, last([[p, null]]), { coverage: null })).rows[0]!.children[0]!.state).toEqual({ kind: 'unknown', reason: 'none' });
    expect(swapView(input(f, last([[p, null]]), { coverage: { latestTs: null, coveredFrom: null, gap: false } })).rows[0]!.children[0]!.state).toEqual({
      kind: 'unknown', reason: 'none',
    });
  });

  test('instance lancée il y a 2 h, inactive → active (même sans historique suffisant)', () => {
    const p = sleeper('nest', 300, { ageSec: 7200 });
    const { f } = project([p]);
    expect(swapView(input(f, last([[p, null]]))).rows[0]!.children[0]!.state).toEqual({ kind: 'active' });
    expect(swapView(input(f, null)).rows[0]!.children[0]!.state).toEqual({ kind: 'active' });
  });

  test('CPU en direct 4 % → active', () => {
    const p = sleeper('nest', 300, { cpuPercent: 4 });
    const { f } = project([p]);
    expect(swapView(input(f, last([[p, NOW - 3 * D]]))).rows[0]!.children[0]!.state).toEqual({ kind: 'active' });
  });

  test('actif il y a 2 h (historique) → active', () => {
    const p = sleeper('nest', 300);
    const { f } = project([p]);
    expect(swapView(input(f, last([[p, NOW - 2 * H]]))).rows[0]!.children[0]!.state).toEqual({ kind: 'active' });
  });

  test('service d\'enregistrement arrêté maintenant (dernier échantillon il y a 2 h) → inconnu, rien de proposé', () => {
    const p = sleeper('nest', 300);
    const { f } = project([p]);
    const v = swapView(input(f, last([[p, NOW - 3 * D]]), { coverage: { ...COVERED, latestTs: NOW - 2 * H } }));
    expect(v.rows[0]!.children[0]!.state).toEqual({ kind: 'unknown', reason: 'stopped' });
    expect(v.sleepingKeys).toEqual([]);
    // dernier échantillon plus vieux que 2 intervalles (11 s pour 5 s) : déjà « arrêté »
    expect(swapView(input(f, last([[p, NOW - 3 * D]]), { coverage: { ...COVERED, latestTs: NOW - 11_000 } })).rows[0]!.children[0]!.state.kind).toBe('unknown');
  });

  test('service arrêté 20 h dans le dernier jour (trou > 10 min) → inconnu (trou), rien de proposé', () => {
    const p = sleeper('nest', 300);
    const { f } = project([p]);
    const v = swapView(input(f, last([[p, NOW - 3 * D]]), { coverage: { latestTs: NOW - 3000, coveredFrom: NOW - 4 * H, gap: true } }));
    expect(v.rows[0]!.children[0]!.state).toEqual({ kind: 'unknown', reason: 'gap' });
    expect(v.sleepingKeys).toEqual([]);
  });

  test('dernière activité avant le début de la couverture continue → endormi depuis plus de (sinceTs null)', () => {
    const p = sleeper('nest', 300);
    const { f } = project([p]);
    const v = swapView(input(f, last([[p, NOW - 6 * D]]), { coverage: { latestTs: NOW - 3000, coveredFrom: NOW - 2 * D, gap: true } }));
    expect(v.rows[0]!.children[0]!.state).toEqual({ kind: 'sleeping', sinceTs: null });
    expect(v.coveredFrom).toBe(NOW - 2 * D);
  });

  test('seuil d\'activité max(1, procMinCpuPercent) : CPU en direct 1,5 % sous un seuil de 2 % → pas actif', () => {
    const p = sleeper('nest', 300, { cpuPercent: 1.5 });
    const { f } = project([p]);
    expect(swapView(input(f, last([[p, NOW - 3 * D]]))).rows[0]!.children[0]!.state.kind).toBe('active');
    const v = swapView(input(f, last([[p, NOW - 3 * D]]), { activeCpu: 2 }));
    expect(v.rows[0]!.children[0]!.state.kind).toBe('sleeping');
    expect(v.activeCpu).toBe(2);
  });

  test('jamais actif dans la fenêtre → endormi, sinceTs null', () => {
    const p = sleeper('nest', 300);
    const { f } = project([p]);
    expect(swapView(input(f, last([[p, null]]))).rows[0]!.children[0]!.state).toEqual({ kind: 'sleeping', sinceTs: null });
  });

  test('groupe app:spotify endormi → endormi mais jamais éligible au kill groupé, sans enfant', () => {
    const p = sleeper('spotify', 400);
    const g = group('app:spotify', 'app', [node(p)]);
    const v = swapView(input(full([g]), last([[p, NOW - 3 * D]])));
    expect(v.rows[0]!.children).toEqual([]);
    expect(v.rows[0]!.state.kind).toBe('sleeping');
    expect(v.rows[0]!.bulkEligible).toBe(false);
    expect(v.rows[0]!.killable).toBe(true);
    expect(v.sleepingKeys).toEqual([]);
  });

  test('appli avec une instance classée unique : instanceKey renseignée, toujours pas éligible', () => {
    const p = sleeper('postgres', 400);
    const g = group('app:postgres', 'app', [node(p)]);
    const inst = instance(g, [p], { category: 'db' });
    const v = swapView(input(full([g], [inst]), last([[p, NOW - 3 * D]])));
    expect(v.rows[0]!.instanceKey).toBe(inst.key);
    expect(v.rows[0]!.category).toBe('db');
    expect(v.rows[0]!.bulkEligible).toBe(false);
  });

  test('instance protégée endormie → pas éligible', () => {
    const p = sleeper('nest', 300);
    const { f } = project([p], { protected: true });
    const v = swapView(input(f, last([[p, NOW - 3 * D]])));
    expect(v.rows[0]!.children[0]!.state.kind).toBe('sleeping');
    expect(v.rows[0]!.children[0]!.protected).toBe(true);
    expect(v.rows[0]!.children[0]!.bulkEligible).toBe(false);
    expect(v.sleepingKeys).toEqual([]);
  });

  test('instance lancée par Claude, ou projet non tuable : jamais éligible', () => {
    const p = sleeper('nest', 300);
    const a = project([p], { launchedBy: 'claude' });
    const va = swapView(input(a.f, last([[p, NOW - 3 * D]])));
    expect(va.sleepingKeys).toEqual([]);
    expect(va.rows[0]!.children[0]!.launchedBy).toBe('claude');
    expect(va.rows[0]!.children[0]!.state.kind).toBe('sleeping');
    const b = project([p], {}, { killable: false });
    expect(swapView(input(b.f, last([[p, NOW - 3 * D]]))).sleepingKeys).toEqual([]);
  });

  test('groupe Claude : jamais tuable depuis la vue swap', () => {
    const p = sleeper('claude', 400);
    const g = group('claude', 'claude', [node(p)]);
    const v = swapView(input(full([g]), last([[p, NOW - 3 * D]])));
    expect(v.rows[0]!.killable).toBe(false);
    expect(v.rows[0]!.bulkEligible).toBe(false);
  });

  test('groupe « command » (démons de session, processus regroupés par nom) : jamais tuable depuis la vue swap', () => {
    const p = sleeper('kwalletd6', 300);
    const v = swapView(input(full([group('command:kwalletd6', 'command', [node(p)])]), last([[p, NOW - 3 * D]])));
    expect(v.rows[0]!.state.kind).toBe('sleeping');
    expect(v.rows[0]!.killable).toBe(false);
  });

  test('appli contenant un service de session (portail, pipewire, kwallet…) : jamais tuable', () => {
    for (const name of ['xdg-desktop-portal-kde', 'kwalletd6', 'pipewire-pulse', 'wireplumber', 'kded6', 'plasmashell', 'kwin_wayland', 'Xwayland', 'dbus-broker', 'systemd', 'gvfsd-fuse', 'at-spi2-registryd']) {
      const root = sleeper('app', 300);
      const svc = sleeper(name, 10);
      const v = swapView(input(full([group('app:x', 'app', [node(root, node(svc))])]), last([[root, NOW - 3 * D], [svc, null]])));
      expect(v.rows[0]!.killable, name).toBe(false);
    }
    expect(isSessionService('spotify')).toBe(false);
    expect(isSessionService('kwalletmanager5')).toBe(false);
  });

  test('tri par swap décroissant, groupes sans swap absents, sous-groupes de « Autres » listés à la place de « Autres »', () => {
    const a = sleeper('a', 50);
    const b = sleeper('b', 500);
    const c = sleeper('c', 0);
    const d = sleeper('d', 200);
    const ga = group('app:a', 'app', [node(a)]);
    const gb = group('app:b', 'app', [node(b)]);
    const gc = group('app:c', 'app', [node(c)]);
    const sub = group('cmd:d', 'command', [node(d)]);
    const others = { ...group('others', 'others', []), subgroups: [sub] };
    const v = swapView(input(full([ga, gb, gc, others]), last([])));
    expect(v.rows.map((r) => r.key)).toEqual(['app:b', 'cmd:d', 'app:a']);
  });

  test('enfants : instances avec swap seulement, triées par swap', () => {
    const a = sleeper('vite', 0);
    const b = sleeper('nest', 300);
    const c = sleeper('pg', 400);
    const g = group('project:/home/u/acme', 'project', [node(a), node(b), node(c)]);
    const ia = instance(g, [a], { category: 'front' });
    const ib = instance(g, [b]);
    const ic = instance(g, [c], { category: 'db' });
    const v = swapView(input(full([g], [ia, ib, ic]), last([])));
    expect(v.rows[0]!.children.map((r) => r.key)).toEqual([ic.key, ib.key]);
    expect(v.rows[0]!.swapKB).toBe(700 * MB);
  });

  test('minSwapKB personnalisé (500 Mo) respecté', () => {
    const p = sleeper('nest', 300);
    const { f } = project([p]);
    const v = swapView(input(f, last([[p, NOW - 3 * D]]), { minSwapKB: 500 * MB }));
    expect(v.rows[0]!.children[0]!.state).toEqual({ kind: 'active' });
    expect(v.sleepingKeys).toEqual([]);
  });

  test('shmem absent → null ; swap total nul', () => {
    const f = { ...full([]), system: { ...system, shmemKB: null, swapTotalKB: 0, swapFreeKB: 0 } };
    const v = swapView(input(f, null));
    expect(v).toMatchObject({ shmemKB: null, swapUsedKB: 0, swapTotalKB: 0, rows: [], sleepingKeys: [] });
  });
});

test('swapTargets : processus des groupes au-dessus du seuil seulement (sous-groupes de « Autres » compris)', () => {
  const a = sleeper('a', 50);
  const b = sleeper('b', 300);
  const b2 = sleeper('b2', 0);
  const d = sleeper('d', 200);
  const others = { ...group('others', 'others', []), subgroups: [group('cmd:d', 'command', [node(d)])] };
  const f = full([group('app:a', 'app', [node(a)]), group('app:b', 'app', [node(b, node(b2))]), others]);
  expect(swapTargets(f, 100 * MB).map((t) => t.pid).sort()).toEqual([b.pid, b2.pid, d.pid].sort());
});
