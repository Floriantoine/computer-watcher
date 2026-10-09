import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, realpathSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { mountPointsOf, copyFileSafe, moveDirSafe, placeUnder, readFileSafe, removeDirIfEmptySafe, removeFileSafe, removeLinkSafe, removeTreeSafe, writeFileSafe } from './safeFs';

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

describe('suppression d’une arborescence (profil Chromium de l’app)', () => {
  test('fichiers, sous-dossiers et liens symboliques retirés sans jamais suivre un lien', () => {
    const t = join(root, 'cfg/GPUCache');
    mkdirSync(join(t, 'a/b'), { recursive: true });
    writeFileSync(join(t, 'a/b/f'), 'x');
    writeFileSync(join(t, 'g'), 'y');
    symlinkSync(victimDir, join(t, 'lien-dossier'));
    symlinkSync(join(victimDir, 'proc-watch.desktop'), join(t, 'lien-fichier'));
    expect(removeTreeSafe([root], t)).toBe('removed');
    expect(existsSync(t)).toBe(false);
    expect(readFileSync(join(victimDir, 'proc-watch.desktop'), 'utf8')).toBe('FOREIGN');
  });
  test('racine de l’arborescence en lien : refusé ; fichier simple : retiré ; absent : « absent »', () => {
    mkdirSync(join(root, 'cfg'), { recursive: true });
    symlinkSync(victimDir, join(root, 'cfg/Cache'));
    expect(() => removeTreeSafe([root], join(root, 'cfg/Cache'))).toThrow(/lien symbolique/);
    expect(existsSync(join(victimDir, 'proc-watch.desktop'))).toBe(true);
    writeFileSync(join(root, 'cfg/Preferences'), '{}');
    expect(removeTreeSafe([root], join(root, 'cfg/Preferences'))).toBe('removed');
    expect(removeTreeSafe([root], join(root, 'cfg/none'))).toBe('absent');
  });
});

