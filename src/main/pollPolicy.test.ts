import { describe, expect, test } from 'vitest';
import { BACKGROUND_POLL_MS, BLUR_GRACE_MS, POLL_MS, pollDelay } from './pollPolicy';

describe('pollDelay', () => {
  test('fenêtre réduite ou cachée → aucune collecte', () => {
    expect(pollDelay({ hidden: true, blurredAt: null }, 0)).toBeNull();
    expect(pollDelay({ hidden: true, blurredAt: 0 }, 10 * BLUR_GRACE_MS)).toBeNull();
  });
  test('fenêtre active → toutes les 2 s', () => {
    expect(pollDelay({ hidden: false, blurredAt: null }, 123)).toBe(POLL_MS);
    expect(POLL_MS).toBe(2000);
  });
  test('sans focus depuis peu → toujours 2 s ; depuis plus d\'une minute → rythme de fond', () => {
    expect(pollDelay({ hidden: false, blurredAt: 1000 }, 1000 + BLUR_GRACE_MS - 1)).toBe(POLL_MS);
    expect(pollDelay({ hidden: false, blurredAt: 1000 }, 1000 + BLUR_GRACE_MS)).toBe(BACKGROUND_POLL_MS);
    expect(BACKGROUND_POLL_MS).toBeGreaterThan(POLL_MS);
  });
});
