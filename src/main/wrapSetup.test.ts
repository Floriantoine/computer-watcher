import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { CLAUDE_HOOK_ENTRY, isOurLauncher, zshBlock } from '../core/wrapSetup';
import { applyWrap, findInPath, installWrap, wrapReminder, ownedWrapParts, removeWrap, wrapConfirmText, wrapPaths, wrapStatus, type WrapSetupDeps } from './wrapSetup';

// HOME temporaires sous ~/.cache/pw-wrapsetup-* : jamais le vrai ~/.zshrc, ~/.claude ni ~/.local/bin.
const cache = join(homedir(), '.cache');
mkdirSync(cache, { recursive: true });
const base = mkdtempSync(join(cache, 'pw-wrapsetup-test-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
let home: string;
let probed: string[];
const NOW = new Date(2026, 9, 21, 10, 0, 0);
const APPIMAGE = () => join(home, 'Applications', 'computer-watcher.AppImage');

/** Sonde factice : un exécutable « répond » s'il est notre lanceur ou contient REPOND (jamais exécuté). */
const fakeProbe = async (f: string) => {
  probed.push(f);
  const t = readFileSync(f, 'utf8');
  return t.includes('REPOND') || isOurLauncher(t);
};

const deps = (o: Partial<WrapSetupDeps> = {}): WrapSetupDeps => ({
  home,
  env: { PATH: `${join(home, '.local/bin')}:/nonexistent`, ...o.env },
  loginShell: '/usr/bin/zsh',
  target: { kind: 'appimage', path: APPIMAGE() },
  probe: fakeProbe,
  now: () => NOW,
  ...o,
});

beforeEach(() => {
  home = join(base, `h${++n}`);
  mkdirSync(join(home, 'Applications'), { recursive: true });
  writeFileSync(APPIMAGE(), 'appimage');
  probed = [];
});

const item = async (d: WrapSetupDeps, part: string) => (await wrapStatus(d)).items.find((i) => i.part === part)!;
const backups = (dir: string) => readdirSync(dir).filter((f) => f.includes('.computer-watcher-') && f.endsWith('.bak')).sort();

describe('chemins injectés', () => {
  test('HOME, ZDOTDIR et CLAUDE_CONFIG_DIR', () => {
    expect(wrapPaths({ home: '/h', env: {} })).toEqual({
      binDir: '/h/.local/bin', launcher: '/h/.local/bin/computer-watcher', zshrc: '/h/.zshrc', claudeDir: '/h/.claude', settings: '/h/.claude/settings.json',
    });
    const p = wrapPaths({ home: '/h', env: { ZDOTDIR: '/z/', CLAUDE_CONFIG_DIR: '/c' } });
    expect(p.zshrc).toBe('/z/.zshrc');
    expect(p.settings).toBe('/c/settings.json');
    // valeur relative ignorée
    expect(wrapPaths({ home: '/h', env: { CLAUDE_CONFIG_DIR: 'rel' } }).claudeDir).toBe('/h/.claude');
  });

  test('findInPath : premier exécutable, dossiers relatifs ignorés', () => {
    const a = join(home, 'a');
    const b = join(home, 'b');
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, 'computer-watcher'), 'x');
    writeFileSync(join(b, 'computer-watcher'), 'x');
    chmodSync(join(b, 'computer-watcher'), 0o755);
    expect(findInPath(`rel:${a}:${b}`)).toBe(join(b, 'computer-watcher'));
    expect(findInPath('')).toBe(null);
  });
});

