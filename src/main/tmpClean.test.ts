// Toutes les racines sont sous ~/.cache/pw-tmpclean-* (jamais /tmp) et supprimées à la fin.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, test } from 'vitest';
import type { TmpConfirmSummary, TmpDeleteItem } from '../core/tmpClean';
import { checkGnuRm, confirmText, createTmpCleaner, scanTmpUsers, tmpCleanEvent, tmpRootFromEnv, type CleanerOptions } from './tmpClean';

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
  const st = lstatSync(join(root, name), { bigint: true });
  return { name, ino: String(st.ino), dev: String(st.dev) };
};
const noMounts = async () => [] as string[];
/** Nettoyeur de test : sans montage, confirmation acceptée (et enregistrée). */
function cleaner(root: string, o: Partial<CleanerOptions> = {}) {
  const asked: TmpConfirmSummary[] = [];
  const c = createTmpCleaner(root, {
    mountPoints: noMounts,
    confirm: async (s) => {
      asked.push(s);
      return true;
    },
    ...o,
  });
  return Object.assign(c, { asked });
}
/** Liste puis supprime (le cas normal : la dernière liste autorise). */
async function listAndDelete(root: string, names: string[], o: Partial<CleanerOptions> = {}) {
  const c = cleaner(root, o);
  await c.list();
  return { c, out: await c.delete(names.map((n) => item(root, n))) };
}
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
const noTrashLeft = (root: string) => expect(readdirSync(root).filter((n) => n.startsWith('.proc-watch-trash-'))).toEqual([]);

test('GNU rm présent (sinon suppression désactivée)', async () => {
  expect(await checkGnuRm()).toBeNull();
  expect(await checkGnuRm('/usr/bin/true')).toMatch(/pas GNU rm/);
  const { root } = setup();
  writeFileSync(join(root, 'f'), 'x');
  const c = cleaner(root, { rmPath: '/usr/bin/true' });
  const l = await c.list();
  expect(l.disabled).toMatch(/pas GNU rm/);
  expect(l.entries[0].refusal).toMatch(/pas GNU rm/);
  const out = await c.delete([item(root, 'f')]);
  expect(out.results[0]).toMatchObject({ ok: false });
  expect(existsSync(join(root, 'f'))).toBe(true);
});

test('liste : dossiers et fichiers de premier niveau, cache étiqueté, récent signalé, système refusé', async () => {
  const { root } = setup();
  mkdirSync(join(root, 'jest_rs'));
  writeFileSync(join(root, 'jest_rs', 'x'), Buffer.alloc(64 * 1024, 1));
  mkdirSync(join(root, 'mon-dossier'));
  writeFileSync(join(root, 'gros.bin'), Buffer.alloc(32 * 1024, 1));
  utimesSync(join(root, 'gros.bin'), new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  mkdirSync(join(root, '.X11-unix'));
  const l = await cleaner(root).list();
  expect(l.root).toBe(root);
  expect(l.disabled).toBeNull();
  const by = Object.fromEntries(l.entries.map((e) => [e.name, e]));
  expect(by.jest_rs).toMatchObject({ kind: 'dir', cache: true, refusal: null, recent: true });
  expect(by.jest_rs.sizeKB).toBeGreaterThanOrEqual(64);
  expect(by['mon-dossier']).toMatchObject({ kind: 'dir', cache: false, refusal: null });
  expect(by['gros.bin']).toMatchObject({ kind: 'file', refusal: null, recent: false });
  expect(by['.X11-unix'].refusal).toBe('système');
  expect(by.jest_rs.ino).toBe(String(lstatSync(join(root, 'jest_rs'), { bigint: true }).ino));
});

test('socket et FIFO de premier niveau : refusés', async () => {
  const { root } = setup();
  const srv = createServer();
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(join(root, 'sock'), r));
  expect(spawnSync('mkfifo', [join(root, 'fifo')]).status).toBe(0);
  const c = cleaner(root);
  const l = await c.list();
  const by = Object.fromEntries(l.entries.map((e) => [e.name, e]));
  expect(by.sock.refusal).toMatch(/socket|utilisé/);
  expect(by.fifo.refusal).toBe('FIFO');
  const r = await c.delete([item(root, 'sock'), item(root, 'fifo')]);
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
  const { out } = await listAndDelete(root, ['tmuxlike']);
  expect(out.results[0]).toEqual({ name: 'tmuxlike', ok: false, reason: 'pas dans la dernière liste affichée' });
  const l = await cleaner(root).list();
  expect(l.entries.find((e) => e.name === 'tmuxlike')?.refusal).toMatch(new RegExp(`^utilisé par .+ \\(pid ${process.pid}\\)$`));
  expect(existsSync(join(root, 'tmuxlike', 'default'))).toBe(true);
});

