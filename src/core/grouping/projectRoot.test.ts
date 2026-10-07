// src/core/grouping/projectRoot.test.ts
import { expect, test } from 'vitest';
import { findProjectRoot, projectLabel } from './projectRoot';

const fs = (paths: string[]) => (p: string) => paths.includes(p);

test('remonte jusqu\'au premier .git ou package.json', () => {
  const exists = fs(['/home/u/code/acme/.worktrees/feature-y/.git']);
  expect(findProjectRoot('/home/u/code/acme/.worktrees/feature-y/backend/src', exists)).toBe('/home/u/code/acme/.worktrees/feature-y');
});

test('package.json plus proche que .git → package.json gagne', () => {
  const exists = fs(['/repo/.git', '/repo/front/package.json']);
  expect(findProjectRoot('/repo/front', exists)).toBe('/repo/front');
});

test('aucun marqueur → null', () => {
  expect(findProjectRoot('/tmp/x', fs([]))).toBeNull();
});

test('libellé : deux derniers segments, segments cachés ignorés', () => {
  expect(projectLabel('/home/u/code/acme/.worktrees/feature-x', '/home/u')).toBe('acme / feature-x');
  expect(projectLabel('/home/u', '/home/u')).toBe('~');
  expect(projectLabel('/opt/app', '/home/u')).toBe('opt / app');
});
