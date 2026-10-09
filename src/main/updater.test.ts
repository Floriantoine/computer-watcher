import { describe, expect, test, vi } from 'vitest';
import { DEFAULT_UPDATE_PREFS, type UpdateMode, type UpdatePrefs } from '../core/update';
import { InstallError, createPrefsStore, createReleasesApiBackend, createUpdateController, pickRelease, type UpdateBackend, type UpdateView } from './updater';

function setup(o: { mode?: UpdateMode; backend?: Partial<UpdateBackend> | null; prefs?: Partial<UpdatePrefs> } = {}) {
  let prefs: UpdatePrefs = { ...DEFAULT_UPDATE_PREFS, ...o.prefs };
  const views: UpdateView[] = [];
  const timers: { fn: () => void; ms: number; every: boolean }[] = [];
  let now = 1_000_000;
  const backend: UpdateBackend | null =
    o.backend === null ? null : { check: vi.fn(async () => ({ version: '0.1.1', notes: '<p>Corrections</p>', url: 'https://github.com/Floriantoine/computer-watcher/releases/tag/v0.1.1' })), ...o.backend };
  const c = createUpdateController({
    mode: o.mode ?? 'install',
    current: '0.1.0',
    backend,
    loadPrefs: () => prefs,
    savePrefs: (p) => {
      prefs = p;
    },
    send: (v) => views.push(v),
    now: () => now,
    setTimeout: (fn, ms) => timers.push({ fn, ms, every: false }),
    setInterval: (fn, ms) => timers.push({ fn, ms, every: true }),
  });
  return { c, views, timers, backend, prefs: () => prefs, advance: (ms: number) => (now += ms) };
}

