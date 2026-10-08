import { describe, expect, test } from 'vitest';
import { DEFAULT_CONFIG } from './defaults';
import {
  EARLYOOM_BASE_IGNORE,
  EARLYOOM_LINE_PATTERN,
  EARLYOOM_LINE_RE,
  EARLYOOM_TOKEN_CHARS,
  checkEarlyoomLine,
  buildEarlyoomArgs,
  ignoreConversions,
  checkRegexPart,
  ignoreList,
  isEarlyoomSettings,
  nameToRegex,
  parseEarlyoomDefault,
  type EarlyoomSettings,
} from './earlyoom';

const USER_FILE =
  'EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(claude|claude-desktop|warp|zsh|bash|kwin_wayland|plasmashell|Xwayland|sddm|systemd.*)$ --prefer ^(chrome|vitest|node.\\(vitest\\)|node-MainThread|node|npm)$"\n';

const SETTINGS: EarlyoomSettings = {
  memTerm: 8, memKill: 5, swapTerm: 35, swapKill: 25,
  prefer: ['chrome', 'vitest', 'node..vitest.', 'node-MainThread', 'node', 'npm'],
};

describe('nameToRegex', () => {
  test.each([
    ['node (vitest)', 'node..vitest.'],
    ['tmux: server', 'tmux..server'],
    ['a{1}[b]<c>&d#e;', 'a.1..b..c..d.e.'],
    ['gnome-terminal-', 'gnome-terminal-'],
    ['c++', 'c..'],
    ['a\\b', 'a.b'],
    ['é', '.'],
    ['gnome-terminal-server', 'gnome-terminal-'],
    ['abcdefghijklmnopq', 'abcdefghijklmno'],
    ['abcdefghijklmnéz', 'abcdefghijklmn'],
  ])('%s → %s', (name, re) => expect(nameToRegex(name)).toBe(re));
});

describe('ignoreList', () => {
  test('base puis noms exacts de la liste protégée, sans doublon, regex ignorées', () => {
    expect(ignoreList(DEFAULT_CONFIG.protected)).toEqual([
      ...EARLYOOM_BASE_IGNORE,
      'fish', 'sh', 'konsole', 'gnome-terminal-', 'kitty', 'alacritty', 'wezterm-gui', 'ghostty', 'tmux..server',
      'kwin_x11', 'gnome-shell', 'Xorg', 'gdm',
    ]);
  });
  test('aucun élément avec espace ou antislash', () => {
    for (const p of ignoreList([...DEFAULT_CONFIG.protected, 'a b', 'x\\y'])) expect(p).not.toMatch(/[ \\]/);
  });
  test('terminaux et Claude toujours présents, même avec une liste protégée vide', () => {
    const l = ignoreList([]);
    for (const n of ['warp', 'zsh', 'bash', 'claude', 'claude-desktop']) expect(l).toContain(n);
  });
  test('nom vide ignoré', () => {
    expect(ignoreList([''])).toEqual([...EARLYOOM_BASE_IGNORE]);
  });
});

describe('checkRegexPart', () => {
  test('motif accepté', () => expect(checkRegexPart('node..vitest.')).toBeNull());
  test('espace', () => expect(checkRegexPart('node (vitest)')).toMatch(/espace/));
  test('antislash', () => expect(checkRegexPart('node.\\(vitest\\)')).toMatch(/antislash/));
  test('vide', () => expect(checkRegexPart('')).toMatch(/vide/));
  test.each(['systemd.*', 'node.*', 'a', 'node-MainThread', 'x_1.2-3'])('motif accepté : %s', (p) => expect(checkRegexPart(p)).toBeNull());
  test.each(['a(', '*x', '+', 'a)|(.*', '.*', 'a.*b', 'a**', 'a?', '(a)'])('grammaire refusée : %s', (p) =>
    expect(checkRegexPart(p)).not.toBeNull());
  test.each(['a|b', 'a"b', '$(rm)', 'a`b', "a'b", 'a;b', 'a#b', 'a{1}', '[ab]', 'a<b', 'a>b', 'a&b', 'tmux:x', 'a,b', 'clаude' /* а cyrillique */, 'ｃhrome'])('caractère interdit : %s', (p) =>
    expect(checkRegexPart(p)).toMatch(/caractère interdit/));
  test('trop long', () => expect(checkRegexPart('a'.repeat(101))).not.toBeNull());
  test('100 caractères acceptés', () => expect(checkRegexPart('a'.repeat(100))).toBeNull());
});

describe('ignoreConversions', () => {
  test('noms protégés transformés, affichés dans l’aperçu', () => {
    expect(ignoreConversions(DEFAULT_CONFIG.protected)).toEqual([{ name: 'tmux: server', re: 'tmux..server' }]);
    expect(ignoreConversions(['gnome-terminal-server'])).toEqual([{ name: 'gnome-terminal-server', re: 'gnome-terminal-' }]);
    expect(ignoreConversions(['a$(b)', '/^x/', ''])).toEqual([{ name: 'a$(b)', re: 'a..b.' }]);
  });
});

