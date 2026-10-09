// Performance et volume à la cardinalité réelle (mesurée sur la base de l'utilisateur le 2026-10-07) :
// ~400 groupes par tick dont ~38 au-dessus de 20 Mo (repliés par le service : ~40 groupes enregistrés + « Petits groupes »),
// ~130 processus enregistrés par tick, ~1 300 processus distincts par heure (cmdline ~600 octets).
// Lignes de commande (v5, table cmdlines dédupliquée) : ratio mesuré sur la vraie base le 2026-10-08, 6 312 lignes distinctes pour
// 10 385 processus (0,61) ; les processus tirent leur ligne dans un réservoir de taille 0,61 × nombre total de processus.
// Lourd (≈ 1 Go de base) : lancé par `npm run test:recorder` (PROC_WATCH_PERF=1), base sur disque dans ~/.cache.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, expect, test } from 'vitest';
import type { Group, ProcInfo, RangePreset, SystemInfo } from '../types';
import { cmdlineHash, openHistoryDb } from './db';
import { aggregateHour, aggregateMinute, rollupHours } from './maintenance';
import { queryCulprits, queryEvents, queryGroups, queryProcTree, querySystem, queryTop, rangeFromPreset } from './queries';
import { HistoryWriter, SMALL_GROUPS_KEY } from './writer';

const M = 60_000;
const H = 3600_000;
const D = 24 * H;
const TICK = 5000;
const GROUPS = 400;
const BIG = 38; // groupes au-dessus de 20 Mo
const STABLE_PROCS = 110; // processus longs au-dessus de 50 Mo
const CHURN_PER_MIN = 20; // processus courts (builds, tests, onglets) : ~1 300 distincts par heure avec les stables
const CMDLINE = 600;
const DAYS = 30;
const THRESHOLDS = { procMinMemMB: 50, procMinCpuPercent: 1, groupMinMemMB: 20 };
/** Groupe à fort renouvellement (Claude, Chrome) : ~176 000 processus distincts sur 30 j, ~15 s de vie chacun. */
const CHURN_GROUP_PROCS = 176_000;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const groupBaseKB = (i: number) => (i < BIG ? (25 + ((i * i * 37) % 3000)) * 1024 : (100 + ((i * 7919) % 15_000)));
/** Un « petit » groupe sur deux ticks passe au-dessus du seuil CPU : enregistré à part ce tick-là. */
const busySmall = (tick: number) => (tick % 2 === 0 ? BIG + ((tick * 7) % (GROUPS - BIG)) : -1);
/** Processus enregistrés sur 30 j : stables, renouvelés (29 j de résumés + 24 h de détail), groupe à fort renouvellement. */
const TOTAL_PROCS = STABLE_PROCS + (DAYS - 1) * 1440 * CHURN_PER_MIN + 1440 * CHURN_PER_MIN + CHURN_GROUP_PROCS;
/** Réservoir de lignes de commande : avec la ligne `claude` du groupe à fort renouvellement, 0,61 ligne distincte par processus. */
const POOL = Math.round(0.61 * TOTAL_PROCS) - 1;
const poolIndex = (n: number) => (n * 7919) % POOL;
const poolText = (k: number) => `/usr/lib/app/bin --type=renderer --instance=${k} `.padEnd(CMDLINE, 'x');
const cmdline = (n: number) => poolText(poolIndex(n));