test('lien vers un fichier ou un dossier hors de la racine : seul le lien est supprimé, la cible reste', async () => {
  const { root, outside } = setup();
  symlinkSync(join(outside, 'precieux.txt'), join(root, 'lien'));
  symlinkSync(join(outside, 'dossier'), join(root, 'lien-dossier'));
  const { c, out } = await listAndDelete(root, ['lien', 'lien-dossier']);
  expect(out.results).toEqual([{ name: 'lien', ok: true }, { name: 'lien-dossier', ok: true }]);
  expect(c.asked[0].items.map((i) => i.kind)).toEqual(['link', 'link']);
  expect(existsSync(join(root, 'lien'))).toBe(false);
  expect(existsSync(join(root, 'lien-dossier'))).toBe(false);
  outsideIntact(outside);
  noTrashLeft(root);
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
  const { out } = await listAndDelete(root, ['projet']);
  expect(out.results).toEqual([{ name: 'projet', ok: true }]);
  expect(existsSync(d)).toBe(false);
  outsideIntact(outside);
  noTrashLeft(root);
});

test('échange par un lien entre la liste et la suppression : refusé, rien de supprimé', async () => {
  const { root, outside } = setup();
  mkdirSync(join(root, 'a'));
  writeFileSync(join(root, 'a', 'f'), 'x');
  const c = cleaner(root);
  await c.list();
  const shown = item(root, 'a');
  renameSync(join(root, 'a'), join(root, 'a.orig'));
  symlinkSync(join(outside, 'dossier'), join(root, 'a'));
  const r = await c.delete([shown]);
  expect(r.results).toEqual([{ name: 'a', ok: false, reason: 'a changé depuis l’affichage' }]);
  expect(lstatSync(join(root, 'a')).isSymbolicLink()).toBe(true);
  expect(existsSync(join(root, 'a.orig', 'f'))).toBe(true);
  outsideIntact(outside);
});

test('élément disparu : refusé', async () => {
  const { root } = setup();
  writeFileSync(join(root, 'f'), 'x');
  const c = cleaner(root);
  await c.list();
  const shown = item(root, 'f');
  rmSync(join(root, 'f'));
  expect((await c.delete([shown])).results).toEqual([{ name: 'f', ok: false, reason: 'disparu' }]);
});

test('fichier d’un autre utilisateur (uid simulé) : refusé', async () => {
  const { root } = setup();
  writeFileSync(join(root, 'f'), 'x');
  const other = process.getuid!() + 1;
  const c = cleaner(root, { uid: other });
  const l = await c.list();
  expect(l.entries.find((e) => e.name === 'f')?.refusal).toBe('autre utilisateur');
  expect((await c.delete([item(root, 'f')])).results).toEqual([{ name: 'f', ok: false, reason: 'pas dans la dernière liste affichée' }]);
  expect(existsSync(join(root, 'f'))).toBe(true);
});

test('jamais en root', async () => {
  const { root } = setup();
  writeFileSync(join(root, 'f'), 'x');
  const l = await cleaner(root, { uid: 0 }).list();
  expect(l.entries[0].refusal).toBe('refusé : proc-watch tourne en root');
});

test('seuls les éléments supprimables de la dernière liste sont acceptés (liste autorisée du main)', async () => {
  const { root } = setup();
  writeFileSync(join(root, 'f'), 'x');
  const c = cleaner(root);
  // sans liste : refusé
  expect((await c.delete([item(root, 'f')])).results[0].reason).toBe('pas dans la dernière liste affichée');
  await c.list();
  // ino falsifié : refusé
  expect((await c.delete([{ ...item(root, 'f'), ino: '12345' }])).results[0].reason).toBe('pas dans la dernière liste affichée');
  // liste périmée : refusé
  let t = 0;
  const c2 = cleaner(root, { now: () => t, allowTtlMs: 1000 });
  await c2.list();
  t = 5000;
  expect((await c2.delete([item(root, 'f')])).results[0].reason).toBe('pas dans la dernière liste affichée');
  expect(c.asked).toEqual([]);
  expect(existsSync(join(root, 'f'))).toBe(true);
});

test('confirmation du main : chemins, taille totale ; « Annuler » ne touche à rien', async () => {
  const { root } = setup();
  writeFileSync(join(root, 'f'), Buffer.alloc(8192, 1));
  const c = cleaner(root, { confirm: async () => false });
  await c.list();
  const out = await c.delete([item(root, 'f')]);
  expect(out).toMatchObject({ cancelled: true, freedKB: 0, results: [{ name: 'f', ok: false, reason: 'annulé' }] });
  expect(existsSync(join(root, 'f'))).toBe(true);
  const ok = cleaner(root);
  await ok.list();
  await ok.delete([item(root, 'f')]);
  expect(ok.asked[0]).toMatchObject({ root, items: [{ name: 'f', kind: 'file', recent: true }] });
  expect(ok.asked[0].totalKB).toBeGreaterThanOrEqual(8);
});

