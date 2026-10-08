import { rmSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import type { Group, ProcInfo } from '../types';
import { addProc, makeProcRoot, writeSmapsRollup } from './fakeProc';
import { applyPss, parsePss, PssCache, pssTargets } from './pss';

const ROLLUP = `55d0c4a00000-7ffd6b5fe000 ---p 00000000 00:00 0                          [rollup]
Rss:              120000 kB
Pss:               45678 kB
Pss_Dirty:         30000 kB
Pss_Anon:          28000 kB
Pss_File:          17000 kB
Pss_Shmem:           678 kB
Shared_Clean:      70000 kB
Private_Dirty:     30000 kB
Swap:                  0 kB
SwapPss:               0 kB
`;

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

test('parsePss : champ « Pss: » de smaps_rollup en kB ; sans ligne Pss → null', () => {
  expect(parsePss(ROLLUP)).toBe(45678);
  expect(parsePss('Rss: 12 kB\nPss_Anon: 3 kB\n')).toBeNull();
  expect(parsePss('')).toBeNull();
});

const errno = (code: string) => Object.assign(new Error(code), { code });

describe('PssCache', () => {
  test('faux /proc : lecture réelle du fichier smaps_rollup', () => {
    const root = makeProcRoot();
    roots.push(root);
    addProc(root, { pid: 42, comm: 'node', rssKB: 120000, starttime: 500 });
    writeSmapsRollup(root, 42, ROLLUP);
    expect(new PssCache(root).update([{ pid: 42, startTicks: 500 }], 0)).toEqual(new Map([[42, 45678]]));
  });

  test('relu au plus toutes les 10 s par pid:startTicks ; PID réutilisé → relu ; pid non demandé → purgé', () => {
    const paths: string[] = [];
    const cache = new PssCache('/p', 10_000, (path) => {
      paths.push(path);
      return ROLLUP;
    });
    const t = [{ pid: 7, startTicks: 100 }];
    expect(cache.update(t, 1_000).get(7)).toBe(45678);
    cache.update(t, 6_000); // 5 s plus tard : en cache
    expect(paths).toEqual(['/p/7/smaps_rollup']);
    cache.update(t, 11_000); // 10 s : relu
    expect(paths.length).toBe(2);
    cache.update([{ pid: 7, startTicks: 999 }], 12_000); // même pid, autre processus
    expect(paths.length).toBe(3);
    cache.update([{ pid: 8, startTicks: 1 }], 13_000); // 7 n'est plus demandé : purgé
    cache.update([{ pid: 7, startTicks: 999 }], 14_000); // donc relu, bien que lu il y a 2 s
    expect(paths.length).toBe(5);
  });

  test.each(['EACCES', 'EPERM'])('%s (autre utilisateur, hidepid) → « denied », sans exception', (code) => {
    const cache = new PssCache('/p', 10_000, () => {
      throw errno(code);
    });
    expect(cache.update([{ pid: 1, startTicks: 1 }], 0)).toEqual(new Map([[1, 'denied']]));
  });

  test('ENOENT (mort entre deux lectures) → absent, sans exception', () => {
    const cache = new PssCache('/p', 10_000, () => {
      throw errno('ENOENT');
    });
    expect(cache.update([{ pid: 1, startTicks: 1 }], 0)).toEqual(new Map());
  });

  test('contenu sans « Pss: » (thread noyau, fichier vide) → « denied »', () => {
    const cache = new PssCache('/p', 10_000, () => '');
    expect(cache.update([{ pid: 2, startTicks: 1 }], 0).get(2)).toBe('denied');
  });

  test('relectures (entrées périmées) limitées à refreshBudgetMs par passe, les plus anciennes d\'abord ; nouveaux processus toujours lus', () => {
    let clock = 0;
    const reads: number[] = [];
    const cache = new PssCache('/p', 10_000, (path) => {
      reads.push(Number(path.split('/')[2]));
      clock += 20; // 20 ms par lecture
      return ROLLUP;
    }, { refreshBudgetMs: 15, clock: () => clock });
    const t = (pids: number[]) => pids.map((pid) => ({ pid, startTicks: 1 }));
    // premier passage : tout est lu, quel que soit le budget (rien à afficher sinon)
    cache.update(t([1, 2]), 0);
    cache.update(t([1, 2, 3]), 4_000);
    expect(reads).toEqual([1, 2, 3]);
    // à 10 s : 1 et 2 périmés ; budget (15 ms) dépassé après la 1re relecture : 2 garde sa valeur
    const r = cache.update(t([1, 2, 3]), 10_000);
    expect(reads).toEqual([1, 2, 3, 1]);
    expect(r.get(2)).toBe(45678);
    // passe suivante : 2 (le plus ancien) d'abord, puis 3 (lu à 4 s) n'est pas encore périmé
    cache.update(t([1, 2, 3]), 12_000);
    expect(reads).toEqual([1, 2, 3, 1, 2]);
    // un nouveau processus est lu même budget épuisé
    cache.update(t([1, 2, 3, 4, 5]), 14_000);
    expect(reads.slice(5)).toEqual([4, 5, 3]);
  });

  test('relecture d\'un processus mort entre deux passes (ENOENT) → retiré du résultat', () => {
    let alive = true;
    const cache = new PssCache('/p', 10_000, () => {
      if (!alive) throw errno('ENOENT');
      return ROLLUP;
    });
    cache.update([{ pid: 9, startTicks: 1 }], 0);
    alive = false;
    expect(cache.update([{ pid: 9, startTicks: 1 }], 10_000)).toEqual(new Map());
  });

  test('clear : tout est relu', () => {
    let n = 0;
    const cache = new PssCache('/p', 10_000, () => {
      n++;
      return ROLLUP;
    });
    cache.update([{ pid: 3, startTicks: 1 }], 0);
    cache.clear();
    cache.update([{ pid: 3, startTicks: 1 }], 1);
    expect(n).toBe(2);
  });

  test('défaut : lit le vrai /proc (smaps_rollup de ce processus, lisible par lui-même)', () => {
    const v = new PssCache().update([{ pid: process.pid, startTicks: 0 }], 0).get(process.pid);
    expect(typeof v).toBe('number');
    expect(v).toBeGreaterThan(0);
  });
});

const proc = (pid: number, extra: Partial<ProcInfo> = {}): ProcInfo => ({
  pid, ppid: 1, name: 'x', cmdline: 'x', uid: 1000, startTicks: pid * 10, ageSec: 10, cpuTicks: 0, cpuPercent: 0,
  rssKB: 1000, swapKB: 50, cwd: null, cwdDeleted: false, ...extra,
});

test('applyPss : nombre → rssKB remplacé (swap inchangé) ; denied → pssDenied ; absent → même objet', () => {
  const a = proc(1);
  const b = proc(2);
  const c = proc(3);
  const out = applyPss([a, b, c], new Map<number, number | 'denied'>([[1, 400], [2, 'denied']]));
  expect(out[0]).toEqual({ ...a, rssKB: 400 });
  expect(out[0]!.swapKB).toBe(50);
  expect(out[1]).toEqual({ ...b, pssDenied: true });
  expect(out[1]!.rssKB).toBe(1000);
  expect(out[2]).toBe(c);
  expect(a.rssKB).toBe(1000); // entrée non modifiée
});

const group = (id: string, procs: ProcInfo[], extra: Partial<Group> = {}): Group => ({
  id, kind: 'command', label: id, tags: [], rootName: 'x',
  roots: procs.length ? [{ proc: procs[0]!, children: procs.slice(1).map((p) => ({ proc: p, children: [] })) }] : [],
  pids: procs.map((p) => p.pid), procCount: procs.length, cpuPercent: 0, rssKB: 0, swapKB: 0, oldestAgeSec: 10,
  protected: false, killable: true, subgroups: [], ...extra,
});

describe('pssTargets', () => {
  const s1 = group('s1', [proc(5)]);
  const s2 = group('s2', [proc(6), proc(7)]);
  const groups = [group('a', [proc(1), proc(2)]), group('b', [proc(3)]), group('others', [], { kind: 'others', subgroups: [s1, s2] })];
  test('groupes de premier niveau ; « Autres » seulement si includeOthers', () => {
    expect(pssTargets(groups, false).map((p) => p.pid)).toEqual([1, 2, 3]);
    expect(pssTargets(groups, true).map((p) => p.pid)).toEqual([1, 2, 3, 5, 6, 7]);
  });
  test('sous-groupes de « Autres » retenus par alsoOthers (proches du seuil) même replié', () => {
    expect(pssTargets(groups, false, (g) => g.id === 's2').map((p) => p.pid)).toEqual([1, 2, 3, 6, 7]);
  });
});