describe('createUpdateController', () => {
  test('démarrage : première vérification après 30 s, puis toutes les 6 h', () => {
    const { c, timers } = setup();
    c.start();
    expect(timers.map((t) => [t.ms, t.every])).toEqual([[30_000, false], [6 * 3600_000, true]]);
  });
  test('mode off (sources) : aucun minuteur, aucune vérification, même manuelle', async () => {
    const { c, timers, backend } = setup({ mode: 'off', backend: null });
    c.start();
    expect(timers).toEqual([]);
    await c.check(true);
    expect(backend).toBeNull();
    expect(c.view().state.phase).toBe('idle');
  });
  test('mise à jour trouvée : pop-up, jamais de téléchargement automatique', async () => {
    const download = vi.fn(async () => {});
    const { c, views } = setup({ backend: { download } });
    await c.check(false);
    expect(c.view().state.phase).toBe('available');
    expect(c.view().state.available?.notes).toBe('Corrections');
    expect(c.view().popup).toBe(true);
    expect(download).not.toHaveBeenCalled();
    expect(views.at(-1)?.popup).toBe(true);
  });
  test('vérification désactivée : les vérifications planifiées ne font rien, « Vérifier maintenant » oui', async () => {
    const { c, backend } = setup({ prefs: { enabled: false } });
    await c.check(false);
    expect(backend!.check).not.toHaveBeenCalled();
    await c.check(true);
    expect(backend!.check).toHaveBeenCalledTimes(1);
  });
  test('préversion trouvée sans le réglage : ignorée ; le réglage est passé au backend', async () => {
    const check = vi.fn(async () => ({ version: '0.2.0-beta.1', notes: '', url: 'https://github.com/Floriantoine/computer-watcher/releases/tag/v0.2.0-beta.1' }));
    const a = setup({ backend: { check } });
    await a.c.check(true);
    expect(check).toHaveBeenLastCalledWith(false);
    expect(a.c.view().state.available).toBeNull();
    const b = setup({ backend: { check }, prefs: { prerelease: true } });
    await b.c.check(true);
    expect(check).toHaveBeenLastCalledWith(true);
    expect(b.c.view().state.available?.version).toBe('0.2.0-beta.1');
  });
  test('version plus ancienne renvoyée par le backend : jamais proposée', async () => {
    const { c } = setup({ backend: { check: async () => ({ version: '0.0.9', notes: '', url: 'https://github.com/Floriantoine/computer-watcher/releases' }) } });
    await c.check(true);
    expect(c.view().state.available).toBeNull();
    expect(c.view().state.lastResult).toBe('none');
  });
  test('URL de page de version inattendue : remplacée par la page des versions du dépôt', async () => {
    const { c } = setup({ backend: { check: async () => ({ version: '0.1.1', notes: '', url: 'https://evil.example/x' }) } });
    await c.check(true);
    expect(c.view().state.available?.url).toBe('https://github.com/Floriantoine/computer-watcher/releases');
  });
  test('erreur de vérification : état gardé, pas de pop-up', async () => {
    const { c } = setup({ backend: { check: async () => Promise.reject(new Error('ENOTFOUND')) } });
    await c.check(false);
    expect(c.view().state.lastResult).toBe('error');
    expect(c.view().state.error).toBe('ENOTFOUND');
    expect(c.view().popup).toBe(false);
  });
  test('téléchargement : progression, prête, puis installation seulement sur demande', async () => {
    let progress: ((p: number) => void) | undefined;
    const install = vi.fn();
    const { c, views } = setup({
      backend: {
        download: async (onProgress) => {
          progress = onProgress;
          onProgress(50);
        },
        install,
      },
    });
    await c.check(false);
    await c.download();
    expect(progress).toBeDefined();
    expect(views.some((v) => v.state.phase === 'downloading' && v.state.progress === 50)).toBe(true);
    expect(c.view().state.phase).toBe('ready');
    expect(install).not.toHaveBeenCalled();
    c.install();
    expect(install).toHaveBeenCalledTimes(1);
  });
  test('pas une AppImage (notify) : téléchargement et installation refusés', async () => {
    const download = vi.fn(async () => {});
    const install = vi.fn();
    const { c } = setup({ mode: 'notify', backend: { download, install } });
    await c.check(false);
    expect(c.view().popup).toBe(true);
    await c.download();
    c.install();
    expect(download).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(c.view().state.phase).toBe('available');
  });
  test('installation qui échoue (dossier en lecture seule) : erreur visible dans le pop-up', async () => {
    const { c } = setup({
      backend: {
        download: async () => {},
        install: () => {
          throw new Error('EACCES: permission denied');
        },
      },
    });
    await c.check(false);
    await c.download();
    expect(() => c.install()).not.toThrow();
    expect(c.view().state.phase).toBe('error');
    expect(c.view().state.error).toContain('EACCES');
    expect(c.view().popup).toBe(true);
  });
  test('installation échouée après la suppression de l’ancienne AppImage : chemin du fichier vérifié et cible dans l’état', async () => {
    const { c } = setup({
      backend: {
        download: async () => {},
        install: () => {
          throw new InstallError('mv: Permission denied', '/c/pending/p.AppImage', '/home/u/Apps/p.AppImage');
        },
        pendingFile: () => '/c/pending/p.AppImage',
      },
    });
    await c.check(false);
    await c.download();
    c.install();
    expect(c.view().state.phase).toBe('error');
    expect(c.view().state.failedInstall).toEqual({ file: '/c/pending/p.AppImage', target: '/home/u/Apps/p.AppImage' });
  });
  test('« Réessayer » après une installation échouée : réinstalle depuis le fichier vérifié en cache, sans retélécharger', async () => {
    let tries = 0;
    const download = vi.fn(async () => {});
    const install = vi.fn(() => {
      tries++;
      if (tries === 1) throw new InstallError('EACCES', '/c/pending/p.AppImage', '/a/p.AppImage');
    });
    const { c } = setup({ backend: { download, install, pendingFile: () => '/c/pending/p.AppImage' } });
    await c.check(false);
    await c.download();
    c.install();
    await c.retry();
    expect(install).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenCalledTimes(1);
  });
  test('« Réessayer » : fichier vérifié disparu du cache → nouveau téléchargement', async () => {
    const download = vi.fn(async () => {});
    const install = vi.fn(() => {
      throw new InstallError('EACCES', '/c/pending/p.AppImage', '/a/p.AppImage');
    });
    const { c } = setup({ backend: { download, install, pendingFile: () => null } });
    await c.check(false);
    await c.download();
    c.install();
    await c.retry();
    expect(install).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(2);
    expect(c.view().state.phase).toBe('ready');
  });
  test('« Réessayer » après un échec de téléchargement : nouveau téléchargement', async () => {
    let fail = true;
    const download = vi.fn(async () => {
      if (fail) throw new Error('réseau');
    });
    const { c } = setup({ backend: { download } });
    await c.check(false);
    await c.download();
    fail = false;
    await c.retry();
    expect(download).toHaveBeenCalledTimes(2);
    expect(c.view().state.phase).toBe('ready');
  });
  test('mode relaunch (copie installée ailleurs) : ni téléchargement ni installation', async () => {
    const download = vi.fn(async () => {});
    const { c } = setup({ mode: 'relaunch', backend: { download } });
    await c.check(false);
    expect(c.view().popup).toBe(true);
    await c.download();
    expect(download).not.toHaveBeenCalled();
  });
  test('préversions désactivées : une préversion déjà proposée est retirée', async () => {
    const check = vi.fn(async () => ({ version: '0.2.0-beta.1', notes: '', url: 'https://github.com/Floriantoine/computer-watcher/releases/tag/v0.2.0-beta.1' }));
    const { c } = setup({ backend: { check }, prefs: { prerelease: true } });
    await c.check(true);
    expect(c.view().state.available?.version).toBe('0.2.0-beta.1');
    c.setPrefs({ prerelease: false });
    expect(c.view().state.available).toBeNull();
    expect(c.view().popup).toBe(false);
  });
  test('préversions désactivées : une version finale proposée reste', async () => {
    const { c } = setup({ prefs: { prerelease: true } });
    await c.check(true);
    c.setPrefs({ prerelease: false });
    expect(c.view().state.available?.version).toBe('0.1.1');
  });
  test('installation avant la fin du téléchargement : refusée', async () => {
    const install = vi.fn();
    const { c } = setup({ backend: { install, download: async () => {} } });
    await c.check(false);
    c.install();
    expect(install).not.toHaveBeenCalled();
  });
  test('échec du téléchargement (sha512) : erreur dans le pop-up, réessai possible', async () => {
    let fail = true;
    const { c } = setup({
      backend: {
        download: async () => {
          if (fail) throw new Error('sha512 checksum mismatch');
        },
      },
    });
    await c.check(false);
    await c.download();
    expect(c.view().state.phase).toBe('error');
    expect(c.view().popup).toBe(true);
    fail = false;
    await c.download();
    expect(c.view().state.phase).toBe('ready');
  });
  test('« Ignorer cette version » : gardé dans les préférences, pop-up fermé', async () => {
    const { c, prefs } = setup();
    await c.check(false);
    c.ignore();
    expect(prefs().ignoredVersion).toBe('0.1.1');
    expect(c.view().popup).toBe(false);
  });
  test('« Plus tard » : pop-up caché, revient après 24 h à la vérification suivante', async () => {
    const { c, advance } = setup();
    await c.check(false);
    c.later();
    expect(c.view().popup).toBe(false);
    advance(24 * 3600_000);
    await c.check(false);
    expect(c.view().popup).toBe(true);
  });
  test('réglages : booléens seulement, enregistrés', () => {
    const { c, prefs } = setup();
    c.setPrefs({ enabled: false, prerelease: true });
    expect(prefs()).toMatchObject({ enabled: false, prerelease: true });
    expect(() => c.setPrefs({ enabled: 'non' })).toThrow();
    expect(() => c.setPrefs(null)).toThrow();
  });
  test('deux vérifications simultanées : un seul appel au backend', async () => {
    const { c, backend } = setup();
    await Promise.all([c.check(true), c.check(true)]);
    expect(backend!.check).toHaveBeenCalledTimes(1);
  });
});

