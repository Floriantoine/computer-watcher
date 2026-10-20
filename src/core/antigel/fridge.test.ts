import { describe, expect, test } from 'vitest';
import { BusctlError } from './systemd';
import { RECLAIM_CHUNK, RECLAIM_MAX_MS, SWAP_MARGIN, STOP_DEADLINE_MS, createFridge, reclaimTarget, type FridgeDeps } from './fridge';
import { freezeArgv, thawArgv, type FridgeClient } from './fridgeSystemd';
import { MAX_FROZEN, type FridgeRequest } from './fridgeState';
import type { AntigelState } from './state';
import { sampleState } from './testFixtures';

const UB = '/user.slice/user-1000.slice/user@1000.service';
const P = `${UB}/cwatch.slice/cwatch-p.slice`;
const ALPHA = 'cwatch-p-alpha.slice';
const GiB = 1024 ** 3;

/** Faux /sys/fs/cgroup et faux client : FreezeUnit / ThawUnit écrivent cgroup.freeze de la slice (argv validé). */
function setup(o: { fail?: (m: string, s: string) => BusctlError | null; reclaim?: (cg: string, n: number) => 'ok' | 'again'; current?: number; partial?: boolean; swapFree?: () => number } = {}) {
  const files = new Map<string, string>();
  const dirs = new Map<string, string[]>();
  const calls: string[] = [];
  const reclaims: [string, number][] = [];
  let clock = 0;
  const put = (cg: string, f: string, v: string) => files.set(`${cg}/${f}`, v);
  const addSlice = (name: string, o2: { frozen?: boolean; pids?: number[]; current?: number } = {}) => {
    const cg = `${P}/${name}`;
    dirs.set(P, [...(dirs.get(P) ?? []), name]);
    put(cg, 'cgroup.freeze', o2.frozen ? '1\n' : '0\n');
    put(cg, 'cgroup.events', `populated 1\nfrozen ${o2.frozen ? 1 : 0}\n`);
    put(cg, 'memory.current', String(o2.current ?? 3 * GiB));
    put(cg, 'memory.stat', `anon ${2 * GiB}\nfile ${GiB}\nkernel 1000\n`);
    const scope = `${name.slice(0, -'.slice'.length)}-a1.scope`;
    dirs.set(cg, [scope, 'not-a-scope']);
    put(`${cg}/${scope}`, 'cgroup.procs', (o2.pids ?? [700, 701]).join('\n') + '\n');
  };
  put(`${UB}/cwatch.slice`, 'memory.swap.max', String(8 * GiB));
  put(`${UB}/cwatch.slice`, 'memory.swap.current', String(GiB));
  const client: FridgeClient = {
    freeze: async (s) => {
      freezeArgv(s);
      calls.push(`freeze ${s}`);
      const e = o.fail?.('freeze', s);
      if (e) throw e;
      put(`${P}/${s}`, 'cgroup.freeze', '1\n');
      if (!o.partial) put(`${P}/${s}`, 'cgroup.events', 'populated 1\nfrozen 1\n');
    },
    thaw: async (s) => {
      thawArgv(s);
      calls.push(`thaw ${s}`);
      const e = o.fail?.('thaw', s);
      if (e) throw e;
      if (!files.has(`${P}/${s}/cgroup.freeze`)) throw new BusctlError(`Unit ${s} not loaded.`, 'no-unit');
      put(`${P}/${s}`, 'cgroup.freeze', '0\n');
      put(`${P}/${s}`, 'cgroup.events', 'populated 1\nfrozen 0\n');
    },
    thawSync: (s) => {
      thawArgv(s);
      calls.push(`thawSync ${s}`);
      const e = o.fail?.('thawSync', s);
      if (e) throw e;
      put(`${P}/${s}`, 'cgroup.freeze', '0\n');
    },
    calls: () => calls.length,
  };
  const logs: string[] = [];
  const deps: FridgeDeps = {
    client,
    probe: () => ({ ok: true, userBase: UB, busctl: '/usr/bin/busctl' }),
    read: (cg, f) => files.get(`${cg}/${f}`) ?? null,
    list: (cg) => dirs.get(cg) ?? null,
    reclaim: async (cg, n) => {
      reclaims.push([cg, n]);
      const r = o.reclaim?.(cg, n) ?? 'ok';
      if (r === 'ok') {
        const cur = Number(files.get(`${cg}/memory.current`));
        put(cg, 'memory.current', String(Math.max(0, cur - n)));
      }
      return r;
    },
    monoNow: () => clock,
    log: (m) => logs.push(m),
    swapFreeBytes: o.swapFree,
    sleep: async () => {
      clock += 1;
    },
  };
  const fridge = createFridge(deps);
  const tick = async (requests: FridgeRequest[] = [], antigel: AntigelState = sampleState(), swapFreeKB = 10 * 1024 * 1024) => {
    fridge.tick({ ts: 5000, antigel, swapFreeKB, requests });
    await fridge.idle();
  };
  return { fridge, files, dirs, calls, reclaims, logs, addSlice, tick, put, deps, advance: (ms: number) => (clock += ms) };
}

