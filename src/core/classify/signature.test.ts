import { describe, expect, test } from 'vitest';
import { signatureOf } from './signature';
import { matchCommand } from './rules';

const sig = (cmdline: string, root?: string) => {
  const chain = [{ name: 'node', cmdline }];
  return signatureOf(chain, matchCommand(chain), root);
};

describe('signatureOf', () => {
  test('match : libellé', () => expect(sig('node /p/node_modules/.bin/vite --port 5173')).toBe('vite'));
  test('port ignoré', () => expect(sig('node /p/node_modules/.bin/vite --port 5173')).toBe(sig('node /p/node_modules/.bin/vite --port 5174')));
  test('chemin relatif au projet', () => {
    expect(sig('node /home/u/acme/dist/main.js', '/home/u/acme')).toBe(sig('node dist/main.js', '/home/u/acme'));
    expect(sig('node /home/u/acme/scripts/run.js', '/home/u/acme')).toBe('node scripts/run.js');
  });
  test('sans match', () => {
    expect(sig('node /home/u/script.js')).toBe('node script.js');
    expect(sig('mytool serve --port 3000')).toBe('mytool serve');
    expect(sig('mytool --port 3000')).toBe('mytool');
    expect(sig('python -m foo.bar:app')).toBe('python foo.bar:app');
    expect(sig('mytool --config foo.js serve')).toBe('mytool serve');
    expect(sig('mytool --verbose serve')).toBe('mytool serve');
    expect(sig('node --require x.cjs app.js')).toBe('node app.js');
  });
  test('chaîne vide', () => expect(signatureOf([], null)).toBe(''));
});
