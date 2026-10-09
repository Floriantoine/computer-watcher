// Mises à jour (logique pure) : mode selon le format d'installation, comparaison de versions, machine à états du pop-up.

/**
 * `install` : AppImage de ce processus (voir realAppImage), téléchargement (sha512 vérifié par electron-updater) puis
 * installation au redémarrage ;
 * `relaunch` : AppImage lancée hors de la copie installée (~/Applications/proc-watch.AppImage) : on ne met pas à jour
 * l'original téléchargé, on invite à lancer proc-watch depuis le menu ;
 * `notify` : .deb (ou autre version empaquetée) : notification et lien vers la page des versions, jamais d'installation ;
 * `off` : lancée depuis les sources, aucune vérification (sauf flux de test local).
 */
export type UpdateMode = 'off' | 'install' | 'relaunch' | 'notify';

export const REPO_RELEASES_URL = 'https://github.com/Floriantoine/proc-watcher/releases';
/** API publique : versions publiées (brouillons exclus par GitHub pour un accès anonyme). */
export const RELEASES_API_URL = 'https://api.github.com/repos/Floriantoine/proc-watcher/releases?per_page=20';
export const FIRST_CHECK_DELAY_MS = 30_000;
export const CHECK_EVERY_MS = 6 * 3600_000;
/** « Plus tard » : pop-up caché pendant 24 h (en mémoire : revient au prochain lancement). */
export const LATER_MS = 24 * 3600_000;

/** `appImage` : AppImage vérifiée de ce processus (realAppImage), jamais la variable APPIMAGE brute. */
export function updateMode(p: { isPackaged: boolean; appImage: string | null; testFeed: string | null; installedElsewhere: boolean }): UpdateMode {
  if (!p.isPackaged && !p.testFeed) return 'off';
  if (!p.appImage) return 'notify';
  return p.installedElsewhere ? 'relaunch' : 'install';
}

/** Option exigée en plus de PROC_WATCH_UPDATE_FEED : argv ne vient pas de l'environnement de session. */
export const TEST_FEED_FLAG = '--update-feed-test';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * PROC_WATCH_UPDATE_FEED : flux de test (http ou https sur la boucle locale), seulement avec l'option --update-feed-test
 * (passée par scripts/update-e2e.mjs) et jamais dans une version empaquetée.
 */
export function testFeedFromEnv(env: NodeJS.ProcessEnv, isPackaged: boolean, argv: readonly string[]): string | null {
  const raw = env.PROC_WATCH_UPDATE_FEED;
  if (isPackaged || !raw || !argv.includes(TEST_FEED_FLAG)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !LOOPBACK.has(u.hostname)) return null;
  // jeton aléatoire (≥ 32 caractères) en tête du chemin : un autre utilisateur local qui prendrait le port ne le connaît pas
  if (!/^\/[A-Za-z0-9_-]{32,}(\/|$)/.test(u.pathname)) return null;
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.toString();
}

const RELEASES_PATH = '/Floriantoine/proc-watcher/releases';

/**
 * Seules les pages des versions du dépôt sont ouvertes dans le navigateur : URL analysée, https://github.com exactement
 * (ni identifiants ni port), chemin sous /Floriantoine/proc-watcher/releases, aucun segment « .. » (même encodé).
 */
export function isReleaseUrl(url: unknown): url is string {
  if (typeof url !== 'string' || /\.\.|%2e/i.test(url)) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password) return false;
  return u.pathname === RELEASES_PATH || u.pathname.startsWith(`${RELEASES_PATH}/`);
}

interface Parsed { core: [number, number, number]; pre: (string | number)[] }

function parse(v: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : x)) : [];
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

export const isVersion = (v: unknown): v is string => typeof v === 'string' && parse(v) !== null;

