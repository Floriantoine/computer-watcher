import { describe, expect, it } from 'vitest';
import {
  DESK_ROOT_DROPINS, DESK_ROOT_MAX_MB, DESK_ROOT_MIN_MB, deskRootContent, deskRootLevels, deskRootPaths, deskRootStatus, deskRootTargetMB, parseDeskRootFile,
} from './deskRoot';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

describe('deskRootTargetMB', () => {
  it('réserve arrondie au Mo supérieur', () => {
    expect(deskRootTargetMB(4884652 * 1024, 32564348 * 1024)).toBe(4771);
    expect(deskRootTargetMB(4 * GiB, 32 * GiB)).toBe(4096);
  });
  it('bornée à la moitié de la RAM, et au minimum', () => {
    expect(deskRootTargetMB(20 * GiB, 32 * GiB)).toBe(16384);
    expect(deskRootTargetMB(10 * MiB, 32 * GiB)).toBe(DESK_ROOT_MIN_MB);
  });
  it('inconnue : null', () => {
    expect(deskRootTargetMB(null, 32 * GiB)).toBeNull();
    expect(deskRootTargetMB(4 * GiB, 0)).toBeNull();
    expect(deskRootTargetMB(Number.NaN, 32 * GiB)).toBeNull();
    // RAM trop petite pour la borne minimale
    expect(deskRootTargetMB(4 * GiB, 300 * MiB)).toBeNull();
  });
  it('jamais au-delà de la borne du script', () => {
    expect(deskRootTargetMB(4 * 1024 * 1024 * GiB, 8 * 1024 * 1024 * GiB)).toBe(DESK_ROOT_MAX_MB);
  });
});

describe('contenu des drop-ins', () => {
  it('trois niveaux : user.slice, user-<uid>.slice, user@<uid>.service', () => {
    expect(DESK_ROOT_DROPINS.map((d) => [d.dir, d.section])).toEqual([
      ['user.slice.d', 'Slice'], ['user-.slice.d', 'Slice'], ['user@.service.d', 'Service'],
    ]);
    expect(deskRootPaths('/etc/systemd/system')).toEqual([
      '/etc/systemd/system/user.slice.d/computer-watcher-desk.conf',
      '/etc/systemd/system/user-.slice.d/computer-watcher-desk.conf',
      '/etc/systemd/system/user@.service.d/computer-watcher-desk.conf',
    ]);
  });
  it('contenu exact et relecture', () => {
    const c = deskRootContent('Service', 4771);
    expect(c).toMatch(/^# Computer Watcher : /);
    expect(c.endsWith('[Service]\nMemoryLow=4771M\n')).toBe(true);
    expect(parseDeskRootFile(c, 'Service')).toBe(4771);
    expect(parseDeskRootFile(c, 'Slice')).toBeNull();
    expect(parseDeskRootFile(c.replace('4771M', '4771G'), 'Service')).toBeNull();
    expect(parseDeskRootFile(`${c}MemoryMin=1G\n`, 'Service')).toBeNull();
    expect(parseDeskRootFile(null, 'Service')).toBeNull();
  });
  it('valeur hors bornes refusée', () => {
    expect(() => deskRootContent('Slice', DESK_ROOT_MIN_MB - 1)).toThrow();
    expect(() => deskRootContent('Slice', 1.5)).toThrow();
    expect(() => deskRootContent('Slice', DESK_ROOT_MAX_MB + 1)).toThrow();
  });
});

describe('deskRootLevels', () => {
  it('chaîne des cgroups système au-dessus de la session', () => {
    expect(deskRootLevels(1000)).toEqual([
      { unit: 'user.slice', cgroup: '/user.slice' },
      { unit: 'user-1000.slice', cgroup: '/user.slice/user-1000.slice' },
      { unit: 'user@1000.service', cgroup: '/user.slice/user-1000.slice/user@1000.service' },
    ]);
    expect(() => deskRootLevels(-1)).toThrow();
  });
});

describe('deskRootStatus', () => {
  const files = (mb: number | null) => DESK_ROOT_DROPINS.map((d) => (mb === null ? null : deskRootContent(d.section, mb)));
  const lows = (v: number | null) => [v, v, v];
  it('absent, sans effet', () => {
    const s = deskRootStatus({ files: files(null), lows: lows(0), targetMB: 4771, uid: 1000, recursiveprot: true });
    expect(s).toMatchObject({ files: 'absent', installedMB: null, targetMB: 4771, effective: false, recursiveprot: true });
    expect(s.levels.map((l) => l.unit)).toEqual(['user.slice', 'user-1000.slice', 'user@1000.service']);
  });
  it('installé et effectif', () => {
    const s = deskRootStatus({ files: files(4771), lows: lows(4771 * MiB), targetMB: 4771, uid: 1000, recursiveprot: true });
    expect(s).toMatchObject({ files: 'installed', installedMB: 4771, effective: true });
  });
  it('installé, pas encore effectif (un niveau à 0 ou illisible)', () => {
    expect(deskRootStatus({ files: files(4771), lows: [4771 * MiB, 0, 4771 * MiB], targetMB: 4771, uid: 1000, recursiveprot: true }).effective).toBe(false);
    expect(deskRootStatus({ files: files(4771), lows: [null, 1, 1], targetMB: 4771, uid: 1000, recursiveprot: true }).effective).toBe(false);
  });
  it('obsolète : réserve changée, fichier partiel ou modifié à la main', () => {
    expect(deskRootStatus({ files: files(4096), lows: lows(1), targetMB: 4771, uid: 1000, recursiveprot: true })).toMatchObject({ files: 'obsolete', installedMB: 4096 });
    const partial = files(4771);
    partial[1] = null;
    expect(deskRootStatus({ files: partial, lows: lows(0), targetMB: 4771, uid: 1000, recursiveprot: true })).toMatchObject({ files: 'obsolete', installedMB: null });
    const edited = files(4771);
    edited[2] = '[Service]\nMemoryLow=1G\n';
    expect(deskRootStatus({ files: edited, lows: lows(0), targetMB: 4771, uid: 1000, recursiveprot: true }).files).toBe('obsolete');
  });
  it('réserve inconnue : installé reste installé', () => {
    expect(deskRootStatus({ files: files(4771), lows: lows(1), targetMB: null, uid: 1000, recursiveprot: true }).files).toBe('installed');
  });
});
