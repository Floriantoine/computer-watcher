import { expect, test } from 'vitest';
import { stickyIds, recordSeparate } from './stickyCards';

const g = (id: string, kind = 'command') => ({ id, kind });

test('un groupe affiché à part le reste HOLD ms après être repassé sous les seuils, puis est oublié', () => {
  const seen = new Map<string, number>();
  recordSeparate(seen, [g('command:a'), g('others', 'others')], 1000);
  expect([...seen.keys()]).toEqual(['command:a']);
  expect([...stickyIds(seen, 1000 + 29_999, 30_000)]).toEqual(['command:a']);
  expect([...stickyIds(seen, 1000 + 30_000, 30_000)]).toEqual([]);
  expect(seen.size).toBe(0);
});
