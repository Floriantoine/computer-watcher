import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { copyFileSafe, placeUnder, readFileSafe, removeDirIfEmptySafe, removeFileSafe, writeFileSafe } from './safeFs';

const cache = join(homedir(), '.cache');
mkdirSync(cache, { recursive: true });
const base = mkdtempSync(join(cache, 'pw-onboard-test-fs-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
let root: string;
let victimDir: string;
beforeEach(() => {
  root = join(base, `r${++n}`, 'home');
  victimDir = join(base, `r${n}`, 'victim');
  mkdirSync(root, { recursive: true });
  mkdirSync(victimDir, { recursive: true });
  writeFileSync(join(victimDir, 'proc-watch.desktop'), 'FOREIGN');
});

describe('placeUnder', () => {
  test('racine la plus longue, dossiers et nom', () => {
    expect(placeUnder(['/h', '/h/.config'], '/h/.config/autostart/p.desktop')).toEqual({ root: '/h/.config', dirs: ['autostart'], name: 'p.desktop' });
    expect(placeUnder(['/h'], '/h/Applications/x')).toEqual({ root: '/h', dirs: ['Applications'], name: 'x' });
  });
  test('hors des racines, ou avec « .. » : refusé', () => {
    expect(() => placeUnder(['/h'], '/etc/passwd')).toThrow();
    expect(() => placeUnder(['/h'], '/h/a/../../etc/passwd')).toThrow();
    expect(() => placeUnder(['/h'], '/hx/a')).toThrow();
  });
});

describe('écriture par descripteur de dossier (O_DIRECTORY|O_NOFOLLOW)', () => {
  test('crée les dossiers manquants, écrit atomiquement avec le mode demandé, aucun temporaire laissé', () => {
    const p = join(root, '.config/autostart/proc-watch.desktop');
    writeFileSafe([root], p, 'abc', 0o600);
    expect(readFileSync(p, 'utf8')).toBe('abc');
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, '.config/autostart'))).toEqual(['proc-watch.desktop']);
  });

  test('reproduction I1 [3] : dossier parent remplacé par un lien → refusé, fichier du dossier visé intact', () => {
    mkdirSync(join(root, '.config'));
    symlinkSync(victimDir, join(root, '.config/autostart'));
    expect(() => writeFileSafe([root], join(root, '.config/autostart/proc-watch.desktop'), 'x')).toThrow(/lien symbolique/);
    expect(readFileSync(join(victimDir, 'proc-watch.desktop'), 'utf8')).toBe('FOREIGN');
  });

  test('dossier intermédiaire en lien (plus haut que le parent) : refusé aussi', () => {
    symlinkSync(victimDir, join(root, '.config'));
    mkdirSync(join(victimDir, 'autostart'));
    expect(() => writeFileSafe([root], join(root, '.config/autostart/proc-watch.desktop'), 'x')).toThrow(/lien symbolique/);
    expect(existsSync(join(victimDir, 'autostart/proc-watch.desktop'))).toBe(false);
  });

  test('racine elle-même en lien (ex. ~/.config géré par des dotfiles) : suivie', () => {
    const real = join(base, `r${n}`, 'dotfiles-config');
    mkdirSync(real);
    const cfg = join(root, '.config');
    symlinkSync(real, cfg);
    writeFileSafe([root, cfg], join(cfg, 'autostart/proc-watch.desktop'), 'ok');
    expect(readFileSync(join(real, 'autostart/proc-watch.desktop'), 'utf8')).toBe('ok');
  });

  test('lien posé à la destination : remplacé par rename, cible intacte', () => {
    mkdirSync(join(root, 'd'));
    symlinkSync(join(victimDir, 'proc-watch.desktop'), join(root, 'd/f'));
    writeFileSafe([root], join(root, 'd/f'), 'new');
    expect(lstatSync(join(root, 'd/f')).isFile()).toBe(true);
    expect(readFileSync(join(victimDir, 'proc-watch.desktop'), 'utf8')).toBe('FOREIGN');
  });

  test('garde : destination existante refusée par le garde → rien écrit', () => {
    mkdirSync(join(root, 'd'));
    writeFileSync(join(root, 'd/f'), 'à moi');
    expect(() => writeFileSafe([root], join(root, 'd/f'), 'new', 0o644, { guard: (cur) => (cur === 'à moi' ? 'pas à nous' : null) })).toThrow(/pas à nous/);
    expect(readFileSync(join(root, 'd/f'), 'utf8')).toBe('à moi');
  });

  test('m4 : temporaire planté au nom prévu → échec, le fichier planté n’est jamais supprimé', () => {
    mkdirSync(join(root, 'd'));
    writeFileSync(join(root, 'd/.f.tmp'), 'planté');
    expect(() => writeFileSafe([root], join(root, 'd/f'), 'new', 0o644, { tmpName: '.f.tmp' })).toThrow();
    expect(readFileSync(join(root, 'd/.f.tmp'), 'utf8')).toBe('planté');
    expect(existsSync(join(root, 'd/f'))).toBe(false);
  });
});

