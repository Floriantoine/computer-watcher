// Le script root n'est jamais lancé via pkexec ici : il est exécuté directement, en tant qu'utilisateur, sur une
// COPIE de test où seules trois constantes changent (cible, systemctl, attente après redémarrage).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_CONFIG } from '../core/defaults';
import { buildEarlyoomArgs, checkEarlyoomLine, EARLYOOM_LINE_PATTERN, EARLYOOM_LINE_RE, parseEarlyoomDefault } from '../core/earlyoom';
import { applyEarlyoom, applyExitMessage, createEarlyoomApplier, EARLYOOM_APPLY_SCRIPT, earlyoomStatus, parseIsEnabled, PKEXEC, type ExecFn } from './earlyoom';

const cacheRoot = join(homedir(), '.cache');
mkdirSync(cacheRoot, { recursive: true });
const root = mkdtempSync(join(cacheRoot, 'pw-earlyoom-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const BASE = 'claude|claude-desktop|warp|zsh|bash|kwin_wayland|kwin_wayland_wr|plasmashell|Xwayland|sddm|systemd.*';
const OLD = 'EARLYOOM_ARGS="-m 6 -s 30 -r 0"\n';
const VALID = `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE})$ --prefer ^(chrome|vitest|node..vitest.|node-MainThread|node|npm)$"`;
const USER_LINE = 'EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(claude|claude-desktop|warp|zsh|bash|kwin_wayland|plasmashell|Xwayland|sddm|systemd.*)$ --prefer ^(chrome|vitest|node.\\(vitest\\)|node-MainThread|node|npm)$"';
// Forme de la ligne réellement installée (avril 2026) : liste protégée par défaut, préférences converties.
const CURRENT = `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE}|fish|sh|konsole|gnome-terminal-|kitty|alacritty|wezterm-gui|ghostty|tmux..server|kwin_x11|gnome-shell|Xorg|gdm)$ --prefer ^(chrome|vitest|node..vitest.|node-MainThread|node|npm)$"`;
const ATTACK = 'EARLYOOM_ARGS="-m 99,99 -s 100,100 -r 0 --ignore ^(x)$ --prefer ^(.*)$"';
const withBase = (rest: string) => `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE})$${rest}"`;

let dir = '';
let n = 0;
const newDir = () => {
  dir = join(root, `case-${n++}`);
  mkdirSync(dir);
};
beforeEach(newDir);

/**
 * Faux systemctl : journalise ses arguments. Valeurs par appel (n-ième appel du même verbe), séparées par des espaces :
 * FAKE_RESTART (codes de restart), FAKE_ACTIVE (codes de is-active), FAKE_NRESTARTS (sorties de show). Défaut 0.
 * FAKE_LOCK=1 : le 1er restart rend la cible non inscriptible (restauration impossible).
 */
const fakeSystemctl = (): string => {
  const p = join(dir, 'systemctl');
  writeFileSync(p, [
    '#!/usr/bin/bash',
    'echo "$*" >> "$FAKE_LOG"',
    'pick() { local -a l=($1); if (( $2 < ${#l[@]} )); then echo "${l[$2]}"; else echo 0; fi; }',
    'c=$(( $(grep -c -- "^$1 " "$FAKE_LOG") - 1 ))',
    'case $1 in',
    '  restart) [[ $c -eq 0 && ${FAKE_LOCK:-0} == 1 ]] && chmod 444 "$FAKE_TARGET"; exit "$(pick "${FAKE_RESTART:-}" $c)";;',
    '  is-active) exit "$(pick "${FAKE_ACTIVE:-}" $c)";;',
    '  show) pick "${FAKE_NRESTARTS:-}" $c; exit 0;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
};

/** Copie de test du script : seules la cible, systemctl et l'attente changent. */
function testScript(target: string, systemctl: string): string {
  const swaps: [string, string][] = [
    ['\ntarget=/etc/default/earlyoom\n', `\ntarget='${target}'\n`],
    ['\nsystemctl=/usr/bin/systemctl\n', `\nsystemctl='${systemctl}'\n`],
    ['\npause=2\n', '\npause=0\n'],
  ];
  let s = EARLYOOM_APPLY_SCRIPT;
  for (const [a, b] of swaps) {
    if (!s.includes(a)) throw new Error(`constante introuvable : ${a.trim()}`);
    s = s.replace(a, b);
  }
  return s;
}

interface RunOpts { arg?: string | null; existing?: string | null; restart?: string; active?: string; nrestarts?: string; lock?: boolean }
function runScript(o: RunOpts) {
  const target = join(dir, 'earlyoom');
  if (o.existing) writeFileSync(target, o.existing);
  const log = join(dir, 'log');
  const args = ['-c', testScript(target, fakeSystemctl()), 'proc-watch-earlyoom', ...(o.arg === null || o.arg === undefined ? [] : [o.arg])];
  const r = spawnSync('/usr/bin/bash', args, {
    env: {
      PATH: '/usr/bin:/bin', FAKE_LOG: log, FAKE_TARGET: target, FAKE_LOCK: o.lock ? '1' : '0',
      FAKE_RESTART: o.restart ?? '', FAKE_ACTIVE: o.active ?? '', FAKE_NRESTARTS: o.nrestarts ?? '',
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  const baks = readdirSync(dir).filter((f) => f.startsWith('earlyoom.bak-')).sort();
  return { code: r.status, stdout: r.stdout, target, calls, baks, read: () => (existsSync(target) ? readFileSync(target, 'utf8') : null) };
}

describe('script livré (constante)', () => {
  test('aucune variable d’environnement lue : seul ${1:-} est une valeur par défaut', () => {
    expect(EARLYOOM_APPLY_SCRIPT).not.toContain('${PW_');
    expect(EARLYOOM_APPLY_SCRIPT).not.toMatch(/PW_/);
    expect(EARLYOOM_APPLY_SCRIPT.match(/\$\{[^}]*:-[^}]*\}/g)).toEqual(['${1:-}']);
    expect(EARLYOOM_APPLY_SCRIPT).toContain('\ntarget=/etc/default/earlyoom\n');
    expect(EARLYOOM_APPLY_SCRIPT).toContain('\nsystemctl=/usr/bin/systemctl\n');
    expect(EARLYOOM_APPLY_SCRIPT).toContain('export PATH=/usr/bin:/bin LC_ALL=C\n');
    expect(EARLYOOM_APPLY_SCRIPT).toContain('\npause=2\n');
  });
  test('motif bash = EARLYOOM_LINE_PATTERN (même source que EARLYOOM_LINE_RE)', () => {
    expect(EARLYOOM_APPLY_SCRIPT).toContain(`\nre='${EARLYOOM_LINE_PATTERN}'\n`);
    expect(EARLYOOM_LINE_RE.source).toBe(new RegExp(EARLYOOM_LINE_PATTERN).source);
  });
  test('ne lit aucun fichier désigné par l’appelant (ligne en argument)', () => {
    for (const s of ['< "$', 'read ', 'stat ', 'grep ', 'cat ', 'source', '-f "$line"', '-e "$line"', '-L "$line"', '-p "$line"', '"$line" ;', '< $line']) expect(EARLYOOM_APPLY_SCRIPT).not.toContain(s);
    expect(EARLYOOM_APPLY_SCRIPT).toContain('line="${1:-}"');
    expect(EARLYOOM_APPLY_SCRIPT.match(/\$\{?1/g)).toEqual(['${1']);
    // $line n'apparaît que dans : test non vide, longueur, =~, printf.
    expect(EARLYOOM_APPLY_SCRIPT.match(/.*\$\{?#?line.*/g)?.map((l) => l.trim().slice(0, 18))).toEqual([
      '[[ -n "$line" ]] |', '(( ${#line} <= 409', '[[ "$line" =~ $re ', "{ printf '%s\\n' \"$",
    ]);
  });
  test('syntaxe bash valide', () => {
    expect(spawnSync('/usr/bin/bash', ['-n', '-c', EARLYOOM_APPLY_SCRIPT]).status).toBe(0);
  });
  test('pkexec par chemin absolu', () => expect(PKEXEC).toBe('/usr/bin/pkexec'));
});

describe('script root (exécuté directement, sans pkexec)', () => {
  test('ligne valide en argument, cible existante → écrite, copie .bak, redémarrage puis vérification', () => {
    const r = runScript({ arg: VALID, existing: OLD });
    expect(r.code).toBe(0);
    expect(r.read()).toBe(`${VALID}\n`);
    expect(r.baks).toHaveLength(1);
    expect(r.baks[0]).toMatch(/^earlyoom\.bak-\d{8}T\d{6}\.\d{3}$/);
    expect(readFileSync(join(dir, r.baks[0]), 'utf8')).toBe(OLD);
    expect(r.calls).toEqual(['restart earlyoom', 'show -p NRestarts --value earlyoom', 'show -p NRestarts --value earlyoom', 'is-active --quiet earlyoom']);
    expect(statSync(r.target).mode & 0o777).toBe(0o644);
    expect(existsSync(`${r.target}.proc-watch.tmp`)).toBe(false);
  });
  test('deux applications de suite → deux .bak, aucun écrasé', () => {
    runScript({ arg: VALID, existing: OLD });
    const r = runScript({ arg: withBase('') });
    expect(r.code).toBe(0);
    expect(r.baks).toHaveLength(2);
    expect(r.baks.map((b) => readFileSync(join(dir, b), 'utf8')).sort()).toEqual([OLD, `${VALID}\n`].sort());
  });
  test('.bak déjà présent au même nom → suffixe compteur', () => {
    // Le nom à la milliseconde est imprévisible : on occupe tous les noms possibles de la seconde courante et des 2 suivantes.
    const t = new Date();
    const p2 = (x: number) => String(x).padStart(2, '0');
    for (let k = 0; k < 3; k++) {
      const d = new Date(t.getTime() + k * 1000);
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}T${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      for (let ms = 0; ms < 1000; ms++) writeFileSync(join(dir, `earlyoom.bak-${stamp}.${String(ms).padStart(3, '0')}`), 'occupé');
    }
    const r = runScript({ arg: VALID, existing: OLD });
    expect(r.code).toBe(0);
    const fresh = r.baks.filter((b) => readFileSync(join(dir, b), 'utf8') === OLD);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatch(/\.\d{3}\.1$/);
    expect(r.baks.filter((b) => readFileSync(join(dir, b), 'utf8') === 'occupé')).toHaveLength(3000);
  });
  test('cible absente → écrite, pas de .bak', () => {
    const r = runScript({ arg: VALID, existing: null });
    expect(r.code).toBe(0);
    expect(r.read()).toBe(`${VALID}\n`);
    expect(r.baks).toEqual([]);
  });
  test.each<[string, RunOpts, number]>([
    ['ligne actuelle de l’utilisateur (antislash)', { arg: USER_LINE }, 11],
    ['ligne d’attaque de la revue', { arg: ATTACK }, 11],
    ['bonne forme mais SIGKILL > SIGTERM', { arg: VALID.replace('-m 8,5', '-m 8,9') }, 11],
    ['bonne forme mais swap SIGKILL > SIGTERM', { arg: VALID.replace('-s 35,25', '-s 35,36') }, 11],
    ['bornes : -m 51,5', { arg: VALID.replace('-m 8,5', '-m 51,5') }, 11],
    ['bornes : -s 101,5', { arg: VALID.replace('-s 35,25', '-s 101,5') }, 11],
    ['exclusions de base absentes', { arg: 'EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(kitty)$"' }, 11],
    ['regex non compilable a(', { arg: withBase(' --prefer ^(a()$') }, 11],
    ['quantificateur en tête *x', { arg: withBase(' --prefer ^(*x)$') }, 11],
    ['sortie des ancres a)|(.*', { arg: withBase(' --prefer ^(a)|(.*)$') }, 11],
    ['ligne de 4 096 caractères', { arg: withBase(` --prefer ^(${'a'.repeat(4096 - withBase(' --prefer ^()$').length)})$`) }, 11],
    ['ligne + saut de ligne', { arg: `${VALID}\n` }, 11],
    ['argument vide', { arg: '' }, 10],
    ['argument absent', { arg: null }, 10],
  ])('%s → refusé, cible inchangée, systemctl jamais appelé', (_name, o, code) => {
    const r = runScript({ ...o, existing: OLD });
    expect(r.code).toBe(code);
    expect(r.read()).toBe(OLD);
    expect(r.baks).toEqual([]);
    expect(r.calls).toEqual([]);
  });
  test('chemin d’un fichier contenant une ligne valide → 11 (le fichier n’est jamais ouvert)', () => {
    const p = join(dir, 'ligne');
    writeFileSync(p, `${VALID}\n`);
    const r = runScript({ arg: p, existing: OLD });
    expect(r.code).toBe(11);
    expect(r.read()).toBe(OLD);
    expect(r.calls).toEqual([]);
  });
  test('redémarrage en échec → 13, ancien contenu restauré, redémarré et vérifié', () => {
    const r = runScript({ arg: VALID, existing: OLD, restart: '1' });
    expect(r.code).toBe(13);
    expect(r.read()).toBe(OLD);
    expect(r.calls).toEqual(['restart earlyoom', 'restart earlyoom', 'show -p NRestarts --value earlyoom', 'show -p NRestarts --value earlyoom', 'is-active --quiet earlyoom']);
  });
  test('redémarrage « réussi » mais earlyoom inactif ensuite → 13, ancien contenu restauré', () => {
    const r = runScript({ arg: VALID, existing: OLD, active: '3' });
    expect(r.code).toBe(13);
    expect(r.read()).toBe(OLD);
    expect(r.calls).toEqual(['restart earlyoom', 'show -p NRestarts --value earlyoom', 'show -p NRestarts --value earlyoom', 'is-active --quiet earlyoom', 'restart earlyoom', 'show -p NRestarts --value earlyoom', 'show -p NRestarts --value earlyoom', 'is-active --quiet earlyoom']);
  });
  test('boucle de plantages (NRestarts augmente, service vu actif) → 13, ancien contenu restauré', () => {
    const r = runScript({ arg: VALID, existing: OLD, nrestarts: '0 2 0 0' });
    expect(r.code).toBe(13);
    expect(r.read()).toBe(OLD);
    expect(r.calls).toEqual(['restart earlyoom', 'show -p NRestarts --value earlyoom', 'show -p NRestarts --value earlyoom', 'restart earlyoom', 'show -p NRestarts --value earlyoom', 'show -p NRestarts --value earlyoom', 'is-active --quiet earlyoom']);
  });
  test('NRestarts identique et actif → 0', () => {
    expect(runScript({ arg: VALID, existing: OLD, nrestarts: '4 4' }).code).toBe(0);
  });
  test('inactif sans fichier précédent → 13, fichier retiré', () => {
    const r = runScript({ arg: VALID, existing: null, active: '3' });
    expect(r.code).toBe(13);
    expect(r.read()).toBeNull();
  });
  test('restauration impossible → 14, chemin du .bak sur la sortie', () => {
    const r = runScript({ arg: VALID, existing: OLD, restart: '1', lock: true });
    expect(r.code).toBe(14);
    expect(r.baks).toHaveLength(1);
    expect(r.stdout.trim()).toBe(join(dir, r.baks[0]));
    expect(readFileSync(join(dir, r.baks[0]), 'utf8')).toBe(OLD);
  });
  test('ancienne config restaurée mais earlyoom ne redémarre pas → 15', () => {
    const r = runScript({ arg: VALID, existing: OLD, active: '3', restart: '0 1' });
    expect(r.code).toBe(15);
    expect(r.read()).toBe(OLD);
    expect(r.calls).toEqual(['restart earlyoom', 'show -p NRestarts --value earlyoom', 'show -p NRestarts --value earlyoom', 'is-active --quiet earlyoom', 'restart earlyoom']);
  });
  test('ancienne config restaurée mais toujours inactive → 15', () => {
    const r = runScript({ arg: VALID, existing: OLD, active: '3 3' });
    expect(r.code).toBe(15);
    expect(r.read()).toBe(OLD);
  });
});

describe('même politique en TS et en bash (vrai bash)', () => {
  const corpus: string[] = [
    VALID,
    withBase(''),
    withBase('').replace(')$"', '|kitty|node)$"'),
    VALID.replace('-m 8,5', '-m 50,50').replace('-s 35,25', '-s 100,100'),
    VALID.replace('-m 8,5', '-m 1,1').replace('-s 35,25', '-s 1,1'),
    USER_LINE,
    ATTACK,
    VALID.replace('-m 8,5', '-m 8,9'),
    VALID.replace('-s 35,25', '-s 35,36'),
    VALID.replace('-m 8,5', '-m 08,5'),
    VALID.replace('-m 8,5', '-m 0,0'),
    VALID.replace('-r 0', '-r 1'),
    VALID.replace('claude|claude-desktop', 'claude-desktop|claude'),
    VALID.replace('|systemd.*', ''),
    withBase(' --prefer ^(a()$'),
    withBase(' --prefer ^(*x)$'),
    withBase(' --prefer ^(+)$'),
    withBase(' --prefer ^(a)|(.*)$'),
    withBase(' --prefer ^(.*)$'),
    withBase(' --prefer ^(a.*b)$'),
    withBase(' --prefer ^(a|)$'),
    VALID.replace('|npm', '|$(reboot)'),
    VALID.replace('|npm', '|`reboot`'),
    VALID.replace('|npm', '|a;reboot'),
    VALID.replace('|npm', "|a'b"),
    VALID.replace('|npm', '|a#b'),
    VALID.replace('|npm', '|a\nb'),
    `${VALID}\n`,
    VALID.replace('|npm', '|a b'),
    VALID.replace('|npm', '|a:b'),
    VALID.replace('|npm', '|a\\b'),
    VALID.replace('chrome', 'chrоme'), // о cyrillique
    VALID.replace('chrome', 'ｃhrome'), // c pleine chasse
    VALID.replace(' -r 0', ' -r 0'), // espace insécable
    VALID.replace('-m 8,5', '-m ٨,5'), // chiffre arabe-indien
    withBase(` --prefer ^(${'a'.repeat(4095 - withBase(' --prefer ^()$').length)})$`),
    withBase(` --prefer ^(${'a'.repeat(4096 - withBase(' --prefer ^()$').length)})$`),
    withBase('').replace(')$"', '|.*)$"'),
    withBase('').replace(')$"', '|...*)$"'),
    withBase('').replace(')$"', '|..)$"'),
    withBase(' --prefer ^(a|.)$'),
    withBase(' --prefer ^(..*)$'),
    withBase('').replace(')$"', '|.a|-|_)$"'),
    withBase(' --prefer ^(a..|..a.*)$'),
    withBase('').replace(')$"', '|a.*)$"'),
    withBase('').replace(')$"', '|node.*)$"'),
    withBase('').replace(')$"', '|kitty|node.*)$"'),
    withBase('').replace('|systemd.*', '|systemd.*|systemd.*'),
    CURRENT,
  ];
  test('[[ =~ ]] et EARLYOOM_LINE_RE : mêmes verdicts, sous 4 locales', () => {
    for (const line of corpus) {
      for (const lang of ['C', 'C.UTF-8', 'fr_FR.UTF-8', 'en_US.UTF-8']) {
        const r = spawnSync('/usr/bin/bash', ['-c', '[[ $1 =~ $2 ]]', 'x', line, EARLYOOM_LINE_PATTERN], { env: { PATH: '/usr/bin', LANG: lang, LC_ALL: lang } });
        expect({ line, lang, bash: r.status === 0 }).toEqual({ line, lang, bash: EARLYOOM_LINE_RE.test(line) });
      }
    }
  });
  test('script complet et checkEarlyoomLine : mêmes verdicts (le script refuse avec 11)', () => {
    const accepted: string[] = [];
    for (const line of corpus) {
      newDir();
      const r = runScript({ arg: line, existing: OLD });
      const ts = checkEarlyoomLine(line) === null;
      expect({ line, script: r.code !== 11 }).toEqual({ line, script: ts });
      if (ts) accepted.push(line);
    }
    expect(accepted).toEqual([corpus[0], corpus[1], corpus[2], corpus[3], corpus[4], corpus[35], corpus[42], corpus[43], corpus[48]]);
  });
  test('lignes générées acceptées par le script', () => {
    const cur = parseEarlyoomDefault(`${CURRENT}\n`);
    if (!cur) throw new Error('ligne actuelle non lue');
    const regen = buildEarlyoomArgs(cur.settings, DEFAULT_CONFIG.protected);
    expect(regen).toEqual({ ok: true, line: CURRENT });
    expect(runScript({ arg: CURRENT, existing: OLD }).code).toBe(0);
    const gen = buildEarlyoomArgs({ memTerm: 10, memKill: 4, swapTerm: 100, swapKill: 1, prefer: ['node.*'] }, DEFAULT_CONFIG.protected);
    if (!gen.ok) throw new Error(gen.errors.join());
    expect(runScript({ arg: gen.line, existing: OLD }).code).toBe(0);
  });
});

describe('applyExitMessage', () => {
  test.each<[number, string]>([
    [126, 'cancelled'], [127, 'unavailable'], [10, 'invalid'], [11, 'invalid'], [12, 'failed'], [13, 'failed'], [14, 'failed'], [15, 'failed'], [99, 'failed'],
  ])('%i → %s', (code, reason) => {
    const r = applyExitMessage(code, VALID);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe(reason);
      expect(r.message.length).toBeGreaterThan(10);
    }
  });
  test('0 → ok', () => expect(applyExitMessage(0, VALID)).toEqual({ ok: true, line: VALID }));
  test('127 → autorisation refusée ou pkexec indisponible', () => {
    const r = applyExitMessage(127, VALID);
    expect(!r.ok && r.message).toMatch(/^Autorisation refusée ou pkexec indisponible/);
  });
  test('13 → ancien fichier restauré', () => {
    const r = applyExitMessage(13, VALID);
    expect(!r.ok && r.message).toContain('restauré');
  });
  test('14 → restauration impossible, chemin du .bak', () => {
    const r = applyExitMessage(14, VALID, '/etc/default/earlyoom.bak-20261008T120000.123\n');
    expect(!r.ok && r.message).toBe('Restauration impossible : voir /etc/default/earlyoom.bak-20261008T120000.123');
    const r2 = applyExitMessage(14, VALID, 'n’importe quoi');
    expect(!r2.ok && r2.message).toBe('Restauration impossible : voir /etc/default/earlyoom.bak-…');
  });
  test('15 → earlyoom arrêté', () => {
    const r = applyExitMessage(15, VALID);
    expect(!r.ok && r.message).toBe('earlyoom arrêté : ancienne config restaurée mais le service ne redémarre pas.');
  });
  test('code inconnu cité', () => {
    const r = applyExitMessage(99, VALID);
    expect(!r.ok && r.message).toContain('99');
  });
});

describe('applyEarlyoom (pkexec simulé, ligne en argument)', () => {
  const capture = (res: { code: number; stdout?: string; timedOut?: boolean } | Error) => {
    const seen: { cmd: string; args: string[]; timeout?: number }[] = [];
    const run: ExecFn = async (cmd, args, opts) => {
      seen.push({ cmd, args, timeout: opts?.timeout });
      if (res instanceof Error) throw res;
      return { stdout: '', stderr: '', ...res };
    };
    return { run, seen };
  };
  test('0 → ok ; arguments exacts : la ligne elle-même, aucun fichier', async () => {
    const { run, seen } = capture({ code: 0 });
    expect(await applyEarlyoom(VALID, { run })).toEqual({ ok: true, line: VALID });
    expect(seen).toEqual([{ cmd: '/usr/bin/pkexec', args: ['/usr/bin/bash', '-c', EARLYOOM_APPLY_SCRIPT, 'proc-watch-earlyoom', VALID], timeout: 120_000 }]);
  });
  test('126 (pkexec annulé) → cancelled', async () => {
    expect(await applyEarlyoom(VALID, { run: capture({ code: 126 }).run })).toMatchObject({ ok: false, reason: 'cancelled' });
  });
  test('127 → unavailable', async () => {
    expect(await applyEarlyoom(VALID, { run: capture({ code: 127 }).run })).toMatchObject({ ok: false, reason: 'unavailable' });
  });
  test('14 → chemin du .bak repris de la sortie', async () => {
    const r = await applyEarlyoom(VALID, { run: capture({ code: 14, stdout: '/etc/default/earlyoom.bak-20261008T120000.123\n' }).run });
    expect(!r.ok && r.message).toContain('earlyoom.bak-20261008T120000.123');
  });
  test('délai dépassé → message dédié', async () => {
    const r = await applyEarlyoom(VALID, { run: capture({ code: -1, timedOut: true }).run });
    expect(r).toEqual({ ok: false, reason: 'failed', message: "Délai dépassé (120 s) : rien n'a été modifié si la fenêtre de mot de passe était encore ouverte." });
  });
  test('spawn ENOENT → unavailable', async () => {
    const err = Object.assign(new Error('spawn pkexec ENOENT'), { code: 'ENOENT' });
    expect(await applyEarlyoom(VALID, { run: capture(err).run })).toMatchObject({ ok: false, reason: 'unavailable' });
  });
  test('run qui lève → failed', async () => {
    expect(await applyEarlyoom(VALID, { run: capture(new Error('boum')).run })).toMatchObject({ ok: false, reason: 'failed' });
  });
  test.each([USER_LINE, ATTACK, VALID.replace('-m 8,5', '-m 8,9')])('ligne hors politique → invalid sans appeler pkexec', async (line) => {
    const { run, seen } = capture({ code: 0 });
    expect(await applyEarlyoom(line, { run })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(seen).toEqual([]);
  });
});

describe('createEarlyoomApplier (IPC earlyoom:apply)', () => {
  const settings = { memTerm: 8, memKill: 5, swapTerm: 35, swapKill: 25, prefer: ['chrome'] };
  const lineFor = (prot: string[]) => {
    const b = buildEarlyoomArgs(settings, prot);
    if (!b.ok) throw new Error('attendu ok');
    return b.line;
  };
  test('réglages invalides → invalid, ni confirmation ni pkexec', async () => {
    let calls = 0;
    const apply = createEarlyoomApplier(() => [], async () => { calls++; return true; }, async () => { calls++; return { ok: true, line: '' }; });
    expect(await apply({ memTerm: '8' }, '')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await apply({ ...settings, memKill: 9 }, '')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(calls).toBe(0);
  });
  test('ligne de l’aperçu différente de celle du main → refus, ni confirmation ni pkexec', async () => {
    let calls = 0;
    const apply = createEarlyoomApplier(() => ['kitty'], async () => { calls++; return true; }, async () => { calls++; return { ok: true, line: '' }; });
    const r = await apply(settings, lineFor([]));
    expect(r).toMatchObject({ ok: false, reason: 'invalid' });
    expect(!r.ok && r.message).toMatch(/aperçu/);
    expect(await apply(settings, 42)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(calls).toBe(0);
  });
  test('confirmation du main avec la ligne exacte, puis pkexec avec cette ligne', async () => {
    const shown: string[] = [];
    let got = '';
    const apply = createEarlyoomApplier(() => ['kitty'], async (l) => { shown.push(l); return true; }, async (l) => { got = l; return { ok: true, line: l }; });
    const expected = lineFor(['kitty']);
    expect(await apply(settings, expected)).toEqual({ ok: true, line: expected });
    expect(shown).toEqual([expected]);
    expect(got).toBe(expected);
    expect(got).toContain('|systemd.*|kitty)$ --prefer ^(chrome)$"');
  });
  test('confirmation refusée → cancelled, pas de pkexec', async () => {
    let pk = 0;
    const apply = createEarlyoomApplier(() => [], async () => false, async () => { pk++; return { ok: true, line: '' }; });
    expect(await apply(settings, lineFor([]))).toEqual({ ok: false, reason: 'cancelled', message: "Annulé : rien n'a été modifié." });
    expect(pk).toBe(0);
  });
  test('second appel concurrent refusé (pendant la confirmation aussi)', async () => {
    let release: (v: boolean) => void = () => {};
    const apply = createEarlyoomApplier(() => [], () => new Promise<boolean>((res) => { release = res; }), async (line) => ({ ok: true, line }));
    const first = apply(settings, lineFor([]));
    expect(await apply(settings, lineFor([]))).toEqual({ ok: false, reason: 'failed', message: 'Une application est déjà en cours.' });
    release(true);
    expect((await first).ok).toBe(true);
    const third = apply(settings, lineFor([]));
    release(true);
    expect((await third).ok).toBe(true);
  });
});

describe('earlyoomStatus', () => {
  const run = (out: Record<string, { code: number; stdout: string }>): ExecFn => async (cmd, args) => {
    const k = [cmd, ...args].join(' ');
    const r = out[k];
    if (!r) throw Object.assign(new Error(`ENOENT ${k}`), { code: 'ENOENT' });
    return { ...r, stderr: '' };
  };
  test('binaire absent → installed false, version null', async () => {
    const st = await earlyoomStatus({ run: run({}), exists: () => false, read: () => null, env: {} });
    expect(st).toMatchObject({ installed: false, version: null, file: null });
    expect(st.installHint).toBe('sudo pacman -S earlyoom && sudo systemctl enable --now earlyoom');
  });
  test('installé, actif, version, fichier lu', async () => {
    const st = await earlyoomStatus({
      run: run({
        '/usr/bin/earlyoom -v': { code: 0, stdout: 'earlyoom 1.9.0\n' },
        '/usr/bin/systemctl is-active earlyoom': { code: 0, stdout: 'active\n' },
      }),
      exists: (p) => p === '/usr/bin/earlyoom',
      read: (p) => (p === '/etc/default/earlyoom' ? `${USER_LINE}\n` : null),
      env: {},
    });
    expect(st).toMatchObject({ installed: true, version: '1.9.0', active: 'active' });
    expect(st.file?.converted).toEqual(['node.\\(vitest\\)']);
  });
  test('earlyoom -v écrit sur stderr (1.9.0) → version lue', async () => {
    const st = await earlyoomStatus({
      run: async (cmd) => (cmd === '/usr/bin/earlyoom' ? { code: 0, stdout: '', stderr: 'earlyoom 1.9.0\n' } : { code: 0, stdout: 'active\n', stderr: '' }),
      exists: () => true, read: () => null, env: {},
    });
    expect(st.version).toBe('1.9.0');
  });
  test('is-active qui sort inactive (code 3) → inactive', async () => {
    const st = await earlyoomStatus({
      run: run({ '/usr/bin/earlyoom -v': { code: 0, stdout: 'earlyoom 1.9.0' }, '/usr/bin/systemctl is-active earlyoom': { code: 3, stdout: 'inactive\n' } }),
      exists: () => true, read: () => null, env: {},
    });
    expect(st.active).toBe('inactive');
    expect(st.file).toBeNull();
  });
  test('sortie inattendue → unknown ; PROC_WATCH_EARLYOOM_BIN respecté', async () => {
    const seen: string[] = [];
    const st = await earlyoomStatus({
      run: async (cmd, args) => { seen.push(cmd); return { code: 1, stdout: args[0] === 'is-active' ? 'bizarre' : '', stderr: '' }; },
      exists: (p) => p === '/opt/eo', read: () => null, env: { PROC_WATCH_EARLYOOM_BIN: '/opt/eo' },
    });
    expect(st.installed).toBe(true);
    expect(st.active).toBe('unknown');
    expect(st.version).toBeNull();
    expect(seen).toContain('/opt/eo');
  });
  test('is-enabled lu par chemin absolu → enabled / disabled', async () => {
    const seen: string[] = [];
    const st = await earlyoomStatus({
      run: async (cmd, args) => {
        seen.push([cmd, ...args].join(' '));
        if (args[0] === 'is-enabled') return { code: 1, stdout: 'disabled\n', stderr: '' };
        if (args[0] === 'is-active') return { code: 3, stdout: 'inactive\n', stderr: '' };
        return { code: 0, stdout: 'earlyoom 1.9.0', stderr: '' };
      },
      exists: (p) => p === '/usr/bin/earlyoom', read: () => null, env: {},
    });
    expect(st).toMatchObject({ installed: true, active: 'inactive', enabled: 'disabled' });
    expect(seen.sort()).toEqual(['/usr/bin/earlyoom -v', '/usr/bin/systemctl is-active earlyoom', '/usr/bin/systemctl is-enabled earlyoom']);
  });
  test('non installé → enabled unknown, aucune commande lancée', async () => {
    const seen: string[] = [];
    const st = await earlyoomStatus({ run: async (c) => (seen.push(c), { code: 0, stdout: '', stderr: '' }), exists: () => false, read: () => null, env: {} });
    expect(st.enabled).toBe('unknown');
    expect(seen).toEqual([]);
  });
});

describe('parseIsEnabled', () => {
  test.each([
    ['enabled\n', 'enabled'], ['enabled-runtime', 'enabled'], ['disabled\n', 'disabled'], ['masked', 'masked'], ['masked-runtime', 'masked'],
    ['static', 'other'], ['not-found', 'other'], ['alias', 'other'], ['', 'unknown'], [undefined, 'unknown'], ['Failed to get unit file state: x', 'unknown'],
  ])('%j → %s', (out, want) => expect(parseIsEnabled(out)).toBe(want));
});
