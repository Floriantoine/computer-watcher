import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

test('échappe \\ " ` $ et % dans Exec', () => {
  const c = desktopEntryContent('/a/b"c$d%e`f\\g');
  expect(c).toContain('Exec="/a/b\\"c\\$d%%e\\`f\\\\g"');
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
