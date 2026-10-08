import { describe, expect, it } from 'vitest';
import { decide } from './classify';
import type { PackageHints } from './packageJson';

const pkg: PackageHints = { front: true, back: false, scripts: { dev: 'vite --port 1', build: 'tsc' } };
const base = { overrideKey: 'k', overrides: {}, match: null, ports: [], chainText: 'vite', pkg: null };

describe('decide', () => {
  it('override > commande > port > package > unknown', () => {
    const match = { category: 'worker' as const, label: 'w' };
    const all = { ...base, overrides: { k: 'ai' as const }, match, ports: [5432], pkg };
    expect(decide(all)).toEqual({ category: 'ai', source: 'manual' });
    expect(decide({ ...all, overrides: {} })).toEqual({ category: 'worker', source: 'command' });
    expect(decide({ ...all, overrides: {}, match: null })).toEqual({ category: 'db', source: 'port' });
    expect(decide({ ...all, overrides: {}, match: null, ports: [] })).toEqual({ category: 'front', source: 'package' });
    expect(decide(base)).toEqual({ category: 'unknown', source: 'unknown' });
  });
  it('package back', () => {
    expect(decide({ ...base, pkg: { front: false, back: true, scripts: {} } })).toEqual({ category: 'back', source: 'package' });
  });
  it('script dev contenant la chaîne -> catégorie de la règle du script', () => {
    const r = decide({ ...base, pkg: { front: false, back: true, scripts: { dev: 'vite --port 1' } }, matchScript: () => ({ category: 'front', label: 'Vite' }) });
    expect(r).toEqual({ category: 'front', source: 'package' });
  });
  it('script non dev/start ignoré, chaîne vide ignorée', () => {
    const p = { front: false, back: true, scripts: { build: 'vite build' } };
    const ms = () => ({ category: 'build' as const, label: 'x' });
    expect(decide({ ...base, pkg: p, matchScript: ms }).category).toBe('back');
    expect(decide({ ...base, chainText: '', pkg: { ...p, scripts: { dev: 'vite' } }, matchScript: ms }).category).toBe('back');
  });
  it('clé override héritée du prototype ignorée', () => {
    expect(decide({ ...base, overrideKey: 'toString' }).source).toBe('unknown');
  });
});