test('texte de la confirmation : chemins exacts échappés, total, définitif, non vérifiables, limite des sockets', () => {
  const t = confirmText(
    { root: '/tmp', items: [{ name: 'a‮b', kind: 'dir', sizeKB: 2048, recent: true }, { name: 'l', kind: 'link', sizeKB: 4, recent: false }], totalKB: 2052, uninspectable: [{ pid: 1, name: 'warp' }] },
    (kb) => `${kb} Ko`,
  );
  expect(t.message).toBe('Supprimer définitivement ces 2 éléments de /tmp ?');
  expect(t.detail).toContain('⚠ /tmp/a\\u{202e}b/ — 2048 Ko — ⚠ modifié il y a moins de 5 min');
  expect(t.detail).toContain('/tmp/l (le lien seul) — 4 Ko');
  expect(t.detail).toContain('Total : 2052 Ko');
  expect(t.detail).toContain('la corbeille ne libérerait pas la RAM');
  expect(t.detail).toContain('warp');
  expect(t.detail).toContain('/proc/net/unix');
  expect(t.detail).not.toContain('‮');
});

test('fichier ouvert / dossier courant d’un processus enfant : refusé, puis supprimable après sa sortie', async () => {
  const { root } = setup();
  mkdirSync(join(root, 'ouvert'));
  writeFileSync(join(root, 'ouvert', 'f'), 'x');
  mkdirSync(join(root, 'courant'));
  const c = cleaner(root);
  await c.list(); // liste autorisée prise avant les enfants
  const items = [item(root, 'ouvert'), item(root, 'courant')];
  const a = spawn('sh', ['-c', 'exec 3<"$0"; exec sleep 30', join(root, 'ouvert', 'f')], { stdio: 'ignore' });
  const b = spawn('sleep', ['30'], { cwd: join(root, 'courant'), stdio: 'ignore' });
  children.push(a, b);
  await settled(a);
  await settled(b);
  const r1 = await c.delete(items); // revérifié juste avant : utilisés
  expect(r1.results).toEqual([
    { name: 'ouvert', ok: false, reason: `utilisé par sleep (pid ${a.pid})` },
    { name: 'courant', ok: false, reason: `utilisé par sleep (pid ${b.pid})` },
  ]);
  const l = await c.list();
  const by = Object.fromEntries(l.entries.map((e) => [e.name, e]));
  expect(by.ouvert.refusal).toBe(`utilisé par sleep (pid ${a.pid})`);
  expect(existsSync(join(root, 'ouvert', 'f'))).toBe(true);
  a.kill('SIGKILL');
  b.kill('SIGKILL');
  await exited(a);
  await exited(b);
  await c.list();
  const r2 = await c.delete(items);
  expect(r2.results).toEqual([{ name: 'ouvert', ok: true }, { name: 'courant', ok: true }]);
  expect(existsSync(join(root, 'ouvert'))).toBe(false);
  noTrashLeft(root);
});

test('fichier projeté en mémoire (maps) par un enfant : vu', async () => {
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
  const c = cleaner(root);
  await c.list();
  const st = lstatSync(root, { bigint: true });
  const bad = ['..', '.', '../voisin', '../outside', 'a/b', '/etc', `${outside}/precieux.txt`, ''];
  const r = await c.delete(bad.map((name) => ({ name, ino: String(st.ino), dev: String(st.dev) })));
  expect(r.results.map((x) => x.reason)).toEqual(bad.map(() => 'nom invalide'));
  expect(c.asked).toEqual([]);
  expect(existsSync(join(base, 'voisin'))).toBe(true);
  expect(existsSync(root)).toBe(true);
  outsideIntact(outside);
});

test('plus de 50 éléments, ou requête mal formée : rejetée entière', async () => {
  const { root } = setup();
  writeFileSync(join(root, 'f'), 'x');
  const c = cleaner(root);
  await c.list();
  const one = item(root, 'f');
  await expect(c.delete(Array.from({ length: 51 }, () => one))).rejects.toThrow(/50/);
  await expect(c.delete([{ name: 'f' }])).rejects.toThrow();
  await expect(c.delete([{ ...one, ino: Number(one.ino) }])).rejects.toThrow();
  expect(existsSync(join(root, 'f'))).toBe(true);
});