const freezeReq = (root = '/home/u/alpha'): FridgeRequest => ({ root, action: 'freeze', at: 5000 });
const thawReq = (root = '/home/u/alpha'): FridgeRequest => ({ root, action: 'thaw', at: 5000 });

describe('quantité récupérée', () => {
  const base = { stat: `anon ${4 * GiB}\nfile ${GiB}`, currentBytes: 5 * GiB, swapFreeBytes: 20 * GiB, rootSwapMax: 'max', rootSwapCurrent: '0' };
  test('cache + anonyme dans la limite de la swap libre (moins 1 Gio) et de la marge de swap de cwatch.slice', () => {
    expect(reclaimTarget(base)).toBe(5 * GiB);
    expect(reclaimTarget({ ...base, swapFreeBytes: 3 * GiB })).toBe(GiB + 3 * GiB - SWAP_MARGIN);
    expect(reclaimTarget({ ...base, swapFreeBytes: SWAP_MARGIN / 2 })).toBe(GiB); // swap presque pleine : le cache seulement
    expect(reclaimTarget({ ...base, rootSwapMax: String(4 * GiB), rootSwapCurrent: String(3 * GiB) })).toBe(2 * GiB);
    expect(reclaimTarget({ ...base, rootSwapMax: String(4 * GiB), rootSwapCurrent: null })).toBe(GiB); // marge inconnue : rien d'anonyme
    expect(reclaimTarget({ ...base, rootSwapMax: null, rootSwapCurrent: null })).toBe(5 * GiB); // swap non comptée par cgroup
  });
  test('jamais plus que memory.current ; rien si illisible', () => {
    expect(reclaimTarget({ ...base, currentBytes: 2 * GiB })).toBe(2 * GiB);
    expect(reclaimTarget({ ...base, currentBytes: null })).toBe(0);
    expect(reclaimTarget({ ...base, stat: null })).toBe(0);
  });
});

