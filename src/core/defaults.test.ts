import { expect, test } from 'vitest';
import { DEFAULT_CONFIG } from './defaults';

// /proc/<pid>/status « Name » est tronqué à 15 caractères (TASK_COMM_LEN - 1).
test('chaque entrée protégée exacte tient dans 15 caractères', () => {
  const tooLong = DEFAULT_CONFIG.protected.filter((e) => !e.startsWith('/') && e.length > 15);
  expect(tooLong).toEqual([]);
});
