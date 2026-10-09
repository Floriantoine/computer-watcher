// src/recorder/recorder.test.ts
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { addProc, makeProcRoot } from '../core/collector/fakeProc';
import { SCHEMA_VERSION } from '../core/history/db';
import { procsInput } from '../core/history/testDb';
import { createRecorder } from './recorder';

// minuteJob après un saut de 31 jours rattrape et purge un mois de minutes : ≈ 2,5 s sur une machine
// calme, plus que les 5 s par défaut de Vitest sous charge (suite complète, build en parallèle).
// La borne reste finie : une boucle de rattrapage devenue quadratique échouerait toujours.
const SLOW_MS = 30_000;

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

test('un tick écrit système, groupes (petits groupes cumulés), processus au-dessus des seuils, statut', () => {
  const { rec, base, db } = setup();
  rec.start();
  rec.tick();
  const d = db();
  expect(d.prepare('SELECT COUNT(*) n FROM system_samples').get()).toEqual({ n: 1 });
  expect((d.prepare('SELECT key FROM groups ORDER BY key').all() as { key: string }[]).map((g) => g.key)).toEqual(['app:chrome', 'others:small', 'project:/home/u/acme']);
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
  writeFileSync(
    join(base, 'data', 'app-events.jsonl'),
    JSON.stringify({ ts: 1_000_100, type: 'app_kill', groupKey: 'app:chrome', detail: { pids: [10], signal: 'SIGTERM' } }) + '\n' +
      JSON.stringify({ ts: 1_000_200, type: 'earlyoom_setup', groupKey: null, detail: { mode: 'install', ok: true, code: 0 } }) + '\n' +
      JSON.stringify({ ts: 1_000_300, type: 'tmp_clean', groupKey: null, detail: { freedKB: 10, deleted: ['jest_rs'], refused: [] } }) + '\n',
  );
  advance(60_000);
  rec.minuteJob();
  expect(db().prepare('SELECT COUNT(*) n FROM group_minute').get()).toEqual({ n: 3 });
  expect(db().prepare("SELECT COUNT(*) n FROM events WHERE type='app_kill'").get()).toEqual({ n: 1 });
  expect(db().prepare("SELECT ts, detail FROM events WHERE type='earlyoom_setup'").all()).toEqual([{ ts: 1_000_200, detail: '{"mode":"install","ok":true,"code":0}' }]);
  expect(db().prepare("SELECT COUNT(*) n FROM events WHERE type='tmp_clean'").get()).toEqual({ n: 1 });
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
}, SLOW_MS);

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
}, SLOW_MS);

test('base d\'une version plus récente : statut en erreur, inactif, aucune écriture', () => {
  const { rec, base, db } = setup();
  mkdirSync(join(base, 'data'), { recursive: true });
  const p = join(base, 'data', 'metrics.db');
  const raw = new DatabaseSync(p);
  raw.exec('PRAGMA user_version = 99; CREATE TABLE x(a); INSERT INTO x VALUES(1);');
  raw.close();
  const before = readFileSync(p);
  rec.start();
  rec.tick();
  rec.minuteJob();
  const status = JSON.parse(readFileSync(join(base, 'data', 'recorder-status.json'), 'utf8'));
  expect(status.lastError).toContain('version plus récente');
  expect(status.lastSampleAt).toBeNull();
  expect(readFileSync(p).equals(before)).toBe(true);
  expect(readdirSync(join(base, 'data')).filter((f) => f.includes('.bak'))).toEqual([]);
  expect(db().prepare('SELECT a FROM x').all()).toEqual([{ a: 1 }]);
  rec.stop();
});

test('minuteJob : tables horaires alimentées (heure en cours recalculée), vidées par clear-request', () => {
  const { rec, advance, db, base } = setup();
  rec.start();
  rec.tick(); // t = 1_000_000 : heure 0
  advance(60_000);
  rec.minuteJob();
  expect(db().prepare('SELECT COUNT(*) n FROM group_hour WHERE ts = 0').get()).toEqual({ n: 3 });
  expect(db().prepare('SELECT COUNT(*) n FROM system_hour WHERE ts = 0').get()).toEqual({ n: 1 });
  advance(3600_000); // heure 0 finie, minutes rattrapées puis heure close
  rec.tick();
  advance(60_000);
  rec.minuteJob();
  expect(db().prepare('SELECT ts FROM system_hour ORDER BY ts').all()).toEqual([{ ts: 0 }, { ts: 3600_000 }]);
  writeFileSync(join(base, 'data', 'clear-request'), '');
  rec.minuteJob();
  expect(db().prepare('SELECT COUNT(*) n FROM group_hour').get()).toEqual({ n: 0 });
  rec.stop();
});

test('recorder-status.json en 0600', () => {
  const { rec, base } = setup();
  rec.start();
  rec.tick();
  expect(statSync(join(base, 'data', 'recorder-status.json')).mode & 0o777).toBe(0o600);
  rec.stop();
});