/** Précédence semver (préversion < version finale) ; versions illisibles : 0 (jamais « plus récente »). */
export function compareVersions(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p - q;
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Strictement plus récente (jamais de retour en arrière) ; préversion seulement si autorisée. */
export function isNewer(candidate: string, current: string, allowPrerelease: boolean): boolean {
  const c = parse(candidate);
  if (!c || !parse(current)) return false;
  if (c.pre.length && !allowPrerelease) return false;
  return compareVersions(candidate, current) > 0;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

/** Notes de version en texte court : HTML retiré (GitHub les fournit en HTML), espaces réduits, au plus `max` caractères. */
export function shortNotes(raw: unknown, max = 280): string {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (Array.isArray(raw)) text = raw.map((n) => (n && typeof n === 'object' && typeof n.note === 'string' ? n.note : '')).join(' ');
  else return '';
  text = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITIES[e])
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Préférences gardées dans updater.json (dossier de config). */
export interface UpdatePrefs {
  enabled: boolean;
  prerelease: boolean;
  /** « Ignorer cette version » : plus de pop-up pour elle (une version plus récente le fait revenir). */
  ignoredVersion: string | null;
  /** Version au lancement précédent : une version différente relance le service d'enregistrement (nouveau code). */
  lastRunVersion: string | null;
}

export const DEFAULT_UPDATE_PREFS: UpdatePrefs = { enabled: true, prerelease: false, ignoredVersion: null, lastRunVersion: null };

export function validateUpdatePrefs(raw: unknown): UpdatePrefs {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_UPDATE_PREFS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_UPDATE_PREFS.enabled,
    prerelease: typeof r.prerelease === 'boolean' ? r.prerelease : DEFAULT_UPDATE_PREFS.prerelease,
    ignoredVersion: isVersion(r.ignoredVersion) ? r.ignoredVersion : null,
    lastRunVersion: isVersion(r.lastRunVersion) ? r.lastRunVersion : null,
  };
}

export interface UpdateOffer { version: string; notes: string; url: string }

export interface UpdateState {
  mode: UpdateMode;
  current: string;
  /** `error` : téléchargement échoué (une vérification échouée reste silencieuse, voir lastResult). */
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
  available: UpdateOffer | null;
  progress: number | null;
  error: string | null;
  lastCheck: number | null;
  lastResult: 'none' | 'available' | 'error' | null;
  /** « Plus tard » : pop-up caché jusqu'à cette heure (ms). */
  snoozedUntil: number | null;
  /**
   * Installation échouée après le téléchargement (l'ancienne AppImage a pu être supprimée avant l'échec du déplacement) :
   * fichier vérifié dans le cache d'electron-updater et AppImage à remplacer, pour le message et la commande de secours.
   */
  failedInstall: { file: string | null; target: string | null } | null;
}

/** Ce que le renderer reçoit : état, réglages et visibilité du pop-up (calculée par le main). */
export interface UpdateView { state: UpdateState; prefs: UpdatePrefs; popup: boolean }

export type UpdateEvent =
  | { type: 'check' }
  | { type: 'found'; version: string; notes: string; url: string; at: number }
  | { type: 'none'; at: number }
  | { type: 'error'; message: string; at: number }
  | { type: 'download' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded' }
  | { type: 'later'; at: number }
  | { type: 'installFailed'; message: string; file: string | null; target: string | null; at: number }
  /** Proposition retirée (préversions désactivées) ; sans effet pendant un téléchargement ou une fois prête. */
  | { type: 'withdraw' };

export function initialUpdateState(mode: UpdateMode, current: string): UpdateState {
  return { mode, current, phase: 'idle', available: null, progress: null, error: null, lastCheck: null, lastResult: null, snoozedUntil: null, failedInstall: null };
}

const busy = (s: UpdateState) => s.phase === 'downloading' || s.phase === 'ready';

export function reduceUpdate(s: UpdateState, e: UpdateEvent): UpdateState {
  if (s.mode === 'off') return s;
  switch (e.type) {
    case 'check':
      return busy(s) || s.phase === 'checking' ? s : { ...s, phase: 'checking' };
    case 'found': {
      if (busy(s)) return s;
      // La comparaison des préversions est faite par l'appelant (réglage) ; ici, jamais une version égale ou plus ancienne.
      if (compareVersions(e.version, s.current) <= 0 || !parse(e.version)) return { ...s, phase: 'idle', available: null, lastCheck: e.at, lastResult: 'none', error: null };
      const same = s.available?.version === e.version;
      return {
        ...s, phase: 'available', available: { version: e.version, notes: e.notes, url: e.url }, progress: null, error: null, lastCheck: e.at, lastResult: 'available',
        snoozedUntil: same ? s.snoozedUntil : null,
      };
    }
    case 'none':
      if (busy(s)) return s;
      return { ...s, phase: 'idle', available: null, error: null, lastCheck: e.at, lastResult: 'none' };
    case 'error':
      // téléchargement ou installation échoués : dans le pop-up, « Réessayer » (le fichier vérifié reste en cache)
      if (s.phase === 'downloading' || s.phase === 'ready') return { ...s, phase: 'error', progress: null, error: e.message, snoozedUntil: null };
      return { ...s, phase: s.available ? 'available' : 'idle', error: e.message, lastCheck: e.at, lastResult: 'error' };
    case 'download':
      if (s.mode !== 'install' || !s.available || (s.phase !== 'available' && s.phase !== 'error')) return s;
      return { ...s, phase: 'downloading', progress: 0, error: null, snoozedUntil: null, failedInstall: null };
    case 'progress':
      return s.phase === 'downloading' ? { ...s, progress: Math.max(0, Math.min(100, e.percent)) } : s;
    case 'downloaded':
      return s.phase === 'downloading' ? { ...s, phase: 'ready', progress: 100 } : s;
    case 'installFailed':
      if (s.phase !== 'ready' && !(s.phase === 'error' && s.failedInstall)) return s;
      return { ...s, phase: 'error', progress: null, error: e.message, snoozedUntil: null, failedInstall: { file: e.file, target: e.target } };
    case 'withdraw':
      return s.phase === 'available' || s.phase === 'error' ? { ...s, phase: 'idle', available: null, progress: null, error: null } : s;
    case 'later':
      return s.phase === 'downloading' ? s : { ...s, snoozedUntil: e.at + LATER_MS };
  }
}

/**
 * Pop-up affiché ? Une version proposée, ni ignorée ni remise à plus tard. Toujours pendant un téléchargement ; une fois
 * téléchargée (ou en échec), seul « Plus tard » le cache (la version a été demandée).
 */
export function popupVisible(s: UpdateState, prefs: UpdatePrefs, now: number): boolean {
  if (!s.available || s.mode === 'off') return false;
  if (s.phase === 'downloading') return true;
  const snoozed = s.snoozedUntil !== null && now < s.snoozedUntil;
  if (s.phase === 'ready' || s.phase === 'error') return !snoozed;
  if (!prefs.enabled || prefs.ignoredVersion === s.available.version) return false;
  return !snoozed;
}
