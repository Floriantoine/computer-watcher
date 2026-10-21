import { describe, expect, test } from 'vitest';
import type { WrapItemStatus, WrapSetupStatus } from '../../core/wrapSetup';
import { applyToast, canInstallAll, previewLabel, stateBadge, summaryLine, WRAP_LIMITS, WRAP_WHY } from './wrapSetupView';

const item = (o: Partial<WrapItemStatus> = {}): WrapItemStatus => ({
  part: 'zshrc', state: 'absent', ok: false, path: '/h/.zshrc', preview: '', detail: '', canInstall: true, canRemove: false, blocked: null, warnings: [], ...o,
});
const status = (items: WrapItemStatus[]): WrapSetupStatus => ({ items, complete: items.every((i) => i.ok) });

describe('textes', () => {
  test('pourquoi : deux phrases ; limites : Warp, nouvelles sessions, règles Bash(...)', () => {
    expect(WRAP_WHY.split(/\. /)).toHaveLength(2);
    expect(WRAP_LIMITS.join(' ')).toMatch(/Warp/);
    expect(WRAP_LIMITS.join(' ')).toMatch(/nouvelles sessions/);
    expect(WRAP_LIMITS.join(' ')).toMatch(/Bash\(npm test:\*\)/);
  });

  test('pastille d’état', () => {
    expect(stateBadge(item())).toEqual({ text: 'Absent', tone: 'muted' });
    expect(stateBadge(item({ state: 'ours', ok: true }))).toEqual({ text: 'Installé', tone: 'ok' });
    expect(stateBadge(item({ state: 'ours', ok: false })).tone).toBe('warn');
    expect(stateBadge(item({ state: 'foreign', ok: true })).text).toMatch(/Déjà en place/);
    expect(stateBadge(item({ state: 'foreign', ok: false })).text).toBe('Présent, pas de Computer Watcher');
    expect(stateBadge(item({ state: 'unreadable' }))).toEqual({ text: 'Illisible', tone: 'bad' });
  });

  test('aperçu et résumé', () => {
    expect(previewLabel(item())).toMatch(/fin du fichier/);
    expect(previewLabel(item({ part: 'claude' }))).toMatch(/settings\.json/);
    expect(summaryLine(status([item({ ok: true }), item(), item()]))).toBe('1 élément sur 3 en place.');
    expect(summaryLine(status([item({ ok: true })]))).toMatch(/Tout est en place/);
    expect(canInstallAll(status([item({ canInstall: false })]))).toBe(false);
  });
});

describe('toast du résultat', () => {
  const st = status([item()]);
  test('annulé : rien ; erreurs : une seule erreur lisible ; sinon ce qui a changé et les sauvegardes', () => {
    expect(applyToast({ cancelled: true }, 'install')).toBe(null);
    expect(applyToast({ cancelled: false, results: [], errors: [{ part: 'claude', error: 'JSON invalide' }], status: st }, 'install')).toEqual({
      message: 'Claude Code : JSON invalide', kind: 'error',
    });
    const r = { part: 'zshrc' as const, changed: true, message: '', backup: '/h/.zshrc.bak', warnings: [] };
    expect(applyToast({ cancelled: false, results: [r], errors: [], status: st }, 'install')).toEqual({
      message: 'Installé : Terminal zsh (sauvegarde à côté des fichiers)', kind: 'info',
    });
    expect(applyToast({ cancelled: false, results: [{ ...r, changed: false }], errors: [], status: st }, 'remove')!.message).toMatch(/Rien à faire/);
  });
});
