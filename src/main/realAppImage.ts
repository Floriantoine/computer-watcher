// Contrôle partagé « l'app tourne-t-elle vraiment depuis une AppImage ? » (installation comme une app, entrée de menu,
// suppression du fichier téléchargé ; à réutiliser par les mises à jour). Jamais APPIMAGE / APPDIR seuls : un lanceur peut
// les poser hors AppImage.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, sep } from 'node:path';
import { hasControlChars } from './appImageTrust';

/** ELF (`\x7fELF`) puis la marque AppImage type 2 (`AI\x02`) à l'octet 8. */
export function isAppImageHeader(b: Buffer): boolean {
  return b.length >= 11 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46 && b[8] === 0x41 && b[9] === 0x49 && b[10] === 0x02;
}

const unescapeMount = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

/** Montages de type FUSE (`fuse`, `fuse.*`) d'un /proc/self/mountinfo : point de montage et type. */
export function fuseMounts(mountinfo: string): { mountPoint: string; fstype: string }[] {
  const out: { mountPoint: string; fstype: string }[] = [];
  for (const line of mountinfo.split('\n')) {
    const [left, right] = line.split(' - ');
    if (!left || !right) continue;
    const fstype = right.split(' ')[0] ?? '';
    if (!/^fuse(\.|$)/.test(fstype)) continue;
    const mp = left.split(' ')[4];
    if (mp) out.push({ mountPoint: unescapeMount(mp), fstype: unescapeMount(fstype) });
  }
  return out;
}

export const fuseMountPoints = (mountinfo: string): string[] => fuseMounts(mountinfo).map((m) => m.mountPoint);

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
 * Fichier utilisable comme AppImage (copie installée choisie pour le service ou le démarrage automatique) : fichier
 * ordinaire non vide, jamais un lien, avec l'en-tête AppImage. Le fichier vide qu'écrit l'updater pour réessayer une
 * installation ratée, ou un fichier étranger, ne l'est pas.
 */
export function isUsableAppImage(path: string): boolean {
  const h = header(path);
  return !!h && isAppImageHeader(h);
}

/**
 * Chemin de l'AppImage lancée, ou null. Exige tout à la fois :
 * - realpath(APPDIR) est un point de montage de type `fuse.<basename(APPIMAGE)>` (/proc/self/mountinfo) ;
 * - realpath(/proc/self/exe) est sous ce montage ;
 * - APPIMAGE est un chemin absolu, sans caractère de contrôle, vers un fichier ordinaire (lstat : pas un lien) hors du montage ;
 * - son en-tête est celui d'une AppImage (ELF + `AI\x02` à l'octet 8).
 */
export function realAppImage(env: NodeJS.ProcessEnv = process.env, deps: RealAppImageDeps = {}): string | null {
  const img = env.APPIMAGE;
  const dir = env.APPDIR;
  if (!img || !dir || !isAbsolute(img) || !isAbsolute(dir) || hasControlChars(img)) return null;
  const realpath = deps.realpath ?? ((p: string) => realpathSync(p));
  try {
    const mount = realpath(dir);
    const mountinfo = deps.mountinfo ?? readFileSync('/proc/self/mountinfo', 'utf8');
    // R4 : le runtime AppImage nomme le montage fuse.<nom du fichier> (vérifié avec une vraie AppImage : téléchargée,
    // copie installée, copie mise à jour) ; un autre type (autre AppImage, fuse nu) n'est pas notre AppImage
    if (!fuseMounts(mountinfo).some((m) => m.mountPoint === mount && m.fstype === `fuse.${basename(img)}`)) return null;
    const exe = realpath('/proc/self/exe');
    if (!exe.startsWith(mount.endsWith(sep) ? mount : mount + sep)) return null;
    if (!lstatSync(img).isFile()) return null;
    const realImg = realpath(img);
    if (hasControlChars(realImg) || realImg === mount || realImg.startsWith(mount.endsWith(sep) ? mount : mount + sep)) return null;
    const h = header(img);
    return h && isAppImageHeader(h) ? img : null;
  } catch {
    return null;
  }
}

/**
 * Test de bout en bout des mises à jour (`npm run test:update`) : version non empaquetée, lancée avec --update-feed-test et
 * un flux local (voir testFeedFromEnv). Seul cas où APPDIR est tenu pour un montage FUSE ; tous les autres contrôles de
 * realAppImage restent (binaire dessous, fichier ordinaire, en-tête AppImage). Empaquetée ou sans flux de test : rien.
 */
export function testFeedTrust(env: NodeJS.ProcessEnv, testFeed: string | null, isPackaged: boolean): RealAppImageDeps {
  const dir = env.APPDIR;
  if (isPackaged || !testFeed || !dir || !isAbsolute(dir)) return {};
  try {
    const real = realpathSync(dir);
    const mountinfo = readFileSync('/proc/self/mountinfo', 'utf8');
    const name = env.APPIMAGE ? basename(env.APPIMAGE).replace(/ /g, '\\040') : 'update-test';
    return { mountinfo: `${mountinfo}\n0 0 0:0 / ${real.replace(/ /g, '\\040')} ro - fuse.${name} ${name} ro\n` };
  } catch {
    return {};
  }
}
