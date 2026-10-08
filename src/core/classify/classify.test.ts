import { describe, expect, it } from 'vitest';
import { classifyGroups, decide, type ClassifyContext } from './classify';
import { group, node, proc } from './testFixtures';
import type { PackageHints } from './packageJson';

const pkg: PackageHints = { front: true, back: false, scripts: { dev: 'vite --port 1', build: 'tsc' } };
const base = { overrideKey: 'k', overrides: {}, match: null, ports: [], chainText: 'vite', pkg: null };

describe('decide', () => {
  it('override > commande > port > package > unknown', () => {
    const match = { category: 'worker' as const, label: 'w' };
    const all = { ...base, overrides: { k: 'ai' as const }, match, ports: [5432], pkg };
    expect(decide(all)).toEqual({ category: 'ai', source: 'manual' });
    expect(decide({ ...all, overrides: {} })).toEqual({ category: 'worker', source: 'command' });
    expect(decide({ ...all, overrides: {}, match: null })).toEqual({ category: 'db', source: 'port' });
    expect(decide({ ...all, overrides: {}, match: null, ports: [] })).toEqual({ category: 'front', source: 'package' });
    expect(decide(base)).toEqual({ category: 'unknown', source: 'unknown' });
  });
  it('package back', () => {
    expect(decide({ ...base, pkg: { front: false, back: true, scripts: {} } })).toEqual({ category: 'back', source: 'package' });
  });
  it('script dev contenant la chaîne -> catégorie de la règle du script', () => {
    const r = decide({ ...base, pkg: { front: false, back: true, scripts: { dev: 'vite --port 1' } }, matchScript: () => ({ category: 'front', label: 'Vite' }) });
    expect(r).toEqual({ category: 'front', source: 'package' });
  });
  it('script non dev/start ignoré, chaîne vide ignorée', () => {
    const p = { front: false, back: true, scripts: { build: 'vite build' } };
    const ms = () => ({ category: 'build' as const, label: 'x' });
    expect(decide({ ...base, pkg: p, matchScript: ms }).category).toBe('back');
    expect(decide({ ...base, chainText: '', pkg: { ...p, scripts: { dev: 'vite' } }, matchScript: ms }).category).toBe('back');
  });
  it('clé override héritée du prototype ignorée', () => {
    expect(decide({ ...base, overrideKey: 'toString' }).source).toBe('unknown');
  });
  it('chaîne < 3 caractères ne matche jamais un script', () => {
    const r = decide({ ...base, chainText: 'v', pkg: { front: false, back: true, scripts: { dev: 'vite' } }, matchScript: () => ({ category: 'front', label: 'x' }) });
    expect(r.category).toBe('back');
  });
});