test('nettoyage des processus orphelins : une fois toutes les 10 minutes', () => {
  const { rec, advance, base } = setup();
  rec.start();
  rec.tick();
  advance(60_000);
  rec.minuteJob(); // 1er passage : nettoyage
  const w = procsInput(new DatabaseSync(join(base, 'data', 'metrics.db')));
  w.exec("INSERT INTO procs_in(id,pid,start_ticks,name,cmdline,group_id) VALUES (999,9,9,'o','o',1)");
  const orphan = () => (w.prepare('SELECT COUNT(*) n FROM procs WHERE id = 999').get() as { n: number }).n;
  for (let i = 0; i < 9; i++) {
    advance(60_000);
    rec.minuteJob();
  }
  expect(orphan()).toBe(1);
  advance(60_000);
  rec.minuteJob(); // 11e passage = 10 minutes après le précédent nettoyage
  expect(orphan()).toBe(0);
  w.close();
  rec.stop();
});

test('copies de sécurité plus vieilles que summaryDays supprimées (avec -wal/-shm), les récentes gardées', () => {
  const { rec, advance, base } = setup();
  rec.start();
  const data = join(base, 'data');
  const old = ['metrics.db.pre-v2-19691101T000000', 'metrics.db.bak-19691101T000000', 'metrics.db.bak-19691101T000000-wal'];
  const recent = ['metrics.db.pre-v3-19700101T000000', 'metrics.db.bak-19700101T000000-shm', 'metrics.db.notes'];
  for (const f of [...old, ...recent]) writeFileSync(join(data, f), 'x');
  advance(60_000);
  rec.minuteJob();
  for (const f of old) expect(existsSync(join(data, f))).toBe(false);
  for (const f of recent) expect(existsSync(join(data, f))).toBe(true);
  rec.stop();
});

