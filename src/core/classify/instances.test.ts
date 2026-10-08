import { describe, expect, it } from 'vitest';
import type { ProcInfo } from '../types';
import { findInstances, isLauncher, splitInstances } from './instances';
import { group, node, proc } from './testFixtures';

const pidsOf = (d: { procs: ProcInfo[] }) => d.procs.map((p) => p.pid);

describe('findInstances / splitInstances', () => {
  it('npm run dev → node vite → esbuild : une instance enracinée sur vite, npm est un lanceur', () => {
    const npm = proc('npm run dev', 'npm run dev');
    const vite = proc('node', 'node /home/u/acme/node_modules/.bin/vite');
    const esb = proc('esbuild', '/home/u/acme/node_modules/@esbuild/linux-x64/bin/esbuild --service=0.21.5 --ping');
    const g = group('project:/home/u/acme', 'project', [node(npm, node(vite, node(esb)))]);
    const r = splitInstances(g);
    expect(r.instances).toHaveLength(1);
    expect(r.instances[0].root.proc.pid).toBe(vite.pid);
    expect(pidsOf(r.instances[0])).toEqual([vite.pid, esb.pid]);
    expect(r.launchers.map((p) => p.pid)).toEqual([npm.pid]);
    expect(findInstances(g)).toEqual(r.instances);
  });

  it('concurrently "vite" "nest start" : chaque serveur est sa propre instance, npm et concurrently sont des lanceurs', () => {
    const npm = proc('npm run dev', 'npm run dev');
    const conc = proc('node', 'node /home/u/acme/node_modules/.bin/concurrently vite nest start');
    const vite = proc('node', 'node /home/u/acme/node_modules/.bin/vite');
    const esb = proc('esbuild', 'esbuild --service=0.21.5 --ping');
    const nest = proc('node', 'node /home/u/acme/node_modules/.bin/nest start');
    const g = group('project:/home/u/acme', 'project', [node(npm, node(conc, node(vite, node(esb)), node(nest)))]);
    const r = splitInstances(g);
    expect(r.instances.map((d) => d.root.proc.pid)).toEqual([vite.pid, nest.pid]);
    expect(pidsOf(r.instances[0])).toEqual([vite.pid, esb.pid]);
    expect(pidsOf(r.instances[1])).toEqual([nest.pid]);
    expect(r.launchers.map((p) => p.pid)).toEqual([npm.pid, conc.pid]);
  });

  it('wrappers sh -c dans l\'arbre : lanceurs, quel que soit le shell', () => {
    const npm = proc('npm run dev', 'npm run dev');
    const sh1 = proc('sh', 'sh -c concurrently vite "nest start"');
    const conc = proc('node', 'node /x/node_modules/.bin/concurrently vite nest start');
    const sh2 = proc('dash', '/bin/sh -c vite; true');
    const vite = proc('node', 'node /x/node_modules/.bin/vite');
    const sh3 = proc('bash', 'bash -c nest start; true');
    const nest = proc('node', 'node /x/node_modules/.bin/nest start');
    const g = group('project:/x', 'project', [node(npm, node(sh1, node(conc, node(sh2, node(vite)), node(sh3, node(nest)))))]);
    const r = splitInstances(g);
    expect(r.instances.map((d) => d.root.proc.pid)).toEqual([vite.pid, nest.pid]);
    expect(r.launchers.map((p) => p.pid)).toEqual([npm.pid, sh1.pid, conc.pid, sh2.pid, sh3.pid]);
  });

  it('processus non reconnu sans instance en dessous : sa propre instance', () => {
    const conc = proc('node', 'node /x/node_modules/.bin/concurrently vite "node scripts/x.js"');
    const vite = proc('node', 'node /x/node_modules/.bin/vite');
    const x = proc('node', 'node scripts/x.js');
    const xc = proc('node', 'node scripts/child.js');
    const r = splitInstances(group('project:/x', 'project', [node(conc, node(vite), node(x, node(xc)))]));
    expect(r.instances.map((d) => d.root.proc.pid)).toEqual([vite.pid, x.pid]);
    expect(pidsOf(r.instances[1])).toEqual([x.pid, xc.pid]);
    expect(r.launchers.map((p) => p.pid)).toEqual([conc.pid]);
  });

  it('racine non reconnue seule : une instance', () => {
    const s = proc('node', 'node server.js');
    const r = splitInstances(group('project:/x', 'project', [node(s)]));
    expect(r.instances.map((d) => d.root.proc.pid)).toEqual([s.pid]);
    expect(r.launchers).toEqual([]);
  });

  it('hasInstanceBelow externe : un lanceur dont les serveurs sont hors de son sous-arbre (sh dans un autre groupe)', () => {
    const npm = proc('npm run dev', 'npm run dev');
    const conc = proc('node', 'node /x/node_modules/.bin/concurrently vite nest start');
    const vite = proc('node', 'node /x/node_modules/.bin/vite');
    const g = group('project:/x', 'project', [node(npm, node(conc)), node(vite)]);
    expect(splitInstances(g).instances).toHaveLength(2); // sans information externe, npm+concurrently = instance
    const below = new Set([npm.pid, conc.pid]);
    const r = splitInstances(g, (pid) => below.has(pid));
    expect(r.instances.map((d) => d.root.proc.pid)).toEqual([vite.pid]);
    expect(r.launchers.map((p) => p.pid)).toEqual([npm.pid, conc.pid]);
  });

  it('plusieurs racines dans un groupe projet = plusieurs instances', () => {
    const a = proc('node', 'node /x/node_modules/.bin/vite');
    const b = proc('node', 'node /x/node_modules/.bin/vite');
    expect(findInstances(group('project:/x', 'project', [node(a), node(b)]))).toHaveLength(2);
  });

  it('groupe non-projet = une seule instance, racine = la plus ancienne (startTicks puis pid)', () => {
    const c1 = proc('chrome', '/opt/google/chrome/chrome', { startTicks: 500 });
    const c2 = proc('chrome', '/opt/google/chrome/chrome --type=renderer', { startTicks: 600 });
    const c3 = proc('chrome', '/opt/google/chrome/chrome --type=gpu', { startTicks: 100 });
    // buildGroups trie les racines par mémoire : la plus ancienne n'est pas forcément la première
    const r = splitInstances(group('app:chrome', 'app', [node(c1, node(c2)), node(c3)]));
    expect(r.instances).toHaveLength(1);
    expect(r.instances[0].root.proc.pid).toBe(c3.pid);
    expect(pidsOf(r.instances[0])[0]).toBe(c3.pid);
    expect(pidsOf(r.instances[0]).sort()).toEqual([c1.pid, c2.pid, c3.pid].sort());
    expect(r.launchers).toEqual([]);
    const a = proc('sh', 'sh', { pid: 9002, startTicks: 7 });
    const b = proc('sh', 'sh', { pid: 9001, startTicks: 7 });
    expect(findInstances(group('command:sh', 'command', [node(a), node(b)]))[0].root.proc.pid).toBe(9001);
  });

  it('groupe vide ou « Autres » : aucune instance', () => {
    expect(splitInstances(group('others', 'others', []))).toEqual({ instances: [], launchers: [] });
  });

  it('processus non reconnu hors liste des lanceurs : absorbe ses descendants reconnus', () => {
    const srv = proc('node', 'node tools/serve.mjs');
    const esb = proc('esbuild', '/x/node_modules/@esbuild/linux-x64/bin/esbuild src/main.ts --bundle --watch');
    const r = splitInstances(group('project:/x', 'project', [node(srv, node(esb))]));
    expect(r.instances.map((d) => d.root.proc.pid)).toEqual([srv.pid]);
    expect(pidsOf(r.instances[0])).toEqual([srv.pid, esb.pid]);
    expect(r.launchers).toEqual([]);
    // même avec une instance signalée hors du groupe : pas un lanceur
    expect(splitInstances(group('project:/x', 'project', [node(srv, node(esb))]), () => true).launchers).toEqual([]);
  });

  it('isLauncher : programme significatif dans la liste des lanceurs', () => {
    const L = (cmd: string, name = 'x') => isLauncher(proc(name, cmd));
    for (const c of ['npm run dev', 'pnpm dev', 'yarn dev', 'npx vite', 'bun run dev', 'bunx vite', '/bin/sh -c vite', 'bash -c x', 'dash -c x', 'zsh -c x',
      'env FOO=1 node x', 'node /x/node_modules/concurrently/dist/bin/concurrently.js a b', 'node /x/node_modules/.bin/nodemon src/x.ts',
      'npm-run-all -p a b', 'run-p a b', 'run-s a b', 'node /x/node_modules/.bin/turbo run dev', 'node /x/node_modules/nx/bin/nx.js run app:serve']) {
      expect(L(c), c).toBe(true);
    }
    for (const c of ['node tools/serve.mjs', 'bun server.ts', 'node /x/node_modules/nx/bin/nx.js daemon', 'python app.py', 'node /x/node_modules/.bin/vite']) {
      expect(L(c), c).toBe(false);
    }
    expect(L('', 'npm run dev')).toBe(true);
  });
});
