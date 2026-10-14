import { describe, expect, test } from 'vitest';
import { isExplorableName, knownCacheNames } from './cacheExplorer';

const r = { home: '/h', configHome: '/h/.config', dataHome: '/h/.local/share', cacheHome: '/h/.cache' };

describe('knownCacheNames', () => {
  test('dossiers des familles connues et de l’app, jamais ceux de ~/.config', () => {
    const k = knownCacheNames(r);
    for (const n of ['uv', 'pip', 'yarn', 'paru', 'yay', 'ms-playwright', 'puppeteer', 'google-chrome', 'chromium', 'mozilla', 'BraveSoftware', 'spotify', 'computer-watcher', 'computer-watcher-updater', 'proc-watch-updater']) {
      expect(k.has(n), n).toBe(true);
    }
    expect(k.has('Code')).toBe(false);
    expect(k.has('outil-inconnu')).toBe(false);
  });
  test('XDG_CACHE_HOME ailleurs : noms relatifs à cette racine', () => {
    expect(knownCacheNames({ ...r, cacheHome: '/h/cache' }).has('uv')).toBe(true);
  });
});

describe('isExplorableName', () => {
  const known = new Set(['uv']);
  test('un seul composant, jamais une famille connue', () => {
    expect(isExplorableName('outil-inconnu', known)).toBe(true);
    expect(isExplorableName('.cache-cachee', known)).toBe(true);
    for (const n of ['', '.', '..', 'a/b', '../x', 'uv', 'a\0b', 'x'.repeat(256)]) expect(isExplorableName(n, known), JSON.stringify(n)).toBe(false);
  });
  test('nom finissant par .asar : jamais proposé (Electron le lirait comme une archive)', () => {
    for (const n of ['paquet.asar', 'PAQUET.ASAR']) expect(isExplorableName(n, known), n).toBe(false);
  });
});
