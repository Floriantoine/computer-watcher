import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createScanCache, scanHome } from './diskScan';

/** Le processus enfant charge le point d'entrée TypeScript (en production : diskScanWorker.js construit). */
function runner(dir: string): string {
  const p = join(dir, 'runner.mjs');
  writeFileSync(p, `import { registerHooks } from 'node:module';
registerHooks({ resolve(spec, ctx, next) { try { return next(spec, ctx); } catch (e) { if (spec.startsWith('.')) return next(spec + '.ts', ctx); throw e; } } });
await import(${JSON.stringify(join(__dirname, 'diskScanWorker.ts'))});`);
  return p;
}

function tree() {
  const base = mkdtempSync(join(tmpdir(), 'pw-scan-'));
  const home = join(base, 'home');
  mkdirSync(join(home, 'a', 'b'), { recursive: true });
  writeFileSync(join(home, 'a', 'b', 'gros'), Buffer.alloc(1024 * 1024, 1));
  writeFileSync(join(home, 'petit'), 'x');
  symlinkSync('/', join(home, 'racine'));
  return { base, home };
}

test('scanHome : processus enfant à basse priorité, taille ≈ 1 Mo, lien vers / ignoré, progression', async () => {
  const { base, home } = tree();
  const ioniced: number[] = [];
  const progress: number[] = [];
  const r = await scanHome(home, { onProgress: (kb) => progress.push(kb), signal: new AbortController().signal }, {
    workerPath: runner(base), ionice: (pid) => ioniced.push(pid),
  });
  expect(r.tree.sizeKB).toBeGreaterThanOrEqual(1024);
  expect(r.tree.sizeKB).toBeLessThan(1200);
  expect(r.tree.children.map((c) => c.name)).not.toContain('racine');
  expect(r.tree.children[0]).toMatchObject({ name: 'a', path: join(home, 'a') });
  expect(r.truncated).toBe(false);
  expect(r.priority).toBe(19);
  expect(ioniced).toHaveLength(1);
  expect(ioniced[0]).toBeGreaterThan(0);
  expect(progress.at(-1)).toBeGreaterThanOrEqual(1024);
});

test('scanHome : AbortSignal → processus enfant tué par son PID, promesse rejetée', async () => {
  const { base, home } = tree();
  const ac = new AbortController();
  let pid = 0;
  const p = scanHome(home, { onProgress: () => {}, signal: ac.signal }, {
    workerPath: runner(base), ionice: (x) => {
      pid = x;
      ac.abort();
    },
    // le processus enfant attend avant de parcourir : l'annulation arrive pendant le parcours
    startDelayMs: 2000,
  });
  await expect(p).rejects.toThrow(/annulé/);
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow(); // plus vivant
});

test('cache de 10 min, une seule exécution à la fois, annulé 30 s après avoir quitté la page', async () => {
  let t = 0;
  const timers: { fn: () => void; at: number }[] = [];
  let runs = 0;
  const signals: AbortSignal[] = [];
  const cache = createScanCache({
    now: () => t,
    setTimeout: (fn, ms) => {
      const h = { fn, at: t + ms };
      timers.push(h);
      return h;
    },
    clearTimeout: (h) => timers.splice(timers.indexOf(h as never), 1),
    scan: (_o, signal) => {
      runs++;
      signals.push(signal);
      return new Promise((res, rej) => {
        signal.addEventListener('abort', () => rej(new Error('annulé')));
        queueMicrotask(() => res({ tree: { name: 'h', path: '/h', sizeKB: runs, children: [] }, truncated: false, at: t, priority: 19 }));
      });
    },
  });
  const a = cache.scan(() => {});
  const b = cache.scan(() => {});
  expect((await a).tree.sizeKB).toBe(1);
  expect((await b).tree.sizeKB).toBe(1);
  t += 9 * 60_000;
  expect((await cache.scan(() => {})).tree.sizeKB).toBe(1); // cache
  t += 2 * 60_000;
  expect((await cache.scan(() => {}, { force: false })).tree.sizeKB).toBe(2); // > 10 min
  expect((await cache.scan(() => {}, { force: true })).tree.sizeKB).toBe(3); // « Actualiser »
  expect(runs).toBe(3);
  // page quittée pendant un parcours : annulé après 30 s seulement
  cache.clear();
  const c = cache.scan(() => {});
  cache.leave();
  expect(timers.at(-1)!.at - t).toBe(30_000);
  timers.at(-1)!.fn();
  await expect(c).rejects.toThrow(/annulé/);
  expect(signals.at(-1)!.aborted).toBe(true);
});
