import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const UNIT_NAME = 'proc-watch-recorder.service';

export function systemdQuote(arg: string): string {
  return '"' + arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$') + '"';
}

export function recorderExecArgs(p: { appImage?: string; execPath: string; appPath: string }): string[] {
  if (p.appImage) return [p.appImage, '-e', "require(process.env.APPDIR + '/resources/app.asar/out/main/recorder.js')"];
  return [p.execPath, join(p.appPath, 'out/main/recorder.js')];
}

export function recorderUnit(args: string[]): string {
  return [
    '[Unit]',
    'Description=proc-watch recorder (historique des processus)',
    // au plus 5 démarrages en 5 min : pas de boucle infinie si le binaire a disparu
    'StartLimitIntervalSec=300',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Environment=ELECTRON_RUN_AS_NODE=1',
    `ExecStart=${args.map(systemdQuote).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=5',
    'Nice=10',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function unitPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd/user', UNIT_NAME);
}

/**
 * Installer/activer le service au démarrage de l'app ? Oui pour une version installée ; pour un clone de dev,
 * seulement avec PROC_WATCH_RECORDER_DEV=1 (pas de service permanent installé en silence). Le réglage
 * « Enregistrer l'historique », action explicite, gère le service dans tous les cas.
 */
export function autoManageService(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return isPackaged || env.PROC_WATCH_RECORDER_DEV === '1';
}

export type Systemctl = (args: string[]) => Promise<{ ok: boolean; stdout: string }>;

export const defaultSystemctl: Systemctl = (args) =>
  new Promise((resolve) => {
    execFile('systemctl', ['--user', ...args], { timeout: 5000 }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout) }));
  });

export async function systemctlAvailable(run: Systemctl): Promise<boolean> {
  return (await run(['show-environment'])).ok;
}

export async function ensureRecorderService(o: {
  enabled: boolean;
  args: string[];
  path: string;
  run: Systemctl;
}): Promise<'installed' | 'updated' | 'unchanged' | 'removed' | 'absent'> {
  const exists = existsSync(o.path);
  if (!o.enabled) {
    if (!exists) return 'absent';
    await o.run(['disable', '--now', UNIT_NAME]);
    rmSync(o.path, { force: true });
    await o.run(['daemon-reload']);
    return 'removed';
  }
  const content = recorderUnit(o.args);
  if (exists && readFileSync(o.path, 'utf8') === content) {
    await o.run(['enable', '--now', UNIT_NAME]);
    return 'unchanged';
  }
  mkdirSync(dirname(o.path), { recursive: true });
  writeFileSync(o.path, content);
  await o.run(['daemon-reload']);
  if (!exists) {
    await o.run(['enable', '--now', UNIT_NAME]);
    return 'installed';
  }
  await o.run(['enable', UNIT_NAME]);
  await o.run(['restart', UNIT_NAME]);
  return 'updated';
}
