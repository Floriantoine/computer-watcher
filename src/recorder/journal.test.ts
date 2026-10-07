import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, test } from 'vitest';
import { classifyProbe, followEarlyoom, type FollowChild, type JournalDeps } from './journal';

test('classifyProbe', () => {
  expect(classifyProbe(null, '', '')).toBe('ok');
  expect(classifyProbe(null, '-- No entries --', '')).toBe('ok');
  expect(classifyProbe(new Error('ENOENT'), '', '')).toBe('unavailable');
  expect(classifyProbe(null, '', 'Hint: You are currently not seeing messages from other users and the system.')).toBe('unavailable');
  expect(classifyProbe(null, 'Permission denied', '')).toBe('unavailable');
  expect(classifyProbe(null, '', 'Insufficient permissions to access journal')).toBe('unavailable');
});

function fakes(probes: Array<{ err: Error | null; out?: string }>) {
  const timers: { fn: () => void; ms: number; h: object }[] = [];
  const children: (FollowChild & { em: EventEmitter; out: PassThrough; killed: boolean })[] = [];
  const states: string[] = [];
  const lines: string[] = [];
  let t = 0;
  let probeN = 0;
  const deps: Partial<JournalDeps> = {
    execFile: (_c, _a, cb) => {
      const p = probes[Math.min(probeN++, probes.length - 1)];
      cb(p.err, p.out ?? '', '');
    },
    spawn: () => {
      const em = new EventEmitter();
      const out = new PassThrough();
      const c = { em, out, killed: false, stdout: out, on: (e: string, cb: () => void) => em.on(e, cb), kill() { c.killed = true; } } as unknown as FollowChild & { em: EventEmitter; out: PassThrough; killed: boolean };
      children.push(c);
      return c;
    },
    setTimeout: (fn, ms) => { const h = {}; timers.push({ fn, ms, h }); return h; },
    clearTimeout: () => {},
    now: () => t,
  };
  return { deps, timers, children, states, lines, setNow: (n: number) => (t = n), stop: () => followEarlyoom((l) => lines.push(l), (s) => states.push(s), deps) };
}

test('sonde en échec : unavailable, pas de suivi, nouvel essai à 30 s puis 60 s', () => {
  const f = fakes([{ err: new Error('x') }]);
  f.stop();
  expect(f.children.length).toBe(0);
  expect(f.states).toEqual(['unavailable']);
  expect(f.timers.map((t) => t.ms)).toEqual([30_000]);
  f.timers[0].fn();
  expect(f.timers.map((t) => t.ms)).toEqual([30_000, 60_000]);
});

test('sonde ok : suivi, ok au spawn, lignes transmises', () => {
  const f = fakes([{ err: null }]);
  f.stop();
  expect(f.children.length).toBe(1);
  f.children[0].em.emit('spawn');
  expect(f.states).toEqual(['ok']);
  f.children[0].out.write('hello\n');
  return new Promise<void>((r) => setImmediate(() => { expect(f.lines).toEqual(['hello']); r(); }));
});

test('arrêt inattendu du suivi : unavailable puis nouvel essai ; stop() tue et annule', () => {
  const f = fakes([{ err: null }]);
  const stop = f.stop();
  f.children[0].em.emit('spawn');
  f.children[0].em.emit('exit');
  expect(f.states).toEqual(['ok', 'unavailable']);
  expect(f.timers.map((t) => t.ms)).toEqual([30_000]);
  f.timers[0].fn();
  expect(f.children.length).toBe(2);
  stop();
  expect(f.children[1].killed).toBe(true);
  f.children[1].em.emit('exit');
  expect(f.timers.length).toBe(1);
});

test('la sonde ne passe pas -q (qui masquerait les avertissements d’accès au journal)', () => {
  const calls: string[][] = [];
  const stop = followEarlyoom(() => {}, () => {}, {
    execFile: (_c, a) => {
      calls.push(a);
    },
    spawn: () => {
      throw new Error('pas de suivi');
    },
  });
  stop();
  expect(calls).toHaveLength(1);
  expect(calls[0]).not.toContain('-q');
  expect(calls[0]).not.toContain('--quiet');
});

test('classifyProbe : avertissements réels de journalctl sans -q', () => {
  const hint = 'Hint: You are currently not seeing messages from other users and the system.\n      Users in groups \'adm\', \'systemd-journal\', \'wheel\' can see all messages.';
  expect(classifyProbe(null, '-- No entries --\n', hint)).toBe('unavailable');
  expect(classifyProbe(null, '', 'No journal files were opened due to insufficient permissions.')).toBe('unavailable');
  expect(classifyProbe(null, '', 'No journal files were found.')).toBe('unavailable');
  expect(classifyProbe(null, '-- No entries --\n', '')).toBe('ok');
  expect(classifyProbe(null, 'oct. 07 10:00:00 host earlyoom[1]: mem avail: 1000 of 2000 MiB\n', '')).toBe('ok');
});
