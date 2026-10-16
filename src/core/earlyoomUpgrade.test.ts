// Mise à niveau de la protection anti-gel (défauts de la ligne earlyoom, octobre 2026) : détection et fusion, logique pure.
import { describe, expect, test } from 'vitest';
import { DEFAULT_CONFIG } from './defaults';
import { buildEarlyoomArgs, checkEarlyoomLine, EARLYOOM_BASE_IGNORE, EARLYOOM_LINE_RE, fileIgnoreTokens, ignoreFromLine, parseEarlyoomDefault } from './earlyoom';
import {
  EARLYOOM_ANTIGEL_PREFER, EARLYOOM_DEFAULT_SETTINGS, EARLYOOM_PREVIOUS_DEFAULTS, EARLYOOM_RECOMMENDED_MEM_TERM, EARLYOOM_TEST_PREFER,
  earlyoomUpgrade, reminderMode, setupSettings, upgradeLine, upgradeNeed,
} from './earlyoomSetup';

const NOW = 1_800_000_000_000;
const BASE = EARLYOOM_BASE_IGNORE.join('|');
const OLD_TESTS = 'vitest|node..vitest.|jest|pytest|playwright|cypress|mocha|karma|headless_shell|chrome-headless';
/** Ligne réellement installée par l'app avant octobre 2026 (liste protégée par défaut, anciens défauts recommandés). */
const OLD_INSTALLED = `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE}|fish|sh|konsole|gnome-terminal-|kitty|alacritty|wezterm-gui|ghostty|tmux..server|kwin_x11|gnome-shell|Xorg|gdm)$ --prefer ^(${OLD_TESTS})$"`;
/** Tout premier défaut : aucune préférence. */
const OLD_NO_PREFER = `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE})$"`;
const file = (line: string) => {
  const f = parseEarlyoomDefault(`${line}\n`);
  if (!f) throw new Error('ligne non lue');
  return f;
};
const ok = (r: ReturnType<typeof upgradeLine>): string => {
  if (!r.ok) throw new Error(r.errors.join(' · '));
  return r.line;
};
const preferOf = (line: string) => file(line).settings.prefer;
const running = { installed: true, active: 'active', enabled: 'enabled' } as const;

describe('nouveaux défauts recommandés', () => {
  test('MainThread, tsc et eslint en tête des préférences, puis les processus de test d’avant', () => {
    expect(EARLYOOM_ANTIGEL_PREFER).toEqual(['MainThread', 'tsc', 'eslint']);
    expect(EARLYOOM_TEST_PREFER).toEqual(['MainThread', 'tsc', 'eslint', ...OLD_TESTS.split('|')]);
  });
  test('SIGTERM à 10 %, SIGKILL toujours à 5 %, swap inchangé', () => {
    expect(EARLYOOM_RECOMMENDED_MEM_TERM).toBe(10);
    expect(EARLYOOM_DEFAULT_SETTINGS).toEqual({ memTerm: 10, memKill: 5, swapTerm: 35, swapKill: 25, prefer: [...EARLYOOM_TEST_PREFER] });
  });
  test('nouvelle ligne par défaut : validée par EARLYOOM_LINE_RE, exclusions de base intactes en tête', () => {
    const line = ok(buildEarlyoomArgs(EARLYOOM_DEFAULT_SETTINGS, []) as ReturnType<typeof upgradeLine>);
    expect(line).toBe(`EARLYOOM_ARGS="-m 10,5 -s 35,25 -r 0 --ignore ^(${BASE})$ --prefer ^(MainThread|tsc|eslint|${OLD_TESTS})$"`);
    expect(EARLYOOM_LINE_RE.test(line)).toBe(true);
    expect(checkEarlyoomLine(line)).toBeNull();
    expect(ignoreFromLine(line)).toEqual([...EARLYOOM_BASE_IGNORE]);
  });
  test('anciens défauts connus : sans préférence, puis avec les processus de test', () => {
    expect(EARLYOOM_PREVIOUS_DEFAULTS).toEqual([
      { memTerm: 8, memKill: 5, swapTerm: 35, swapKill: 25, prefer: [] },
      { memTerm: 8, memKill: 5, swapTerm: 35, swapKill: 25, prefer: OLD_TESTS.split('|') },
    ]);
  });
});

