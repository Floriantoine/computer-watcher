import { describe, expect, test } from 'vitest';
import { buildEarlyoomArgs } from './earlyoom';
import {
  detectPackageManager, EARLYOOM_DEFAULT_SETTINGS, EARLYOOM_REMINDER_SNOOZE_MS, isSetupMode, reminderMode, reminderSnoozed, setupNeed, setupSettings,
  PACKAGE_MANAGERS, validateEarlyoomReminder,
} from './earlyoomSetup';

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600_000;

describe('isSetupMode', () => {
  test.each(['install', 'activate'])('%s accepté', (m) => expect(isSetupMode(m)).toBe(true));
  test.each([
    'install; reboot', '--mode=x', 'install\n', '\ninstall', 'Install', 'INSTALL', ' install', 'install ', '-m 99', '', 'activate\0', 'reinstall', 'remove',
    null, undefined, 1, ['install'], { mode: 'install' },
  ])('%j refusé', (m) => expect(isSetupMode(m)).toBe(false));
});

describe('rappel « Ne plus rappeler pendant 7 jours »', () => {
  test('7 jours exactement', () => expect(EARLYOOM_REMINDER_SNOOZE_MS).toBe(7 * DAY));
  test('absent → pas en pause', () => expect(reminderSnoozed(undefined, NOW)).toBe(false));
  test('à l’instant → en pause', () => expect(reminderSnoozed(NOW, NOW)).toBe(true));
  test('6 j 23 h 59 → en pause', () => expect(reminderSnoozed(NOW - 7 * DAY + 60_000, NOW)).toBe(true));
  test('7 j pile → rappel de nouveau', () => expect(reminderSnoozed(NOW - 7 * DAY, NOW)).toBe(false));
  test('30 jours → rappel', () => expect(reminderSnoozed(NOW - 30 * DAY, NOW)).toBe(false));
  test('horodatage futur (horloge reculée, config éditée) → ignoré', () => {
    expect(reminderSnoozed(NOW + 1, NOW)).toBe(false);
    expect(reminderSnoozed(NOW + 365 * DAY, NOW)).toBe(false);
  });
  test.each([NaN, Infinity, -1, 1.5])('valeur aberrante %s → pas en pause', (v) => expect(reminderSnoozed(v, NOW)).toBe(false));

  test('validation de la config : objet { snoozedAt } entier ≥ 0', () => {
    expect(validateEarlyoomReminder({ snoozedAt: NOW })).toEqual({ snoozedAt: NOW });
    expect(validateEarlyoomReminder({ snoozedAt: NOW, autre: 1 })).toEqual({ snoozedAt: NOW });
  });
  test.each([undefined, null, 'x', [], {}, { snoozedAt: 'x' }, { snoozedAt: -5 }, { snoozedAt: 1.5 }, { snoozedAt: Infinity }])(
    '%j → absent (jamais une config invalide)',
    (v) => expect(validateEarlyoomReminder(v)).toBeUndefined(),
  );
});

describe('setupNeed', () => {
  test('non installé → install', () => expect(setupNeed({ installed: false, active: 'unknown', enabled: 'unknown' })).toBe('install'));
  test.each(['inactive', 'failed'] as const)('installé, %s → activate', (active) => {
    expect(setupNeed({ installed: true, active, enabled: 'enabled' })).toBe('activate');
    expect(setupNeed({ installed: true, active, enabled: 'disabled' })).toBe('activate');
  });
  test('actif mais désactivé au démarrage → activate', () => expect(setupNeed({ installed: true, active: 'active', enabled: 'disabled' })).toBe('activate'));
  test('actif et activé → rien', () => expect(setupNeed({ installed: true, active: 'active', enabled: 'enabled' })).toBeNull());
  test('masqué (choix délibéré) → rien', () => expect(setupNeed({ installed: true, active: 'inactive', enabled: 'masked' })).toBeNull());
  test('état inconnu (systemctl absent) → rien', () => expect(setupNeed({ installed: true, active: 'unknown', enabled: 'unknown' })).toBeNull());
});

describe('reminderMode (pop-up au lancement)', () => {
  const absent = { installed: false, active: 'unknown', enabled: 'unknown' } as const;
  test('non installé, ni pause ni « plus tard » → install', () => expect(reminderMode({ status: absent, snoozedAt: undefined, later: false, now: NOW })).toBe('install'));
  test('« Plus tard » dans cette session → rien', () => expect(reminderMode({ status: absent, snoozedAt: undefined, later: true, now: NOW })).toBeNull());
  test('pause de 7 jours en cours → rien', () => expect(reminderMode({ status: absent, snoozedAt: NOW - DAY, later: false, now: NOW })).toBeNull());
  test('pause expirée → install', () => expect(reminderMode({ status: absent, snoozedAt: NOW - 8 * DAY, later: false, now: NOW })).toBe('install'));
  test('pause datée du futur → ignorée', () => expect(reminderMode({ status: absent, snoozedAt: NOW + DAY, later: false, now: NOW })).toBe('install'));
  test('installé inactif → activate', () =>
    expect(reminderMode({ status: { installed: true, active: 'inactive', enabled: 'disabled' }, snoozedAt: undefined, later: false, now: NOW })).toBe('activate'));
  test('tout va bien → rien', () =>
    expect(reminderMode({ status: { installed: true, active: 'active', enabled: 'enabled' }, snoozedAt: undefined, later: false, now: NOW })).toBeNull());
});

