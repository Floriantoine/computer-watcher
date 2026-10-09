import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { desktopEntryContent, execPathFromEntry, installDesktopEntry, refreshDesktopEntry } from './desktopEntry';

test('contenu .desktop', () => {
  const c = desktopEntryContent('/home/u/Apps/proc-watch.AppImage');
  expect(c).toContain('Exec="/home/u/Apps/proc-watch.AppImage"');
  expect(c).toContain('Name=proc-watch');
  expect(c.startsWith('[Desktop Entry]\n')).toBe(true);
});

test('écrit dans XDG_DATA_HOME/applications, sinon ~/.local/share/applications', () => {
  const home = mkdtempSync(join(tmpdir(), 'procwatch-home-'));
  const file = installDesktopEntry('/x/app', {}, home);
  expect(file).toBe(join(home, '.local/share/applications/proc-watch.desktop'));
  expect(readFileSync(file, 'utf8')).toContain('Exec="/x/app"');

  const data = mkdtempSync(join(tmpdir(), 'procwatch-data-'));
  expect(installDesktopEntry('/x/app', { XDG_DATA_HOME: data }, home)).toBe(join(data, 'applications/proc-watch.desktop'));
});

test('échappe selon la spécification Desktop Entry (guillemets, puis chaîne) : \\ " ` $ et %', () => {
  // `"` → \\" ; `$` → \\$ ; `` ` `` → \\` ; `\\` → \\\\ (quatre) ; `%` → %%
  const c = desktopEntryContent('/a/b"c$d%e`f\\g');
  expect(c).toContain('Exec="/a/b\\\\"c\\\\$d%%e\\\\`f\\\\\\\\g"\n');
});

test('espaces : un seul argument entre guillemets ; saut de ligne échappé en \\n (jamais une nouvelle clé)', () => {
  expect(desktopEntryContent('/home/u/Mes Apps/p.AppImage')).toContain('Exec="/home/u/Mes Apps/p.AppImage"\n');
  const c = desktopEntryContent('/a\nType=Link');
  expect(c).toContain('Exec="/a\\nType=Link"\n');
  expect(c.split('\n').filter((l) => l.startsWith('Type='))).toEqual(['Type=Application']);
});

test('caractère de contrôle : refusé', () => {
  expect(() => desktopEntryContent('/a\u0001b')).toThrow();
});

test('arguments après le chemin (--hidden sans guillemets) et entrée de démarrage automatique', () => {
  const c = desktopEntryContent('/home/u/Applications/proc-watch.AppImage', { args: ['--hidden'], autostart: true });
  expect(c).toContain('Exec="/home/u/Applications/proc-watch.AppImage" --hidden\n');
  expect(c).toContain('X-GNOME-Autostart-enabled=true\n');
  expect(c).not.toContain('Categories=');
  expect(desktopEntryContent('/x')).not.toContain('Autostart');
});

test('marque X-ProcWatch-Managed=1 dans chaque entrée (menu et démarrage automatique)', () => {
  expect(desktopEntryContent('/x')).toContain('\nX-ProcWatch-Managed=1\n');
  expect(desktopEntryContent('/x', { args: ['--hidden'], autostart: true })).toContain('\nX-ProcWatch-Managed=1\n');
});

test('raccourci marqué X-ProcWatch-Managed=1', () => {
  expect(desktopEntryContent('/x/app')).toContain('\nX-ProcWatch-Managed=1\n');
});

test('chemin avec caractère de contrôle : refusé (aucune clé injectée)', () => {
  const data = mkdtempSync(join(tmpdir(), 'procwatch-ctl-'));
  expect(() => installDesktopEntry('/home/u/a\nIcon=x.AppImage', { XDG_DATA_HOME: data })).toThrow();
  expect(existsSync(join(data, 'applications/proc-watch.desktop'))).toBe(false);
  expect(refreshDesktopEntry('/home/u/a\rb.AppImage', { XDG_DATA_HOME: data })).toBe('refused');
});

