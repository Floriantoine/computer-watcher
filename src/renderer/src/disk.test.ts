import { describe, expect, test } from 'vitest';
import type { FamilyMeasure } from '../../core/disk/families';
import type { SunNode } from '../../core/disk/sunTree';
import { arcPath, badgeText, breadcrumb, familyOfPath, freedToast, highlighted, measuredAt, refusalText, selectedTotal, sunColors } from './disk';

const H = '/home/u';
const paths = {
  npm: [`${H}/.npm/_cacache`],
  uv: [`${H}/.cache/uv`],
  'test-browsers': [`${H}/.cache/ms-playwright`, `${H}/.cache/puppeteer`],
};
const m = (id: FamilyMeasure['id'], reclaimKB: number | null): FamilyMeasure => ({ id, sizeKB: reclaimKB, reclaimKB, at: 0 });

test('total sélectionné : somme des « libère », tailles inconnues ignorées', () => {
  const measures = [m('npm', 1000), m('uv', 500), m('journal', null)];
  expect(selectedTotal(measures, new Set(['npm', 'uv']))).toBe(1500);
  expect(selectedTotal(measures, new Set(['npm', 'journal']))).toBe(1000);
  expect(selectedTotal(measures, new Set())).toBe(0);
});

test('chemin d’un segment → famille (dedans ou égal), sinon null ; jamais un dossier parent', () => {
  expect(familyOfPath(`${H}/.npm/_cacache`, paths)).toBe('npm');
  expect(familyOfPath(`${H}/.npm/_cacache/content-v2`, paths)).toBe('npm');
  expect(familyOfPath(`${H}/.cache/ms-playwright/chromium-1140`, paths)).toBe('test-browsers');
  expect(familyOfPath(`${H}/.cache`, paths)).toBeNull();
  expect(familyOfPath(`${H}/.cache/uvx`, paths)).toBeNull();
  expect(familyOfPath(`${H}/.npm`, paths)).toBeNull();
});

test('familles cochées → segments à surligner', () => {
  const h = highlighted(new Set(['uv']), paths);
  expect(h(`${H}/.cache/uv`)).toBe(true);
  expect(h(`${H}/.cache/uv/wheels`)).toBe(true);
  expect(h(`${H}/.npm/_cacache`)).toBe(false);
  expect(h(`${H}/.cache`)).toBe(false);
});

test('fil d’Ariane depuis la racine : « ~ » puis chaque dossier', () => {
  expect(breadcrumb(H, `${H}/.cache/uv`)).toEqual([
    { label: '~', path: H }, { label: '.cache', path: `${H}/.cache` }, { label: 'uv', path: `${H}/.cache/uv` },
  ]);
  expect(breadcrumb(H, H)).toEqual([{ label: '~', path: H }]);
  expect(breadcrumb(H, '/ailleurs')).toEqual([{ label: '~', path: H }]);
});

test('textes : refus, badge, heure de mesure, toast', () => {
  expect(refusalText('uv', 'lien symbolique, refusé')).toBe('Cache uv : lien symbolique, refusé');
  expect(badgeText('rebuild')).toBe('se reconstruit');
  expect(badgeText('root')).toBe('root');
  expect(badgeText('keep-latest')).toBe('garde la plus récente');
  const now = new Date(2026, 9, 9, 14, 30).getTime();
  expect(measuredAt(new Date(2026, 9, 9, 9, 5).getTime(), now)).toBe('mesuré à 09:05');
  expect(measuredAt(new Date(2026, 9, 8, 9, 5).getTime(), now)).toBe('mesuré le 08/10 à 09:05');
  expect(freedToast({ freedKB: 3 * 1024 * 1024, done: ['npm', 'uv'], refused: [], cancelled: false })).toEqual({ text: '3,0 Go libérés', kind: 'info' });
  expect(freedToast({ freedKB: 2048, done: ['npm'], refused: [{ id: 'uv', reason: 'utilisé par uv (pid 3)' }], cancelled: false })).toEqual({
    text: '2 Mo libérés · refusé : Cache uv : utilisé par uv (pid 3)', kind: 'info',
  });
  expect(freedToast({ freedKB: 0, done: [], refused: [{ id: 'uv', reason: 'x' }], cancelled: false })).toEqual({ text: 'Rien libéré · refusé : Cache uv : x', kind: 'error' });
  expect(freedToast({ freedKB: 0, done: [], refused: [], cancelled: true })).toBeNull();
  // place pas encore visible (btrfs : quelques secondes) : l'estimation, annoncée comme telle
  expect(freedToast({ freedKB: 0, estimatedKB: 5 * 1024, done: ['npm'], refused: [], cancelled: false })).toEqual({ text: '≈ 5 Mo libérés (estimation)', kind: 'info' });
  expect(freedToast({ freedKB: 4 * 1024, estimatedKB: 5 * 1024, done: ['npm'], refused: [], cancelled: false })).toEqual({ text: '4 Mo libérés', kind: 'info' });
});

test('couleurs : une teinte par dossier de premier niveau, gardée en profondeur ; « autres » gris', () => {
  const tree: SunNode = {
    name: 'u', path: H, sizeKB: 30, children: [
      { name: 'a', path: `${H}/a`, sizeKB: 20, children: [{ name: 'x', path: `${H}/a/x`, sizeKB: 20, children: [] }] },
      { name: 'b', path: `${H}/b`, sizeKB: 9, children: [] },
      { name: 'autres', path: `${H}/\u0000autres`, sizeKB: 1, children: [], other: true },
    ],
  };
  const c = sunColors(tree);
  expect(c(`${H}/a`)).toBe(c(`${H}/a/x`));
  expect(c(`${H}/a`)).not.toBe(c(`${H}/b`));
  expect(c(`${H}/\u0000autres`)).toBe('#3a3d52');
});

describe('arcPath (SVG)', () => {
  test('anneau : deux arcs et deux segments, fermé', () => {
    const d = arcPath(150, 150, 40, 85, 0, 90);
    expect(d).toMatch(/^M[\d.]+,[\d.]+ A85,85 0 0 1 [\d.]+,[\d.]+ L[\d.]+,[\d.]+ A40,40 0 0 0 [\d.]+,[\d.]+ Z$/);
    expect(d.startsWith('M150.0,65.0')).toBe(true); // 0° en haut
  });
  test('cercle complet (360°) : dessiné en deux moitiés (un arc SVG de 360° est vide)', () => {
    expect(arcPath(150, 150, 40, 85, 0, 360).match(/A85/g)).toHaveLength(2);
  });
  test('grand arc : drapeau large', () => {
    expect(arcPath(150, 150, 40, 85, 0, 200)).toContain('A85,85 0 1 1');
  });
});
