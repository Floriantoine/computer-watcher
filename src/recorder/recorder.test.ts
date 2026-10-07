// src/recorder/recorder.test.ts
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { addProc, makeProcRoot } from '../core/collector/fakeProc';
import { createRecorder } from './recorder';

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'pw-r-'));
  const procRoot = makeProcRoot(1000);
  writeFileSync(join(procRoot, 'meminfo'), 'MemTotal: 32000000 kB\nMemAvailable: 16000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 1000000 kB\n');
  writeFileSync(join(procRoot, 'loadavg'), '1.00 1.00 1.00 1/100 999\n');
  mkdirSync(join(procRoot, 'pressure'));
  writeFileSync(join(procRoot, 'pressure', 'memory'), 'some avg10=30.00 avg60=0 avg300=0 total=0\n');
  addProc(procRoot, { pid: 10, comm: 'chrome', rssKB: 200 * 1024 });
  addProc(procRoot, { pid: 11, comm: 'node', rssKB: 80 * 1024, cwd: '/home/u/acme' });
  addProc(procRoot, { pid: 12, comm: 'sleep', rssKB: 100 });
  let t = 1_000_000;
  const rec = createRecorder({ dataDir: join(base, 'data'), configDir: join(base, 'cfg'), procRoot, now: () => t, cpuCount: 4, log: () => {} });
  return { rec, base, procRoot, advance: (ms: number) => (t += ms), db: () => new DatabaseSync(join(base, 'data', 'metrics.db'), { readOnly: true }) };
}

test('un tick écrit système, groupes, processus au-dessus des seuils, statut', () => {
  const { rec, base, db } = setup();
  rec.start();
  rec.tick();
  const d = db();
  expect(d.prepare('SELECT COUNT(*) n FROM system_samples').get()).toEqual({ n: 1 });
  expect((d.prepare('SELECT key FROM groups ORDER BY key').all() as { key: string }[]).map((g) => g.key)).toEqual(['app:chrome', 'command:sleep', 'project:/home/u/acme']);
  expect((d.prepare('SELECT pid FROM procs ORDER BY pid').all() as { pid: number }[]).map((p) => p.pid)).toEqual([10, 11]);
  expect(d.prepare("SELECT type FROM events").all()).toEqual([{ type: 'pressure' }]);
  const status = JSON.parse(readFileSync(join(base, 'data', 'recorder-status.json'), 'utf8'));
  expect(status).toMatchObject({ lastSampleAt: 1_000_000, lastError: null, earlyoomSource: 'unavailable' });
  rec.stop();
});

test('trou : redémarrage après 1 min sans échantillon → événement gap', () => {
  const { rec, advance, db, base, procRoot } = setup();
  rec.start();
  rec.tick();
  rec.stop();
  advance(60_000);
  const rec2 = createRecorder({ dataDir: join(base, 'data'), configDir: join(base, 'cfg'), procRoot, now: () => 1_060_000, cpuCount: 4, log: () => {} });
  rec2.start();
  expect(db().prepare("SELECT type, detail FROM events WHERE type = 'gap'").all()).toEqual([{ type: 'gap', detail: '{"from":1000000,"to":1060000}' }]);
  rec2.stop();
});

test('exception dans un tick : consignée, tick suivant normal', () => {
  const { rec, base, procRoot } = setup();
  rec.start();
  const meminfo = readFileSync(join(procRoot, 'meminfo'), 'utf8');
  rmSync(join(procRoot, 'meminfo')); // readSystem lève ENOENT
  expect(() => rec.tick()).not.toThrow();
  expect(JSON.parse(readFileSync(join(base, 'data', 'recorder-status.json'), 'utf8')).lastError).toMatch(/^tick: /);
  writeFileSync(join(procRoot, 'meminfo'), meminfo);
  rec.tick();
  expect(JSON.parse(readFileSync(join(base, 'data', 'recorder-status.json'), 'utf8')).lastError).toBeNull();
  rec.stop();
});