test('point de montage, ou dossier qui en contient un : refusé (sans lstat du montage)', async () => {
  const { root } = setup();
  mkdirSync(join(root, 'm'));
  mkdirSync(join(root, 'p', 'sous'), { recursive: true });
  const l = await cleaner(root, { mountPoints: async () => [join(root, 'm'), join(root, 'p', 'sous')] }).list();
  expect(l.entries.find((e) => e.name === 'm')).toBeUndefined(); // jamais parcouru ni affiché
  expect(l.entries.find((e) => e.name === 'p')?.refusal).toBe('contient un point de montage');
});

test('montage apparu entre la liste et la suppression : refusé', async () => {
  const { root } = setup();
  mkdirSync(join(root, 'p', 'sous'), { recursive: true });
  let mounts: string[] = [];
  const c = cleaner(root, { mountPoints: async () => mounts });
  await c.list();
  mounts = [join(root, 'p', 'sous')];
  expect((await c.delete([item(root, 'p')])).results[0].reason).toBe('contient un point de montage');
  expect(existsSync(join(root, 'p', 'sous'))).toBe(true);
});

test('points de montage illisibles : tout est refusé', async () => {
  const { root } = setup();
  writeFileSync(join(root, 'f'), 'x');
  const l = await cleaner(root, { mountPoints: async () => null }).list();
  expect(l.entries.find((e) => e.name === 'f')?.refusal).toBe('impossible de vérifier (points de montage illisibles)');
});

test('vérification des processus incomplète (budget dépassé) : « impossible de vérifier »', async () => {
  const { root } = setup();
  writeFileSync(join(root, 'f'), 'x');
  const l = await cleaner(root, { procBudgetMs: 0 }).list();
  expect(l.entries.find((e) => e.name === 'f')?.refusal).toBe('impossible de vérifier');
});

test('quarantaine restée d’une suppression interrompue : signalée, jamais proposée', async () => {
  const { root } = setup();
  mkdirSync(join(root, '.proc-watch-trash-abc123'));
  const l = await cleaner(root).list();
  expect(l.entries[0].refusal).toBe('quarantaine de proc-watch (suppression interrompue), à vérifier');
});

test('nom d’un programme non vérifiable (warp, kwin…) : « peut-être utilisé par … »', async () => {
  const { root } = setup();
  mkdirSync(join(root, 'warp-terminal-x'));
  const l = await cleaner(root).list();
  expect(l.entries[0].refusal).toBe('peut-être utilisé par warp (non vérifiable)');
});

test('budget de temps : les éléments au-delà sont refusés « temps écoulé »', async () => {
  const { root } = setup();
  for (const n of ['a', 'b', 'c']) writeFileSync(join(root, n), 'x');
  let t = 0;
  // l'horloge avance de 600 ms à chaque lecture ; budget 1 s : seul le premier élément passe
  const c = cleaner(root, { budgetMs: 1000, allowTtlMs: Number.MAX_SAFE_INTEGER, now: () => (t += 600) });
  await c.list();
  const r = await c.delete(['a', 'b', 'c'].map((n) => item(root, n)));
  expect(r.results[0]).toEqual({ name: 'a', ok: true });
  expect(r.results.slice(1).map((x) => x.reason)).toEqual(['temps écoulé', 'temps écoulé']);
  expect(existsSync(join(root, 'b'))).toBe(true);
  noTrashLeft(root);
});

test('délai de rm dépassé : SIGKILL, l’élément reste en quarantaine, la suppression suivante reste possible', async () => {
  const { root, base } = setup();
  mkdirSync(join(root, 'd'));
  // faux rm : répond comme GNU à --version, puis bloque
  const fake = join(base, 'rm-lent');
  writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "rm (GNU coreutils) 9.0"; exit 0; fi\nexec sleep 30\n', { mode: 0o755 });
  const c = cleaner(root, { rmPath: fake, rmTimeoutMs: 300 });
  await c.list();
  const t0 = Date.now();
  const r = await c.delete([item(root, 'd')]);
  expect(Date.now() - t0).toBeLessThan(5000);
  expect(r.partial).toBe(true);
  expect(r.results[0].reason).toMatch(/^échec : délai dépassé \(montage figé \?\) ; le reste est dans .*\.proc-watch-trash-/);
  await c.list();
  writeFileSync(join(root, 'g'), 'x');
  await c.list();
  await expect(c.delete([item(root, 'g')])).resolves.toBeTruthy(); // verrou relâché
});

test('racine donnée par un lien : résolue, la suppression reste dans la racine réelle', async () => {
  const { root, base, outside } = setup();
  mkdirSync(join(root, 'd'));
  symlinkSync(root, join(base, 'lien-racine'));
  const { out } = await listAndDelete(join(base, 'lien-racine'), ['d']);
  expect(out.results).toEqual([{ name: 'd', ok: true }]);
  expect(existsSync(join(root, 'd'))).toBe(false);
  outsideIntact(outside);
});

