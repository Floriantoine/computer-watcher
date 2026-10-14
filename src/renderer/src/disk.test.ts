import { describe, expect, test } from 'vitest';
import type { FamilyMeasure } from '../../core/disk/families';
import type { SunNode } from '../../core/disk/sunTree';
import type { ExtrasView } from '../../core/disk/extras';
import {
  arcPath, badgeText, breadcrumb, cleanRequest, emptyExtraSelection, extraCount, extraPaths, extrasTotal, familyOfPath, freedToast, highlighted, inactiveText, measuredAt,
  createLatest, dockerActionEmpty, pruneExtras, refusalText, selectedTotal, sunColors, toggleExtra,
} from './disk';

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

test('revue n-3 : libellé du bouton pendant la mesure des tailles', async () => {
  const { freeButtonLabel } = await import('./disk');
  expect(freeButtonLabel(0, 0, null)).toBe('Libérer…');
  expect(freeButtonLabel(2, 3 * 1024, null)).toBe('Libérer ≈ 3 Mo…');
  expect(freeButtonLabel(2, 3 * 1024, 'measuring')).toBe('Mesure des tailles…');
  expect(freeButtonLabel(2, 3 * 1024, 'confirming')).toBe('Confirmation…');
  expect(freeButtonLabel(2, 3 * 1024, 'cleaning')).toBe('Suppression…');
});

const X: ExtrasView = {
  at: 0, days: 30, home: H,
  projectRoots: { roots: [`${H}/code`], isDefault: true, missing: [] },
  nodeModules: [{ path: `${H}/code/vieux/node_modules`, projectDir: `${H}/code/vieux`, label: 'code / vieux', sizeKB: 2048, lastSeen: null, partialHistory: true }],
  worktrees: [
    { path: `${H}/code/depot/.worktrees/fini`, repo: `${H}/code/depot`, branch: 'fini', head: 'a', label: 'depot › fini', sizeKB: 1024, refusal: null },
    { path: `${H}/code/depot/.worktrees/secret`, repo: `${H}/code/depot`, branch: 'secret', head: 'b', label: 'depot › secret', sizeKB: 10, refusal: 'fichiers ignorés qui seraient perdus : .env' },
  ],
  projectErrors: [], truncated: false, gitMissing: false,
  cacheDirs: { dirs: [{ name: 'outil-inconnu', path: `${H}/.cache/outil-inconnu`, sizeKB: 512, refusal: null }], refusal: null },
  docker: { version: '27.1.1', actions: [{ id: 'images', reclaimKB: 300, items: ['demo/old:0.9 (300MB)'] }, { id: 'containers', reclaimKB: null, items: [] }, { id: 'volumes', reclaimKB: 60, items: [] }] },
};

test('sélection du lot 2 : bascule, total, requête, élagage, chemins à surligner', () => {
  let s = emptyExtraSelection();
  s = toggleExtra(s, 'nodeModules', `${H}/code/vieux/node_modules`);
  s = toggleExtra(s, 'worktrees', `${H}/code/depot/.worktrees/fini`);
  s = toggleExtra(s, 'cacheDirs', 'outil-inconnu');
  s = toggleExtra(s, 'docker', 'images');
  expect(extraCount(s)).toBe(4);
  expect(extrasTotal(s, X)).toBe(2048 + 1024 + 512 + 300);
  expect(cleanRequest(new Set(['npm']), s)).toEqual({
    families: ['npm'], nodeModules: [`${H}/code/vieux/node_modules`], worktrees: [`${H}/code/depot/.worktrees/fini`], cacheDirs: ['outil-inconnu'], docker: ['images'],
  });
  expect(extraPaths(s, X).sort()).toEqual([`${H}/.cache/outil-inconnu`, `${H}/code/depot/.worktrees/fini`, `${H}/code/vieux/node_modules`]);
  expect(extraCount(toggleExtra(s, 'docker', 'images'))).toBe(3);
  // élément refusé ou disparu de la nouvelle analyse : décoché
  const s2 = toggleExtra(toggleExtra(s, 'worktrees', `${H}/code/depot/.worktrees/secret`), 'cacheDirs', 'parti');
  const p = pruneExtras(s2, X);
  expect([...p.worktrees]).toEqual([`${H}/code/depot/.worktrees/fini`]);
  expect([...p.cacheDirs]).toEqual(['outil-inconnu']);
  expect(extraCount(pruneExtras(s, null))).toBe(0);
});

test('texte d’inactivité ; toast avec éléments du lot 2 (libellé, note de branche gardée)', () => {
  const now = 100 * 86_400_000;
  expect(inactiveText(X.nodeModules[0], 30, now)).toBe('aucun processus vu, aucun fichier modifié depuis 30 j (historique partiel)');
  expect(inactiveText({ ...X.nodeModules[0], lastSeen: now - 45 * 86_400_000, partialHistory: false }, 30, now)).toBe('dernier processus il y a 45 j, aucun fichier modifié depuis 30 j');
  expect(freedToast({
    freedKB: 2048, done: ['worktree:/p/fini'], refused: [{ id: 'cache:x', label: '~/.cache/x (inconnu)', reason: 'utilisé par x (pid 3)' }],
    notes: [{ label: 'worktree depot › fini', note: 'worktree supprimé ; branche fini gardée : non fusionnée' }], cancelled: false,
  })).toEqual({ text: '2 Mo libérés · refusé : ~/.cache/x (inconnu) : utilisé par x (pid 3) · worktree supprimé ; branche fini gardée : non fusionnée', kind: 'info' });
});

test('Docker : action sans rien à retirer non cochable, élaguée', () => {
  expect(dockerActionEmpty({ id: 'containers', reclaimKB: null, items: [] })).toBe(true);
  expect(dockerActionEmpty({ id: 'containers', reclaimKB: 0, items: [] })).toBe(true);
  expect(dockerActionEmpty({ id: 'volumes', reclaimKB: 60, items: [] })).toBe(false);
  expect(dockerActionEmpty({ id: 'images', reclaimKB: 0, items: ['demo/x'] })).toBe(false);
  const s = toggleExtra(toggleExtra(emptyExtraSelection(), 'docker', 'containers'), 'docker', 'volumes');
  expect([...pruneExtras(s, X).docker]).toEqual(['volumes']);
});

test('réponses dans le désordre : seule la dernière requête compte', () => {
  const latest = createLatest();
  const a = latest.next();
  const b = latest.next();
  expect(latest.isLatest(a)).toBe(false);
  expect(latest.isLatest(b)).toBe(true);
});
