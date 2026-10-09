import { describe, expect, test } from 'vitest';
import { earlyoomPopupText, popupAfterSetup, settingsSetupAction } from './earlyoomPopup';

describe('earlyoomPopupText', () => {
  test('non installé : « Installer et configurer », « Plus tard », « Ne plus rappeler pendant 7 jours »', () => {
    const t = earlyoomPopupText('install');
    expect(t.title).toBe('⚠ Attention : earlyoom n’est pas installé');
    expect(t.primary).toBe('Installer et configurer');
    expect(t.later).toBe('Plus tard');
    expect(t.snooze).toBe('Ne plus rappeler pendant 7 jours');
    expect(t.body).toMatch(/geler/);
  });
  test('installé mais inactif : « Activer »', () => {
    const t = earlyoomPopupText('activate');
    expect(t.title).toBe('⚠ Attention : earlyoom n’est pas actif');
    expect(t.primary).toBe('Activer');
  });
});

describe('popupAfterSetup', () => {
  test('succès → fermé ; échec ou annulation → reste ouvert (réessayer ou fermer)', () => {
    expect(popupAfterSetup({ ok: true, line: 'x' })).toBe('close');
    expect(popupAfterSetup({ ok: false, reason: 'failed', message: 'x' })).toBe('keep');
    expect(popupAfterSetup({ ok: false, reason: 'cancelled', message: 'x' })).toBe('keep');
  });
  test('état changé entre-temps (déjà réglé ailleurs) → fermé', () => {
    expect(popupAfterSetup({ ok: false, reason: 'stale', message: 'L’état d’earlyoom a changé (rien à faire) : rien n’a été modifié.' })).toBe('close');
    expect(popupAfterSetup({ ok: false, reason: 'invalid', message: 'x' })).toBe('keep');
  });
});

describe('settingsSetupAction (bouton de Réglages › earlyoom)', () => {
  test('non installé → Installer et configurer', () => {
    expect(settingsSetupAction({ installed: false, active: 'unknown', enabled: 'unknown' })).toEqual({ mode: 'install', label: 'Installer et configurer (mot de passe)' });
  });
  test('installé inactif ou désactivé → Activer', () => {
    expect(settingsSetupAction({ installed: true, active: 'inactive', enabled: 'disabled' })).toEqual({ mode: 'activate', label: 'Activer (mot de passe)' });
    expect(settingsSetupAction({ installed: true, active: 'active', enabled: 'disabled' })?.mode).toBe('activate');
  });
  test('actif et activé → aucun bouton', () => {
    expect(settingsSetupAction({ installed: true, active: 'active', enabled: 'enabled' })).toBeNull();
  });
});