test('place libérée : tailles de la dernière liste, doublons ignorés', async () => {
  const { root } = setup();
  writeFileSync(join(root, 'gros'), Buffer.alloc(4 * 1024 * 1024, 1));
  mkdirSync(join(root, 'd', 'sous'), { recursive: true });
  writeFileSync(join(root, 'd', 'sous', 'f'), Buffer.alloc(2 * 1024 * 1024, 1));
  const c = cleaner(root);
  await c.list();
  const it = item(root, 'gros');
  const r = await c.delete([it, it, item(root, 'd')]);
  expect(r.results).toEqual([{ name: 'gros', ok: true }, { name: 'd', ok: true }]);
  expect(r.freedKB).toBeGreaterThanOrEqual(6 * 1024);
  expect(r.freedKB).toBeLessThan(7 * 1024);
});

/**
 * Régression C1 (revue sécurité) : un processus du même utilisateur remplace un sous-dossier de l'élément par un lien
 * vers un dossier « victime » voisin dès que la suppression commence (mtime du sous-dossier), y compris dans la
 * quarantaine. Aucun fichier de la victime ne doit disparaître.
 */
async function race(mode: 'once' | 'flip') {
  const { base, root } = setup();
  const N = 3000;
  const victim = join(base, 'victim');
  mkdirSync(join(root, 'item', 'd'), { recursive: true });
  mkdirSync(victim);
  for (let i = 0; i < N; i++) {
    const n = `f${String(i).padStart(5, '0')}`;
    writeFileSync(join(root, 'item', 'd', n), 'x');
    writeFileSync(join(victim, n), 'precious');
  }
  symlinkSync(victim, join(base, 'L'));
  const c = cleaner(root);
  await c.list();
  const py = `
import os,sys,time,glob
b,mode=sys.argv[1],sys.argv[2]; root=os.path.join(b,'root'); h=os.path.join(b,'hold'); L=os.path.join(b,'L')
def cands(): return [os.path.join(root,'item','d')]+glob.glob(os.path.join(root,'.proc-watch-trash-*','item','d'))
m0=os.stat(os.path.join(root,'item','d')).st_mtime_ns
print('ready',flush=True)
end=time.time()+15
while time.time()<end:
    hit=None
    for d in cands():
        try:
            if os.lstat(d).st_mtime_ns!=m0: hit=d; break
        except OSError: pass
    if not hit: continue
    if mode=='once':
        try:
            os.rename(hit,h); os.rename(L,hit); print('swapped',flush=True)
        except OSError as e: print('swap failed',e,flush=True)
        break
    n=0; stop=time.time()+3
    while time.time()<stop:
        try:
            os.rename(hit,h); os.rename(L,hit); os.rename(hit,L); os.rename(h,hit); n+=1
        except OSError: pass
    print('flips',n,flush=True); break
`;
  const atk = spawn('python3', ['-I', '-c', py, base, mode], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(atk);
  let said = '';
  atk.stdout!.on('data', (b) => (said += String(b)));
  await new Promise<void>((r) => atk.stdout!.once('data', () => r()));
  const out = await c.delete([item(root, 'item')]);
  await new Promise((r) => setTimeout(r, mode === 'flip' ? 3500 : 300));
  atk.kill('SIGKILL');
  await exited(atk);
  return { out, said, left: readdirSync(victim).length, N };
}

test('C1 : sous-dossier remplacé par un lien pendant la suppression (une fois) : aucun fichier extérieur perdu', async () => {
  const r = await race('once');
  expect(r.said).toContain('swapped'); // l'attaque a bien eu lieu (dans la quarantaine)
  expect(r.left).toBe(r.N);
}, 30_000);

test('C1 : attaquant qui alterne dossier/lien en continu : aucun fichier extérieur perdu', async () => {
  const r = await race('flip');
  expect(r.said).toMatch(/flips [1-9]/);
  expect(r.left).toBe(r.N);
}, 30_000);

test('racine de test : seulement sous ~/.cache/pw-… avec le fichier témoin ; sinon /tmp', () => {
  const { base } = setup();
  const home = homedir();
  expect(tmpRootFromEnv({}, home)).toEqual({ root: '/tmp', warning: null });
  // sans témoin
  expect(tmpRootFromEnv({ PROC_WATCH_TMP_ROOT: base }, home).root).toBe('/tmp');
  writeFileSync(join(base, '.proc-watch-test-root'), '');
  expect(tmpRootFromEnv({ PROC_WATCH_TMP_ROOT: base }, home)).toEqual({ root: base, warning: null });
  // même avec NODE_ENV=production, la règle est la même (pas de dépendance à NODE_ENV)
  expect(tmpRootFromEnv({ PROC_WATCH_TMP_ROOT: base, NODE_ENV: 'production' }, home).root).toBe(base);
  // chemin qui ressort de ~/.cache/pw- par « .. », home, /, relatif : refusés
  for (const r of [join(base, '..'), home, '/', 'relatif', join(home, '.cache'), `${base}/../../.cache`]) {
    const t = tmpRootFromEnv({ PROC_WATCH_TMP_ROOT: r }, home);
    expect(t.root, r).toBe('/tmp');
    expect(t.warning, r).toMatch(/PROC_WATCH_TMP_ROOT ignoré/);
  }
  // un lien sous ~/.cache/pw- vers ailleurs : le chemin réel compte
  const link = join(base, 'vers-home');
  symlinkSync(home, link);
  expect(tmpRootFromEnv({ PROC_WATCH_TMP_ROOT: link }, home).root).toBe('/tmp');
});

test('événement tmp_clean : si quelque chose a été supprimé, ou en partie', () => {
  expect(tmpCleanEvent({ freedKB: 0, results: [{ name: 'a', ok: false, reason: 'système' }] }, 5)).toBeNull();
  expect(tmpCleanEvent({ freedKB: 12, results: [{ name: 'a', ok: true }, { name: 'b', ok: false, reason: 'système' }] }, 5)).toEqual({
    ts: 5, type: 'tmp_clean', groupKey: null, detail: { freedKB: 12, deleted: ['a'], refused: [{ name: 'b', reason: 'système' }] },
  });
  expect(tmpCleanEvent({ freedKB: 0, partial: true, results: [{ name: 'a', ok: false, reason: 'échec : x' }] }, 5)).toEqual({
    ts: 5, type: 'tmp_clean', groupKey: null, detail: { freedKB: 0, deleted: [], refused: [{ name: 'a', reason: 'échec : x' }], partial: true },
  });
});

/** Faux rm : répond comme GNU à --version ; sinon exécute `attack` (sh) puis délègue au vrai rm avec les mêmes arguments. */
function attackingRm(base: string, attack: string): string {
  const p = join(base, 'rm-attaquant');
  writeFileSync(p, `#!/bin/sh\nif [ "$1" = "--version" ]; then exec /usr/bin/rm --version; fi\n${attack}\nexec /usr/bin/rm "$@"\n`, { mode: 0o755 });
  return p;
}

test('N1 q3 : quarantaine remplacée par un lien juste avant rm : aucun fichier extérieur perdu, l’élément choisi est supprimé', async () => {
  const { base, root } = setup();
  mkdirSync(join(root, 'item'));
  for (let i = 0; i < 20; i++) writeFileSync(join(root, 'item', `x${i}`), 'x');
  mkdirSync(join(base, 'vparent', 'item'), { recursive: true });
  for (let i = 0; i < 10; i++) writeFileSync(join(base, 'vparent', 'item', `p${i}`), 'precieux');
  const rmPath = attackingRm(base, `q=$(ls -d "${root}"/.proc-watch-trash-* | head -n 1)\nmv "$q" "${base}/hold" && ln -s "${base}/vparent" "$q"`);
  const c = cleaner(root, { rmPath });
  await c.list();
  const out = await c.delete([item(root, 'item')]);
  expect(readdirSync(join(base, 'vparent', 'item'))).toHaveLength(10); // victime intacte
  expect(existsSync(join(base, 'hold'))).toBe(true); // l'attaque a bien eu lieu
  expect(existsSync(join(base, 'hold', 'item'))).toBe(false); // l'élément choisi est supprimé
  expect(out.results).toEqual([{ name: 'item', ok: true }]);
});

test('N1 q2 : élément en quarantaine remplacé juste avant rm : jamais « supprimé » si l’élément choisi survit', async () => {
  const { base, root } = setup();
  mkdirSync(join(root, 'item'));
  writeFileSync(join(root, 'item', 'x'), 'x');
  mkdirSync(join(base, 'victim'));
  writeFileSync(join(base, 'victim', 'p'), 'precieux');
  const rmPath = attackingRm(base, `q=$(ls -d "${root}"/.proc-watch-trash-* | head -n 1)\nmv "$q/item" "${base}/hold-item" && mv "${base}/victim" "$q/item"`);
  const c = cleaner(root, { rmPath });
  await c.list();
  const out = await c.delete([item(root, 'item')]);
  expect(existsSync(join(base, 'hold-item', 'x'))).toBe(true); // l'élément choisi a survécu…
  expect(out.results[0].ok).toBe(false); // …donc jamais annoncé supprimé
  expect(out.results[0].reason).toMatch(/^non supprimé : remplacé dans la quarantaine/);
  expect(out.partial).toBe(true);
});

test('n2 : un autre élément a pris sa place pendant le déplacement : mis à l’écart, non supprimé, message clair', async () => {
  const { base, root } = setup();
  mkdirSync(join(root, 'item'));
  const c = cleaner(root, {
    // l'échange a lieu pendant la confirmation : la revérification le voit (« a changé ») ; on simule donc un échange
    // après la revérification par un faux fs.rename qui déplace un autre objet
    fs: {
      ...(await import('node:fs/promises')),
      rename: async (from: string, to: string) => {
        const fsp = await import('node:fs/promises');
        await fsp.rename(from, join(base, 'vrai-item'));
        await fsp.mkdir(join(base, 'intrus'));
        await fsp.rename(join(base, 'intrus'), to);
      },
    } as never,
  });
  await c.list();
  const out = await c.delete([item(root, 'item')]);
  expect(out.results[0].ok).toBe(false);
  expect(out.results[0].reason).toMatch(/^un autre élément a pris sa place ; il a été mis à l’écart dans .*\.proc-watch-trash-[^ ]+ \(non supprimé\)$/);
});

test('n3 : seule une détection réussie de GNU rm est gardée', async () => {
  const { base, root } = setup();
  writeFileSync(join(root, 'f'), 'x');
  const flag = join(base, 'deuxieme');
  const flaky = join(base, 'rm-instable');
  writeFileSync(flaky, `#!/bin/sh\nif [ ! -e "${flag}" ]; then touch "${flag}"; exit 1; fi\nexec /usr/bin/rm "$@"\n`, { mode: 0o755 });
  const c = cleaner(root, { rmPath: flaky });
  expect((await c.list()).disabled).toMatch(/pas GNU rm/);
  expect((await c.list()).disabled).toBeNull();
});

test('n1 : quarantaines restées signalées quelle que soit leur taille, « Vider la quarantaine » (confirmée) les supprime', async () => {
  const { base, root, outside } = setup();
  const q = join(root, '.proc-watch-trash-AbC123');
  mkdirSync(q, { mode: 0o700 });
  mkdirSync(join(q, 'reste', 'sous'), { recursive: true });
  writeFileSync(join(q, 'reste', 'sous', 'f'), 'x');
  symlinkSync(outside, join(q, 'reste', 'vers-dehors'));
  writeFileSync(join(q, 'fichier'), 'x');
  const other = join(root, '.proc-watch-trash-Ouvert');
  mkdirSync(other, { mode: 0o755 }); // pas 0700 : non éligible
  const c = cleaner(root);
  const l = await c.list();
  expect(l.quarantines).toEqual([
    { name: '.proc-watch-trash-AbC123', eligible: true },
    { name: '.proc-watch-trash-Ouvert', eligible: false },
  ]);
  const refused = cleaner(root, { confirm: async () => false });
  expect((await refused.emptyQuarantine()).cancelled).toBe(true);
  expect(existsSync(join(q, 'fichier'))).toBe(true);
  const out = await c.emptyQuarantine();
  expect(c.asked.at(-1)).toMatchObject({ purpose: 'quarantine', items: [{ name: '.proc-watch-trash-AbC123', kind: 'dir' }] });
  expect(out.results).toEqual([{ name: '.proc-watch-trash-AbC123', ok: true }]);
  expect(existsSync(q)).toBe(false);
  expect(existsSync(other)).toBe(true);
  outsideIntact(outside);
  void base;
});

test('texte de la confirmation « Vider la quarantaine »', () => {
  const t = confirmText({ purpose: 'quarantine', root: '/tmp', items: [{ name: '.proc-watch-trash-a', kind: 'dir', sizeKB: 0, recent: false }], totalKB: 0, uninspectable: [] }, String);
  expect(t.message).toBe('Vider la quarantaine de proc-watch ?');
  expect(t.detail).toContain('/tmp/.proc-watch-trash-a/');
  expect(t.detail).toContain('la corbeille ne libérerait pas la RAM');
});

/** Quarantaine restée (0700) avec des entrées données. */
function leftover(root: string, name = '.proc-watch-trash-Reste1', entries: Record<string, number> = { a: 1, b: 1 }) {
  const q = join(root, name);
  mkdirSync(q, { mode: 0o700 });
  for (const [n, kb] of Object.entries(entries)) writeFileSync(join(q, n), Buffer.alloc(kb * 1024, 1));
  return q;
}

test('p1 : quarantaine sur un autre système de fichiers (dev ≠ racine) : refusée, rien supprimé', async () => {
  const { root } = setup();
  const q = leftover(root);
  const fsp = await import('node:fs/promises');
  const c = cleaner(root, {
    fs: {
      ...fsp,
      open: async (p: string, f: number) => {
        const h = await fsp.open(p, f);
        const stat = h.stat.bind(h);
        return Object.assign(h, { stat: async (o: { bigint: true }) => {
          const st = await stat(o);
          return p === q ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 1n }) : st;
        } });
      },
    } as never,
  });
  await c.list();
  const out = await c.emptyQuarantine();
  expect(out.results[0]).toMatchObject({ ok: false });
  expect(out.results[0].reason).toMatch(/autre système de fichiers/);
  expect(existsSync(join(q, 'a'))).toBe(true);
});