test.skipIf(process.env.PROC_WATCH_PERF !== '1')('requêtes Métriques et taille de la base à la cardinalité réelle', () => {
  const root = join(homedir(), '.cache');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'proc-watch-perf-'));
  dirs.push(dir);
  const path = join(dir, 'metrics.db');
  const { db } = openHistoryDb(path);
  db.exec('PRAGMA synchronous = OFF'); // amorçage seulement : n'influence ni la taille ni les requêtes
  const now = Date.UTC(2026, 9, 7, 12);
  const detailFrom = now - D;
  const start = now - DAYS * D;
  const t0 = performance.now();

  // --- 29 jours de résumés (ce que le service laisse après purge du détail) ---
  db.exec('BEGIN');
  const ins = {
    group: db.prepare('INSERT INTO groups(id,key,label,kind) VALUES (?,?,?,?)'),
    cmd: db.prepare('INSERT INTO cmdlines(hash, text) VALUES (?, ?) RETURNING id'),
    proc: db.prepare('INSERT INTO procs(id,pid,start_ticks,name,cmdline_id,group_id,ppid) VALUES (?,?,?,?,?,?,?)'),
    sm: db.prepare('INSERT INTO system_minute(ts, mem_used_kb_avg, mem_used_kb_max, mem_total_kb, swap_used_kb_avg, swap_used_kb_max, swap_total_kb, psi_avg, psi_max, load1_avg, cpu_avg) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
    gm: db.prepare('INSERT INTO group_minute VALUES (?,?,?,?,?,?)'),
    pm: db.prepare('INSERT INTO proc_minute VALUES (?,?,?,?,?)'),
    ev: db.prepare('INSERT INTO events(ts,type,group_id,detail) VALUES (?,?,?,?)'),
  };
  const cmdIds = new Map<number, number>(); // indice du réservoir → id (pas de cache des textes : ~600 000 × 600 octets)
  const cmdId = (n: number) => {
    const k = poolIndex(n);
    let id = cmdIds.get(k);
    if (id === undefined) cmdIds.set(k, (id = (ins.cmd.get(cmdlineHash(poolText(k)), poolText(k)) as { id: number }).id));
    return id;
  };
  const claudeCmd = (ins.cmd.get(cmdlineHash('claude'), 'claude') as { id: number }).id;
  for (let i = 0; i < GROUPS; i++) ins.group.run(i + 1, `command:g${i}`, `g${i}`, 'command');
  ins.group.run(GROUPS + 1, SMALL_GROUPS_KEY, 'Petits groupes', 'others');
  for (let p = 1; p <= STABLE_PROCS; p++) ins.proc.run(p, 1000 + p, p, `p${p}`, cmdId(p), (p % BIG) + 1, 1);
  let nextProc = STABLE_PROCS + 1;
  let prevChurn: number[] = [];
  for (let ts = start, m = 0; ts < detailFrom; ts += M, m++) {
    ins.sm.run(ts, 20e6 + (m % 100) * 1e4, 21e6, 32e6, 4e6, 4.1e6, 20e6, 2, 8, 1.5, 12);
    for (let i = 0; i < BIG; i++) {
      const v = groupBaseKB(i) + (m % 60) * 100;
      ins.gm.run(ts, i + 1, v, 1024, v + 2048, 3);
    }
    ins.gm.run(ts, GROUPS + 1, 1_200_000, 50_000, 1_300_000, 4);
    for (let k = 0; k < 6; k++) ins.gm.run(ts, BIG + 1 + ((m * 6 + k) % (GROUPS - BIG)), 5000, 0, 5000, 2);
    for (let p = 1; p <= STABLE_PROCS; p++) ins.pm.run(ts, p, 80_000 + p, 90_000 + p, 1);
    const churn: number[] = [];
    for (let k = 0; k < CHURN_PER_MIN; k++) {
      const id = nextProc++;
      ins.proc.run(id, 100_000 + (id % 4_000_000), id, 'chrome', cmdId(id), (id % BIG) + 1, 1);
      churn.push(id);
    }
    for (const id of [...prevChurn, ...churn]) ins.pm.run(ts, id, 60_000, 70_000, 2);
    prevChurn = churn;
    if (m % 30 === 0) ins.ev.run(ts, 'pressure', null, '{"psi":30}');
    // un kill earlyoom par heure, sur un processus stable : le filtre par groupe le résout via proc_minute
    if (m % 60 === 0) ins.ev.run(ts, 'earlyoom_kill', null, JSON.stringify({ pid: 1000 + ((m / 60) % STABLE_PROCS) + 1, name: 'p' }));
  }
  // --- groupe à fort renouvellement : un processus court toutes les ~15 s sur les 30 jours ---
  const churnGid = GROUPS + 2;
  ins.group.run(churnGid, 'command:churn', 'churn', 'command');
  const cps = db.prepare('INSERT INTO proc_samples VALUES (?,?,?,?,?)');
  const churnEvery = Math.floor((DAYS * D) / CHURN_GROUP_PROCS);
  for (let i = 0; i < CHURN_GROUP_PROCS; i++) {
    const id = 50_000_000 + i;
    const ts = start + i * churnEvery;
    ins.proc.run(id, 4_200_000 + (i % 100_000), id, 'claude', claudeCmd, churnGid, 1);
    if (ts < detailFrom) ins.pm.run(Math.floor(ts / M) * M, id, 70_000, 80_000, 3);
    else {
      cps.run(ts, id, 70_000, 0, 3);
      cps.run(ts + TICK, id, 71_000, 0, 3);
    }
  }
  rollupHours(db, { from: start, to: detailFrom });
  db.exec('COMMIT');
  const tSummary = performance.now();

  // --- 24 h de détail écrites par le vrai writer (règle de repli du service), puis agrégées comme le service ---
  const sys: SystemInfo = { memTotalKB: 32e6, memAvailableKB: 12e6, swapTotalKB: 20e6, swapFreeKB: 16e6, load1: 1.5, psiSome10: 2, shmemKB: 0 };
  const writer = new HistoryWriter(db);
  const churnAlive: { id: number; pid: number; until: number }[] = [];
  let maxGroupsPerTick = 0;
  for (let ts = detailFrom, tick = 0; ts < now; ts += TICK, tick++) {
    if (tick % 12 === 0) {
      for (let k = 0; k < CHURN_PER_MIN; k++) {
        const id = nextProc++;
        churnAlive.push({ id, pid: 100_000 + (id % 4_000_000), until: ts + M });
      }
    }
    while (churnAlive.length && churnAlive[0].until <= ts) churnAlive.shift();
    const busy = busySmall(tick);
    const procs: ProcInfo[] = [];
    const pidsOf = new Map<number, number[]>();
    const add = (pid: number, startTicks: number, gi: number, rssKB: number, cpu: number) => {
      procs.push({
        pid, ppid: 1, name: `p${pid}`, cmdline: cmdline(pid), uid: 1000, startTicks, ageSec: 1, cpuTicks: 0, cpuPercent: cpu,
        rssKB, swapKB: 0, cwd: null, cwdDeleted: false,
      });
      pidsOf.set(gi, [...(pidsOf.get(gi) ?? []), pid]);
    };
    for (let p = 1; p <= STABLE_PROCS; p++) add(1000 + p, p, p % BIG, 80_000 + p, 0.5);
    for (const c of churnAlive) add(c.pid, c.id, c.id % BIG, 60_000, 2);
    const groups = Array.from({ length: GROUPS }, (_, i): Group => {
      const rssKB = groupBaseKB(i) + (i < BIG ? (tick % 720) * 10 : 0);
      return {
        id: `command:g${i}`, kind: 'command', label: `g${i}`, tags: [], rootName: `g${i}`, roots: [], pids: pidsOf.get(i) ?? [],
        procCount: 1, cpuPercent: i === busy ? 2 : 0.1, rssKB, swapKB: 1024, oldestAgeSec: 1, protected: false, killable: true, subgroups: [],
      };
    });
    const r = writer.writeTick({ ts, system: sys, cpuPercent: 12, groups, procs }, THRESHOLDS);
    maxGroupsPerTick = Math.max(maxGroupsPerTick, r.groups);
  }
  for (let ts = detailFrom; ts < now; ts += M) aggregateMinute(db, ts);
  for (let ts = detailFrom; ts < now; ts += H) aggregateHour(db, ts);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const tDetail = performance.now();
  console.info(`amorçage : résumés ${((tSummary - t0) / 1000).toFixed(1)} s, détail ${((tDetail - tSummary) / 1000).toFixed(1)} s`);
  expect(maxGroupsPerTick).toBeLessThanOrEqual(BIG + 2); // ~40 groupes enregistrés au lieu de 400

  // --- taille : octets par table (dbstat), ramenés à un jour ---
  const bytes = new Map<string, number>();
  const owner = (name: string) =>
    name.replace(/_ts$/, '').replace(/^sqlite_autoindex_(\w+)_\d+$/, '$1').replace(/^procs_(group|cmdline|pid)$/, 'procs').replace(/^cmdlines_hash$/, 'cmdlines');
  for (const r of db.prepare('SELECT name, SUM(pgsize) AS s FROM dbstat GROUP BY name').all() as { name: string; s: number }[]) {
    bytes.set(owner(r.name), (bytes.get(owner(r.name)) ?? 0) + r.s);
  }
  const sum = (ts: string[]) => ts.reduce((s, t) => s + (bytes.get(t) ?? 0), 0);
  const detail = sum(['system_samples', 'group_samples', 'proc_samples']);
  const summaryDays = DAYS; // minutes/heures/procs/événements couvrent les 30 jours
  const summary = sum(['system_minute', 'group_minute', 'proc_minute', 'system_hour', 'group_hour', 'procs', 'cmdlines', 'groups', 'events']);
  const perDay = summary / summaryDays;
  const MB = 1024 * 1024;
  const file = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count * 4096;
  console.info(`taille par table (Mo) : ${JSON.stringify(Object.fromEntries([...bytes].map(([k, v]) => [k, +(v / MB).toFixed(1)])))}`);
  console.info(`détail 24 h : ${(detail / MB).toFixed(0)} Mo ; résumés : ${(perDay / MB).toFixed(1)} Mo/jour ; fichier à 30 j : ${(file / MB).toFixed(0)} Mo`);
  console.info(`  dont groupes (group_minute+group_hour) : ${(sum(['group_minute', 'group_hour']) / summaryDays / MB).toFixed(2)} Mo/jour ; processus (procs+proc_minute) : ${(sum(['procs', 'proc_minute']) / summaryDays / MB).toFixed(1)} Mo/jour`);
  // lignes de commande (B2, v5) : procs + cmdlines contre l'équivalent v4 estimé (procs v5 + texte répété à chaque référence)
  const procsV5 = sum(['procs', 'cmdlines']);
  const refs = db.prepare('SELECT COUNT(*) AS n, SUM(length(CAST(c.text AS BLOB))) AS b FROM procs p JOIN cmdlines c ON c.id = p.cmdline_id').get() as { n: number; b: number };
  const distinct = (db.prepare('SELECT COUNT(*) AS n FROM cmdlines').get() as { n: number }).n;
  const procsV4 = (bytes.get('procs') ?? 0) + refs.b;
  console.info(
    `lignes de commande : ${refs.n} processus, ${distinct} lignes distinctes (${(distinct / refs.n).toFixed(2)}) ; procs + cmdlines (v5) ${(procsV5 / MB).toFixed(0)} Mo ` +
      `contre ~${(procsV4 / MB).toFixed(0)} Mo en v4 (estimé), ÷${(procsV4 / procsV5).toFixed(2)} ; fichier ${(file / MB).toFixed(0)} Mo ` +
      `contre ~${((file - procsV5 + procsV4) / MB).toFixed(0)} Mo en v4 (estimé), ÷${((file - procsV5 + procsV4) / file).toFixed(2)}`,
  );
  expect(procsV5).toBeLessThan(procsV4);
  // projection en régime établi = détail (24 h) + 30 jours de résumés ; budget large pour ne pas casser sur le bruit
  expect(sum(['group_minute', 'group_hour', 'system_minute', 'system_hour']) / summaryDays).toBeLessThan(6 * MB);
  expect(detail + 30 * perDay).toBeLessThan(1600 * MB);
  db.close();

  // --- requêtes de l'onglet Métriques, sur une connexion en lecture seule neuve comme l'app ---
  const ro = new DatabaseSync(path, { readOnly: true });
  const o = { now, detailHours: 24, intervalSec: 5 };
  for (const preset of ['1h', '6h', '24h', '7d', '30d'] as RangePreset[]) {
    const r = rangeFromPreset(preset, now);
    const times: Record<string, number> = {};
    const time = <T,>(name: string, fn: () => T): T => {
      const a = performance.now();
      const v = fn();
      times[name] = performance.now() - a;
      return v;
    };
    const sysSeries = time('system', () => querySystem(ro, r, o));
    const top = time('top', () => queryTop(ro, r, o, { peakLimit: 8 }));
    time('groups', () => queryGroups(ro, r, o, top.byMax.map((t) => t.key)));
    time('events', () => queryEvents(ro, r));
    // détail d'un groupe (B7) : pressions + fuites et kills du groupe. Premier appel à froid : en v4, chaque kill lisait au
    // hasard la table procs (lignes de ~600 octets, cmdline comprise) : 97 à 194 ms à 7 j. En v5, l'index couvrant procs_pid
    // (pid, group_id, name) répond sans lire la table : même borne de 150 ms à froid et à chaud.
    time('events g1 (froid)', () => queryEvents(ro, r, 'command:g1'));
    time('events g1', () => queryEvents(ro, r, 'command:g1'));
    time('culprits', () => queryCulprits(ro, r.from + (r.to - r.from) / 2, o));
    const total = Object.values(times).reduce((a, b) => a + b, 0);
    console.info(`${preset} : ${Object.entries(times).map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(', ')} — total ${total.toFixed(1)} ms`);
    expect(sysSeries.ts.length).toBeGreaterThan(0);
    expect(top.byAvg.length).toBe(10);
    for (const [k, v] of Object.entries(times)) expect(v, `${preset} ${k}`).toBeLessThan(150);
  }
  // --- rejeu (B5) : arbre d'un groupe à un instant, borne 50 ms, groupes à fort renouvellement ---
  const tree: Record<string, number> = {};
  const timeTree = (name: string, key: string, ts: number) => {
    const a = performance.now();
    const r = queryProcTree(ro, key, ts, o);
    tree[name] = performance.now() - a;
    expect(r.procs.length, name).toBeGreaterThan(0);
  };
  // instant aligné sur la naissance d'un processus du groupe (un toutes les ~15 s : la fenêtre de ± 5 s pourrait tomber entre deux)
  const churnStep = Math.floor((DAYS * D) / CHURN_GROUP_PROCS);
  timeTree('churn détail', 'command:churn', start + Math.ceil((now - 12 * H - start) / churnStep) * churnStep + 2000);
  timeTree('churn minute', 'command:churn', now - 10 * D);
  timeTree('g1 détail', 'command:g1', now - 12 * H);
  timeTree('g1 minute', 'command:g1', now - 10 * D);
  console.info(`procTree : ${Object.entries(tree).map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(', ')}`);
  for (const [k, v] of Object.entries(tree)) expect(v, `procTree ${k}`).toBeLessThan(50);
  ro.close();
}, 600_000);
