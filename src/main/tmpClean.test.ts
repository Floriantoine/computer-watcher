// Toutes les racines sont sous ~/.cache/pw-tmpclean-* (jamais /tmp) et supprimées à la fin.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, test } from 'vitest';
import type { TmpDeleteItem } from '../core/tmpClean';
import { deleteTmpEntries, listTmpEntries, scanTmpUsers, tmpCleanEvent, tmpRootFromEnv } from './tmpClean';

const cache = join(homedir(), '.cache');
mkdirSync(cache, { recursive: true });
const bases: string[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];

afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  for (const s of servers.splice(0)) s.close();
});
afterAll(() => {
  for (const b of bases) rmSync(b, { recursive: true, force: true });
});

/** base/root (la fausse /tmp) et base/outside (cibles des liens, qui doivent rester intactes). */
function setup() {
  const base = mkdtempSync(join(cache, 'pw-tmpclean-'));
  bases.push(base);
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, 'precieux.txt'), 'garder');
  mkdirSync(join(outside, 'dossier'));
  writeFileSync(join(outside, 'dossier', 'f.txt'), 'garder aussi');
  return { base, root, outside };
}
const outsideIntact = (outside: string) => {
  expect(readFileSync(join(outside, 'precieux.txt'), 'utf8')).toBe('garder');
  expect(readFileSync(join(outside, 'dossier', 'f.txt'), 'utf8')).toBe('garder aussi');
};
const item = (root: string, name: string): TmpDeleteItem => {
  const st = lstatSync(join(root, name));
  return { name, ino: st.ino, dev: st.dev };
};
const noMounts = async () => [] as string[];
const exited = (c: ChildProcess) => new Promise<void>((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once('exit', () => r())));
/** Attend que le processus ait fait son exec (comm = sleep), pour que /proc décrive bien l'état voulu. */
async function settled(c: ChildProcess) {
  for (let i = 0; i < 100; i++) {
    try {
      if (readFileSync(`/proc/${c.pid}/comm`, 'utf8').trim() === 'sleep') return;
    } catch {
      // pas encore
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('enfant pas prêt');
}

test('liste : dossiers et fichiers de premier niveau, cache étiqueté, système refusé', async () => {
  const { root } = setup();
  mkdirSync(join(root, 'jest_rs'));
  writeFileSync(join(root, 'jest_rs', 'x'), Buffer.alloc(64 * 1024, 1));
  mkdirSync(join(root, 'mon-dossier'));
  writeFileSync(join(root, 'gros.bin'), Buffer.alloc(32 * 1024, 1));
  mkdirSync(join(root, '.X11-unix'));
  const l = await listTmpEntries(root, { mountPoints: noMounts });
  expect(l.root).toBe(root);
  const by = Object.fromEntries(l.entries.map((e) => [e.name, e]));
  expect(by.jest_rs).toMatchObject({ kind: 'dir', cache: true, refusal: null });
  expect(by.jest_rs.sizeKB).toBeGreaterThanOrEqual(64);
  expect(by['mon-dossier']).toMatchObject({ kind: 'dir', cache: false, refusal: null });
  expect(by['gros.bin']).toMatchObject({ kind: 'file', refusal: null });
  expect(by['gros.bin'].sizeKB).toBeGreaterThanOrEqual(32);
  expect(by['.X11-unix'].refusal).toBe('système');
  expect(by.jest_rs.ino).toBe(lstatSync(join(root, 'jest_rs')).ino);
});

test('socket et FIFO de premier niveau : refusés', async () => {
  const { root } = setup();
  const srv = createServer();
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(join(root, 'sock'), r));
  expect(spawnSync('mkfifo', [join(root, 'fifo')]).status).toBe(0);
  const l = await listTmpEntries(root, { mountPoints: noMounts });
  const by = Object.fromEntries(l.entries.map((e) => [e.name, e]));
  expect(by.sock.refusal).toMatch(/socket|utilisé/);
  expect(by.fifo.refusal).toBe('FIFO');
  const r = await deleteTmpEntries(root, [item(root, 'sock'), item(root, 'fifo')], { mountPoints: noMounts });
  expect(r.results.every((x) => !x.ok)).toBe(true);
  expect(existsSync(join(root, 'sock'))).toBe(true);
  expect(existsSync(join(root, 'fifo'))).toBe(true);
});

test('dossier contenant un socket actif : « utilisé par … »', async () => {
  const { root } = setup();
  mkdirSync(join(root, 'tmuxlike'));
  const srv = createServer();
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(join(root, 'tmuxlike', 'default'), r));
  const l = await listTmpEntries(root, { mountPoints: noMounts });
  expect(l.entries.find((e) => e.name === 'tmuxlike')?.refusal).toMatch(new RegExp(`^utilisé par .+ \\(pid ${process.pid}\\)$`));
  const r = await deleteTmpEntries(root, [item(root, 'tmuxlike')], { mountPoints: noMounts });
  expect(r.results[0]).toMatchObject({ ok: false });
  expect(existsSync(join(root, 'tmuxlike', 'default'))).toBe(true);
});

