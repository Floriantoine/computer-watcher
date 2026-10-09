import { describe, expect, test } from 'vitest';
import {
  SECTION_STORAGE_KEY,
  SETTINGS_SECTIONS,
  initialSection,
  linesDirty,
  numbersDirty,
  readStoredSection,
  sectionAttention,
  sectionByKey,
  settingsSectionForAlert,
  tokenDiff,
  writeStoredSection,
  type AttentionInput,
} from './settingsNav';

const calm: AttentionInput = {
  protectedEntry: '',
  protectedList: ['bash'],
  others: { dirty: false, invalid: false },
  alerts: { dirty: false, invalid: false },
  recorder: { status: { available: true, enabled: true, running: true }, dirty: false, invalid: false },
  earlyoom: { status: { installed: true, active: 'active' }, dirty: false, invalid: false },
};

describe('SETTINGS_SECTIONS', () => {
  test('neuf sections, dans l’ordre de la barre latérale, chacune avec un libellé et une description', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual(['protected', 'others', 'display', 'classify', 'alerts', 'rules', 'recorder', 'earlyoom', 'desktop']);
    for (const s of SETTINGS_SECTIONS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });
});

describe('initialSection', () => {
  test('la section de la route passe avant celle mémorisée', () => {
    expect(initialSection('alerts', 'earlyoom')).toBe('alerts');
  });
  test('sans route : la section mémorisée', () => {
    expect(initialSection(undefined, 'recorder')).toBe('recorder');
  });
  test('valeurs inconnues ignorées → Protégés', () => {
    expect(initialSection('nope', 'pas-une-section')).toBe('protected');
    expect(initialSection(undefined, null)).toBe('protected');
    expect(initialSection('nope', 'display')).toBe('display');
  });
});

describe('readStoredSection / writeStoredSection', () => {
  test('lit la clé, ignore une valeur inconnue', () => {
    expect(readStoredSection({ getItem: (k) => (k === SECTION_STORAGE_KEY ? 'earlyoom' : null) })).toBe('earlyoom');
    expect(readStoredSection({ getItem: () => 'zzz' })).toBeNull();
    expect(readStoredSection(null)).toBeNull();
  });
  test('stockage qui lève : null en lecture, rien en écriture', () => {
    const boom = () => {
      throw new Error('SecurityError');
    };
    expect(readStoredSection({ getItem: boom })).toBeNull();
    expect(() => writeStoredSection('alerts', { setItem: boom })).not.toThrow();
  });
  test('écrit la section sous la clé', () => {
    const saved: Record<string, string> = {};
    writeStoredSection('recorder', { setItem: (k, v) => (saved[k] = v) });
    expect(saved).toEqual({ [SECTION_STORAGE_KEY]: 'recorder' });
  });
});

describe('sectionByKey', () => {
  test('flèches bas / droite : suivante, avec retour au début', () => {
    expect(sectionByKey('protected', 'ArrowDown')).toBe('others');
    expect(sectionByKey('protected', 'ArrowRight')).toBe('others');
    expect(sectionByKey('desktop', 'ArrowDown')).toBe('protected');
  });
  test('flèches haut / gauche : précédente, avec retour à la fin', () => {
    expect(sectionByKey('others', 'ArrowUp')).toBe('protected');
    expect(sectionByKey('protected', 'ArrowLeft')).toBe('desktop');
  });
  test('Début / Fin ; autre touche → null', () => {
    expect(sectionByKey('alerts', 'Home')).toBe('protected');
    expect(sectionByKey('alerts', 'End')).toBe('desktop');
    expect(sectionByKey('alerts', 'Enter')).toBeNull();
    expect(sectionByKey('alerts', 'a')).toBeNull();
  });
});

describe('numbersDirty', () => {
  test('mêmes nombres (écriture différente) → pas modifié', () => {
    expect(numbersDirty({ a: '10', b: ' 2.50 ' }, { a: 10, b: 2.5 })).toBe(false);
  });
  test('nombre différent, champ vide ou texte non numérique → modifié', () => {
    expect(numbersDirty({ a: '11' }, { a: 10 })).toBe(true);
    expect(numbersDirty({ a: '' }, { a: 10 })).toBe(true);
    expect(numbersDirty({ a: 'abc' }, { a: 10 })).toBe(true);
  });
  test('seules les clés du formulaire comptent', () => {
    expect(numbersDirty({ a: '1' }, { a: 1, b: 99 })).toBe(false);
  });
});

describe('linesDirty', () => {
  test('lignes vides et espaces en bord ignorés', () => {
    expect(linesDirty('node.*\n\n  java \n', 'node.*\njava')).toBe(false);
    expect(linesDirty('', '')).toBe(false);
  });
  test('ordre ou contenu différent → modifié', () => {
    expect(linesDirty('java\nnode.*', 'node.*\njava')).toBe(true);
    expect(linesDirty('node.*', '')).toBe(true);
  });
});

