import { afterEach, expect, test, vi } from 'vitest';
import { realCliDeps } from './deps';

afterEach(() => vi.restoreAllMocks());

test('messages écrits par writeSync, jamais par process.stdout / process.stderr (O_NONBLOCK hérité par la commande, revue I1)', () => {
  const out = vi.spyOn(process.stdout, 'write');
  const err = vi.spyOn(process.stderr, 'write');
  const d = realCliDeps();
  d.stdout('');
  d.stderr('');
  expect(out).not.toHaveBeenCalled();
  expect(err).not.toHaveBeenCalled();
});