describe('mettre au frigo', () => {
  test('projet plafonné : FreezeUnit sur sa slice, reclaim par morceaux, au frigo, pids et slice signalés', async () => {
    const s = setup();
    s.addSlice(ALPHA);
    await s.tick([freezeReq()]);
    expect(s.calls).toEqual([`freeze ${ALPHA}`]);
    expect(s.files.get(`${P}/${ALPHA}/cgroup.freeze`)).toBe('1\n');
    // 3 Gio (1 de cache + 2 d'anonyme ; swap libre 10 Gio, marge de cwatch.slice 7 Gio) en morceaux de 64 Mio
    expect(s.reclaims.every(([cg, n]) => cg === `${P}/${ALPHA}` && n <= RECLAIM_CHUNK)).toBe(true);
    expect(s.reclaims.reduce((a, [, n]) => a + n, 0)).toBe(3 * GiB);
    const pub = s.fridge.publish();
    expect(pub.fridge).toEqual([{ unit: ALPHA, root: '/home/u/alpha', since: 5000, phase: 'frozen', reclaimedKB: 3 * 1024 * 1024 }]);
    expect(pub.fridgeNotice).toMatchObject({ root: '/home/u/alpha', ok: true });
    expect(pub.fridgeNotice!.text).toMatch(/au frigo : ≈ 3,0 Go sortis de la RAM/);
    await s.tick();
    expect([...s.fridge.frozenSlices()]).toEqual([ALPHA]);
    expect([...s.fridge.frozenPids()].sort()).toEqual([700, 701]);
  });

  test('deuxième demande : rien de plus', async () => {
    const s = setup();
    s.addSlice(ALPHA);
    await s.tick([freezeReq()]);
    await s.tick([freezeReq()]);
    expect(s.calls).toEqual([`freeze ${ALPHA}`]);
  });

  test('refus : interrupteur éteint, indisponible, projet hors plafond, vide, slice « autres », slice absente', async () => {
    const s = setup();
    s.addSlice(ALPHA);
    await s.tick([freezeReq()], sampleState({ enabled: false, status: 'off' }));
    await s.tick([freezeReq()], sampleState({ status: 'unavailable' }));
    await s.tick([freezeReq('/home/u/beta')]);
    await s.tick([freezeReq()], sampleState({ projects: [{ unit: ALPHA, root: '/home/u/alpha', procs: 0, currentKB: 0, budgetMB: null, throttled: false }] }));
    await s.tick([freezeReq()], sampleState({ projects: [], slices: { [ALPHA]: '/home/u/alpha' } }));
    // attribution incohérente (racine attribuée à « autres ») : refusée
    await s.tick([freezeReq('/home/u/x')], sampleState({
      slices: { 'cwatch-p-autres.slice': '/home/u/x' as never },
      projects: [{ unit: 'cwatch-p-autres.slice', root: '/home/u/x', procs: 2, currentKB: 1, budgetMB: null, throttled: false }],
    }));
    const t = setup();
    await t.tick([freezeReq()]); // slice de alpha absente de /sys
    expect(s.calls).toEqual([]);
    expect(t.calls).toEqual([]);
    expect(s.fridge.publish().fridgeNotice).toMatchObject({ ok: false, root: '/home/u/x' });
    expect(t.fridge.publish().fridgeNotice!.text).toMatch(/introuvable/);
    const u = setup();
    u.deps.probe = () => ({ ok: false, reason: 'non' });
    const v = createFridge(u.deps);
    v.tick({ ts: 1, antigel: sampleState(), swapFreeKB: 0, requests: [freezeReq()] });
    expect(v.publish().fridgeNotice!.text).toMatch(/indisponible/);
    expect(u.calls).toEqual([]);
  });

  test(`au plus ${MAX_FROZEN} projets au frigo`, async () => {
    const s = setup();
    const roots = Array.from({ length: MAX_FROZEN + 1 }, (_, i) => `/home/u/p${i}`);
    const slices = Object.fromEntries(roots.map((r, i) => [`cwatch-p-p${i}.slice`, r]));
    for (const u of Object.keys(slices)) s.addSlice(u);
    const st = sampleState({ slices, projects: roots.map((r, i) => ({ unit: `cwatch-p-p${i}.slice`, root: r, procs: 1, currentKB: 1, budgetMB: null, throttled: false })) });
    await s.tick(roots.map((r) => freezeReq(r)), st);
    expect(s.calls.filter((c) => c.startsWith('freeze'))).toHaveLength(MAX_FROZEN);
    expect(s.logs.some((l) => /p20.*déjà 20 projets/.test(l))).toBe(true);
  });

  test('FreezeUnit en échec : sorti du frigo, dégel de sécurité', async () => {
    const s = setup({ fail: (m) => (m === 'freeze' ? new BusctlError('délai', 'timeout') : null) });
    s.addSlice(ALPHA);
    await s.tick([freezeReq()]);
    expect(s.calls).toEqual([`freeze ${ALPHA}`, `thaw ${ALPHA}`]);
    expect(s.fridge.publish().fridge).toEqual([]);
    expect(s.fridge.publish().fridgeNotice).toMatchObject({ ok: false });
  });

  test('reclaim : arrêt après deux EAGAIN, et au bout de la durée maximale', async () => {
    const s = setup({ reclaim: () => 'again' });
    s.addSlice(ALPHA);
    await s.tick([freezeReq()]);
    expect(s.reclaims).toHaveLength(2);
    expect(s.fridge.publish().fridge[0]!.phase).toBe('frozen');
    const t = setup({ reclaim: () => { t.advance(RECLAIM_MAX_MS / 3); return 'ok'; } });
    t.addSlice(ALPHA);
    await t.tick([freezeReq()]);
    expect(t.reclaims.length).toBeLessThanOrEqual(4);
  });

  test('reclaim interrompu si le projet est dégelé hors de l’app', async () => {
    const s = setup({ reclaim: () => { s.put(`${P}/${ALPHA}`, 'cgroup.freeze', '0\n'); return 'ok'; } });
    s.addSlice(ALPHA);
    await s.tick([freezeReq()]);
    expect(s.reclaims).toHaveLength(1);
    await s.tick();
    expect(s.fridge.publish().fridge).toEqual([]);
    expect(s.fridge.publish().fridgeNotice!.text).toMatch(/hors de l’app/);
  });
});

