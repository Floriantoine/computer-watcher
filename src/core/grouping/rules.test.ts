import { expect, test } from 'vitest';
import { isDevTool } from './rules';

test('isDevTool : au comm, ou au programme lancé (jamais au seul comm « MainThread »)', () => {
  expect(isDevTool('node', 'node server.js')).toBe(true);
  expect(isDevTool('npm run typech', 'npm run typecheck')).toBe(true);
  expect(isDevTool('MainThread', 'node /p/node_modules/jest/bin/jest.js')).toBe(true);
  expect(isDevTool('MainThread', '/usr/bin/node /p/node_modules/typescript/bin/tsc --noEmit')).toBe(true);
  expect(isDevTool('MainThread', '/usr/lib/jvm/bin/java -jar x.jar')).toBe(true);
  expect(isDevTool('MainThread', '/opt/app/bin/app --flag')).toBe(false);
  expect(isDevTool('MainThread', '[MainThread]')).toBe(false);
  expect(isDevTool('nodemon', 'nodemonx')).toBe(false);
});

test('isDevTool : la ligne de commande n’est lue que pour le comm « MainThread » (Node ≥ 24), jamais pour un script à shebang', () => {
  // programme Python lancé par son shebang : comm = nom du script, ligne de commande = interpréteur + script
  expect(isDevTool('meld', '/usr/bin/python3 /usr/bin/meld')).toBe(false);
  expect(isDevTool('meld', '/usr/bin/python3 /usr/bin/meld .')).toBe(false);
  expect(isDevTool('idle3', '/usr/bin/python3 /usr/bin/idle3')).toBe(false);
  expect(isDevTool('demo', '/usr/bin/node /home/u/bin/demo')).toBe(false);
  expect(isDevTool('MainThread', 'node /home/u/demo/x.js')).toBe(true);
  expect(isDevTool('MainThread', '/usr/bin/python3 /home/u/demo/x.py')).toBe(true);
});
