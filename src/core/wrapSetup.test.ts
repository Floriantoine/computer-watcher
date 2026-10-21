import { describe, expect, test } from 'vitest';
import {
  addClaudeHook, addZshBlock, CLAUDE_HOOK_ENTRY, claudeHookState, launcherScript, isOurLauncher, removeClaudeHook, removeZshBlock, shouldRemind,
  ZSH_BEGIN, ZSH_END, ZSHRC_LINE, zshBlock, zshrcState, backupName,
} from './wrapSetup';

describe('bloc ~/.zshrc', () => {
  test('ajouté en fin de fichier, séparé par une ligne vide, et retiré à l’identique', () => {
    const before = 'export A=1\nalias l=ls\n';
    const after = addZshBlock(before);
    expect(after.startsWith(before)).toBe(true);
    expect(after).toBe(`${before}\n${zshBlock()}`);
    expect(after).toContain(ZSHRC_LINE);
    expect(zshrcState(after)).toBe('ours');
    expect(removeZshBlock(after)).toBe(before);
  });

  test('fichier sans retour à la ligne final, ou vide', () => {
    expect(addZshBlock('export A=1')).toBe(`export A=1\n\n${zshBlock()}`);
    expect(addZshBlock('')).toBe(zshBlock());
    expect(removeZshBlock(addZshBlock('export A=1'))).toBe('export A=1\n');
    expect(removeZshBlock(zshBlock())).toBe('');
  });

  test('idempotent : déjà présent → inchangé', () => {
    const once = addZshBlock('x\n');
    expect(addZshBlock(once)).toBe(once);
    expect(removeZshBlock('x\n')).toBe('x\n');
  });

  test('bloc au milieu (lignes ajoutées après par l’utilisateur) : seul le bloc part', () => {
    const t = `a\n\n${zshBlock()}b\n`;
    expect(removeZshBlock(t)).toBe('a\nb\n');
  });

  test('états : absent, ligne manuelle (pas de nous), bloc incomplet', () => {
    expect(zshrcState('export A=1\n')).toBe('absent');
    expect(zshrcState(`${ZSHRC_LINE}\n`)).toBe('foreign');
    expect(zshrcState('# eval "$(computer-watcher shell-init zsh)"\n')).toBe('absent');
    expect(zshrcState(`${ZSH_BEGIN}\n${ZSHRC_LINE}\n`)).toBe('broken');
    expect(() => removeZshBlock(`${ZSH_BEGIN}\nx\n`)).toThrow(/incomplet/);
    expect(zshrcState(`${ZSH_END}\n${ZSH_BEGIN}\n`)).toBe('broken');
  });

  test('CRLF : marqueurs reconnus', () => {
    const t = `a\r\n\r\n${zshBlock().replace(/\n/g, '\r\n')}`;
    expect(zshrcState(t)).toBe('ours');
    expect(removeZshBlock(t)).toBe('a\r\n');
  });
});

