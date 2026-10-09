import { describe, expect, test } from 'vitest';
import { autostartResult, installResult, recorderResult, uninstallReport } from './onboardingText';

const base = { dest: '/home/u/Applications/proc-watch.AppImage', desktopFile: '/home/u/.local/share/applications/proc-watch.desktop', source: '/home/u/Téléchargements/p.AppImage', autostartUpdated: false };

describe('installation', () => {
  test('installée : copie et entrée de menu, chemins exacts', () => {
    const r = installResult({ ...base, status: 'installed', runningFromCopy: false, canDeleteSource: true });
    expect(r.tone).toBe('ok');
    expect(r.lines).toEqual([`Copiée dans ${base.dest}`, `Entrée de menu : ${base.desktopFile}`]);
  });
  test('déjà installée / mise à jour / démarrage repointé', () => {
    expect(installResult({ ...base, status: 'already', runningFromCopy: true, canDeleteSource: false }).lines[0]).toBe(`Déjà installée : ${base.dest}`);
    expect(installResult({ ...base, status: 'updated', runningFromCopy: false, canDeleteSource: true }).lines[0]).toBe(`Copie remplacée : ${base.dest}`);
    expect(installResult({ ...base, status: 'installed', runningFromCopy: false, canDeleteSource: true, autostartUpdated: true }).lines).toContain('Démarrage avec la session : repointé vers la copie');
  });
});

describe('démarrage avec la session', () => {
  test('activé / désactivé : chemin exact', () => {
    expect(autostartResult({ enabled: true, path: '/c/autostart/proc-watch.desktop', target: '/x' })).toEqual({ tone: 'ok', lines: ['Activé : /c/autostart/proc-watch.desktop'] });
    expect(autostartResult({ enabled: false, path: '/c/autostart/proc-watch.desktop', target: '/x' })).toEqual({ tone: 'ok', lines: ['Désactivé : /c/autostart/proc-watch.desktop retiré'] });
  });
});

describe('historique', () => {
  test.each([
    [{ available: false, enabled: true, running: false }, 'warn', 'systemd utilisateur indisponible'],
    [{ available: true, enabled: true, running: true }, 'ok', 'Service actif'],
    [{ available: true, enabled: true, running: false }, 'warn', 'Activé, le service n’a pas encore répondu'],
    [{ available: true, enabled: false, running: false }, 'ok', 'Désactivé'],
  ] as const)('%o → %s', (s, tone, text) => {
    const r = recorderResult(s);
    expect(r.tone).toBe(tone);
    expect(r.lines[0]).toContain(text);
  });
});

describe('désinstallation', () => {
  test('tout retiré : liste exacte, fermeture annoncée', () => {
    const r = uninstallReport({ removed: ['/a', '/b'], failed: [], kept: [], done: true });
    expect(r.tone).toBe('ok');
    expect(r.lines).toEqual(['Retiré : /a', 'Retiré : /b', 'proc-watch est désinstallé et va se fermer.']);
  });
  test('échecs partiels : chaque échec et ce qui reste', () => {
    const r = uninstallReport({ removed: ['/a'], failed: [{ path: '/u', error: 'refus' }], kept: [{ path: '/app', reason: 'gardée' }], done: false });
    expect(r.tone).toBe('error');
    expect(r.lines).toEqual(['Retiré : /a', 'Échec : /u — refus', 'Laissé : /app — gardée', 'Désinstallation incomplète : proc-watch reste ouvert.']);
  });
});