describe('commande dans le PATH', () => {
  test('absente : « Installer » crée le lanceur (AppImage figée, 0755), puis « Retirer » le supprime ; idempotent', async () => {
    const d = deps();
    const s = await item(d, 'command');
    expect(s).toMatchObject({ state: 'absent', ok: false, canInstall: true, canRemove: false });
    expect(s.preview).toContain(`exec '${APPIMAGE()}' "$@"`);
    const r = await installWrap(d, 'command');
    expect(r.changed).toBe(true);
    const launcher = wrapPaths(d).launcher;
    expect(statSync(launcher).mode & 0o777).toBe(0o755);
    expect(readFileSync(launcher, 'utf8')).toBe(s.preview);
    const after = await item(d, 'command');
    expect(after).toMatchObject({ state: 'ours', ok: true, canInstall: false, canRemove: true, warnings: [] });
    expect((await installWrap(d, 'command')).changed).toBe(false);
    expect((await removeWrap(d, 'command')).changed).toBe(true);
    expect(existsSync(launcher)).toBe(false);
    expect((await removeWrap(d, 'command')).changed).toBe(false);
  });

  test('déjà trouvable ailleurs et qui répond (ex. /usr/bin du .deb) : rien à faire, rien écrit', async () => {
    const other = join(home, 'usr-bin');
    mkdirSync(other);
    writeFileSync(join(other, 'computer-watcher'), '#!/bin/sh\n# REPOND\n');
    chmodSync(join(other, 'computer-watcher'), 0o755);
    const d = deps({ env: { PATH: `${other}:${join(home, '.local/bin')}` } });
    const s = await item(d, 'command');
    expect(s).toMatchObject({ state: 'foreign', ok: true, canInstall: false, path: join(other, 'computer-watcher') });
    expect((await installWrap(d, 'command')).changed).toBe(false);
    expect(existsSync(wrapPaths(d).launcher)).toBe(false);
  });

  test('fichier existant qui n’est pas de nous : jamais écrasé ni retiré', async () => {
    const d = deps();
    const launcher = wrapPaths(d).launcher;
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    writeFileSync(launcher, '#!/bin/sh\nexec mon-lanceur "$@"\n');
    chmodSync(launcher, 0o755);
    const s = await item(d, 'command');
    expect(s).toMatchObject({ state: 'foreign', ok: false, canInstall: false, canRemove: false });
    expect(s.blocked).toMatch(/jamais écrasé/);
    await expect(installWrap(d, 'command')).rejects.toThrow(/jamais écrasé/);
    await expect(removeWrap(d, 'command')).rejects.toThrow(/laissé en place/);
    expect(readFileSync(launcher, 'utf8')).toBe('#!/bin/sh\nexec mon-lanceur "$@"\n');
  });

  test('lanceur maison qui répond : présent, pas de nous, rien à faire', async () => {
    const d = deps();
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    writeFileSync(wrapPaths(d).launcher, '#!/bin/sh\n# REPOND\n');
    chmodSync(wrapPaths(d).launcher, 0o755);
    expect(await item(d, 'command')).toMatchObject({ state: 'foreign', ok: true, canInstall: false, blocked: null });
  });

  test('lien symbolique à la place du lanceur : pas de nous, jamais suivi', async () => {
    const d = deps();
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    const target = join(home, 'cible');
    writeFileSync(target, 'x');
    symlinkSync(target, wrapPaths(d).launcher);
    expect(await item(d, 'command')).toMatchObject({ state: 'foreign', canInstall: false });
    await expect(removeWrap(d, 'command')).rejects.toThrow();
    expect(lstatSync(wrapPaths(d).launcher).isSymbolicLink()).toBe(true);
  });

  test('~/.local/bin absent du PATH : prévenu', async () => {
    const d = deps({ env: { PATH: '/nonexistent' } });
    const s = await item(d, 'command');
    expect(s.warnings.join(' ')).toMatch(/n’est pas dans le PATH/);
    const r = await installWrap(d, 'command');
    expect(r.warnings.join(' ')).toMatch(/n’est pas dans le PATH/);
  });

  test('cible disparue (AppImage déplacée) : à mettre à jour ; « Installer » réécrit le lanceur vers la nouvelle cible', async () => {
    const d = deps();
    await installWrap(d, 'command');
    rmSync(APPIMAGE());
    const moved = join(home, 'Applications', 'cw2.AppImage');
    writeFileSync(moved, 'x');
    const d2 = deps({ target: { kind: 'appimage', path: moved } });
    expect(await item(d2, 'command')).toMatchObject({ state: 'ours', ok: false, canInstall: true });
    await installWrap(d2, 'command');
    expect(readFileSync(wrapPaths(d).launcher, 'utf8')).toContain(moved);
  });

  test('aucun exécutable connu : bloqué, dit', async () => {
    const d = deps({ target: null });
    const s = await item(d, 'command');
    expect(s).toMatchObject({ canInstall: false });
    expect(s.blocked).toMatch(/introuvable/);
    await expect(installWrap(d, 'command')).rejects.toThrow(/introuvable/);
  });
});

