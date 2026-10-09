import { describe, expect, test } from 'vitest';
import type { EarlyoomStatus, HistoryEvent } from '../../core/types';
import { formFromStatus, lastEarlyoomKills, validateEarlyoomForm, withTestPrefer, type EarlyoomForm } from './earlyoomForm';
import { EARLYOOM_DEFAULT_SETTINGS, EARLYOOM_TEST_PREFER } from '../../core/earlyoomSetup';
import { checkRegexPart } from '../../core/earlyoom';

const LINE = 'EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(claude|claude-desktop|warp|zsh|bash|kwin_wayland|kwin_wayland_wr|plasmashell|Xwayland|sddm|systemd.*)$ --prefer ^(chrome|vitest|node..vitest.|node-MainThread|node|npm)$"';

const status = (file: EarlyoomStatus['file']): EarlyoomStatus => ({
  installed: true, version: '1.9.0', active: 'active', enabled: 'enabled', file, installHint: 'x',
});

const VALID: EarlyoomForm = { memTerm: '8', memKill: '5', swapTerm: '35', swapKill: '25', prefer: 'chrome\nvitest\nnode..vitest.\nnode-MainThread\nnode\nnpm' };

describe('formFromStatus', () => {
  test('fichier lu → valeurs, une préférence par ligne', () => {
    expect(formFromStatus(status({
      settings: { memTerm: 6, memKill: 3, swapTerm: 30, swapKill: 15, prefer: ['chrome', 'node..vitest.'] },
      converted: [], line: 'x',
    }))).toEqual({ memTerm: '6', memKill: '3', swapTerm: '30', swapKill: '15', prefer: 'chrome\nnode..vitest.' });
  });
  test('sans fichier → défauts 8,5 / 35,25, processus de test préférés', () => {
    expect(formFromStatus(status(null))).toEqual({ memTerm: '8', memKill: '5', swapTerm: '35', swapKill: '25', prefer: EARLYOOM_TEST_PREFER.join('\n') });
  });
});

describe('validateEarlyoomForm', () => {
  test('formulaire valide → aperçu = ligne exacte', () => {
    const r = validateEarlyoomForm(VALID, ['claude']);
    expect(r.errors).toEqual({});
    expect(r.preview).toBe(LINE);
    expect(r.settings).toEqual({ memTerm: 8, memKill: 5, swapTerm: 35, swapKill: 25, prefer: ['chrome', 'vitest', 'node..vitest.', 'node-MainThread', 'node', 'npm'] });
  });
  test('memKill vide → Valeur requise', () => {
    const r = validateEarlyoomForm({ ...VALID, memKill: ' ' }, []);
    expect(r.errors.memKill).toBe('Valeur requise');
    expect(r.preview).toBeUndefined();
    expect(r.settings).toBeUndefined();
  });
  test("'abc' → erreur", () => {
    expect(validateEarlyoomForm({ ...VALID, swapTerm: 'abc' }, []).errors.swapTerm).toBeTruthy();
  });
  test('memKill > memTerm → erreur sur memKill', () => {
    expect(validateEarlyoomForm({ ...VALID, memKill: '9' }, []).errors.memKill).toBeTruthy();
  });
  test('motif avec espace → erreur sur prefer nommant le motif', () => {
    const r = validateEarlyoomForm({ ...VALID, prefer: 'chrome\nnode (vitest)' }, []);
    expect(r.errors.prefer).toContain('node (vitest)');
    expect(r.preview).toBeUndefined();
  });
  test.each(['a(', '*x', 'a)|(.*', '.*', 'a|b'])('motif hors grammaire « %s » → erreur sur prefer', (p) => {
    const r = validateEarlyoomForm({ ...VALID, prefer: p }, []);
    expect(r.errors.prefer).toBeTruthy();
    expect(r.preview).toBeUndefined();
  });
  test('lignes vides de prefer ignorées', () => {
    const r = validateEarlyoomForm({ ...VALID, prefer: '\n  chrome  \n\n\nnpm\n' }, []);
    expect(r.settings?.prefer).toEqual(['chrome', 'npm']);
  });
  test('prefer vide → pas de --prefer', () => {
    expect(validateEarlyoomForm({ ...VALID, prefer: '' }, []).preview).not.toContain('--prefer');
  });
});

describe('lastEarlyoomKills', () => {
  const ev = (ts: number, type: string, detail: Record<string, unknown> = {}): HistoryEvent => ({ ts, type, groupKey: null, groupLabel: null, detail });
  test('3 kills les plus récents avec nom et signal', () => {
    const events = [
      ev(10, 'earlyoom_kill', { name: 'a', signal: 'SIGTERM' }),
      ev(50, 'pressure'),
      ev(40, 'earlyoom_kill', { name: 'd', signal: 'SIGKILL' }),
      ev(20, 'earlyoom_kill', { name: 'b', signal: 'SIGTERM' }),
      ev(30, 'earlyoom_kill', { name: 'c' }),
    ];
    expect(lastEarlyoomKills(events)).toEqual([
      { ts: 40, name: 'd', signal: 'SIGKILL' },
      { ts: 30, name: 'c', signal: '' },
      { ts: 20, name: 'b', signal: 'SIGTERM' },
    ]);
  });
  test('aucun kill → vide', () => expect(lastEarlyoomKills([ev(1, 'pressure')])).toEqual([]));
});

describe('processus de test dans les préférences', () => {
  test('les motifs de test respectent la grammaire', () => {
    for (const p of EARLYOOM_TEST_PREFER) expect(checkRegexPart(p)).toBeNull();
  });
  test('une nouvelle installation préfère les processus de test par défaut', () => {
    expect(EARLYOOM_DEFAULT_SETTINGS.prefer).toEqual([...EARLYOOM_TEST_PREFER]);
  });
  test('ajout sans rien retirer ni dupliquer, ordre de la liste conservé', () => {
    const out = withTestPrefer('chrome\nvitest\nnode\nnpm');
    const lines = out.split('\n');
    expect(lines.slice(0, 4)).toEqual(['chrome', 'vitest', 'node', 'npm']);
    for (const p of EARLYOOM_TEST_PREFER) expect(lines.filter((l) => l === p)).toHaveLength(1);
  });
  test('liste vide → les motifs de test ; déjà complète → inchangée', () => {
    expect(withTestPrefer('').split('\n')).toEqual([...EARLYOOM_TEST_PREFER]);
    const full = EARLYOOM_TEST_PREFER.join('\n');
    expect(withTestPrefer(full)).toBe(full);
  });
});
