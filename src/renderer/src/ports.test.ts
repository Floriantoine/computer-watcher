import { describe, expect, it } from 'vitest';
import type { OpenPort, OpenPortsInfo } from '../../core/openPorts';
import type { GroupKind, InstanceSummary } from '../../core/types';
import { freePortCheck, freePortLabel, instanceFreeable, otherUsersNote, portRowsFor, portSearchEmpty, tooBigNote, unreadableNote } from './ports';

const row = (over: Partial<OpenPort> = {}): OpenPort => ({
  port: 3000, pid: 20, startTicks: 200, groupId: 'acme', groupLabel: 'acme', instanceKey: 'acme#20:200', category: 'back', project: 'acme',
  label: 'nest start', ageSec: 60, protected: false, freeable: true, ...over,
});
const inst = (over: Partial<InstanceSummary> = {}) => ({ key: 'acme#20:200', groupId: 'acme', label: 'nest start', pids: [20], ports: [3000], protected: false, ...over }) as InstanceSummary;
const info = (rows: OpenPort[]): OpenPortsInfo => ({ ports: rows, otherUsers: [], unreadable: [], tooBig: 0 });
const kinds = (k: GroupKind) => () => k;

describe('freePortLabel', () => {
  it('« Libérer :port »', () => expect(freePortLabel(3000)).toBe('Libérer :3000'));
});

describe('freePortCheck (garde du clic, défense en profondeur)', () => {
  const instances = new Map([['acme#20:200', inst()]]);
  it('instance non protégée d\'un projet qui tient toujours le port → kill de l\'instance', () => {
    expect(freePortCheck(row(), info([row()]), instances, kinds('project'))).toEqual({ ok: true, inst: inst() });
    expect(freePortCheck(row(), info([row()]), instances, kinds('deleted')).ok).toBe(true);
  });
  it('ligne non arrêtable (appli, Claude, commande, système) → refus', () => {
    const r = row({ freeable: false, instanceKey: null });
    expect(freePortCheck(r, info([r]), instances, kinds('project'))).toEqual({ ok: false, message: "« Libérer » n'est proposé que pour les instances non protégées d'un projet" });
  });
  it('instance devenue protégée, ou groupe qui n\'est plus un projet → refus', () => {
    expect(freePortCheck(row(), info([row()]), new Map([['acme#20:200', inst({ protected: true })]]), kinds('project')).ok).toBe(false);
    expect(freePortCheck(row(), info([row()]), instances, kinds('claude')).ok).toBe(false);
    expect(freePortCheck(row(), info([row()]), instances, kinds('app')).ok).toBe(false);
  });
  it('instance disparue → « a disparu »', () => {
    expect(freePortCheck(row(), info([]), new Map(), kinds('project'))).toEqual({ ok: false, message: "L'instance « nest start » a disparu" });
  });
  it('instance présente qui ne tient plus le port → « ne tient plus »', () => {
    expect(freePortCheck(row(), info([]), instances, kinds('project'))).toEqual({ ok: false, message: '« nest start » ne tient plus :3000' });
    // liste pas encore relue : repli sur les ports de l'instance
    expect(freePortCheck(row(), null, instances, kinds('project')).ok).toBe(true);
    expect(freePortCheck(row(), null, new Map([['acme#20:200', inst({ ports: [] })]]), kinds('project')).ok).toBe(false);
  });
});

describe('autres utilisateurs et ports illisibles (Review Focus 5)', () => {
  const i: OpenPortsInfo = { ports: [row({ port: 8080 })], otherUsers: [{ port: 5432, uid: 965 }], unreadable: [7777], tooBig: 0 };
  it('un port d\'un autre utilisateur ne donne aucune ligne et un message explicite', () => {
    expect(portRowsFor(i, 5432)).toEqual([]);
    expect(portSearchEmpty(5432, i)).toBe(':5432 est écouté par un autre utilisateur (uid 965) : non arrêtable depuis proc-watch');
  });
  it('plusieurs autres utilisateurs sur le même port', () => {
    const two: OpenPortsInfo = { ports: [], otherUsers: [{ port: 80, uid: 0 }, { port: 80, uid: 33 }], unreadable: [], tooBig: 0 };
    expect(portSearchEmpty(80, two)).toBe(':80 est écouté par d\'autres utilisateurs (uid 0, 33) : non arrêtable depuis proc-watch');
  });
  it('port à soi sans processus lisible : le message le dit', () => {
    expect(portSearchEmpty(7777, i)).toBe(":7777 est écouté par un de vos processus illisible (processus trop gros, conteneur, autre espace de noms…) : non arrêtable depuis proc-watch");
  });
  it('port libre', () => {
    expect(portSearchEmpty(1, i)).toBe('Aucun processus n\'écoute :1');
  });
  it('lignes du port cherché seulement', () => {
    expect(portRowsFor(i, 8080).map((r) => r.pid)).toEqual([20]);
  });
});

describe('notes', () => {
  it('otherUsersNote : 0 → rien ; singulier ; pluriel', () => {
    expect(otherUsersNote(0)).toBeNull();
    expect(otherUsersNote(1)).toBe('1 port d\'un autre utilisateur non affiché');
    expect(otherUsersNote(3)).toBe('3 ports d\'autres utilisateurs non affichés');
  });
  it('tooBigNote', () => {
    expect(tooBigNote(0)).toBeNull();
    expect(tooBigNote(1)).toBe('1 processus trop gros pour être lu');
    expect(tooBigNote(2)).toBe('2 processus trop gros pour être lus');
  });
  it('unreadableNote', () => {
    expect(unreadableNote(0)).toBeNull();
    expect(unreadableNote(1)).toBe('1 port sans processus lisible');
    expect(unreadableNote(2)).toBe('2 ports sans processus lisible');
  });
});

describe('instanceFreeable (bouton « Libérer » du détail)', () => {
  const redis = inst({ key: 'app#7:70', groupId: 'app', label: 'redis-server', ports: [6379] });
  it('instance d\'une appli (redis dans un groupe app) : jamais', () => {
    expect(instanceFreeable('app', redis)).toBe(false);
    expect(instanceFreeable('claude', redis)).toBe(false);
    expect(instanceFreeable('command', redis)).toBe(false);
  });
  it('projet ou dossier supprimé, non protégée, avec un port : oui', () => {
    expect(instanceFreeable('project', redis)).toBe(true);
    expect(instanceFreeable('deleted', redis)).toBe(true);
    expect(instanceFreeable('project', inst({ protected: true }))).toBe(false);
    expect(instanceFreeable('project', inst({ ports: [] }))).toBe(false);
  });
  it('freePortCheck refuse aussi une instance d\'appli', () => {
    const r = row({ instanceKey: 'app#7:70', groupId: 'app', port: 6379 });
    expect(freePortCheck(r, info([r]), new Map([['app#7:70', redis]]), () => 'app').ok).toBe(false);
  });
});