test('p1 : appel au système de fichiers bloqué pendant « Vider la quarantaine » : délai, verrou relâché', async () => {
  const { root } = setup();
  const q = leftover(root);
  const fsp = await import('node:fs/promises');
  let block = true;
  const c = cleaner(root, {
    fsTimeoutMs: 200,
    fs: { ...fsp, readdir: (p: string) => (block && p.startsWith('/proc/self/fd/') ? new Promise<string[]>(() => {}) : fsp.readdir(p)) } as never,
  });
  await c.list();
  const t0 = Date.now();
  const out = await c.emptyQuarantine();
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(out.results[0].reason).toMatch(/délai dépassé/);
  block = false;
  const again = await c.emptyQuarantine(); // pas « déjà en cours »
  expect(again.results).toEqual([{ name: '.proc-watch-trash-Reste1', ok: true }]);
  expect(existsSync(q)).toBe(false);
});

test('p4 : « Vider la quarantaine » : budget de temps global et plafond d’entrées', async () => {
  const { root } = setup();
  const q = leftover(root, '.proc-watch-trash-Reste1', { a: 1, b: 1, c: 1 });
  const capped = cleaner(root, { quarantineMaxEntries: 2 });
  await capped.list();
  const out = await capped.emptyQuarantine();
  expect(out.partial).toBe(true);
  expect(out.results[0].reason).toMatch(/1 entrée non traitée \(plafond de 2\)/);
  expect(readdirSync(q)).toHaveLength(1);
  let t = 0;
  const q2 = leftover(root, '.proc-watch-trash-Reste2', { x: 1, y: 1 });
  const slow = cleaner(root, { quarantineBudgetMs: 1000, now: () => (t += 600) });
  await slow.list();
  const out2 = await slow.emptyQuarantine();
  expect(out2.results.find((r) => r.name === '.proc-watch-trash-Reste2')?.reason ?? out2.results[0].reason).toMatch(/temps écoulé/);
  expect(existsSync(q2) || existsSync(q)).toBe(true);
});

