import { describe, expect, test } from 'vitest';
import {
  DEFAULT_UPDATE_PREFS,
  LATER_MS,
  compareVersions,
  initialUpdateState,
  isNewer,
  isReleaseUrl,
  popupVisible,
  reduceUpdate,
  shortNotes,
  testFeedFromEnv,
  updateMode,
  validateUpdatePrefs,
  type UpdateState,
} from './update';

const found = (version: string, at = 1000) => ({ type: 'found' as const, version, notes: 'Corrections', url: `https://github.com/Floriantoine/computer-watcher/releases/tag/v${version}`, at });
const start = (mode: UpdateState['mode'] = 'install') => initialUpdateState(mode, '0.1.0');

describe('compareVersions / isNewer', () => {
  test('ordre semver, préfixe v accepté', () => {
    expect(compareVersions('0.1.1', '0.1.0')).toBeGreaterThan(0);
    expect(compareVersions('v0.2.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
  });
  test('version illisible : jamais plus récente', () => {
    expect(isNewer('n/a', '0.1.0', false)).toBe(false);
    expect(isNewer('1.2', '0.1.0', false)).toBe(false);
    expect(isNewer('9.9.9', 'bad', false)).toBe(false);
  });
  test('jamais de retour en arrière ni de version égale', () => {
    expect(isNewer('0.0.9', '0.1.0', false)).toBe(false);
    expect(isNewer('0.1.0', '0.1.0', false)).toBe(false);
    expect(isNewer('0.1.1', '0.1.0', false)).toBe(true);
  });
  test('préversions seulement si le réglage les autorise', () => {
    expect(isNewer('0.2.0-beta.1', '0.1.0', false)).toBe(false);
    expect(isNewer('0.2.0-beta.1', '0.1.0', true)).toBe(true);
  });
});

describe('updateMode', () => {
  const base = { isPackaged: true, appImage: null, testFeed: null, installedElsewhere: false };
  test('source (non empaquetée) sans flux de test : aucune vérification', () => {
    expect(updateMode({ ...base, isPackaged: false })).toBe('off');
    expect(updateMode({ ...base, isPackaged: false, appImage: '/home/u/x.AppImage' })).toBe('off');
  });
  test('AppImage de ce processus, empaquetée : installation possible', () => {
    expect(updateMode({ ...base, appImage: '/home/u/Applications/proc-watch.AppImage' })).toBe('install');
  });
  test('pas une AppImage de ce processus (.deb, APPIMAGE hérité refusé) : notification seulement', () => {
    expect(updateMode(base)).toBe('notify');
    expect(updateMode({ ...base, isPackaged: false, testFeed: 'http://127.0.0.1:9/' })).toBe('notify');
  });
  test('AppImage lancée hors de la copie installée : « lancez proc-watch depuis le menu »', () => {
    expect(updateMode({ ...base, appImage: '/home/u/Téléchargements/proc-watch-0.1.0-x86_64.AppImage', installedElsewhere: true })).toBe('relaunch');
  });
  test('flux de test local : vérification même depuis les sources', () => {
    expect(updateMode({ ...base, isPackaged: false, appImage: '/home/u/a.AppImage', testFeed: 'http://127.0.0.1:9/' })).toBe('install');
  });
});

describe('testFeedFromEnv', () => {
  const flag = ['electron', '.', '--update-feed-test'];
  const T = 'a3f1c9e07b5d4c2e8f6a1b3c5d7e9f00a3f1c9e0';
  test('variable ET option --update-feed-test, adresse locale (boucle) en http(s), jeton aléatoire en tête du chemin, jamais empaquetée', () => {
    expect(testFeedFromEnv({ PROC_WATCH_UPDATE_FEED: `http://127.0.0.1:8123/${T}` }, false, flag)).toBe(`http://127.0.0.1:8123/${T}/`);
    expect(testFeedFromEnv({ PROC_WATCH_UPDATE_FEED: `http://localhost:8123/${T}/feed/` }, false, flag)).toBe(`http://localhost:8123/${T}/feed/`);
    expect(testFeedFromEnv({ PROC_WATCH_UPDATE_FEED: `http://127.0.0.1:8123/${T}` }, true, flag)).toBeNull();
    expect(testFeedFromEnv({ PROC_WATCH_UPDATE_FEED: `http://example.com/${T}/` }, false, flag)).toBeNull();
    expect(testFeedFromEnv({ PROC_WATCH_UPDATE_FEED: 'file:///tmp/x' }, false, flag)).toBeNull();
    expect(testFeedFromEnv({ PROC_WATCH_UPDATE_FEED: 'pas une url' }, false, flag)).toBeNull();
    expect(testFeedFromEnv({}, false, flag)).toBeNull();
  });
  test('R3 : sans jeton (ou jeton trop court) : refusé — un port local peut être pris par un autre utilisateur', () => {
    expect(testFeedFromEnv({ PROC_WATCH_UPDATE_FEED: 'http://127.0.0.1:8123' }, false, flag)).toBeNull();
    expect(testFeedFromEnv({ PROC_WATCH_UPDATE_FEED: 'http://127.0.0.1:8123/feed/' }, false, flag)).toBeNull();
    expect(testFeedFromEnv({ PROC_WATCH_UPDATE_FEED: 'http://127.0.0.1:8123/abc123/' }, false, flag)).toBeNull();
  });
  test('variable seule (héritée de la session) : ignorée', () => {
    expect(testFeedFromEnv({ PROC_WATCH_UPDATE_FEED: `http://127.0.0.1:8123/${T}` }, false, ['electron', '.'])).toBeNull();
  });
});

describe('isReleaseUrl', () => {
  test('pages des versions du dépôt en https seulement', () => {
    expect(isReleaseUrl('https://github.com/Floriantoine/computer-watcher/releases/tag/v0.1.1')).toBe(true);
    expect(isReleaseUrl('https://github.com/Floriantoine/computer-watcher/releases')).toBe(true);
    expect(isReleaseUrl('http://github.com/Floriantoine/computer-watcher/releases')).toBe(false);
    expect(isReleaseUrl('https://github.com/Floriantoine/computer-watcher-evil/releases')).toBe(false);
    expect(isReleaseUrl('https://evil.example/Floriantoine/computer-watcher/releases')).toBe(false);
    expect(isReleaseUrl(42)).toBe(false);
  });
  test('analyse de l’URL : hôte exact, pas de « .. », pas d’identifiants ni de port', () => {
    expect(isReleaseUrl('https://github.com/Floriantoine/computer-watcher/releases/../../../autre/depot')).toBe(false);
    expect(isReleaseUrl('https://github.com/Floriantoine/computer-watcher/releases/%2e%2e/%2E%2E/x')).toBe(false);
    expect(isReleaseUrl('https://github.com.evil.example/Floriantoine/computer-watcher/releases/')).toBe(false);
    expect(isReleaseUrl('https://github.com@evil.example/Floriantoine/computer-watcher/releases/')).toBe(false);
    expect(isReleaseUrl('https://u:p@github.com/Floriantoine/computer-watcher/releases/')).toBe(false);
    expect(isReleaseUrl('https://github.com:8443/Floriantoine/computer-watcher/releases/')).toBe(false);
    expect(isReleaseUrl('https://github.com/Floriantoine/computer-watcher/releasesX')).toBe(false);
  });
});

describe('shortNotes', () => {
  test('HTML retiré, espaces réduits, tronqué', () => {
    expect(shortNotes('<h2>Nouveautés</h2><ul><li>Plus rapide</li><li>Moins de &amp; mémoire</li></ul>')).toBe('Nouveautés Plus rapide Moins de & mémoire');
    const long = shortNotes('x'.repeat(1000), 50);
    expect(long.length).toBe(50);
    expect(long.endsWith('…')).toBe(true);
  });
  test('liste de notes (une par version) ou absente', () => {
    expect(shortNotes([{ version: '0.1.1', note: 'A' }, { version: '0.1.2', note: '<p>B</p>' }])).toBe('A B');
    expect(shortNotes(null)).toBe('');
    expect(shortNotes(undefined)).toBe('');
  });
});

describe('validateUpdatePrefs', () => {
  test('défauts : vérification active, pas de préversions', () => {
    expect(DEFAULT_UPDATE_PREFS).toEqual({ enabled: true, prerelease: false, ignoredVersion: null, lastRunVersion: null });
    expect(validateUpdatePrefs(undefined)).toEqual(DEFAULT_UPDATE_PREFS);
    expect(validateUpdatePrefs('x')).toEqual(DEFAULT_UPDATE_PREFS);
  });
  test('champ invalide → défaut de ce champ seulement', () => {
    expect(validateUpdatePrefs({ enabled: false, prerelease: 'oui', ignoredVersion: '0.2.0', lastRunVersion: 3 })).toEqual({
      enabled: false, prerelease: false, ignoredVersion: '0.2.0', lastRunVersion: null,
    });
    expect(validateUpdatePrefs({ ignoredVersion: 'pas une version' }).ignoredVersion).toBeNull();
  });
});

describe('reduceUpdate (machine à états)', () => {
  test('vérification → disponible → pop-up', () => {
    let s = reduceUpdate(start(), { type: 'check' });
    expect(s.phase).toBe('checking');
    s = reduceUpdate(s, found('0.1.1'));
    expect(s.phase).toBe('available');
    expect(s.available?.version).toBe('0.1.1');
    expect(s.lastCheck).toBe(1000);
    expect(popupVisible(s, DEFAULT_UPDATE_PREFS, 2000)).toBe(true);
  });
  test('aucune mise à jour : pas de pop-up', () => {
    const s = reduceUpdate(reduceUpdate(start(), { type: 'check' }), { type: 'none', at: 5 });
    expect(s.phase).toBe('idle');
    expect(s.lastResult).toBe('none');
    expect(popupVisible(s, DEFAULT_UPDATE_PREFS, 10)).toBe(false);
  });
  test('version trouvée qui n’est pas plus récente : ignorée (pas de retour en arrière)', () => {
    const s = reduceUpdate(start(), found('0.1.0'));
    expect(s.phase).toBe('idle');
    expect(s.available).toBeNull();
  });
  test('téléchargement : progression puis prête (sha512 vérifié par electron-updater)', () => {
    let s = reduceUpdate(start(), found('0.1.1'));
    s = reduceUpdate(s, { type: 'download' });
    expect(s.phase).toBe('downloading');
    expect(s.progress).toBe(0);
    s = reduceUpdate(s, { type: 'progress', percent: 42.4 });
    expect(s.progress).toBe(42.4);
    s = reduceUpdate(s, { type: 'progress', percent: 140 });
    expect(s.progress).toBe(100);
    s = reduceUpdate(s, { type: 'downloaded' });
    expect(s.phase).toBe('ready');
    expect(popupVisible(s, DEFAULT_UPDATE_PREFS, 0)).toBe(true);
  });
  test('téléchargement impossible en mode notification', () => {
    const s = reduceUpdate(initialUpdateState('notify', '0.1.0'), found('0.1.1'));
    expect(reduceUpdate(s, { type: 'download' })).toBe(s);
  });
  test('erreur de vérification : silencieuse ; erreur de téléchargement : dans le pop-up', () => {
    let s = reduceUpdate(reduceUpdate(start(), { type: 'check' }), { type: 'error', message: 'réseau', at: 7 });
    expect(s.phase).toBe('idle');
    expect(s.lastResult).toBe('error');
    expect(s.error).toBe('réseau');
    expect(popupVisible(s, DEFAULT_UPDATE_PREFS, 8)).toBe(false);
    s = reduceUpdate(reduceUpdate(start(), found('0.1.1')), { type: 'download' });
    s = reduceUpdate(s, { type: 'error', message: 'sha512 checksum mismatch', at: 9 });
    expect(s.phase).toBe('error');
    expect(s.available?.version).toBe('0.1.1');
    expect(popupVisible(s, DEFAULT_UPDATE_PREFS, 10)).toBe(true);
    // Réessayer
    expect(reduceUpdate(s, { type: 'download' }).phase).toBe('downloading');
  });
  test('erreur de vérification alors qu’une version est déjà proposée : la proposition reste', () => {
    let s = reduceUpdate(start(), found('0.1.1'));
    s = reduceUpdate(reduceUpdate(s, { type: 'check' }), { type: 'error', message: 'réseau', at: 7 });
    expect(s.phase).toBe('available');
    expect(s.available?.version).toBe('0.1.1');
  });
  test('version ignorée : pas de pop-up ; une version plus récente le fait revenir', () => {
    const s = reduceUpdate(start(), found('0.1.1'));
    const prefs = { ...DEFAULT_UPDATE_PREFS, ignoredVersion: '0.1.1' };
    expect(popupVisible(s, prefs, 0)).toBe(false);
    expect(popupVisible(reduceUpdate(s, found('0.1.2')), prefs, 0)).toBe(true);
  });
  test('« Plus tard » : caché pendant LATER_MS, puis revient', () => {
    const s = reduceUpdate(reduceUpdate(start(), found('0.1.1')), { type: 'later', at: 1000 });
    expect(popupVisible(s, DEFAULT_UPDATE_PREFS, 1000 + LATER_MS - 1)).toBe(false);
    expect(popupVisible(s, DEFAULT_UPDATE_PREFS, 1000 + LATER_MS)).toBe(true);
  });
  test('pendant un téléchargement ou une fois prête : une nouvelle vérification ne change rien', () => {
    let s = reduceUpdate(reduceUpdate(start(), found('0.1.1')), { type: 'download' });
    expect(reduceUpdate(s, { type: 'check' })).toBe(s);
    expect(reduceUpdate(s, found('0.1.2'))).toBe(s);
    s = reduceUpdate(s, { type: 'downloaded' });
    expect(reduceUpdate(s, { type: 'check' })).toBe(s);
  });
  test('« Plus tard » une fois téléchargée : caché, mais jamais pendant le téléchargement', () => {
    let s = reduceUpdate(reduceUpdate(start(), found('0.1.1')), { type: 'download' });
    expect(reduceUpdate(s, { type: 'later', at: 0 })).toBe(s);
    s = reduceUpdate(reduceUpdate(s, { type: 'downloaded' }), { type: 'later', at: 0 });
    expect(s.phase).toBe('ready');
    expect(popupVisible(s, DEFAULT_UPDATE_PREFS, 1)).toBe(false);
    expect(popupVisible(s, DEFAULT_UPDATE_PREFS, LATER_MS)).toBe(true);
  });
  test('vérification désactivée : pas de pop-up', () => {
    const s = reduceUpdate(start(), found('0.1.1'));
    expect(popupVisible(s, { ...DEFAULT_UPDATE_PREFS, enabled: false }, 0)).toBe(false);
  });
  test('échec de l’installation : erreur dans le pop-up (réessai possible)', () => {
    let s = reduceUpdate(reduceUpdate(reduceUpdate(start(), found('0.1.1')), { type: 'download' }), { type: 'downloaded' });
    s = reduceUpdate(s, { type: 'error', message: 'EACCES', at: 1 });
    expect(s.phase).toBe('error');
    expect(s.error).toBe('EACCES');
    expect(reduceUpdate(s, { type: 'download' }).phase).toBe('downloading');
  });
  test('installation échouée après le téléchargement : fichier vérifié et cible gardés, nouvel essai sans retélécharger', () => {
    let s = reduceUpdate(reduceUpdate(reduceUpdate(start(), found('0.1.1')), { type: 'download' }), { type: 'downloaded' });
    s = reduceUpdate(s, { type: 'installFailed', message: 'mv: Permission denied', file: '/home/u/.cache/proc-watch-updater/pending/p.AppImage', target: '/home/u/Apps/p.AppImage', at: 2 });
    expect(s.phase).toBe('error');
    expect(s.error).toBe('mv: Permission denied');
    expect(s.failedInstall).toEqual({ file: '/home/u/.cache/proc-watch-updater/pending/p.AppImage', target: '/home/u/Apps/p.AppImage' });
    // un nouveau téléchargement efface l'échec d'installation
    expect(reduceUpdate(s, { type: 'download' }).failedInstall).toBeNull();
    // seulement depuis « prête » ou un échec d'installation précédent
    expect(reduceUpdate(start(), { type: 'installFailed', message: 'x', file: null, target: null, at: 0 }).phase).toBe('idle');
  });
  test('retrait : une proposition (préversion désactivée) disparaît, sauf pendant le téléchargement', () => {
    const s = reduceUpdate(start(), found('0.2.0-beta.1'));
    const w = reduceUpdate(s, { type: 'withdraw' });
    expect(w.available).toBeNull();
    expect(w.phase).toBe('idle');
    const d = reduceUpdate(s, { type: 'download' });
    expect(reduceUpdate(d, { type: 'withdraw' })).toBe(d);
  });
  test('mode off : aucun événement ne change l’état', () => {
    const s = initialUpdateState('off', '0.1.0');
    expect(reduceUpdate(s, { type: 'check' })).toBe(s);
    expect(reduceUpdate(s, found('9.0.0'))).toBe(s);
  });
});
