// Le script root n'est jamais lancé via pkexec ici : il est exécuté directement, en tant qu'utilisateur,
// sur une cible temporaire (PW_EARLYOOM_TARGET) avec un faux systemctl (PW_SYSTEMCTL).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_CONFIG } from '../core/defaults';
import { buildEarlyoomArgs, EARLYOOM_LINE_RE } from '../core/earlyoom';
import { applyEarlyoom, applyExitMessage, createEarlyoomApplier, EARLYOOM_APPLY_SCRIPT, earlyoomStatus, type ExecFn } from './earlyoom';

const cacheRoot = join(homedir(), '.cache');
mkdirSync(cacheRoot, { recursive: true });
const root = mkdtempSync(join(cacheRoot, 'pw-earlyoom-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const OLD = 'EARLYOOM_ARGS="-m 6 -s 30 -r 0"\n';
const VALID = 'EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(claude|claude-desktop|warp|zsh|bash|kwin_wayland|plasmashell|Xwayland|sddm|systemd.*)$ --prefer ^(chrome|vitest|node..vitest.|node-MainThread|node|npm)$"';
const USER_LINE = 'EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(claude|claude-desktop|warp|zsh|bash|kwin_wayland|plasmashell|Xwayland|sddm|systemd.*)$ --prefer ^(chrome|vitest|node.\\(vitest\\)|node-MainThread|node|npm)$"';

let dir = '';
let n = 0;
beforeEach(() => {
  dir = join(root, `case-${n++}`);
  mkdirSync(dir);
});

const fakeSystemctl = (): string => {
  const p = join(dir, 'systemctl');
  writeFileSync(p, '#!/usr/bin/bash\necho "$@" >> "$FAKE_LOG"\nc=$(grep -c "" "$FAKE_LOG")\nif [[ $c -eq 1 ]]; then exit "${FAKE_RC:-0}"; fi\nexit 0\n');
  chmodSync(p, 0o755);
  return p;
};

function runScript(opts: { content?: string; srcPath?: string | null; target?: string; existing?: string | null; fakeRc?: number }) {
  const target = opts.target ?? join(dir, 'earlyoom');
  if (opts.existing !== undefined && opts.existing !== null) writeFileSync(target, opts.existing);
  let src = opts.srcPath === undefined ? join(dir, 'src') : opts.srcPath;
  if (src && opts.content !== undefined) writeFileSync(src, opts.content, { mode: 0o600 });
  const log = join(dir, 'log');
  const args = ['-c', EARLYOOM_APPLY_SCRIPT, 'proc-watch-earlyoom', ...(src ? [src] : [])];
  const r = spawnSync('/usr/bin/bash', args, {
    env: { PATH: '/usr/bin:/bin', PW_EARLYOOM_TARGET: target, PW_SYSTEMCTL: fakeSystemctl(), FAKE_LOG: log, FAKE_RC: String(opts.fakeRc ?? 0) },
    encoding: 'utf8',
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  const baks = readdirSync(dir).filter((f) => f.startsWith('earlyoom.bak-'));
  return { code: r.status, target, calls, baks, read: () => (existsSync(target) ? readFileSync(target, 'utf8') : null) };
}

describe('script root (exécuté directement, sans pkexec)', () => {
  test('ligne valide, cible existante → écrite, copie .bak, redémarrage', () => {
    const r = runScript({ content: `${VALID}\n`, existing: OLD });
    expect(r.code).toBe(0);
    expect(r.read()).toBe(`${VALID}\n`);
    expect(r.baks).toHaveLength(1);
    expect(r.baks[0]).toMatch(/^earlyoom\.bak-\d{8}T\d{6}$/);
    expect(readFileSync(join(dir, r.baks[0]), 'utf8')).toBe(OLD);
    expect(r.calls).toEqual(['restart earlyoom']);
    expect(statSync(r.target).mode & 0o777).toBe(0o644);
    expect(existsSync(`${r.target}.proc-watch.tmp`)).toBe(false);
  });
  test('cible absente → écrite, pas de .bak', () => {
    const r = runScript({ content: `${VALID}\n`, existing: null });
    expect(r.code).toBe(0);
    expect(r.read()).toBe(`${VALID}\n`);
    expect(r.baks).toEqual([]);
  });
  test('ligne actuelle de l’utilisateur (antislash) → 11, rien modifié, systemctl jamais appelé', () => {
    const r = runScript({ content: `${USER_LINE}\n`, existing: OLD });
    expect(r.code).toBe(11);
    expect(r.read()).toBe(OLD);
    expect(r.baks).toEqual([]);
    expect(r.calls).toEqual([]);
  });
  test.each<[string, Parameters<typeof runScript>[0], number[]]>([
    ['espace dans une regex', { content: `${VALID.replace('node-MainThread', 'node MainThread')}\n` }, [11]],
    ['deux lignes', { content: `${VALID}\n${VALID}\n` }, [10]],
    ['5 000 octets', { content: `${VALID}${' '.repeat(5000)}\n` }, [10]],
    ['argument absent', { srcPath: null }, [10]],
    ['fichier inexistant', { srcPath: '/nonexistent/proc-watch' }, [10]],
  ])('%s → refusé, cible inchangée', (_n, opts, codes) => {
    const r = runScript({ ...opts, existing: OLD });
    expect(codes).toContain(r.code);
    expect(r.read()).toBe(OLD);
    expect(r.baks).toEqual([]);
    expect(r.calls).toEqual([]);
  });
  test('lien symbolique → 10', () => {
    const real = join(dir, 'real');
    writeFileSync(real, `${VALID}\n`);
    const link = join(dir, 'src');
    symlinkSync(real, link);
    const r = runScript({ srcPath: link, existing: OLD });
    expect(r.code).toBe(10);
    expect(r.read()).toBe(OLD);
    expect(r.calls).toEqual([]);
  });
  test('redémarrage en échec → 13, ancien contenu restauré, systemctl appelé deux fois', () => {
    const r = runScript({ content: `${VALID}\n`, existing: OLD, fakeRc: 1 });
    expect(r.code).toBe(13);
    expect(r.read()).toBe(OLD);
    expect(r.calls).toEqual(['restart earlyoom', 'restart earlyoom']);
  });
  test('redémarrage en échec sans fichier précédent → 13, fichier retiré', () => {
    const r = runScript({ content: `${VALID}\n`, existing: null, fakeRc: 1 });
    expect(r.code).toBe(13);
    expect(r.read()).toBeNull();
  });
  test('même motif en JS et en bash', () => {
    const gen = buildEarlyoomArgs({ memTerm: 10, memKill: 4, swapTerm: 100, swapKill: 1, prefer: [] }, DEFAULT_CONFIG.protected);
    if (!gen.ok) throw new Error('attendu ok');
    const lines = [
      VALID,
      gen.line,
      USER_LINE,
      VALID.replace('node-MainThread', 'node MainThread'),
      VALID.replace('-r 0', '-r 1'),
      VALID.replace('"-m', '"-m  '),
      VALID.replace('|npm', '|n"pm'),
      'EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(a)$ --prefer ^(b)$"; rm -rf /',
    ];
    for (const l of lines) {
      dir = join(root, `case-${n++}`);
      mkdirSync(dir);
      const r = runScript({ content: `${l}\n`, existing: OLD });
      expect({ l, js: EARLYOOM_LINE_RE.test(l) }).toEqual({ l, js: r.code !== 11 });
    }
  });
});

describe('applyExitMessage', () => {
  test.each<[number, string]>([
    [126, 'cancelled'], [127, 'unavailable'], [10, 'invalid'], [11, 'invalid'], [12, 'failed'], [13, 'failed'], [99, 'failed'],
  ])('%i → %s', (code, reason) => {
    const r = applyExitMessage(code, VALID);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe(reason);
      expect(r.message.length).toBeGreaterThan(10);
    }
  });
  test('0 → ok', () => expect(applyExitMessage(0, VALID)).toEqual({ ok: true, line: VALID }));
  test('13 → ancien fichier restauré', () => {
    const r = applyExitMessage(13, VALID);
    expect(!r.ok && r.message).toContain('restauré');
  });
  test('code inconnu cité', () => {
    const r = applyExitMessage(99, VALID);
    expect(!r.ok && r.message).toContain('99');
  });
});

describe('applyEarlyoom (pkexec simulé)', () => {
  const capture = (code: number | Error) => {
    const seen: { cmd: string; args: string[]; mode: number; content: string; timeout?: number }[] = [];
    const run: ExecFn = async (cmd, args, opts) => {
      const file = args[args.length - 1];
      seen.push({ cmd, args, mode: statSync(file).mode & 0o777, content: readFileSync(file, 'utf8'), timeout: opts?.timeout });
      if (code instanceof Error) throw code;
      return { code, stdout: '', stderr: '' };
    };
    return { run, seen };
  };
  test('0 → ok ; arguments exacts ; fichier 0600 pendant l’appel, supprimé après', async () => {
    const { run, seen } = capture(0);
    expect(await applyEarlyoom(VALID, { run, tmpRoot: dir })).toEqual({ ok: true, line: VALID });
    expect(seen).toHaveLength(1);
    const file = seen[0].args[4];
    expect(seen[0].cmd).toBe('pkexec');
    expect(seen[0].args).toEqual(['/usr/bin/bash', '-c', EARLYOOM_APPLY_SCRIPT, 'proc-watch-earlyoom', file]);
    expect(seen[0].mode).toBe(0o600);
    expect(seen[0].content).toBe(`${VALID}\n`);
    expect(seen[0].timeout).toBe(120_000);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
  test('126 (pkexec annulé) → cancelled', async () => {
    const r = await applyEarlyoom(VALID, { run: capture(126).run, tmpRoot: dir });
    expect(r).toMatchObject({ ok: false, reason: 'cancelled' });
  });
  test('127 → unavailable', async () => {
    expect(await applyEarlyoom(VALID, { run: capture(127).run, tmpRoot: dir })).toMatchObject({ ok: false, reason: 'unavailable' });
  });
  test('spawn ENOENT → unavailable, fichier supprimé', async () => {
    const err = Object.assign(new Error('spawn pkexec ENOENT'), { code: 'ENOENT' });
    const { run, seen } = capture(err);
    expect(await applyEarlyoom(VALID, { run, tmpRoot: dir })).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(existsSync(seen[0].args[4])).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
  test('run qui lève → failed, fichier supprimé', async () => {
    const { run } = capture(new Error('boum'));
    expect(await applyEarlyoom(VALID, { run, tmpRoot: dir })).toMatchObject({ ok: false, reason: 'failed' });
    expect(readdirSync(dir)).toEqual([]);
  });
  test('ligne non conforme → invalid sans appeler pkexec', async () => {
    const { run, seen } = capture(0);
    expect(await applyEarlyoom(USER_LINE, { run, tmpRoot: dir })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(seen).toEqual([]);
  });
});

describe('createEarlyoomApplier (IPC earlyoom:apply)', () => {
  const settings = { memTerm: 8, memKill: 5, swapTerm: 35, swapKill: 25, prefer: ['chrome'] };
  test('réglages invalides → invalid', async () => {
    const apply = createEarlyoomApplier(() => [], async () => ({ ok: true, line: '' }));
    expect(await apply({ memTerm: '8' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await apply({ ...settings, memKill: 9 })).toMatchObject({ ok: false, reason: 'invalid' });
  });
  test('ligne construite avec la liste protégée', async () => {
    let got = '';
    const apply = createEarlyoomApplier(() => ['kitty'], async (line) => { got = line; return { ok: true, line }; });
    const r = await apply(settings);
    expect(r.ok).toBe(true);
    expect(got).toContain('|sddm|systemd.*|kitty)$ --prefer ^(chrome)$"');
  });
  test('second appel concurrent refusé', async () => {
    let release: () => void = () => {};
    const apply = createEarlyoomApplier(() => [], (line) => new Promise((res) => { release = () => res({ ok: true, line }); }));
    const first = apply(settings);
    expect(await apply(settings)).toEqual({ ok: false, reason: 'failed', message: 'Une application est déjà en cours.' });
    release();
    expect((await first).ok).toBe(true);
    const third = apply(settings);
    release();
    expect((await third).ok).toBe(true);
  });
});

describe('earlyoomStatus', () => {
  const run = (out: Record<string, { code: number; stdout: string }>): ExecFn => async (cmd, args) => {
    const k = [cmd, ...args].join(' ');
    const r = out[k];
    if (!r) throw Object.assign(new Error(`ENOENT ${k}`), { code: 'ENOENT' });
    return { ...r, stderr: '' };
  };
  test('binaire absent → installed false, version null', async () => {
    const st = await earlyoomStatus({ run: run({}), exists: () => false, read: () => null, env: {} });
    expect(st).toMatchObject({ installed: false, version: null, file: null });
    expect(st.installHint).toBe('sudo pacman -S earlyoom && sudo systemctl enable --now earlyoom');
  });
  test('installé, actif, version, fichier lu', async () => {
    const st = await earlyoomStatus({
      run: run({
        '/usr/bin/earlyoom -v': { code: 0, stdout: 'earlyoom 1.9.0\n' },
        'systemctl is-active earlyoom': { code: 0, stdout: 'active\n' },
      }),
      exists: (p) => p === '/usr/bin/earlyoom',
      read: (p) => (p === '/etc/default/earlyoom' ? `${USER_LINE}\n` : null),
      env: {},
    });
    expect(st).toMatchObject({ installed: true, version: '1.9.0', active: 'active' });
    expect(st.file?.converted).toEqual(['node.\\(vitest\\)']);
  });
  test('is-active qui sort inactive (code 3) → inactive', async () => {
    const st = await earlyoomStatus({
      run: run({ '/usr/bin/earlyoom -v': { code: 0, stdout: 'earlyoom 1.9.0' }, 'systemctl is-active earlyoom': { code: 3, stdout: 'inactive\n' } }),
      exists: () => true, read: () => null, env: {},
    });
    expect(st.active).toBe('inactive');
    expect(st.file).toBeNull();
  });
  test('sortie inattendue → unknown ; PROC_WATCH_EARLYOOM_BIN respecté', async () => {
    const seen: string[] = [];
    const st = await earlyoomStatus({
      run: async (cmd, args) => { seen.push(cmd); return { code: 1, stdout: args[0] === 'is-active' ? 'bizarre' : '', stderr: '' }; },
      exists: (p) => p === '/opt/eo', read: () => null, env: { PROC_WATCH_EARLYOOM_BIN: '/opt/eo' },
    });
    expect(st.installed).toBe(true);
    expect(st.active).toBe('unknown');
    expect(st.version).toBeNull();
    expect(seen).toContain('/opt/eo');
  });
});
