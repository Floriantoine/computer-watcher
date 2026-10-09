import { expect, test } from 'vitest';
import { buildSunTree, sunArcs, type ScanFs, type SunNode } from './sunTree';

/** Arbre en mémoire : `{ nom: Ko }` pour un fichier, objet pour un dossier, `'->'` pour un lien, `{ dev: n, … }` pour un montage. */
type Spec = { [name: string]: number | '->' | Spec };
function memFs(spec: Spec, o: { unreadable?: string[] } = {}): ScanFs & { visited: string[] } {
  const visited: string[] = [];
  const find = (p: string): { v: number | '->' | Spec; dev: number } | null => {
    let cur: number | '->' | Spec = spec;
    let dev = 1;
    for (const part of p.split('/').filter(Boolean)) {
      if (typeof cur !== 'object') return null;
      cur = cur[part];
      if (cur === undefined) return null;
      if (typeof cur === 'object' && typeof cur.dev === 'number') dev = cur.dev;
    }
    return { v: cur, dev };
  };
  return {
    visited,
    lstat(p) {
      const f = find(p);
      if (!f) throw new Error(`ENOENT ${p}`);
      if (f.v === '->') return { isDir: false, isLink: true, dev: f.dev, blocksKB: 0 };
      if (typeof f.v === 'number') return { isDir: false, isLink: false, dev: f.dev, blocksKB: f.v };
      return { isDir: true, isLink: false, dev: f.dev, blocksKB: 0 };
    },
    readdir(p) {
      visited.push(p);
      if (o.unreadable?.includes(p)) throw new Error(`EACCES ${p}`);
      const f = find(p);
      if (!f || typeof f.v !== 'object') throw new Error(`ENOTDIR ${p}`);
      return Object.keys(f.v).filter((k) => k !== 'dev');
    },
  };
}
const opts = { maxDepth: 6, minShare: 0.005, maxEntries: 1_000_000, deadline: Infinity, now: () => 0 };
const child = (n: SunNode, name: string) => n.children.find((c) => c.name === name)!;

test('tailles agrégées par dossier, chemins complets, enfants triés par taille décroissante', () => {
  const fs = memFs({ h: { a: { x: 100, y: 300 }, b: { z: { w: 600 } }, f: 50 } });
  const { tree, truncated } = buildSunTree('/h', fs, opts);
  expect(truncated).toBe(false);
  expect(tree).toMatchObject({ name: 'h', path: '/h', sizeKB: 1050 });
  expect(tree.children.map((c) => [c.name, c.sizeKB])).toEqual([['b', 600], ['a', 400], ['f', 50]]);
  expect(child(child(tree, 'b'), 'z')).toMatchObject({ path: '/h/b/z', sizeKB: 600 });
});

test('lien symbolique : compté 0, jamais suivi', () => {
  const fs = memFs({ h: { lien: '->', a: { x: 10 } } });
  const { tree } = buildSunTree('/h', fs, opts);
  expect(tree.sizeKB).toBe(10);
  expect(fs.visited).toEqual(['/h', '/h/a']);
});

test('dossier d’un autre périphérique (montage sous HOME) : compté 0, jamais parcouru', () => {
  const fs = memFs({ h: { usb: { dev: 7, gros: 999_999 }, a: { x: 10 } } });
  const { tree } = buildSunTree('/h', fs, opts);
  expect(tree.sizeKB).toBe(10);
  expect(fs.visited).not.toContain('/h/usb');
});

test('enfants sous 0,5 % du parent fusionnés en un nœud « autres »', () => {
  const fs = memFs({ h: { gros: 10_000, p1: 20, p2: 30, moyen: 100 } });
  const { tree } = buildSunTree('/h', fs, opts);
  expect(tree.children.map((c) => [c.name, c.sizeKB, !!c.other])).toEqual([['gros', 10_000, false], ['moyen', 100, false], ['autres', 50, true]]);
});

test('profondeur limitée : les niveaux au-delà comptent dans la taille, sans nœuds', () => {
  const fs = memFs({ h: { a: { b: { c: { f: 5 } } } } });
  const { tree } = buildSunTree('/h', fs, { ...opts, maxDepth: 2 });
  expect(tree.sizeKB).toBe(5);
  expect(child(child(tree, 'a'), 'b').children).toEqual([]);
  expect(child(child(tree, 'a'), 'b').sizeKB).toBe(5);
});

