import { describe, expect, test } from 'vitest';
import { sampleState } from '../../core/antigel/testFixtures';
import {
  LATE_HINT, antigelCard, antigelMarks, budgetUsage, antigelStatusLine, budgetLabel, formatGo, parseGo, reserveHint, sameMark, validateBudget, validateReserve, withBudget,
  budgetRows, withNoBudget, budgetEffect, budgetEffectLine, budgetDialogEffect, defaultBudgetFor, formatBudgetSize,
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
    expect(reserveHint(32 * 1024 * 1024)).toMatch(/RAM disponible/);
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
    expect(c.memLine).toBe('Travail : 2,0 Go · marge avant ralentissement : 10,0 Go');
    expect(c.memHint).toMatch(/suit la RAM .* arrêt par le noyau seulement au-delà de 14,0 Go/i);
    // plus de compteur brut d'événements du noyau
    expect(c.lines).toEqual(['1 projet plafonné']);
    expect(c.budgets).toEqual([]);
    expect(antigelStatusLine(fresh(), true)).toBe('Actif : 1 projet plafonné · travail : 2,0 Go, marge avant ralentissement : 10,0 Go.');
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
    // projet avec budget : la mention hors budget est sur sa ligne de budget
    expect(c.late).toEqual([]);
    expect(c.budgets).toEqual([{ text: 'u / projet-a : 5,4 / 5 Go — ok · ~4,5 Go hors budget (capturé tard)', hint: LATE_HINT, throttled: false }]);
    expect(LATE_HINT).toMatch(/computer-watcher run -- <commande>/);
    expect(antigelCard(fresh()).late).toEqual([]);
    // sans budget : ligne à part, comme avant
    const free = antigelCard(fresh({ projects: [{ ...late, budgetMB: null }] }));
    expect(free.late).toEqual([{ text: 'u / projet-a : 5,4 Go dans le budget · ~4,5 Go hors budget (capturé tard)', hint: LATE_HINT }]);
    expect(antigelCard(fresh({ projects: [{ ...late, budgetMB: null, root: null, unit: 'cwatch-p-autres.slice' }] })).late[0]!.text).toMatch(/^Vérifications hors projet : /);
    // Réglages → budgets : mémoire du projet en cours, hors budget seulement s'il y en a
    expect(budgetUsage(v, '/home/u/projet-a')).toEqual({ text: '5,4 Go dans le budget — ok · ~4,5 Go hors budget (capturé tard)', hint: LATE_HINT });
    expect(budgetUsage(fresh({ projects: [{ ...late, outsideKB: undefined }] }), '/home/u/projet-a')).toEqual({ text: '5,4 Go dans le budget — ok', hint: null });
    expect(budgetUsage(v, '/home/u/demo')).toBeNull();
    expect(budgetUsage({ state: v.state, fresh: false }, '/home/u/projet-a')).toBeNull();
  });
  test('carte : aucun jargon « slice » ; la slice « autres » (vérifications hors projet) ne compte pas comme un projet', () => {
    const alpha = { unit: 'cwatch-p-alpha.slice', root: '/home/u/alpha', procs: 3, currentKB: 1, budgetMB: null, throttled: false };
    const autres = { unit: 'cwatch-p-autres.slice', root: null, procs: 1, currentKB: 1, budgetMB: null, throttled: false };
    const both = fresh({ projects: [alpha, autres] });
    expect(antigelCard(both).lines).toEqual(['1 projet plafonné, plus des vérifications hors projet']);
    expect(antigelStatusLine(both, true)).toMatch(/^Actif : 1 projet plafonné,/);
    const only = fresh({ projects: [autres] });
    expect(antigelCard(only).lines[0]).toBe('0 projet plafonné, plus des vérifications hors projet');
    expect(antigelStatusLine(only, true)).toMatch(/^Actif : 0 projet plafonné,/);
    for (const v of [both, only, fresh()]) expect(antigelCard(v).lines.join(' ')).not.toMatch(/slice/);
  });

  describe('budget par défaut', () => {
    const G = 1024 * 1024;
    const ag = { enabled: true, reserveMB: null, budgets: { '/home/u/demo': 2048 }, defaultBudgetMB: 5120 };
    const proj = (root: string, o = {}) => ({ unit: `cwatch-p-${root.split('/').pop()}.slice`, root, procs: 2, currentKB: G, budgetMB: 5120, throttled: false, ...o });

    test('lignes de Réglages : budgets explicites, projets actifs au budget par défaut ou sans budget, triés', () => {
      const v = fresh({ projects: [
        proj('/home/u/projet-a', { budgetDefault: true }), proj('/home/u/demo', { budgetMB: 2048 }), proj('/home/u/libre', { budgetMB: null }),
        { unit: 'cwatch-p-autres.slice', root: null, procs: 1, currentKB: 1, budgetMB: null, throttled: false },
      ] });
      expect(budgetRows({ ...ag, noBudget: ['/home/u/libre', '/home/u/vieux'] }, v)).toEqual([
        { root: '/home/u/demo', mb: 2048, source: 'explicit' },
        { root: '/home/u/libre', mb: null, source: 'none' },
        { root: '/home/u/projet-a', mb: 5120, source: 'default' },
        { root: '/home/u/vieux', mb: null, source: 'none' },
      ]);
      // défaut retiré : les projets actifs sans budget explicite apparaissent « sans budget »
      expect(budgetRows({ ...ag, defaultBudgetMB: null }, v).find((r) => r.root === '/home/u/projet-a')).toEqual({ root: '/home/u/projet-a', mb: null, source: 'none' });
      // état vieux : seulement la config
      expect(budgetRows(ag, { ...v, fresh: false })).toEqual([{ root: '/home/u/demo', mb: 2048, source: 'explicit' }]);
    });
    test('projet sans budget : ajout normalisé sans doublon, retrait, champ omis quand la liste est vide', () => {
      const a = withNoBudget(ag, '/home/u/projet-a/', true);
      expect(a.noBudget).toEqual(['/home/u/projet-a']);
      expect(withNoBudget(a, '/home/u/projet-a', true).noBudget).toEqual(['/home/u/projet-a']);
      expect(withNoBudget(a, '/home/u/projet-a', false)).not.toHaveProperty('noBudget');
      expect(withNoBudget(ag, 'relatif', true)).toEqual(ag);
    });
    test('carte Métriques : les projets au budget par défaut ont leur ligne, avec la mention « par défaut »', () => {
      const c = antigelCard(fresh({ projects: [proj('/home/u/projet-a', { budgetDefault: true, currentKB: 800 * 1024 }), proj('/home/u/demo', { budgetMB: 2048 })] }));
      expect(c.budgets.map((b) => b.text)).toEqual(['u / projet-a : 800 Mo / 5 Go (par défaut) — ok', 'u / demo : 1,0 / 2 Go — ok']);
    });
  });

  describe('ce qui freine vraiment', () => {
    const G = 1024 * 1024;
    const proj = { unit: 'cwatch-p-projet-a.slice', root: '/home/u/projet-a', procs: 4, currentKB: 5 * G, budgetMB: 5120, throttled: false, budgetThrottled: false };
    const slice = { currentKB: 4.8 * G, highKB: 6 * G, maxKB: 28.7 * G, swapMaxKB: 4 * G, throttles: 2_825_279, oomKills: 0, throttled: false };

    test('budget d’un projet : titre qui le nomme, ligne « freiné » ; le plafond global n’est pas en cause', () => {
      const c = antigelCard(fresh({ slice, projects: [{ ...proj, throttled: true, budgetThrottled: true, stallPct: 64 }] }));
      expect(c).toMatchObject({ tone: 'warn', title: 'Le projet u / projet-a est freiné par son budget' });
      expect(c.memLine).toBe('Travail : 4,8 Go · marge avant ralentissement : 1,2 Go');
      expect(c.budgets).toEqual([{ text: 'u / projet-a : 5,0 / 5 Go — freiné en ce moment', hint: null, throttled: true }]);
      expect(c.lines.join(' ')).not.toMatch(/2825279|2 825 279|ralentissements/);
      const two = antigelCard(fresh({ slice, projects: [
        { ...proj, throttled: true, budgetThrottled: true },
        { ...proj, unit: 'cwatch-p-demo.slice', root: '/home/u/demo', throttled: true, budgetThrottled: true },
      ] }));
      expect(two.title).toBe('2 projets sont freinés par leur budget');
    });
    test('budget qui a freiné dans la dernière minute : part du temps ; sinon « ok »', () => {
      const c = antigelCard(fresh({ slice, projects: [{ ...proj, stallPct: 30 }] }));
      expect(c).toMatchObject({ tone: 'ok', title: 'Plafond de travail actif' });
      expect(c.budgets[0]!.text).toBe('u / projet-a : 5,0 / 5 Go — freiné 30 % de la dernière minute');
      expect(antigelCard(fresh({ slice, projects: [{ ...proj, stallPct: 0 }] })).budgets[0]!.text).toBe('u / projet-a : 5,0 / 5 Go — ok');
      expect(antigelCard(fresh({ slice, projects: [{ ...proj, currentKB: 800 * 1024 }] })).budgets[0]!.text).toBe('u / projet-a : 800 Mo / 5 Go — ok');
    });
    test('plafond global : « la RAM est presque pleine », état récent du travail, marge nulle', () => {
      const full = { ...slice, highKB: 4.8 * G, throttled: true, stallPct: 42 };
      const c = antigelCard(fresh({ slice: full, projects: [{ ...proj, budgetMB: null, throttled: true }] }));
      expect(c).toMatchObject({ tone: 'warn', title: 'Le travail est freiné : la RAM est presque pleine' });
      expect(c.memLine).toBe('Travail : 4,8 Go · marge avant ralentissement : aucune');
      expect(c.lines).toContain('Travail freiné en ce moment (42 % de la dernière minute)');
      const past = antigelCard(fresh({ slice: { ...full, throttled: false, stallPct: 7 }, projects: [] }));
      expect(past).toMatchObject({ tone: 'ok', title: 'Plafond de travail actif' });
      expect(past.lines).toContain('Travail freiné 7 % de la dernière minute');
    });
    test('arrêts par le noyau : seulement s’il y en a', () => {
      expect(antigelCard(fresh({ slice: { ...slice, oomKills: 2 }, projects: [] })).lines).toContain('2 arrêts par le noyau sous le plafond');
      expect(antigelCard(fresh({ slice, projects: [] })).lines.join(' ')).not.toMatch(/arrêt/);
    });
    test('service d’avant ce lot (sans budgetThrottled ni slice.throttled) : déduit du budget', () => {
      const old = { currentKB: 4.8 * G, highKB: 26.4 * G, maxKB: 28.7 * G, swapMaxKB: 4 * G, throttles: 2_825_279, oomKills: 0 };
      const { budgetThrottled: _, ...p } = proj;
      expect(antigelCard(fresh({ slice: old, projects: [{ ...p, throttled: true }] })).title).toBe('Le projet u / projet-a est freiné par son budget');
      expect(antigelCard(fresh({ slice: old, projects: [{ ...p, budgetMB: null, throttled: true }] })).title).toBe('Le travail est freiné : la RAM est presque pleine');
    });
    test('Réglages → budgets : état du budget à côté de la mémoire', () => {
      expect(budgetUsage(fresh({ slice, projects: [{ ...proj, throttled: true, budgetThrottled: true }] }), '/home/u/projet-a'))
        .toEqual({ text: '5,0 Go dans le budget — freiné en ce moment', hint: null });
      expect(budgetUsage(fresh({ slice, projects: [proj] }), '/home/u/projet-a')).toEqual({ text: '5,0 Go dans le budget — ok', hint: null });
    });
  });
});