test('ligne earlyoom → événement earlyoom_kill', () => {
  const { rec, db } = setup();
  rec.start();
  rec.tick();
  rec.setEarlyoomSource('ok');
  rec.onEarlyoomLine(JSON.stringify({ __REALTIME_TIMESTAMP: '1000500000', MESSAGE: 'sending SIGTERM to process 10 uid 1000 "chrome": oom_score 600' }));
  rec.onEarlyoomLine(JSON.stringify({ __REALTIME_TIMESTAMP: '1000600000', MESSAGE: 'mem avail: 10 MiB' }));
  expect(db().prepare("SELECT ts, detail FROM events WHERE type='earlyoom_kill'").all()).toEqual([
    { ts: 1_000_500, detail: '{"signal":"SIGTERM","pid":10,"uid":1000,"name":"chrome"}' },
  ]);
  expect(rec.status().earlyoomSource).toBe('ok');
  rec.stop();
});

test('minuteJob : agrège, purge, ingère les événements de l\'app, traite clear-request', () => {
  const { rec, advance, db, base } = setup();
  rec.start();
  rec.tick();
  writeFileSync(join(base, 'data', 'app-events.jsonl'), JSON.stringify({ ts: 1_000_100, type: 'app_kill', groupKey: 'app:chrome', detail: { pids: [10], signal: 'SIGTERM' } }) + '\n');
  advance(60_000);
  rec.minuteJob();
  expect(db().prepare('SELECT COUNT(*) n FROM group_minute').get()).toEqual({ n: 3 });
  expect(db().prepare("SELECT COUNT(*) n FROM events WHERE type='app_kill'").get()).toEqual({ n: 1 });
  writeFileSync(join(base, 'data', 'clear-request'), '');
  rec.minuteJob();
  expect(db().prepare('SELECT COUNT(*) n FROM system_samples').get()).toEqual({ n: 0 });
  rec.stop();
});

test('après une purge qui supprime un processus en cache, le tick suivant recrée sa ligne procs', () => {
  const { rec, advance, db } = setup();
  rec.start();
  rec.tick();
  advance(31 * 86400_000); // au-delà de summaryDays (30 j) : samples, minutes et procs sont purgés
  rec.minuteJob(); // purge : procs/proc_samples anciens supprimés, cache du writer oublié
  expect(db().prepare('SELECT COUNT(*) n FROM procs').get()).toEqual({ n: 0 });
  rec.tick();
  expect(db().prepare('SELECT COUNT(*) n FROM procs').get()).toEqual({ n: 2 });
  expect(db().prepare('SELECT COUNT(*) n FROM proc_samples WHERE proc_id NOT IN (SELECT id FROM procs)').get()).toEqual({ n: 0 });
  expect(db().prepare('SELECT COUNT(*) n FROM proc_samples').get()).toEqual({ n: 2 });
  rec.stop();
});

test('redémarrage : la minute en cours à l\'arrêt est agrégée', () => {
  const { rec, db, base, procRoot } = setup();
  rec.start();
  rec.tick(); // t = 1_000_000 (minute 960_000)
  rec.stop();
  const rec2 = createRecorder({ dataDir: join(base, 'data'), configDir: join(base, 'cfg'), procRoot, now: () => 1_000_000 + 5 * 60_000, cpuCount: 4, log: () => {} });
  rec2.start();
  rec2.minuteJob();
  expect(db().prepare('SELECT COUNT(*) n FROM group_minute WHERE ts = 960000').get()).toEqual({ n: 3 });
  rec2.stop();
});

test('une étape de minuteJob en échec ne bloque pas la purge ; erreurs par travail', () => {
  const { rec, advance, db, base } = setup();
  rec.start();
  rec.tick();
  // échec simulé : un dossier à la place du fichier d'événements de l'app
  mkdirSync(join(base, 'data', 'app-events.jsonl'));
  advance(31 * 86400_000);
  rec.minuteJob();
  const s = rec.status();
  expect(s.jobErrors?.minute).toMatch(/^minute: événements app/);
  expect(s.lastError).toMatch(/^minute: /);
  expect(db().prepare('SELECT COUNT(*) n FROM system_samples').get()).toEqual({ n: 0 }); // purge exécutée malgré tout
  rec.stop();
});
