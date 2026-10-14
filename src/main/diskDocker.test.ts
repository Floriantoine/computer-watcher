import { describe, expect, test } from 'vitest';
import { checkDocker, dockerEnv, dockerPrune, dockerRunner, dockerStatus, fakeDocker, type DockerRun, type ExecFn } from './diskDocker';

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
      'context inspect --format {{.Endpoints.docker.Host}}': { code: 0, stdout: 'unix:///var/run/docker.sock\n' },
      'version --format {{.Server.APIVersion}}': { code: 0, stdout: '1.46\n' },
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
    const s = stub({ 'image prune -a -f': { code: 0 }, 'volume prune -f': { code: 1, stderr: 'Error response from daemon: x\n' }, 'version --format {{.Server.APIVersion}}': { code: 0, stdout: '1.46' } });
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
    expect(await checkDocker(stub({ 'info --format {{.ServerVersion}}': { code: 0, stdout: '27.1.1' }, 'context inspect --format {{.Endpoints.docker.Host}}': { code: 0, stdout: 'unix:///var/run/docker.sock' } }).run)).toBeNull();
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

describe('revue de sécurité du lot 2', () => {
  const CTX = 'context inspect --format {{.Endpoints.docker.Host}}';
  const API = 'version --format {{.Server.APIVersion}}';
  /** Simulation complète, avec contexte et version d'API remplaçables. */
  const sim = (o: { api?: { code: number; stdout: string }; ctx?: { code: number; stdout: string } }) => {
    const calls: string[][] = [];
    const run: DockerRun = async (args) => {
      calls.push(args);
      const k = args.join(' ');
      if (k === API && o.api) return { ...o.api, stderr: '' };
      if (k === CTX && o.ctx) return { ...o.ctx, stderr: '' };
      return fakeDocker(args);
    };
    return { run, calls };
  };
  test('I-4 : API 1.41 (Docker < 23) → pas d’action volumes ; 1.42 et plus → présente ; version illisible → absente', async () => {
    const ids = async (api: { code: number; stdout: string }) => (await dockerStatus(sim({ api }).run))?.actions.map((a) => a.id);
    expect(await ids({ code: 0, stdout: '1.41\n' })).toEqual(['images', 'containers']);
    expect(await ids({ code: 0, stdout: '1.40\n' })).toEqual(['images', 'containers']);
    expect(await ids({ code: 0, stdout: '1.42\n' })).toEqual(['images', 'containers', 'volumes']);
    expect(await ids({ code: 0, stdout: '1.47\n' })).toEqual(['images', 'containers', 'volumes']);
    expect(await ids({ code: 0, stdout: '2.0\n' })).toEqual(['images', 'containers', 'volumes']);
    for (const bad of [{ code: 0, stdout: '' }, { code: 0, stdout: 'abc' }, { code: 1, stdout: '' }, { code: 0, stdout: '1.42.x' }]) expect(await ids(bad), JSON.stringify(bad)).toEqual(['images', 'containers']);
  });
  test('I-4 : dockerPrune volumes revérifie l’API juste avant — trop ancien → refus, jamais de prune', async () => {
    const s = sim({ api: { code: 0, stdout: '1.41' } });
    await expect(dockerPrune(s.run, 'volumes')).rejects.toThrow('Docker trop ancien : docker volume prune supprimerait aussi les volumes nommés');
    expect(s.calls.some((a) => a[1] === 'prune')).toBe(false);
    const ok = sim({});
    await dockerPrune(ok.run, 'volumes');
    expect(ok.calls.filter((a) => a[1] === 'prune')).toEqual([['volume', 'prune', '-f']]);
  });
  test('m-1 : contexte docker non local (tcp://, ssh://) ou illisible → section indisponible, checkDocker refuse', async () => {
    for (const ctx of [{ code: 0, stdout: 'tcp://10.0.0.2:2376\n' }, { code: 0, stdout: 'ssh://moi@serveur\n' }, { code: 1, stdout: '' }, { code: 0, stdout: '' }]) {
      const s = sim({ ctx });
      expect(await dockerStatus(s.run), ctx.stdout).toBeNull();
      expect(await checkDocker(s.run), ctx.stdout).toMatch(/Docker/);
      expect(s.calls.some((a) => a[1] === 'prune')).toBe(false);
    }
    expect(await dockerStatus(sim({ ctx: { code: 0, stdout: 'unix:///run/user/1000/docker.sock\n' } }).run)).not.toBeNull();
    expect(await checkDocker(sim({}).run)).toBeNull();
  });
  test('m-1 : DOCKER_HOST, DOCKER_CONTEXT, DOCKER_TLS*, DOCKER_CERT_PATH retirés de l’environnement des lancements', async () => {
    const seen: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const exec: ExecFn = (file, args, opts, cb) => {
      seen.push({ file, args, env: opts.env });
      cb(null, 'ok', '');
    };
    const env = { PATH: '/usr/bin', HOME: '/h', DOCKER_HOST: 'tcp://10.0.0.2:2376', DOCKER_CONTEXT: 'distant', DOCKER_TLS_VERIFY: '1', DOCKER_TLS: '1', DOCKER_CERT_PATH: '/h/certs', DOCKER_CONFIG: '/h/.docker' };
    const r = dockerRunner(env, false, (p) => p === '/usr/bin/docker', exec)!;
    expect(await r.run(['info'], { timeoutMs: 1000 })).toEqual({ code: 0, stdout: 'ok', stderr: '' });
    expect(seen[0].file).toBe('/usr/bin/docker');
    expect(seen[0].env).toEqual({ PATH: '/usr/bin', HOME: '/h', DOCKER_CONFIG: '/h/.docker' });
    expect(dockerEnv(env)).toEqual({ PATH: '/usr/bin', HOME: '/h', DOCKER_CONFIG: '/h/.docker' });
  });
});
