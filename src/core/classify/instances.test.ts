import { describe, expect, it } from 'vitest';
import type { ProcInfo } from '../types';
import { findInstances } from './instances';
import { group, node, proc } from './testFixtures';

const pidsOf = (d: { procs: ProcInfo[] }) => d.procs.map((p) => p.pid);

describe('findInstances', () => {
  it('npm run dev → node vite → esbuild = une seule instance enracinée sur npm', () => {
    const npm = proc('npm run dev', 'npm run dev');
    const vite = proc('node', 'node /home/u/acme/node_modules/.bin/vite');
    const esb = proc('esbuild', '/home/u/acme/node_modules/@esbuild/linux-x64/bin/esbuild --service=0.21.5 --ping');
    const g = group('project:/home/u/acme', 'project', [node(npm, node(vite, node(esb)))]);
    const r = findInstances(g);
    expect(r).toHaveLength(1);
    expect(r[0].root.proc.pid).toBe(npm.pid);
    expect(pidsOf(r[0])).toEqual([npm.pid, vite.pid, esb.pid]);
  });

  it('concurrently "vite" "nest start" : chaque enfant serveur est sa propre instance', () => {
    const npm = proc('npm run dev', 'npm run dev');
    const conc = proc('node', 'node /home/u/acme/node_modules/.bin/concurrently vite nest start');
    const vite = proc('node', 'node /home/u/acme/node_modules/.bin/vite');
    const esb = proc('esbuild', 'esbuild --service=0.21.5 --ping');
    const nest = proc('node', 'node /home/u/acme/node_modules/.bin/nest start');
    const g = group('project:/home/u/acme', 'project', [node(npm, node(conc, node(vite, node(esb)), node(nest)))]);
    const r = findInstances(g);
    expect(r.map((d) => d.root.proc.pid)).toEqual([vite.pid, nest.pid]);
    expect(pidsOf(r[0])).toEqual([vite.pid, esb.pid]);
    expect(pidsOf(r[1])).toEqual([nest.pid]);
  });

  it('lanceur avec un seul enfant serveur : pas de découpage', () => {
    const conc = proc('node', 'node /x/node_modules/.bin/concurrently vite');
    const vite = proc('node', 'node /x/node_modules/.bin/vite');
    const r = findInstances(group('project:/x', 'project', [node(conc, node(vite))]));
    expect(r).toHaveLength(1);
    expect(r[0].root.proc.pid).toBe(conc.pid);
  });

  it('plusieurs racines dans un groupe projet = plusieurs instances', () => {
    const a = proc('node', 'node /x/node_modules/.bin/vite');
    const b = proc('node', 'node /x/node_modules/.bin/vite');
    expect(findInstances(group('project:/x', 'project', [node(a), node(b)]))).toHaveLength(2);
  });

  it('groupe non-projet = une seule instance avec tous les processus', () => {
    const c1 = proc('chrome', '/opt/google/chrome/chrome');
    const c2 = proc('chrome', '/opt/google/chrome/chrome --type=renderer');
    const c3 = proc('chrome', '/opt/google/chrome/chrome --type=gpu');
    const r = findInstances(group('app:chrome', 'app', [node(c1, node(c2)), node(c3)]));
    expect(r).toHaveLength(1);
    expect(r[0].root.proc.pid).toBe(c1.pid);
    expect(pidsOf(r[0]).sort()).toEqual([c1.pid, c2.pid, c3.pid].sort());
  });

  it('groupe vide ou « Autres » : aucune instance', () => {
    expect(findInstances(group('others', 'others', []))).toEqual([]);
  });
});
