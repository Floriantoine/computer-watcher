import { describe, expect, test } from 'vitest';
import {
  ONBOARDING_STEPS, onboardingSteps, parseOnboardingFile, serializeOnboarding, shouldOpenOnboarding, startIndex, wizardKey, stepPosition,
} from './onboarding';

describe('étapes', () => {
  test('AppImage : 4 étapes, installation d’abord', () => {
    expect(onboardingSteps(true)).toEqual(['install', 'autostart', 'history', 'earlyoom']);
  });
  test('.deb ou dev : 3 étapes, sans installation', () => {
    expect(onboardingSteps(false)).toEqual(['autostart', 'history', 'earlyoom']);
  });
  test('titres en français pour chaque étape', () => {
    for (const s of onboardingSteps(true)) expect(ONBOARDING_STEPS[s].title).toMatch(/\S/);
  });
  test('position lisible « Étape 2 sur 4 »', () => {
    expect(stepPosition(1, 4)).toBe('Étape 2 sur 4');
  });
});

describe('fichier d’état', () => {
  test('aller-retour', () => {
    const s = { version: 1 as const, done: false, resume: 'autostart' as const };
    expect(parseOnboardingFile(serializeOnboarding(s))).toEqual(s);
  });
  test.each([null, '', '{', '[]', '{"version":2,"done":true}', '{"version":1}', '{"version":1,"done":"oui"}'])('illisible → null : %s', (t) => {
    expect(parseOnboardingFile(t)).toBeNull();
  });
  test('étape de reprise inconnue : ignorée', () => {
    expect(parseOnboardingFile('{"version":1,"done":false,"resume":"rm -rf"}')).toEqual({ version: 1, done: false });
  });
});

describe('ouverture au lancement', () => {
  test('premier lancement (config créée maintenant) sans fichier : ouvert', () => {
    expect(shouldOpenOnboarding({ file: null, freshConfig: true })).toBe(true);
  });
  test('config existante sans fichier (mise à jour d’une ancienne version) : jamais', () => {
    expect(shouldOpenOnboarding({ file: null, freshConfig: false })).toBe(false);
  });
  test('terminé ou passé : ne revient plus', () => {
    expect(shouldOpenOnboarding({ file: { version: 1, done: true }, freshConfig: true })).toBe(false);
  });
  test('relancé depuis la copie en cours d’accueil : reprend', () => {
    expect(shouldOpenOnboarding({ file: { version: 1, done: false, resume: 'autostart' }, freshConfig: false })).toBe(true);
  });
});

describe('étape de départ', () => {
  test('reprise sur une étape présente', () => {
    expect(startIndex(onboardingSteps(true), 'autostart')).toBe(1);
  });
  test('reprise absente ou hors liste : première étape', () => {
    expect(startIndex(onboardingSteps(false), 'install')).toBe(0);
    expect(startIndex(onboardingSteps(true), undefined)).toBe(0);
  });
});

describe('clavier', () => {
  test('Échap : passer', () => {
    expect(wizardKey('Escape', 0, 4)).toEqual({ kind: 'skip' });
  });
  test('Alt+flèches : précédent / suivant, bornés', () => {
    expect(wizardKey('ArrowRight', 0, 4, true)).toEqual({ kind: 'go', index: 1 });
    expect(wizardKey('ArrowLeft', 0, 4, true)).toBeNull();
    expect(wizardKey('ArrowRight', 3, 4, true)).toBeNull();
    expect(wizardKey('ArrowLeft', 2, 4, true)).toEqual({ kind: 'go', index: 1 });
  });
  test('flèches sans Alt (champs, cases) : rien', () => {
    expect(wizardKey('ArrowRight', 0, 4)).toBeNull();
    expect(wizardKey('a', 0, 4)).toBeNull();
  });
});