test('lien vers un fichier hors de la racine : seul le lien est supprimé, la cible reste', async () => {
  const { root, outside } = setup();
  symlinkSync(join(outside, 'precieux.txt'), join(root, 'lien'));
  symlinkSync(join(outside, 'dossier'), join(root, 'lien-dossier'));
  const l = await listTmpEntries(root, { mountPoints: noMounts });
  expect(l.entries.find((e) => e.name === 'lien')).toMatchObject({ kind: 'link', refusal: null });
  expect(l.entries.find((e) => e.name === 'lien-dossier')).toMatchObject({ kind: 'link', refusal: null });
  const r = await deleteTmpEntries(root, [item(root, 'lien'), item(root, 'lien-dossier')], { mountPoints: noMounts });
  expect(r.results).toEqual([{ name: 'lien', ok: true }, { name: 'lien-dossier', ok: true }]);
  expect(existsSync(join(root, 'lien'))).toBe(false);
  expect(existsSync(join(root, 'lien-dossier'))).toBe(false);
  outsideIntact(outside);
});

test('dossier contenant des liens vers l’extérieur (à plusieurs niveaux) : supprimé, cibles intactes', async () => {
  const { root, outside } = setup();
  const d = join(root, 'projet');
  mkdirSync(join(d, 'a', 'b'), { recursive: true });
  writeFileSync(join(d, 'a', 'b', 'f'), 'x');
  symlinkSync(outside, join(d, 'vers-outside'));
  symlinkSync(join(outside, 'dossier'), join(d, 'a', 'vers-dossier'));
  symlinkSync(join(outside, 'precieux.txt'), join(d, 'a', 'b', 'vers-fichier'));
  symlinkSync('../../..', join(d, 'a', 'b', 'remonte'));
  const r = await deleteTmpEntries(root, [item(root, 'projet')], { mountPoints: noMounts });
  expect(r.results).toEqual([{ name: 'projet', ok: true }]);
  expect(existsSync(d)).toBe(false);
  outsideIntact(outside);
  expect(existsSync(root)).toBe(true);
});

test('échange par un lien entre la liste et la suppression : refusé, rien de supprimé', async () => {
  const { root, outside } = setup();
  mkdirSync(join(root, 'a'));
  writeFileSync(join(root, 'a', 'f'), 'x');
  const shown = item(root, 'a');
  renameSync(join(root, 'a'), join(root, 'a.orig'));
  symlinkSync(join(outside, 'dossier'), join(root, 'a'));
  const r = await deleteTmpEntries(root, [shown], { mountPoints: noMounts });
  expect(r.results).toEqual([{ name: 'a', ok: false, reason: 'a changé depuis l’affichage' }]);
  expect(lstatSync(join(root, 'a')).isSymbolicLink()).toBe(true);
  expect(existsSync(join(root, 'a.orig', 'f'))).toBe(true);
  outsideIntact(outside);
});

test('élément disparu : refusé', async () => {
  const { root } = setup();
  writeFileSync(join(root, 'f'), 'x');
  const shown = item(root, 'f');
  rmSync(join(root, 'f'));
  const r = await deleteTmpEntries(root, [shown], { mountPoints: noMounts });
  expect(r.results).toEqual([{ name: 'f', ok: false, reason: 'disparu' }]);
});

test('fichier d’un autre utilisateur (uid simulé) : refusé', async () => {
  const { root } = setup();
  writeFileSync(join(root, 'f'), 'x');
  const other = process.getuid!() + 1;
  const l = await listTmpEntries(root, { mountPoints: noMounts, uid: other });
  expect(l.entries.find((e) => e.name === 'f')?.refusal).toBe('autre utilisateur');
  const r = await deleteTmpEntries(root, [item(root, 'f')], { mountPoints: noMounts, uid: other });
  expect(r.results).toEqual([{ name: 'f', ok: false, reason: 'autre utilisateur' }]);
  expect(existsSync(join(root, 'f'))).toBe(true);
});

test('jamais en root', async () => {
  const { root } = setup();
  writeFileSync(join(root, 'f'), 'x');
  const r = await deleteTmpEntries(root, [item(root, 'f')], { mountPoints: noMounts, uid: 0 });
  expect(r.results).toEqual([{ name: 'f', ok: false, reason: 'refusé : proc-watch tourne en root' }]);
  expect(existsSync(join(root, 'f'))).toBe(true);
});