describe('~/.zshrc', () => {
  test('bloc ajouté en fin, sauvegarde horodatée, droits gardés ; retiré proprement avec une autre sauvegarde', async () => {
    const d = deps();
    const rc = join(home, '.zshrc');
    writeFileSync(rc, 'export A=1\n');
    chmodSync(rc, 0o600);
    expect(await item(d, 'zshrc')).toMatchObject({ state: 'absent', canInstall: true, preview: zshBlock() });
    const r = await installWrap(d, 'zshrc');
    expect(r.backup).toBe(`${rc}.computer-watcher-20261021-100000.bak`);
    expect(readFileSync(r.backup!, 'utf8')).toBe('export A=1\n');
    expect(readFileSync(rc, 'utf8')).toBe(`export A=1\n\n${zshBlock()}`);
    expect(statSync(rc).mode & 0o777).toBe(0o600);
    expect(await item(d, 'zshrc')).toMatchObject({ state: 'ours', ok: true, canRemove: true });
    expect((await installWrap(d, 'zshrc')).changed).toBe(false);
    const rm = await removeWrap(d, 'zshrc');
    expect(rm.backup).toBe(`${rc}.computer-watcher-20261021-100000-2.bak`);
    expect(readFileSync(rc, 'utf8')).toBe('export A=1\n');
    expect(backups(home)).toHaveLength(2);
    expect(readdirSync(home).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('absent et zsh n’est pas le shell : rien créé, dit ; zsh : créé (sans sauvegarde)', async () => {
    const d = deps({ loginShell: '/bin/bash' });
    const s = await item(d, 'zshrc');
    expect(s).toMatchObject({ state: 'absent', canInstall: false });
    expect(s.blocked).toMatch(/zsh n’est pas votre shell \(\/bin\/bash\)/);
    await expect(installWrap(d, 'zshrc')).rejects.toThrow(/pas votre shell/);
    expect(existsSync(join(home, '.zshrc'))).toBe(false);
    const r = await installWrap(deps(), 'zshrc');
    expect(r.backup).toBe(null);
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe(zshBlock());
  });

  test('ligne ajoutée à la main : présent, pas de nous, laissé', async () => {
    writeFileSync(join(home, '.zshrc'), '(( ${+commands[computer-watcher]} )) && eval "$(computer-watcher shell-init zsh)"\n');
    const s = await item(deps(), 'zshrc');
    expect(s).toMatchObject({ state: 'foreign', ok: true, canInstall: false, canRemove: false });
  });

  test('~/.zshrc lien symbolique (dotfiles) : le fichier pointé est modifié, le lien reste', async () => {
    const dot = join(home, 'dotfiles');
    mkdirSync(dot);
    writeFileSync(join(dot, 'zshrc'), 'x\n');
    symlinkSync(join(dot, 'zshrc'), join(home, '.zshrc'));
    await installWrap(deps(), 'zshrc');
    expect(lstatSync(join(home, '.zshrc')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dot, 'zshrc'), 'utf8')).toContain(zshBlock());
    expect(backups(home)).toHaveLength(1);
  });

  test('illisible (dossier à la place) ou bloc incomplet : rien modifié', async () => {
    mkdirSync(join(home, '.zshrc'));
    expect(await item(deps(), 'zshrc')).toMatchObject({ state: 'unreadable', canInstall: false });
    rmSync(join(home, '.zshrc'), { recursive: true });
    writeFileSync(join(home, '.zshrc'), '# >>> computer-watcher : lancer directement dans le budget >>>\n');
    expect(await item(deps(), 'zshrc')).toMatchObject({ state: 'unreadable', canInstall: false, canRemove: false });
    await expect(removeWrap(deps(), 'zshrc')).rejects.toThrow(/incomplet/);
  });

  test('ZDOTDIR respecté', async () => {
    const z = join(home, 'zdot');
    mkdirSync(z);
    const d = deps({ env: { PATH: '/x', ZDOTDIR: z } });
    await installWrap(d, 'zshrc');
    expect(existsSync(join(z, '.zshrc'))).toBe(true);
    expect(existsSync(join(home, '.zshrc'))).toBe(false);
  });
});

describe('~/.claude/settings.json', () => {
  const settings = () => join(home, '.claude', 'settings.json');

  test('Claude Code absent (pas de dossier) : dit, rien créé', async () => {
    const s = await item(deps(), 'claude');
    expect(s).toMatchObject({ state: 'absent', canInstall: false });
    expect(s.blocked).toMatch(/Claude Code n’est pas installé/);
    await expect(installWrap(deps(), 'claude')).rejects.toThrow(/pas installé/);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  test('entrée ajoutée sans toucher au reste, sauvegarde ; retirée exactement', async () => {
    mkdirSync(join(home, '.claude'));
    const original = '{\n  "permissions": {\n    "allow": ["Bash(ls:*)"]\n  },\n  "hooks": {\n    "PreToolUse": [\n      { "matcher": "Edit", "hooks": [] }\n    ]\n  },\n  "model": "opus"\n}\n';
    writeFileSync(settings(), original);
    const r = await installWrap(deps(), 'claude');
    expect(readFileSync(r.backup!, 'utf8')).toBe(original);
    const j = JSON.parse(readFileSync(settings(), 'utf8'));
    expect(Object.keys(j)).toEqual(['permissions', 'hooks', 'model']);
    expect(j.hooks.PreToolUse).toEqual([{ matcher: 'Edit', hooks: [] }, CLAUDE_HOOK_ENTRY]);
    expect(await item(deps(), 'claude')).toMatchObject({ state: 'ours', ok: true, canRemove: true });
    await removeWrap(deps(), 'claude');
    expect(JSON.parse(readFileSync(settings(), 'utf8'))).toEqual(JSON.parse(original));
  });

  test('settings.json absent mais dossier présent : créé avec le seul hook', async () => {
    mkdirSync(join(home, '.claude'));
    const r = await installWrap(deps(), 'claude');
    expect(r.backup).toBe(null);
    expect(JSON.parse(readFileSync(settings(), 'utf8'))).toEqual({ hooks: { PreToolUse: [CLAUDE_HOOK_ENTRY] } });
  });

  test('JSON invalide : rien fait, erreur claire', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(settings(), '{ "model": ');
    const s = await item(deps(), 'claude');
    expect(s).toMatchObject({ state: 'unreadable', canInstall: false });
    expect(s.blocked).toMatch(/JSON invalide/);
    await expect(installWrap(deps(), 'claude')).rejects.toThrow(/JSON invalide/);
    expect(readFileSync(settings(), 'utf8')).toBe('{ "model": ');
    expect(backups(join(home, '.claude'))).toEqual([]);
  });

  test('CLAUDE_CONFIG_DIR respecté', async () => {
    const c = join(home, 'claude-cfg');
    mkdirSync(c);
    const d = deps({ env: { PATH: '/x', CLAUDE_CONFIG_DIR: c } });
    await installWrap(d, 'claude');
    expect(existsSync(join(c, 'settings.json'))).toBe(true);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });
});

describe('ensemble', () => {
  test('complet seulement quand les trois sont en place ; ownedWrapParts dans l’ordre de retrait', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.zshrc'), '');
    const d = deps();
    expect((await wrapStatus(d)).complete).toBe(false);
    expect(ownedWrapParts(d)).toEqual([]);
    for (const p of ['command', 'zshrc', 'claude'] as const) await installWrap(d, p);
    expect((await wrapStatus(d)).complete).toBe(true);
    expect(ownedWrapParts(d).map((o) => o.part)).toEqual(['claude', 'zshrc', 'command']);
  });

  test('confirmation : fichiers modifiés et emplacement des sauvegardes', async () => {
    mkdirSync(join(home, '.claude'));
    const st = await wrapStatus(deps());
    const c = wrapConfirmText(home, 'install', st.items);
    expect(c.detail).toContain('~/.local/bin/computer-watcher : lanceur créé');
    expect(c.detail).toContain('~/.zshrc : bloc de 4 lignes ajouté à la fin');
    expect(c.detail).toContain('~/.claude/settings.json : une entrée ajoutée dans hooks.PreToolUse');
    expect(c.detail).toContain('~/.zshrc.computer-watcher-AAAAMMJJ-HHMMSS.bak');
    expect(c.confirm).toBe('Installer');
    expect(wrapConfirmText(home, 'remove', st.items.slice(0, 1)).detail).not.toContain('Sauvegarde');
  });
});

describe('applyWrap (Réglages)', () => {
  test('« Tout installer » : confirmation puis les éléments installables ; refus de confirmer : rien écrit', async () => {
    mkdirSync(join(home, '.claude'));
    const d = deps();
    const seen: string[] = [];
    const no = await applyWrap(d, 'install', 'all', async (c) => (seen.push(c.detail), false));
    expect(no).toEqual({ cancelled: true });
    expect(existsSync(wrapPaths(d).launcher)).toBe(false);
    expect(existsSync(join(home, '.zshrc'))).toBe(false);
    expect(seen[0]).toContain('.bak');
    const yes = await applyWrap(d, 'install', 'all', async () => true);
    if (yes.cancelled) throw new Error('annulé');
    expect(yes.results.map((r) => r.part)).toEqual(['command', 'zshrc', 'claude']);
    expect(yes.errors).toEqual([]);
    expect(yes.status.complete).toBe(true);
  });

  test('une erreur n’arrête pas les autres ; rien à faire : pas de confirmation', async () => {
    mkdirSync(join(home, '.claude'));
    const d = deps();
    let asked = 0;
    await applyWrap(d, 'install', 'zshrc', async () => (asked++, true));
    // JSON cassé pendant la confirmation (après le calcul de l'état) : le hook échoue, le lanceur passe
    const r = await applyWrap(d, 'install', 'all', async () => {
      asked++;
      writeFileSync(join(home, '.claude/settings.json'), '{');
      return true;
    });
    if (r.cancelled) throw new Error('annulé');
    expect(r.results.map((x) => x.part)).toEqual(['command']);
    expect(r.errors).toEqual([{ part: 'claude', error: expect.stringMatching(/JSON invalide/) }]);
    expect(readFileSync(join(home, '.claude/settings.json'), 'utf8')).toBe('{');
    const none = await applyWrap(d, 'remove', 'claude', async () => (asked++, true));
    expect(none).toMatchObject({ cancelled: false, results: [] });
    expect(asked).toBe(2);
  });
});

describe('rappel au lancement', () => {
  const run = (d: WrapSetupDeps, o: Partial<{ antigelEnabled: boolean; later: boolean; testMode: boolean; answer: 'never' | 'done' | null }> = {}) => {
    const written: string[] = [];
    let answer = o.answer ?? null;
    const p = wrapReminder({
      deps: d, antigelEnabled: o.antigelEnabled ?? true, later: o.later ?? false, testMode: o.testMode ?? false, onboarding: false,
      read: () => answer, write: (a) => { written.push(a); answer = a; },
    });
    return p.then((shown) => ({ shown, written }));
  };

  test('incomplet : montré ; « Ne plus afficher » ou test : jamais, sans sonde', async () => {
    expect(await run(deps())).toEqual({ shown: true, written: [] });
    probed = [];
    expect(await run(deps(), { answer: 'never' })).toEqual({ shown: false, written: [] });
    expect(await run(deps(), { testMode: true })).toEqual({ shown: false, written: [] });
    expect(await run(deps(), { antigelEnabled: false })).toEqual({ shown: false, written: [] });
    expect(probed).toEqual([]);
  });

  test('installation complète : pas montré, réponse « done » écrite (plus jamais montré)', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.zshrc'), '');
    const d = deps();
    for (const p of ['command', 'zshrc', 'claude'] as const) await installWrap(d, p);
    expect(await run(d)).toEqual({ shown: false, written: ['done'] });
  });
});