test('p2 : confirmation « Vider » : entrées de chaque quarantaine avec tailles, objets mis à l’écart après un échange signalés', async () => {
  const { base, root } = setup();
  mkdirSync(join(root, 'item'));
  const fsp = await import('node:fs/promises');
  // échange pendant le déplacement : un autre objet est mis à l'écart dans la quarantaine (n2)
  const swapping = cleaner(root, {
    fs: {
      ...fsp,
      rename: async (from: string, to: string) => {
        await fsp.rename(from, join(base, 'vrai-item'));
        await fsp.mkdir(join(base, 'intrus'));
        await fsp.writeFile(join(base, 'intrus', 'f'), Buffer.alloc(8192, 1));
        await fsp.rename(join(base, 'intrus'), to);
      },
    } as never,
  });
  await swapping.list();
  expect((await swapping.delete([item(root, 'item')])).results[0].reason).toMatch(/^un autre élément a pris sa place/);
  const qname = readdirSync(root).find((n) => n.startsWith('.proc-watch-trash-'))!;
  writeFileSync(join(root, qname, 'reste'), Buffer.alloc(4096, 1));
  const c = cleaner(root);
  await c.list();
  await c.emptyQuarantine();
  const s = c.asked.at(-1)!;
  expect(s.purpose).toBe('quarantine');
  expect(s.quarantines).toHaveLength(1);
  const entries = Object.fromEntries(s.quarantines![0].entries.map((e) => [e.name, e]));
  expect(entries.item).toMatchObject({ kind: 'dir', setAside: true });
  expect(entries.item.sizeKB).toBeGreaterThanOrEqual(8);
  expect(entries.reste).toMatchObject({ kind: 'file', setAside: false });
  expect(entries.reste.sizeKB).toBeGreaterThanOrEqual(4);
  expect(Object.keys(entries)).not.toContain('.proc-watch-mis-a-l-ecart');
  const t = confirmText(s, (kb) => `${kb} Ko`);
  expect(t.detail).toMatch(/item\/ — \d+ Ko — ⚠ mis à l’écart après un échange \(jamais choisi\)/);
  expect(t.detail).toMatch(/reste — \d+ Ko/);
});
