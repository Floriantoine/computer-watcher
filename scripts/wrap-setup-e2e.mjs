// Lancer les commandes lourdes directement dans le budget : rappel au lancement et Réglages → Plafond de travail, de bout
// en bout. Usage : npm run test:wrap-setup
//
// HOME, XDG, ZDOTDIR et CLAUDE_CONFIG_DIR temporaires sous ~/.cache/pw-wrap-setup-* : jamais le vrai ~/.zshrc, ~/.claude,
// ~/.local/bin ni ~/.config/computer-watcher. PATH réduit à <HOME temporaire>/.local/bin:/usr/bin:/bin (le lanceur de
// l'utilisateur n'est ni trouvé ni exécuté). PROC_WATCH_NO_RECORDER_SYNC=1, PROC_WATCH_NO_KILL=1, PROC_WATCH_NO_ANTIGEL=1,
// earlyoom simulé ; PROC_WATCH_WRAP_REMINDER=1 force le rappel malgré le mode test. Les confirmations natives sont
// acceptées par le script (dialog.showMessageBox remplacé dans le main de l'app de test). Captures seulement si
// WRAP_SHOTS désigne un dossier (hors du dépôt).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

mkdirSync(join(homedir(), '.cache'), { recursive: true });
const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-wrap-setup-')));
let app = null;
const cleanup = () => rmSync(base, { recursive: true, force: true });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    await Promise.race([app?.close().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    cleanup();
    process.exit(130);
  });
}
const waitFor = async (fn, what, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`délai dépassé : ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

try {
  const home = join(base, 'home');
  const cfg = join(base, 'cfg');
  const data = join(base, 'data');
  const claudeDir = join(home, '.claude');
  mkdirSync(join(cfg, 'computer-watcher'), { recursive: true });
  writeFileSync(join(cfg, 'computer-watcher', 'onboarding.json'), '{"version":1,"done":true}\n');
  mkdirSync(join(data, 'computer-watcher'), { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  const zshrc = join(home, '.zshrc');
  writeFileSync(zshrc, 'export DEMO=1\n');
  const settings = join(claudeDir, 'settings.json');
  const settingsBefore = '{\n  "model": "demo",\n  "permissions": {\n    "allow": ["Bash(ls:*)"]\n  }\n}\n';
  writeFileSync(settings, settingsBefore);
  const launcher = join(home, '.local', 'bin', 'computer-watcher');
  const answerFile = join(cfg, 'computer-watcher', 'wrap-setup.json');

  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('PROC_WATCH_') || k === 'ZDOTDIR' || k === 'CLAUDE_CONFIG_DIR' || k === 'ELECTRON_RUN_AS_NODE') delete env[k];
  Object.assign(env, {
    HOME: home, XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: data, XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(base, 'state'),
    ZDOTDIR: home, CLAUDE_CONFIG_DIR: claudeDir, PATH: `${join(home, '.local', 'bin')}:/usr/bin:/bin`,
    PROC_WATCH_NO_RECORDER_SYNC: '1', PROC_WATCH_NO_KILL: '1', PROC_WATCH_NO_ANTIGEL: '1', PROC_WATCH_EARLYOOM_FAKE: join(base, 'earlyoom'),
    PROC_WATCH_WRAP_REMINDER: '1',
  });
  mkdirSync(env.PROC_WATCH_EARLYOOM_FAKE);
  const shots = process.env.WRAP_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const shot = async (name, el) => { if (shots) await el.screenshot({ path: join(shots, `${name}.png`) }); };

  const launch = async () => {
    app = await electron.launch({ args: ['.'], env });
    const win = await app.firstWindow();
    await win.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
    await win.waitForSelector('[data-testid="snapshot-ready"]', { timeout: 30000 });
    // confirmations natives : acceptées, texte gardé pour vérification
    await app.evaluate(({ dialog }) => {
      globalThis.__boxes = [];
      dialog.showMessageBox = async (...a) => {
        globalThis.__boxes.push(a.find((x) => x && typeof x === 'object' && 'message' in x));
        return { response: 1, checkboxChecked: false };
      };
    });
    return win;
  };
  const close = async () => {
    await app.close();
    app = null;
  };
  const reminder = (win) => win.locator('[data-testid="wrap-reminder"]');

  // 1) Premier lancement : rappel montré ; « Plus tard » → fermé, rien écrit
  let win = await launch();
  await reminder(win).waitFor({ timeout: 20000 });
  assert.match(await reminder(win).innerText(), /les lancer dans le budget/);
  await shot('rappel', reminder(win));
  await win.locator('[data-testid="wrap-reminder-later"]').click();
  await reminder(win).waitFor({ state: 'detached' });
  assert.equal(existsSync(answerFile), false, '« Plus tard » n’écrit rien');
  await close();

  // 2) Deuxième lancement : revenu ; « Ne plus afficher » → wrap-setup.json « never »
  win = await launch();
  await reminder(win).waitFor({ timeout: 20000 });
  await win.locator('[data-testid="wrap-reminder-never"]').click();
  await reminder(win).waitFor({ state: 'detached' });
  await waitFor(() => existsSync(answerFile) && JSON.parse(readFileSync(answerFile, 'utf8')).reminder === 'never', 'réponse « never »');
  await close();

  // 3) Troisième lancement : plus de rappel ; Réglages → Plafond de travail (fenêtre haute : la carte entière sur la capture)
  win = await launch();
  await win.setViewportSize({ width: 1280, height: 1900 }).catch(() => {});
  await win.waitForTimeout(3000);
  assert.equal(await reminder(win).count(), 0, 'plus de rappel après « Ne plus afficher »');
  await win.locator('button[aria-label="Réglages"]').click();
  await win.locator('#settings-tab-antigel').click();
  const card = win.locator('[data-testid="wrap-setup"]');
  await card.waitFor();
  const item = (part) => card.locator(`[data-testid="wrap-setup-item"][data-part="${part}"]`);
  await waitFor(async () => (await card.locator('[data-testid="wrap-setup-item"]').count()) === 3, 'trois éléments');
  for (const p of ['command', 'zshrc', 'claude']) assert.equal(await item(p).getAttribute('data-state'), 'absent', `${p} absent`);
  assert.match(await card.innerText(), /0 élément sur 3 en place/);
  assert.match(await item('zshrc').locator('[data-testid="wrap-setup-preview"]').innerText(), /computer-watcher shell-init zsh/);
  assert.match(await item('claude').locator('[data-testid="wrap-setup-preview"]').innerText(), /computer-watcher claude-hook/);
  assert.match(await card.innerText(), /Warp/);
  await card.scrollIntoViewIfNeeded();
  await shot('section-avant', card);

  // 4) « Tout installer » : confirmation (fichiers, sauvegardes), trois éléments installés, tout en place
  await card.locator('[data-testid="wrap-setup-all"]').click();
  await waitFor(async () => /Tout est en place/.test(await card.locator('[data-testid="wrap-setup-summary"]').innerText()), 'tout en place');
  const boxes = await app.evaluate(() => globalThis.__boxes);
  assert.equal(boxes.length, 1);
  assert.match(boxes[0].detail, /~\/\.local\/bin\/computer-watcher : lanceur créé/);
  assert.match(boxes[0].detail, /~\/\.zshrc\.computer-watcher-AAAAMMJJ-HHMMSS\.bak/);
  assert.match(boxes[0].detail, /settings\.json : une entrée ajoutée/);
  assert.ok(statSync(launcher).mode & 0o100, 'lanceur exécutable');
  assert.match(readFileSync(launcher, 'utf8'), /ELECTRON_RUN_AS_NODE=1 exec .*cli\.js' "\$@"/);
  assert.match(readFileSync(zshrc, 'utf8'), /^export DEMO=1\n\n# >>> computer-watcher/);
  const j = JSON.parse(readFileSync(settings, 'utf8'));
  assert.deepEqual(Object.keys(j), ['model', 'permissions', 'hooks']);
  assert.equal(j.hooks.PreToolUse[0].hooks[0].command, 'computer-watcher claude-hook');
  assert.equal(readdirSync(home).filter((f) => f.startsWith('.zshrc.computer-watcher-')).length, 1, 'sauvegarde de .zshrc');
  assert.equal(readdirSync(claudeDir).filter((f) => f.startsWith('settings.json.computer-watcher-')).length, 1, 'sauvegarde de settings.json');
  for (const p of ['command', 'zshrc', 'claude']) assert.equal(await item(p).getAttribute('data-state'), 'ours', `${p} installé`);
  await waitFor(() => JSON.parse(readFileSync(answerFile, 'utf8')).reminder === 'done', 'réponse « done » (installation complète)');
  await shot('section-installee', card);

  // 5) « Retirer » le hook Claude : settings.json revient à l'identique (au contenu près), le reste en place
  await item('claude').locator('[data-testid="wrap-setup-remove"]').click();
  await waitFor(async () => (await item('claude').getAttribute('data-state')) === 'absent', 'hook retiré');
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), JSON.parse(settingsBefore));
  assert.equal(await item('zshrc').getAttribute('data-state'), 'ours');
  assert.equal(readdirSync(claudeDir).filter((f) => f.startsWith('settings.json.computer-watcher-')).length, 2, 'nouvelle sauvegarde avant retrait');
  await close();

  console.log('WRAP SETUP E2E OK');
} finally {
  await app?.close().catch(() => {});
  cleanup();
}
