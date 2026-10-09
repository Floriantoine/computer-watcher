// Mises à jour (main) : vérifications planifiées, pop-up, téléchargement et installation sur demande seulement.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CHECK_EVERY_MS,
  FIRST_CHECK_DELAY_MS,
  REPO_RELEASES_URL,
  initialUpdateState,
  isNewer,
  isReleaseUrl,
  popupVisible,
  reduceUpdate,
  shortNotes,
  type UpdateEvent,
  type UpdateMode,
  type UpdatePrefs,
  type UpdateView,
  validateUpdatePrefs,
} from '../core/update';

/** `notes` : texte, HTML (GitHub) ou liste de notes (electron-updater), réduit par shortNotes. */
export interface FoundRelease { version: string; notes: unknown; url: string }

/** Source des versions : electron-updater (AppImage) ou API GitHub (notification seulement). */
export interface UpdateBackend {
  check(allowPrerelease: boolean): Promise<FoundRelease | null>;
  /** AppImage seulement : téléchargement, sha512 vérifié par electron-updater avant de résoudre. */
  download?(onProgress: (percent: number) => void): Promise<void>;
  /** AppImage seulement : remplace le fichier et relance l'app (electron-updater). */
  install?(): void;
}

export type { UpdateView };

export interface UpdaterDeps {
  mode: UpdateMode;
  current: string;
  backend: UpdateBackend | null;
  loadPrefs(): UpdatePrefs;
  savePrefs(p: UpdatePrefs): void;
  send(v: UpdateView): void;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  setInterval(fn: () => void, ms: number): unknown;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export function createUpdateController(d: UpdaterDeps) {
  let state = initialUpdateState(d.mode, d.current);
  let checking: Promise<void> | null = null;
  const view = (): UpdateView => {
    const prefs = d.loadPrefs();
    return { state, prefs, popup: popupVisible(state, prefs, d.now()) };
  };
  const dispatch = (e: UpdateEvent) => {
    const next = reduceUpdate(state, e);
    if (next === state) return;
    state = next;
    d.send(view());
  };
  const active = () => d.mode !== 'off' && d.backend !== null;

  async function runCheck(): Promise<void> {
    const prefs = d.loadPrefs();
    dispatch({ type: 'check' });
    try {
      const r = await d.backend!.check(prefs.prerelease);
      const at = d.now();
      if (r && isNewer(r.version, d.current, prefs.prerelease)) {
        dispatch({ type: 'found', version: r.version.replace(/^v/, ''), notes: shortNotes(r.notes), url: isReleaseUrl(r.url) ? r.url : REPO_RELEASES_URL, at });
      } else dispatch({ type: 'none', at });
    } catch (e) {
      dispatch({ type: 'error', message: message(e), at: d.now() });
    }
  }

  return {
    view,
    start() {
      if (!active()) return;
      d.setTimeout(() => void this.check(false), FIRST_CHECK_DELAY_MS);
      d.setInterval(() => void this.check(false), CHECK_EVERY_MS);
    },
    /** `manual` : « Vérifier maintenant » (même si la vérification automatique est désactivée). */
    check(manual: boolean): Promise<void> {
      if (!active() || (!manual && !d.loadPrefs().enabled)) return Promise.resolve();
      if (state.phase === 'downloading') return Promise.resolve();
      if (state.phase === 'ready') {
        d.send(view()); // « Plus tard » expiré : le pop-up « Redémarrer et installer » revient
        return Promise.resolve();
      }
      checking ??= runCheck().finally(() => {
        checking = null;
      });
      return checking;
    },
    async download(): Promise<void> {
      const b = d.backend;
      if (d.mode !== 'install' || !b?.download) return;
      const before = state;
      dispatch({ type: 'download' });
      if (state === before || state.phase !== 'downloading') return;
      try {
        await b.download((percent) => dispatch({ type: 'progress', percent }));
        dispatch({ type: 'downloaded' });
      } catch (e) {
        dispatch({ type: 'error', message: message(e), at: d.now() });
      }
    },
    install(): void {
      if (d.mode !== 'install' || state.phase !== 'ready' || !d.backend?.install) return;
      d.backend.install();
    },
    later(): void {
      dispatch({ type: 'later', at: d.now() });
    },
    ignore(): void {
      const v = state.available?.version;
      if (!v || state.phase === 'downloading' || state.phase === 'ready') return;
      d.savePrefs({ ...d.loadPrefs(), ignoredVersion: v });
      d.send(view());
    },
    setPrefs(raw: unknown): UpdateView {
      if (typeof raw !== 'object' || raw === null) throw new Error('Réglage invalide');
      const r = raw as Record<string, unknown>;
      const next = { ...d.loadPrefs() };
      for (const k of ['enabled', 'prerelease'] as const) {
        if (r[k] === undefined) continue;
        if (typeof r[k] !== 'boolean') throw new Error('Réglage invalide');
        next[k] = r[k];
      }
      d.savePrefs(next);
      const v = view();
      d.send(v);
      return v;
    },
  };
}

export type UpdateController = ReturnType<typeof createUpdateController>;

/** Liste de l'API GitHub → version publiée la plus récente (brouillons exclus, préversions seulement si autorisées). */
export function pickRelease(list: unknown, allowPrerelease: boolean): FoundRelease | null {
  if (!Array.isArray(list)) return null;
  let best: FoundRelease | null = null;
  for (const r of list) {
    if (typeof r !== 'object' || r === null) continue;
    const { tag_name, html_url, body, draft, prerelease } = r as Record<string, unknown>;
    if (draft !== false || typeof tag_name !== 'string' || (prerelease === true && !allowPrerelease)) continue;
    const version = tag_name.replace(/^v/, '');
    if (!isNewer(version, best?.version ?? '0.0.0', allowPrerelease)) continue;
    best = { version, notes: typeof body === 'string' ? body : '', url: isReleaseUrl(html_url) ? html_url : REPO_RELEASES_URL };
  }
  return best;
}

/** Mode notification : un GET HTTPS de l'API publique, délai de 15 s, réponse limitée à 2 Mo. */
export function createReleasesApiBackend(o: { url: string; fetch: typeof fetch; timeoutMs?: number }): UpdateBackend {
  return {
    async check(allowPrerelease) {
      const res = await o.fetch(o.url, {
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'proc-watch-update-check' },
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > 2_000_000) throw new Error('Réponse trop grande');
      return pickRelease(JSON.parse(text), allowPrerelease);
    },
  };
}

/** updater.json (dossier de config) : lu une fois puis gardé en mémoire, écrit de façon atomique ; illisible → défauts. */
export function createPrefsStore(file: string) {
  let cache: UpdatePrefs | null = null;
  return {
    load(): UpdatePrefs {
      if (cache) return cache;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        raw = undefined;
      }
      cache = validateUpdatePrefs(raw);
      return cache;
    },
    save(p: UpdatePrefs): void {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n');
      renameSync(tmp, file);
      cache = p;
    },
  };
}