/** Dossier d'AppImage : ancienne (supprimée par electron-updater) et nouvelle, dans le même dossier. */
function apps() {
  const data = mkdtempSync(join(tmpdir(), 'procwatch-refresh-'));
  const dir = mkdtempSync(join(tmpdir(), 'procwatch-apps-'));
  const oldImg = join(dir, 'proc-watch-0.1.0-x86_64.AppImage');
  const newImg = join(dir, 'proc-watch-0.1.1-x86_64.AppImage');
  writeFileSync(newImg, 'x');
  return { env: { XDG_DATA_HOME: data }, dir, oldImg, newImg };
}

test('refreshDesktopEntry : ancienne AppImage supprimée, nouvelle dans le même dossier → repointé', () => {
  const a = apps();
  expect(refreshDesktopEntry(a.newImg, a.env)).toBe('absent');
  const file = installDesktopEntry(a.oldImg, a.env); // l'ancienne n'existe plus (supprimée)
  expect(refreshDesktopEntry(a.newImg, a.env)).toBe('updated');
  expect(readFileSync(file, 'utf8')).toBe(desktopEntryContent(a.newImg));
  expect(refreshDesktopEntry(a.newImg, a.env)).toBe('unchanged');
});

test('refreshDesktopEntry : gabarit ancien mais marqué → mis à jour', () => {
  const a = apps();
  const file = installDesktopEntry(a.oldImg, a.env);
  writeFileSync(file, `[Desktop Entry]\nType=Application\nName=proc-watch\nExec="${a.oldImg}"\nIcon=utilities-system-monitor\nX-ProcWatch-Managed=1\n`);
  expect(refreshDesktopEntry(a.newImg, a.env)).toBe('updated');
  expect(readFileSync(file, 'utf8')).toBe(desktopEntryContent(a.newImg));
});

test('refreshDesktopEntry : ancienne cible toujours présente (autre copie lancée) → jamais repointé', () => {
  const a = apps();
  writeFileSync(a.oldImg, 'x');
  installDesktopEntry(a.oldImg, a.env);
  expect(refreshDesktopEntry(a.newImg, a.env)).toBe('kept');
});

test('refreshDesktopEntry : nouvelle AppImage dans un autre dossier (téléchargement lancé une fois) → jamais repointé', () => {
  const a = apps();
  const file = installDesktopEntry(join(a.dir, 'proc-watch.AppImage'), a.env);
  const elsewhere = join(mkdtempSync(join(tmpdir(), 'procwatch-dl-')), 'proc-watch-0.1.0-x86_64.AppImage');
  writeFileSync(elsewhere, 'x');
  expect(refreshDesktopEntry(elsewhere, a.env)).toBe('kept');
  expect(readFileSync(file, 'utf8')).toContain(join(a.dir, 'proc-watch.AppImage'));
});

test('refreshDesktopEntry : raccourci non marqué (écrit à la main, ancienne version) → jamais réécrit', () => {
  const a = apps();
  const file = installDesktopEntry(a.oldImg, a.env);
  writeFileSync(file, `[Desktop Entry]\nName=Mon proc-watch\nExec="${a.oldImg}" --free\n`);
  expect(refreshDesktopEntry(a.newImg, a.env)).toBe('foreign');
  expect(readFileSync(file, 'utf8')).toContain('--free');
});

test('icône de l\'app : Icon=proc-watch, PNG copiée dans le thème hicolor', () => {
  expect(desktopEntryContent('/x/app')).toContain('Icon=proc-watch\n');
  const home = mkdtempSync(join(tmpdir(), 'procwatch-home-'));
  const src = mkdtempSync(join(tmpdir(), 'procwatch-icons-'));
  writeFileSync(join(src, 'icon.png'), 'png');
  installDesktopEntry('/x/app', {}, home, join(src, 'icon.png'));
  expect(existsSync(join(home, '.local/share/icons/hicolor/512x512/apps/proc-watch.png'))).toBe(true);
});