describe('EARLYOOM_TOKEN_CHARS', () => {
  test('liste blanche stricte des motifs', () => {
    expect(EARLYOOM_TOKEN_CHARS).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-');
    for (const c of ['$', '`', ';', "'", '"', '\\', ' ', '#', '{', '}', '[', ']', '<', '>', '&', ':', ',', '\n', '(', ')', '|', '*', '+', '?']) expect(EARLYOOM_TOKEN_CHARS).not.toContain(c);
  });
  test('EARLYOOM_LINE_RE construit depuis EARLYOOM_LINE_PATTERN', () => {
    expect(EARLYOOM_LINE_RE.source).toBe(new RegExp(EARLYOOM_LINE_PATTERN).source);
    expect(EARLYOOM_LINE_PATTERN).toContain(`[${EARLYOOM_TOKEN_CHARS}]+`);
  });
});

const BASE = 'claude|claude-desktop|warp|zsh|bash|kwin_wayland|kwin_wayland_wr|plasmashell|Xwayland|sddm|systemd.*';
describe('checkEarlyoomLine (politique, identique au script root)', () => {
  const ok = (l: string) => expect(checkEarlyoomLine(l)).toBeNull();
  const ko = (l: string) => expect(checkEarlyoomLine(l)).not.toBeNull();
  test('ligne valide', () => {
    ok(`EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE})$"`);
    ok(`EARLYOOM_ARGS="-m 50,50 -s 100,100 -r 0 --ignore ^(${BASE}|kitty|node.*)$ --prefer ^(chrome|node..vitest.)$"`);
    ok(`EARLYOOM_ARGS="-m 1,1 -s 1,1 -r 0 --ignore ^(${BASE})$"`);
  });
  test('ligne d’attaque de la revue refusée', () => ko('EARLYOOM_ARGS="-m 99,99 -s 100,100 -r 0 --ignore ^(x)$ --prefer ^(.*)$"'));
  test.each([
    ['-m 51,5', `EARLYOOM_ARGS="-m 51,5 -s 35,25 -r 0 --ignore ^(${BASE})$"`],
    ['-m 0,0', `EARLYOOM_ARGS="-m 0,0 -s 35,25 -r 0 --ignore ^(${BASE})$"`],
    ['-m 08,5', `EARLYOOM_ARGS="-m 08,5 -s 35,25 -r 0 --ignore ^(${BASE})$"`],
    ['-s 101,1', `EARLYOOM_ARGS="-m 8,5 -s 101,1 -r 0 --ignore ^(${BASE})$"`],
    ['kill > term (mém.)', `EARLYOOM_ARGS="-m 8,9 -s 35,25 -r 0 --ignore ^(${BASE})$"`],
    ['kill > term (swap)', `EARLYOOM_ARGS="-m 8,5 -s 35,36 -r 0 --ignore ^(${BASE})$"`],
    ['-r 1', `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 1 --ignore ^(${BASE})$"`],
    ['base absente', 'EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(x)$"'],
    ['base dans un autre ordre', `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE.replace('claude|claude-desktop', 'claude-desktop|claude')})$"`],
    ['base tronquée', `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE.replace('|systemd.*', '')})$"`],
    ['base modifiée', `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE.replace('systemd.*', 'systemdX*')})$"`],
    ['regex non compilable', `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE})$ --prefer ^(a()$"`],
    ['quantificateur en tête', `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE})$ --prefer ^(*x)$"`],
    ['sortie des ancres', `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE})$ --prefer ^(a)|(.*)$"`],
    ['prefer .*', `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE})$ --prefer ^(.*)$"`],
    ['alternative vide', `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE}|)$"`],
    ['antislash', `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE})$ --prefer ^(node.\\(vitest\\))$"`],
    ['4 096 caractères', `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE}|${'a'.repeat(4096 - 50 - BASE.length - 1)})$"`],
  ])('%s → refusé', (_n, l) => ko(l));
  test('4 095 caractères acceptés', () => {
    const l = `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE}|${'a'.repeat(4095 - 50 - BASE.length - 1)})$"`;
    expect(l.length).toBe(4095);
    ok(l);
  });
});