describe('réveiller', () => {
  test('projet au frigo vidé de ses processus : réveillé seul (sinon invisible et fermé au plafond)', async () => {
    const s = setup();
    s.addSlice(ALPHA);
    await s.tick([freezeReq()]);
    s.put(`${P}/${ALPHA}`, 'cgroup.events', 'populated 1\nfrozen 1\n');
    await s.tick();
    expect(s.calls).toEqual([`freeze ${ALPHA}`]);
    s.put(`${P}/${ALPHA}`, 'cgroup.events', 'populated 0\nfrozen 1\n');
    await s.tick();
    expect(s.calls).toEqual([`freeze ${ALPHA}`, `thaw ${ALPHA}`]);
    expect(s.fridge.publish().fridge).toEqual([]);
  });

  test('ThawUnit, sorti du frigo, plus de pids gelés', async () => {
    const s = setup();
    s.addSlice(ALPHA);
    await s.tick([freezeReq()]);
    await s.tick([thawReq()]);
    expect(s.calls).toEqual([`freeze ${ALPHA}`, `thaw ${ALPHA}`]);
    expect(s.files.get(`${P}/${ALPHA}/cgroup.freeze`)).toBe('0\n');
    await s.tick();
    expect(s.fridge.publish().fridge).toEqual([]);
    expect(s.fridge.frozenSlices().size).toBe(0);
    expect(s.fridge.frozenPids().size).toBe(0);
  });

  test('réveil pendant le reclaim : reclaim arrêté, puis dégel', async () => {
    let n = 0;
    const s = setup({ reclaim: () => { if (++n === 3) s.fridge.tick({ ts: 6000, antigel: sampleState(), swapFreeKB: 1e7, requests: [thawReq()] }); return 'ok'; } });
    s.addSlice(ALPHA);
    await s.tick([freezeReq()]);
    await s.fridge.idle();
    expect(n).toBe(3);
    expect(s.calls).toEqual([`freeze ${ALPHA}`, `thaw ${ALPHA}`]);
    expect(s.fridge.publish().fridge).toEqual([]);
  });

  test('projet gelé inconnu du frigo (service redémarré) : dégelé à la demande ; pas au frigo : simple message', async () => {
    const s = setup();
    s.addSlice(ALPHA, { frozen: true });
    s.fridge.tick({ ts: 1, antigel: sampleState(), swapFreeKB: 0, requests: [thawReq()] });
    await s.fridge.idle();
    expect(s.calls).toEqual([`thaw ${ALPHA}`]);
    await s.tick([thawReq()]);
    expect(s.calls).toEqual([`thaw ${ALPHA}`]);
    expect(s.fridge.publish().fridgeNotice!.text).toMatch(/n’est pas au frigo/);
  });
});

