import { inflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import type { SystemInfo } from '../core/types';
import { encodePng, iconKey, memPercent, ringPixels, TRAY_COLORS, TRAY_SIZE, TRAY_TRACK, trayMenuLabels } from './trayIcon';

const GB = 1024 * 1024;

/** Couleur RGBA du pixel le plus proche du point de l'anneau à l'heure `h` (0 = midi), au milieu de son épaisseur. */
function pixelAt(px: Uint8Array, hour: number, radius = 8.5, size = TRAY_SIZE): number[] {
  const a = (hour / 12) * 2 * Math.PI;
  const x = Math.floor(size / 2 + radius * Math.sin(a));
  const y = Math.floor(size / 2 - radius * Math.cos(a));
  const i = (y * size + x) * 4;
  return [...px.slice(i, i + 4)];
}
const rgba = (c: readonly [number, number, number, number?]) => [c[0], c[1], c[2], c[3] ?? 255];

describe('iconKey', () => {
  test('tranches de 5 % et niveau', () => {
    expect(iconKey(42, 'ok')).toBe(iconKey(43.9, 'ok'));
    expect(iconKey(42, 'ok')).not.toBe(iconKey(48, 'ok'));
    expect(iconKey(42, 'ok')).not.toBe(iconKey(42, 'warn'));
  });
});

describe('memPercent', () => {
  test('part utilisée ; total nul → 0', () => {
    expect(memPercent({ memTotalKB: 100, memAvailableKB: 25 } as SystemInfo)).toBeCloseTo(75);
    expect(memPercent({ memTotalKB: 0, memAvailableKB: 0 } as SystemInfo)).toBe(0);
  });
});

describe('ringPixels', () => {
  test('25 % : arc coloré de midi à 3 h, piste grise ailleurs, centre transparent', () => {
    const px = ringPixels(25, 'ok');
    expect(px.length).toBe(TRAY_SIZE * TRAY_SIZE * 4);
    expect(pixelAt(px, 1)).toEqual(rgba(TRAY_COLORS.ok));
    expect(pixelAt(px, 6)).toEqual(rgba(TRAY_TRACK));
    expect(pixelAt(px, 9)).toEqual(rgba(TRAY_TRACK));
    const c = ((TRAY_SIZE / 2) * TRAY_SIZE + TRAY_SIZE / 2) * 4;
    expect(px[c + 3]).toBe(0);
    expect(px[3]).toBe(0); // coin
  });
  test('100 % : anneau complet coloré', () => {
    const px = ringPixels(100, 'ok');
    for (const h of [0.5, 3, 6, 9, 11.5]) expect(pixelAt(px, h)).toEqual(rgba(TRAY_COLORS.ok));
  });
  test('0 % : aucune couleur, seulement la piste', () => {
    const px = ringPixels(0, 'ok');
    for (const h of [0.5, 3, 6, 9]) expect(pixelAt(px, h)).toEqual(rgba(TRAY_TRACK));
  });
  test('couleurs des niveaux', () => {
    expect(TRAY_COLORS).toEqual({ ok: [0x7c, 0x5c, 0xff], warn: [0xff, 0xb5, 0x47], bad: [0xff, 0x5c, 0x8a] });
    expect(pixelAt(ringPixels(50, 'bad'), 1)).toEqual([0xff, 0x5c, 0x8a, 255]);
    expect(pixelAt(ringPixels(50, 'warn'), 1)).toEqual([0xff, 0xb5, 0x47, 255]);
  });
});

describe('encodePng', () => {
  test('signature, IHDR 22×22 RGBA, IDAT = lignes au filtre 0', () => {
    const px = ringPixels(42, 'warn');
    const png = encodePng(px, TRAY_SIZE, TRAY_SIZE);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks = new Map<string, Buffer>();
    for (let o = 8; o < png.length; ) {
      const len = png.readUInt32BE(o);
      const type = png.toString('latin1', o + 4, o + 8);
      chunks.set(type, Buffer.concat([chunks.get(type) ?? Buffer.alloc(0), png.subarray(o + 8, o + 8 + len)]));
      o += 12 + len;
    }
    expect([...chunks.keys()]).toEqual(['IHDR', 'IDAT', 'IEND']);
    const ihdr = chunks.get('IHDR')!;
    expect(ihdr.readUInt32BE(0)).toBe(22);
    expect(ihdr.readUInt32BE(4)).toBe(22);
    expect([...ihdr.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
    const raw = inflateSync(chunks.get('IDAT')!);
    expect(raw.length).toBe(22 * (1 + 22 * 4));
    for (let y = 0; y < 22; y++) {
      const row = raw.subarray(y * 89, (y + 1) * 89);
      expect(row[0]).toBe(0);
      expect(Buffer.from(row.subarray(1)).equals(Buffer.from(px.subarray(y * 88, (y + 1) * 88)))).toBe(true);
    }
  });
  test('CRC de chaque bloc correct', async () => {
    const { crc32 } = await import('node:zlib');
    const png = encodePng(ringPixels(10, 'ok'), TRAY_SIZE, TRAY_SIZE);
    for (let o = 8; o < png.length; ) {
      const len = png.readUInt32BE(o);
      expect(png.readUInt32BE(o + 8 + len)).toBe(crc32(png.subarray(o + 4, o + 8 + len)) >>> 0);
      o += 12 + len;
    }
  });
});

describe('trayMenuLabels', () => {
  const s: SystemInfo = {
    memTotalKB: 31.5 * GB, memAvailableKB: 21.1 * GB, swapTotalKB: 16 * GB, swapFreeKB: 3.6 * GB,
    load1: 1.52, psiSome10: 0.2, shmemKB: 0,
  };
  test('RAM et swap utilisés en Go, pression et charge, virgule décimale', () => {
    expect(trayMenuLabels(s)).toEqual({
      mem: 'RAM 10,4 Go · Swap 12,4 Go',
      pressure: 'Pression 0 % · Charge 1,5',
      tooltip: 'Computer Watcher — RAM 33 %',
    });
  });
  test('PSI indisponible → « Pression — »', () => {
    expect(trayMenuLabels({ ...s, psiSome10: null }).pressure).toBe('Pression — · Charge 1,5');
  });
  test('sans swap → Swap 0,0 Go', () => {
    expect(trayMenuLabels({ ...s, swapTotalKB: 0, swapFreeKB: 0 }).mem).toBe('RAM 10,4 Go · Swap 0,0 Go');
  });
});
