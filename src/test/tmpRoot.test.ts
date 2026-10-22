// Racines temporaires des lancements de Vitest (~/.cache/pw-vitest) : identité du propriétaire, nom, purge des orphelines.
// Tout se passe dans de faux dossiers sous la racine du lancement en cours (jamais la vraie ~/.cache/pw-vitest).
import { chmodSync, mkdtempSync, readlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { addProc, makeProcRoot } from '../core/collector/fakeProc';
import { ownerDead, parseRootName, readStartTime, rootPrefix, selfOwner } from './tmpRoot';

describe('propriétaire d’une racine', () => {
  test('starttime (champ 22 de stat) lu après la dernière parenthèse, même si le nom contient espaces et parenthèses', () => {
    const proc = makeProcRoot();
    addProc(proc, { pid: 4242, comm: 'a) b (c', starttime: 987654 });
    expect(readStartTime(4242, proc)).toBe('987654');
    expect(readStartTime(4243, proc)).toBeNull();
  });

  test('le processus courant : pid, starttime et espace de noms de pid lus dans le vrai /proc', () => {
    const o = selfOwner();
    expect(o.pid).toBe(process.pid);
    const stat = readFileSync('/proc/self/stat', 'utf8');
    expect(o.start).toBe(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    expect(o.ns).toBe(/^pid:\[(\d+)\]$/.exec(readlinkSync('/proc/self/ns/pid'))![1]);
  });

  test('nom de racine : préfixe pid-starttime-pidns- puis les 6 caractères de mkdtemp ; tout autre nom est inconnu', () => {
    const owner = { pid: 31337, start: '123456789', ns: '4026531836' };
    const dir = mkdtempSync(join(tmpdir(), rootPrefix(owner)));
    const name = dir.slice(dir.lastIndexOf('/') + 1);
    expect(name).toMatch(/^31337-123456789-4026531836-[A-Za-z0-9]{6}$/);
    expect(parseRootName(name)).toEqual(owner);
    for (const bad of ['pw-vitest-AbC123', '31337-1-2-AbC12', '31337-1-2-AbC1234', '0-1-2-AbC123', '-1-2-3-AbC123', '1-2-AbC123', '1-2-3-AbC12/', ' 1-2-3-AbC123', '1-2-3-AbC_23', '1-2-3-4-AbC123'])
      expect(parseRootName(bad), bad).toBeNull();
  });
});

describe('ownerDead : seulement sur preuve', () => {
  const proc = makeProcRoot();
  addProc(proc, { pid: 500, comm: 'node (vitest)', starttime: 777 });
  const ns = '4026531836';

  test('vivant (même pid, même starttime) : pas mort', () => {
    expect(ownerDead({ pid: 500, start: '777', ns }, { procRoot: proc, ns })).toBe(false);
  });
  test('pid absent : mort', () => {
    expect(ownerDead({ pid: 501, start: '777', ns }, { procRoot: proc, ns })).toBe(true);
  });
  test('pid réutilisé (autre starttime) : mort', () => {
    expect(ownerDead({ pid: 500, start: '778', ns }, { procRoot: proc, ns })).toBe(true);
  });
  test('autre espace de noms de pid (conteneur, flatpak) : invérifiable, jamais déclaré mort', () => {
    expect(ownerDead({ pid: 501, start: '1', ns: '4026532000' }, { procRoot: proc, ns })).toBe(false);
  });
  test('stat mal formé (tronqué : pas de champ 22) ou illisible : jamais déclaré mort', () => {
    const broken = makeProcRoot();
    addProc(broken, { pid: 700, comm: 'x' });
    writeFileSync(join(broken, '700', 'stat'), '700 (x) S 1');
    expect(ownerDead({ pid: 700, start: '1', ns }, { procRoot: broken, ns })).toBe(false);
    // /proc/<pid> présent mais stat inaccessible (droits) : invérifiable
    addProc(broken, { pid: 701, comm: 'y', starttime: 5 });
    chmodSync(join(broken, '701', 'stat'), 0o000);
    expect(ownerDead({ pid: 701, start: '6', ns }, { procRoot: broken, ns })).toBe(false);
  });
  test('le vrai processus courant : vivant', () => {
    const me = selfOwner();
    expect(ownerDead(me, { ns: me.ns })).toBe(false);
  });
});
