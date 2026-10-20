// « Protection anti-gel à mettre à jour » de bout en bout : pop-up du lancement (« Plus tard »), carte de Réglages › earlyoom,
// point de la barre latérale, confirmation native annulée puis acceptée, fichier fusionné, plus rien à proposer ensuite.
// Usage : npm run build && node scripts/earlyoom-upgrade-e2e.mjs
//
// Rien de réel n'est touché : HOME et XDG_* temporaires sous ~/.cache/pw-eo-upgrade-* (jamais la vraie config ni la vraie
// metrics.db), service systemd laissé tranquille (PROC_WATCH_NO_RECORDER_SYNC), earlyoom simulé (PROC_WATCH_EARLYOOM_FAKE,
// hors paquet seulement) : /etc/default/earlyoom est remplacé par un fichier du dossier temporaire et AUCUN pkexec n'est
// lancé. La boîte de confirmation native est remplacée, dans le main, par une réponse enregistrée.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

mkdirSync(join(homedir(), '.cache'), { recursive: true });
const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-eo-upgrade-')));
const cleanup = () => rmSync(base, { recursive: true, force: true });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

const BASE = 'claude|claude-desktop|warp|zsh|bash|kwin_wayland|kwin_wayland_wr|plasmashell|Xwayland|sddm|systemd.*';
const OLD_TESTS = 'vitest|node..vitest.|jest|pytest|playwright|cypress|mocha|karma|headless_shell|chrome-headless';
// Ligne installée par une version précédente de l'app (anciens défauts), avec une exclusion que la liste protégée n'a plus.
const OLD = `EARLYOOM_ARGS="-m 8,5 -s 35,25 -r 0 --ignore ^(${BASE}|fish|gnome-terminal-|ancien-protege)$ --prefer ^(${OLD_TESTS})$"`;

/** Clic DOM : la fenêtre peut être cachée (Chromium suspend alors requestAnimationFrame). */
const press = async (loc) => {
  await loc.waitFor({ timeout: 10000 });
  await loc.evaluate((el) => el.click());
};