describe('buildEarlyoomArgs', () => {
  test('ligne de plus de 4 095 caractères refusée', () => {
    const many = Array.from({ length: 300 }, (_, i) => `n${String(i).padStart(4, '0')}${'x'.repeat(10)}`);
    const r = buildEarlyoomArgs({ memTerm: 8, memKill: 5, swapTerm: 35, swapKill: 25, prefer: [] }, many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/trop longue/);
  });
  test('ligne exacte', () => {
    const r = buildEarlyoomArgs(SETTINGS, ['claude']);
    expect(r).toEqual({
      ok: true,
      line: 'EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(claude|claude-desktop|warp|zsh|bash|kwin_wayland|kwin_wayland_wr|plasmashell|Xwayland|sddm|systemd.*)$ --prefer ^(chrome|vitest|node..vitest.|node-MainThread|node|npm)$"',
    });
    if (r.ok) expect(EARLYOOM_LINE_RE.test(r.line)).toBe(true);
  });
  test('prefer vide → pas de --prefer', () => {
    const r = buildEarlyoomArgs({ ...SETTINGS, prefer: [] }, []);
    expect(r.ok && r.line).toBe(
      'EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(claude|claude-desktop|warp|zsh|bash|kwin_wayland|kwin_wayland_wr|plasmashell|Xwayland|sddm|systemd.*)$"',
    );
    if (r.ok) expect(EARLYOOM_LINE_RE.test(r.line)).toBe(true);
  });
  test('liste protégée par défaut → ligne conforme', () => {
    const r = buildEarlyoomArgs(SETTINGS, DEFAULT_CONFIG.protected);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(EARLYOOM_LINE_RE.test(r.line)).toBe(true);
      expect(r.line).toContain('|tmux..server|');
    }
  });
  test.each<[string, Partial<EarlyoomSettings>]>([
    ['memKill > memTerm', { memKill: 9 }],
    ['memTerm 0', { memTerm: 0 }],
    ['memTerm 51', { memTerm: 51 }],
    ['swapTerm non entier', { swapTerm: 2.5 }],
    ['swapKill > swapTerm', { swapKill: 36 }],
    ['swapTerm 101', { swapTerm: 101 }],
    ['memKill 0', { memKill: 0 }],
  ])('erreur : %s', (_n, patch) => {
    const r = buildEarlyoomArgs({ ...SETTINGS, ...patch }, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });
  test('motif de préférence avec espace → erreur nommant le motif', () => {
    const r = buildEarlyoomArgs({ ...SETTINGS, prefer: ['node (vitest)'] }, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('node (vitest)');
  });
  test('31 motifs → erreur', () => {
    const r = buildEarlyoomArgs({ ...SETTINGS, prefer: Array.from({ length: 31 }, (_, i) => `p${i}`) }, []);
    expect(r.ok).toBe(false);
  });
  test('30 motifs acceptés', () => {
    expect(buildEarlyoomArgs({ ...SETTINGS, prefer: Array.from({ length: 30 }, (_, i) => `p${i}`) }, []).ok).toBe(true);
  });
});

describe('EARLYOOM_LINE_RE', () => {
  test('refuse antislash, espace dans une regex, guillemet', () => {
    expect(EARLYOOM_LINE_RE.test(USER_FILE.trim())).toBe(false);
    expect(EARLYOOM_LINE_RE.test('EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(a b)$"')).toBe(false);
    expect(EARLYOOM_LINE_RE.test('EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(a"b)$"')).toBe(false);
  });
});

describe('parseEarlyoomDefault', () => {
  test('fichier réel de l’utilisateur : antislash converti et signalé', () => {
    expect(parseEarlyoomDefault(USER_FILE)).toEqual({
      settings: SETTINGS,
      converted: ['node.\\(vitest\\)'],
      line: USER_FILE.trim(),
    });
  });
  test('ancienne config sans seuil KILL → moitié arrondie vers le bas', () => {
    const r = parseEarlyoomDefault('EARLYOOM_ARGS="-m 6 -s 30 -r 0"\n');
    expect(r?.settings).toMatchObject({ memTerm: 6, memKill: 3, swapTerm: 30, swapKill: 15, prefer: [] });
    expect(r?.converted).toEqual([]);
  });
  test('commentaires et lignes vides ignorés', () => {
    const text = '# Default settings\n\n#EARLYOOM_ARGS="-m 1 -s 1"\n  \nEARLYOOM_ARGS="-m 10,4 -s 50,20 -r 0"\n';
    expect(parseEarlyoomDefault(text)).toEqual({
      settings: { memTerm: 10, memKill: 4, swapTerm: 50, swapKill: 20, prefer: [] },
      converted: [],
      line: 'EARLYOOM_ARGS="-m 10,4 -s 50,20 -r 0"',
    });
  });
  test('sans EARLYOOM_ARGS → null', () => {
    expect(parseEarlyoomDefault('# rien\nFOO=1\n')).toBeNull();
    expect(parseEarlyoomDefault('')).toBeNull();
  });
  test('ligne générée relue à l’identique', () => {
    const r = buildEarlyoomArgs(SETTINGS, DEFAULT_CONFIG.protected);
    if (!r.ok) throw new Error('attendu ok');
    expect(parseEarlyoomDefault(r.line)).toEqual({ settings: SETTINGS, converted: [], line: r.line });
  });
});

describe('isEarlyoomSettings', () => {
  test('objet valide', () => expect(isEarlyoomSettings(SETTINGS)).toBe(true));
  test.each<[string, unknown]>([
    ['prefer non tableau', { ...SETTINGS, prefer: 'chrome' }],
    ['nombre en chaîne', { ...SETTINGS, memTerm: '8' }],
    ['null', null],
    ['prefer avec un nombre', { ...SETTINGS, prefer: [1] }],
    ['NaN', { ...SETTINGS, swapKill: Number.NaN }],
  ])('%s → faux', (_n, v) => expect(isEarlyoomSettings(v)).toBe(false));
});
