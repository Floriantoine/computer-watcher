import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { desktopEntryContent, installDesktopEntry, refreshDesktopEntry } from './desktopEntry';

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