test('migration sans copie de sécurité possible : avertissement dans le statut, enregistrement actif', () => {
  const { rec, base, db } = setup();
  const data = join(base, 'data');
  // base v2 : schéma d'une base neuve ramené en v2 (sans tables horaires)
  rec.start();
  rec.stop();
  const w = new DatabaseSync(join(data, 'metrics.db'));
  w.exec('DROP TABLE group_hour; DROP TABLE system_hour; PRAGMA user_version = 2;');
  w.close();
  mkdirSync(join(data, `metrics.db.pre-v${SCHEMA_VERSION}-19700101T001640`)); // la copie ne peut pas être écrite à cet endroit
  rec.start();
  rec.tick();
  const status = JSON.parse(readFileSync(join(data, 'recorder-status.json'), 'utf8'));
  expect(status.warning).toMatch(/copie de sécurité/i);
  expect(status.lastError).toBeNull();
  expect(db().prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
  rec.stop();
});

test('Shmem au-delà du seuil (4000 Mo par défaut) : un seul événement tmpfs, même après redémarrage du service', () => {
  const { rec, procRoot, advance, db } = setup();
  writeFileSync(join(procRoot, 'meminfo'), 'MemTotal: 32000000 kB\nMemAvailable: 16000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 1000000 kB\nShmem: 5000000 kB\n');
  rec.start();
  rec.tick();
  const tmpfs = () => db().prepare("SELECT detail FROM events WHERE type = 'tmpfs'").all();
  expect(tmpfs()).toEqual([{ detail: JSON.stringify({ shmemKB: 5000000, thresholdKB: 4096000 }) }]);
  expect(db().prepare('SELECT shmem_kb FROM system_samples').all()).toEqual([{ shmem_kb: 5000000 }]);
  advance(5000);
  rec.tick();
  expect(tmpfs()).toHaveLength(1);
  rec.stop();
  advance(5000);
  rec.start();
  rec.tick();
  expect(tmpfs()).toHaveLength(1);
  rec.stop();
});

test('alerte tmpfs dont l’écriture échoue : retentée au tick suivant (pas réduite au silence 1 h)', () => {
  const { rec, procRoot, advance, db, base } = setup();
  writeFileSync(join(procRoot, 'meminfo'), 'MemTotal: 32000000 kB\nMemAvailable: 16000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 1000000 kB\nShmem: 5000000 kB\n');
  rec.start();
  const w = new DatabaseSync(join(base, 'data', 'metrics.db'));
  w.exec("CREATE TRIGGER no_tmpfs BEFORE INSERT ON events WHEN NEW.type = 'tmpfs' BEGIN SELECT RAISE(FAIL, 'écriture refusée'); END");
  rec.tick();
  const tmpfs = () => db().prepare("SELECT COUNT(*) n FROM events WHERE type = 'tmpfs'").get();
  expect(tmpfs()).toEqual({ n: 0 });
  w.exec('DROP TRIGGER no_tmpfs');
  w.close();
  advance(5000);
  rec.tick();
  expect(tmpfs()).toEqual({ n: 1 });
  rec.stop();
});

test('meminfo sans ligne Shmem : shmem_kb NULL (trou dans la courbe), aucune alerte', () => {
  const { rec, db } = setup();
  rec.start();
  rec.tick();
  expect(db().prepare('SELECT shmem_kb FROM system_samples').all()).toEqual([{ shmem_kb: null }]);
  expect(db().prepare("SELECT COUNT(*) n FROM events WHERE type = 'tmpfs'").get()).toEqual({ n: 0 });
  rec.stop();
});

test('disque : une ligne disk_samples par disque réel et par tick ; libre sous le seuil 60 s → un seul disk_low, même après redémarrage', () => {
  const base = mkdtempSync(join(tmpdir(), 'pw-r-'));
  const procRoot = makeProcRoot(1000);
  writeFileSync(join(procRoot, 'meminfo'), 'MemTotal: 32000000 kB\nMemAvailable: 16000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 1000000 kB\n');
  writeFileSync(join(procRoot, 'loadavg'), '1.00 1.00 1.00 1/100 999\n');
  const GB = 1024 * 1024;
  // btrfs : / et /home sont deux sous-volumes du même disque ; tmpfs ignoré
  const mountinfo = [
    '30 1 0:28 /@ / rw,relatime shared:1 - btrfs /dev/nvme0n1p2 rw',
    '31 1 0:28 /@home /home rw,relatime shared:2 - btrfs /dev/nvme0n1p2 rw',
    '32 1 0:40 / /tmp rw shared:3 - tmpfs tmpfs rw',
  ].join('\n');
  const asked: string[] = [];
  const statfs = (m: string) => {
    asked.push(m);
    return { sizeKB: 477 * GB, availKB: 15 * GB };
  };
  let t = 1_000_000;
  const mk = () => createRecorder({ dataDir: join(base, 'data'), configDir: join(base, 'cfg'), procRoot, now: () => t, cpuCount: 4, log: () => {}, statfs, mountinfo: () => mountinfo });
  const db = () => new DatabaseSync(join(base, 'data', 'metrics.db'), { readOnly: true });
  const lows = () => db().prepare("SELECT ts, detail FROM events WHERE type = 'disk_low'").all();
  let rec = mk();
  rec.start();
  rec.tick();
  t += 30_000;
  rec.tick();
  expect(lows()).toEqual([]);
  t += 30_000;
  rec.tick();
  const threshold = Math.round(Math.max(0.1 * 477 * GB, 20 * GB));
  expect(lows()).toEqual([{ ts: 1_060_000, detail: JSON.stringify({ mount: '/', availKB: 15 * GB, sizeKB: 477 * GB, thresholdKB: threshold }) }]);
  t += 30_000;
  rec.tick();
  expect(lows()).toHaveLength(1);
  expect(db().prepare('SELECT ts, mount, size_kb, avail_kb FROM disk_samples ORDER BY ts').all()).toEqual(
    [1_000_000, 1_030_000, 1_060_000, 1_090_000].map((ts) => ({ ts, mount: '/', size_kb: 477 * GB, avail_kb: 15 * GB })),
  );
  expect(new Set(asked)).toEqual(new Set(['/']));
  rec.stop();
  // redémarrage du service, disque toujours plein : pas de doublon
  rec = mk();
  rec.start();
  for (let i = 0; i < 4; i++) {
    t += 30_000;
    rec.tick();
  }
  expect(lows()).toHaveLength(1);
  rec.stop();
});

test('disque : statfs en échec → tick normal (échantillonnage mémoire intact), erreur journalisée', () => {
  const base = mkdtempSync(join(tmpdir(), 'pw-r-'));
  const procRoot = makeProcRoot(1000);
  writeFileSync(join(procRoot, 'meminfo'), 'MemTotal: 32000000 kB\nMemAvailable: 16000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 1000000 kB\n');
  writeFileSync(join(procRoot, 'loadavg'), '1.00 1.00 1.00 1/100 999\n');
  const logs: string[] = [];
  const rec = createRecorder({
    dataDir: join(base, 'data'), configDir: join(base, 'cfg'), procRoot, now: () => 1_000_000, cpuCount: 4, log: (m) => logs.push(m),
    statfs: () => { throw new Error('EIO'); }, mountinfo: () => '30 1 8:2 / / rw - ext4 /dev/sda2 rw',
  });
  rec.start();
  rec.tick();
  const d = new DatabaseSync(join(base, 'data', 'metrics.db'), { readOnly: true });
  expect(d.prepare('SELECT COUNT(*) n FROM system_samples').get()).toEqual({ n: 1 });
  expect(d.prepare('SELECT COUNT(*) n FROM disk_samples').get()).toEqual({ n: 0 });
  expect(rec.status().lastError).toBeNull();
  expect(logs.some((l) => l.includes('disque') && l.includes('EIO'))).toBe(true);
  rec.stop();
});