let app = null;
try {
  const home = join(base, 'home');
  const cfg = join(base, 'cfg');
  const data = join(base, 'data');
  const eo = join(base, 'earlyoom');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(cfg, 'computer-watcher'), { recursive: true });
  writeFileSync(join(cfg, 'computer-watcher', 'onboarding.json'), '{"version":1,"done":true}\n');
  mkdirSync(data, { recursive: true });
  mkdirSync(eo, { recursive: true });
  const target = join(eo, 'default');
  writeFileSync(target, `# fichier simulé\n${OLD}\n`);

  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: data, XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(base, 'state'),
    PROC_WATCH_NO_RECORDER_SYNC: '1', PROC_WATCH_NO_ANTIGEL: '1', PROC_WATCH_EARLYOOM_FAKE: eo,
  };
  app = await electron.launch({ args: ['.'], env });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
  await win.waitForSelector('[data-testid="snapshot-ready"]', { timeout: 20000 });

  // confirmation native remplacée (test seulement) : réponse fixée par __eoAnswer, message gardé
  await app.evaluate(({ dialog }) => {
    globalThis.__eoConfirms = [];
    globalThis.__eoAnswer = 0;
    dialog.showMessageBox = async (...a) => {
      const o = a.length > 1 ? a[1] : a[0];
      globalThis.__eoConfirms.push({ message: o.message, detail: o.detail, buttons: o.buttons });
      return { response: globalThis.__eoAnswer, checkboxChecked: false };
    };
  });

  // 1) pop-up du lancement : titre, détail, « Plus tard » respecté
  const popup = win.locator('[data-testid="earlyoom-popup"]');
  await popup.waitFor({ timeout: 10000 });
  const ptext = await popup.innerText();
  assert.match(ptext, /Protection anti-gel à mettre à jour/);
  assert.match(ptext, /MainThread, tsc, eslint/);
  assert.match(ptext, /8 % → 10 %/);
  assert.equal(await win.locator('[data-testid="earlyoom-popup-setup"]').innerText(), 'Mettre à jour');
  await press(win.locator('[data-testid="earlyoom-popup-later"]'));
  await popup.waitFor({ state: 'detached' });
  assert.equal((await win.evaluate(() => window.procWatch.earlyoom.reminder())).mode, null, '« Plus tard » : plus de pop-up dans ce lancement');

  // 2) Réglages › earlyoom : point d'avertissement, carte, un seul bouton
  await press(win.locator('button[aria-label="Réglages"]'));
  const dot = win.locator('[data-testid="settings-dot-earlyoom"]');
  await dot.waitFor({ timeout: 10000 });
  assert.match(await dot.getAttribute('class'), /\bwarn\b/);
  assert.equal(await dot.getAttribute('aria-label'), 'Protection anti-gel à mettre à jour');
  await press(win.locator('[data-testid="settings-nav-earlyoom"]'));
  const card = win.locator('[data-testid="earlyoom-upgrade-card"]');
  await card.waitFor({ timeout: 10000 });
  const ctext = await card.innerText();
  assert.match(ctext, /Protection anti-gel à mettre à jour/);
  assert.match(ctext, /Aucune exclusion retirée/);
  assert.equal(await card.locator('button').count(), 1);

  // 3) confirmation annulée : rien d'écrit
  await press(win.locator('[data-testid="earlyoom-upgrade"]'));
  await win.waitForFunction(() => !document.querySelector('[data-testid="earlyoom-upgrade"]')?.hasAttribute('disabled'));
  assert.equal(readFileSync(target, 'utf8'), `# fichier simulé\n${OLD}\n`);
  assert.equal(existsSync(join(eo, 'applied.log')), false);
  let confirms = await app.evaluate(() => globalThis.__eoConfirms);
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].message, 'Mettre à jour la protection anti-gel (earlyoom) ?');
  assert.deepEqual(confirms[0].buttons, ['Annuler', 'Mettre à jour']);

  // 4) confirmation acceptée : ligne fusionnée écrite (simulation, aucun pkexec), carte et point disparus
  await app.evaluate(() => { globalThis.__eoAnswer = 1; });
  await press(win.locator('[data-testid="earlyoom-upgrade"]'));
  await card.waitFor({ state: 'detached', timeout: 10000 });
  // exclusions du fichier d'abord (dans leur ordre), puis celles de la liste protégée par défaut qui manquaient
  const expected = OLD.replace('-m 8,5', '-m 10,5').replace(`--prefer ^(${OLD_TESTS})$`, `--prefer ^(MainThread|tsc|eslint|${OLD_TESTS})$`)
    .replace('|ancien-protege)$', '|ancien-protege|sh|konsole|kitty|alacritty|wezterm-gui|ghostty|tmux..server|kwin_x11|gnome-shell|Xorg|gdm)$');
  const written = readFileSync(target, 'utf8');
  confirms = await app.evaluate(() => globalThis.__eoConfirms);
  assert.equal(confirms.length, 2);
  const line = written.trim();
  assert.ok(confirms[1].detail.includes(line), 'la confirmation montre la ligne exacte');
  assert.match(line, /^EARLYOOM_ARGS="-m 10,5 -s 35,25 -r 0 --ignore \^\(claude\|.*\|ancien-protege\|/);
  assert.match(line, /--prefer \^\(MainThread\|tsc\|eslint\|vitest\|/);
  for (const keep of ['fish', 'gnome-terminal-', 'ancien-protege', 'systemd.*']) assert.ok(line.includes(`|${keep}`), `exclusion gardée : ${keep}`);
  assert.equal(readFileSync(join(eo, 'applied.log'), 'utf8'), `${line}\n`);
  assert.equal(line, expected);
  await dot.waitFor({ state: 'detached', timeout: 10000 });
  assert.equal(await win.locator('[data-testid="earlyoom-current"]').innerText(), line);

  // 5) plus rien à proposer : ni carte, ni pop-up, et l'IPC refuse une seconde mise à jour sans rien écrire
  const again = await win.evaluate(() => window.procWatch.earlyoom.upgrade());
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'stale');
  assert.equal((await app.evaluate(() => globalThis.__eoConfirms)).length, 2);
  assert.equal(readFileSync(join(eo, 'applied.log'), 'utf8'), `${line}\n`);

  console.log('EARLYOOM UPGRADE E2E OK');
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await app.close().catch(() => {});
  }
  cleanup();
}
