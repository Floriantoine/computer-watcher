// Protection mémoire système du bureau prioritaire, fenêtre de bout en bout. Usage : npm run test:desk-root
//
// Rien de réel n'est touché : HOME et XDG temporaires sous ~/.cache/pw-desk-root-e2e-* (jamais la vraie config ni la vraie
// metrics.db), PROC_WATCH_NO_RECORDER_SYNC=1, PROC_WATCH_NO_ANTIGEL=1, état du service SIMULÉ (antigel-state.json écrit par ce
// script). PROC_WATCH_DESK_ROOT_FAKE (hors paquet seulement) : /etc/systemd/system, systemctl et /sys/fs/cgroup remplacés par
// des fichiers du dossier temporaire ; le VRAI script root est lancé par /usr/bin/bash, JAMAIS pkexec. Le faux systemctl, sur
// daemon-reload, recopie la valeur des drop-ins dans le faux memory.low (comme systemd). La boîte de confirmation native est
// remplacée, dans le main, par une réponse enregistrée. Captures seulement si DESK_ROOT_SHOTS désigne un dossier (hors du dépôt).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

mkdirSync(join(homedir(), '.cache'), { recursive: true });
const base = realpathSync(mkdtempSync(join(homedir(), '.cache', 'pw-desk-root-e2e-')));
let app = null;
let timer = null;
const cleanup = () => {
  clearInterval(timer);
  rmSync(base, { recursive: true, force: true });
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    await Promise.race([app?.close().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    cleanup();
    process.exit(130);
  });
}
const waitFor = async (fn, what, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`délai dépassé : ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
/** Clic DOM : la fenêtre peut être cachée (Chromium suspend alors requestAnimationFrame). */
const press = async (loc) => {
  await loc.waitFor({ timeout: 10000 });
  await loc.evaluate((el) => el.click());
};

try {
  const home = join(base, 'home');
  const cfg = join(base, 'cfg');
  const data = join(base, 'data');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(cfg, 'computer-watcher'), { recursive: true });
  writeFileSync(join(cfg, 'computer-watcher', 'onboarding.json'), '{"version":1,"done":true}\n');
  const dataApp = join(data, 'computer-watcher');
  mkdirSync(dataApp, { recursive: true });

  // fausse racine : etc/, cgroup/ (memory.low à 0), mounts, systemctl
  const fake = join(base, 'root');
  const uid = process.getuid();
  const levels = ['user.slice', `user.slice/user-${uid}.slice`, `user.slice/user-${uid}.slice/user@${uid}.service`];
  mkdirSync(join(fake, 'etc'), { recursive: true });
  for (const l of levels) {
    mkdirSync(join(fake, 'cgroup', l), { recursive: true });
    writeFileSync(join(fake, 'cgroup', l, 'memory.low'), '0\n');
  }
  writeFileSync(join(fake, 'mounts'), 'cgroup2 /sys/fs/cgroup cgroup2 rw,nosuid,nodev,noexec,relatime,nsdelegate,memory_recursiveprot 0 0\n');
  writeFileSync(join(fake, 'systemctl'), `#!/bin/bash
D='${fake}'
printf '%s\\n' "$*" >> "$D/systemctl.log"
[[ "$1" == daemon-reload ]] || exit 0
v=0
f="$D/etc/user.slice.d/computer-watcher-desk.conf"
if [[ -f "$f" ]]; then mb=$(sed -n 's/^MemoryLow=\\([0-9]*\\)M$/\\1/p' "$f"); v=$((mb * 1048576)); fi
${levels.map((l) => `printf '%s\\n' "$v" > "$D/cgroup/${l}/memory.low"`).join('\n')}
`);
  chmodSync(join(fake, 'systemctl'), 0o755);
  const log = () => (existsSync(join(fake, 'systemctl.log')) ? readFileSync(join(fake, 'systemctl.log'), 'utf8') : '');
  const dropins = ['user.slice.d', 'user-.slice.d', 'user@.service.d'].map((d) => join(fake, 'etc', d, 'computer-watcher-desk.conf'));

  // valeur attendue : réserve automatique max(4 Go, 15 % de la RAM), au Mo supérieur, au plus la moitié de la RAM
  const MiB = 1024 * 1024;
  const total = totalmem();
  const mb = Math.min(Math.ceil(Math.max(4 * 1024 * MiB, Math.round(0.15 * total)) / MiB), Math.floor(total / 2 / MiB));

  // état simulé du service : bureau prioritaire actif, protection mémoire sans effet (niveaux système sans protection)
  const G = 1024 * 1024;
  const state = () => ({
    version: 1, at: Date.now(), enabled: true, status: 'active', reason: null, memTotalKB: Math.round(total / 1024), reserveKB: 5 * G,
    slice: { currentKB: 2 * G, highKB: 9 * G, maxKB: 29 * G, swapMaxKB: 10 * G, throttles: 0, oomKills: 0, throttled: false },
    projects: [], slices: {}, lastError: null, tickMs: 0.4, dbusCalls: 0,
    desk: { status: 'active', reason: null, cpu: true, io: false, memory: 'ineffective', units: ['session.slice', 'app.slice', 'cwatch.slice'], truncated: false, restoring: 0 },
  });
  const writeState = () => {
    const p = join(dataApp, 'antigel-state.json');
    writeFileSync(`${p}.tmp`, JSON.stringify(state()), { mode: 0o600 });
    renameSync(`${p}.tmp`, p);
  };
  writeState();
  timer = setInterval(writeState, 1000);

  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: data, XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(base, 'state'),
    PROC_WATCH_NO_RECORDER_SYNC: '1', PROC_WATCH_NO_KILL: '1', PROC_WATCH_NO_ANTIGEL: '1', PROC_WATCH_EARLYOOM_FAKE: join(base, 'earlyoom'),
    PROC_WATCH_DESK_ROOT_FAKE: fake,
  };
  mkdirSync(env.PROC_WATCH_EARLYOOM_FAKE);
  app = await electron.launch({ args: ['.'], env });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
  await win.waitForSelector('[data-testid="snapshot-ready"]', { timeout: 20000 });
  // pop-up earlyoom éventuel (earlyoom simulé sans fichier) : « Plus tard »
  await win.locator('[data-testid="earlyoom-popup-later"]').click({ timeout: 3000 }).catch(() => {});

  await app.evaluate(({ dialog }) => {
    globalThis.__drConfirms = [];
    globalThis.__drAnswer = 0;
    dialog.showMessageBox = async (...a) => {
      const o = a.length > 1 ? a[1] : a[0];
      globalThis.__drConfirms.push({ title: o.title, message: o.message, detail: o.detail, buttons: o.buttons });
      return { response: globalThis.__drAnswer, checkboxChecked: false };
    };
  });
  const confirms = () => app.evaluate(() => globalThis.__drConfirms);
  const shots = process.env.DESK_ROOT_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const shot = async (name, el) => { if (shots) await el.screenshot({ path: join(shots, `${name}.png`) }); };
  /** Ligne lisible : résumé sans fond de jauge, libellé ni écrasé ni recouvert par le résumé ou les boutons. */
  const assertRowLayout = async (what) => {
    const row = win.locator('.s-row', { has: win.locator('[data-testid="desk-root-summary"]') });
    const box = async (loc) => (await loc.count() ? loc.boundingBox() : null);
    const label = await box(row.locator('.s-label'));
    const parts = (await Promise.all(['[data-testid="desk-root-summary"]', '[data-testid="desk-root-apply"]', '[data-testid="desk-root-remove"]']
      .map((s) => box(row.locator(s))))).filter(Boolean);
    const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    assert.ok(label.width >= 120, `${what} : libellé écrasé (${Math.round(label.width)} px)`);
    for (const p of parts) assert.ok(!overlap(label, p), `${what} : le libellé chevauche ${JSON.stringify(p)}`);
    const bg = await row.locator('[data-testid="desk-root-summary"]').evaluate((el) => getComputedStyle(el).backgroundImage);
    assert.equal(bg, 'none', `${what} : fond du résumé`);
  };

  // 1) Métriques : ligne « sans effet ici » avec l'invitation, bouton « Activer » ; annulé → rien d'écrit
  await press(win.locator('[data-testid="tab-metrics"]'));
  const agCard = win.locator('[data-testid="antigel-card"]');
  await agCard.waitFor({ timeout: 15000 });
  await waitFor(async () => /protection mémoire sans effet ici \(les niveaux système au-dessus de la session n’en ont pas\) : « Activer » la pose au niveau système/.test(await agCard.innerText()), 'ligne « Activer » de la carte');
  const cardBtn = win.locator('[data-testid="antigel-desk-root-apply"]');
  assert.match(await cardBtn.innerText(), /Activer/);
  await press(cardBtn);
  await win.locator('[data-testid="antigel-desk-root-message"]').waitFor({ timeout: 10000 });
  assert.match(await win.locator('[data-testid="antigel-desk-root-message"]').innerText(), /Annulé : rien n’a été modifié/);
  let c = await confirms();
  assert.equal(c.length, 1);
  assert.equal(c[0].message, 'Activer la protection mémoire du bureau au niveau système ?');
  assert.deepEqual(c[0].buttons, ['Annuler', 'Activer']);
  for (const p of dropins) assert.ok(c[0].detail.includes(p), `la confirmation montre ${p}`);
  assert.ok(c[0].detail.includes(`MemoryLow=${mb}M`));
  assert.ok(c[0].detail.includes('systemctl daemon-reload'));
  assert.ok(c[0].detail.includes(`pkexec /usr/bin/bash -c … computer-watcher-desk install ${mb}`));
  for (const p of dropins) assert.equal(existsSync(p), false, 'annulé : aucun fichier');
  assert.equal(log(), '');

  // 2) Réglages → Plafond de travail : « Non activée », « Activer » accepté → fichiers, daemon-reload, effet vérifié
  await press(win.locator('button[aria-label="Réglages"]'));
  await press(win.locator('#settings-tab-antigel'));
  const summary = win.locator('[data-testid="desk-root-summary"]');
  await summary.waitFor({ timeout: 10000 });
  assert.match(await summary.innerText(), new RegExp(`^Non activée : user\\.slice, user-${uid}\\.slice et user@${uid}\\.service n’ont aucune protection mémoire.*« Activer » y pose ${mb} Mo \\(réserve du bureau\\)\\. \\(simulé\\)$`));
  assert.equal(await win.locator('[data-testid="desk-root-remove"]').count(), 0);
  await shot('desk-root-absent', win.locator('[data-testid="antigel-settings"]'));
  await assertRowLayout('« Non activée »');
  await app.evaluate(() => { globalThis.__drAnswer = 1; });
  await press(win.locator('[data-testid="desk-root-apply"]'));
  await waitFor(async () => /^Active : /.test(await summary.innerText()), 'résumé « Active »');
  assert.equal(await summary.innerText(), `Active : ${mb} Mo protégés sur user.slice, user-${uid}.slice et user@${uid}.service (memory.low vérifié). (simulé)`);
  assert.match(await win.locator('[data-testid="desk-root-message"]').innerText(), new RegExp(`^Protection mémoire système active \\(${mb} Mo sur `));
  for (const [k, p] of dropins.entries()) {
    const text = readFileSync(p, 'utf8');
    assert.ok(text.startsWith('# Computer Watcher : protection mémoire du bureau prioritaire'));
    assert.ok(text.endsWith(`[${k === 2 ? 'Service' : 'Slice'}]\nMemoryLow=${mb}M\n`));
  }
  assert.equal(log(), 'daemon-reload\n');
  for (const l of levels) assert.equal(readFileSync(join(fake, 'cgroup', l, 'memory.low'), 'utf8'), `${mb * MiB}\n`);
  assert.equal(await win.locator('[data-testid="desk-root-apply"]').count(), 0, 'plus rien à activer');
  await shot('desk-root-active', win.locator('[data-testid="antigel-settings"]'));
  await assertRowLayout('« Active »');
  // ligne du bureau prioritaire dans Réglages
  await waitFor(async () => /protection mémoire système active, prise en compte par le service sous 5 min/.test(await win.locator('[data-testid="antigel-desk-status"]').innerText()), 'ligne Réglages « active »');

  // 3) Métriques : ligne « active », plus de bouton
  await press(win.locator('[data-testid="tab-metrics"]'));
  await agCard.waitFor();
  await waitFor(async () => /protection mémoire système active, prise en compte par le service sous 5 min/.test(await agCard.innerText()), 'ligne de carte « active »');
  assert.equal(await win.locator('[data-testid="antigel-desk-root-apply"]').count(), 0);

  // 4) une seconde activation par l'IPC : refusée, rien relancé
  const again = await win.evaluate(() => window.procWatch.deskRoot.apply('install'));
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'stale');
  assert.equal(log(), 'daemon-reload\n');

  // 5) Réglages : « Retirer » → fichiers et dossiers retirés, memory.low à 0, « Non activée »
  await press(win.locator('button[aria-label="Réglages"]'));
  await press(win.locator('#settings-tab-antigel'));
  await press(win.locator('[data-testid="desk-root-remove"]'));
  await waitFor(async () => /^Non activée/.test(await summary.innerText()), 'résumé « Non activée » après retrait');
  c = await confirms();
  assert.equal(c.at(-1).message, 'Retirer la protection mémoire système du bureau ?');
  assert.ok(c.at(-1).detail.includes('computer-watcher-desk remove 0'));
  for (const p of dropins) assert.equal(existsSync(p), false);
  assert.equal(existsSync(join(fake, 'etc', 'user.slice.d')), false);
  assert.equal(log(), 'daemon-reload\ndaemon-reload\n');
  for (const l of levels) assert.equal(readFileSync(join(fake, 'cgroup', l, 'memory.low'), 'utf8'), '0\n');

  console.log('DESK ROOT E2E OK');
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await app.close().catch(() => {});
  }
  cleanup();
}
