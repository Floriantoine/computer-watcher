import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('read qui lève -> null', () => {
    expect(readPackageHints('/t1', () => { throw new Error('x'); })).toBeNull();
  });
  it('scripts tableau ignoré', () => {
    expect(readPackageHints('/t2', () => pkg({ scripts: ['a'] }))?.scripts).toEqual({});
  });
  it('peerDependencies comptées', () => {
    expect(readPackageHints('/t3', () => pkg({ peerDependencies: { vue: '1' } }))?.front).toBe(true);
  });
  it('horloge reculée -> expiré', () => {
    let reads = 0; let t = 5000;
    const read = () => { reads++; return pkg({}); };
    readPackageHints('/t4', read, () => t); t = 100; readPackageHints('/t4', read, () => t);
    expect(reads).toBe(2);
  });
  it('éviction à 500 entrées, sans éviction pour une clé existante', () => {
    let reads = 0; const read = () => { reads++; return pkg({}); };
    for (let i = 0; i < 500; i++) readPackageHints('/r' + i, read, () => 0);
    readPackageHints('/r499', read, () => 70_000); // existante expirée : relue, sans éviction
    expect(reads).toBe(501);
    readPackageHints('/r1', read, () => 0); // toujours en cache : pas de lecture
    expect(reads).toBe(501);
    readPackageHints('/new', read, () => 70_000); // nouvelle clé : évince la plus ancienne (r0)
    expect(reads).toBe(502);
    readPackageHints('/r499', read, () => 70_000);
    expect(reads).toBe(502);
    readPackageHints('/r0', read, () => 0);
    expect(reads).toBe(503);
  });
  describe('fichiers spéciaux', () => {
    it('FIFO et fichier > 1 MiB -> null rapidement', () => {
      const d = mkdtempSync(join(tmpdir(), 'procwatch-pj-'));
      try {
        writeFileSync(join(d, 'package.json'), 'x'.repeat(1024 * 1024 + 1));
        const t0 = Date.now();
        expect(readPackageHints(d)).toBeNull();
        const f = mkdtempSync(join(tmpdir(), 'procwatch-pj-'));
        try {
          try { execFileSync('mkfifo', [join(f, 'package.json')]); } catch { return; }
          expect(readPackageHints(f)).toBeNull();
        } finally { rmSync(f, { recursive: true, force: true }); }
        expect(Date.now() - t0).toBeLessThan(2000);
      } finally { rmSync(d, { recursive: true, force: true }); }
    });
  });
});
