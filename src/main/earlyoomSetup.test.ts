// Le script root d'installation n'est JAMAIS lancé via pkexec ici : il est exécuté directement, en tant qu'utilisateur,
// sur une COPIE de test où seules les constantes de chemin (cible, systemctl, earlyoom, gestionnaires de paquets) et
// l'attente changent. Aucun paquet n'est installé : les gestionnaires de paquets sont de faux scripts qui journalisent leur argv.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { EARLYOOM_LINE_PATTERN } from '../core/earlyoom';
import { PACKAGE_MANAGERS, type EarlyoomSetupMode } from '../core/earlyoomSetup';
import type { Config, EarlyoomStatus } from '../core/types';
import type { ExecFn } from './earlyoom';
import {
  createEarlyoomSetup, EARLYOOM_SETUP_SCRIPT, INSTALL_TIMEOUT_MS, keepEarlyoomReminder, setupConfirmation, snoozeReminder, setupEarlyoom, setupExitMessage, type SetupEvent,
} from './earlyoomSetup';

const cacheRoot = join(homedir(), '.cache');
mkdirSync(cacheRoot, { recursive: true });
const root = mkdtempSync(join(cacheRoot, 'pw-earlyoom-setup-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const BASE = 'claude|claude-desktop|warp|zsh|bash|kwin_wayland|kwin_wayland_wr|plasmashell|Xwayland|sddm|systemd.*';
const VALID = `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE}|kitty)$"`;
const OLD = 'EARLYOOM_ARGS="-m 10 -s 100"\n';

let dir = '';
let n = 0;
beforeEach(() => {
  dir = join(root, `case-${n++}`);
  mkdirSync(dir);
});

const writeExec = (p: string, lines: string[]) => {
  writeFileSync(p, `${lines.join('\n')}\n`);
  chmodSync(p, 0o755);
};

/** Faux systemctl (même principe que earlyoom.test.ts) : journalise, codes par appel dans FAKE_RESTART / FAKE_ACTIVE / FAKE_ENABLE. */
const fakeSystemctl = (): string => {
  const p = join(dir, 'systemctl');
  writeExec(p, [
    '#!/usr/bin/bash',
    'echo "systemctl $*" >> "$FAKE_LOG"',
    'pick() { local -a l=($1); if (( $2 < ${#l[@]} )); then echo "${l[$2]}"; else echo 0; fi; }',
    'c=$(( $(grep -c -- "^systemctl $1 " "$FAKE_LOG") - 1 ))',
    'case $1 in',
    '  enable) exit "$(pick "${FAKE_ENABLE:-}" $c)";;',
    '  disable) exit "$(pick "${FAKE_DISABLE:-}" $c)";;',
    '  restart) exit "$(pick "${FAKE_RESTART:-}" $c)";;',
    '  is-active) exit "$(pick "${FAKE_ACTIVE:-}" $c)";;',
    '  show) pick "${FAKE_NRESTARTS:-}" $c; exit 0;;',
    'esac',
    'exit 0',
  ]);
  return p;
};

/**
 * Faux gestionnaire de paquets. Lancé par le script sous `env -i` : il ne reçoit AUCUNE variable du test, donc ses
 * réglages (journal, code, faux binaire) sont écrits dans son texte. Journalise son nom, son argv, son environnement
 * (hors PWD/SHLVL/_ ajoutés par bash) et son stdin ; installe un faux earlyoom si le code est 0.
 */
const fakePm = (name: string, o: { log: string; earlyoom: string; code: number; noBin: boolean }): string => {
  const p = join(dir, name);
  writeExec(p, [
    '#!/usr/bin/bash',
    `env_=$(/usr/bin/env | /usr/bin/grep -v -E '^(PWD|SHLVL|_|OLDPWD)=' | /usr/bin/sort | /usr/bin/paste -sd ' ')`,
    `echo "${name} $* [env=$env_] [stdin=$(/usr/bin/readlink /proc/self/fd/0)]" >> '${o.log}'`,
    'echo "ligne 1 du gestionnaire"',
    'echo "erreur : impossible de joindre le miroir" >&2',
    ...(o.code === 0 && !o.noBin ? [`printf '#!/usr/bin/bash\\nexit 0\\n' > '${o.earlyoom}'`, `/usr/bin/chmod 755 '${o.earlyoom}'`] : []),
    `exit ${o.code}`,
  ]);
  return p;
};

/** Environnement vu par le gestionnaire : seulement ces trois variables (M3). */
const PM_ENV = '[env=DEBIAN_FRONTEND=noninteractive LC_ALL=C PATH=/usr/bin:/bin] [stdin=/dev/null]';

type PmName = (typeof PACKAGE_MANAGERS)[number]['name'];

/** Copie de test : chemins remplacés par des fichiers du dossier de test (absents si non demandés), pause 0. */
function testScript(o: { pms: PmName[]; pmCode: number; pmNoBin: boolean; osRelease: string | null }): { script: string; target: string; earlyoom: string } {
  const target = join(dir, 'earlyoom.conf');
  const earlyoom = join(dir, 'earlyoom-bin');
  const osRelease = join(dir, 'os-release');
  if (o.osRelease !== null) writeFileSync(osRelease, o.osRelease);
  const log = join(dir, 'log');
  const swaps: [string, string][] = [
    ['\ntarget=/etc/default/earlyoom\n', `\ntarget='${target}'\n`],
    ['\nsystemctl=/usr/bin/systemctl\n', `\nsystemctl='${fakeSystemctl()}'\n`],
    ['\nearlyoom=/usr/bin/earlyoom\n', `\nearlyoom='${earlyoom}'\n`],
    ['\npause=2\n', '\npause=0\n'],
    ['\nosrelease=/etc/os-release\n', `\nosrelease='${osRelease}'\n`],
  ];
  for (const m of PACKAGE_MANAGERS) {
    const path = o.pms.includes(m.name) ? fakePm(m.name, { log, earlyoom, code: o.pmCode, noBin: o.pmNoBin }) : join(dir, `absent-${m.name}`);
    swaps.push([`\n${m.varName}=${m.path}\n`, `\n${m.varName}='${path}'\n`]);
  }
  let s = EARLYOOM_SETUP_SCRIPT;
  for (const [a, b] of swaps) {
    if (!s.includes(a)) throw new Error(`constante introuvable : ${a.trim()}`);
    s = s.replace(a, b);
  }
  return { script: s, target, earlyoom };
}

interface RunOpts {
  args: string[];
  pms?: PmName[];
  existing?: string | null;
  binPresent?: boolean;
  pmCode?: number;
  pmNoBin?: boolean;
  restart?: string;
  active?: string;
  enable?: string;
  nrestarts?: string;
  disable?: string;
  /** Contenu de /etc/os-release (copie de test) ; null : absent. Défaut : absent. */
  osRelease?: string | null;
  env?: Record<string, string>;
}
function run(o: RunOpts) {
  const { script, target, earlyoom } = testScript({ pms: o.pms ?? [], pmCode: o.pmCode ?? 0, pmNoBin: !!o.pmNoBin, osRelease: o.osRelease ?? null });
  if (o.existing) writeFileSync(target, o.existing);
  if (o.binPresent) writeExec(earlyoom, ['#!/usr/bin/bash', 'exit 0']);
  const log = join(dir, 'log');
  const r = spawnSync('/usr/bin/bash', ['-c', script, 'proc-watch-earlyoom-setup', ...o.args], {
    env: {
      PATH: '/usr/bin:/bin', FAKE_LOG: log,
      FAKE_RESTART: o.restart ?? '', FAKE_ACTIVE: o.active ?? '', FAKE_ENABLE: o.enable ?? '', FAKE_NRESTARTS: o.nrestarts ?? '', FAKE_DISABLE: o.disable ?? '',
      // Ce que pkexec aurait déjà retiré, et que le script retire aussi pour le gestionnaire (M3).
      DISPLAY: ':0', XAUTHORITY: '/home/u/.Xauthority', TERM: 'xterm', SHELL: '/usr/bin/zsh',
      ...o.env,
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  const baks = readdirSync(dir).filter((f) => f.startsWith('earlyoom.conf.bak-')).sort();
  return {
    code: r.status, stdout: r.stdout, stderr: r.stderr, calls, baks, target,
    pmCalls: calls.filter((c) => !c.startsWith('systemctl ')),
    sysCalls: calls.filter((c) => c.startsWith('systemctl ')),
    read: () => (existsSync(target) ? readFileSync(target, 'utf8') : null),
  };
}

const START_CALLS = [
  'systemctl enable --now earlyoom', 'systemctl restart earlyoom',
  'systemctl show -p NRestarts --value earlyoom', 'systemctl show -p NRestarts --value earlyoom', 'systemctl is-active --quiet earlyoom',
];

describe('script d’installation livré (constante)', () => {
  test('syntaxe bash valide', () => expect(spawnSync('/usr/bin/bash', ['-n', '-c', EARLYOOM_SETUP_SCRIPT]).status).toBe(0));
  test('chemins absolus constants, PATH et locale fixés, umask 022', () => {
    for (const l of [
      'target=/etc/default/earlyoom', 'systemctl=/usr/bin/systemctl', 'earlyoom=/usr/bin/earlyoom', 'pacman=/usr/bin/pacman',
      'apt_get=/usr/bin/apt-get', 'dnf=/usr/bin/dnf', 'zypper=/usr/bin/zypper', 'pause=2', 'export PATH=/usr/bin:/bin LC_ALL=C', 'umask 022',
    ]) expect(EARLYOOM_SETUP_SCRIPT).toContain(`\n${l}\n`);
    expect(EARLYOOM_SETUP_SCRIPT).toContain(`\nre='${EARLYOOM_LINE_PATTERN}'\n`);
  });
  test('aucune variable d’environnement lue : toute variable référencée est assignée par le script', () => {
    const assigned = new Set([...EARLYOOM_SETUP_SCRIPT.matchAll(/(?:^|[\s;(])(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((m) => m[1]));
    for (const v of ['n1', 'n2']) assigned.add(v); // `local n1 n2`
    // Variables de boucle et de read (`for w in`, `read -r l`, `read -r -a words`).
    for (const m of EARLYOOM_SETUP_SCRIPT.matchAll(/\b(?:for|read(?: -r)?(?: -a)?)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) assigned.add(m[1]!);
    const used = new Set([...EARLYOOM_SETUP_SCRIPT.matchAll(/\$\{?#?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
    used.delete('BASH_REMATCH'); // tableau de bash rempli par =~, pas l'environnement
    for (const v of used) expect(assigned, `$${v} lu sans être assigné`).toContain(v);
    expect(EARLYOOM_SETUP_SCRIPT).not.toMatch(/\$\{[^}]*:-/); // aucune valeur par défaut d'environnement
    expect(EARLYOOM_SETUP_SCRIPT).not.toMatch(/PW_|PROC_WATCH/);
  });
  test('$1 et $2 lus une seule fois, après le contrôle du nombre d’arguments', () => {
    expect(EARLYOOM_SETUP_SCRIPT.match(/\$\{?[0-9@*]/g)).toEqual(['$1', '$2']);
    expect(EARLYOOM_SETUP_SCRIPT.indexOf('(( $# == 2 )) || exit 10')).toBeLessThan(EARLYOOM_SETUP_SCRIPT.indexOf('mode="$1"'));
  });
  test('ni le paquet ni le gestionnaire ne viennent de l’appelant : nom constant earlyoom', () => {
    for (const m of PACKAGE_MANAGERS) {
      expect(EARLYOOM_SETUP_SCRIPT).toContain(`pm=("$${m.varName}" ${m.args.join(' ')})`);
      expect(m.args.join(' ')).toMatch(/^[A-Za-z0-9 :=_-]+$/);
      expect(m.args.at(-1)).toBe('earlyoom');
    }
    expect(EARLYOOM_SETUP_SCRIPT).not.toMatch(/"\$(mode|line)"\s*(install|-S)/);
  });
  test('tout est validé avant d’installer : mode et ligne contrôlés avant le premier gestionnaire', () => {
    const firstPm = EARLYOOM_SETUP_SCRIPT.indexOf('"${pm[@]}"');
    expect(EARLYOOM_SETUP_SCRIPT.indexOf('[[ "$mode" == install || "$mode" == activate ]] || exit 10')).toBeLessThan(firstPm);
    expect(EARLYOOM_SETUP_SCRIPT.indexOf('[[ "$line" =~ $re ]] || exit 11')).toBeLessThan(firstPm);
  });
});

describe('installation : une branche par gestionnaire (faux binaires, argv journalisé)', () => {
  test.each([
    ['pacman', 'pacman -S --needed --noconfirm earlyoom'],
    ['apt-get', 'apt-get -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install -y --no-install-recommends --no-remove earlyoom'],
    ['dnf', 'dnf install -y --setopt=install_weak_deps=False earlyoom'],
    ['zypper', 'zypper --non-interactive install --no-recommends earlyoom'],
  ] as [PmName, string][])('%s seul → `%s`, ligne écrite, enable --now, vérifié', (pm, argv) => {
    const r = run({ args: ['install', VALID], pms: [pm], existing: OLD });
    expect(r.code).toBe(0);
    expect(r.pmCalls).toEqual([`${argv} ${PM_ENV}`]); // env -i : ni DISPLAY, ni XAUTHORITY, ni TERM, ni SHELL, ni FAKE_*
    expect(r.read()).toBe(`${VALID}\n`);
    expect(r.baks).toHaveLength(1);
    expect(readFileSync(join(dir, r.baks[0]), 'utf8')).toBe(OLD);
    expect(r.sysCalls).toEqual(START_CALLS);
    expect(r.stdout).toBe(''); // sortie du gestionnaire sur stderr (stdout réservé au chemin du .bak, code 14)
    expect(r.stderr).toContain('impossible de joindre le miroir');
  });
  test.each([
    ['ID=manjaro\nID_LIKE=arch\n', 'pacman'],
    ['ID=linuxmint\nID_LIKE="ubuntu debian"\n', 'apt-get'],
    ['ID="centos"\nID_LIKE="rhel fedora"\n', 'dnf'],
    ['ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n', 'zypper'],
  ] as [string, PmName][])('plusieurs gestionnaires, os-release %j → %s (M1)', (osRelease, pm) => {
    const r = run({ args: ['install', VALID], pms: ['zypper', 'dnf', 'apt-get', 'pacman'], osRelease });
    expect(r.code).toBe(0);
    expect(r.pmCalls).toHaveLength(1);
    expect(r.pmCalls[0]!.startsWith(`${pm} `)).toBe(true);
  });
  test.each([
    ['os-release absent', null],
    ['distribution inconnue', 'ID=gentoo\n'],
    ['deux familles présentes', 'ID=arch\nID_LIKE=fedora\n'],
    ['VERSION_ID et PRETTY_NAME ne comptent pas', 'VERSION_ID=arch\nPRETTY_NAME="debian"\nID=void\n'],
    ['glob dans la valeur', 'ID=*\nID_LIKE="[a-z]*"\n'],
    ['injection dans la valeur', 'ID="$(touch PWNED)"\nID_LIKE=`touch PWNED`\n'],
  ])('plusieurs gestionnaires, %s → 20, rien installé ni écrit', (_l, osRelease) => {
    const r = run({ args: ['install', VALID], pms: ['pacman', 'dnf'], osRelease, existing: OLD });
    expect(r.code).toBe(20);
    expect(r.calls).toEqual([]);
    expect(r.read()).toBe(OLD);
    expect(existsSync(join(dir, 'PWNED'))).toBe(false);
  });
  test('la famille désignée doit avoir son gestionnaire présent', () => {
    expect(run({ args: ['install', VALID], pms: ['pacman', 'dnf'], osRelease: 'ID=debian\n' }).code).toBe(20);
  });
  test('un seul gestionnaire présent : os-release ignoré', () => {
    const r = run({ args: ['install', VALID], pms: ['apt-get'], osRelease: 'ID=arch\n' });
    expect(r.code).toBe(0);
    expect(r.pmCalls[0]).toMatch(/^apt-get /);
  });
  test('fichier de config absent après installation → écrit, pas de .bak', () => {
    const r = run({ args: ['install', VALID], pms: ['dnf'] });
    expect(r.code).toBe(0);
    expect(r.read()).toBe(`${VALID}\n`);
    expect(r.baks).toEqual([]);
  });
});

describe('échecs d’installation', () => {
  test('aucun gestionnaire reconnu → 20, rien installé, rien écrit, aucun systemctl', () => {
    const r = run({ args: ['install', VALID], pms: [], existing: OLD });
    expect(r.code).toBe(20);
    expect(r.calls).toEqual([]);
    expect(r.read()).toBe(OLD);
    expect(r.baks).toEqual([]);
  });
  test.each([1, 100, 127])('gestionnaire en échec (code %i : réseau, verrou…) → 21, rien écrit, aucun systemctl', (code) => {
    const r = run({ args: ['install', VALID], pms: ['pacman'], pmCode: code, existing: OLD });
    expect(r.code).toBe(21);
    expect(r.pmCalls).toHaveLength(1);
    expect(r.sysCalls).toEqual([]);
    expect(r.read()).toBe(OLD);
    expect(r.baks).toEqual([]);
    expect(r.stderr).toContain('impossible de joindre le miroir');
  });
  test('installation « réussie » mais /usr/bin/earlyoom absent → 22, rien écrit', () => {
    const r = run({ args: ['install', VALID], pms: ['apt-get'], pmNoBin: true, existing: OLD });
    expect(r.code).toBe(22);
    expect(r.sysCalls).toEqual([]);
    expect(r.read()).toBe(OLD);
  });
});

describe('activation : installation sautée', () => {
  test('binaire présent → aucun gestionnaire appelé (même présent), ligne écrite, enable --now', () => {
    const r = run({ args: ['activate', VALID], pms: ['pacman', 'apt-get', 'dnf', 'zypper'], binPresent: true, existing: OLD });
    expect(r.code).toBe(0);
    expect(r.pmCalls).toEqual([]);
    expect(r.read()).toBe(`${VALID}\n`);
    expect(r.sysCalls).toEqual(START_CALLS);
  });
  test('binaire absent → 22, aucun gestionnaire appelé', () => {
    const r = run({ args: ['activate', VALID], pms: ['pacman'], existing: OLD });
    expect(r.code).toBe(22);
    expect(r.calls).toEqual([]);
    expect(r.read()).toBe(OLD);
  });
});

describe('restauration si le service ne démarre pas', () => {
  test('enable --now en échec → ancien fichier restauré, redémarré : 13', () => {
    const r = run({ args: ['activate', VALID], binPresent: true, existing: OLD, enable: '1 0' });
    expect(r.code).toBe(13);
    expect(r.read()).toBe(OLD);
    expect(r.baks).toHaveLength(1);
  });
  test('activation : inactif après démarrage → restauré et redémarré : 13', () => {
    const r = run({ args: ['activate', VALID], binPresent: true, existing: OLD, active: '3 0' });
    expect(r.code).toBe(13);
    expect(r.read()).toBe(OLD);
    expect(r.sysCalls).toEqual([...START_CALLS, ...START_CALLS]);
  });
  test('activation : boucle de plantages (NRestarts augmente) → restauré : 13', () => {
    const r = run({ args: ['activate', VALID], binPresent: true, existing: OLD, nrestarts: '0 2 0 0' });
    expect(r.code).toBe(13);
    expect(r.read()).toBe(OLD);
  });
  test('juste après une INSTALLATION : ancien fichier (celui du paquet) restauré puis disable --now, jamais relancé : 16 (M4)', () => {
    const r = run({ args: ['install', VALID], pms: ['pacman'], existing: OLD, active: '3' });
    expect(r.code).toBe(16);
    expect(r.read()).toBe(OLD);
    expect(r.sysCalls).toEqual([...START_CALLS, 'systemctl disable --now earlyoom']);
  });
  test('installation, boucle de plantages → 16, désactivé', () => {
    const r = run({ args: ['install', VALID], pms: ['pacman'], existing: OLD, nrestarts: '0 2' });
    expect(r.code).toBe(16);
    expect(r.sysCalls.at(-1)).toBe('systemctl disable --now earlyoom');
  });
  test('installation, désactivation impossible → 17', () => {
    const r = run({ args: ['install', VALID], pms: ['pacman'], existing: OLD, active: '3', disable: '1' });
    expect(r.code).toBe(17);
    expect(r.read()).toBe(OLD);
  });
  test('ne démarre pas non plus avec l’ancien fichier → 15 (ancien fichier en place)', () => {
    const r = run({ args: ['activate', VALID], binPresent: true, existing: OLD, restart: '1 1' });
    expect(r.code).toBe(15);
    expect(r.read()).toBe(OLD);
  });
  test('pas d’ancien fichier → nouveau supprimé (installation : 16, désactivé)', () => {
    const r = run({ args: ['install', VALID], pms: ['dnf'], active: '3' });
    expect(r.code).toBe(16);
    expect(r.read()).toBeNull();
  });
});

describe('corpus d’attaque (mode et ligne) : refusé avant toute action', () => {
  const nothingDone = (r: ReturnType<typeof run>) => {
    expect(r.calls).toEqual([]);
    expect(r.read()).toBe(OLD);
    expect(r.baks).toEqual([]);
  };
  test.each([
    'install; reboot', '--mode=x', '-m 99', 'install\n', '\ninstall', 'install ', ' install', 'INSTALL', 'Install', '$(reboot)', '`reboot`',
    'install && reboot', 'install|activate', 'install*', 'inst*', '?nstall', '[i]nstall', 'activate\nreboot', 'reinstall', 'remove', '', '-', '--', '-c',
  ])('mode %j → 10', (mode) => {
    const r = run({ args: [mode, VALID], pms: ['pacman'], binPresent: true, existing: OLD });
    expect(r.code).toBe(10);
    nothingDone(r);
  });
  test.each([
    ['ligne vide', ''],
    ['-m 99', VALID.replace('-m 8,5', '-m 99,99')],
    ['SIGKILL > SIGTERM', VALID.replace('-m 8,5', '-m 8,9')],
    ['base absente', 'EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(x)$"'],
    ['prefer .*', VALID.replace(')$"', ')$ --prefer ^(.*)$"')],
    ['saut de ligne', VALID.replace('|kitty', '|kitty\nEARLYOOM_ARGS="-m 99,99"')],
    ['saut de ligne final', `${VALID}\n`],
    ['substitution', VALID.replace('kitty', '$(reboot)')],
    ['option en plus', VALID.replace(')$"', ')$ --dryrun"')],
    ['option seule', '--mode=x'],
    ['-m 99 seul', '-m 99'],
    ['trop longue', VALID.replace('kitty', 'k'.repeat(5000))],
  ])('ligne : %s → refusée (10/11) sans installer', (_label, line) => {
    const r = run({ args: ['install', line], pms: ['pacman'], existing: OLD });
    expect([10, 11]).toContain(r.code);
    nothingDone(r);
  });
  test.each([
    ['aucun argument', []],
    ['mode seul', ['install']],
    ['trois arguments', ['install', VALID, 'reboot']],
    ['ligne en premier', [VALID, 'install']],
  ])('%s → 10', (_l, args) => {
    const r = run({ args, pms: ['pacman'], existing: OLD });
    expect(r.code).toBe(10);
    nothingDone(r);
  });
  test('variables d’environnement au nom des variables du script : sans effet', () => {
    const evil = join(dir, 'evil');
    const r = run({
      args: ['install', VALID], pms: ['pacman'], existing: OLD,
      env: { mode: 'x', line: 'x', re: '.*', pm: evil, pause: '99', bak: evil, first: evil, out: 'x', rc: '0', DEBIAN_FRONTEND: 'dialog' },
    });
    expect(r.code).toBe(0);
    expect(r.read()).toBe(`${VALID}\n`);
    expect(r.pmCalls[0]).toContain(PM_ENV);
    expect(existsSync(evil)).toBe(false);
  });
});

describe('setupExitMessage (un message français par code)', () => {
  const msg = (code: number, mode: EarlyoomSetupMode = 'install', stderr = '') => setupExitMessage(code, mode, VALID, '', stderr);
  test('0 → succès', () => {
    expect(msg(0)).toEqual({ ok: true, line: VALID });
  });
  test.each([
    [10, /Demande refusée/],
    [11, /Ligne refusée/],
    [12, /Écriture de \/etc\/default\/earlyoom impossible/],
    [13, /ancien fichier a été restauré/],
    [15, /ne redémarre pas/],
    [16, /earlyoom installé mais désactivé : la configuration ne démarrait pas/],
    [17, /n’a pas pu être désactivé/],
    [20, /Gestionnaire de paquets non reconnu ou ambigu/],
    [21, /Échec de l’installation du paquet earlyoom/],
    [22, /earlyoom introuvable/],
    [126, /Authentification annulée/],
    [127, /Autorisation refusée/],
    [99, /code 99/],
  ])('%i → %s', (code, re) => {
    const r = msg(code);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(re);
  });
  test('21 : dernière ligne du gestionnaire reprise, nettoyée et tronquée', () => {
    const r = msg(21, 'install', `bla\nerror: failed retrieving file 'earlyoom.pkg' \u001b[31mrouge\u001b[0m\n\n`);
    expect(!r.ok && r.message).toContain("error: failed retrieving file 'earlyoom.pkg'");
    expect(!r.ok && r.message).not.toContain('\u001b');
    const long = msg(21, 'install', 'x'.repeat(1000));
    expect(!long.ok && long.message.length).toBeLessThan(400);
  });
  test('14 : chemin du .bak repris seulement s’il a la forme attendue', () => {
    const ok = setupExitMessage(14, 'install', VALID, '/etc/default/earlyoom.bak-20261009T101010.123\n', '');
    expect(!ok.ok && ok.message).toContain('/etc/default/earlyoom.bak-20261009T101010.123');
    const bad = setupExitMessage(14, 'install', VALID, '/home/u/évil', '');
    expect(!bad.ok && bad.message).not.toContain('évil');
  });
});

describe('setupEarlyoom (pkexec simulé)', () => {
  test('argv figé : pkexec, bash -c SCRIPT, nom, mode, ligne ; délai de 10 min pour l’installation', async () => {
    const calls: { cmd: string; args: string[]; timeout?: number }[] = [];
    const run: ExecFn = async (cmd, args, opts) => {
      calls.push({ cmd, args, timeout: opts?.timeout });
      return { code: 0, stdout: '', stderr: '' };
    };
    const o = await setupEarlyoom('install', VALID, { run });
    expect(o.result).toEqual({ ok: true, line: VALID });
    expect(o.code).toBe(0);
    expect(calls).toEqual([{ cmd: '/usr/bin/pkexec', args: ['/usr/bin/bash', '-c', EARLYOOM_SETUP_SCRIPT, 'proc-watch-earlyoom-setup', 'install', VALID], timeout: INSTALL_TIMEOUT_MS }]);
    expect(INSTALL_TIMEOUT_MS).toBe(600_000);
  });
  test('activation : délai de 120 s', async () => {
    let t: number | undefined;
    await setupEarlyoom('activate', VALID, { run: async (_c, _a, o) => ((t = o?.timeout), { code: 0, stdout: '', stderr: '' }) });
    expect(t).toBe(120_000);
  });
  test('mode ou ligne refusés → aucun pkexec', async () => {
    const run = vi.fn<ExecFn>();
    expect((await setupEarlyoom('install; reboot' as EarlyoomSetupMode, VALID, { run })).result.ok).toBe(false);
    expect((await setupEarlyoom('install', VALID.replace('-m 8,5', '-m 99,99'), { run })).result.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  test('pkexec introuvable → message 127', async () => {
    const o = await setupEarlyoom('install', VALID, { run: async () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })) });
    expect(!o.result.ok && o.result.message).toMatch(/Autorisation refusée ou pkexec indisponible/);
  });
  test('délai dépassé (processus root impossible à tuer) → message clair, sans attendre la fin', async () => {
    let finish: (v: { code: number; stdout: string; stderr: string }) => void = () => {};
    const run: ExecFn = () => new Promise((res) => (finish = res));
    const o = await setupEarlyoom('install', VALID, { run, timeoutMs: 20 });
    expect(o.timedOut).toBe(true);
    expect(!o.result.ok && o.result.message).toMatch(/Délai dépassé \(10 min\)/);
    expect(!o.result.ok && o.result.message).toContain('gestionnaire de paquets peut-être occupé');
    let done = false;
    void o.done.then(() => (done = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false); // le verrou « une seule installation » tient jusqu'à la vraie fin
    finish({ code: 0, stdout: '', stderr: '' });
    await o.done;
  });
  test('délai signalé par execFile (tué avant l’authentification) → même message', async () => {
    const o = await setupEarlyoom('activate', VALID, { run: async () => ({ code: -1, stdout: '', stderr: '', timedOut: true }) });
    expect(!o.result.ok && o.result.message).toMatch(/Délai dépassé \(120 s\)/);
  });
});

describe('setupConfirmation (boîte native du main)', () => {
  test('installation : paquet, gestionnaire, ligne exacte, activation du service', () => {
    const c = setupConfirmation('install', 'pacman', VALID);
    expect(c.message).toBe('Installer et configurer earlyoom ?');
    expect(c.detail).toContain('Paquet : earlyoom');
    expect(c.detail).toContain('pacman -S --needed --noconfirm earlyoom');
    expect(c.detail).toContain(VALID);
    expect(c.detail).toContain('/etc/default/earlyoom');
    expect(c.detail).toContain('systemctl enable --now earlyoom');
    expect(c.confirm).toBe('Installer et configurer');
  });
  test('activation : pas de paquet', () => {
    const c = setupConfirmation('activate', null, VALID);
    expect(c.message).toBe('Configurer et activer earlyoom ?');
    expect(c.detail).not.toContain('Paquet');
    expect(c.detail).toContain(VALID);
    expect(c.detail).toContain('systemctl enable --now earlyoom');
    expect(c.confirm).toBe('Activer');
  });
});

describe('createEarlyoomSetup (IPC earlyoom:setup)', () => {
  const status = (s: Partial<EarlyoomStatus>): EarlyoomStatus => ({
    installed: false, version: null, active: 'unknown', enabled: 'unknown', file: null, installHint: '', ...s,
  });
  const make = (o: { st?: EarlyoomStatus; pm?: boolean; confirm?: boolean; protectedList?: string[]; code?: number } = {}) => {
    const confirms: { mode: string; pm: string | null; line: string }[] = [];
    const setups: { mode: string; line: string }[] = [];
    const events: SetupEvent[] = [];
    const handler = createEarlyoomSetup({
      status: async () => o.st ?? status({}),
      getProtected: () => o.protectedList ?? ['kitty'],
      exists: (p) => (o.pm ?? true) && p === '/usr/bin/pacman',
      confirm: async (c) => (confirms.push(c), o.confirm ?? true),
      setup: async (mode, line) => {
        setups.push({ mode, line });
        return { result: setupExitMessage(o.code ?? 0, mode, line, '', ''), code: o.code ?? 0, timedOut: false, done: Promise.resolve() };
      },
      log: (e) => events.push(e),
      now: () => 42,
    });
    return { handler, confirms, setups, events };
  };
  test('non installé + install → confirmation (pacman, ligne construite par le main), pkexec, événement', async () => {
    const m = make();
    const r = await m.handler('install');
    expect(r.ok).toBe(true);
    // nouvelle installation : les processus de test sont préférés par défaut
    const fresh = VALID.replace(')$"', ')$ --prefer ^(vitest|node..vitest.|jest|pytest|playwright|cypress|mocha|karma|headless_shell|chrome-headless)$"');
    expect(m.confirms).toEqual([{ mode: 'install', pm: 'pacman', line: fresh }]);
    expect(m.setups).toEqual([{ mode: 'install', line: fresh }]);
    expect(m.events).toEqual([{ ts: 42, type: 'earlyoom_setup', groupKey: null, detail: { mode: 'install', ok: true, code: 0 } }]);
  });
  test.each(['install; reboot', '--mode=x', 'install\n', '-m 99', null, 3, { mode: 'install' }])('mode %j → refusé sans rien lancer', async (mode) => {
    const m = make();
    const r = await m.handler(mode);
    expect(r.ok).toBe(false);
    expect(m.confirms).toEqual([]);
    expect(m.setups).toEqual([]);
    expect(m.events).toEqual([]);
  });
  test('mode qui ne correspond plus à l’état (activate alors que non installé) → refusé', async () => {
    const m = make();
    const r = await m.handler('activate');
    expect(r).toMatchObject({ ok: false, reason: 'stale' });
    expect(!r.ok && r.message).toMatch(/état d’earlyoom a changé/);
    expect(m.setups).toEqual([]);
  });
  test('déjà actif → rien à faire', async () => {
    const m = make({ st: status({ installed: true, active: 'active', enabled: 'enabled' }) });
    expect((await m.handler('activate')).ok).toBe(false);
    expect(m.setups).toEqual([]);
  });
  test('installé inactif + activate → réglages du fichier existant gardés', async () => {
    const file = { settings: { memTerm: 10, memKill: 4, swapTerm: 50, swapKill: 20, prefer: ['node'] }, converted: [], line: '' };
    const m = make({ st: status({ installed: true, active: 'inactive', enabled: 'disabled', file }) });
    await m.handler('activate');
    expect(m.confirms[0].pm).toBeNull();
    expect(m.setups[0].line).toBe(`EARLYOOM_ARGS="-m 10,4 -s 50,20 -r 0 --ignore ^(${BASE}|kitty)$ --prefer ^(node)$"`);
  });
  test('aucun gestionnaire reconnu → message 20 sans mot de passe', async () => {
    const m = make({ pm: false });
    const r = await m.handler('install');
    expect(!r.ok && r.message).toMatch(/Gestionnaire de paquets non reconnu/);
    expect(m.confirms).toEqual([]);
    expect(m.setups).toEqual([]);
  });
  test('plusieurs gestionnaires et os-release ambigu → refus sans mot de passe (M1)', async () => {
    const confirms: unknown[] = [];
    const handler = createEarlyoomSetup({
      status: async () => status({}), getProtected: () => [], exists: (p) => p === '/usr/bin/pacman' || p === '/usr/bin/apt-get',
      readOsRelease: () => 'ID=gentoo\n', confirm: async (c) => (confirms.push(c), true), log: () => {},
      setup: async () => { throw new Error('pkexec lancé'); },
    });
    const r = await handler('install');
    expect(!r.ok && r.message).toMatch(/Plusieurs gestionnaires de paquets/);
    expect(confirms).toEqual([]);
  });
  test('plusieurs gestionnaires, os-release clair → confirmé avec le bon', async () => {
    const confirms: { pm: string | null }[] = [];
    const handler = createEarlyoomSetup({
      status: async () => status({}), getProtected: () => [], exists: (p) => p === '/usr/bin/pacman' || p === '/usr/bin/apt-get',
      readOsRelease: () => 'ID=ubuntu\nID_LIKE=debian\n', confirm: async (c) => (confirms.push(c), false), log: () => {},
    });
    await handler('install');
    expect(confirms[0]!.pm).toBe('apt-get');
  });
  test('confirmation refusée → annulé, aucun pkexec, aucun événement', async () => {
    const m = make({ confirm: false });
    const r = await m.handler('install');
    expect(r).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(m.setups).toEqual([]);
    expect(m.events).toEqual([]);
  });
  test('échec → événement avec le code', async () => {
    const m = make({ code: 21 });
    const r = await m.handler('install');
    expect(r.ok).toBe(false);
    expect(m.events[0]).toMatchObject({ type: 'earlyoom_setup', detail: { mode: 'install', ok: false, code: 21 } });
  });
  test('un seul à la fois, confirmation comprise', async () => {
    let release: (v: boolean) => void = () => {};
    let asked = 0;
    const handler = createEarlyoomSetup({
      status: async () => status({}), getProtected: () => [], exists: (p) => p === '/usr/bin/pacman',
      confirm: () => (asked++ === 0 ? new Promise<boolean>((r) => (release = r)) : Promise.resolve(true)),
      setup: async (mode, line) => ({ result: setupExitMessage(0, mode, line, '', ''), code: 0, timedOut: false, done: Promise.resolve() }),
      log: () => {},
    });
    const first = handler('install');
    await new Promise((r) => setTimeout(r, 0));
    const second = await handler('install');
    expect(!second.ok && second.message).toMatch(/déjà en cours/);
    release(true);
    expect((await first).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect((await handler('install')).ok).toBe(true);
  });
  test('verrou gardé jusqu’à la vraie fin après un délai dépassé', async () => {
    let finish: () => void = () => {};
    const done = new Promise<void>((r) => (finish = r));
    const handler = createEarlyoomSetup({
      status: async () => status({}), getProtected: () => [], exists: (p) => p === '/usr/bin/pacman', confirm: async () => true,
      setup: async (mode, line) => ({ result: { ok: false, reason: 'failed', message: 'Délai dépassé' }, code: null, timedOut: true, done }),
      log: () => {},
    });
    expect((await handler('install')).ok).toBe(false);
    const again = await handler('install');
    expect(!again.ok && again.message).toMatch(/déjà en cours/);
    finish();
    await done;
    await new Promise((r) => setTimeout(r, 0));
    expect((await handler('install')).ok).toBe(false); // relancé (le faux setup rend toujours le délai)
  });
});

describe('rappel dans la config (main seul)', () => {
  const base = { version: 1 } as unknown as Config;
  test('« Ne plus rappeler pendant 7 jours » : horodatage du main', () => {
    expect(snoozeReminder(base, 1234).earlyoomReminder).toEqual({ snoozedAt: 1234 });
  });
  test('config:set du renderer : le rappel du main est gardé (jamais fourni, effacé ni avancé par le renderer)', () => {
    const cur = { ...base, earlyoomReminder: { snoozedAt: 10 } } as Config;
    expect(keepEarlyoomReminder({ ...base } as Config, cur).earlyoomReminder).toEqual({ snoozedAt: 10 });
    expect(keepEarlyoomReminder({ ...base, earlyoomReminder: { snoozedAt: 9e12 } } as Config, cur).earlyoomReminder).toEqual({ snoozedAt: 10 });
    const none = keepEarlyoomReminder({ ...base, earlyoomReminder: { snoozedAt: 9e12 } } as Config, base);
    expect('earlyoomReminder' in none).toBe(false);
  });
});

describe('verrou partagé avec « Appliquer »', () => {
  test('« Appliquer » en cours → installation refusée ; et inversement', async () => {
    const { createEarlyoomApplier } = await import('./earlyoom');
    const lock = { held: false };
    let release: (v: boolean) => void = () => {};
    const apply = createEarlyoomApplier(() => [], () => new Promise<boolean>((r) => (release = r)), async (line) => ({ ok: true, line }), lock);
    const setup = createEarlyoomSetup({
      status: async () => ({ installed: false, version: null, active: 'unknown', enabled: 'unknown', file: null, installHint: '' }),
      getProtected: () => [], exists: (p) => p === '/usr/bin/pacman', confirm: async () => true, log: () => {}, lock,
      setup: async (mode, line) => ({ result: setupExitMessage(0, mode, line, '', ''), code: 0, timedOut: false, done: Promise.resolve() }),
    });
    const settings = { memTerm: 8, memKill: 5, swapTerm: 35, swapKill: 25, prefer: [] };
    const pending = apply(settings, `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE})$"`);
    await new Promise((r) => setTimeout(r, 0));
    const r = await setup('install');
    expect(!r.ok && r.message).toMatch(/déjà en cours/);
    release(false);
    await pending;
    expect((await setup('install')).ok).toBe(true);
  });
});
