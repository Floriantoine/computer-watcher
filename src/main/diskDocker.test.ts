import { describe, expect, test } from 'vitest';
import { checkDocker, dockerPrune, dockerRunner, dockerStatus, fakeDocker, type DockerRun } from './diskDocker';

/** Docker simulé par table : « args joints » → sortie ; enregistre les appels. */
function stub(table: Record<string, { code: number; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];
  const run: DockerRun = async (args) => {
    calls.push(args);
    const r = table[args.join(' ')];
    return r ? { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } : { code: 1, stdout: '', stderr: 'inconnu' };
  };
  return { run, calls };
}

describe('dockerStatus', () => {
  test('démon arrêté ou permission refusée : null, aucune autre commande', async () => {
    const s = stub({ 'info --format {{.ServerVersion}}': { code: 1, stderr: 'permission denied while trying to connect to the Docker daemon socket' } });
    expect(await dockerStatus(s.run)).toBeNull();
    expect(s.calls).toHaveLength(1);
  });
  test('version illisible (sortie inattendue de docker info) : null, aucune autre commande', async () => {
    for (const stdout of ['', 'WARNING: bla\n27.1.1', '<html>', 'x'.repeat(41)]) {
      const s = stub({ 'info --format {{.ServerVersion}}': { code: 0, stdout } });
      expect(await dockerStatus(s.run), stdout).toBeNull();
      expect(s.calls).toHaveLength(1);
    }
  });
  test('aucune action lancée par l’analyse : jamais de prune', async () => {
    const calls: string[][] = [];
    await dockerStatus(async (args) => {
      calls.push(args);
      return fakeDocker(args);
    });
    expect(calls.some((a) => a.includes('prune'))).toBe(false);
  });
  test('le lanceur qui lève (binaire disparu, délai) : null', async () => {
    expect(await dockerStatus(async () => {
      throw new Error('ENOENT');
    })).toBeNull();
  });
  test('sortie inattendue : pas d’exception, détail indisponible', async () => {
    const s = stub({
      'info --format {{.ServerVersion}}': { code: 0, stdout: '27.1.1\n' },
      'system df --format {{json .}}': { code: 0, stdout: 'n’importe quoi' },
      'image ls --format {{json .}}': { code: 1 },
      'ps -a --format {{json .}}': { code: 0, stdout: '' },
      'volume ls --filter dangling=true --format {{json .}}': { code: 0, stdout: '' },
    });
    const v = await dockerStatus(s.run);
    expect(v?.version).toBe('27.1.1');
    expect(v?.actions.map((a) => a.id)).toEqual(['images', 'containers', 'volumes']);
    expect(v?.actions[0]).toEqual({ id: 'images', reclaimKB: null, items: [], note: 'détail indisponible' });
  });
  test('simulation : vue complète, appels enregistrés', async () => {
    const v = await dockerStatus(async (args) => fakeDocker(args));
    expect(v?.actions.find((a) => a.id === 'images')?.items).toEqual(['demo/old:0.9 (300MB)']);
    expect(v?.actions.find((a) => a.id === 'volumes')?.note).toBe('1 volume nommé inutilisé gardé (docker volume prune ne retire que les anonymes)');
  });
});

describe('checkDocker / dockerPrune', () => {
  test('argv exact ; échec → erreur avec la dernière ligne', async () => {
    const s = stub({ 'image prune -a -f': { code: 0 }, 'volume prune -f': { code: 1, stderr: 'Error response from daemon: x\n' } });
    await dockerPrune(s.run, 'images');
    expect(s.calls).toEqual([['image', 'prune', '-a', '-f']]);
    await expect(dockerPrune(s.run, 'volumes')).rejects.toThrow('docker a refusé : Error response from daemon: x');
  });
  test('action inconnue refusée avant tout appel', async () => {
    const s = stub({});
    await expect(dockerPrune(s.run, 'system' as never)).rejects.toThrow(/action refusée/);
    expect(s.calls).toEqual([]);
  });
  test('checkDocker : un lanceur qui lève n’est pas une exception', async () => {
    expect(await checkDocker(async () => {
      throw new Error('ENOENT');
    })).toBe('Docker ne répond plus');
  });
  test('checkDocker : null si docker répond encore', async () => {
    expect(await checkDocker(stub({ 'info --format {{.ServerVersion}}': { code: 0, stdout: '27.1.1' } }).run)).toBeNull();
    expect(await checkDocker(stub({}).run)).toBe('Docker ne répond plus');
  });
});

describe('dockerRunner', () => {
  test('binaire absent : null ; simulation ignorée par une app empaquetée', () => {
    expect(dockerRunner({}, false, () => false)).toBeNull();
    expect(dockerRunner({ PROC_WATCH_DISK_DOCKER_FAKE: '1' }, true, () => false)).toBeNull();
    expect(dockerRunner({ PROC_WATCH_DISK_DOCKER_FAKE: '1' }, false, () => false)?.fake).toBe(true);
    expect(dockerRunner({}, false, (p) => p === '/usr/bin/docker')?.fake).toBe(false);
  });
  test('simulation : enregistre les appels dans globalThis.__pwDockerFakeCalls', async () => {
    const g = globalThis as unknown as { __pwDockerFakeCalls?: string[][] };
    g.__pwDockerFakeCalls = [];
    await dockerRunner({ PROC_WATCH_DISK_DOCKER_FAKE: '1' }, false, () => false)!.run(['image', 'prune', '-a', '-f'], { timeoutMs: 1000 });
    expect(g.__pwDockerFakeCalls).toEqual([['image', 'prune', '-a', '-f']]);
  });
});
