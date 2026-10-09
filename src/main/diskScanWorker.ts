// Processus enfant du parcours du dossier personnel (soleil de la page Disque) : basse priorité, lecture seule, jamais de
// lien suivi ni de montage traversé (buildSunTree). Messages : reçoit `scan`, envoie `progress` puis `done` ou `error`.
import { lstatSync, readdirSync } from 'node:fs';
import { getPriority, setPriority } from 'node:os';
import { buildSunTree, capTree, type ScanFs } from '../core/disk/sunTree';

export interface ScanRequest {
  type: 'scan'; root: string; nice: number; maxDepth: number; minShare: number; maxEntries: number; budgetMs: number;
  /** Tests : attente avant le parcours. */
  startDelayMs?: number;
}

const realFs: ScanFs = {
  lstat(p) {
    const s = lstatSync(p);
    return { isDir: s.isDirectory(), isLink: s.isSymbolicLink(), dev: s.dev, blocksKB: s.blocks / 2 };
  },
  readdir: (p) => readdirSync(p),
};

const PROGRESS_MS = 250;

function run(req: ScanRequest): void {
  try {
    setPriority(0, req.nice);
  } catch {
    // priorité déjà plus basse, ou refusée : on continue
  }
  const send = (m: unknown) => process.send?.(m);
  let last = 0;
  const { tree, truncated } = buildSunTree(req.root, realFs, {
    maxDepth: req.maxDepth, minShare: req.minShare, maxEntries: req.maxEntries, deadline: Date.now() + req.budgetMs, now: Date.now,
    onProgress: (kb) => {
      const t = Date.now();
      if (t - last < PROGRESS_MS) return;
      last = t;
      send({ type: 'progress', kb });
    },
  });
  send({ type: 'progress', kb: tree.sizeKB });
  process.send?.({ type: 'done', tree: capTree(tree), truncated, priority: getPriority(0) }, () => process.disconnect?.());
}

process.on('message', (m: ScanRequest) => {
  if (!m || m.type !== 'scan' || typeof m.root !== 'string') return;
  const go = () => {
    try {
      run(m);
    } catch (e) {
      process.send?.({ type: 'error', message: (e as Error).message ?? String(e) }, () => process.disconnect?.());
    }
  };
  if (m.startDelayMs) setTimeout(go, m.startDelayMs);
  else go();
});
