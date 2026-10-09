// « Ouvrir dans le gestionnaire de fichiers » (soleil de la page Disque) : seulement un dossier réel sous HOME, par
// xdg-open en chemin absolu et environnement nettoyé. Aucune suppression ici.
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { cleanEnv, systemBin } from '../core/childEnv';

export interface OpenDeps {
  home: string;
  spawn?: (cmd: string, args: string[]) => void;
  exists?: (p: string) => boolean;
}

const defaultSpawn = (cmd: string, args: string[]) => {
  const c = nodeSpawn(cmd, args, { detached: true, stdio: 'ignore', env: cleanEnv(process.env) });
  c.on('error', () => {});
  c.unref();
};

export function openInFileManager(raw: unknown, d: OpenDeps): { ok: true } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.includes('\u0000') || raw.split('/').includes('..')) return { ok: false, error: 'chemin refusé' };
  let real: string;
  let home: string;
  try {
    real = realpathSync(raw);
    home = realpathSync(d.home);
    if (!statSync(real).isDirectory()) return { ok: false, error: 'pas un dossier' };
  } catch {
    return { ok: false, error: 'introuvable' };
  }
  // le chemin réel (liens résolus) doit rester sous le dossier personnel
  if (real !== home && !real.startsWith(`${home}/`)) return { ok: false, error: 'hors du dossier personnel' };
  const bin = systemBin('xdg-open', d.exists ?? existsSync);
  if (!bin) return { ok: false, error: 'xdg-open introuvable' };
  (d.spawn ?? defaultSpawn)(bin, [real]);
  return { ok: true };
}
