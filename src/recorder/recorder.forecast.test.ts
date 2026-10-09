// Prévision ② dans le service d'enregistrement : faux /proc (meminfo réécrit à chaque tick), fausse horloge,
// faux notificateur, faux lanceur. Aucune vraie notification, aucun vrai lancement.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import type { AlertsConfig } from '../core/alerts';
import { DEFAULT_CONFIG } from '../core/config';
import { addProc, makeProcRoot } from '../core/collector/fakeProc';
import type { Notifier, NotifyRequest } from './notify';
import { createRecorder } from './recorder';
import { readSnooze, writeSnooze } from '../core/forecast/snooze';
import { forecastSnoozePath } from '../core/paths';

const GO = 1024 * 1024;
const MIN = 60_000;

interface Opts { result?: () => Promise<string | null>; alerts?: Partial<AlertsConfig>; earlyoom?: string; memTotalGo?: number }

function setup(o: Opts = {}) {
  const base = mkdtempSync(join(tmpdir(), 'pw-rf-'));
  const procRoot = makeProcRoot(1000);
  writeFileSync(join(procRoot, 'loadavg'), '1.00 1.00 1.00 1/100 999\n');
  mkdirSync(join(procRoot, 'pressure'));
  writeFileSync(join(procRoot, 'pressure', 'memory'), 'some avg10=0.00 avg60=0 avg300=0 total=0\n');
  addProc(procRoot, { pid: 10, comm: 'chrome', rssKB: 200 * 1024 });
  const cfgDir = join(base, 'cfg');
  mkdirSync(cfgDir, { recursive: true });
  const alerts = { ...DEFAULT_CONFIG.alerts, ...o.alerts, channels: { ...DEFAULT_CONFIG.alerts.channels, ...o.alerts?.channels } };
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, alerts }));
  const earlyoomFile = join(base, 'earlyoom');
  writeFileSync(earlyoomFile, o.earlyoom ?? 'EARLYOOM_ARGS="-m 8 -s 35"\n');
  let t = 1_000_000_000;
  const notify = vi.fn((_r: NotifyRequest) => (o.result ? o.result() : Promise.resolve(null)));
  const notifier: Notifier = { notify, state: () => 'actions' };
  const launchApp = vi.fn();
  const logs: string[] = [];
  const make = () =>
    createRecorder({
      dataDir: join(base, 'data'), configDir: cfgDir, procRoot, now: () => t, cpuCount: 4, log: (m) => logs.push(m),
      notifier, launchApp, focusFile: join(base, 'data', 'app-focus.json'), earlyoomFile,
    });
  /** RAM disponible (Ko) au prochain tick ; swap à 10 % libre (sous son seuil de 35 % : la marge mémoire décide). */
  const setMem = (availKB: number) =>
    writeFileSync(join(procRoot, 'meminfo'), `MemTotal: ${(o.memTotalGo ?? 32) * GO} kB\nMemAvailable: ${Math.round(availKB)} kB\nSwapTotal: ${20 * GO} kB\nSwapFree: ${2 * GO} kB\nShmem: 0 kB\n`);
  setMem(16 * GO);
  const db = () => new DatabaseSync(join(base, 'data', 'metrics.db'), { readOnly: true });
  const forecasts = () => db().prepare("SELECT id, ts, detail FROM events WHERE type = 'forecast' ORDER BY id").all() as { id: number; ts: number; detail: string }[];
  const dataDir = join(base, 'data');
  return { make, notify, launchApp, setMem, earlyoomFile, db, forecasts, logs, dataDir, advance: (ms: number) => (t += ms), now: () => t };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** `minutes` de ticks toutes les 5 s, la RAM disponible baissant de `perMin` Ko/min depuis `from`. */
function run(s: ReturnType<typeof setup>, rec: ReturnType<ReturnType<typeof setup>['make']>, from: number, perMin: number, minutes: number): number {
  let avail = from;
  for (let i = 0; i < (minutes * 60) / 5; i++) {
    s.setMem(avail);
    rec.tick();
    s.advance(5000);
    avail += perMin / 12;
  }
  return avail;
}

test('baisse de 1 Go/min qui franchit le plancher : un seul événement forecast, une seule notification avec Libérer… et Ignorer 30 min', async () => {
  const s = setup();
  const rec = s.make();
  rec.start();
  let avail = run(s, rec, 16 * GO, -GO, 10);
  await flush();
  expect(s.forecasts()).toHaveLength(0); // marge encore au-dessus du plancher (3,2 Go) : pas d'alerte malgré l'ETA
  avail = run(s, rec, avail, -GO, 1.5);
  await flush();
  const ev = s.forecasts();
  expect(ev).toHaveLength(1);
  const detail = JSON.parse(ev[0]!.detail);
  expect(detail.etaMin).toBeGreaterThan(0);
  expect(detail.etaMin).toBeLessThan(10);
  expect(detail.body).toBe('swap 90 %');
  expect(s.notify).toHaveBeenCalledTimes(1);
  const req = s.notify.mock.calls[0]![0];
  expect(req.title).toBe('Computer Watcher — Mémoire bientôt épuisée');
  expect(req.body).toMatch(/^Mémoire épuisée dans ~\d+ min — swap 90 %$/);
  expect(req.urgency).toBe('critical');
  expect(req.actions).toEqual([{ id: 'free', label: 'Libérer…' }, { id: 'snooze', label: 'Ignorer 30 min' }]);
  expect(rec.forecast()?.etaMin).not.toBeNull();
  // 10 ticks de plus : toujours un seul
  run(s, rec, Math.max(avail, GO), -GO / 4, 10 / 12);
  await flush();
  expect(s.forecasts()).toHaveLength(1);
  expect(s.notify).toHaveBeenCalledTimes(1);
  rec.stop();
});