describe('ignoreFromLine', () => {
  test('exclusions d’une ligne conforme, dans l’ordre', () => {
    expect(ignoreFromLine(OLD_INSTALLED)).toEqual([...EARLYOOM_BASE_IGNORE, 'fish', 'sh', 'konsole', 'gnome-terminal-', 'kitty', 'alacritty', 'wezterm-gui', 'ghostty', 'tmux..server', 'kwin_x11', 'gnome-shell', 'Xorg', 'gdm']);
  });
  test('ligne hors politique (écrite à la main, antislash, -m 99) → null', () => {
    expect(ignoreFromLine('EARLYOOM_ARGS="-m 6 -s 30 -r 0"')).toBeNull();
    expect(ignoreFromLine(OLD_INSTALLED.replace('-m 8,5', '-m 99,5'))).toBeNull();
    expect(ignoreFromLine(OLD_INSTALLED.replace('|gdm', '|g\\(dm'))).toBeNull();
  });
});

describe('earlyoomUpgrade (détection « à mettre à jour »)', () => {
  test('ancien défaut exact (processus de test) → à mettre à jour : MainThread, tsc, eslint ajoutés, 8 → 10', () => {
    const u = earlyoomUpgrade(file(OLD_INSTALLED));
    expect(u).toEqual({
      oldDefaults: true,
      addedPrefer: ['MainThread', 'tsc', 'eslint'],
      memTerm: { from: 8, to: 10 },
      settings: { ...EARLYOOM_DEFAULT_SETTINGS, prefer: [...EARLYOOM_TEST_PREFER] },
    });
  });
  test('tout premier défaut (aucune préférence) → toute la liste recommandée', () => {
    const u = earlyoomUpgrade(file(OLD_NO_PREFER));
    expect(u?.oldDefaults).toBe(true);
    expect(u?.addedPrefer).toEqual([...EARLYOOM_TEST_PREFER]);
    expect(u?.settings).toEqual(EARLYOOM_DEFAULT_SETTINGS);
  });
  test('config perso sans MainThread → à mettre à jour, préférences de l’utilisateur gardées après les recommandées', () => {
    const line = `EARLYOOM_ARGS="-m 12,6 -s 20,10 -r 0 --ignore ^(${BASE}|kitty)$ --prefer ^(chrome|vitest|java.*)$"`;
    const u = earlyoomUpgrade(file(line));
    expect(u?.oldDefaults).toBe(false);
    expect(u?.memTerm).toBeNull(); // 12 > 10 : jamais abaissé
    expect(u?.settings).toEqual({
      memTerm: 12, memKill: 6, swapTerm: 20, swapKill: 10,
      prefer: ['MainThread', 'tsc', 'eslint', 'node..vitest.', 'jest', 'pytest', 'playwright', 'cypress', 'mocha', 'karma', 'headless_shell', 'chrome-headless', 'chrome', 'vitest', 'java.*'],
    });
  });
  test('memTerm plus bas que 10 → monté à 10 ; SIGKILL inchangé', () => {
    const u = earlyoomUpgrade(file(`EARLYOOM_ARGS="-m 4,2 -s 35,25 -r 0 --ignore ^(${BASE})$ --prefer ^(java)$"`));
    expect(u?.memTerm).toEqual({ from: 4, to: 10 });
    expect(u?.settings.memKill).toBe(2);
  });
  test('config déjà à jour (nouveau défaut) → rien', () => {
    expect(earlyoomUpgrade(file(ok(buildEarlyoomArgs(EARLYOOM_DEFAULT_SETTINGS, DEFAULT_CONFIG.protected) as ReturnType<typeof upgradeLine>)))).toBeNull();
  });
  test('config perso contenant déjà MainThread, tsc et eslint → rien, même avec SIGTERM à 6 %', () => {
    expect(earlyoomUpgrade(file(`EARLYOOM_ARGS="-m 6,3 -s 35,25 -r 0 --ignore ^(${BASE})$ --prefer ^(eslint|MainThread|tsc)$"`))).toBeNull();
  });
  test('jetons déjà couverts par un motif de l’utilisateur (Main.*, ts.*, es.*) → rien', () => {
    expect(earlyoomUpgrade(file(`EARLYOOM_ARGS="-m 10,5 -s 35,25 -r 0 --ignore ^(${BASE})$ --prefer ^(Main.*|ts.*|es.*)$"`))).toBeNull();
  });
  test('un seul jeton manquant → seulement celui-là (et les processus de test absents)', () => {
    const u = earlyoomUpgrade(file(`EARLYOOM_ARGS="-m 10,5 -s 35,25 -r 0 --ignore ^(${BASE})$ --prefer ^(MainThread|eslint|${OLD_TESTS})$"`));
    expect(u?.addedPrefer).toEqual(['tsc']);
    expect(u?.memTerm).toBeNull();
  });
  test('config illisible, absente ou hors politique → rien (jamais de fusion à l’aveugle)', () => {
    expect(earlyoomUpgrade(null)).toBeNull();
    expect(earlyoomUpgrade(file('EARLYOOM_ARGS="-m 6 -s 30 -r 0"'))).toBeNull(); // sans exclusions de base : écrite à la main
    expect(earlyoomUpgrade(file(OLD_INSTALLED.replace('|gdm', '|g\\(dm')))).toBeNull(); // antislash converti
    expect(earlyoomUpgrade({ settings: EARLYOOM_PREVIOUS_DEFAULTS[1]!, line: 'n’importe quoi' })).toBeNull();
  });
  test('trop de préférences pour tout ajouter (30 au plus) → seulement MainThread, tsc, eslint', () => {
    const many = Array.from({ length: 27 }, (_, i) => `p${i}`).join('|');
    const u = earlyoomUpgrade(file(`EARLYOOM_ARGS="-m 10,5 -s 35,25 -r 0 --ignore ^(${BASE})$ --prefer ^(${many})$"`));
    expect(u?.addedPrefer).toEqual(['MainThread', 'tsc', 'eslint']);
    expect(u?.settings.prefer).toHaveLength(30);
  });
  test('aucune place même pour MainThread, tsc, eslint → rien (on ne retire jamais un motif de l’utilisateur)', () => {
    const many = Array.from({ length: 29 }, (_, i) => `p${i}`).join('|');
    expect(earlyoomUpgrade(file(`EARLYOOM_ARGS="-m 10,5 -s 35,25 -r 0 --ignore ^(${BASE})$ --prefer ^(${many})$"`))).toBeNull();
  });
});

