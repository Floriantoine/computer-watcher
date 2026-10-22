// Alerte tmpfs : bouton « Vider les caches (X) » de la notification du bureau, vidage par le service au clic (faux
// notificateur, faux caches : rien n'est mesuré ni supprimé pour de vrai ici).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../core/config';
import { addProc, makeProcRoot } from '../core/collector/fakeProc';
import type { TmpCacheId, TmpCaches, TmpCachesOutcome } from '../core/tmpCaches';
import type { Notifier, NotifyRequest } from './notify';
import { createRecorder } from './recorder';

const GB = 1024 * 1024;
const JEST: TmpCaches = { root: '/tmp', caches: [{ id: 'jest', name: 'jest_rs', sizeKB: 5 * GB, atLeast: false, refusal: null }] };

function setup(o: { caches?: TmpCaches | 'reject' | 'hang'; shmemKB?: number; channel?: 'pressure'; result?: string | null } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'pw-rtc-'));
  const procRoot = makeProcRoot(1000);
  writeFileSync(join(procRoot, 'meminfo'), `MemTotal: 32000000 kB\nMemAvailable: 16000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 1000000 kB\nShmem: ${o.shmemKB ?? 5000000} kB\n`);
  writeFileSync(join(procRoot, 'loadavg'), '1.00 1.00 1.00 1/100 999\n');
  mkdirSync(join(procRoot, 'pressure'));
  writeFileSync(join(procRoot, 'pressure', 'memory'), 'some avg10=30.00 avg60=0 avg300=0 total=0\n');
  addProc(procRoot, { pid: 10, comm: 'chrome', rssKB: 200 * 1024 });
  const cfgDir = join(base, 'cfg');
  mkdirSync(cfgDir, { recursive: true });
  const channels = { ...DEFAULT_CONFIG.alerts.channels, ...(o.channel ? { [o.channel]: 'both' } : {}) };
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, alerts: { ...DEFAULT_CONFIG.alerts, channels } }));
  const notify = vi.fn(async (r: NotifyRequest) => (r.actions.some((a) => a.id === 'empty-caches') ? (o.result ?? null) : null));
  const notifier: Notifier = { notify, state: () => 'actions' };
  const measure = vi.fn(async () => {
    if (o.caches === 'reject') throw new Error('EACCES');
    if (o.caches === 'hang') return new Promise<TmpCaches>(() => {});
    return o.caches ?? JEST;
  });
  const outcome: TmpCachesOutcome = { results: [{ id: 'jest', name: 'jest_rs', ok: true, freedKB: 5 * GB }], freedKB: 5 * GB };
  const empty = vi.fn(async (_ids: TmpCacheId[]) => outcome);
  const rec = createRecorder({
    dataDir: join(base, 'data'), configDir: cfgDir, procRoot, now: () => 1_000_000, cpuCount: 4, log: () => {},
    notifier, launchApp: vi.fn(), focusFile: join(base, 'data', 'app-focus.json'), tmpCaches: { measure, empty },
  });
  const db = () => new DatabaseSync(join(base, 'data', 'metrics.db'), { readOnly: true });
  return { rec, notify, measure, empty, db };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

test('alerte tmpfs : caches mesurés avant l’envoi, « Vider le cache Jest (5,0 Go) » à côté de « Ouvrir »', async () => {
  const s = setup();
  s.rec.start();
  s.rec.tick();
  await settle();
  expect(s.measure).toHaveBeenCalledTimes(1);
  expect(s.notify).toHaveBeenCalledTimes(1);
  expect(s.notify.mock.calls[0]![0]).toMatchObject({
    title: 'Computer Watcher — Fichiers en mémoire', urgency: 'critical',
    actions: [{ id: 'open', label: 'Ouvrir' }, { id: 'empty-caches', label: 'Vider le cache Jest (5,0 Go)' }],
  });
  expect(s.empty).not.toHaveBeenCalled();
  s.rec.stop();
});

test('clic sur « Vider… » : le service vide les caches proposés, note un tmp_clean et notifie le résultat', async () => {
  const s = setup({ result: 'empty-caches' });
  s.rec.start();
  s.rec.tick();
  await settle();
  expect(s.empty).toHaveBeenCalledWith(['jest']);
  expect(s.notify).toHaveBeenCalledTimes(2);
  expect(s.notify.mock.calls[1]![0]).toEqual({ title: 'Computer Watcher — Fichiers en mémoire', body: 'Cache Jest vidé : 5,0 Go libérés', urgency: 'normal', actions: [] });
  const ev = s.db().prepare("SELECT detail FROM events WHERE type = 'tmp_clean'").get() as { detail: string };
  expect(JSON.parse(ev.detail)).toEqual({ freedKB: 5 * GB, deleted: ['jest_rs'], refused: [] });
  s.rec.stop();
});

test('moins de 100 Mo vidables, ou mesure en échec : notification sans ce bouton', async () => {
  for (const caches of [{ root: '/tmp', caches: [{ id: 'jest' as const, name: 'jest_rs', sizeKB: 1024, atLeast: false, refusal: null }] }, 'reject' as const]) {
    const s = setup({ caches });
    s.rec.start();
    s.rec.tick();
    await settle();
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.notify.mock.calls[0]![0].actions).toEqual([{ id: 'open', label: 'Ouvrir' }]);
    s.rec.stop();
  }
});

test('autres alertes : aucune mesure des caches', async () => {
  const s = setup({ shmemKB: 1000, channel: 'pressure' });
  s.rec.start();
  s.rec.tick();
  await settle();
  expect(s.notify).toHaveBeenCalledTimes(1);
  expect(s.notify.mock.calls[0]![0].title).toBe('Computer Watcher — Pression mémoire');
  expect(s.measure).not.toHaveBeenCalled();
  s.rec.stop();
});

test('mesure qui ne rend jamais la main (système de fichiers bloqué) : l’alerte part quand même, sans le bouton, après 5 s', async () => {
  vi.useFakeTimers();
  try {
    const s = setup({ caches: 'hang' });
    s.rec.start();
    s.rec.tick();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(s.notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.notify.mock.calls[0]![0].actions).toEqual([{ id: 'open', label: 'Ouvrir' }]);
    s.rec.stop();
  } finally {
    vi.useRealTimers();
  }
});
