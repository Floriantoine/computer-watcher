import { describe, expect, test } from 'vitest';
import { diskSettingsToForm, validateDiskSettingsForm } from './diskSettingsForm';

describe('Réglages → Disque', () => {
  test('aller-retour, ~ développé, lignes vides ignorées', () => {
    expect(diskSettingsToForm({ diskProjectRoots: ['/home/u/code', '/srv/projets'], diskInactiveDays: 30 })).toEqual({ rootsText: '/home/u/code\n/srv/projets', days: '30' });
    expect(validateDiskSettingsForm({ rootsText: '~/code\n\n  /srv/projets/  \n', days: '45' }, '/home/u')).toEqual({ ok: true, roots: ['/home/u/code', '/srv/projets'], days: 45 });
    expect(validateDiskSettingsForm({ rootsText: '', days: '30' }, null)).toEqual({ ok: true, roots: [], days: 30 });
  });
  test('erreurs : chemin relatif, « / », ~ sans dossier personnel connu, jours hors bornes', () => {
    expect(validateDiskSettingsForm({ rootsText: 'code', days: '30' }, '/home/u')).toMatchObject({ ok: false, errors: { roots: expect.stringMatching(/chemin absolu/) } });
    expect(validateDiskSettingsForm({ rootsText: '/', days: '30' }, '/home/u').ok).toBe(false);
    expect(validateDiskSettingsForm({ rootsText: '~/code', days: '30' }, null).ok).toBe(false);
    for (const d of ['0', '366', '1.5', 'abc', '']) expect(validateDiskSettingsForm({ rootsText: '', days: d }, null), d).toMatchObject({ ok: false, errors: { days: 'Un nombre entier de 1 à 365 est attendu' } });
  });
  test('doublons fusionnés avant la limite ; ~ sans dossier personnel : message précis', () => {
    const lignes = [...Array.from({ length: 20 }, (_, i) => `/srv/p${i}`), '/srv/p0/'].join('\n');
    expect(validateDiskSettingsForm({ rootsText: lignes, days: '30' }, null)).toMatchObject({ ok: true, roots: expect.any(Array) });
    expect((validateDiskSettingsForm({ rootsText: lignes, days: '30' }, null) as { roots: string[] }).roots).toHaveLength(20);
    expect(validateDiskSettingsForm({ rootsText: '~/code', days: '30' }, null)).toMatchObject({ ok: false, errors: { roots: '~ indisponible : écris le chemin complet' } });
  });
});