describe('jamais gelé par oubli', () => {
  test('démarrage : toute slice de projet gelée est dégelée ; les autres noms sont ignorés', async () => {
    const s = setup();
    s.addSlice(ALPHA, { frozen: true });
    s.addSlice('cwatch-p-beta.slice');
    s.dirs.set(P, [...s.dirs.get(P)!, 'cwatch-e2eab-a.slice', 'app.slice']);
    s.put(`${P}/cwatch-e2eab-a.slice`, 'cgroup.freeze', '1');
    await s.tick();
    expect(s.calls).toEqual([`thaw ${ALPHA}`]);
  });

  test('balayage toutes les 60 s seulement', async () => {
    const s = setup();
    s.addSlice(ALPHA);
    await s.tick();
    s.put(`${P}/${ALPHA}`, 'cgroup.freeze', '1\n'); // gelé hors du service
    await s.tick();
    expect(s.calls).toEqual([]);
    s.advance(60_000);
    await s.tick();
    expect(s.calls).toEqual([`thaw ${ALPHA}`]);
  });

  test('interrupteur éteint : tout est dégelé', async () => {
    const s = setup();
    s.addSlice(ALPHA);
    await s.tick([freezeReq()]);
    await s.tick([], sampleState({ enabled: false, status: 'off' }));
    expect(s.calls).toEqual([`freeze ${ALPHA}`, `thaw ${ALPHA}`]);
    expect(s.fridge.publish().fridge).toEqual([]);
  });

  test('dégel en échec : repris par le balayage', async () => {
    let fail = true;
    const s = setup({ fail: (m) => (m === 'thaw' && fail ? new BusctlError('x', 'other') : null) });
    s.addSlice(ALPHA);
    await s.tick([freezeReq()]);
    await s.tick([thawReq()]);
    expect(s.fridge.publish().fridgeNotice).toMatchObject({ ok: false });
    fail = false;
    s.advance(60_000);
    await s.tick();
    expect(s.calls).toEqual([`freeze ${ALPHA}`, `thaw ${ALPHA}`, `thaw ${ALPHA}`]);
    expect(s.files.get(`${P}/${ALPHA}/cgroup.freeze`)).toBe('0\n');
  });

  test('arrêt du service : dégel synchrone de tout ce qui est gelé, borné dans le temps', async () => {
    const s = setup();
    s.addSlice(ALPHA);
    s.addSlice('cwatch-p-beta.slice');
    await s.tick([freezeReq()]);
    s.put(`${P}/cwatch-p-beta.slice`, 'cgroup.freeze', '1');
    s.fridge.thawAllSync();
    expect(s.calls.filter((c) => c.startsWith('thawSync')).sort()).toEqual([`thawSync ${ALPHA}`, 'thawSync cwatch-p-beta.slice']);
    expect(s.fridge.publish().fridge).toEqual([]);
    const t = setup({ fail: (m) => (m === 'thawSync' ? (t.advance(STOP_DEADLINE_MS + 1), new BusctlError('délai', 'timeout')) : null) });
    t.addSlice(ALPHA, { frozen: true });
    t.addSlice('cwatch-p-beta.slice', { frozen: true });
    t.fridge.tick({ ts: 1, antigel: sampleState({ status: 'unavailable' }), swapFreeKB: 0, requests: [] });
    t.fridge.thawAllSync();
    expect(t.calls.filter((c) => c.startsWith('thawSync'))).toHaveLength(1);
  });
});

test('coût : aucun appel ni lecture de pids en régime établi sans projet au frigo', async () => {
  const s = setup();
  s.addSlice(ALPHA);
  await s.tick();
  let reads = 0;
  const read = s.deps.read;
  s.deps.read = (cg, f) => (reads++, read(cg, f));
  await s.tick();
  expect(reads).toBe(0);
  expect(s.calls).toEqual([]);
});

