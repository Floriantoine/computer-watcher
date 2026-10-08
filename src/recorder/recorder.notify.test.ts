// Notifications du bureau émises par le service d'enregistrement (faux notificateur, fausse horloge).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../core/config';
import { addProc, makeProcRoot } from '../core/collector/fakeProc';
import type { AlertsConfig } from '../core/alerts';
import type { Notifier, NotifyRequest } from './notify';
import { createRecorder } from './recorder';

function setup(o: { alerts?: Partial<AlertsConfig>; launch?: boolean; result?: string | null; reject?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'pw-rn-'));
  const procRoot = makeProcRoot(1000);
  writeFileSync(join(procRoot, 'meminfo'), 'MemTotal: 32000000 kB\nMemAvailable: 16000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 1000000 kB\n');
  writeFileSync(join(procRoot, 'loadavg'), '1.00 1.00 1.00 1/100 999\n');
  mkdirSync(join(procRoot, 'pressure'));
  writeFileSync(join(procRoot, 'pressure', 'memory'), 'some avg10=30.00 avg60=0 avg300=0 total=0\n');
  addProc(procRoot, { pid: 10, comm: 'chrome', rssKB: 200 * 1024 });
  const cfgDir = join(base, 'cfg');
  mkdirSync(cfgDir, { recursive: true });
  const alerts = { ...DEFAULT_CONFIG.alerts, ...o.alerts, channels: { ...DEFAULT_CONFIG.alerts.channels, ...o.alerts?.channels } };
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, alerts }));
  let t = 1_000_000;
  const notify = vi.fn(async (_r: NotifyRequest) => {
    if (o.reject) throw new Error('boom');
    return o.result ?? null;
  });
  const notifier: Notifier = { notify, state: () => 'actions' };
  const launchApp = vi.fn();
  const rec = createRecorder({
    dataDir: join(base, 'data'), configDir: cfgDir, procRoot, now: () => t, cpuCount: 4, log: () => {},
    notifier, launchApp: o.launch === false ? undefined : launchApp,
  });
  const db = () => new DatabaseSync(join(base, 'data', 'metrics.db'), { readOnly: true });
  return { rec, notify, launchApp, base, advance: (ms: number) => (t += ms), now: () => t, db };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('canal « both » : une notification critique avec « Ouvrir » ; « Ouvrir » lance l’app sur --alert=<id>', async () => {
  const s = setup({ alerts: { channels: { pressure: 'both' } as AlertsConfig['channels'] }, result: 'open' });
  s.rec.start();
  s.rec.tick();
  await flush();
  expect(s.notify).toHaveBeenCalledTimes(1);
  expect(s.notify.mock.calls[0]![0]).toMatchObject({
    title: 'Pression mémoire 30 %', urgency: 'critical', actions: [{ id: 'open', label: 'Ouvrir' }],
  });
  const { id } = s.db().prepare("SELECT id FROM events WHERE type = 'pressure'").get() as { id: number };
  expect(s.launchApp).toHaveBeenCalledWith([`--alert=${id}`]);
  s.rec.stop();
});

test('défauts : pression = pop-up seulement → aucune notification du bureau', async () => {
  const s = setup();
  s.rec.start();
  s.rec.tick();
  await flush();
  expect(s.db().prepare("SELECT COUNT(*) n FROM events WHERE type = 'pressure'").get()).toEqual({ n: 1 });
  expect(s.notify).not.toHaveBeenCalled();
  s.rec.stop();
});

test('canal « none » : rien', async () => {
  const s = setup({ alerts: { channels: { earlyoom_kill: 'none' } as AlertsConfig['channels'] } });
  s.rec.start();
  s.rec.onEarlyoomLine(JSON.stringify({ __REALTIME_TIMESTAMP: '1000500000', MESSAGE: 'sending SIGTERM to process 10 uid 1000 "chrome": oom_score 600' }));
  await flush();
  expect(s.notify).not.toHaveBeenCalled();
  s.rec.stop();
});

test('kill earlyoom (défaut both) : notification « earlyoom a arrêté chrome »', async () => {
  const s = setup();
  s.rec.start();
  s.rec.onEarlyoomLine(JSON.stringify({ __REALTIME_TIMESTAMP: '1000500000', MESSAGE: 'sending SIGTERM to process 10 uid 1000 "chrome": oom_score 600' }));
  await flush();
  expect(s.notify).toHaveBeenCalledTimes(1);
  expect(s.notify.mock.calls[0]![0].title).toBe('earlyoom a arrêté chrome');
  s.rec.stop();
});

test('anti-spam (fausse horloge) : une notification par type par intervalle (5 min)', async () => {
  const s = setup({ alerts: { channels: { pressure: 'both' } as AlertsConfig['channels'] } });
  s.rec.start();
  for (let i = 0; i <= 10; i++) {
    s.rec.tick(); // pression enregistrée au plus une fois par minute
    s.advance(60_000);
  }
  await flush();
  expect(s.db().prepare("SELECT COUNT(*) n FROM events WHERE type = 'pressure'").get()).toEqual({ n: 11 });
  // t = 0, 5 min, 10 min
  expect(s.notify).toHaveBeenCalledTimes(3);
  s.rec.stop();
});