test('pic court (−3 Go en 40 s après 5 min stables) : ni événement ni notification', async () => {
  const s = setup();
  const rec = s.make();
  rec.start();
  run(s, rec, 6 * GO, 0, 5 + 20 / 60);
  run(s, rec, 6 * GO, -4.5 * GO, 40 / 60);
  await flush();
  expect(rec.forecast()?.etaMin ?? null).not.toBeNull();
  expect(s.forecasts()).toHaveLength(0);
  expect(s.notify).not.toHaveBeenCalled();
  rec.stop();
});

test('« Libérer… » : lance l’app sur l’alerte (--alert=<id>)', async () => {
  const s = setup({ result: async () => 'free' });
  const rec = s.make();
  rec.start();
  run(s, rec, 16 * GO, -GO, 11.5);
  await flush();
  expect(s.launchApp).toHaveBeenCalledWith([`--alert=${s.forecasts()[0]!.id}`]);
  rec.stop();
});

/**
 * Fuite lente sur une machine de 128 Go (seuil earlyoom 10,24 Go, plancher 12,8 Go) : marge sous le plancher qui baisse
 * de 150 Mo/min pendant plus de 40 min sans que la RAM disponible tombe à 0.
 */
const SLOW = { from: 12.3 * GO, perMin: -0.15 * GO };

test('« Ignorer 30 min » (cliqué 10 min après) : pas de nouvelle alerte avant 30 min après le clic', async () => {
  let click!: (v: string) => void;
  const s = setup({ memTotalGo: 128, result: () => new Promise((r) => (click = r)) });
  const rec = s.make();
  rec.start();
  let avail = run(s, rec, SLOW.from, SLOW.perMin, 6);
  await flush();
  expect(s.forecasts()).toHaveLength(1);
  const alertAt = s.forecasts()[0]!.ts;
  while (s.now() < alertAt + 10 * MIN) avail = run(s, rec, avail, SLOW.perMin, 1 / 12);
  click('snooze');
  await flush();
  // sans « Ignorer », une nouvelle alerte partirait à alertAt + 30 min ; avec, pas avant alertAt + 40 min
  while (s.now() < alertAt + 39 * MIN) avail = run(s, rec, avail, SLOW.perMin, 1 / 12);
  expect(s.forecasts()).toHaveLength(1);
  while (s.now() < alertAt + 41 * MIN) avail = run(s, rec, avail, SLOW.perMin, 1 / 12);
  expect(avail).toBeGreaterThan(0);
  expect(s.forecasts()).toHaveLength(2);
  rec.stop();
});

test('« Ignorer 30 min » survit à un redémarrage du service (fichier d’état)', async () => {
  let click!: (v: string) => void;
  const s = setup({ memTotalGo: 128, result: () => new Promise((r) => (click = r)) });
  const rec = s.make();
  rec.start();
  let avail = run(s, rec, SLOW.from, SLOW.perMin, 6);
  await flush();
  const alertAt = s.forecasts()[0]!.ts;
  while (s.now() < alertAt + 10 * MIN) avail = run(s, rec, avail, SLOW.perMin, 1 / 12);
  click('snooze');
  await flush();
  expect(readSnooze(forecastSnoozePath(s.dataDir))).toBe(s.now() + 30 * MIN);
  rec.stop();
  const rec2 = s.make();
  rec2.start();
  while (s.now() < alertAt + 39 * MIN) avail = run(s, rec2, avail, SLOW.perMin, 1 / 12);
  expect(s.forecasts()).toHaveLength(1);
  while (s.now() < alertAt + 41 * MIN) avail = run(s, rec2, avail, SLOW.perMin, 1 / 12);
  expect(s.forecasts()).toHaveLength(2);
  rec2.stop();
});

test('fichier « Ignorer » forgé (fin en 2099) : la prévision n\'est pas coupée (pas de pause perpétuelle)', async () => {
  const s = setup({ memTotalGo: 128 });
  const rec = s.make();
  rec.start();
  writeFileSync(forecastSnoozePath(s.dataDir), JSON.stringify({ snoozedUntil: 4_070_908_800_000 }));
  run(s, rec, SLOW.from, SLOW.perMin, 21);
  expect(s.forecasts()).toHaveLength(1);
  rec.stop();
});