describe('I-B : jamais à travers un point de montage', () => {
  test('mountinfo : points de montage, espaces décodés', () => {
    expect(mountPointsOf('1 2 0:5 / /a\\040b rw - ext4 x rw\n3 4 0:6 / /c rw - tmpfs t rw\n')).toEqual(['/a b', '/c']);
  });
  test('montage annoncé sous l’arbre (montage lié, même dev) : sous-arbre laissé, signalé, le reste retiré', () => {
    const t = join(root, 'cfg/Cache');
    mkdirSync(join(t, 'mnt'), { recursive: true });
    writeFileSync(join(t, 'mnt/precious'), 'x');
    writeFileSync(join(t, 'f'), 'y');
    const real = realpathSync(t);
    const mi = `1 2 0:5 / ${real}/mnt rw - ext4 x rw\n`;
    expect(() => removeTreeSafe([root], t, { mountinfo: mi })).toThrow(/point de montage/);
    expect(existsSync(join(t, 'mnt/precious'))).toBe(true);
    expect(existsSync(join(t, 'f'))).toBe(false);
  });
  test('l’arbre lui-même est un point de montage : refusé, rien retiré', () => {
    const t = join(root, 'cfg/GPUCache');
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, 'f'), 'y');
    expect(() => removeTreeSafe([root], t, { mountinfo: `1 2 0:5 / ${realpathSync(t)} rw - tmpfs t rw\n` })).toThrow(/point de montage/);
    expect(existsSync(join(t, 'f'))).toBe(true);
  });
  const unshareOk = (() => {
    try {
      execFileSync('unshare', ['-rm', 'true'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  test.skipIf(!unshareOk)('reproduction [mount] (unshare -rm) : montage lié d’une victime et tmpfs sous l’arbre → victime intacte, signalé', () => {
    const t = join(root, 'cfg/Cache');
    const victim = join(root, 'victime');
    mkdirSync(join(t, 'mnt'), { recursive: true });
    mkdirSync(join(t, 'tmp'), { recursive: true });
    mkdirSync(victim, { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(join(victim, `f${i}`), 'x');
    writeFileSync(join(t, 'ordinaire'), 'y');
    const runner = join(root, 'runner.mjs');
    writeFileSync(runner, `import { removeTreeSafe } from ${JSON.stringify(join(__dirname, 'safeFs.ts'))};
try { removeTreeSafe([${JSON.stringify(root)}], ${JSON.stringify(t)}); console.log('ok'); } catch (e) { console.log('ERR ' + e.message); }`);
    const script = 'mount --bind "$1" "$2/mnt" && mount -t tmpfs none "$2/tmp" && echo z > "$2/tmp/z" && exec node --no-warnings "$3"';
    const out = execFileSync('unshare', ['-rm', 'sh', '-c', script, 'sh', victim, t, runner], { encoding: 'utf8' });
    expect(out).toMatch(/ERR .*point de montage/);
    expect(readdirSync(victim).sort()).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
    expect(existsSync(join(t, 'ordinaire'))).toBe(false);
  });
});

describe('renommage : déplacement d’un dossier de l’app (proc-watch → computer-watcher)', () => {
  const noMounts = '';
  const fill = (d: string) => {
    mkdirSync(join(d, 'sous'), { recursive: true });
    writeFileSync(join(d, 'metrics.db'), 'historique');
    writeFileSync(join(d, 'sous', 'f'), 'x');
  };
  test('nouveau absent : rename dans le même parent, contenu identique, ancien absent', () => {
    const from = join(root, '.config/proc-watch');
    const to = join(root, '.config/computer-watcher');
    fill(from);
    const ino = statSync(from).ino;
    expect(moveDirSafe([root], from, to, { mountinfo: noMounts })).toBe('moved');
    expect(existsSync(from)).toBe(false);
    expect(statSync(to).ino).toBe(ino); // rename(2), pas une copie
    expect(readFileSync(join(to, 'metrics.db'), 'utf8')).toBe('historique');
  });
  test('ancien absent : rien', () => {
    expect(moveDirSafe([root], join(root, '.config/proc-watch'), join(root, '.config/computer-watcher'), { mountinfo: noMounts })).toBe('absent');
  });
  test('nouveau vide : remplacé atomiquement ; nouveau non vide : refusé, rien touché', () => {
    const from = join(root, 'c/proc-watch');
    const to = join(root, 'c/computer-watcher');
    fill(from);
    mkdirSync(to);
    expect(moveDirSafe([root], from, to, { mountinfo: noMounts })).toBe('moved');
    expect(readFileSync(join(to, 'metrics.db'), 'utf8')).toBe('historique');
    fill(from);
    expect(() => moveDirSafe([root], from, to, { mountinfo: noMounts })).toThrow(/non vide/);
    expect(existsSync(join(from, 'metrics.db'))).toBe(true);
  });
  test('ancien en lien symbolique : refusé, la cible du lien intacte', () => {
    const from = join(root, 'c/proc-watch');
    mkdirSync(join(root, 'c'), { recursive: true });
    symlinkSync(victimDir, from);
    expect(() => moveDirSafe([root], from, join(root, 'c/computer-watcher'), { mountinfo: noMounts })).toThrow(/lien symbolique/);
    expect(lstatSync(from).isSymbolicLink()).toBe(true);
    expect(readdirSync(victimDir)).toEqual(['proc-watch.desktop']);
  });
  test('nouveau en lien symbolique : refusé, rien déplacé vers la cible', () => {
    const from = join(root, 'c/proc-watch');
    fill(from);
    symlinkSync(victimDir, join(root, 'c/computer-watcher'));
    expect(() => moveDirSafe([root], from, join(root, 'c/computer-watcher'), { mountinfo: noMounts })).toThrow(/lien symbolique/);
    expect(readdirSync(victimDir)).toEqual(['proc-watch.desktop']);
    expect(existsSync(join(from, 'metrics.db'))).toBe(true);
  });
  test('parent remplacé par un lien : refusé', () => {
    mkdirSync(join(victimDir, 'proc-watch'));
    symlinkSync(victimDir, join(root, 'c'));
    expect(() => moveDirSafe([root], join(root, 'c/proc-watch'), join(root, 'c/computer-watcher'), { mountinfo: noMounts })).toThrow(/lien symbolique/);
    expect(existsSync(join(victimDir, 'proc-watch'))).toBe(true);
  });
  test('point de montage (l’ancien lui-même, ou un montage dessous) : refusé, rien déplacé', () => {
    const from = join(root, 'c/proc-watch');
    fill(from);
    const real = realpathSync(from);
    expect(() => moveDirSafe([root], from, join(root, 'c/computer-watcher'), { mountinfo: `1 2 0:5 / ${real} rw - tmpfs t rw\n` })).toThrow(/point de montage/);
    expect(() => moveDirSafe([root], from, join(root, 'c/computer-watcher'), { mountinfo: `1 2 0:5 / ${real}/sous rw - tmpfs t rw\n` })).toThrow(/point de montage/);
    expect(existsSync(join(from, 'metrics.db'))).toBe(true);
    expect(existsSync(join(root, 'c/computer-watcher'))).toBe(false);
  });
  test('pas dans le même dossier parent : refusé', () => {
    const from = join(root, 'a/proc-watch');
    fill(from);
    expect(() => moveDirSafe([root], from, join(root, 'b/computer-watcher'), { mountinfo: noMounts })).toThrow(/même dossier/);
  });
  test('l’ancien est un fichier : refusé', () => {
    mkdirSync(join(root, 'c'));
    writeFileSync(join(root, 'c/proc-watch'), 'x');
    expect(() => moveDirSafe([root], join(root, 'c/proc-watch'), join(root, 'c/computer-watcher'), { mountinfo: noMounts })).toThrow(/pas un dossier/);
  });
});

describe('renommage : retrait d’un lien symbolique (default.target.wants de l’ancienne unité)', () => {
  test('le lien seul est retiré, jamais sa cible ; un fichier ordinaire est refusé', () => {
    const d = join(root, '.config/systemd/user/default.target.wants');
    mkdirSync(d, { recursive: true });
    symlinkSync(join(victimDir, 'proc-watch.desktop'), join(d, 'l'));
    expect(removeLinkSafe([root], join(d, 'l'))).toBe('removed');
    expect(readFileSync(join(victimDir, 'proc-watch.desktop'), 'utf8')).toBe('FOREIGN');
    expect(removeLinkSafe([root], join(d, 'l'))).toBe('absent');
    writeFileSync(join(d, 'f'), 'x');
    expect(() => removeLinkSafe([root], join(d, 'f'))).toThrow(/pas un lien/);
    expect(existsSync(join(d, 'f'))).toBe(true);
  });
});
