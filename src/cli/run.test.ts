import { describe, expect, test } from 'vitest';
import type { Availability, CgroupStats } from '../core/antigel/cgroupfs';
import { GiB } from '../core/antigel/limits';
import { USAGE, startRunScopeArgv } from '../core/antigel/run';
import { BusctlError } from '../core/antigel/systemd';
import { shortHash } from '../core/antigel/units';
import { CONFIRM_TIMEOUT_MS, resolveCommand, runCli, type CliDeps, type FsLike } from './run';

const BASE = '/user.slice/user-1000.slice/user@1000.service';
const TERM = `${BASE}/app.slice/app-term.service`;
const capped = (on: boolean): CgroupStats => ({
  currentBytes: 0, highBytes: on ? 12 * GiB : null, maxBytes: on ? 14 * GiB : null, swapMaxBytes: null,
  events: { high: 0, max: 0, oom: 0, oomKill: 0 }, populated: true,
});

function harness(o: {
  env?: NodeJS.ProcessEnv; avail?: Availability; root?: CgroupStats | null; present?: string[]; busctl?: ((argv: readonly string[]) => Promise<void>) | null;
  attribution?: Map<string, string | null>; confirmAfter?: number; projectRoot?: string | null; cwd?: string;
} = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[][] = [];
  const execs: { file: string; argv: string[]; env: NodeJS.ProcessEnv }[] = [];
  let t = 0;
  let polls = 0;
  let moved: string | null = null;
  const present = new Set(o.present ?? []);
  const deps: CliDeps = {
    env: o.env ?? { PATH: '/usr/bin', HOME: '/home/u' },
    cwd: o.cwd ?? '/home/u/demo/src',
    home: '/home/u',
    pid: 4242,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    probe: () => o.avail ?? { ok: true, userBase: BASE, busctl: '/usr/bin/busctl' },
    stats: (cg) => {
      if (cg === `${BASE}/cwatch.slice` || cg === `${BASE}/cwatch.slice/cwatch-e2eab12.slice`) return o.root === undefined ? capped(true) : o.root;
      const name = cg.split('/').pop()!;
      return present.has(name) ? capped(false) : null;
    },
    findRoot: () => (o.projectRoot === undefined ? '/home/u/demo' : o.projectRoot),
    attribution: () => o.attribution ?? new Map(),
    busctl: o.busctl === undefined
      ? async (argv) => {
        calls.push([...argv]);
        const i = argv.indexOf('StartTransientUnit');
        const scope = argv[i + 2]!;
        const slice = argv[argv.indexOf('Slice') + 2]!;
        moved = `${BASE}/cwatch.slice/cwatch-p.slice/${slice}/${scope}`;
        if (slice.startsWith('cwatch-e2e')) moved = `${BASE}/cwatch.slice/cwatch-e2eab12.slice/${slice}/${scope}`;
      }
      : o.busctl,
    selfCgroup: () => {
      polls++;
      return moved !== null && polls > (o.confirmAfter ?? 1) ? moved : TERM;
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    resolve: (cmd) => (cmd[0] === 'introuvable' ? { code: 127, message: 'commande introuvable : introuvable' } : { file: `/usr/bin/${cmd[0]}`, argv: [...cmd] }),
    exec: async (file, argv, env) => {
      execs.push({ file, argv, env });
      return 0;
    },
  };
  return { deps, out, err, calls, execs, polls: () => polls };
}

describe('runCli', () => {
  test('--help : aide sur la sortie standard, 0, rien lancé', async () => {
    const h = harness();
    expect(await runCli(['--help'], h.deps)).toBe(0);
    expect(h.out.join('')).toBe(USAGE);
    expect(h.execs).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test('erreur d’usage : 2, message et renvoi à --help sur stderr, rien lancé', async () => {
    const h = harness();
    expect(await runCli(['--mem', '6', '--', 'x'], h.deps)).toBe(2);
    expect(h.err.join('')).toMatch(/^computer-watcher run : --mem : taille refusée.*\n.*--help/s);
    expect(h.execs).toEqual([]);
  });

  test('commande introuvable : 127 avant tout appel systemd', async () => {
    const h = harness();
    expect(await runCli(['--', 'introuvable'], h.deps)).toBe(127);
    expect(h.err.join('')).toMatch(/commande introuvable : introuvable/);
    expect(h.calls).toEqual([]);
  });

  test('plafond actif : scope run sous la slice du projet, attente du déplacement, puis la commande (environnement nettoyé)', async () => {
    const h = harness({ env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', HOME: '/home/u' } });
    expect(await runCli(['--mem', '6G', '--', 'sh', '-c', 'exit 3'], h.deps)).toBe(0);
    expect(h.calls).toHaveLength(1);
    const scope = h.calls[0]![h.calls[0]!.indexOf('StartTransientUnit') + 2]!;
    const H = `cwatch-p-demo_${shortHash('/home/u/demo')}`;
    expect(scope.startsWith(`${H}-r`) && scope.length === `${H}-r0123456789.scope`.length).toBe(true);
    expect(h.calls[0]).toEqual(startRunScopeArgv(scope, `${H}.slice`, 4242, 6 * GiB));
    expect(h.execs).toEqual([{ file: '/usr/bin/sh', argv: ['sh', '-c', 'exit 3'], env: { PATH: '/usr/bin', HOME: '/home/u' } }]);
    expect(h.err).toEqual([]);
    expect(h.polls()).toBeGreaterThanOrEqual(2);
  });

  test('hors projet : slice « autres » ; slice attribuée relue dans l’état', async () => {
    const a = harness({ projectRoot: null });
    await runCli(['--', 'tail'], a.deps);
    expect(a.calls[0]).toContain('cwatch-p-autres.slice');
    const b = harness({ attribution: new Map([['cwatch-p-demo_abcdef.slice', '/home/u/demo']]) });
    await runCli(['--', 'tail'], b.deps);
    expect(b.calls[0]).toContain('cwatch-p-demo_abcdef.slice');
  });

  test('nom de scope déjà pris : un autre nom, une seule fois', async () => {
    let n = 0;
    const h = harness({
      busctl: async (argv) => {
        h.calls.push([...argv]);
        if (n++ === 0) throw new BusctlError('Unit x was already loaded or has a fragment file.', 'exists');
        throw new BusctlError('Unit y was already loaded or has a fragment file.', 'exists');
      },
    });
    expect(await runCli(['--', 'tail'], h.deps)).toBe(0);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]![h.calls[0]!.indexOf('StartTransientUnit') + 2]).not.toBe(h.calls[1]![h.calls[1]!.indexOf('StartTransientUnit') + 2]);
    expect(h.err.join('')).toMatch(/sans plafond/);
    expect(h.execs).toHaveLength(1);
  });

  const fallbacks: [string, Parameters<typeof harness>[0], RegExp][] = [
    ['PROC_WATCH_NO_ANTIGEL=1', { env: { PATH: '/usr/bin', PROC_WATCH_NO_ANTIGEL: '1' } }, /coupé \(PROC_WATCH_NO_ANTIGEL=1\)/],
    ['indisponible', { avail: { ok: false, reason: 'cgroups v2 absents' } }, /indisponible : cgroups v2 absents/],
    ['éteint (sans plafond)', { root: capped(false) }, /éteint/],
    ['éteint (slice absente)', { root: null }, /éteint/],
    ['busctl introuvable', { busctl: null }, /busctl introuvable/],
    ['refus systemd', { busctl: async () => { throw new BusctlError('Access denied', 'denied'); } }, /non posé : Access denied/],
  ];
  for (const [name, o, re] of fallbacks) {
    test(`repli (${name}) : avertissement sur stderr, la commande est lancée quand même, sans plafond`, async () => {
      const h = harness(o);
      expect(await runCli(['--mem', '6G', '--', 'make', '-j8'], h.deps)).toBe(0);
      expect(h.execs).toEqual([{ file: '/usr/bin/make', argv: ['make', '-j8'], env: expect.any(Object) }]);
      const e = h.err.join('');
      expect(e).toMatch(re);
      expect(e).toMatch(/^computer-watcher : .*commande lancée sans plafond \(--mem ignoré\)\.\n$/);
    });
  }

  test('déplacement non confirmé : avertissement, la commande part quand même après le délai', async () => {
    const h = harness({ confirmAfter: 1_000_000 });
    expect(await runCli(['--', 'tail'], h.deps)).toBe(0);
    expect(h.err.join('')).toMatch(/non confirmé/);
    expect(h.execs).toHaveLength(1);
    expect(h.deps.now()).toBeGreaterThanOrEqual(CONFIRM_TIMEOUT_MS);
  });

  test('slice de test (PROC_WATCH_RUN_ROOT_SLICE) ; valeur refusée : 2, rien lancé', async () => {
    const h = harness({ env: { PATH: '/usr/bin', PROC_WATCH_RUN_ROOT_SLICE: 'cwatch-e2eab12.slice' }, projectRoot: null });
    expect(await runCli(['--', 'tail'], h.deps)).toBe(0);
    expect(h.calls[0]).toContain('cwatch-e2eab12-autres.slice');
    expect(h.calls[0]!.join(' ')).not.toMatch(/cwatch-p-/);
    expect(h.execs[0]!.env.PROC_WATCH_RUN_ROOT_SLICE).toBeUndefined();
    const bad = harness({ env: { PATH: '/usr/bin', PROC_WATCH_RUN_ROOT_SLICE: 'cwatch.slice' } });
    expect(await runCli(['--', 'tail'], bad.deps)).toBe(2);
    expect(bad.execs).toEqual([]);
    expect(bad.calls).toEqual([]);
  });

  test('le code de sortie est celui de exec (repli sans execve)', async () => {
    const h = harness();
    h.deps.exec = async () => 3;
    expect(await runCli(['--', 'sh', '-c', 'exit 3'], h.deps)).toBe(3);
  });
});

describe('resolveCommand', () => {
  const fsFake = (files: Record<string, { exec?: boolean; dir?: boolean; head?: string }>): FsLike => ({
    kind: (p) => (files[p] ? (files[p]!.dir ? 'dir' : 'file') : null),
    executable: (p) => files[p]?.exec === true,
    head: (p) => (files[p] ? Buffer.from(files[p]!.head ?? '\x7fELF') : null),
  });
  test('recherche dans le PATH de la commande, dans l’ordre ; argv[0] tel que tapé', () => {
    const fs = fsFake({ '/usr/bin/npm': { exec: true, head: '#!/usr/bin/env node' }, '/bin/npm': { exec: true }, '/usr/bin/env': { exec: true } });
    expect(resolveCommand(['npm', 'test'], { PATH: '/opt/x:/usr/bin:/bin' }, '/home/u', fs)).toEqual({ file: '/usr/bin/npm', argv: ['npm', 'test'] });
  });
  test('chemin avec « / » : relatif au dossier courant, PATH ignoré', () => {
    const fs = fsFake({ '/home/u/demo/run.sh': { exec: true, head: '#!/bin/sh' }, '/bin/sh': { exec: true } });
    expect(resolveCommand(['./run.sh', 'a'], { PATH: '/usr/bin' }, '/home/u/demo', fs)).toEqual({ file: '/home/u/demo/run.sh', argv: ['./run.sh', 'a'] });
  });
  test('sans « #! » ni ELF : /bin/sh <fichier> (comme execvp)', () => {
    const fs = fsFake({ '/home/u/s': { exec: true, head: 'echo x' } });
    expect(resolveCommand(['/home/u/s', 'a'], {}, '/', fs)).toEqual({ file: '/bin/sh', argv: ['/bin/sh', '/home/u/s', 'a'] });
  });
  test('introuvable : 127 ; présent mais non exécutable ou dossier : 126', () => {
    expect(resolveCommand(['nope'], { PATH: '/usr/bin' }, '/', fsFake({}))).toEqual({ code: 127, message: 'commande introuvable : nope' });
    expect(resolveCommand(['x'], { PATH: '/usr/bin' }, '/', fsFake({ '/usr/bin/x': {} }))).toMatchObject({ code: 126 });
    expect(resolveCommand(['/usr/bin'], {}, '/', fsFake({ '/usr/bin': { dir: true } }))).toMatchObject({ code: 126 });
    // un non exécutable plus tôt dans le PATH n'empêche pas l'exécutable suivant
    expect(resolveCommand(['x'], { PATH: '/a:/b' }, '/', fsFake({ '/a/x': {}, '/b/x': { exec: true } }))).toMatchObject({ file: '/b/x' });
  });
  test('PATH absent : /usr/local/bin:/usr/bin:/bin ; entrée vide : dossier courant', () => {
    expect(resolveCommand(['ls'], {}, '/', fsFake({ '/usr/bin/ls': { exec: true } }))).toMatchObject({ file: '/usr/bin/ls' });
    expect(resolveCommand(['t'], { PATH: ':/usr/bin' }, '/home/u', fsFake({ '/home/u/t': { exec: true } }))).toMatchObject({ file: '/home/u/t' });
  });
});

describe('dossier courant supprimé', () => {
  test('chemins absolus seulement ; aucun projet', async () => {
    const fs = { kind: (p: string) => (p === '/usr/bin/ls' || p === '/x/t' ? 'file' as const : null), executable: () => true, head: () => Buffer.from('\x7fELF') };
    expect(resolveCommand(['ls'], { PATH: '.:/usr/bin' }, null, fs)).toMatchObject({ file: '/usr/bin/ls' });
    expect(resolveCommand(['./t'], {}, null, fs)).toMatchObject({ code: 127 });
    const h = harness();
    h.deps.cwd = null;
    await runCli(['--', 'tail'], h.deps);
    expect(h.calls[0]).toContain('cwatch-p-autres.slice');
  });
});

describe('resolveCommand : en-tête (revue m1, m2)', () => {
  const fsH = (files: Record<string, { head: string | null; exec?: boolean; dir?: boolean }>): FsLike => ({
    kind: (p) => (files[p] ? (files[p]!.dir ? 'dir' : 'file') : null),
    executable: (p) => files[p]?.exec !== false,
    head: (p) => (files[p]?.head == null ? null : Buffer.from(files[p]!.head!, 'latin1')),
  });
  test('« #! » : interpréteur absent → 127, non exécutable → 126, présent → exec direct', () => {
    expect(resolveCommand(['/w/s'], {}, '/', fsH({ '/w/s': { head: '#!/nonexistent/interp -x\nfoo' } }))).toEqual({ code: 127, message: 'interpréteur introuvable pour /w/s : /nonexistent/interp' });
    expect(resolveCommand(['/w/s'], {}, '/', fsH({ '/w/s': { head: '#!\n' } }))).toMatchObject({ code: 127 });
    expect(resolveCommand(['/w/s'], {}, '/', fsH({ '/w/s': { head: '#! /usr/bin/py\n' }, '/usr/bin/py': { head: '\x7fELF', exec: false } }))).toMatchObject({ code: 126 });
    expect(resolveCommand(['/w/s', 'a'], {}, '/', fsH({ '/w/s': { head: '#!/usr/bin/env node\n' }, '/usr/bin/env': { head: '\x7fELF' } }))).toEqual({ file: '/w/s', argv: ['/w/s', 'a'] });
  });
  test('binaire non ELF (octet nul : binfmt_misc) et exécutable illisible (exécution seule) : exec direct, jamais /bin/sh', () => {
    expect(resolveCommand(['/w/a.exe'], {}, '/', fsH({ '/w/a.exe': { head: 'MZ\x90\x00\x03' } }))).toEqual({ file: '/w/a.exe', argv: ['/w/a.exe'] });
    expect(resolveCommand(['/w/mount.x'], {}, '/', fsH({ '/w/mount.x': { head: null } }))).toEqual({ file: '/w/mount.x', argv: ['/w/mount.x'] });
    expect(resolveCommand(['/w/t'], {}, '/', fsH({ '/w/t': { head: 'echo x\n' } }))).toEqual({ file: '/bin/sh', argv: ['/bin/sh', '/w/t'] });
  });
});