describe('ce que fait un budget, en une ligne (freinage, part de swap, plafond dur)', () => {
  test('5 Go, 8 Go, petits budgets (Mo sous 1 Go)', () => {
    expect(budgetEffect(5120)).toBe('freine à 5 Go · swap 1,25 Go max · au-delà de 5,5 Go, un processus du projet est arrêté');
    expect(budgetEffect(8192)).toBe('freine à 8 Go · swap 2 Go max · au-delà de 8,8 Go, un processus du projet est arrêté');
    expect(budgetEffect(256)).toBe('freine à 256 Mo · swap 64 Mo max · au-delà de 512 Mo, un processus du projet est arrêté');
    expect(budgetEffect(1536)).toBe('freine à 1,5 Go · swap 384 Mo max · au-delà de 1,75 Go, un processus du projet est arrêté');
    expect(formatBudgetSize(1023)).toBe('1023 Mo');
    expect(formatBudgetSize(1024)).toBe('1 Go');
    expect(budgetEffectLine(5120, true)).toBe('Budget par défaut (5 Go) : freine à 5 Go · swap 1,25 Go max · au-delà de 5,5 Go, un processus du projet est arrêté');
    expect(budgetEffectLine(8192, false)).toMatch(/^Budget de 8 Go : freine à 8 Go · /);
  });
  test('dialogue « Budget mémoire… » : budget saisi ; vide : budget par défaut du projet (ou aucun) ; saisie invalide : rien', () => {
    expect(budgetDialogEffect('6', 5120)).toBe('Freine à 6 Go · swap 1,5 Go max · au-delà de 6,6 Go, un processus du projet est arrêté.');
    expect(budgetDialogEffect(' ', 5120)).toBe('Sans budget propre, budget par défaut (5 Go) : freine à 5 Go · swap 1,25 Go max · au-delà de 5,5 Go, un processus du projet est arrêté.');
    expect(budgetDialogEffect('', null)).toBe('Sans budget propre : aucun budget, seul le plafond de travail global s’applique.');
    expect(budgetDialogEffect('six', 5120)).toBeNull();
    expect(budgetDialogEffect('0,1', 5120)).toBeNull();
  });
  test('budget par défaut d’un projet (sans tenir compte de son budget propre) : aucun s’il est « Sans budget » ou si le défaut est éteint', () => {
    const ag = { enabled: true, reserveMB: null, budgets: { '/home/u/projet-a': 2048 }, defaultBudgetMB: 5120 };
    expect(defaultBudgetFor(ag, '/home/u/projet-a')).toBe(5120);
    expect(defaultBudgetFor(ag, '/home/u/demo/')).toBe(5120);
    expect(defaultBudgetFor({ ...ag, noBudget: ['/home/u/demo'] }, '/home/u/demo')).toBeNull();
    expect(defaultBudgetFor({ ...ag, defaultBudgetMB: null }, '/home/u/demo')).toBeNull();
    expect(defaultBudgetFor(ag, 'relatif')).toBeNull();
  });
  test('carte Métriques : une ligne par budget en cours (le défaut d’abord), aucune sans budget', () => {
    const p = (root: string, o: object) => ({ unit: 'cwatch-p-projet-a.slice', root, procs: 1, currentKB: 1024, budgetMB: 5120, throttled: false, ...o });
    const c = antigelCard(fresh({ projects: [
      p('/home/u/demo', { budgetMB: 8192 }), p('/home/u/projet-a', { budgetDefault: true }), p('/home/u/projet-b', { budgetDefault: true }),
      p('/home/u/projet-c', { budgetMB: null }),
    ] }));
    expect(c.effects).toEqual([
      'Budget par défaut (5 Go) : freine à 5 Go · swap 1,25 Go max · au-delà de 5,5 Go, un processus du projet est arrêté',
      'Budget de 8 Go : freine à 8 Go · swap 2 Go max · au-delà de 8,8 Go, un processus du projet est arrêté',
    ]);
    expect(antigelCard(fresh()).effects).toEqual([]);
    expect(antigelCard(null).effects).toEqual([]);
  });
  test('carte : plafond dur provisoire (convergence) sur la ligne du projet ; rien quand il vaut celui du budget', () => {
    const G = 1024 * 1024;
    const p = { unit: 'cwatch-p-projet-a.slice', root: '/home/u/projet-a', procs: 9, currentKB: 4.5 * G, budgetMB: 5120, throttled: false };
    const c = antigelCard(fresh({ projects: [{ ...p, maxKB: 10.25 * G }] }));
    expect(c.budgets[0]!.text).toBe('u / projet-a : 4,5 / 5 Go — ok · plafond dur provisoire : 10,25 Go');
    expect(antigelCard(fresh({ projects: [{ ...p, maxKB: 5.5 * G }] })).budgets[0]!.text).toBe('u / projet-a : 4,5 / 5 Go — ok');
  });
});
