import { describe, expect, it } from 'vitest';
import { classifyGroups, decide, type ClassifyContext } from './classify';
import { buildGroups } from '../grouping/buildGroups';
import { group, node, proc } from './testFixtures';
import { readPackageHints, type PackageHints } from './packageJson';

const pkg: PackageHints = { scripts: { dev: 'vite --port 1', build: 'tsc' } };
const viteRule = () => ({ category: 'front' as const, label: 'Vite' });
const base = { overrideKey: 'k', overrides: {}, match: null, ports: [], chainText: 'vite', pkg: null };

describe('decide', () => {
  it('override > commande > port > package > unknown', () => {
    const match = { category: 'worker' as const, label: 'w' };
    const all = { ...base, overrides: { k: 'ai' as const }, match, ports: [5432], pkg, matchScript: viteRule };
    expect(decide(all)).toEqual({ category: 'ai', source: 'manual' });
    expect(decide({ ...all, overrides: {} })).toEqual({ category: 'worker', source: 'command' });
    expect(decide({ ...all, overrides: {}, match: null })).toEqual({ category: 'db', source: 'port' });
    expect(decide({ ...all, overrides: {}, match: null, ports: [] })).toEqual({ category: 'front', source: 'package' });
    expect(decide(base)).toEqual({ category: 'unknown', source: 'unknown' });
  });
  it('package.json sans script dev/start correspondant -> unknown (les dépendances seules ne classent rien)', () => {
    expect(decide({ ...base, pkg: { scripts: {} }, matchScript: viteRule })).toEqual({ category: 'unknown', source: 'unknown' });
    expect(decide({ ...base, chainText: 'electron .', pkg: { scripts: { dev: 'vite' } }, matchScript: viteRule })).toEqual({ category: 'unknown', source: 'unknown' });
    expect(decide({ ...base, pkg })).toEqual({ category: 'unknown', source: 'unknown' }); // sans matchScript
  });
  it('script dev contenant la chaîne -> catégorie de la règle du script', () => {
    const r = decide({ ...base, pkg: { scripts: { dev: 'vite --port 1' } }, matchScript: viteRule });
    expect(r).toEqual({ category: 'front', source: 'package' });
  });
  it('script non dev/start ignoré, chaîne vide ignorée', () => {
    const p = { scripts: { build: 'vite build' } };
    const ms = () => ({ category: 'build' as const, label: 'x' });
    expect(decide({ ...base, pkg: p, matchScript: ms }).category).toBe('unknown');
    expect(decide({ ...base, chainText: '', pkg: { scripts: { dev: 'vite' } }, matchScript: ms }).category).toBe('unknown');
  });
  it('clé override héritée du prototype ignorée', () => {
    expect(decide({ ...base, overrideKey: 'toString' }).source).toBe('unknown');
  });
  it('chaîne < 3 caractères ne matche jamais un script', () => {
    const r = decide({ ...base, chainText: 'v', pkg: { scripts: { dev: 'vite' } }, matchScript: viteRule });
    expect(r.category).toBe('unknown');
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

  it('lancé par Claude : claude → zsh -c → npx jest dans acme/backend → instance Tests du projet, marquée ; lanceur npx hors instance', () => {
    const P = '/home/u/acme/backend';
    const procs = [
      proc('claude', 'claude', { pid: 9001, cwd: P }),
      proc('zsh', '/usr/bin/zsh -c npx jest', { pid: 9002, ppid: 9001, cwd: P }),
      proc('npm exec jest', 'npm exec jest', { pid: 9003, ppid: 9002, cwd: P }),
      proc('node', `node ${P}/node_modules/.bin/jest`, { pid: 9004, ppid: 9003, cwd: P }),
      proc('node', `node ${P}/node_modules/jest-worker/build/processChild.js`, { pid: 9005, ppid: 9004, cwd: P }),
    ];
    const groups = buildGroups(procs, {
      home: '/home/u', currentUid: 1000, isProtected: () => false, othersThreshold: { memMB: 0, cpuPercent: 0 },
      projectRootOf: (cwd) => (cwd.startsWith(P) ? P : null), claudeDirs: ['/home/u/.claude'],
    });
    const cls = classifyGroups(groups, ctx());
    const project = cls.get(`project:${P}`)!;
    expect(project.instances).toHaveLength(1);
    expect(project.instances[0]).toMatchObject({ category: 'test', label: 'jest', rootPid: 9004, launchedBy: 'claude' });
    expect(project.launcherPids).toEqual([9003]);
    expect(cls.get('claude')!.instances[0]!.launchedBy).toBeUndefined();
    expect(cls.get('claude')!.instances[0]!.pids.sort()).toEqual([9001, 9002]);
  });

  it('lancé par Claude : npx jest → sh -c → jest → worker, sous-arbre entier dans le projet ; npx et sh lanceurs, une instance Tests', () => {
    const P = '/home/u/acme/backend';
    const procs = [
      proc('claude', 'claude', { pid: 9101, cwd: P }),
      proc('zsh', '/usr/bin/zsh -c npx jest', { pid: 9102, ppid: 9101, cwd: P }),
      proc('npm exec jest', 'npm exec jest', { pid: 9103, ppid: 9102, cwd: P }),
      proc('sh', 'sh -c jest', { pid: 9104, ppid: 9103, cwd: P }),
      proc('node', `node ${P}/node_modules/.bin/jest`, { pid: 9105, ppid: 9104, cwd: P }),
      proc('node', `node ${P}/node_modules/jest-worker/build/processChild.js`, { pid: 9106, ppid: 9105, cwd: P }),
    ];
    const groups = buildGroups(procs, {
      home: '/home/u', currentUid: 1000, isProtected: () => false, othersThreshold: { memMB: 0, cpuPercent: 0 },
      projectRootOf: (cwd) => (cwd.startsWith(P) ? P : null), claudeDirs: ['/home/u/.claude'],
    });
    const project = classifyGroups(groups, ctx()).get(`project:${P}`)!;
    expect(project.instances).toHaveLength(1);
    expect(project.instances[0]).toMatchObject({ category: 'test', rootPid: 9105, launchedBy: 'claude' });
    expect(project.instances[0]!.pids.sort()).toEqual([9105, 9106]);
    expect(project.launcherPids.sort()).toEqual([9103, 9104]);
  });

  it('processus qui change de groupe entre deux relevés : clé d’instance stable dans son nouveau groupe', () => {
    const P = '/home/u/acme/backend';
    const o = {
      home: '/home/u', currentUid: 1000, isProtected: () => false, othersThreshold: { memMB: 0, cpuPercent: 0 },
      projectRootOf: (cwd: string) => (cwd.startsWith(P) ? P : null), claudeDirs: ['/home/u/.claude'],
    };
    const claude = proc('claude', 'claude', { pid: 9201, cwd: P });
    const zsh = proc('zsh', '/usr/bin/zsh -c source /home/u/.claude/shell-snapshots/s.sh && eval npm run dev', { pid: 9202, ppid: 9201, cwd: P });
    const npm = proc('npm run dev', 'npm run dev', { pid: 9203, ppid: 9202, cwd: P });
    const vite = proc('node', `node ${P}/node_modules/.bin/vite`, { pid: 9204, ppid: 9203, cwd: P });
    const keyOf = (procs: ReturnType<typeof proc>[], memo: NonNullable<ClassifyContext['memo']>) => {
      const cls = classifyGroups(buildGroups(procs, o), ctx({ memo }));
      return cls.get(`project:${P}`)!.instances.find((i) => i.rootPid === 9204)!;
    };
    const memo: NonNullable<ClassifyContext['memo']> = new Map();
    // 1. sous la session Claude  2. relevé suivant identique  3. session fermée : npm rattaché à systemd (step 3)
    const k1 = keyOf([claude, zsh, npm, vite], memo);
    const k2 = keyOf([{ ...claude }, { ...zsh }, { ...npm }, { ...vite }], memo);
    const k3 = keyOf([{ ...npm, ppid: 1 }, { ...vite }], memo);
    expect(k1.key).toBe(`project:${P}#9204:${vite.startTicks}`);
    expect(k2.key).toBe(k1.key);
    expect(k3.key).toBe(k1.key);
    expect([k1.launchedBy, k2.launchedBy, k3.launchedBy]).toEqual(['claude', 'claude', undefined]);
    expect(k3.category).toBe('front');
  });

  it('serveur de dev lancé à la main : instance non marquée', () => {
    const { tree } = npmVite();
    const inst = classifyGroups([group('project:/home/u/acme', 'project', [tree])], ctx()).get('project:/home/u/acme')!.instances[0]!;
    expect(inst.launchedBy).toBeUndefined();
    expect('launchedBy' in inst).toBe(false);
  });

  it('cache des décisions : même résultat, réutilisé tant que l\'appelant ne le vide pas, entrées disparues retirées', () => {
    const { tree } = npmVite(42);
    const g = group('project:/home/u/acme', 'project', [tree]);
    const memo: NonNullable<ClassifyContext['memo']> = new Map();
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
    const memo: NonNullable<ClassifyContext['memo']> = new Map();
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

  it('deux back différents du même projet (commandes différentes) : pas de doublon', () => {
    const api = proc('node', 'node /x/node_modules/.bin/nest start', { ageSec: 500 });
    const other = proc('node', 'node /x/node_modules/.bin/tsx watch src/server.ts', { ageSec: 10 });
    const g = group('project:/x', 'project', [node(api), node(other)]);
    const r = classifyGroups([g], ctx()).get(g.id)!;
    expect(r.instances.map((i) => [i.category, i.duplicate])).toEqual([['back', false], ['back', false]]);
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

  it('package.json : seulement via un script dev/start qui lance l\'instance', () => {
    const srv = proc('node', 'node server.js');
    const g = group('project:/x', 'project', [node(srv)]);
    const seen: string[] = [];
    const r = classifyGroups([g], ctx({ pkg: (root) => { seen.push(root); return { scripts: { build: 'node server.js && celery -A x worker' } }; } })).get(g.id)!;
    expect(seen).toEqual(['/x']);
    expect(r.instances[0]).toMatchObject({ category: 'unknown', source: 'unknown' });
    const r2 = classifyGroups([g], ctx({ pkg: () => ({ scripts: { dev: 'node server.js && celery -A x worker' } }) })).get(g.id)!;
    expect(r2.instances[0]).toMatchObject({ category: 'worker', source: 'package' });
  });

  it('projet React (cas proc-watch) : npm exec electron n\'est pas « Front » (dépendances React ignorées)', () => {
    const json = JSON.stringify({ dependencies: { react: '19', 'lucide-react': '1' }, devDependencies: { electron: '38' }, scripts: { dev: 'electron-vite dev', start: 'electron-vite preview' } });
    const hints = (root: string) => readPackageHints(root, () => json);
    const npm = proc('npm exec electr', 'npm exec electron .');
    const el = proc('electron', '/x/node_modules/electron/dist/electron .');
    const g = group('project:/pw-react', 'project', [node(npm, node(el))]);
    expect(classifyGroups([g], ctx({ pkg: hints })).get(g.id)!.instances.map((i) => [i.category, i.source])).toEqual([['unknown', 'unknown']]);
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

  it('skipOthersSubgroups : sous-groupes de « Autres » non classés, lanceurs vus à travers eux quand même', () => {
    const c = proc('chrome', '/opt/google/chrome/chrome');
    const npm = proc('npm run dev', 'npm run dev', { ageSec: 900 });
    const conc = proc('node', 'node /x/node_modules/.bin/concurrently vite', { ageSec: 900 });
    const sh2 = proc('sh', 'sh -c vite; true', { ageSec: 899, ppid: conc.pid });
    const vite = proc('node', 'node /x/node_modules/.bin/vite', { ageSec: 899, ppid: sh2.pid });
    const g = group('project:/x', 'project', [node(npm, node(conc)), node(vite)]);
    // le wrapper sh est un petit groupe rangé dans « Autres »
    const others = { ...group('others', 'others', []), subgroups: [group('app:chrome', 'app', [node(c)]), group('command:sh', 'command', [node(sh2)])] };
    const m = classifyGroups([g, others], ctx({ skipOthersSubgroups: true }));
    expect([...m.keys()]).toEqual(['project:/x', 'others']);
    expect(m.get(g.id)!.launcherPids).toEqual([npm.pid, conc.pid]);
    expect(m.get(g.id)!.instances.map((i) => i.label)).toEqual(['vite']);
  });

  it('projet de 5 Mo inactif (seuils par défaut) : sa propre carte, avec son instance', () => {
    const npm = proc('npm run dev', 'npm run dev', { rssKB: 2 * 1024, cpuPercent: 0 });
    const vite = proc('node', 'node /home/u/acme/node_modules/.bin/vite', { ppid: npm.pid, rssKB: 3 * 1024, cpuPercent: 0 });
    const tiny1 = proc('foo', 'foo', { cwd: '/', rssKB: 1024, cpuPercent: 0 });
    const tiny2 = proc('bar', 'bar', { cwd: '/', rssKB: 1024, cpuPercent: 0 });
    const groups = buildGroups([npm, vite, tiny1, tiny2], {
      home: '/home/u', currentUid: 1000, isProtected: () => false, othersThreshold: { memMB: 100, cpuPercent: 1 },
      projectRootOf: (cwd) => (cwd.startsWith('/home/u/acme') ? '/home/u/acme' : null),
    });
    expect(groups.map((g) => g.id)).toEqual(['project:/home/u/acme', 'others']);
    const r = classifyGroups(groups, ctx()).get('project:/home/u/acme')!;
    expect(r.instances.map((i) => [i.category, i.label])).toEqual([['front', 'vite']]);
  });

  it('nom inconnu : unknown', () => {
    const p = proc('foo', '/usr/bin/foo --bar');
    const g = group('command:foo', 'command', [node(p)]);
    expect(classifyGroups([g], ctx()).get(g.id)!).toMatchObject({ categories: ['unknown'], instances: [{ category: 'unknown', source: 'unknown' }] });
  });

  const frontBackPkg = () => ({ scripts: { dev: 'concurrently vite "nest start"' } });

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
    // script annexe classé « back » par son script start:x (qui lance aussi nest) : source package
    const r = classifyGroups([g], ctx({ pkg: () => ({ scripts: { 'start:x': 'node scripts/x.js && nest start' } }) })).get(g.id)!;
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

  it('« Reclasser » depuis l\'en-tête : override command:gitstatusd|<signature> = back → back (manual)', () => {
    const gs = proc('gitstatusd', '/home/u/.cache/gitstatus/gitstatusd-linux-x86_64 -G v1.5.4 -s -1 -u -1');
    const g = group('command:gitstatusd', 'command', [node(gs)]);
    const auto = classifyGroups([g], ctx()).get(g.id)!.instances[0];
    expect(auto.source).not.toBe('manual');
    const r = classifyGroups([g], ctx({ overrides: { [`command:gitstatusd|${auto.signature}`]: 'back' } })).get(g.id)!;
    expect(r.instances[0]).toMatchObject({ category: 'back', source: 'manual', signature: auto.signature });
    expect(r.categories).toEqual(['back']);
  });

  it('groupe claude dont la seule racine est un outil détaché (node server.cjs) → IA ; correction manuelle prioritaire', () => {
    const srv = proc('node', 'node server.cjs', { cwd: '/home/u/.claude/plugins/cache/superpowers/6.4.1' });
    const g = group('claude', 'claude', [node(srv)]);
    const auto = classifyGroups([g], ctx()).get(g.id)!;
    expect(auto.instances[0]).toMatchObject({ category: 'ai' });
    expect(auto.categories).toEqual(['ai']);
    const sig = auto.instances[0].signature;
    const r = classifyGroups([g], ctx({ overrides: { [`claude|${sig}`]: 'back' } })).get(g.id)!;
    expect(r.instances[0]).toMatchObject({ category: 'back', source: 'manual' });
  });

  it('groupes non-projet : launcherPids vide', () => {
    const c = proc('chrome', '/opt/google/chrome/chrome');
    const g = group('app:chrome', 'app', [node(c)]);
    expect(classifyGroups([g], ctx()).get(g.id)!.launcherPids).toEqual([]);
  });
});
