import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { isAppImageHeader, fuseMountPoints, fuseMounts, realAppImage, testFeedTrust } from './realAppImage';

const cache = join(homedir(), '.cache');
mkdirSync(cache, { recursive: true });
const base = mkdtempSync(join(cache, 'pw-onboard-test-ai-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** En-tête d'une AppImage de type 2 : ELF, puis « AI\x02 » à l'octet 8. */
const HEADER = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02]), Buffer.alloc(53)]);
const MOUNT = '/tmp/.mount_proc-wAbC12';
const fuseLine = (mp: string, type = 'fuse.proc-watch-1.0.0-x86_64.AppImage') =>
  `812 30 0:91 / ${mp.replace(/ /g, '\\040')} ro,nosuid,nodev,relatime shared:451 - ${type} proc-watch.AppImage ro,user_id=1000,group_id=1000`;
const OTHER = '25 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw';

let n = 0;
let img: string;
beforeEach(() => {
  const d = join(base, `c${++n}`);
  mkdirSync(d, { recursive: true });
  img = join(d, 'proc-watch-1.0.0-x86_64.AppImage');
  writeFileSync(img, HEADER);
});

const ok = () => ({
  env: { APPIMAGE: img, APPDIR: MOUNT },
  deps: { mountinfo: `${OTHER}\n${fuseLine(MOUNT)}\n`, realpath: (p: string) => (p === '/proc/self/exe' ? `${MOUNT}/proc-watch` : p) },
});

describe('realAppImage : vraie AppImage seulement', () => {
  test('montage FUSE, /proc/self/exe dessous, fichier ordinaire avec l’en-tête AppImage : accepté', () => {
    const { env, deps } = ok();
    expect(realAppImage(env, deps)).toBe(img);
  });

  test('reproduction I2 : APPDIR = dossier du binaire (pas un montage), APPIMAGE = un document → refusé', () => {
    const doc = join(base, `thesis-${n}.pdf`);
    writeFileSync(doc, 'MY THESIS');
    const dist = join(base, 'electron-dist');
    expect(realAppImage({ APPIMAGE: doc, APPDIR: dist }, { mountinfo: OTHER, realpath: (p) => (p === '/proc/self/exe' ? `${dist}/electron` : p) })).toBeNull();
  });

  test('R4 : type de montage différent de fuse.<basename(APPIMAGE)> (autre AppImage, fuse nu) : refusé', () => {
    const { env, deps } = ok();
    expect(realAppImage(env, { ...deps, mountinfo: fuseLine(MOUNT, 'fuse.Editeur-1.2.3.AppImage') })).toBeNull();
    expect(realAppImage(env, { ...deps, mountinfo: fuseLine(MOUNT, 'fuse') })).toBeNull();
    expect(realAppImage(env, { ...deps, mountinfo: fuseLine(MOUNT, 'fuse.proc-watch-1.0.0-x86_64.AppImage') })).toBe(img);
  });
  test('fuseMounts : point de montage et type', () => {
    expect(fuseMounts(fuseLine('/tmp/.mount a', 'fuse.x.AppImage'))).toEqual([{ mountPoint: '/tmp/.mount a', fstype: 'fuse.x.AppImage' }]);
  });

  test('APPDIR monté mais pas en FUSE : refusé', () => {
    const { env, deps } = ok();
    expect(realAppImage(env, { ...deps, mountinfo: fuseLine(MOUNT, 'ext4') })).toBeNull();
  });

  test('binaire en cours hors du montage (ou préfixe trompeur) : refusé', () => {
    const { env, deps } = ok();
    expect(realAppImage(env, { ...deps, realpath: (p) => (p === '/proc/self/exe' ? '/usr/lib/electron/electron' : p) })).toBeNull();
    expect(realAppImage(env, { ...deps, realpath: (p) => (p === '/proc/self/exe' ? `${MOUNT}-evil/proc-watch` : p) })).toBeNull();
  });

  test('APPIMAGE lien symbolique, absent, relatif ou sans en-tête AppImage : refusé', () => {
    const { deps } = ok();
    const link = `${img}.lien`;
    symlinkSync(img, link);
    expect(realAppImage({ APPIMAGE: link, APPDIR: MOUNT }, deps)).toBeNull();
    expect(realAppImage({ APPIMAGE: `${img}.absent`, APPDIR: MOUNT }, deps)).toBeNull();
    expect(realAppImage({ APPIMAGE: 'x.AppImage', APPDIR: MOUNT }, deps)).toBeNull();
    const elf = `${img}.elf`;
    writeFileSync(elf, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(56)]));
    expect(realAppImage({ APPIMAGE: elf, APPDIR: MOUNT }, deps)).toBeNull();
  });

  test('APPIMAGE avec caractère de contrôle, ou à l’intérieur du montage : refusé', () => {
    const { deps } = ok();
    const bad = `${img}\nExecStartPre=x`;
    writeFileSync(bad, HEADER);
    expect(realAppImage({ APPIMAGE: bad, APPDIR: MOUNT }, deps)).toBeNull();
    const inMount = { ...deps, realpath: (p: string) => (p === '/proc/self/exe' ? `${MOUNT}/proc-watch` : p === img ? `${MOUNT}/usr/x` : p) };
    expect(realAppImage({ APPIMAGE: img, APPDIR: MOUNT }, inMount)).toBeNull();
  });

  test('variables absentes : null', () => {
    const { deps } = ok();
    expect(realAppImage({ APPDIR: MOUNT }, deps)).toBeNull();
    expect(realAppImage({ APPIMAGE: img }, deps)).toBeNull();
  });

  test('points de montage FUSE lus dans mountinfo (espaces échappés)', () => {
    expect(fuseMountPoints(`${OTHER}\n${fuseLine('/tmp/.mount a')}\n${fuseLine('/x', 'fuse')}\n`)).toEqual(['/tmp/.mount a', '/x']);
  });

  test('en-tête : ELF + AI\\x02 à l’octet 8', () => {
    expect(isAppImageHeader(HEADER)).toBe(true);
    expect(isAppImageHeader(Buffer.from('%PDF-1.7 AI\x02'))).toBe(false);
    expect(isAppImageHeader(Buffer.alloc(4))).toBe(false);
  });
});

