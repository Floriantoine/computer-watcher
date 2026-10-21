// Chargeur dynamique (PT_INTERP) d'un exécutable ELF, lu avant l'execve de `computer-watcher run` : un chargeur absent
// fait échouer execve en ENOENT, ce qui abat Node (process.execve, code 134, impossible à rattraper). Vérifié à
// l'avance, il donne le code 127 et un message clair, comme un interpréteur « #! » absent.

/** e_machine des ELF exécutés nativement selon process.arch ; les autres passent par binfmt_misc (qemu…) : jamais vérifiés. */
const NATIVE_MACHINES: Readonly<Record<string, readonly number[]>> = {
  x64: [62, 3], // EM_X86_64, EM_386 (compatibilité 32 bits)
  ia32: [3],
  arm64: [183, 40], // EM_AARCH64, EM_ARM
  arm: [40],
  riscv64: [243],
  ppc64: [21],
  s390x: [22],
  loong64: [258],
};

const PT_INTERP = 3;
/** Bornes de lecture : en-têtes de programme (64 Kio au plus) et chemin du chargeur (PATH_MAX). */
const MAX_PHDRS_BYTES = 64 * 1024;
const MAX_INTERP = 4096;

export type ReadAt = (pos: number, len: number) => Buffer | null;

/**
 * Chemin du chargeur demandé par l'ELF natif dont `head` est le début (au moins 64 octets), null s'il n'en demande pas
 * (statique), undefined si on ne peut pas savoir (ELF étranger, tronqué, illisible, incohérent) : exec direct, comme avant.
 */
export function elfInterpreter(head: Buffer, readAt: ReadAt, arch: string = process.arch): string | null | undefined {
  if (head.length < 64 || head[0] !== 0x7f || head.subarray(1, 4).toString('latin1') !== 'ELF') return undefined;
  const is64 = head[4] === 2 ? true : head[4] === 1 ? false : null;
  const le = head[5] === 1 ? true : head[5] === 2 ? false : null;
  if (is64 === null || le === null) return undefined;
  const u16 = (b: Buffer, o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (b: Buffer, o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const u64 = (b: Buffer, o: number) => Number(le ? b.readBigUInt64LE(o) : b.readBigUInt64BE(o));
  if (!(NATIVE_MACHINES[arch] ?? []).includes(u16(head, 18))) return undefined;
  const phoff = is64 ? u64(head, 32) : u32(head, 28);
  const phentsize = u16(head, is64 ? 54 : 42);
  const phnum = u16(head, is64 ? 56 : 44);
  if (phnum === 0) return null;
  if (phentsize < (is64 ? 56 : 32) || phentsize * phnum > MAX_PHDRS_BYTES || !Number.isSafeInteger(phoff)) return undefined;
  const ph = readAt(phoff, phentsize * phnum);
  if (ph === null || ph.length < phentsize * phnum) return undefined;
  for (let i = 0; i < phnum; i++) {
    const o = i * phentsize;
    if (u32(ph, o) !== PT_INTERP) continue;
    const off = is64 ? u64(ph, o + 8) : u32(ph, o + 4);
    const size = is64 ? u64(ph, o + 32) : u32(ph, o + 16);
    if (size < 2 || size > MAX_INTERP || !Number.isSafeInteger(off)) return undefined;
    const s = readAt(off, size);
    if (s === null || s.length < size) return undefined;
    const end = s.indexOf(0);
    const path = s.subarray(0, end < 0 ? s.length : end).toString('latin1');
    return path === '' ? undefined : path;
  }
  return null;
}
