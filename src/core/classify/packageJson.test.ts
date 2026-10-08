import { beforeEach, describe, expect, it } from 'vitest';
import { clearPackageHintsCache, readPackageHints } from './packageJson';

const pkg = (o: object) => JSON.stringify(o);
beforeEach(() => clearPackageHintsCache());

describe('readPackageHints', () => {
  it('react seul -> front', () => {
    const h = readPackageHints('/a', () => pkg({ dependencies: { react: '1' }, scripts: { dev: 'vite' } }));
    expect(h).toEqual({ front: true, back: false, scripts: { dev: 'vite' } });
  });
  it('react + express -> back seulement', () => {
    const h = readPackageHints('/b', () => pkg({ dependencies: { react: '1' }, devDependencies: { express: '1' } }));
    expect(h).toMatchObject({ front: false, back: true });
  });
  it.each(['vue', 'svelte', '@angular/core', 'solid-js'])('%s -> front', (d) => {
    expect(readPackageHints('/c' + d, () => pkg({ dependencies: { [d]: '1' } }))?.front).toBe(true);
  });
  it.each(['fastify', '@nestjs/core', 'koa', '@hapi/hapi'])('%s -> back', (d) => {
    expect(readPackageHints('/d' + d, () => pkg({ dependencies: { [d]: '1' } }))?.back).toBe(true);
  });
  it('json invalide ou absent -> null sans exception', () => {
    expect(readPackageHints('/e', () => '{nope')).toBeNull();
    expect(readPackageHints('/f', () => null)).toBeNull();
    expect(readPackageHints('/g', () => '[]')).toMatchObject({ front: false, back: false });
  });
  it('cache 60 s', () => {
    let reads = 0; let t = 1000;
    const read = () => { reads++; return pkg({}); };
    readPackageHints('/h', read, () => t);
    t += 10_000; readPackageHints('/h', read, () => t);
    expect(reads).toBe(1);
    t += 51_000; readPackageHints('/h', read, () => t);
    expect(reads).toBe(2);
  });
});
