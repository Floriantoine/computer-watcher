// État d'exemple pour les tests (service, main, renderer). Noms neutres.
import type { AntigelState } from './state';

export const sampleState = (o: Partial<AntigelState> = {}): AntigelState => ({
  version: 1, at: 1_000_000, enabled: true, status: 'active', reason: null, memTotalKB: 16 * 1024 * 1024, reserveKB: 4 * 1024 * 1024,
  slice: { currentKB: 2 * 1024 * 1024, highKB: 12 * 1024 * 1024, maxKB: 14 * 1024 * 1024, swapMaxKB: 4 * 1024 * 1024, throttles: 3, oomKills: 0 },
  projects: [{ unit: 'cwatch-p-alpha.slice', root: '/home/u/alpha', procs: 3, currentKB: 1024 * 1024, budgetMB: null, throttled: false }],
  scopes: { 'cwatch-p-alpha.slice': '/home/u/alpha', 'cwatch-p-autres.slice': null }, lastError: null, tickMs: 0.4, dbusCalls: 2, ...o,
});