test('fichier ouvert / dossier courant d’un processus enfant : refusé, puis supprimable après sa sortie', async () => {
  const { root } = setup();
  mkdirSync(join(root, 'ouvert'));
  writeFileSync(join(root, 'ouvert', 'f'), 'x');
  mkdirSync(join(root, 'courant'));
  const a = spawn('sh', ['-c', 'exec 3<"$0"; exec sleep 30', join(root, 'ouvert', 'f')], { stdio: 'ignore' });
  const b = spawn('sleep', ['30'], { cwd: join(root, 'courant'), stdio: 'ignore' });
  children.push(a, b);
  await settled(a);
  await settled(b);
  const l = await listTmpEntries(root, { mountPoints: noMounts });
  const by = Object.fromEntries(l.entries.map((e) => [e.name, e]));
  expect(by.ouvert.refusal).toBe(`utilisé par sleep (pid ${a.pid})`);
  expect(by.courant.refusal).toBe(`utilisé par sleep (pid ${b.pid})`);
  const items = [item(root, 'ouvert'), item(root, 'courant')];
  const r1 = await deleteTmpEntries(root, items, { mountPoints: noMounts });
  expect(r1.results).toEqual([
    { name: 'ouvert', ok: false, reason: `utilisé par sleep (pid ${a.pid})` },
    { name: 'courant', ok: false, reason: `utilisé par sleep (pid ${b.pid})` },
  ]);
  expect(existsSync(join(root, 'ouvert', 'f'))).toBe(true);
  a.kill('SIGKILL');
  b.kill('SIGKILL');
  await exited(a);
  await exited(b);
  const r2 = await deleteTmpEntries(root, items, { mountPoints: noMounts });
  expect(r2.results).toEqual([{ name: 'ouvert', ok: true }, { name: 'courant', ok: true }]);
  expect(existsSync(join(root, 'ouvert'))).toBe(false);
});

test('fichier projeté en mémoire (maps) par un enfant : refusé', async () => {
  const { root } = setup();
  mkdirSync(join(root, 'bin'));
  const copy = join(root, 'bin', 'sleep');
  writeFileSync(copy, readFileSync(spawnSync('sh', ['-c', 'command -v sleep']).stdout.toString().trim()), { mode: 0o755 });
  const c = spawn(copy, ['30'], { stdio: 'ignore', cwd: homedir() });
  children.push(c);
  await settled(c);
  const u = await scanTmpUsers(root);
  expect(u.complete).toBe(true);
  expect(u.users.get('bin')).toEqual({ pid: c.pid, name: 'sleep' });
});

test('noms injectés (« .. », « / », « . ») : refusés, rien hors de la racine touché', async () => {
  const { root, base, outside } = setup();
  writeFileSync(join(base, 'voisin'), 'x');
  const st = lstatSync(root);
  const bad = ['..', '.', '../voisin', '../outside', 'a/b', '/etc', `${outside}/precieux.txt`, ''];
  const r = await deleteTmpEntries(root, bad.map((name) => ({ name, ino: st.ino, dev: st.dev })), { mountPoints: noMounts });
  expect(r.results.map((x) => x.reason)).toEqual(bad.map(() => 'nom invalide'));
  expect(existsSync(join(base, 'voisin'))).toBe(true);
  expect(existsSync(root)).toBe(true);
  outsideIntact(outside);
});

test('plus de 50 éléments, ou requête mal formée : rejetée entière', async () => {
  const { root } = setup();
  writeFileSync(join(root, 'f'), 'x');
  const one = item(root, 'f');
  await expect(deleteTmpEntries(root, Array.from({ length: 51 }, () => one), { mountPoints: noMounts })).rejects.toThrow(/50/);
  await expect(deleteTmpEntries(root, [{ name: 'f' }] as unknown as TmpDeleteItem[], { mountPoints: noMounts })).rejects.toThrow();
  expect(existsSync(join(root, 'f'))).toBe(true);
});

test('point de montage, ou dossier qui en contient un : refusé (sans lstat du montage)', async () => {
  const { root } = setup();
  mkdirSync(join(root, 'm'));
  mkdirSync(join(root, 'p', 'sous'), { recursive: true });
  const mounts = async () => [join(root, 'm'), join(root, 'p', 'sous')];
  const l = await listTmpEntries(root, { mountPoints: mounts });
  expect(l.entries.find((e) => e.name === 'm')).toBeUndefined(); // jamais parcouru ni affiché
  expect(l.entries.find((e) => e.name === 'p')?.refusal).toBe('contient un point de montage');
  const r = await deleteTmpEntries(root, [item(root, 'm'), item(root, 'p')], { mountPoints: mounts });
  expect(r.results).toEqual([
    { name: 'm', ok: false, reason: 'point de montage' },
    { name: 'p', ok: false, reason: 'contient un point de montage' },
  ]);
  expect(existsSync(join(root, 'p', 'sous'))).toBe(true);
});

