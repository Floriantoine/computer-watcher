import { _electron as electron } from 'playwright';

const app = await electron.launch(
  process.env.SMOKE_EXECUTABLE ? { executablePath: process.env.SMOKE_EXECUTABLE, args: [] } : { args: ['.'] },
);
try {
  const win = await app.firstWindow();
  const selector = process.env.SMOKE_SELECTOR ?? '[data-testid="snapshot-ready"]';
  await win.waitForSelector(selector, { timeout: 15000 });
  await win.screenshot({ path: process.env.SMOKE_SCREENSHOT ?? 'smoke.png' });
  console.log('SMOKE OK:', await win.locator(selector).first().innerText());
} finally {
  await app.close();
}
