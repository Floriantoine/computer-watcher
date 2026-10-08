import { crc32, deflateSync } from 'node:zlib';
import type { Level } from '../core/pressure';
import type { SystemInfo } from '../core/types';

/** Icône de la barre des tâches : anneau = % de RAM utilisée, couleur selon `pressureLevel` (mêmes teintes que les jauges). */
export const TRAY_SIZE = 22;
export const TRAY_COLORS: Record<Level, readonly [number, number, number]> = {
  ok: [0x7c, 0x5c, 0xff],
  warn: [0xff, 0xb5, 0x47],
  bad: [0xff, 0x5c, 0x8a],
};
/** Piste de l'anneau (partie non utilisée) : gris lisible sur fond clair comme sombre. */
export const TRAY_TRACK: readonly [number, number, number, number] = [0x8a, 0x8f, 0x9c, 150];

export const memPercent = (s: SystemInfo): number => (s.memTotalKB ? (1 - s.memAvailableKB / s.memTotalKB) * 100 : 0);

/** Tranche de 5 % (arrondi inférieur, bornée à 0–100) : 42 et 43,9 → 40, 48 → 45. */
const slice = (memPct: number): number => Math.min(100, Math.max(0, Math.floor(memPct / 5) * 5));

/** Clé de l'icône : par tranches de 5 %, l'icône n'est redessinée que si la clé change. */
export function iconKey(memPct: number, level: Level): string {
  return `${slice(memPct)}:${level}`;
}

/**
 * Pixels RGBA (ligne par ligne) : piste grise et arc coloré de midi dans le sens horaire sur `memPct` % du tour.
 * Bords intérieur et extérieur adoucis ; centre et coins transparents.
 */
export function ringPixels(memPct: number, level: Level, size = TRAY_SIZE): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const c = size / 2;
  const rOut = size / 2 - 0.5;
  const rIn = rOut - size * 0.18;
  const pct = slice(memPct);
  const arcEnd = (pct / 100) * 2 * Math.PI;
  const color = TRAY_COLORS[level];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const d = Math.hypot(dx, dy);
      const cover = Math.min(1, Math.max(0, Math.min(d - rIn, rOut - d) + 0.5));
      if (cover <= 0) continue;
      // angle depuis midi, sens horaire, dans [0, 2π)
      let a = Math.atan2(dx, -dy);
      if (a < 0) a += 2 * Math.PI;
      const inArc = a < arcEnd;
      const i = (y * size + x) * 4;
      const [r, g, b, alpha] = inArc ? [color[0], color[1], color[2], 255] : TRAY_TRACK;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = Math.round(alpha * cover);
    }
  }
  return out;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/** PNG RGBA 8 bits sans entrelacement, chaque ligne au filtre 0. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const go = (kb: number) => `${(kb / (1024 * 1024)).toFixed(1).replace('.', ',')} Go`;

/** Libellés du menu et de l'infobulle : RAM et swap utilisés, pression (PSI some avg10) et charge sur 1 min. */
export function trayMenuLabels(s: SystemInfo): { mem: string; pressure: string; tooltip: string } {
  const memUsed = Math.max(0, s.memTotalKB - s.memAvailableKB);
  const swapUsed = Math.max(0, s.swapTotalKB - s.swapFreeKB);
  const psi = s.psiSome10 === null ? '—' : `${Math.round(s.psiSome10)} %`;
  return {
    mem: `RAM ${go(memUsed)} · Swap ${go(swapUsed)}`,
    pressure: `Pression ${psi} · Charge ${s.load1.toFixed(1).replace('.', ',')}`,
    tooltip: `proc-watch — RAM ${Math.round(memPercent(s))} %`,
  };
}
