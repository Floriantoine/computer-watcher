import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { desktopEntryContent, installDesktopEntry } from './desktopEntry';

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
