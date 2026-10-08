import { describe, expect, it } from 'vitest';
import { addProc, addSocketFd, makeProcRoot, writeNetTcp } from './fakeProc';
import { parseNetTcp, readListeningPorts } from './ports';

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
const LISTEN = '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0';
const ESTAB = '   1: 0100007F:D2A4 0100007F:1435 01 00000000:00000000 00:00000000 00000000  1000        0 99999 1 0000000000000000 20 4 30 10 -1';

describe('parseNetTcp', () => {
  it('ne garde que les lignes LISTEN', () => {
    expect(parseNetTcp(HEADER + LISTEN + '\n' + ESTAB + '\n')).toEqual(new Map([[12345, 5173]]));
  });
  it('lit tcp6', () => {
    const l = '   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 777 1 0000000000000000 100 0 0 10 0';
    expect(parseNetTcp(HEADER + l + '\n')).toEqual(new Map([[777, 3000]]));
  });
  it('contenu vide', () => {
    expect(parseNetTcp('')).toEqual(new Map());
  });
});

describe('readListeningPorts', () => {
  it('associe les pids à leurs ports, ignore les fd illisibles', () => {
    const root = makeProcRoot();
    writeNetTcp(root, [LISTEN]);
    addProc(root, { pid: 10, comm: 'vite' });
    addSocketFd(root, 10, 3, 12345);
    addSocketFd(root, 10, 4, 5555);
    addProc(root, { pid: 11, comm: 'x' });
    expect(readListeningPorts([10, 11, 12], root)).toEqual(new Map([[10, [5173]]]));
  });
  it('fusionne tcp6, trie et déduplique', () => {
    const root = makeProcRoot();
    writeNetTcp(root, [LISTEN]);
    writeNetTcp(root, ['   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 777 1 0 100 0 0 10 0'], 'tcp6');
    addProc(root, { pid: 10, comm: 'node' });
    addSocketFd(root, 10, 3, 777);
    addSocketFd(root, 10, 4, 12345);
    addSocketFd(root, 10, 5, 12345);
    expect(readListeningPorts([10], root).get(10)).toEqual([3000, 5173]);
  });
  it('plafond de fd parcourus par lecture : au-delà, les pids restants sont ignorés', () => {
    const root = makeProcRoot();
    writeNetTcp(root, [LISTEN]);
    addProc(root, { pid: 10, comm: 'a' });
    for (let fd = 0; fd < 5; fd++) addSocketFd(root, 10, fd, 1000 + fd);
    addProc(root, { pid: 11, comm: 'b' });
    addSocketFd(root, 11, 3, 12345);
    expect(readListeningPorts([10, 11], root, 5)).toEqual(new Map());
    expect(readListeningPorts([10, 11], root, 6)).toEqual(new Map([[11, [5173]]]));
  });
  it('sans /proc/net/tcp → vide', () => {
    const root = makeProcRoot();
    addProc(root, { pid: 10, comm: 'node' });
    expect(readListeningPorts([10], root)).toEqual(new Map());
  });
});
