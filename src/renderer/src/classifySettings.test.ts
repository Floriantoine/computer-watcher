import { describe, expect, test } from 'vitest';
import { DEFAULT_CONFIG } from '../../core/defaults';
import type { Category, Config } from '../../core/types';
import { overrideRows, withoutOverride, withDetectPorts } from './classifySettings';

const cfg = (overrides: Record<string, Category>, detectPorts = true): Config => ({ ...DEFAULT_CONFIG, classify: { detectPorts, overrides } });

describe('overrideRows', () => {
  test('projet = dernier segment de la racine (chemin complet en titre), motif, catégorie ; triées par projet puis motif', () => {
    const rows = overrideRows({
      '/home/u/zeta|node server.js': 'back',
      '/home/u/acme|vite': 'build',
      '/home/u/acme|node dist/main': 'worker',
    });
    expect(rows).toEqual([
      { key: '/home/u/acme|node dist/main', project: 'acme', scope: '/home/u/acme', signature: 'node dist/main', category: 'worker' },
      { key: '/home/u/acme|vite', project: 'acme', scope: '/home/u/acme', signature: 'vite', category: 'build' },
      { key: '/home/u/zeta|node server.js', project: 'zeta', scope: '/home/u/zeta', signature: 'node server.js', category: 'back' },
    ]);
  });

  test('portée hors projet (id de groupe) : nom sans préfixe ; un « | » dans le chemin reste dans le projet', () => {
    expect(overrideRows({ 'app:chrome|chrome': 'browser', claude: 'ai' as Category, '/home/u/a|b|vite': 'front' })).toEqual([
      { key: '/home/u/a|b|vite', project: 'a|b', scope: '/home/u/a|b', signature: 'vite', category: 'front' },
      { key: 'app:chrome|chrome', project: 'chrome', scope: 'app:chrome', signature: 'chrome', category: 'browser' },
      { key: 'claude', project: 'claude', scope: 'claude', signature: '', category: 'ai' },
    ]);
  });

  test('aucune correction → liste vide', () => {
    expect(overrideRows({})).toEqual([]);
  });
});

describe('withoutOverride', () => {
  test('retire une clé sans toucher au reste ni à la config d\'origine', () => {
    const c = cfg({ 'a|vite': 'front', 'b|nest start': 'back' });
    const next = withoutOverride(c, 'a|vite');
    expect(next.classify.overrides).toEqual({ 'b|nest start': 'back' });
    expect(c.classify.overrides).toEqual({ 'a|vite': 'front', 'b|nest start': 'back' });
    expect(next.protected).toBe(c.protected);
  });
  test('sans clé : efface tout', () => {
    expect(withoutOverride(cfg({ 'a|vite': 'front', 'b|x': 'back' }), null).classify).toEqual({ detectPorts: true, overrides: {} });
  });
});

test('withDetectPorts : bascule l\'interrupteur, garde les corrections', () => {
  const c = cfg({ 'a|vite': 'front' });
  expect(withDetectPorts(c, false).classify).toEqual({ detectPorts: false, overrides: { 'a|vite': 'front' } });
  expect(c.classify.detectPorts).toBe(true);
});
