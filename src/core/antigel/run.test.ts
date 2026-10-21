import { describe, expect, test } from 'vitest';
import { GiB, MiB } from './limits';
import {
  RUN_DESCRIPTION, USAGE, commandEnv, isRunScopeName, parseMem, parseRunArgs, runProjectSlice, runRootSlice, runScopeN, runScopeName,
  startRunScopeArgv, workRoot,
} from './run';
import { OTHERS_SLICE, isScopeName, newScopeName, shortHash } from './units';

const HEAD = ['--user', '--timeout=5', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager'];

describe('parseMem', () => {
  test('entier suivi de K, M ou G (puissances de 1024), casse indifférente', () => {
    expect(parseMem('6G')).toBe(6 * GiB);
    expect(parseMem('6g')).toBe(6 * GiB);
    expect(parseMem('512M')).toBe(512 * MiB);
    expect(parseMem('262144K')).toBe(256 * MiB);
    expect(parseMem('1024G')).toBe(1024 * GiB);
  });
  test('refusés : sans unité, décimales, unités inconnues, zéros de tête, espaces, signes, hors bornes', () => {
    for (const s of ['', '6', '6000', '1.5G', '6GB', '6Gi', '6T', '06G', ' 6G', '6G ', '-6G', '+6G', '0G', '255M', '1025G', '99999999999G', 'G', '6 G', '0x10G', '١G']) {
      expect(parseMem(s), s).toBeNull();
    }
    expect(parseMem('256M')).toBe(256 * MiB);
  });
});

describe('parseRunArgs', () => {
  test('commande après --, options avant', () => {
    expect(parseRunArgs(['--', 'npm', 'test', '--watch'])).toEqual({ kind: 'run', memBytes: null, command: ['npm', 'test', '--watch'] });
    expect(parseRunArgs(['--mem', '6G', '--', 'sh', '-c', 'exit 3'])).toEqual({ kind: 'run', memBytes: 6 * GiB, command: ['sh', '-c', 'exit 3'] });
    expect(parseRunArgs(['--mem=512m', '--', 'x'])).toEqual({ kind: 'run', memBytes: 512 * MiB, command: ['x'] });
  });
  test('« -- » obligatoire (depuis l’app, Electron lit ce qui le précède) ; après lui, tout est à la commande', () => {
    expect(parseRunArgs(['make', '-j8'])).toMatchObject({ kind: 'error', message: expect.stringMatching(/« -- » manquant.*-- make/) });
    expect(parseRunArgs(['--mem', '1G', 'tail', '--', 'x'])).toMatchObject({ kind: 'error' });
    expect(parseRunArgs(['--mem', '1G', '--', 'tail', '--', 'x'])).toEqual({ kind: 'run', memBytes: GiB, command: ['tail', '--', 'x'] });
  });
  test('aide', () => {
    expect(parseRunArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseRunArgs(['-h', '--', 'x'])).toEqual({ kind: 'help' });
    expect(parseRunArgs(['--', '--help'])).toEqual({ kind: 'run', memBytes: null, command: ['--help'] });
    expect(USAGE).toMatch(/computer-watcher run \[--mem <taille>\] -- <commande>/);
  });
  test('erreurs d’usage', () => {
    const err = (a: string[]) => parseRunArgs(a).kind;
    for (const a of [[], ['--'], ['--mem', '6G'], ['--mem'], ['--mem', '6G', '--mem', '1G', '--', 'x'], ['--mem', 'beaucoup', '--', 'x'], ['--mem='],
      ['--memory', '6G', '--', 'x'], ['-m', '6G', 'x'], ['--', ''], ['']]) {
      expect(err(a), JSON.stringify(a)).toBe('error');
    }
    expect(parseRunArgs(['--foo', 'x'])).toEqual({ kind: 'error', message: 'option inconnue : --foo' });
    expect(parseRunArgs(['--mem', '6', '--', 'x'])).toMatchObject({ kind: 'error', message: expect.stringMatching(/--mem.*256M.*1024G/) });
  });
});

describe('nom du scope « run »', () => {
  test('r + 10 caractères [a-z0-9] : 11 en tout, jamais les 12 des scopes du contrôleur', () => {
    const n = runScopeN(4_194_304, 1_791_400_091_708, 0);
    expect(n).toMatch(/^r[a-z0-9]{10}$/);
    expect(runScopeN(2, 0, 0)).toMatch(/^r[a-z0-9]{10}$/);
    expect(runScopeN(1234, 1_791_400_091_708, 1)).not.toBe(runScopeN(1234, 1_791_400_091_708, 0));
    expect(() => runScopeN(1, 0, 0)).toThrow();
    expect(() => runScopeN(1.5, 0, 0)).toThrow();
    const s = runScopeName('cwatch-p-demo.slice', n);
    expect(s).toBe(`cwatch-p-demo-${n}.scope`);
    expect(isScopeName(s) && isRunScopeName(s)).toBe(true);
    expect(isRunScopeName(newScopeName('cwatch-p-demo.slice', 'mgz1abcd0001'))).toBe(false); // scope du contrôleur (12)
    expect(isRunScopeName('cwatch-p-demo-r12345678901.scope')).toBe(false); // 12 après « r »
    expect(isRunScopeName('cwatch-e2eab12-r0000000001.scope')).toBe(true);
    expect(isRunScopeName('app-r0000000001.scope')).toBe(false);
    expect(() => runScopeName('cwatch-p-demo.slice', 'x')).toThrow();
  });
});

describe('argv busctl figé du scope « run »', () => {
  test('PIDs = le lanceur seul, Slice, OOMPolicy, CollectMode, Description ; MemoryHigh seulement avec --mem', () => {
    const scope = 'cwatch-p-demo-r0000000001.scope';
    expect(startRunScopeArgv(scope, 'cwatch-p-demo.slice', 4242, null)).toEqual([
      ...HEAD, 'StartTransientUnit', 'ssa(sv)a(sa(sv))', scope, 'fail', '5',
      'PIDs', 'au', '1', '4242', 'Slice', 's', 'cwatch-p-demo.slice', 'OOMPolicy', 's', 'continue', 'CollectMode', 's', 'inactive-or-failed',
      'Description', 's', RUN_DESCRIPTION, '0',
    ]);
    expect(startRunScopeArgv(scope, 'cwatch-p-demo.slice', 4242, 6 * GiB)).toEqual([
      ...HEAD, 'StartTransientUnit', 'ssa(sv)a(sa(sv))', scope, 'fail', '6',
      'PIDs', 'au', '1', '4242', 'Slice', 's', 'cwatch-p-demo.slice', 'OOMPolicy', 's', 'continue', 'CollectMode', 's', 'inactive-or-failed',
      'Description', 's', RUN_DESCRIPTION, 'MemoryHigh', 't', String(6 * GiB), '0',
    ]);
  });
  test('refus : nom hors motif, scope d’une autre slice, slice racine, PID invalide, mémoire hors bornes', () => {
    const ok = 'cwatch-p-demo-r0000000001.scope';
    expect(() => startRunScopeArgv('cwatch-p-demo-mgz1abcd0001.scope', 'cwatch-p-demo.slice', 4242, null)).toThrow();
    expect(() => startRunScopeArgv(ok, 'cwatch-p-autre.slice', 4242, null)).toThrow();
    expect(() => startRunScopeArgv(ok, 'cwatch.slice', 4242, null)).toThrow();
    expect(() => startRunScopeArgv('app-r0000000001.scope', 'app.slice', 4242, null)).toThrow();
    for (const pid of [0, 1, -3, 1.5, 4_194_305, Number.NaN]) expect(() => startRunScopeArgv(ok, 'cwatch-p-demo.slice', pid, null)).toThrow();
    for (const m of [0, 255 * MiB, 1025 * GiB, 1.5, Number.NaN]) expect(() => startRunScopeArgv(ok, 'cwatch-p-demo.slice', 4242, m)).toThrow();
    expect(startRunScopeArgv('cwatch-e2eab12-r0000000001.scope', 'cwatch-e2eab12-p123456.slice', 4242, null)).toContain('cwatch-e2eab12-p123456.slice');
  });
});

describe('slice racine et slice de projet', () => {
  test('racine : cwatch.slice, ou une slice de test par PROC_WATCH_RUN_ROOT_SLICE (rien d’autre)', () => {
    expect(runRootSlice({})).toEqual({ slice: 'cwatch.slice', test: false });
    expect(runRootSlice({ PROC_WATCH_RUN_ROOT_SLICE: '' })).toEqual({ slice: 'cwatch.slice', test: false });
    expect(runRootSlice({ PROC_WATCH_RUN_ROOT_SLICE: 'cwatch-e2eab12.slice' })).toEqual({ slice: 'cwatch-e2eab12.slice', test: true });
    for (const v of ['cwatch.slice', 'app.slice', 'cwatch-p-demo.slice', 'cwatch-e2eab12-x.slice', 'session.slice', '../x']) {
      expect(runRootSlice({ PROC_WATCH_RUN_ROOT_SLICE: v }), v).toHaveProperty('error');
    }
  });
  test('racine de travail : jamais / ni le dossier personnel', () => {
    const find = (r: string | null) => () => r;
    expect(workRoot('/home/u/demo/src', find('/home/u/demo'), '/home/u')).toBe('/home/u/demo');
    expect(workRoot('/home/u', find('/home/u'), '/home/u')).toBeNull();
    expect(workRoot('/home/u', find('/home/u'), '/home/u/')).toBeNull();
    expect(workRoot('/', find('/'), '/home/u')).toBeNull();
    expect(workRoot('/tmp', find(null), '/home/u')).toBeNull();
  });
  test('production : slice attribuée à la racine, sinon toujours le nom haché (jamais le nom simple)', () => {
    const taken = new Map<string, string | null>();
    const H = `cwatch-p-demo_${shortHash('/home/u/demo')}.slice`;
    expect(runProjectSlice({ root: null, taken, test: null })).toBe(OTHERS_SLICE);
    expect(runProjectSlice({ root: '/home/u/demo', taken, test: null })).toBe(H);
    // déjà attribuée à cette racine (antigel-state.json), nom simple ou haché : réutilisée
    expect(runProjectSlice({ root: '/home/u/demo', taken: new Map([['cwatch-p-demo.slice', '/home/u/demo']]), test: null })).toBe('cwatch-p-demo.slice');
    // nom simple pris par une autre racine : haché
    expect(runProjectSlice({ root: '/home/u/demo', taken: new Map([['cwatch-p-demo.slice', '/home/u/b/demo']]), test: null })).toBe(H);
    // haché attribué à une autre racine (collision) : « autres »
    expect(runProjectSlice({ root: '/home/u/demo', taken: new Map([[H, '/home/u/x/demo']]), test: null })).toBe(OTHERS_SLICE);
    // projet nommé « autres »
    expect(runProjectSlice({ root: '/home/u/autres', taken, test: null })).toBe(`cwatch-p-autres_${shortHash('/home/u/autres')}.slice`);
  });
  test('test : slices cwatch-e2e<id>-<clé>.slice seulement', () => {
    const taken = new Map<string, string | null>();
    expect(runProjectSlice({ root: null, taken, test: 'cwatch-e2eab12.slice' })).toBe('cwatch-e2eab12-autres.slice');
    expect(runProjectSlice({ root: '/home/u/demo', taken, test: 'cwatch-e2eab12.slice' })).toBe(`cwatch-e2eab12-p${shortHash('/home/u/demo')}.slice`);
  });
});

describe('environnement de la commande', () => {
  test('sans les variables du runtime AppImage, d’Electron ni du test ; le reste intact', () => {
    const env = commandEnv({
      PATH: '/tmp/.mount_cwXYZ/usr/bin:/usr/bin', APPDIR: '/tmp/.mount_cwXYZ', APPIMAGE: '/home/u/a.AppImage', ELECTRON_RUN_AS_NODE: '1',
      CHROME_DESKTOP: 'computer-watcher.desktop', PROC_WATCH_RUN_ROOT_SLICE: 'cwatch-e2eab12.slice', HOME: '/home/u', LANG: 'fr_FR.UTF-8', FOO: 'a=b',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', LANG: 'fr_FR.UTF-8', FOO: 'a=b' });
    expect(commandEnv({ CHROME_DESKTOP: 'firefox.desktop' })).toEqual({ CHROME_DESKTOP: 'firefox.desktop' });
    expect(commandEnv({ CHROME_DESKTOP: 'electron.desktop' })).toEqual({});
  });
  test('NODE_OPTIONS mis de côté par le lanceur : rendu tel quel à la commande (même vide), à la place de celui laissé par Electron', () => {
    expect(commandEnv({ CWATCH_NODE_OPTIONS: '--max-old-space-size=4096 --require ./a.js', NODE_OPTIONS: '' })).toEqual({ NODE_OPTIONS: '--max-old-space-size=4096 --require ./a.js' });
    expect(commandEnv({ CWATCH_NODE_OPTIONS: '' })).toEqual({ NODE_OPTIONS: '' });
    expect(commandEnv({ NODE_OPTIONS: '--no-warnings' })).toEqual({ NODE_OPTIONS: '--no-warnings' });
  });
});