describe('upgradeLine (fusion)', () => {
  test('ancien défaut installé → nouvelle ligne : seuls -m et --prefer changent, exclusions identiques', () => {
    const line = ok(upgradeLine(file(OLD_INSTALLED), DEFAULT_CONFIG.protected));
    expect(line).toBe(OLD_INSTALLED.replace('-m 8,5', '-m 10,5').replace(`--prefer ^(${OLD_TESTS})$`, `--prefer ^(MainThread|tsc|eslint|${OLD_TESTS})$`));
    expect(checkEarlyoomLine(line)).toBeNull();
  });
  test('jamais une exclusion retirée : celles du fichier sont gardées même si la liste protégée les a perdues', () => {
    const line = ok(upgradeLine(file(OLD_INSTALLED), []));
    expect(ignoreFromLine(line)).toEqual(ignoreFromLine(OLD_INSTALLED));
  });
  test('exclusions de la liste protégée actuelle ajoutées après celles du fichier', () => {
    const line = ok(upgradeLine(file(OLD_NO_PREFER), ['kitty', 'node (dev)']));
    expect(ignoreFromLine(line)).toEqual([...EARLYOOM_BASE_IGNORE, 'kitty', 'node..dev.']);
  });
  test('exclusion du fichier plus longue que 15 caractères gardée telle quelle (jamais tronquée ni réinterprétée)', () => {
    const line = ok(upgradeLine(file(OLD_NO_PREFER.replace(')$"', '|un-nom-tres-long-de-processus)$"')), ['un-nom-tres-long-de-processus']));
    expect(ignoreFromLine(line)).toEqual([...EARLYOOM_BASE_IGNORE, 'un-nom-tres-long-de-processus', 'un-nom-tres-lon']);
  });
  test('idempotence : la ligne fusionnée n’est plus « à mettre à jour », et refusionner ne change rien', () => {
    for (const l of [OLD_INSTALLED, OLD_NO_PREFER, `EARLYOOM_ARGS="-m 4,2 -s 35,25 -r 0 --ignore ^(${BASE}|kitty)$ --prefer ^(java)$"`]) {
      const once = ok(upgradeLine(file(l), DEFAULT_CONFIG.protected));
      expect(earlyoomUpgrade(file(once))).toBeNull();
      const again = upgradeLine(file(once), DEFAULT_CONFIG.protected);
      expect(again).toEqual({ ok: false, errors: ['Rien à mettre à jour'] });
    }
  });
  test('rien à faire → refus explicite (aucune écriture)', () => {
    expect(upgradeLine(null, [])).toEqual({ ok: false, errors: ['Rien à mettre à jour'] });
  });
  test('préférences : toutes celles de l’utilisateur restent, dans l’ordre', () => {
    const line = ok(upgradeLine(file(`EARLYOOM_ARGS="-m 12,6 -s 20,10 -r 0 --ignore ^(${BASE})$ --prefer ^(chrome|java.*)$"`), []));
    const p = preferOf(line);
    expect(p.slice(-2)).toEqual(['chrome', 'java.*']);
    expect(p.slice(0, 3)).toEqual(['MainThread', 'tsc', 'eslint']);
  });
  test('ligne trop longue après fusion → refus (rien écrit)', () => {
    const toks: string[] = [];
    const lineWith = () => `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE}|${toks.join('|')})$"`;
    while (lineWith().length < 4050) toks.push(`p${String(toks.length).padStart(12, '0')}`);
    const big = lineWith();
    expect(checkEarlyoomLine(big)).toBeNull();
    const r = upgradeLine(file(big), []);
    expect(r.ok).toBe(false);
  });
});

