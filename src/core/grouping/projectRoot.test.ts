// src/core/grouping/projectRoot.test.ts
import { expect, test } from 'vitest';
import { findProjectRoot, projectLabel } from './projectRoot';

const fs = (paths: string[]) => (p: string) => paths.includes(p);

test('remonte jusqu\'au premier .git ou package.json', () => {
  const exists = fs(['/home/u/code/acme/.worktrees/feature-y/.git']);
  expect(findProjectRoot('/home/u/code/acme/.worktrees/feature-y/backend/src', exists)).toBe('/home/u/code/acme/.worktrees/feature-y');
});

test('.git au-dessus d\'un package.json → la racine git gagne (front et backend regroupés)', () => {
  const exists = fs(['/repo/.git', '/repo/front/package.json', '/repo/backend/package.json']);
  expect(findProjectRoot('/repo/front', exists)).toBe('/repo');
  expect(findProjectRoot('/repo/backend/src', exists)).toBe('/repo');
});

test('worktree (.git fichier) avec sous-paquets → la racine du worktree', () => {
  const root = '/home/u/code/acme/.worktrees/feature-x';
  const exists = fs([`${root}/.git`, `${root}/package.json`, `${root}/front/package.json`]);
  expect(findProjectRoot(`${root}/front/src`, exists, '/home/u')).toBe(root);
});

test('sans .git → le package.json le plus proche', () => {
  const exists = fs(['/srv/mono/package.json', '/srv/mono/apps/web/package.json']);
  expect(findProjectRoot('/srv/mono/apps/web/src', exists)).toBe('/srv/mono/apps/web');
});

test('un .git dans le dossier home ne regroupe pas ses sous-dossiers', () => {
  const exists = fs(['/home/u/.git', '/home/u/code/app/package.json']);
  expect(findProjectRoot('/home/u/code/app', exists, '/home/u')).toBe('/home/u/code/app');
  expect(findProjectRoot('/home/u/notes', exists, '/home/u')).toBeNull();
});

test('le dossier home lui-même garde ses marqueurs', () => {
  expect(findProjectRoot('/home/u', fs(['/home/u/.git']), '/home/u')).toBe('/home/u');
});

test('aucun marqueur → null', () => {
  expect(findProjectRoot('/tmp/x', fs([]))).toBeNull();
});

test('libellé : deux derniers segments, segments cachés ignorés', () => {
  expect(projectLabel('/home/u/code/acme/.worktrees/feature-x', '/home/u')).toBe('acme / feature-x');
  expect(projectLabel('/home/u', '/home/u')).toBe('~');
  expect(projectLabel('/opt/app', '/home/u')).toBe('opt / app');
});