test('vérification des processus incomplète (budget dépassé) : « impossible de vérifier »', async () => {
  const { root } = setup();
  writeFileSync(join(root, 'f'), 'x');
  const l = await listTmpEntries(root, { mountPoints: noMounts, procBudgetMs: 0 });
  expect(l.entries.find((e) => e.name === 'f')?.refusal).toBe('impossible de vérifier');
  const r = await deleteTmpEntries(root, [item(root, 'f')], { mountPoints: noMounts, procBudgetMs: 0 });
  expect(r.results).toEqual([{ name: 'f', ok: false, reason: 'impossible de vérifier' }]);
  expect(existsSync(join(root, 'f'))).toBe(true);
});

test('budget de temps : les éléments au-delà sont refusés « temps écoulé »', async () => {
  const { root } = setup();
  for (const n of ['a', 'b', 'c']) writeFileSync(join(root, n), 'x');
  let t = 0;
  // l'horloge est lue au début puis avant chaque élément, et avance de 600 ms à chaque lecture ; budget 1 s : seul le premier passe
  const now = () => (t += 600);
  const r = await deleteTmpEntries(root, ['a', 'b', 'c'].map((n) => item(root, n)), { mountPoints: noMounts, budgetMs: 1000, now });
  expect(r.results[0]).toEqual({ name: 'a', ok: true });
  expect(r.results.slice(1)).toEqual([
    { name: 'b', ok: false, reason: 'temps écoulé' },
    { name: 'c', ok: false, reason: 'temps écoulé' },
  ]);
  expect(existsSync(join(root, 'b'))).toBe(true);
});

test('racine donnée par un lien : résolue, la suppression reste dans la racine réelle', async () => {
  const { root, base, outside } = setup();
  mkdirSync(join(root, 'd'));
  symlinkSync(root, join(base, 'lien-racine'));
  const r = await deleteTmpEntries(join(base, 'lien-racine'), [item(root, 'd')], { mountPoints: noMounts });
  expect(r.results).toEqual([{ name: 'd', ok: true }]);
  expect(existsSync(join(root, 'd'))).toBe(false);
  outsideIntact(outside);
});

test('place libérée : mesurée élément par élément avant suppression, doublons ignorés', async () => {
  const { root } = setup();
  writeFileSync(join(root, 'gros'), Buffer.alloc(4 * 1024 * 1024, 1));
  const it = item(root, 'gros');
  mkdirSync(join(root, 'd', 'sous'), { recursive: true });
  writeFileSync(join(root, 'd', 'sous', 'f'), Buffer.alloc(2 * 1024 * 1024, 1));
  symlinkSync(join(root, 'gros'), join(root, 'd', 'lien')); // le lien compte pour lui-même, jamais sa cible
  const r = await deleteTmpEntries(root, [it, it, item(root, 'd')], { mountPoints: noMounts });
  expect(r.results).toEqual([{ name: 'gros', ok: true }, { name: 'd', ok: true }]);
  expect(r.freedKB).toBeGreaterThanOrEqual(6 * 1024);
  expect(r.freedKB).toBeLessThan(7 * 1024);
});

test('racine : /tmp, sauf PROC_WATCH_TMP_ROOT absolu hors production et hors app empaquetée', () => {
  expect(tmpRootFromEnv({}, false)).toBe('/tmp');
  expect(tmpRootFromEnv({ PROC_WATCH_TMP_ROOT: '/home/u/.cache/pw-tmpclean-x' }, false)).toBe('/home/u/.cache/pw-tmpclean-x');
  expect(tmpRootFromEnv({ PROC_WATCH_TMP_ROOT: '/home/u/.cache/pw-tmpclean-x', NODE_ENV: 'production' }, false)).toBe('/tmp');
  expect(tmpRootFromEnv({ PROC_WATCH_TMP_ROOT: '/home/u/.cache/pw-tmpclean-x' }, true)).toBe('/tmp');
  expect(tmpRootFromEnv({ PROC_WATCH_TMP_ROOT: 'relatif' }, false)).toBe('/tmp');
  expect(tmpRootFromEnv({ PROC_WATCH_TMP_ROOT: '/' }, false)).toBe('/tmp');
  expect(tmpRootFromEnv({ PROC_WATCH_TMP_ROOT: '' }, false)).toBe('/tmp');
});

test('événement tmp_clean : seulement si quelque chose a été supprimé', () => {
  expect(tmpCleanEvent({ freedKB: 0, results: [{ name: 'a', ok: false, reason: 'système' }] }, 5)).toBeNull();
  expect(tmpCleanEvent({ freedKB: 12, results: [{ name: 'a', ok: true }, { name: 'b', ok: false, reason: 'système' }] }, 5)).toEqual({
    ts: 5, type: 'tmp_clean', groupKey: null, detail: { freedKB: 12, deleted: ['a'], refused: [{ name: 'b', reason: 'système' }] },
  });
});