describe('flux de test des mises à jour (sources seulement, option --update-feed-test)', () => {
  test('seul cas où APPDIR est tenu pour un montage : non empaqueté ET flux de test actif ; le reste des contrôles demeure', () => {
    const dir = join(base, 'fake-appdir');
    mkdirSync(dir, { recursive: true });
    expect(testFeedTrust({ APPDIR: dir }, null, false)).toEqual({});
    expect(testFeedTrust({ APPDIR: dir }, 'http://127.0.0.1:9/', true)).toEqual({});
    const deps = testFeedTrust({ APPDIR: dir, APPIMAGE: img }, 'http://127.0.0.1:9/', false);
    expect(fuseMountPoints(deps.mountinfo!)).toContain(dir);
    // binaire hors d'APPDIR (environnement hérité) : toujours refusé
    expect(realAppImage({ APPIMAGE: img, APPDIR: dir }, { ...deps, realpath: (p) => (p === '/proc/self/exe' ? '/usr/bin/x' : p) })).toBeNull();
    // fichier sans en-tête AppImage : toujours refusé
    const doc = join(base, `doc-${n}.pdf`);
    writeFileSync(doc, 'PDF');
    expect(realAppImage({ APPIMAGE: doc, APPDIR: dir }, { ...deps, realpath: (p) => (p === '/proc/self/exe' ? `${dir}/electron` : p) })).toBeNull();
    expect(realAppImage({ APPIMAGE: img, APPDIR: dir }, { ...deps, realpath: (p) => (p === '/proc/self/exe' ? `${dir}/electron` : p) })).toBe(img);
  });
});
