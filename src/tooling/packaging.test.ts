// Empaquetage : nom technique, identifiant et paquet .deb du renommage (proc-watch → computer-watcher).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const root = join(__dirname, '..', '..');
const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string };

test('package.json : nom technique computer-watcher (cache de l’updater computer-watcher-updater)', () => {
  expect(pkg.name).toBe('computer-watcher');
});

test('electron-builder.yml : identifiant, nom de produit et exécutable au nouveau nom', () => {
  expect(yml).toMatch(/^appId: io\.github\.floriantoine\.computerwatcher$/m);
  expect(yml).toMatch(/^productName: computer-watcher$/m);
  expect(yml).toMatch(/^ {2}executableName: computer-watcher$/m);
  expect(yml).toMatch(/^artifactName: \$\{productName\}-\$\{version\}-\$\{arch\}\.\$\{ext\}$/m);
  expect(yml).not.toMatch(/^ *(appId|productName|executableName):.*proc/m);
});

test('electron-builder.yml : entrée de menu « Computer Watcher », classe de fenêtre computer-watcher', () => {
  expect(yml).toMatch(/^ {2}desktop:\n {4}entry:\n(?: {6}.+\n)*? {6}Name: Computer Watcher$/m);
  expect(yml).toMatch(/^ {6}StartupWMClass: computer-watcher$/m);
});

test('.deb : remplace l’ancien paquet proc-watch au lieu de s’installer à côté', () => {
  for (const o of ['--replaces=proc-watch', '--conflicts=proc-watch', '--provides=proc-watch']) expect(yml).toContain(`    - ${o}\n`);
  expect(yml).toMatch(/^deb:\n(?: {2}#.*\n)* {2}fpm:\n/m);
});