describe('hook ~/.claude/settings.json', () => {
  const ours = () => structuredClone(CLAUDE_HOOK_ENTRY);

  test('ajouté sans toucher au reste : ordre des clés, indentation, retour final', () => {
    const text = '{\n    "model": "opus",\n    "hooks": {\n        "Stop": [1]\n    },\n    "z": true\n}\n';
    const out = addClaudeHook(text);
    const j = JSON.parse(out);
    expect(Object.keys(j)).toEqual(['model', 'hooks', 'z']);
    expect(Object.keys(j.hooks)).toEqual(['Stop', 'PreToolUse']);
    expect(j.hooks.PreToolUse).toEqual([ours()]);
    expect(out).toMatch(/^\{\n {4}"model"/);
    expect(out.endsWith('}\n')).toBe(true);
    expect(claudeHookState(out)).toBe('ours');
    expect(removeClaudeHook(out)).toBe(JSON.stringify({ model: 'opus', hooks: { Stop: [1] }, z: true }, null, 4) + '\n');
  });

  test('PreToolUse existant : ajouté à la fin, les autres entrées gardées', () => {
    const other = { matcher: 'Edit', hooks: [{ type: 'command', command: 'x' }] };
    const out = addClaudeHook(JSON.stringify({ hooks: { PreToolUse: [other] } }));
    expect(JSON.parse(out).hooks.PreToolUse).toEqual([other, ours()]);
    expect(JSON.parse(removeClaudeHook(out)).hooks.PreToolUse).toEqual([other]);
    expect(out.endsWith('\n')).toBe(false); // pas de retour final à l'origine
  });

  test('fichier absent ou vide : créé avec le seul hook', () => {
    expect(JSON.parse(addClaudeHook(null))).toEqual({ hooks: { PreToolUse: [ours()] } });
    expect(JSON.parse(addClaudeHook('   '))).toEqual({ hooks: { PreToolUse: [ours()] } });
  });

  test('retrait : seulement notre entrée exacte ; tableaux et objet vidés par le retrait enlevés', () => {
    const near = { ...ours(), hooks: [{ ...ours().hooks[0], timeout: 10 }] };
    const t = JSON.stringify({ a: 1, hooks: { PreToolUse: [near, ours()] } }, null, 2);
    expect(JSON.parse(removeClaudeHook(t))).toEqual({ a: 1, hooks: { PreToolUse: [near] } });
    expect(JSON.parse(removeClaudeHook(JSON.stringify({ a: 1, hooks: { PreToolUse: [ours()] } })))).toEqual({ a: 1 });
    expect(JSON.parse(removeClaudeHook(JSON.stringify({ hooks: { PreToolUse: [ours()], Stop: [] } })))).toEqual({ hooks: { Stop: [] } });
  });

  test('idempotent', () => {
    const once = addClaudeHook('{}');
    expect(addClaudeHook(once)).toBe(once);
    expect(removeClaudeHook('{"a":1}')).toBe('{"a":1}');
  });

  test('états : absent, ajouté à la main (autre forme), JSON invalide ou structure inattendue', () => {
    expect(claudeHookState('{}')).toBe('absent');
    expect(claudeHookState(null)).toBe('absent');
    const manual = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'computer-watcher claude-hook --ask' }] }] } };
    expect(claudeHookState(JSON.stringify(manual))).toBe('foreign');
    expect(claudeHookState('{ "a": ')).toBe('invalid');
    expect(claudeHookState('[]')).toBe('invalid');
    expect(claudeHookState('{"hooks": []}')).toBe('invalid');
    expect(claudeHookState('{"hooks": {"PreToolUse": {}}}')).toBe('invalid');
    expect(() => addClaudeHook('{ "a": ')).toThrow(/JSON invalide/);
    expect(() => removeClaudeHook('{"hooks": []}')).toThrow(/inattendu/);
  });
});

describe('lanceur ~/.local/bin/computer-watcher', () => {
  test('AppImage : chemin figé, marqueur reconnu', () => {
    const s = launcherScript({ kind: 'appimage', path: "/home/u/Applications/computer-watcher.AppImage" });
    expect(s.startsWith('#!/bin/sh\n')).toBe(true);
    expect(s).toContain(`exec '/home/u/Applications/computer-watcher.AppImage' "$@"`);
    expect(isOurLauncher(s)).toBe(true);
    expect(isOurLauncher('#!/bin/sh\nexec foo "$@"\n')).toBe(false);
  });

  test('version de développement : Electron en mode Node sur cli.js ; apostrophes protégées', () => {
    const s = launcherScript({ kind: 'node', electron: "/o'k/electron", cli: '/d/out/main/cli.js' });
    expect(s).toContain(`ELECTRON_RUN_AS_NODE=1 exec '/o'\\''k/electron' '/d/out/main/cli.js' "$@"`);
  });
});

describe('rappel au lancement', () => {
  const base = { antigelEnabled: true, complete: false, answer: null, later: false, testMode: false, onboarding: false } as const;
  test('montré une fois : anti-gel actif, installation incomplète, rien répondu', () => {
    expect(shouldRemind(base)).toBe(true);
  });
  test('jamais : anti-gel éteint, complet, « Ne plus afficher », « Plus tard » dans ce lancement, test, accueil ouvert', () => {
    expect(shouldRemind({ ...base, antigelEnabled: false })).toBe(false);
    expect(shouldRemind({ ...base, complete: true })).toBe(false);
    expect(shouldRemind({ ...base, answer: 'never' })).toBe(false);
    expect(shouldRemind({ ...base, answer: 'done' })).toBe(false);
    expect(shouldRemind({ ...base, later: true })).toBe(false);
    expect(shouldRemind({ ...base, testMode: true })).toBe(false);
    expect(shouldRemind({ ...base, onboarding: true })).toBe(false);
  });
});

test('nom de sauvegarde horodaté (heure locale)', () => {
  expect(backupName('/h/.zshrc', new Date(2026, 9, 21, 9, 5, 7))).toBe('/h/.zshrc.computer-watcher-20261021-090507.bak');
});

test('lancement de test : PROC_WATCH_NO_* ou e2e, sauf PROC_WATCH_WRAP_REMINDER=1', async () => {
  const { isTestLaunch } = await import('./wrapSetup');
  expect(isTestLaunch({})).toBe(false);
  expect(isTestLaunch({ PROC_WATCH_NO_ANTIGEL: '1' })).toBe(true);
  expect(isTestLaunch({ PROC_WATCH_ANTIGEL_E2E: '1' })).toBe(true);
  expect(isTestLaunch({ PROC_WATCH_NO_ANTIGEL: '1', PROC_WATCH_WRAP_REMINDER: '1' })).toBe(false);
});