test('budget d’entrées ou de temps dépassé : truncated, sans planter', () => {
  const big: Spec = {};
  for (let i = 0; i < 100; i++) big[`f${i}`] = 1;
  expect(buildSunTree('/h', memFs({ h: big }), { ...opts, maxEntries: 10 }).truncated).toBe(true);
  let t = 0;
  expect(buildSunTree('/h', memFs({ h: big }), { ...opts, deadline: 5, now: () => t++ }).truncated).toBe(true);
});

test('dossier illisible : ignoré sans planter ; progression signalée', () => {
  const seen: number[] = [];
  const fs = memFs({ h: { secret: { x: 100 }, a: { y: 10 } } }, { unreadable: ['/h/secret'] });
  const { tree } = buildSunTree('/h', fs, { ...opts, onProgress: (kb) => seen.push(kb) });
  expect(tree.sizeKB).toBe(10);
  expect(seen.at(-1)).toBe(10);
});

test('sunArcs : angles des enfants = angle du parent, ordre décroissant, profondeur limitée', () => {
  const fs = memFs({ h: { a: { x: 100, y: 300 }, b: { z: { w: 600 } }, f: 50 } });
  const { tree } = buildSunTree('/h', fs, opts);
  const arcs = sunArcs(tree, 2);
  expect(Math.max(...arcs.map((a) => a.depth))).toBe(2);
  const top = arcs.filter((a) => a.depth === 1);
  expect(top.map((a) => a.name)).toEqual(['b', 'a', 'f']);
  expect(top[0].a0).toBe(0);
  expect(top.at(-1)!.a1).toBeCloseTo(360);
  for (const p of top) {
    const kids = arcs.filter((a) => a.depth === 2 && a.path.startsWith(`${p.path}/`));
    if (!kids.length) continue;
    expect(kids[0].a0).toBeCloseTo(p.a0);
    expect(kids.reduce((s, k) => s + (k.a1 - k.a0), 0)).toBeCloseTo(p.a1 - p.a0);
  }
  const a = top.find((x) => x.name === 'a')!;
  expect(arcs.filter((x) => x.depth === 2 && x.path.startsWith('/h/a/')).map((x) => x.name)).toEqual(['y', 'x']);
  expect(a.a1 - a.a0).toBeCloseTo((400 / 1050) * 360);
  expect(sunArcs(tree, 1).every((x) => x.depth === 1)).toBe(true);
});

test('revue (note) : capTree plafonne le nombre de nœuds envoyés au renderer, surplus fusionné en « autres », tailles gardées', async () => {
  const { capTree } = await import('./sunTree');
  const count = (n: SunNode): number => 1 + n.children.reduce((s, c) => s + count(c), 0);
  const sum = (n: SunNode) => n.children.reduce((s, c) => s + c.sizeKB, 0);
  const kids = (p: string, n: number, depth: number): SunNode[] =>
    Array.from({ length: n }, (_, i) => ({ name: `d${i}`, path: `${p}/d${i}`, sizeKB: depth ? 100 * 100 : 100, children: depth ? kids(`${p}/d${i}`, 100, depth - 1) : [] }));
  const big: SunNode = { name: 'h', path: '/h', sizeKB: 300 * 100 * 100, children: kids('/h', 300, 1) };
  expect(count(big)).toBe(1 + 300 + 30_000);
  const t = capTree(big, 20_000);
  expect(count(t)).toBeLessThanOrEqual(20_000);
  expect(sum(t)).toBe(sum(big));
  for (const c of t.children) expect(sum(c) === c.sizeKB || c.children.length === 0).toBe(true);
  expect(t.children.some((c) => c.children.some((g) => g.other))).toBe(true);
  // petit arbre : inchangé
  const small: SunNode = { name: 'h', path: '/h', sizeKB: 1, children: [{ name: 'a', path: '/h/a', sizeKB: 1, children: [] }] };
  expect(capTree(small, 20_000)).toEqual(small);
});
