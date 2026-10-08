import { describe, expect, it } from 'vitest';
import type { OpenPort, OpenPortsInfo } from '../../core/openPorts';
import type { InstanceSummary, ProcInfo } from '../../core/types';
import { freePortAction, freePortLabel, freePortRequest, otherUsersNote, portRowsFor, portSearchEmpty } from './ports';

const row = (over: Partial<OpenPort> = {}): OpenPort => ({
  port: 3000, pid: 20, startTicks: 200, groupId: 'acme', groupLabel: 'acme', instanceKey: 'acme#20:200', category: 'back', project: 'acme',
  label: 'nest start', ageSec: 60, protected: false, ...over,
});
const inst = { key: 'acme#20:200', groupId: 'acme', label: 'nest start', pids: [20], ports: [3000] } as InstanceSummary;
const proc = (over: Partial<ProcInfo> = {}): ProcInfo => ({
  pid: 30, ppid: 1, name: 'code', cmdline: '/usr/bin/code', uid: 1000, startTicks: 300, ageSec: 10, cpuTicks: 0, cpuPercent: 0,
  rssKB: 0, swapKB: 0, cwd: null, cwdDeleted: false, ...over,
});

describe('freePortLabel', () => {
  it('« Libérer :port »', () => expect(freePortLabel(3000)).toBe('Libérer :3000'));
});

describe('freePortAction', () => {
  const instances = new Map([[inst.key, inst]]);
  it('instance connue → kill de l\'instance', () => {
    expect(freePortAction(row(), instances)).toEqual({ kind: 'instance', inst });
  });
  it('sans instance → kill du processus (pid + startTicks)', () => {
    expect(freePortAction(row({ instanceKey: null, pid: 30, startTicks: 300, groupId: 'code' }), instances)).toEqual({ kind: 'proc', pid: 30, startTicks: 300, groupId: 'code' });
  });
  it('instance disparue du snapshot → processus', () => {
    expect(freePortAction(row(), new Map())).toEqual({ kind: 'proc', pid: 20, startTicks: 200, groupId: 'acme' });
  });
});

describe('freePortRequest', () => {
  const yes = () => true;
  const no = () => false;
  it('processus identique (pid, startTicks, uid) → confirmation toujours demandée', () => {
    const r = freePortRequest(3000, { pid: 30, startTicks: 300 }, [proc()], no, 1000)!;
    expect(r).toMatchObject({ targets: [{ pid: 30, startTicks: 300 }], needsConfirm: true, protectedProcs: [] });
    expect(r.title).toBe('Libérer :3000 : tuer « code » (PID 30) ?');
    expect(freePortRequest(3000, { pid: 30, startTicks: 300 }, [proc()], yes, 1000)!.protectedProcs).toHaveLength(1);
  });
  it('PID réutilisé, disparu ou autre utilisateur → null (rien n\'est visé)', () => {
    expect(freePortRequest(3000, { pid: 30, startTicks: 300 }, [proc({ startTicks: 999 })], no, 1000)).toBeNull();
    expect(freePortRequest(3000, { pid: 30, startTicks: 300 }, [], no, 1000)).toBeNull();
    expect(freePortRequest(3000, { pid: 30, startTicks: 300 }, [proc({ uid: 965 })], no, 1000)).toBeNull();
  });
});

describe('autres utilisateurs (Review Focus 5)', () => {
  const info: OpenPortsInfo = { ports: [row({ port: 8080 })], otherUsers: [{ port: 5432, uid: 965 }] };
  it('un port d\'un autre utilisateur ne donne aucune ligne (donc aucun bouton) et un message explicite', () => {
    expect(portRowsFor(info, 5432)).toEqual([]);
    expect(portSearchEmpty(5432, info)).toBe(':5432 est écouté par un autre utilisateur (uid 965) : non arrêtable depuis proc-watch');
  });
  it('plusieurs autres utilisateurs sur le même port', () => {
    const two: OpenPortsInfo = { ports: [], otherUsers: [{ port: 80, uid: 0 }, { port: 80, uid: 33 }] };
    expect(portSearchEmpty(80, two)).toBe(':80 est écouté par d\'autres utilisateurs (uid 0, 33) : non arrêtable depuis proc-watch');
  });
  it('port libre', () => {
    expect(portSearchEmpty(1, info)).toBe('Aucun processus n\'écoute :1');
  });
  it('lignes du port cherché seulement', () => {
    expect(portRowsFor(info, 8080).map((r) => r.pid)).toEqual([20]);
  });
});

describe('otherUsersNote', () => {
  it('0 → rien ; singulier ; pluriel', () => {
    expect(otherUsersNote(0)).toBeNull();
    expect(otherUsersNote(1)).toBe('1 port d\'un autre utilisateur non affiché');
    expect(otherUsersNote(3)).toBe('3 ports d\'autres utilisateurs non affichés');
  });
});
