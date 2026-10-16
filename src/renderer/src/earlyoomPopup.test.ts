import { describe, expect, test } from 'vitest';
import { earlyoomPopupText, popupAfterSetup, settingsSetupAction, upgradeSummary } from './earlyoomPopup';

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
  test('état changé entre-temps → l’état est relu : le pop-up passe au nouveau mode, ou se ferme s’il n’y a plus rien à faire (M6)', () => {
    expect(popupAfterSetup({ ok: false, reason: 'stale', message: 'L’état d’earlyoom a changé (installé mais inactif) : rien n’a été modifié.' })).toBe('refresh');
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

describe('« Protection anti-gel à mettre à jour »', () => {
  const up = {
    oldDefaults: true, addedPrefer: ['MainThread', 'tsc', 'eslint'], memTerm: { from: 8, to: 10 },
    settings: { memTerm: 10, memKill: 5, swapTerm: 35, swapKill: 25, prefer: ['MainThread', 'tsc', 'eslint', 'vitest'] },
  };
  test('pop-up : titre, un seul bouton d’action, « Plus tard » et pause de 7 jours comme pour l’installation', () => {
    const t = earlyoomPopupText('upgrade', up);
    expect(t.title).toBe('Protection anti-gel à mettre à jour');
    expect(t.primary).toBe('Mettre à jour');
    expect(t.busy).toBe('Mise à jour…');
    expect(t.later).toBe('Plus tard');
    expect(t.snooze).toBe('Ne plus rappeler pendant 7 jours');
    expect(t.body).toContain('MainThread, tsc, eslint');
    expect(t.body).toContain('8 % → 10 %');
    expect(t.body).toMatch(/aucune exclusion retirée/i);
    expect(t.body).toMatch(/mot de passe/);
  });
  test('sans détail (état pas encore lu) : texte générique', () => {
    expect(earlyoomPopupText('upgrade').body).toMatch(/MainThread/);
  });
  test('libellés d’attente des autres modes inchangés', () => {
    expect(earlyoomPopupText('install').busy).toBe('Installation…');
    expect(earlyoomPopupText('activate').busy).toBe('Activation…');
  });
  test('upgradeSummary : une ligne par changement', () => {
    expect(upgradeSummary(up)).toEqual([
      'Tués en premier : MainThread, tsc, eslint (vos motifs restent).',
      'SIGTERM dès 10 % de mémoire disponible (8 % → 10 %) : earlyoom réagit avant le gel.',
      'Aucune exclusion retirée (terminaux, Claude, session, liste protégée) ; vos autres réglages restent.',
    ]);
  });
});