describe('upgradeNeed (état du service)', () => {
  const f = file(OLD_INSTALLED);
  test('actif et lancé au démarrage, anciens défauts → à mettre à jour', () => expect(upgradeNeed({ ...running, file: f })).not.toBeNull());
  test('masqué (choix délibéré) → rien', () => expect(upgradeNeed({ installed: true, active: 'inactive', enabled: 'masked', file: f })).toBeNull());
  test('non installé ou inactif → c’est l’installation / l’activation qui est proposée, pas la mise à jour', () => {
    expect(upgradeNeed({ installed: false, active: 'unknown', enabled: 'unknown', file: f })).toBeNull();
    expect(upgradeNeed({ installed: true, active: 'inactive', enabled: 'enabled', file: f })).toBeNull();
    expect(upgradeNeed({ installed: true, active: 'active', enabled: 'disabled', file: f })).toBeNull();
  });
  test('état inconnu (systemctl muet) → rien', () => expect(upgradeNeed({ installed: true, active: 'unknown', enabled: 'unknown', file: f })).toBeNull());
  test('fichier absent ou illisible → rien', () => expect(upgradeNeed({ ...running, file: null })).toBeNull());
});

describe('reminderMode : pop-up « Protection anti-gel à mettre à jour »', () => {
  const status = { ...running, file: file(OLD_INSTALLED) };
  test('anciens défauts → upgrade', () => expect(reminderMode({ status, snoozedAt: undefined, later: false, now: NOW })).toBe('upgrade'));
  test('« Plus tard » respecté', () => expect(reminderMode({ status, snoozedAt: undefined, later: true, now: NOW })).toBeNull());
  test('pause de 7 jours respectée', () => expect(reminderMode({ status, snoozedAt: NOW - 3600_000, later: false, now: NOW })).toBeNull());
  test('installation / activation prioritaires', () =>
    expect(reminderMode({ status: { ...status, active: 'inactive' }, snoozedAt: undefined, later: false, now: NOW })).toBe('activate'));
  test('à jour → rien', () => {
    const fresh = file(ok(buildEarlyoomArgs(EARLYOOM_DEFAULT_SETTINGS, []) as ReturnType<typeof upgradeLine>));
    expect(reminderMode({ status: { ...running, file: fresh }, snoozedAt: undefined, later: false, now: NOW })).toBeNull();
  });
});

