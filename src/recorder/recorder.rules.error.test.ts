// Une exception dans le moteur de règles ne casse pas l'échantillonnage (try séparé, jobErrors.rules).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../core/config';
import { addProc, makeProcRoot } from '../core/collector/fakeProc';
import { RULE_TEMPLATES } from '../core/rules/config';
import { createRecorder } from './recorder';

vi.mock('../core/rules/engine', async (orig) => ({
  ...(await orig<typeof import('../core/rules/engine')>()),
  evaluateRules: vi.fn(() => {
    throw new Error('règle forgée');
  }),
}));

test('exception dans evaluateRules → l’échantillon du tick est écrit, status().jobErrors.rules renseigné, aucun kill', () => {
  const base = mkdtempSync(join(tmpdir(), 'pw-rules-err-'));
  const procRoot = makeProcRoot(1000);
  writeFileSync(join(procRoot, 'meminfo'), 'MemTotal: 32000000 kB\nMemAvailable: 16000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n');
  writeFileSync(join(procRoot, 'loadavg'), '1.00 1.00 1.00 1/100 999\n');
  addProc(procRoot, { pid: 10, comm: 'node', rssKB: 100_000, cwd: '/home/u/acme' });
  const cfgDir = join(base, 'cfg');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, rules: { enabled: true, list: [{ ...RULE_TEMPLATES[0], id: 'r-v', createdAt: 0, enabled: true }] } }));
  const kill = vi.fn();
  const rec = createRecorder({ dataDir: join(base, 'data'), configDir: cfgDir, procRoot, now: () => 1_000_000, cpuCount: 4, log: () => {}, kill, selfPid: 999 });
  rec.start();
  rec.tick();
  const db = new DatabaseSync(join(base, 'data', 'metrics.db'), { readOnly: true });
  expect(db.prepare('SELECT COUNT(*) n FROM system_samples').get()).toEqual({ n: 1 });
  expect(rec.status().jobErrors?.rules).toMatch(/^règles: règle forgée/);
  expect(rec.status().jobErrors?.tick).toBeNull();
  expect(rec.status().lastSampleAt).toBe(1_000_000);
  expect(kill).not.toHaveBeenCalled();
  rec.stop();
});