describe('corrections de la revue', () => {
  test('I1 : swap relue avant chaque morceau ; deux mises au frigo ne dépassent pas la place', async () => {
    let free = 3 * GiB;
    const s = setup({ swapFree: () => free, reclaim: (_cg, n) => { free -= n; return 'ok'; } });
    s.put(`${UB}/cwatch.slice`, 'memory.swap.max', 'max');
    s.addSlice(ALPHA);
    s.addSlice('cwatch-p-beta.slice');
    const st = sampleState({
      slices: { [ALPHA]: '/home/u/alpha', 'cwatch-p-beta.slice': '/home/u/beta' },
      projects: [{ unit: ALPHA, root: '/home/u/alpha', procs: 2, currentKB: 1, budgetMB: null, throttled: false },
        { unit: 'cwatch-p-beta.slice', root: '/home/u/beta', procs: 2, currentKB: 1, budgetMB: null, throttled: false }],
    });
    await s.tick([freezeReq(), freezeReq('/home/u/beta')], st, 3 * 1024 * 1024);
    const pushed = s.reclaims.reduce((a, [, n]) => a + n, 0);
    expect(pushed).toBeLessThanOrEqual(2 * GiB + RECLAIM_CHUNK); // 3 Gio libres − 1 Gio de marge (+ un morceau au plus)
    expect(free).toBeGreaterThanOrEqual(SWAP_MARGIN - RECLAIM_CHUNK);
  });

  test('I2 : un réveil n’attend pas le reclaim d’un autre projet', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const s = setup();
    s.deps.reclaim = async () => { await gate; return 'ok'; };
    s.addSlice(ALPHA);
    s.addSlice('cwatch-p-beta.slice', { frozen: true });
    const st = sampleState({ slices: { [ALPHA]: '/home/u/alpha', 'cwatch-p-beta.slice': '/home/u/beta' } });
    s.advance(1); // pas de balayage au premier tick pour beta : on le veut par la demande
    const f = createFridge(s.deps);
    f.tick({ ts: 1, antigel: st, swapFreeKB: 1e7, requests: [freezeReq()] });
    await new Promise((r) => setTimeout(r, 10));
    f.tick({ ts: 2, antigel: st, swapFreeKB: 1e7, requests: [thawReq('/home/u/beta')] });
    await new Promise((r) => setTimeout(r, 10));
    expect(s.calls).toContain('thaw cwatch-p-beta.slice');
    release();
    await f.idle();
  });

  test('M1 : réveil en échec : reste au frigo (règles, contrôleur), nouvel essai après 60 s', async () => {
    let fail = true;
    const s = setup({ fail: (m) => (m === 'thaw' && fail ? new BusctlError('x', 'other') : null) });
    s.addSlice(ALPHA);
    await s.tick([freezeReq()]);
    await s.tick([thawReq()]);
    expect(s.fridge.publish().fridge[0]!.phase).toBe('thawing');
    expect(s.fridge.frozenSlices().has(ALPHA)).toBe(true);
    expect(s.fridge.frozenPids().size).toBe(2);
    fail = false;
    await s.tick();
    expect(s.calls.filter((c) => c.startsWith('thaw'))).toHaveLength(1);
    s.advance(60_000);
    await s.tick();
    expect(s.fridge.publish().fridge).toEqual([]);
  });

  test('M4 : gel non effectif (cgroup.events) : aucun reclaim, réveil de sécurité', async () => {
    const s = setup({ partial: true });
    s.addSlice(ALPHA);
    await s.tick([freezeReq()]);
    expect(s.reclaims).toEqual([]);
    expect(s.calls).toEqual([`freeze ${ALPHA}`, `thaw ${ALPHA}`]);
  });

  test('dégel synchrone au démarrage, avant tout le reste', () => {
    const s = setup();
    s.addSlice(ALPHA, { frozen: true });
    s.addSlice('cwatch-p-beta.slice');
    s.fridge.startupThawSync();
    expect(s.calls).toEqual([`thawSync ${ALPHA}`]);
  });

  test('I4 : un processus vu au frigo après le début de la période n’est pas « inactif »', async () => {
    const s = setup();
    s.addSlice(ALPHA);
    await s.tick([freezeReq()]);
    await s.tick();
    expect(s.fridge.frozenSince(700, 4000)).toBe(true);
    expect(s.fridge.frozenSince(700, 6000)).toBe(false);
    expect(s.fridge.frozenSince(999, 0)).toBe(false);
  });
});