describe('setupSettings : l’activation applique aussi la mise à niveau', () => {
  test('fichier aux anciens défauts → réglages fusionnés (une seule saisie du mot de passe)', () => {
    expect(setupSettings(file(OLD_INSTALLED))).toEqual(EARLYOOM_DEFAULT_SETTINGS);
  });
  test('fichier perso à jour → ses réglages, inchangés', () => {
    const f = file(`EARLYOOM_ARGS="-m 6,3 -s 35,25 -r 0 --ignore ^(${BASE})$ --prefer ^(eslint|MainThread|tsc)$"`);
    expect(setupSettings(f)).toEqual(f.settings);
  });
});

describe('ligne lue presque conforme : jamais de blocage (retour arrière exponentiel du motif en JavaScript)', () => {
  test('30 exclusions suivies d’un antislash → refusée en moins de 50 ms', () => {
    const extra = Array.from({ length: 30 }, (_, i) => `processus-${i}`).join('|');
    for (const line of [
      `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE}|${extra}|g\\(dm)$"`,
      `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE}|${extra})$ --prefer ^(a\\b)$"`,
      `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE}|${extra}|a.*)$"`,
      `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE}|${extra})$ --prefer ^(.*)$"`,
      `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE}|${extra})$"x`,
    ]) {
      const t = performance.now();
      expect(checkEarlyoomLine(line)).not.toBeNull();
      expect(earlyoomUpgrade(file(line.endsWith('x') ? line.slice(0, -1).replace('-m 8,5', '-m 8,5 -x') : line))).toBeNull();
      expect(performance.now() - t).toBeLessThan(50);
    }
  });
});

describe('fileIgnoreTokens (revue I1 : exclusions d’un fichier non conforme)', () => {
  test('ligne conforme → ses exclusions', () => expect(fileIgnoreTokens(OLD_NO_PREFER.replace(')$"', '|kitty)$"'))).toEqual([...EARLYOOM_BASE_IGNORE, 'kitty']));
  test('aucun --ignore (fichier du paquet) → aucune', () => {
    expect(fileIgnoreTokens('EARLYOOM_ARGS="-r 3600"')).toEqual([]);
    expect(fileIgnoreTokens('EARLYOOM_ARGS=""')).toEqual([]);
  });
  test('ligne écrite à la main, exclusions représentables → reprises', () => {
    expect(fileIgnoreTokens("EARLYOOM_ARGS='-r 60 --ignore ^(postgres|Xorg|my-db)$'")).toEqual(['postgres', 'Xorg', 'my-db']);
    expect(fileIgnoreTokens('EARLYOOM_ARGS="-m 5 --ignore=^(postgres)$"')).toEqual(['postgres']);
    expect(fileIgnoreTokens('EARLYOOM_ARGS="--ignore postgres"')).toEqual(['postgres']);
  });
  test('exclusion non représentable (regex, antislash, .*) → null : on ne sait pas la reprendre', () => {
    expect(fileIgnoreTokens('EARLYOOM_ARGS="-r 60 --ignore ^(postgres|my\\(db\\))$"')).toBeNull();
    expect(fileIgnoreTokens('EARLYOOM_ARGS="--ignore ^(pg.*)$"')).toBeNull();
    expect(fileIgnoreTokens('EARLYOOM_ARGS="--ignore ^(a[0-9])$"')).toBeNull();
    expect(fileIgnoreTokens(`EARLYOOM_ARGS="--ignore ^(${'a'.repeat(101)})$"`)).toBeNull();
  });
});

describe('revue M1 : motif du fichier de plus de 100 caractères', () => {
  test('aucune proposition (sinon impasse : proposée mais jamais applicable)', () => {
    expect(earlyoomUpgrade(file(OLD_NO_PREFER.replace(')$"', `|${'a'.repeat(101)})$"`)))).toBeNull();
    expect(earlyoomUpgrade(file(`${OLD_NO_PREFER.slice(0, -1)} --prefer ^(${'b'.repeat(101)})$"`))).toBeNull();
  });
});