test('« Ignorer 30 min » depuis le pop-up de l’app (fichier écrit par le main) : respecté par le service', async () => {
  const s = setup({ memTotalGo: 128 });
  const rec = s.make();
  rec.start();
  writeSnooze(forecastSnoozePath(s.dataDir), s.now() + 20 * MIN, s.now());
  let avail = run(s, rec, SLOW.from, SLOW.perMin, 19);
  expect(s.forecasts()).toHaveLength(0);
  avail = run(s, rec, avail, SLOW.perMin, 2);
  expect(s.forecasts()).toHaveLength(1);
  rec.stop();
});

test('redémarrage du service 5 min après l’alerte : aucune nouvelle alerte', async () => {
  const s = setup();
  const rec = s.make();
  rec.start();
  let avail = run(s, rec, 16 * GO, -GO, 11.5);
  rec.stop();
  expect(s.forecasts()).toHaveLength(1);
  s.advance(5 * MIN);
  const rec2 = s.make();
  rec2.start();
  avail = run(s, rec2, 6 * GO, -0.3 * GO, 10);
  await flush();
  expect(s.forecasts()).toHaveLength(1);
  expect(avail).toBeGreaterThan(0);
  rec2.stop();
});

test('canal « Rien » pour la prévision : événement enregistré, aucune notification', async () => {
  const s = setup({ alerts: { channels: { forecast: 'none' } as AlertsConfig['channels'] } });
  const rec = s.make();
  rec.start();
  run(s, rec, 16 * GO, -GO, 11.5);
  await flush();
  expect(s.forecasts()).toHaveLength(1);
  expect(s.notify).not.toHaveBeenCalled();
  rec.stop();
});

test('notificateur qui rejette : le tick suivant est normal', async () => {
  const s = setup({ result: () => Promise.reject(new Error('boom')) });
  const rec = s.make();
  rec.start();
  run(s, rec, 16 * GO, -GO, 11.5);
  await flush();
  expect(s.notify).toHaveBeenCalledTimes(1);
  rec.tick();
  expect(rec.status().lastError).toBeNull();
  expect(rec.status().lastSampleAt).toBe(s.now());
  rec.stop();
});

test('seuils earlyoom relus toutes les 10 min', () => {
  const s = setup();
  const rec = s.make();
  rec.start();
  run(s, rec, 16 * GO, 0, 5);
  const before = rec.forecast()!.marginKB;
  expect(before).toBeCloseTo(16 * GO - 0.08 * 32 * GO, -3);
  writeFileSync(s.earlyoomFile, 'EARLYOOM_ARGS="-m 20 -s 35"\n');
  rec.minuteJob();
  run(s, rec, 16 * GO, 0, 1 / 12);
  expect(rec.forecast()!.marginKB).toBeCloseTo(before, -3); // pas encore relu
  s.advance(10 * MIN);
  rec.minuteJob();
  run(s, rec, 16 * GO, 0, 5);
  expect(rec.forecast()!.marginKB).toBeCloseTo(16 * GO - 0.2 * 32 * GO, -3);
  rec.stop();
});

test('écriture de l’événement en échec durable : nouvel essai espacé (exponentiel, 5 min au plus), une ligne de journal par changement', async () => {
  const s = setup({ memTotalGo: 128 });
  const rec = s.make();
  rec.start();
  rec.tick();
  const w = new DatabaseSync(join(s.dataDir, 'metrics.db'));
  w.exec("CREATE TRIGGER no_forecast BEFORE INSERT ON events WHEN NEW.type = 'forecast' BEGIN SELECT RAISE(ABORT, 'disque plein'); END;");
  let avail = run(s, rec, SLOW.from, SLOW.perMin, 25);
  const failures = s.logs.filter((l) => l.includes('prévision'));
  // 25 min de condition tenue (≈ 250 ticks) : quelques lignes seulement (première erreur, puis délai qui change jusqu'à 5 min)
  expect(failures.length).toBeGreaterThan(0);
  expect(failures.length).toBeLessThanOrEqual(8);
  expect(failures[0]).toMatch(/disque plein/);
  expect(rec.status().lastError).toBeNull(); // le tick, lui, continue
  w.exec('DROP TRIGGER no_forecast');
  w.close();
  avail = run(s, rec, avail, SLOW.perMin, 5.5); // au plus 5 min d'attente avant le nouvel essai
  expect(s.forecasts()).toHaveLength(1);
  expect(s.logs.at(-1)).toMatch(/rétabli/);
  rec.stop();
});

test('statut : prévision « en préparation » au démarrage, « ok » ensuite, « indisponible » sans échantillons récents', () => {
  const s = setup();
  const rec = s.make();
  rec.start();
  rec.tick();
  expect(rec.status().forecast).toBe('warming');
  run(s, rec, 16 * GO, 0, 5);
  expect(rec.status().forecast).toBe('ok');
  s.advance(20 * MIN); // trou : plus aucun échantillon dans la fenêtre
  rec.tick();
  expect(rec.status().forecast).toBe('unavailable');
  rec.stop();
});