describe('copie (AppImage)', () => {
  test('copie atomique 0755, SHA-256 rendu, exécutable', async () => {
    const src = join(base, `r${n}`, 'src.AppImage');
    writeFileSync(src, 'BYTES');
    chmodSync(src, 0o644);
    const r = await copyFileSafe([root], src, join(root, 'Applications/proc-watch.AppImage'), 0o755);
    expect(r.sha256).toBe(createHash('sha256').update('BYTES').digest('hex'));
    expect(statSync(join(root, 'Applications/proc-watch.AppImage')).mode & 0o777).toBe(0o755);
    expect(readdirSync(join(root, 'Applications'))).toEqual(['proc-watch.AppImage']);
  });
  test('~/Applications en lien : refusé, rien écrit dans le dossier visé', async () => {
    const src = join(base, `r${n}`, 'src.AppImage');
    writeFileSync(src, 'BYTES');
    symlinkSync(victimDir, join(root, 'Applications'));
    await expect(copyFileSafe([root], src, join(root, 'Applications/proc-watch.AppImage'), 0o755)).rejects.toThrow(/lien symbolique/);
    expect(readdirSync(victimDir)).toEqual(['proc-watch.desktop']);
  });
});

describe('suppression par descripteur de dossier (m2)', () => {
  test('fichier ordinaire : supprimé ; absent : « absent »', () => {
    mkdirSync(join(root, 'd'));
    writeFileSync(join(root, 'd/f'), 'x');
    expect(removeFileSafe([root], join(root, 'd/f'))).toBe('removed');
    expect(removeFileSafe([root], join(root, 'd/f'))).toBe('absent');
    expect(removeFileSafe([root], join(root, 'nope/f'))).toBe('absent');
  });
  test('parent en lien (ex. ~/Applications → autre dossier) : refusé, fichier visé intact', () => {
    symlinkSync(victimDir, join(root, 'Applications'));
    expect(() => removeFileSafe([root], join(root, 'Applications/proc-watch.desktop'))).toThrow(/lien symbolique/);
    expect(existsSync(join(victimDir, 'proc-watch.desktop'))).toBe(true);
  });
  test('dernier élément en lien : refusé, jamais suivi', () => {
    mkdirSync(join(root, 'd'));
    symlinkSync(join(victimDir, 'proc-watch.desktop'), join(root, 'd/f'));
    expect(() => removeFileSafe([root], join(root, 'd/f'))).toThrow(/lien symbolique/);
    expect(existsSync(join(victimDir, 'proc-watch.desktop'))).toBe(true);
  });
  test('dossier : retiré vide seulement ; lien refusé', () => {
    mkdirSync(join(root, 'a/b'), { recursive: true });
    writeFileSync(join(root, 'a/b/x'), '');
    expect(removeDirIfEmptySafe([root], join(root, 'a/b'))).toBe('not-empty');
    rmSync(join(root, 'a/b/x'));
    expect(removeDirIfEmptySafe([root], join(root, 'a/b'))).toBe('removed');
    symlinkSync(victimDir, join(root, 'a/b'));
    expect(() => removeDirIfEmptySafe([root], join(root, 'a/b'))).toThrow(/lien symbolique/);
  });
  test('lecture sans suivre : lien → null, absent → null', () => {
    mkdirSync(join(root, 'd'));
    symlinkSync(join(victimDir, 'proc-watch.desktop'), join(root, 'd/f'));
    expect(readFileSafe([root], join(root, 'd/f'))).toBeNull();
    expect(readFileSafe([root], join(root, 'd/none'))).toBeNull();
    writeFileSync(join(root, 'd/g'), 'ok');
    expect(readFileSafe([root], join(root, 'd/g'))).toBe('ok');
  });
});
