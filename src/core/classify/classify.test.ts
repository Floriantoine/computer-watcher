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
    overrides: {}, ports: new Map(), pkg: () => null, isProtected: () => false, ...over,
  });
  const npmVite = (ageSec = 100) => {
    const npm = proc('npm run dev', 'npm run dev', { ageSec });
    const vite = proc('node', 'node /home/u/acme/node_modules/.bin/vite', { ageSec, rssKB: 2000, cpuPercent: 3 });
    const esb = proc('esbuild', 'esbuild --service=0.21.5 --ping', { ageSec, swapKB: 50 });
    return { npm, vite, esb, tree: node(npm, node(vite, node(esb))) };
  };

  it('cache des décisions : même résultat, réutilisé tant que l\'appelant ne le vide pas, entrées disparues retirées', () => {
    const { tree } = npmVite(42);
    const g = group('project:/home/u/acme', 'project', [tree]);
    const memo = new Map();
    const plain = classifyGroups([g], ctx()).get(g.id)!;
    expect(classifyGroups([g], ctx({ memo })).get(g.id)).toEqual(plain);
    expect(memo.size).toBe(1);
    expect([...memo.keys()][0]).toMatch(new RegExp(`^project:/home/u/acme#${plain.instances[0]!.rootPid}:${plain.instances[0]!.rootStartTicks}\\|`));
    // décision en cache : une correction n'est vue qu'après avoir vidé le cache
    const overrides = { '/home/u/acme|vite': 'back' as const };
    expect(classifyGroups([g], ctx({ memo, overrides })).get(g.id)!.instances[0]!.category).toBe('front');
    memo.clear();
    expect(classifyGroups([g], ctx({ memo, overrides })).get(g.id)!.instances[0]).toMatchObject({ category: 'back', source: 'manual' });
    classifyGroups([], ctx({ memo }));
    expect(memo.size).toBe(0);
  });

  it('cache des décisions : un enfant remplacé (même nombre de processus) est re-décidé', () => {
    const srv = proc('node', 'node tools/serve.mjs');
    const helper = proc('node', 'node tools/helper.js');
    const esb = proc('esbuild', '/x/node_modules/@esbuild/linux-x64/bin/esbuild src/main.ts --bundle --watch');
    const memo = new Map();
    const before = classifyGroups([group('project:/x', 'project', [node(srv, node(helper))])], ctx({ memo })).get('project:/x')!;
    expect(before.instances[0]!.category).not.toBe('build');
    const after = classifyGroups([group('project:/x', 'project', [node(srv, node(esb))])], ctx({ memo })).get('project:/x')!;
    expect(after.instances[0]).toMatchObject({ rootPid: srv.pid, category: 'build', source: 'command' });
    expect(memo.size).toBe(1); // l'ancienne entrée, non revue, est retirée
  });

  it('npm → vite → esbuild : une instance front enracinée sur vite, npm lanceur', () => {
    const { npm, vite, esb, tree } = npmVite(42);
    const g = group('project:/home/u/acme', 'project', [tree]);
    const r = classifyGroups([g], ctx()).get(g.id)!;
    expect(r.categories).toEqual(['front']);
    expect(r.instances).toHaveLength(1);
    const i = r.instances[0];
    expect(i).toMatchObject({
      key: `project:/home/u/acme#${vite.pid}:${vite.startTicks}`, groupId: g.id, project: '/home/u/acme',
      category: 'front', source: 'command', signature: 'vite', label: 'vite', rootPid: vite.pid, rootStartTicks: vite.startTicks,
      pids: [vite.pid, esb.pid], ports: [], ageSec: 42, rssKB: 3000, swapKB: 50, cpuPercent: 4, duplicate: false, protected: false,
    });
    expect(r.launcherPids).toEqual([npm.pid]);
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
    expect(r.launcherPids).toEqual([npm.pid, conc.pid]);
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
    expect(byRoot.get(old.vite.pid)!.duplicate).toBe(false);
    expect(byRoot.get(young.vite.pid)!.duplicate).toBe(true);
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
    expect(m.get('others')).toEqual({ categories: [], instances: [], launcherPids: [] });
    expect(m.get('app:chrome')!.categories).toEqual(['browser']);
  });

  it('nom inconnu : unknown', () => {
    const p = proc('foo', '/usr/bin/foo --bar');
    const g = group('command:foo', 'command', [node(p)]);
    expect(classifyGroups([g], ctx()).get(g.id)!).toMatchObject({ categories: ['unknown'], instances: [{ category: 'unknown', source: 'unknown' }] });
  });

  const frontBackPkg = () => ({ front: true, back: true, scripts: { dev: 'concurrently vite "nest start"' } });

  it('wrappers sh -c dans le groupe projet : exactement front + back, sans doublon', () => {
    const npm = proc('npm run dev', 'npm run dev', { ageSec: 900 });
    const sh1 = proc('sh', 'sh -c concurrently vite "nest start"', { ageSec: 900 });
    const conc = proc('node', 'node /x/node_modules/.bin/concurrently vite nest start', { ageSec: 900 });
    const sh2 = proc('sh', 'sh -c vite; true', { ageSec: 899 });
    const vite = proc('node', 'node /x/node_modules/.bin/vite', { ageSec: 899 });
    const sh3 = proc('sh', 'sh -c nest start; true', { ageSec: 899 });
    const nest = proc('node', 'node /x/node_modules/.bin/nest start', { ageSec: 899 });
    const g = group('project:/x', 'project', [node(npm, node(sh1, node(conc, node(sh2, node(vite)), node(sh3, node(nest)))))]);
    const r = classifyGroups([g], ctx({ pkg: frontBackPkg })).get(g.id)!;
    expect(r.instances.map((i) => [i.category, i.label, i.duplicate])).toEqual([['front', 'vite', false], ['back', 'nest start', false]]);
    expect(r.categories).toEqual(['front', 'back']);
    expect(r.launcherPids).toEqual([npm.pid, sh1.pid, conc.pid, sh2.pid, sh3.pid]);
  });

  it('doublons : une instance classée par package.json ne compte pas (script annexe à côté du vrai back)', () => {
    const conc = proc('node', 'node /x/node_modules/.bin/concurrently', { ageSec: 900 });
    const script = proc('node', 'node scripts/x.js', { ageSec: 899 });
    const nest = proc('node', 'node /x/node_modules/.bin/nest start', { ageSec: 899 });
    const vite = proc('node', 'node /x/node_modules/.bin/vite', { ageSec: 899 });
    const g = group('project:/x', 'project', [node(conc, node(script), node(nest), node(vite))]);
    const r = classifyGroups([g], ctx({ pkg: () => ({ front: false, back: true, scripts: {} }) })).get(g.id)!;
    const byLabel = new Map(r.instances.map((i) => [i.rootPid, i]));
    expect(byLabel.get(script.pid)!.source).toBe('package');
    expect(r.instances.every((i) => !i.duplicate)).toBe(true);
  });

  it('forme réelle : sh -c dans command:sh, serveurs racines séparées du groupe projet', () => {
    const npm = proc('npm run dev', 'npm run dev', { ageSec: 900 });
    const conc = proc('node', 'node /x/node_modules/.bin/concurrently vite nest start', { ageSec: 900 });
    const sh2 = proc('sh', 'sh -c vite; true', { ageSec: 899, cwd: '/x' });
    const sh3 = proc('sh', 'sh -c nest start; true', { ageSec: 899, cwd: '/x' });
    const vite = proc('node', 'node /x/node_modules/.bin/vite', { ageSec: 899, ppid: sh2.pid });
    const nest = proc('node', 'node /x/node_modules/.bin/nest start', { ageSec: 899, ppid: sh3.pid });
    const projTree = node(npm, node(conc));
    sh2.ppid = conc.pid; sh3.ppid = conc.pid;
    const g = group('project:/x', 'project', [projTree, node(vite), node(nest)]);
    const sh = group('command:sh', 'command', [node(sh2), node(sh3)]);
    const m = classifyGroups([g, sh], ctx({ pkg: frontBackPkg }));
    const r = m.get(g.id)!;
    expect(r.instances.map((i) => [i.category, i.label, i.duplicate])).toEqual([['front', 'vite', false], ['back', 'nest start', false]]);
    expect(r.launcherPids).toEqual([npm.pid, conc.pid]);
  });

  it('concurrently + node scripts/x.js : x.js reste sa propre instance', () => {
    const npm = proc('npm run dev', 'npm run dev');
    const conc = proc('node', 'node /x/node_modules/.bin/concurrently vite nest start "node scripts/x.js"');
    const vite = proc('node', 'node /x/node_modules/.bin/vite');
    const nest = proc('node', 'node /x/node_modules/.bin/nest start');
    const x = proc('node', 'node scripts/x.js');
    const g = group('project:/x', 'project', [node(npm, node(conc, node(vite), node(nest), node(x)))]);
    const r = classifyGroups([g], ctx()).get(g.id)!;
    expect(r.instances.map((i) => [i.category, i.rootPid, i.pids])).toEqual([
      ['front', vite.pid, [vite.pid]], ['back', nest.pid, [nest.pid]], ['unknown', x.pid, [x.pid]],
    ]);
    expect(r.launcherPids).toEqual([npm.pid, conc.pid]);
  });

  it('la clé de l\'instance vite ne change pas quand nest disparaît', () => {
    const npm = proc('npm run dev', 'npm run dev');
    const conc = proc('node', 'node /x/node_modules/.bin/concurrently vite nest start');
    const vite = proc('node', 'node /x/node_modules/.bin/vite');
    const nest = proc('node', 'node /x/node_modules/.bin/nest start');
    const before = classifyGroups([group('project:/x', 'project', [node(npm, node(conc, node(vite), node(nest)))])], ctx()).get('project:/x')!;
    const keyBefore = before.instances.find((i) => i.category === 'front')!.key;
    const after = classifyGroups([group('project:/x', 'project', [node(npm, node(conc, node(vite)))])], ctx()).get('project:/x')!;
    expect(after.instances.map((i) => i.key)).toEqual([keyBefore]);
    expect(keyBefore).toBe(`project:/x#${vite.pid}:${vite.startTicks}`);
  });

  it('doublons : départage déterministe (ageSec, puis startTicks, puis pid)', () => {
    const v = (pid: number, startTicks: number) => proc('node', 'node /x/node_modules/.bin/vite', { pid, startTicks, ageSec: 50 });
    const run = (roots: ReturnType<typeof v>[]) => {
      const r = classifyGroups([group('project:/x', 'project', roots.map((p) => node(p)))], ctx()).get('project:/x')!;
      return r.instances.filter((i) => !i.duplicate).map((i) => i.rootPid);
    };
    const a = v(8001, 300); const b = v(8002, 200);
    expect(run([a, b])).toEqual([8002]);
    expect(run([b, a])).toEqual([8002]);
    const c = v(8004, 300); const d = v(8003, 300);
    expect(run([c, d])).toEqual([8003]);
    expect(run([d, c])).toEqual([8003]);
  });

  it('groupes non-projet : launcherPids vide', () => {
    const c = proc('chrome', '/opt/google/chrome/chrome');
    const g = group('app:chrome', 'app', [node(c)]);
    expect(classifyGroups([g], ctx()).get(g.id)!.launcherPids).toEqual([]);
  });
});
