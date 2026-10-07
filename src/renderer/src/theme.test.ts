import { describe, expect, it } from 'vitest';
import type { SystemInfo } from '../../core/types';
import { ICON_PALETTE, cardLevel, cardTone, gaugeTone, groupIconColor, metricLevels } from './theme';

describe('groupIconColor', () => {
  it('renvoie toujours une teinte de la palette', () => {
    for (const id of ['', 'a', 'claude', 'app:firefox', 'project:/home/x/api', 'others', 'é∂ƒ😀']) {
      expect(ICON_PALETTE).toContain(groupIconColor(id));
    }
  });

  it('est déterministe', () => {
    expect(groupIconColor('app:chrome')).toBe(groupIconColor('app:chrome'));
    expect(groupIconColor('project:/srv/api')).toBe(groupIconColor('project:/srv/api'));
  });

  it('répartit des ids différents sur plusieurs teintes', () => {
    const ids = Array.from({ length: 64 }, (_, i) => `group-${i}`);
    const used = new Set(ids.map(groupIconColor));
    expect(used.size).toBeGreaterThanOrEqual(ICON_PALETTE.length - 1);
  });

  it('propose 6 à 8 teintes sombres distinctes', () => {
    expect(ICON_PALETTE.length).toBeGreaterThanOrEqual(6);
    expect(ICON_PALETTE.length).toBeLessThanOrEqual(8);
    expect(new Set(ICON_PALETTE).size).toBe(ICON_PALETTE.length);
    for (const hex of ICON_PALETTE) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      // Luminance perçue basse : l'icône blanche doit rester lisible.
      expect(0.299 * r! + 0.587 * g! + 0.114 * b!).toBeLessThan(110);
    }
  });
});

describe('cardLevel', () => {
  it('suit les seuils de part mémoire de la carte', () => {
    expect(cardLevel(0)).toBe('ok');
    expect(cardLevel(7.9)).toBe('ok');
    expect(cardLevel(8)).toBe('warn');
    expect(cardLevel(19.9)).toBe('warn');
    expect(cardLevel(20)).toBe('bad');
  });
});

describe('gaugeTone', () => {
  it("garde la teinte propre de la jauge quand la pression est normale", () => {
    expect(gaugeTone('mem', 'ok')).toBe('mem');
    expect(gaugeTone('swap', 'ok')).toBe('swap');
    expect(gaugeTone('psi', 'ok')).toBe('psi');
  });

  it("passe en couleur d'alerte selon pressureLevel", () => {
    expect(gaugeTone('mem', 'warn')).toBe('warn');
    expect(gaugeTone('psi', 'warn')).toBe('warn');
    expect(gaugeTone('mem', 'bad')).toBe('bad');
    expect(gaugeTone('swap', 'bad')).toBe('bad');
  });
});

describe('cardTone', () => {
  it('violet si faible, ambre si notable, rose-orange si lourde', () => {
    expect(cardTone(3)).toBe('mem');
    expect(cardTone(10)).toBe('warn');
    expect(cardTone(34)).toBe('swap');
  });
});

describe('metricLevels', () => {
  const sys = (over: Partial<SystemInfo>): SystemInfo => ({
    memTotalKB: 32_000_000,
    memAvailableKB: 12_000_000,
    swapTotalKB: 20_000_000,
    swapFreeKB: 20_000_000,
    load1: 1,
    psiSome10: 0,
    ...over,
  });

  it('attribue l’alerte de pressureLevel au swap quand il en est la cause', () => {
    expect(metricLevels(sys({ swapFreeKB: 3_400_000, psiSome10: 1 }))).toEqual({ swap: 'bad', psi: 'ok' });
    expect(metricLevels(sys({ swapFreeKB: 9_000_000 }))).toEqual({ swap: 'warn', psi: 'ok' });
  });

  it('attribue l’alerte à la pression mémoire quand elle en est la cause', () => {
    expect(metricLevels(sys({ psiSome10: 30 }))).toEqual({ swap: 'ok', psi: 'bad' });
    expect(metricLevels(sys({ psiSome10: 12 }))).toEqual({ swap: 'ok', psi: 'warn' });
  });

  it('reste ok sans swap ni PSI', () => {
    expect(metricLevels(sys({ swapTotalKB: 0, swapFreeKB: 0, psiSome10: null }))).toEqual({ swap: 'ok', psi: 'ok' });
  });
});