test('icône absente : l\'entrée est quand même écrite', () => {
  const home = mkdtempSync(join(tmpdir(), 'procwatch-home-'));
  const file = installDesktopEntry('/x/app', {}, home, '/nope/icon.png');
  expect(readFileSync(file, 'utf8')).toContain('Exec="/x/app"');
});

test('lien symbolique posé à la place de l’entrée ou de l’icône : remplacé, sa cible jamais écrite', () => {
  const home = mkdtempSync(join(tmpdir(), 'procwatch-home-'));
  const victim = join(home, 'victim.txt');
  writeFileSync(victim, 'précieux');
  const apps = join(home, '.local/share/applications');
  const icons = join(home, '.local/share/icons/hicolor/512x512/apps');
  mkdirSync(apps, { recursive: true });
  mkdirSync(icons, { recursive: true });
  symlinkSync(victim, join(apps, 'proc-watch.desktop'));
  symlinkSync(victim, join(icons, 'proc-watch.png'));
  const src = join(home, 'icon.png');
  writeFileSync(src, 'png');
  installDesktopEntry('/x/app', {}, home, src);
  expect(readFileSync(victim, 'utf8')).toBe('précieux');
  expect(lstatSync(join(apps, 'proc-watch.desktop')).isSymbolicLink()).toBe(false);
  expect(readFileSync(join(apps, 'proc-watch.desktop'), 'utf8')).toContain('Exec="/x/app"');
  expect(readFileSync(join(icons, 'proc-watch.png'), 'utf8')).toBe('png');
});

test('idempotent : deux installations, même contenu, aucun fichier temporaire laissé', () => {
  const home = mkdtempSync(join(tmpdir(), 'procwatch-home-'));
  const a = installDesktopEntry('/x/app', {}, home);
  const first = readFileSync(a, 'utf8');
  installDesktopEntry('/x/app', {}, home);
  expect(readFileSync(a, 'utf8')).toBe(first);
  expect(readdirSync(join(home, '.local/share/applications'))).toEqual(['proc-watch.desktop']);
});

test('reproduction I1 [2] : entrée de menu existante sans X-ProcWatch-Managed=1 → jamais écrasée, erreur', () => {
  const home = mkdtempSync(join(tmpdir(), 'procwatch-home-'));
  const apps = join(home, '.local/share/applications');
  mkdirSync(apps, { recursive: true });
  writeFileSync(join(apps, 'proc-watch.desktop'), '[Desktop Entry]\nName=mine-menu\nExec=/usr/bin/my-own\n');
  expect(() => installDesktopEntry('/x/app', {}, home)).toThrow(/pas été créé par proc-watch/);
  expect(readFileSync(join(apps, 'proc-watch.desktop'), 'utf8')).toContain('my-own');
});

test('dossier applications remplacé par un lien : refusé, fichier du dossier visé intact', () => {
  const home = mkdtempSync(join(tmpdir(), 'procwatch-home-'));
  const victim = mkdtempSync(join(tmpdir(), 'procwatch-victim-'));
  writeFileSync(join(victim, 'proc-watch.desktop'), 'FOREIGN');
  mkdirSync(join(home, '.local/share'), { recursive: true });
  symlinkSync(victim, join(home, '.local/share/applications'));
  expect(() => installDesktopEntry('/x/app', {}, home)).toThrow(/lien symbolique/);
  expect(readFileSync(join(victim, 'proc-watch.desktop'), 'utf8')).toBe('FOREIGN');
});

test('execPathFromEntry : inverse exact de l’échappement (\\ " ` $ % espaces)', () => {
  for (const p of ['/home/u/Applications/proc-watch.AppImage', '/a/b"c$d%e`f\\g', '/home/u/Mes Apps/x\\ny.AppImage']) {
    expect(execPathFromEntry(desktopEntryContent(p))).toBe(p);
  }
  expect(execPathFromEntry('[Desktop Entry]\nExec=/x --y\n')).toBeNull();
});
