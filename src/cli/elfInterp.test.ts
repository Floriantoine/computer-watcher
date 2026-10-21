import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { elfInterpreter, type ReadAt } from './elfInterp';

/** ELF minimal : en-tête, en-têtes de programme à l'offset 64 (64 bits) ou 52 (32 bits), chemin du chargeur à 512. */
function elf(o: { is64?: boolean; le?: boolean; machine?: number; interp?: string | null; phnum?: number; truncate?: number }): Buffer {
  const is64 = o.is64 ?? true;
  const le = o.le ?? true;
  const b = Buffer.alloc(1024);
  b.write('\x7fELF', 0, 'latin1');
  b[4] = is64 ? 2 : 1;
  b[5] = le ? 1 : 2;
  const w16 = (v: number, at: number) => (le ? b.writeUInt16LE(v, at) : b.writeUInt16BE(v, at));
  const w32 = (v: number, at: number) => (le ? b.writeUInt32LE(v, at) : b.writeUInt32BE(v, at));
  const w64 = (v: number, at: number) => (le ? b.writeBigUInt64LE(BigInt(v), at) : b.writeBigUInt64BE(BigInt(v), at));
  w16(o.machine ?? 62, 18);
  const phoff = is64 ? 64 : 52;
  const phent = is64 ? 56 : 32;
  const headers = o.interp === null ? [1] : [6, 3, 1]; // PT_PHDR, PT_INTERP, PT_LOAD
  if (is64) {
    w64(phoff, 32);
    w16(phent, 54);
    w16(o.phnum ?? headers.length, 56);
  } else {
    w32(phoff, 28);
    w16(phent, 42);
    w16(o.phnum ?? headers.length, 44);
  }
  const interp = `${o.interp ?? '/lib64/ld-linux-x86-64.so.2'}\0`;
  headers.forEach((type, i) => {
    const at = phoff + i * phent;
    w32(type, at);
    if (type !== 3) return;
    if (is64) {
      w64(512, at + 8);
      w64(interp.length, at + 32);
    } else {
      w32(512, at + 4);
      w32(interp.length, at + 16);
    }
  });
  if (o.interp !== null) b.write(interp, 512, 'latin1');
  return o.truncate !== undefined ? b.subarray(0, o.truncate) : b;
}
const reader = (b: Buffer): ReadAt => (pos, len) => b.subarray(pos, pos + len);

describe('elfInterpreter', () => {
  test('ELF 64 bits petit-boutiste natif : chemin du chargeur', () => {
    const b = elf({});
    expect(elfInterpreter(b.subarray(0, 256), reader(b), 'x64')).toBe('/lib64/ld-linux-x86-64.so.2');
  });
  test('32 bits (compatibilité x86) et gros-boutiste natif', () => {
    const b32 = elf({ is64: false, machine: 3, interp: '/lib/ld-linux.so.2' });
    expect(elfInterpreter(b32, reader(b32), 'x64')).toBe('/lib/ld-linux.so.2');
    const be = elf({ le: false, machine: 22, interp: '/lib/ld64.so.1' });
    expect(elfInterpreter(be, reader(be), 's390x')).toBe('/lib/ld64.so.1');
  });
  test('statique (sans PT_INTERP, ou sans en-tête de programme) : null', () => {
    const b = elf({ interp: null });
    expect(elfInterpreter(b, reader(b), 'x64')).toBeNull();
    const none = elf({ phnum: 0 });
    expect(elfInterpreter(none, reader(none), 'x64')).toBeNull();
  });
  test('ELF étranger (binfmt_misc possible), tronqué, illisible ou incohérent : undefined (exec direct)', () => {
    const arm = elf({ machine: 183 });
    expect(elfInterpreter(arm, reader(arm), 'x64')).toBeUndefined();
    expect(elfInterpreter(arm, reader(arm), 'arm64')).toBe('/lib64/ld-linux-x86-64.so.2');
    expect(elfInterpreter(Buffer.from('\x7fELF', 'latin1'), () => null, 'x64')).toBeUndefined();
    const b = elf({});
    expect(elfInterpreter(b, () => null, 'x64')).toBeUndefined();
    expect(elfInterpreter(b, reader(b.subarray(0, 300)), 'x64')).toBeUndefined();
    expect(elfInterpreter(elf({ phnum: 2000 }), reader(b), 'x64')).toBeUndefined();
    expect(elfInterpreter(Buffer.from('#!/bin/sh\n'.padEnd(64)), reader(b), 'x64')).toBeUndefined();
    expect(elfInterpreter(b, reader(b), 'mips')).toBeUndefined();
  });
  test('vrai binaire du système (/bin/sh) : un chargeur absolu, ou statique', () => {
    const real = readFileSync('/bin/sh');
    const r = elfInterpreter(real.subarray(0, 256), reader(real));
    expect(r === null || (typeof r === 'string' && r.startsWith('/'))).toBe(true);
  });
});
