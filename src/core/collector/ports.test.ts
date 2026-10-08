import { describe, expect, it } from 'vitest';
import { addProc, addSocketFd, makeProcRoot, writeNetTcp } from './fakeProc';
import { parseNetTcp, parseNetTcpListen, readAllListenSockets, readListenSockets, readListeningPorts, readListeningPortsSlice } from './ports';

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

const PG = '   2: 00000000:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000   965        0 4242 1 0000000000000000 100 0 0 10 0';

describe('parseNetTcpListen', () => {
  it('LISTEN seulement, avec l\'uid (8e colonne)', () => {
    expect(parseNetTcpListen(HEADER + LISTEN + '\n' + ESTAB + '\n' + PG + '\n')).toEqual([
      { inode: 12345, port: 5173, uid: 1000 },
      { inode: 4242, port: 5432, uid: 965 },
    ]);
  });
  it('ligne tronquée ou uid illisible : ignorée', () => {
    expect(parseNetTcpListen(HEADER + '   0: 0100007F:1435 00000000:0000 0A\n' + PG.replace('  965 ', '  abc ') + '\n')).toEqual([]);
  });
  it('parseNetTcp reste la vue inode → port', () => {
    expect(parseNetTcp(HEADER + PG + '\n')).toEqual(new Map([[4242, 5432]]));
  });
});

describe('readListenSockets', () => {
  it('tcp + tcp6, dédoublonné par (port, uid), trié par port', () => {
    const root = makeProcRoot();
    writeNetTcp(root, [LISTEN, PG]);
    writeNetTcp(root, [
      '   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 777 1 0 100 0 0 10 0',
      '   1: 00000000000000000000000000000000:1538 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000   965        0 778 1 0 100 0 0 10 0',
    ], 'tcp6');
    expect(readListenSockets(root)).toEqual([
      { inode: 777, port: 3000, uid: 1000 },
      { inode: 12345, port: 5173, uid: 1000 },
      { inode: 4242, port: 5432, uid: 965 },
    ]);
  });
  it('sans /proc/net : vide', () => {
    expect(readListenSockets(makeProcRoot())).toEqual([]);
  });
});

describe('readListeningPortsSlice', () => {
  const setup = () => {
    const root = makeProcRoot();
    writeNetTcp(root, [LISTEN, PG]);
    addProc(root, { pid: 10, comm: 'a' });
    for (let fd = 0; fd < 3; fd++) addSocketFd(root, 10, fd, 1000 + fd);
    addSocketFd(root, 10, 3, 12345);
    addProc(root, { pid: 11, comm: 'b' });
    addSocketFd(root, 11, 3, 4242);
    addProc(root, { pid: 12, comm: 'c' });
    addSocketFd(root, 12, 3, 7);
    return root;
  };
  it('s\'arrête avant de dépasser le budget de fd et reprend au bon pid', () => {
    const root = setup();
    const sockets = readAllListenSockets(root);
    const first = readListeningPortsSlice([10, 11, 12], 0, sockets, 5, root);
    expect(first).toEqual({ ports: new Map([[10, [5173]], [11, [5432]]]), next: 2, tooBig: [] });
    const second = readListeningPortsSlice([10, 11, 12], first.next, sockets, 5, root);
    expect(second).toEqual({ ports: new Map(), next: 3, tooBig: [] });
  });
  it('pid illisible sauté ; pid à plus de fd que le budget : jamais lu, signalé (tooBig)', () => {
    const root = setup();
    const sockets = readAllListenSockets(root);
    expect(readListeningPortsSlice([99, 10, 11], 0, sockets, 2, root)).toEqual({ ports: new Map([[11, [5432]]]), next: 3, tooBig: [10] });
  });
  it('fin de liste : next = longueur', () => {
    const root = setup();
    expect(readListeningPortsSlice([10], 1, readAllListenSockets(root), 5, root)).toEqual({ ports: new Map(), next: 1, tooBig: [] });
  });
});