test('anti-spam réglable : 1 min → une notification par événement minute', async () => {
  const s = setup({ alerts: { channels: { pressure: 'both' } as AlertsConfig['channels'], desktopMinIntervalMin: 1 } });
  s.rec.start();
  for (let i = 0; i < 4; i++) {
    s.rec.tick();
    s.advance(60_000);
  }
  await flush();
  expect(s.notify).toHaveBeenCalledTimes(4);
  s.rec.stop();
});

test('app au premier plan (état frais < 10 s) : pas de notification ; état périmé : notification', async () => {
  const s = setup({ alerts: { channels: { pressure: 'both' } as AlertsConfig['channels'], desktopMinIntervalMin: 1 } });
  s.rec.start();
  writeFileSync(join(s.base, 'data', 'app-focus.json'), JSON.stringify({ focused: true, ts: s.now() - 9_000 }));
  s.rec.tick();
  await flush();
  expect(s.notify).not.toHaveBeenCalled();
  s.advance(60_000); // l'état date maintenant de 69 s : l'app a fermé ou planté
  s.rec.tick();
  await flush();
  expect(s.notify).toHaveBeenCalledTimes(1);
  // fenêtre sans focus : notification
  s.advance(60_000);
  writeFileSync(join(s.base, 'data', 'app-focus.json'), JSON.stringify({ focused: false, ts: s.now() }));
  s.rec.tick();
  await flush();
  expect(s.notify).toHaveBeenCalledTimes(2);
  s.rec.stop();
});

test('notification supprimée par le premier plan : ne consomme pas l’intervalle anti-spam', async () => {
  const s = setup({ alerts: { channels: { pressure: 'both' } as AlertsConfig['channels'] } });
  s.rec.start();
  writeFileSync(join(s.base, 'data', 'app-focus.json'), JSON.stringify({ focused: true, ts: s.now() }));
  s.rec.tick();
  s.advance(60_000);
  writeFileSync(join(s.base, 'data', 'app-focus.json'), JSON.stringify({ focused: false, ts: s.now() }));
  s.rec.tick();
  await flush();
  expect(s.notify).toHaveBeenCalledTimes(1);
  s.rec.stop();
});

test('sans lanceur d’app : notification sans action', async () => {
  const s = setup({ launch: false });
  s.rec.start();
  s.rec.onEarlyoomLine(JSON.stringify({ __REALTIME_TIMESTAMP: '1000500000', MESSAGE: 'sending SIGKILL to process 10 uid 1000 "chrome": oom_score 600' }));
  await flush();
  expect(s.notify.mock.calls[0]![0].actions).toEqual([]);
  s.rec.stop();
});

test('notificateur qui rejette : le tick suivant est normal', async () => {
  const s = setup({ alerts: { channels: { pressure: 'both' } as AlertsConfig['channels'] }, reject: true });
  s.rec.start();
  s.rec.tick();
  await flush();
  s.advance(5000);
  s.rec.tick();
  expect(s.rec.status().lastError).toBeNull();
  expect(s.rec.status().lastSampleAt).toBe(s.now());
  s.rec.stop();
});

test('alerte vieille de plus de 5 min (ligne de journal en retard) : pas de notification', async () => {
  const s = setup();
  s.rec.start();
  s.advance(10 * 60_000);
  s.rec.onEarlyoomLine(JSON.stringify({ __REALTIME_TIMESTAMP: '1000500000', MESSAGE: 'sending SIGTERM to process 10 uid 1000 "chrome": oom_score 600' }));
  await flush();
  expect(s.notify).not.toHaveBeenCalled();
  s.rec.stop();
});

test('notifyAlert (canal pour la prévision ②) : public, applique canal et anti-spam', async () => {
  const s = setup();
  s.rec.start();
  const ev = { id: 7, ts: s.now(), type: 'forecast' as const, groupKey: null, groupLabel: null, detail: { etaMin: 7.6 } };
  s.rec.notifyAlert(ev);
  s.rec.notifyAlert({ ...ev, id: 8 });
  await flush();
  expect(s.notify).toHaveBeenCalledTimes(1);
  expect(s.notify.mock.calls[0]![0].title).toBe('Mémoire épuisée dans ~8 min');
  s.rec.stop();
});

test('rechargement de la config : nouveaux canaux pris en compte', async () => {
  const s = setup();
  s.rec.start();
  writeFileSync(join(s.base, 'cfg', 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, alerts: { ...DEFAULT_CONFIG.alerts, channels: { ...DEFAULT_CONFIG.alerts.channels, pressure: 'both' } } }));
  s.rec.reloadConfig();
  s.rec.tick();
  await flush();
  expect(s.notify).toHaveBeenCalledTimes(1);
  s.rec.stop();
});
