// Contrôle partagé « l'app tourne-t-elle vraiment depuis une AppImage ? » (installation comme une app, entrée de menu,
// suppression du fichier téléchargé ; à réutiliser par les mises à jour). Jamais APPIMAGE / APPDIR seuls : un lanceur peut
// les poser hors AppImage.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';

/** ELF (`\x7fELF`) puis la marque AppImage type 2 (`AI\x02`) à l'octet 8. */
export function isAppImageHeader(b: Buffer): boolean {
  return b.length >= 11 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46 && b[8] === 0x41 && b[9] === 0x49 && b[10] === 0x02;
}

const unescapeMount = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

/** Points de montage de type FUSE (`fuse`, `fuse.*`) d'un /proc/self/mountinfo. */
export function fuseMountPoints(mountinfo: string): string[] {
  const out: string[] = [];
  for (const line of mountinfo.split('\n')) {
    const [left, right] = line.split(' - ');
    if (!left || !right) continue;
    const fstype = right.split(' ')[0] ?? '';
    if (!/^fuse(\.|$)/.test(fstype)) continue;
    const mp = left.split(' ')[4];
    if (mp) out.push(unescapeMount(mp));
  }
  return out;
}

export interface RealAppImageDeps {
  /** Contenu de /proc/self/mountinfo. */
  mountinfo?: string;
  realpath?: (p: string) => string;
}

/** Lit les premiers octets d'un fichier ordinaire, sans suivre de lien. */
function header(path: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return null;
    const b = Buffer.alloc(16);
    const n = readSync(fd, b, 0, 16, 0);
    return b.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Chemin de l'AppImage lancée, ou null. Exige tout à la fois :
 * - realpath(APPDIR) est un point de montage FUSE (/proc/self/mountinfo) ;
 * - realpath(/proc/self/exe) est sous ce montage ;
 * - APPIMAGE est un chemin absolu vers un fichier ordinaire (lstat : pas un lien) ;
 * - son en-tête est celui d'une AppImage (ELF + `AI\x02` à l'octet 8).
 */
export function realAppImage(env: NodeJS.ProcessEnv = process.env, deps: RealAppImageDeps = {}): string | null {
  const img = env.APPIMAGE;
  const dir = env.APPDIR;
  if (!img || !dir || !isAbsolute(img) || !isAbsolute(dir)) return null;
  const realpath = deps.realpath ?? ((p: string) => realpathSync(p));
  try {
    const mount = realpath(dir);
    const mountinfo = deps.mountinfo ?? readFileSync('/proc/self/mountinfo', 'utf8');
    if (!fuseMountPoints(mountinfo).includes(mount)) return null;
    const exe = realpath('/proc/self/exe');
    if (!exe.startsWith(mount.endsWith(sep) ? mount : mount + sep)) return null;
    if (!lstatSync(img).isFile()) return null;
    const h = header(img);
    return h && isAppImageHeader(h) ? img : null;
  } catch {
    return null;
  }
}
