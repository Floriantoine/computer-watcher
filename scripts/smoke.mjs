import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

// Config temporaire (sous ~/.cache : /tmp est en RAM) : jamais la config réelle, et pas de collision avec le verrou
// d'instance unique d'une app proc-watch déjà ouverte. PROC_WATCH_NO_RECORDER_SYNC : le service systemd réel n'est pas touché.
mkdirSync(join(homedir(), '.cache'), { recursive: true });
const cfg = mkdtempSync(join(homedir(), '.cache', 'pw-smoke-'));
const env = { ...process.env, XDG_CONFIG_HOME: cfg, PROC_WATCH_NO_RECORDER_SYNC: '1' };
const app = await electron.launch(
  process.env.SMOKE_EXECUTABLE ? { executablePath: process.env.SMOKE_EXECUTABLE, args: [], env } : { args: ['.'], env },
);
try {
  const win = await app.firstWindow();
  const selector = process.env.SMOKE_SELECTOR ?? '[data-testid="snapshot-ready"]';
  await win.waitForSelector(selector, { timeout: 15000 });
  await win.screenshot({ path: process.env.SMOKE_SCREENSHOT ?? 'smoke.png' });
  console.log('SMOKE OK:', await win.locator(selector).first().innerText());
  if (process.env.SMOKE_DETAIL) {
    await win.locator('[data-testid="group-card"]').first().click();
    await win.waitForSelector('table.tree, .subgroup', { timeout: 5000 });
    await win.screenshot({ path: 'smoke-detail.png' });
  }
} finally {
  // Fermer la fenêtre la garderait dans la barre des tâches : quitter explicitement.
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await app.close();
  rmSync(cfg, { recursive: true, force: true });
}
