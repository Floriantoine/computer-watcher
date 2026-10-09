import { describe, expect, test } from 'vitest';
import { DEFAULT_UPDATE_PREFS, initialUpdateState, type UpdateState, type UpdateView } from '../../core/update';
import { aboutLines, updatePopupText } from './updatePopup';

const view = (s: Partial<UpdateState>, mode: UpdateState['mode'] = 'install'): UpdateView => ({
  state: {
    ...initialUpdateState(mode, '0.1.0'),
    phase: 'available',
    available: { version: '0.1.1', notes: 'Corrections diverses', url: 'https://github.com/Floriantoine/proc-watcher/releases/tag/v0.1.1' },
    ...s,
  },
  prefs: DEFAULT_UPDATE_PREFS,
  popup: true,
});

describe('updatePopupText', () => {
  test('AppImage : « Mise à jour X.Y.Z disponible », notes, Mettre à jour / Plus tard / Ignorer cette version', () => {
    const t = updatePopupText(view({}));
    expect(t.title).toBe('Mise à jour 0.1.1 disponible');
    expect(t.body).toBe('Corrections diverses');
    expect(t.actions.map((a) => [a.kind, a.label])).toEqual([
      ['download', 'Mettre à jour'],
      ['later', 'Plus tard'],
      ['ignore', 'Ignorer cette version'],
    ]);
  });
  test('.deb : notification et lien vers la page de la version, jamais d’installation', () => {
    const t = updatePopupText(view({}, 'notify'));
    expect(t.body).toContain('Corrections diverses');
    expect(t.body).toContain('une mise à jour est disponible');
    expect(t.actions.map((a) => a.kind)).toEqual(['open', 'later', 'ignore']);
  });
  test('sans notes : texte par défaut', () => {
    expect(updatePopupText(view({ available: { version: '0.1.1', notes: '', url: 'x' } })).body).toBe('Nouvelle version de proc-watch.');
  });
  test('téléchargement : progression arrondie, aucune action', () => {
    const t = updatePopupText(view({ phase: 'downloading', progress: 41.6 }));
    expect(t.body).toBe('Téléchargement… 42 %');
    expect(t.progress).toBe(41.6);
    expect(t.actions).toEqual([]);
  });
  test('prête : explique le redémarrage, « Redémarrer et installer » / « Plus tard »', () => {
    const t = updatePopupText(view({ phase: 'ready', progress: 100 }));
    expect(t.body).toContain('redémarrer');
    expect(t.body).toContain('vérifiée');
    expect(t.actions.map((a) => [a.kind, a.label])).toEqual([
      ['install', 'Redémarrer et installer'],
      ['later', 'Plus tard'],
    ]);
  });
  test('échec du téléchargement : message et « Réessayer »', () => {
    const t = updatePopupText(view({ phase: 'error', error: 'sha512 checksum mismatch' }));
    expect(t.body).toContain('sha512 checksum mismatch');
    expect(t.actions.map((a) => a.kind)).toEqual(['download', 'later']);
    expect(t.actions[0].label).toBe('Réessayer');
  });
});

describe('aboutLines', () => {
  test('mode, dernière vérification et résultat', () => {
    const fmt = (ms: number) => `t${ms}`;
    expect(aboutLines(view({ phase: 'idle', available: null }, 'off').state, fmt)).toEqual({
      mode: 'Lancée depuis les sources : aucune vérification des mises à jour.',
      last: 'Jamais vérifié',
    });
    expect(aboutLines(view({ phase: 'idle', available: null, lastCheck: 5, lastResult: 'none' }).state, fmt).last).toBe('Dernière vérification : t5 — à jour');
    expect(aboutLines(view({ lastCheck: 5, lastResult: 'available' }, 'notify').state, fmt)).toEqual({
      mode: 'Paquet (.deb) : notification seulement, la mise à jour se télécharge depuis la page des versions.',
      last: 'Dernière vérification : t5 — version 0.1.1 disponible',
    });
    expect(aboutLines(view({ phase: 'idle', available: null, lastCheck: 5, lastResult: 'error', error: 'ENOTFOUND' }).state, fmt).last).toBe(
      'Dernière vérification : t5 — échec (ENOTFOUND)',
    );
    expect(aboutLines(view({}).state, fmt).mode).toBe('AppImage : mise à jour téléchargée et vérifiée (sha512), installée au redémarrage, sur demande.');
  });
});