describe('pickRelease (API GitHub, mode notification)', () => {
  const rel = (tag: string, extra: Record<string, unknown> = {}) => ({
    tag_name: tag, html_url: `https://github.com/Floriantoine/computer-watcher/releases/tag/${tag}`, body: `Notes ${tag}`, draft: false, prerelease: false, ...extra,
  });
  test('la plus récente publiée, préversions exclues par défaut, brouillons toujours exclus', () => {
    const list = [rel('v0.1.1'), rel('v0.3.0', { draft: true }), rel('v0.2.0-beta.1', { prerelease: true }), rel('v0.1.2'), { junk: true }];
    expect(pickRelease(list, false)).toEqual({ version: '0.1.2', notes: 'Notes v0.1.2', url: 'https://github.com/Floriantoine/computer-watcher/releases/tag/v0.1.2' });
    expect(pickRelease(list, true)?.version).toBe('0.2.0-beta.1');
  });
  test('réponse inattendue : rien', () => {
    expect(pickRelease({ message: 'rate limited' }, false)).toBeNull();
    expect(pickRelease([], false)).toBeNull();
  });
});

describe('createReleasesApiBackend', () => {
  const list = JSON.stringify([{ tag_name: 'v0.1.1', html_url: 'https://github.com/Floriantoine/computer-watcher/releases/tag/v0.1.1', body: 'x', draft: false, prerelease: false }]);
  const respond = (body: string, headers: Record<string, string> = {}) => (async () => new Response(body, { status: 200, headers })) as unknown as typeof fetch;
  test('réponse normale', async () => {
    expect((await createReleasesApiBackend({ url: 'https://x', fetch: respond(list) }).check(false))?.version).toBe('0.1.1');
  });
  test('content-length au-delà de 2 Mo : refusé sans lire', async () => {
    await expect(createReleasesApiBackend({ url: 'https://x', fetch: respond(list, { 'content-length': '3000000' }) }).check(false)).rejects.toThrow(/trop grande/);
  });
  test('corps en flux au-delà de 2 Mo (sans content-length) : lecture arrêtée', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(256 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(ctl) {
        pulled++;
        if (pulled > 100) ctl.close();
        else ctl.enqueue(chunk);
      },
    });
    const f = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    await expect(createReleasesApiBackend({ url: 'https://x', fetch: f }).check(false)).rejects.toThrow(/trop grande/);
    expect(pulled).toBeLessThan(20);
  });
});

describe('createPrefsStore', () => {
  test('absent ou illisible → défauts ; écriture atomique relue', async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'pw-upd-'));
    const store = createPrefsStore(join(dir, 'sub', 'updater.json'));
    expect(store.load()).toEqual(DEFAULT_UPDATE_PREFS);
    store.save({ ...DEFAULT_UPDATE_PREFS, ignoredVersion: '0.2.0' });
    expect(createPrefsStore(join(dir, 'sub', 'updater.json')).load().ignoredVersion).toBe('0.2.0');
    expect(JSON.parse(readFileSync(join(dir, 'sub', 'updater.json'), 'utf8')).ignoredVersion).toBe('0.2.0');
    writeFileSync(join(dir, 'bad.json'), '{oops');
    expect(createPrefsStore(join(dir, 'bad.json')).load()).toEqual(DEFAULT_UPDATE_PREFS);
  });
});