describe('setupSettings (réglages de la ligne écrite à l’installation)', () => {
  test('aucun fichier → valeurs par défaut 8,5 / 35,25', () => {
    expect(setupSettings(null)).toEqual(EARLYOOM_DEFAULT_SETTINGS);
    expect(EARLYOOM_DEFAULT_SETTINGS).toEqual({ memTerm: 8, memKill: 5, swapTerm: 35, swapKill: 25, prefer: [] });
  });
  test('fichier existant valide → ses réglages', () => {
    const s = { memTerm: 10, memKill: 5, swapTerm: 20, swapKill: 10, prefer: ['node'] };
    expect(setupSettings({ settings: s })).toEqual(s);
  });
  test('fichier hors politique (-m 99) → valeurs par défaut', () => {
    expect(setupSettings({ settings: { memTerm: 99, memKill: 5, swapTerm: 35, swapKill: 25, prefer: [] } })).toEqual(EARLYOOM_DEFAULT_SETTINGS);
  });
  test('préférences invalides (.*) → valeurs par défaut', () => {
    expect(setupSettings({ settings: { memTerm: 8, memKill: 5, swapTerm: 35, swapKill: 25, prefer: ['.*'] } })).toEqual(EARLYOOM_DEFAULT_SETTINGS);
  });
  test('la ligne par défaut passe la politique, exclusions de base en tête', () => {
    const b = buildEarlyoomArgs(EARLYOOM_DEFAULT_SETTINGS, ['kitty']);
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.line).toBe('EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(claude|claude-desktop|warp|zsh|bash|kwin_wayland|kwin_wayland_wr|plasmashell|Xwayland|sddm|systemd.*|kitty)$"');
  });
});

describe('choix du gestionnaire (M1 : plusieurs présents → /etc/os-release)', () => {
  const only = (...paths: string[]) => (p: string) => paths.includes(p);
  const ALL = only('/usr/bin/pacman', '/usr/bin/apt-get', '/usr/bin/dnf', '/usr/bin/zypper');
  test('un seul présent → celui-là, sans lire os-release', () => {
    expect(detectPackageManager(only('/usr/bin/zypper'), null)).toEqual({ ok: true, pm: 'zypper' });
    expect(detectPackageManager(only('/usr/bin/apt-get'), 'ID=arch\n')).toEqual({ ok: true, pm: 'apt-get' });
  });
  test('aucun → none ; jamais par le PATH', () => {
    expect(detectPackageManager(only('/usr/local/bin/pacman', '/bin/pacman', 'pacman'), 'ID=arch')).toEqual({ ok: false, reason: 'none' });
  });
  test.each([
    ['ID=manjaro\nID_LIKE=arch\n', 'pacman'],
    ['ID=arch', 'pacman'],
    ['ID=debian\n', 'apt-get'],
    ['ID=linuxmint\nID_LIKE="ubuntu debian"\n', 'apt-get'],
    ['ID="ubuntu"\nID_LIKE=debian\n', 'apt-get'],
    ['ID=fedora\n', 'dnf'],
    ['ID="centos"\nID_LIKE="rhel fedora"\n', 'dnf'],
    ['ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n', 'zypper'],
    ["ID='sles'\nID_LIKE='suse'\n", 'zypper'],
  ] as const)('plusieurs présents, os-release %j → %s', (text, pm) => {
    expect(detectPackageManager(ALL, text)).toEqual({ ok: true, pm });
  });
  test.each([
    ['os-release absent', null],
    ['distribution inconnue', 'ID=gentoo\n'],
    ['deux familles', 'ID=arch\nID_LIKE=debian\n'],
    ['VERSION_ID ne compte pas', 'VERSION_ID=arch\nID=void\n'],
    ['PRETTY_NAME ne compte pas', 'PRETTY_NAME="arch"\n'],
    ['vide', ''],
  ])('plusieurs présents, %s → ambiguous', (_l, text) => {
    expect(detectPackageManager(ALL, text)).toEqual({ ok: false, reason: 'ambiguous' });
  });
  test('la famille désignée doit avoir son gestionnaire présent', () => {
    expect(detectPackageManager(only('/usr/bin/pacman', '/usr/bin/dnf'), 'ID=debian')).toEqual({ ok: false, reason: 'ambiguous' });
    expect(detectPackageManager(only('/usr/bin/pacman', '/usr/bin/dnf'), 'ID=fedora')).toEqual({ ok: true, pm: 'dnf' });
  });
});

describe('options des gestionnaires (M2 : ni recommandations ni suppressions)', () => {
  const args = (n: string) => PACKAGE_MANAGERS.find((m) => m.name === n)!.args.join(' ');
  test('apt-get --no-install-recommends --no-remove', () => expect(args('apt-get')).toMatch(/--no-install-recommends --no-remove/));
  test('dnf sans dépendances faibles', () => expect(args('dnf')).toContain('--setopt=install_weak_deps=False'));
  test('zypper --no-recommends', () => expect(args('zypper')).toContain('--no-recommends'));
  test('pacman --needed --noconfirm', () => expect(args('pacman')).toBe('-S --needed --noconfirm earlyoom'));
});