describe('classifyGroups', () => {
  const ctx = (over: Partial<ClassifyContext> = {}): ClassifyContext => ({
    overrides: {}, ports: new Map(), pkg: () => null, isProtected: () => false, home: '/home/u', ...over,
  });
  const npmVite = (ageSec = 100) => {
    const npm = proc('npm run dev', 'npm run dev', { ageSec });
    const vite = proc('node', 'node /home/u/acme/node_modules/.bin/vite', { ageSec, rssKB: 2000, cpuPercent: 3 });
    const esb = proc('esbuild', 'esbuild --service=0.21.5 --ping', { ageSec, swapKB: 50 });
    return { npm, vite, esb, tree: node(npm, node(vite, node(esb))) };
  };

  it('npm → vite → esbuild : une instance front, totaux et clé', () => {
    const { npm, vite, esb, tree } = npmVite(42);
    const g = group('project:/home/u/acme', 'project', [tree]);
    const r = classifyGroups([g], ctx()).get(g.id)!;
    expect(r.categories).toEqual(['front']);
    expect(r.instances).toHaveLength(1);
    const i = r.instances[0];
    expect(i).toMatchObject({
      key: `project:/home/u/acme#${npm.pid}:${npm.startTicks}`, groupId: g.id, project: '/home/u/acme',
      category: 'front', source: 'command', signature: 'vite', label: 'vite', rootPid: npm.pid, rootStartTicks: npm.startTicks,
      pids: [npm.pid, vite.pid, esb.pid], ports: [], ageSec: 42, rssKB: 4000, swapKB: 50, cpuPercent: 5, duplicate: false, protected: false,
    });
  });

  it('concurrently "vite" "nest start" : front + back', () => {
    const npm = proc('npm run dev', 'npm run dev');
    const conc = proc('node', 'node /home/u/acme/node_modules/.bin/concurrently vite nest start');
    const vite = proc('node', 'node /home/u/acme/node_modules/.bin/vite');
    const nest = proc('node', 'node /home/u/acme/node_modules/.bin/nest start');
    const g = group('project:/home/u/acme', 'project', [node(npm, node(conc, node(vite), node(nest)))]);
    const r = classifyGroups([g], ctx()).get(g.id)!;
    expect(r.instances.map((i) => [i.category, i.label])).toEqual([['front', 'vite'], ['back', 'nest start']]);
    expect(r.categories).toEqual(['front', 'back']);
    expect(r.instances.every((i) => !i.duplicate)).toBe(true);
  });

  it('app:chrome : une instance browser, source name', () => {
    const c1 = proc('chrome', '/opt/google/chrome/chrome');
    const c2 = proc('chrome', '/opt/google/chrome/chrome --type=renderer');
    const g = group('app:chrome', 'app', [node(c1, node(c2))]);
    const r = classifyGroups([g], ctx()).get(g.id)!;
    expect(r.categories).toEqual(['browser']);
    expect(r.instances).toHaveLength(1);
    expect(r.instances[0]).toMatchObject({ category: 'browser', source: 'name', project: null, pids: [c1.pid, c2.pid] });
  });

  it('postgres (uid 0) : db, protected selon la liste', () => {
    const pg = proc('postgres', '/usr/bin/postgres -D /var/lib/postgres/data', { uid: 0 });
    const ck = proc('postgres', 'postgres: checkpointer', { uid: 0 });
    const g = group('command:postgres', 'command', [node(pg, node(ck))]);
    const off = classifyGroups([g], ctx()).get(g.id)!.instances[0];
    expect(off).toMatchObject({ category: 'db', source: 'name', protected: false });
    const on = classifyGroups([g], ctx({ isProtected: (n) => n === 'postgres' })).get(g.id)!.instances[0];
    expect(on.protected).toBe(true);
  });

  it('deux vite du même projet : le plus récent est en double', () => {
    const old = npmVite(5000);
    const young = npmVite(10);
    const g = group('project:/home/u/acme', 'project', [young.tree, old.tree]);
    const r = classifyGroups([g], ctx()).get(g.id)!;
    const byRoot = new Map(r.instances.map((i) => [i.rootPid, i]));
    expect(byRoot.get(old.npm.pid)!.duplicate).toBe(false);
    expect(byRoot.get(young.npm.pid)!.duplicate).toBe(true);
    expect(r.categories).toEqual(['front']);
  });

  it('pas de doublon pour les catégories hors front/back/worker/db', () => {
    const a = proc('node', 'node /x/node_modules/.bin/vitest', { ageSec: 10 });
    const b = proc('node', 'node /x/node_modules/.bin/vitest', { ageSec: 20 });
    const g = group('project:/x', 'project', [node(a), node(b)]);
    expect(classifyGroups([g], ctx()).get(g.id)!.instances.map((i) => i.duplicate)).toEqual([false, false]);
  });

  it('override sur acme|nest start → manual', () => {
    const nest = proc('node', 'node /home/u/acme/node_modules/.bin/nest start');
    const g = group('project:/home/u/acme', 'project', [node(nest)]);
    const r = classifyGroups([g], ctx({ overrides: { '/home/u/acme|nest start': 'worker' } })).get(g.id)!;
    expect(r.instances[0]).toMatchObject({ category: 'worker', source: 'manual', signature: 'nest start' });
    expect(r.categories).toEqual(['worker']);
  });

  it('override hors projet : clé groupId|signature', () => {
    const c = proc('chrome', '/opt/google/chrome/chrome');
    const g = group('app:chrome', 'app', [node(c)]);
    const sig = classifyGroups([g], ctx()).get(g.id)!.instances[0].signature;
    const r = classifyGroups([g], ctx({ overrides: { [`app:chrome|${sig}`]: 'ai' } })).get(g.id)!;
    expect(r.instances[0]).toMatchObject({ category: 'ai', source: 'manual' });
  });

  it('port utilisé seulement si la carte a des entrées pour ses pids', () => {
    const srv = proc('node', 'node server.js', { cwd: '/x' });
    const g = group('project:/x', 'project', [node(srv)]);
    expect(classifyGroups([g], ctx()).get(g.id)!.instances[0]).toMatchObject({ category: 'unknown', source: 'unknown', ports: [] });
    const r = classifyGroups([g], ctx({ ports: new Map([[srv.pid, [8080, 5432, 8080]], [99999, [5173]]]) })).get(g.id)!;
    expect(r.instances[0]).toMatchObject({ category: 'db', source: 'port', ports: [5432, 8080] });
  });

  it('package.json : front/back et script dev', () => {
    const srv = proc('node', 'node server.js');
    const g = group('project:/x', 'project', [node(srv)]);
    const seen: string[] = [];
    const r = classifyGroups([g], ctx({ pkg: (root) => { seen.push(root); return { front: false, back: true, scripts: {} }; } })).get(g.id)!;
    expect(seen).toEqual(['/x']);
    expect(r.instances[0]).toMatchObject({ category: 'back', source: 'package' });
    const r2 = classifyGroups([g], ctx({ pkg: () => ({ front: false, back: false, scripts: { dev: 'node server.js && celery -A x worker' } }) })).get(g.id)!;
    expect(r2.instances[0]).toMatchObject({ category: 'worker', source: 'package' });
  });

  it('groupe « dossier supprimé » : pas de projet, pas de package.json', () => {
    const v = proc('node', 'node /gone/node_modules/.bin/vite', { cwdDeleted: true });
    const g = group('deleted', 'deleted', [node(v)]);
    let called = false;
    const r = classifyGroups([g], ctx({ pkg: () => { called = true; return null; } })).get(g.id)!;
    expect(r.instances[0]).toMatchObject({ category: 'front', project: null, key: `deleted#${v.pid}:${v.startTicks}` });
    expect(called).toBe(false);
  });

  it('« Autres » : aucune instance, sous-groupes classés', () => {
    const c = proc('chrome', '/opt/google/chrome/chrome');
    const sub = group('app:chrome', 'app', [node(c)]);
    const others = { ...group('others', 'others', []), subgroups: [sub] };
    const m = classifyGroups([others], ctx());
    expect(m.get('others')).toEqual({ categories: [], instances: [] });
    expect(m.get('app:chrome')!.categories).toEqual(['browser']);
  });

  it('nom inconnu : unknown', () => {
    const p = proc('foo', '/usr/bin/foo --bar');
    const g = group('command:foo', 'command', [node(p)]);
    expect(classifyGroups([g], ctx()).get(g.id)!).toMatchObject({ categories: ['unknown'], instances: [{ category: 'unknown', source: 'unknown' }] });
  });
});
