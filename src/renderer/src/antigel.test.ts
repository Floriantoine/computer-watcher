import { describe, expect, test } from 'vitest';
import { sampleState } from '../../core/antigel/testFixtures';
import {
  LATE_HINT, antigelCard, antigelMarks, budgetUsage, antigelStatusLine, budgetLabel, formatGo, parseGo, reserveHint, sameMark, validateBudget, validateReserve, withBudget,
} from './antigel';

const fresh = (o = {}) => ({ state: sampleState(o), fresh: true });

describe('fenêtre : plafond de travail', () => {
  test('marques par groupe projet ; rien si l’état est vieux, éteint ou indisponible', () => {
    const v = fresh({ projects: [
      { unit: 'cwatch-p-alpha.slice', root: '/home/u/alpha', procs: 3, currentKB: 1, budgetMB: 4096, throttled: true },
      { unit: 'cwatch-p-autres.slice', root: null, procs: 1, currentKB: 1, budgetMB: null, throttled: false },
    ] });
    expect([...antigelMarks(v)]).toEqual([['project:/home/u/alpha', { throttled: true, budgetMB: 4096 }]]);
    expect(antigelMarks({ ...v, fresh: false }).size).toBe(0);
    expect(antigelMarks(fresh({ status: 'off' })).size).toBe(0);
    expect(antigelMarks(null).size).toBe(0);
    expect(sameMark({ throttled: true, budgetMB: null }, { throttled: true, budgetMB: null })).toBe(true);
    expect(sameMark({ throttled: true, budgetMB: null }, { throttled: false, budgetMB: null })).toBe(false);
    expect(sameMark(undefined, undefined)).toBe(true);
  });
  test('saisie en Go (virgule ou point), bornes du budget', () => {
    expect(parseGo('6')).toBe(6144);
    expect(parseGo(' 6,5 Go ')).toBe(6656);
    expect(parseGo('0.25')).toBe(256);
    expect(parseGo('')).toBeNull();
    expect(parseGo('six')).toBeUndefined();
    expect(parseGo('-1')).toBeUndefined();
    expect(formatGo(6656)).toBe('6,5 Go');
    expect(validateBudget('6')).toEqual({ ok: true, mb: 6144 });
    expect(validateBudget('0,2')).toMatchObject({ ok: false, error: 'Entre 0,25 Go et 1024 Go.' });
    expect(validateBudget('')).toMatchObject({ ok: false });
    expect(validateBudget('0,25')).toEqual({ ok: true, mb: 256 });
    expect(validateBudget('1024')).toEqual({ ok: true, mb: 1_048_576 });
    expect(validateBudget('1025')).toMatchObject({ ok: false, error: 'Entre 0,25 Go et 1024 Go.' });
    expect(validateBudget('1,5')).toEqual({ ok: true, mb: 1536 });
    expect(parseGo('1,234')).toBeUndefined();
  });
  test('réserve : vide = automatique ; au moins 1 Go laissé au travail', () => {
    expect(validateReserve('', 16 * 1024 * 1024)).toEqual({ ok: true, mb: null });
    expect(validateReserve('6', 16 * 1024 * 1024)).toEqual({ ok: true, mb: 6144 });
    expect(validateReserve('15', 16 * 1024 * 1024)).toEqual({ ok: true, mb: 15360 });
    expect(validateReserve('15,5', 16 * 1024 * 1024)).toMatchObject({ ok: false, error: 'Laisse au moins 1 Go au travail (RAM : 16 Go).' });
    expect(validateReserve('0,5', null)).toMatchObject({ ok: false, error: 'Entre 1 Go et 1024 Go.' });
    expect(reserveHint(32 * 1024 * 1024)).toMatch(/^Vide : automatique, 4,8 Go/);
  });
  test('budgets : ajout, remplacement, retrait, racine normalisée, libellé', () => {
    expect(withBudget({}, '/home/u/alpha/', 4096)).toEqual({ '/home/u/alpha': 4096 });
    expect(withBudget({ '/home/u/alpha': 4096 }, '/home/u/alpha', null)).toEqual({});
    expect(withBudget({ '/a': 300 }, 'relatif', 4096)).toEqual({ '/a': 300 });
    expect(budgetLabel('/home/u/projets/alpha')).toBe('projets / alpha');
  });
  test('carte Métriques et ligne d’état', () => {
    expect(antigelCard(null)).toMatchObject({ tone: 'na', title: 'Plafond de travail : en attente du service d’enregistrement' });
    expect(antigelCard({ state: sampleState(), fresh: false })).toMatchObject({ tone: 'na', title: 'Plafond de travail : service d’enregistrement arrêté' });
    expect(antigelCard(fresh({ status: 'unavailable', reason: 'busctl introuvable (/usr/bin/busctl)', slice: null, projects: [] })))
      .toMatchObject({ tone: 'na', title: 'Plafond de travail indisponible : busctl introuvable (/usr/bin/busctl)' });
    expect(antigelCard(fresh({ status: 'off', enabled: false }))).toMatchObject({ tone: 'off', title: 'Plafond de travail éteint' });
    const c = antigelCard(fresh());
    expect(c).toMatchObject({ tone: 'ok', title: 'Plafond de travail actif', usedKB: 2 * 1024 * 1024, highKB: 12 * 1024 * 1024, fillPercent: 17 });
    expect(c.lines).toEqual(['1 projet plafonné', '3 ralentissements · 0 arrêt par le noyau sous le plafond']);
    expect(antigelCard(fresh({ projects: [{ unit: 'cwatch-p-alpha.slice', root: '/a', procs: 1, currentKB: 1, budgetMB: null, throttled: true }] })))
      .toMatchObject({ tone: 'warn', title: 'Plafond de travail atteint : travail ralenti' });
    expect(antigelCard(fresh({ status: 'off' })).lines).toEqual(['Réglages → Plafond de travail pour le rallumer.']);
    expect(antigelStatusLine(fresh(), true)).toMatch(/^Actif : 1 projet plafonné/);
    expect(antigelStatusLine(null, true)).toMatch(/applique le plafond de travail/);
    expect(antigelStatusLine(fresh({ status: 'unavailable', reason: 'x' }), true)).toBe('Plafond de travail indisponible : x.');
    expect(antigelStatusLine(fresh({ status: 'off' }), false)).toMatch(/^Éteint/);
  });
  test('mémoire hors budget (capturé tard) : ligne de la carte et des budgets, avec une infobulle qui conseille run', () => {
    const late = { unit: 'cwatch-p-projet-a.slice', root: '/home/u/projet-a', procs: 17, currentKB: 5.4 * 1024 * 1024, budgetMB: 5120, throttled: false, outsideKB: 4.5 * 1024 * 1024 };
    const v = fresh({ projects: [late] });
    const c = antigelCard(v);
    expect(c.late).toEqual([{ text: 'u / projet-a : 5,4 Go dans le budget · ~4,5 Go hors budget (capturé tard)', hint: LATE_HINT }]);
    expect(LATE_HINT).toMatch(/computer-watcher run -- <commande>/);
    expect(antigelCard(fresh()).late).toEqual([]);
    expect(antigelCard(fresh({ projects: [{ ...late, root: null, unit: 'cwatch-p-autres.slice' }] })).late[0]!.text).toMatch(/^Vérifications hors projet : /);
    // Réglages → budgets : mémoire du projet en cours, hors budget seulement s'il y en a
    expect(budgetUsage(v, '/home/u/projet-a')).toEqual({ text: '5,4 Go dans le budget · ~4,5 Go hors budget (capturé tard)', hint: LATE_HINT });
    expect(budgetUsage(fresh({ projects: [{ ...late, outsideKB: undefined }] }), '/home/u/projet-a')).toEqual({ text: '5,4 Go dans le budget', hint: null });
    expect(budgetUsage(v, '/home/u/demo')).toBeNull();
    expect(budgetUsage({ state: v.state, fresh: false }, '/home/u/projet-a')).toBeNull();
  });
  test('carte : aucun jargon « slice » ; la slice « autres » (vérifications hors projet) ne compte pas comme un projet', () => {
    const alpha = { unit: 'cwatch-p-alpha.slice', root: '/home/u/alpha', procs: 3, currentKB: 1, budgetMB: null, throttled: false };
    const autres = { unit: 'cwatch-p-autres.slice', root: null, procs: 1, currentKB: 1, budgetMB: null, throttled: false };
    const both = fresh({ projects: [alpha, autres] });
    expect(antigelCard(both).lines).toEqual(['1 projet plafonné, plus des vérifications hors projet', '3 ralentissements · 0 arrêt par le noyau sous le plafond']);
    expect(antigelStatusLine(both, true)).toMatch(/^Actif : 1 projet plafonné,/);
    const only = fresh({ projects: [autres] });
    expect(antigelCard(only).lines[0]).toBe('0 projet plafonné, plus des vérifications hors projet');
    expect(antigelStatusLine(only, true)).toMatch(/^Actif : 0 projet plafonné,/);
    for (const v of [both, only, fresh()]) expect(antigelCard(v).lines.join(' ')).not.toMatch(/slice/);
  });
});
