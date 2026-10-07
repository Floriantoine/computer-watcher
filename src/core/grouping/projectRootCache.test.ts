import { expect, test, vi } from 'vitest';
import { createProjectRootCache } from './projectRootCache';

test('met en cache, y compris les null', () => {
  const find = vi.fn((cwd: string) => (cwd === '/a' ? '/a' : null));
  const get = createProjectRootCache(find);
  expect(get('/a')).toBe('/a');
  expect(get('/a')).toBe('/a');
  expect(get('/b')).toBeNull();
  expect(get('/b')).toBeNull();
  expect(find).toHaveBeenCalledTimes(2);
});

test('vidé au-delà de max entrées', () => {
  const find = vi.fn(() => null);
  const get = createProjectRootCache(find, 2);
  get('/1'); get('/2'); get('/3'); get('/1');
  expect(find).toHaveBeenCalledTimes(4);
});