describe('sectionAttention', () => {
  test('tout va bien → aucun point', () => {
    expect(sectionAttention(calm)).toEqual({});
  });
  test('earlyoom absent, inactif ou pas lancé au démarrage → point ROUGE tant que ce n’est pas réglé (B8 bis)', () => {
    const eo = (status: AttentionInput['earlyoom']['status']) => sectionAttention({ ...calm, earlyoom: { ...calm.earlyoom, status } }).earlyoom;
    expect(eo({ installed: false, active: 'unknown' })).toEqual({ tone: 'error', reasons: ['earlyoom n’est pas installé'] });
    expect(eo({ installed: true, active: 'failed' })).toEqual({ tone: 'error', reasons: ['earlyoom n’est pas actif'] });
    expect(eo({ installed: true, active: 'inactive', enabled: 'disabled' })).toEqual({ tone: 'error', reasons: ['earlyoom n’est pas actif'] });
    expect(eo({ installed: true, active: 'active', enabled: 'disabled' })).toEqual({ tone: 'error', reasons: ['earlyoom ne démarre pas avec le système'] });
    expect(eo({ installed: true, active: 'active', enabled: 'enabled' })).toBeUndefined();
    expect(eo({ installed: true, active: 'active', enabled: 'masked' })).toBeUndefined();
  });
  test('earlyoom pas encore lu → pas de point', () => {
    expect(sectionAttention({ ...calm, earlyoom: { ...calm.earlyoom, status: null } }).earlyoom).toBeUndefined();
  });
  test('enregistrement désactivé, service muet ou systemd absent', () => {
    const r = (status: AttentionInput['recorder']['status']) => sectionAttention({ ...calm, recorder: { ...calm.recorder, status } }).recorder;
    expect(r({ available: true, enabled: false, running: false })).toEqual({ tone: 'warn', reasons: ['Enregistrement désactivé'] });
    expect(r({ available: true, enabled: true, running: false })).toEqual({ tone: 'warn', reasons: ['Le service d’enregistrement ne répond pas'] });
    expect(r({ available: false, enabled: false, running: false })).toEqual({ tone: 'warn', reasons: ['systemd utilisateur indisponible'] });
    expect(r(null)).toBeUndefined();
  });
  test('formulaire modifié → point « modifié » ; invalide l’emporte', () => {
    expect(sectionAttention({ ...calm, others: { dirty: true, invalid: false } }).others).toEqual({ tone: 'dirty', reasons: ['Modifications non enregistrées'] });
    expect(sectionAttention({ ...calm, alerts: { dirty: true, invalid: true } }).alerts).toEqual({
      tone: 'error',
      reasons: ['Valeur invalide', 'Modifications non enregistrées'],
    });
  });
  test('raisons cumulées, la plus grave donne le ton', () => {
    const a = sectionAttention({
      ...calm,
      earlyoom: { status: { installed: true, active: 'inactive' }, dirty: true, invalid: false },
    }).earlyoom;
    expect(a).toEqual({ tone: 'error', reasons: ['Modifications non enregistrées', 'earlyoom n’est pas actif'] });
  });
  test('Protégés : texte saisi mais pas ajouté → modifié ; déjà dans la liste ou vide → rien', () => {
    expect(sectionAttention({ ...calm, protectedEntry: ' code ' }).protected).toEqual({ tone: 'dirty', reasons: ['Saisie pas encore ajoutée'] });
    expect(sectionAttention({ ...calm, protectedEntry: 'bash' }).protected).toBeUndefined();
    expect(sectionAttention({ ...calm, protectedEntry: '   ' }).protected).toBeUndefined();
  });
});

describe('settingsSectionForAlert', () => {
  test('kill earlyoom → earlyoom ; les autres → Alertes', () => {
    expect(settingsSectionForAlert('earlyoom_kill')).toBe('earlyoom');
    expect(settingsSectionForAlert('leak')).toBe('alerts');
    expect(settingsSectionForAlert('tmpfs')).toBe('alerts');
  });
});

describe('tokenDiff', () => {
  test('jetons absents de l’ancienne ligne marqués, espaces conservés', () => {
    const d = tokenDiff('EARLYOOM_ARGS="-m 8,5 -s 35,25"', 'EARLYOOM_ARGS="-m 10,5 -s 35,25"');
    expect(d.map((t) => t.text).join('')).toBe('EARLYOOM_ARGS="-m 10,5 -s 35,25"');
    expect(d.filter((t) => t.changed).map((t) => t.text)).toEqual(['10,5']);
  });
  test('ancienne ligne absente → rien de marqué', () => {
    expect(tokenDiff(null, 'a b').some((t) => t.changed)).toBe(false);
  });
  test('jeton répété : marqué au-delà du nombre d’occurrences anciennes', () => {
    expect(tokenDiff('a b', 'a a b').filter((t) => t.changed).map((t) => t.text)).toEqual(['a']);
  });
});

describe('sectionAttention : Règles', () => {
  test('règle refusée dans le fichier → erreur ; éditeur modifié → non enregistré ; rien → pas de point', () => {
    expect(sectionAttention({ ...calm, rules: { dirty: false, invalid: false, issues: 1 } }).rules).toEqual({ tone: 'error', reasons: ['1 règle invalide ignorée'] });
    expect(sectionAttention({ ...calm, rules: { dirty: true, invalid: false, issues: 0 } }).rules).toEqual({ tone: 'dirty', reasons: ['Modifications non enregistrées'] });
    expect(sectionAttention({ ...calm, rules: { dirty: false, invalid: false, issues: 0 } }).rules).toBeUndefined();
    expect(sectionAttention(calm).rules).toBeUndefined();
  });
});
