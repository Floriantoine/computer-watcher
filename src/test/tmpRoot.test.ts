// Racines temporaires des lancements de Vitest (~/.cache/pw-vitest) : identité du propriétaire, nom, purge des orphelines.
// Tout se passe dans de faux dossiers sous la racine du lancement en cours (jamais la vraie ~/.cache/pw-vitest).
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { addProc, makeProcRoot } from '../core/collector/fakeProc';
import { ownerDead, parseRootName, readStartTime, removeTree, rootPrefix, selfOwner } from './tmpRoot';

/** base/victime (à supprimer) et base/dehors (cibles des liens : doit rester intact, droits compris). */
function tree() {
  const base = mkdtempSync(join(tmpdir(), 'pw-rmtree-'));
  const out = join(base, 'dehors');
  mkdirSync(join(out, 'dossier'), { recursive: true });
  writeFileSync(join(out, 'precieux.txt'), 'garder');
  writeFileSync(join(out, 'dossier', 'f.txt'), 'garder aussi');
  chmodSync(join(out, 'dossier'), 0o555);
  const v = join(base, 'victime');
  mkdirSync(join(v, 'lecture-seule', 'sous'), { recursive: true });
  writeFileSync(join(v, 'lecture-seule', 'a.txt'), 'a');
  writeFileSync(join(v, 'lecture-seule', 'sous', 'b.txt'), 'b');
  chmodSync(join(v, 'lecture-seule', 'sous'), 0o500);
  chmodSync(join(v, 'lecture-seule'), 0o500);
  mkdirSync(join(v, 'ferme', 'interieur'), { recursive: true });
  writeFileSync(join(v, 'ferme', 'interieur', 'c.txt'), 'c');
  chmodSync(join(v, 'ferme'), 0o000);
  writeFileSync(join(v, 'zero.txt'), 'z', { mode: 0o000 });
  symlinkSync(out, join(v, 'lien-dossier'));
  symlinkSync(join(out, 'precieux.txt'), join(v, 'lien-fichier'));
  symlinkSync('.', join(v, 'boucle'));
  mkdirSync(join(v, 'profond', 'a', 'b', 'c'), { recursive: true });
  symlinkSync(join(out, 'dossier'), join(v, 'profond', 'a', 'b', 'c', 'lien'));
  return { base, out, v };
}
const intact = (out: string) => {
  expect(readFileSync(join(out, 'precieux.txt'), 'utf8')).toBe('garder');
  expect(readFileSync(join(out, 'dossier', 'f.txt'), 'utf8')).toBe('garder aussi');
  expect(statSync(join(out, 'dossier')).mode & 0o777).toBe(0o555); // jamais de chmod à travers un lien
};

describe('removeTree', () => {
  test('dossiers en 0o500 et 0o000, fichier en 0o000 : supprimés ; liens supprimés, jamais suivis', () => {
    const { out, v } = tree();
    expect(removeTree(v)).toEqual({ removed: true, errors: [] });
    expect(existsSync(v)).toBe(false);
    intact(out);
    chmodSync(join(out, 'dossier'), 0o755);
  });

  test('déjà absent : rien à faire', () => {
    const base = mkdtempSync(join(tmpdir(), 'pw-rmtree-'));
    expect(removeTree(join(base, 'absent'))).toEqual({ removed: true, errors: [] });
  });

  test('chemin qui est un lien vers un dossier : seul le lien est supprimé', () => {
    const { base, out } = tree();
    const l = join(base, 'lien-racine');
    symlinkSync(out, l);
    expect(removeTree(l).removed).toBe(true);
    expect(existsSync(l)).toBe(false);
    intact(out);
    chmodSync(join(out, 'dossier'), 0o755);
  });

  test('point de montage dessous : jamais franchi ni supprimé, la racine reste et l’erreur est rendue', () => {
    const { out, v } = tree();
    const r = removeTree(v, { mounts: new Set([join(v, 'profond', 'a')]) });
    expect(r.removed).toBe(false);
    expect(r.errors.join('\n')).toMatch(/profond\/a : point de montage/);
    expect(existsSync(join(v, 'profond', 'a', 'b', 'c'))).toBe(true);
    expect(existsSync(join(v, 'zero.txt'))).toBe(false); // le reste est supprimé
    intact(out);
    chmodSync(join(out, 'dossier'), 0o755);
  });

  test('délai dépassé : arrêt, la racine reste, « temps écoulé »', () => {
    const { v } = tree();
    let t = 0;
    const r = removeTree(v, { deadline: 3, now: () => t++ });
    expect(r.removed).toBe(false);
    expect(r.errors).toContain('temps écoulé');
    expect(lstatSync(v).isDirectory()).toBe(true);
    expect(removeTree(v).removed).toBe(true); // repris plus tard
  });
});

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
