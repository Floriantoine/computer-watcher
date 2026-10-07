import { describe, expect, test } from 'vitest';
import { parseCmdline, parseLoadavg, parseMeminfo, parsePsiSome10, parseStat, parseStatus } from './parse';

const statLine = (comm: string) =>
  `4242 (${comm}) S 1000 4242 4242 0 -1 4194304 100 0 0 0 250 50 0 0 20 0 1 0 123456 1000000 2000 18446744073709551615\n`;

describe('parseStat', () => {
  test('lit comm, ppid, utime, stime, starttime et rss', () => {
    expect(parseStat(statLine('node'))).toEqual({ comm: 'node', ppid: 1000, utime: 250, stime: 50, starttime: 123456, rssPages: 2000 });
  });

  test.each(['tmux: server', '(sd-pam)', 'node (vitest)', 'a) b'])('nom avec espaces ou parenthèses : %s', (comm) => {
    expect(parseStat(statLine(comm))).toEqual({ comm, ppid: 1000, utime: 250, stime: 50, starttime: 123456, rssPages: 2000 });
  });

  test('lève une erreur sur un contenu sans parenthèse fermante', () => {
    expect(() => parseStat('garbage')).toThrow();
  });
});

describe('parseStatus', () => {
  test('lit nom, uid réel, RSS et swap', () => {
    const s = 'Name:\ttmux: server\nUmask:\t0022\nUid:\t1000\t1000\t1000\t1000\nVmRSS:\t  45120 kB\nVmSwap:\t   2048 kB\n';
    expect(parseStatus(s)).toEqual({ name: 'tmux: server', uid: 1000, rssKB: 45120, swapKB: 2048 });
  });

  test('thread noyau sans VmRSS ni VmSwap → 0', () => {
    expect(parseStatus('Name:\tkworker/0:1\nUid:\t0\t0\t0\t0\n')).toEqual({ name: 'kworker/0:1', uid: 0, rssKB: 0, swapKB: 0 });
  });
});

describe('parseCmdline', () => {
  test('remplace les séparateurs NUL par des espaces', () => {
    expect(parseCmdline('node\0./node_modules/.bin/vite\0--port\x005173\0')).toBe('node ./node_modules/.bin/vite --port 5173');
  });
  test('vide → chaîne vide', () => {
    expect(parseCmdline('')).toBe('');
  });
});

describe('métriques système', () => {
  test('parseMeminfo', () => {
    const m = 'MemTotal:       32563200 kB\nMemFree:  1000 kB\nMemAvailable:   11534336 kB\nSwapTotal:      21495804 kB\nSwapFree:        1363148 kB\n';
    expect(parseMeminfo(m)).toEqual({ memTotalKB: 32563200, memAvailableKB: 11534336, swapTotalKB: 21495804, swapFreeKB: 1363148 });
  });
  test('parseLoadavg', () => {
    expect(parseLoadavg('84.40 127.58 77.53 3/2100 3528380\n')).toBe(84.4);
  });
  test('parsePsiSome10', () => {
    expect(parsePsiSome10('some avg10=28.40 avg60=40.55 avg300=36.75 total=1\nfull avg10=25.34 avg60=1 avg300=1 total=1\n')).toBe(28.4);
    expect(parsePsiSome10('')).toBeNull();
  });
});
