import { mkdtempSync, readFileSync } from 'node:fs';
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
