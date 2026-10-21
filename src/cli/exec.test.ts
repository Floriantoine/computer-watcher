import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { closeSync, constants as fsConstants, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { closeInheritedFds, execCommand, isNonBlocking, reopenPipeCloexec, restoreBlocking, type ProcLike } from './exec';

function fakeProc(withExecve: boolean) {
  const ev = new EventEmitter();
  const p = {
    pid: 4242,
    execve: withExecve ? vi.fn() : undefined,
    on: (s: string, h: () => void) => ev.on(s, h),
    off: (s: string, h: () => void) => ev.off(s, h),
    kill: vi.fn(),
    stderr: { write: vi.fn() },
    emit: (s: string) => ev.emit(s),
    count: (s: string) => ev.listenerCount(s),
  };
  return p;
}
function fakeChild() {
  const c = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
  c.kill = vi.fn();
  return c;
}

describe('closeInheritedFds', () => {
  test('ferme tout descripteur > 2, ignore les erreurs', () => {
    const closed: number[] = [];
    const kept: number[] = [];
    closeInheritedFds(() => ['0', '1', '2', '3', '17', 'x', '255'], (fd) => {
      if (fd === 17) throw new Error('EBADF');
      closed.push(fd);
    }, (fd) => {
      kept.push(fd);
      return fd === 3;
    });
    expect(closed).toEqual([3, 255]);
    expect(kept).toEqual([3, 17, 255]);
  });

  test('tube réel : rouvert avec O_CLOEXEC, l’original fermé, le tube reste ouvert (le lecteur ne voit pas EOF)', () => {
    // FIFO nommé sous ~/.cache/pw-* (même traitement qu'un tube anonyme : fstat isFIFO), ouvert des deux côtés
    const dir = mkdtempSync(join(homedir(), '.cache', 'pw-exec-fifo-'));
    try {
      const fifo = join(dir, 'f');
      execFileSync('mkfifo', [fifo]);
      const r = openSync(fifo, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      const w = openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
      const onFifo = () => readdirSync('/proc/self/fd').map(Number).filter((n) => {
        try {
          return n !== r && n !== w && readlinkSync(`/proc/self/fd/${n}`) === fifo;
        } catch {
          return false;
        }
      });
      expect(onFifo()).toEqual([]);
      expect(reopenPipeCloexec(w)).toBe(true);
      const added = onFifo();
      expect(added).toHaveLength(1);
      const fd = added[0]!;
      // O_CLOEXEC (02000000) posé, même sens (écriture)
      const flags = parseInt(/^flags:\s+([0-7]+)/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))![1]!, 8);
      expect(flags & 0o2000000).not.toBe(0);
      expect(flags & 3).toBe(fsConstants.O_WRONLY);
      closeSync(w);
      // un écrivain reste : la lecture rend EAGAIN, pas EOF (0 octet)
      expect(() => readSync(r, Buffer.alloc(1))).toThrow(/EAGAIN/);
      closeSync(fd);
      expect(readSync(r, Buffer.alloc(1))).toBe(0);
      closeSync(r);
      // fichier ordinaire : jamais rouvert
      const f = openSync(fifo.replace(/f$/, 'g'), 'w');
      expect(reopenPipeCloexec(f)).toBe(false);
      closeSync(f);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('restoreBlocking', () => {
  test('O_NONBLOCK lu dans fdinfo ; seules les poignées des descripteurs qui l’ont sont remises en bloquant', () => {
    expect(isNonBlocking('pos:\t0\nflags:\t04002\nmnt_id:\t15\n')).toBe(true);
    expect(isNonBlocking('pos:\t0\nflags:\t02000001\n')).toBe(false);
    expect(isNonBlocking(null)).toBe(false);
    const set: number[] = [];
    const info: Record<number, string> = { 0: 'flags:\t02100000\n', 1: 'flags:\t02\n', 2: 'flags:\t04002\n' };
    restoreBlocking((fd) => info[fd] ?? null, (fd) => ({ _handle: { setBlocking: (b: boolean) => { if (b) set.push(fd); } } }));
    expect(set).toEqual([2]);
    expect(() => restoreBlocking(() => 'flags:\t04001\n', () => ({ _handle: null }))).not.toThrow();
  });
});

describe('execCommand', () => {
  test('execve disponible : descripteurs fermés puis execve(fichier, argv, env)', () => {
    const p = fakeProc(true);
    const closeFds = vi.fn();
    const sp = vi.fn();
    const blocking = vi.fn();
    void execCommand('/usr/bin/sh', ['sh', '-c', 'exit 3'], { A: '1' }, p as unknown as ProcLike, sp, closeFds, blocking);
    expect(blocking).toHaveBeenCalledOnce();
    expect(closeFds).toHaveBeenCalledOnce();
    expect(p.execve).toHaveBeenCalledWith('/usr/bin/sh', ['sh', '-c', 'exit 3'], { A: '1' });
    expect(closeFds.mock.invocationCallOrder[0]).toBeLessThan((p.execve as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
  });

  test('SIGPIPE et SIGXFSZ (ignorés par Node) reçoivent un gestionnaire avant execve : action par défaut dans la commande', () => {
    const p = fakeProc(true);
    let atExec: number[] = [];
    (p.execve as ReturnType<typeof vi.fn>).mockImplementation(() => {
      atExec = [p.count('SIGPIPE'), p.count('SIGXFSZ')];
    });
    void execCommand('/usr/bin/yes', ['yes'], {}, p as unknown as ProcLike, vi.fn(), vi.fn(), vi.fn());
    expect(atExec).toEqual([1, 1]);
  });

  test('repli sans execve : enfant (argv0, stdio hérités), SIGTERM/SIGHUP transmis, SIGINT attendu, code renvoyé', async () => {
    const p = fakeProc(false);
    const c = fakeChild();
    const sp = vi.fn(() => c as unknown as ChildProcess);
    const done = execCommand('/usr/bin/sh', ['sh', '-c', 'exit 3'], { A: '1' }, p as unknown as ProcLike, sp, vi.fn());
    expect(sp).toHaveBeenCalledWith('/usr/bin/sh', ['-c', 'exit 3'], { argv0: 'sh', stdio: 'inherit', env: { A: '1' } });
    p.emit('SIGTERM');
    p.emit('SIGHUP');
    p.emit('SIGINT');
    expect(c.kill.mock.calls).toEqual([['SIGTERM'], ['SIGHUP']]);
    c.emit('exit', 3, null);
    expect(await done).toBe(3);
    expect(p.count('SIGTERM') + p.count('SIGINT')).toBe(0);
  });

  test('repli : enfant tué par un signal → le lanceur se tue avec le même signal (128 + n sinon)', async () => {
    const p = fakeProc(false);
    const c = fakeChild();
    const done = execCommand('/bin/tail', ['tail'], {}, p as unknown as ProcLike, () => c as unknown as ChildProcess, vi.fn());
    c.emit('exit', null, 'SIGINT');
    expect(p.kill).toHaveBeenCalledWith(4242, 'SIGINT');
    expect(await done).toBe(130);
  });

  test('repli : échec du lancement → 127 et message', async () => {
    const p = fakeProc(false);
    const c = fakeChild();
    const done = execCommand('/nope', ['nope'], {}, p as unknown as ProcLike, () => c as unknown as ChildProcess, vi.fn());
    c.emit('error', new Error('spawn /nope ENOENT'));
    expect(await done).toBe(127);
    expect(p.stderr.write).toHaveBeenCalledWith('computer-watcher run : spawn /nope ENOENT\n');
  });
});
