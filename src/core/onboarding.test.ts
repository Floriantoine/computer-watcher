import { describe, expect, test } from 'vitest';
import {
  DELETE_CONSENT_TTL_MS, ONBOARDING_STEPS, onboardingSteps, takeDeleteConsent, parseOnboardingFile, serializeOnboarding, shouldOpenOnboarding, startIndex, wizardKey, stepPosition,
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

describe('consentement « supprimer le fichier téléchargé » (R1 : par onboarding.json, jamais par l’argv)', () => {
  const sha = 'b'.repeat(64);
  const consent = { path: '/home/u/dl/proc-watch-1.0.0-x86_64.AppImage', sha256: sha, ino: 42, expires: 1_000_000 };
  test('aller-retour dans le fichier d’état', () => {
    const f = { version: 1 as const, done: false, resume: 'autostart' as const, deleteOriginal: consent };
    expect(parseOnboardingFile(serializeOnboarding(f))).toEqual(f);
  });
  test.each([
    { ...consent, path: 'relatif' },
    { ...consent, sha256: 'abc' },
    { ...consent, ino: -1 },
    { ...consent, ino: 1.5 },
    { ...consent, expires: 'demain' },
  ])('consentement mal formé : ignoré (%o)', (bad) => {
    const parsed = parseOnboardingFile(JSON.stringify({ version: 1, done: false, deleteOriginal: bad }));
    expect(parsed).toEqual({ version: 1, done: false });
  });
  test('à usage unique : le fichier sans consentement est rendu pour réécriture immédiate', () => {
    const r = takeDeleteConsent({ version: 1, done: false, resume: 'autostart', deleteOriginal: consent }, 999_999);
    expect(r.consent).toEqual(consent);
    expect(r.rest).toEqual({ version: 1, done: false, resume: 'autostart' });
    expect(r.error).toBeNull();
  });
  test('expiré : refusé (et effacé quand même)', () => {
    const r = takeDeleteConsent({ version: 1, done: false, deleteOriginal: consent }, 1_000_001);
    expect(r.consent).toBeNull();
    expect(r.error).toMatch(/expiré/);
    expect(r.rest).toEqual({ version: 1, done: false });
  });
  test('aucun consentement : rien', () => {
    expect(takeDeleteConsent({ version: 1, done: true }, 0)).toEqual({ consent: null, error: null, rest: { version: 1, done: true } });
    expect(takeDeleteConsent(null, 0)).toEqual({ consent: null, error: null, rest: null });
  });
  test('durée de validité : quelques minutes', () => {
    expect(DELETE_CONSENT_TTL_MS).toBeGreaterThanOrEqual(60_000);
    expect(DELETE_CONSENT_TTL_MS).toBeLessThanOrEqual(10 * 60_000);
  });
});
