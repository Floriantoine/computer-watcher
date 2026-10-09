// Renommage : l'interface ne nomme plus l'app « proc-watch ». Seules exceptions : le préfixe des anciennes quarantaines
// /tmp (.proc-watch-trash-*, toujours reconnues) et la mention de la migration depuis l'ancien nom.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const root = join(__dirname, '..');
const ALLOWED = /\.proc-watch-trash-|depuis proc-watch|(?:Ancien|ancien) nom/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(tsx?|html|css)$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
  });
}

test('aucun texte du renderer ne nomme l’app « proc-watch » (nom affiché : Computer Watcher)', () => {
  const hits = files(root).flatMap((f) =>
    readFileSync(f, 'utf8').split('\n').flatMap((l, i) => (/proc-watch/.test(l) && !ALLOWED.test(l) ? [`${f.slice(root.length + 1)}:${i + 1}: ${l.trim()}`] : [])),
  );
  expect(hits).toEqual([]);
});

test('titre de la fenêtre (index.html) : Computer Watcher', () => {
  expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain('<title>Computer Watcher</title>');
});
