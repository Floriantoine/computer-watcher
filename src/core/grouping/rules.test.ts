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
