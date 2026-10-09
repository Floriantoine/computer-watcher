import { describe, expect, test } from 'vitest';
import { createFreeOpener, hiddenPlacement, secondInstanceAction, startWindowShown, wantsFree, wantsHidden } from './launchArgs';

test('wantsFree : --free exact seulement', () => {
  expect(wantsFree(['/x/proc-watch', '--free'])).toBe(true);
  expect(wantsFree(['--freeze'])).toBe(false);
  expect(wantsFree([])).toBe(false);
});

test('createFreeOpener : envoi différé et protégé, demande gardée jusqu’à ce que le renderer la prenne', async () => {
  const sent: number[] = [];
  const o = createFreeOpener(() => {
    sent.push(1);
    throw new ReferenceError("Cannot access 'mainWin' before initialization");
  });
  expect(o.take()).toBe(false);
  expect(() => o.open()).not.toThrow();
  expect(sent).toHaveLength(0); // jamais synchrone (démarrage à froid)
  await Promise.resolve();
  expect(sent).toHaveLength(1);
  expect(o.take()).toBe(true);
  expect(o.take()).toBe(false);
});

describe('--hidden (démarrage avec la session)', () => {
  test('wantsHidden : --hidden exact seulement', () => {
    expect(wantsHidden(['/x/proc-watch', '--hidden'])).toBe(true);
    expect(wantsHidden(['/x/proc-watch', '--hiddenx'])).toBe(false);
    expect(wantsHidden(['/x/proc-watch'])).toBe(false);
  });
  test('placement : caché dans la barre des tâches si l’icône existe, sinon fenêtre réduite (jamais invisible sans moyen de la rouvrir)', () => {
    expect(hiddenPlacement(true)).toBe('tray');
    expect(hiddenPlacement(false)).toBe('minimized');
  });
  test('fenêtre créée sans être montrée seulement avec --hidden', () => {
    expect(startWindowShown(['/x', '--hidden'])).toBe(false);
    expect(startWindowShown(['/x'])).toBe(true);
    expect(startWindowShown(['/x', '--free'])).toBe(true);
  });
  test('second lancement : --free ouvre « Libérer », --hidden ne montre rien (session qui redémarre l’app déjà ouverte), sinon montrer', () => {
    expect(secondInstanceAction(['/x', '--free'])).toBe('free');
    expect(secondInstanceAction(['/x', '--hidden'])).toBe('ignore');
    expect(secondInstanceAction(['/x', '--hidden', '--free'])).toBe('free');
    expect(secondInstanceAction(['/x'])).toBe('show');
  });
});
