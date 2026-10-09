// Environnement et outils des processus lancés par l'app (ou par le service) quand elle tourne depuis une AppImage.
// L'AppRun d'electron-builder préfixe PATH, LD_LIBRARY_PATH, XDG_DATA_DIRS et GSETTINGS_SCHEMA_DIR par le montage
// /tmp/.mount_* : une fois l'AppImage quittée, ce nom redevient libre dans un /tmp où tout le monde écrit. Un processus
// qui survit à l'app (copie relancée, nettoyage d'après sortie, app lancée par le service) ne doit jamais s'en servir.

/** Variables posées par le runtime AppImage : la copie relancée pose les siennes. */
const RUNTIME_VARS = ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD'];
const MOUNT_PREFIX = '/tmp/.mount_';

const under = (entry: string, dir: string) => entry === dir || entry.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

/**
 * Copie de l'environnement sans les variables du runtime AppImage, et sans aucune entrée (listes séparées par « : »)
 * sous APPDIR ou sous /tmp/.mount_* ; une variable qui devient vide est retirée.
 */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const appdir = env.APPDIR && env.APPDIR.startsWith('/') ? env.APPDIR : null;
  const bad = (e: string) => e.startsWith(MOUNT_PREFIX) || (appdir !== null && under(e, appdir));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (RUNTIME_VARS.includes(k) || v === undefined) continue;
    if (!v.includes(MOUNT_PREFIX) && !(appdir && v.includes(appdir))) {
      out[k] = v;
      continue;
    }
    const kept = v.split(':').filter((e) => e !== '' && !bad(e));
    if (kept.length) out[k] = kept.join(':');
  }
  return out;
}

/** Outil système par chemin absolu : /usr/bin/<nom>, sinon /bin/<nom>, sinon null (jamais de recherche dans le PATH). */
export function systemBin(name: string, exists: (p: string) => boolean): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) throw new Error(`Nom d’outil refusé : ${name}`);
  for (const dir of ['/usr/bin', '/bin']) if (exists(`${dir}/${name}`)) return `${dir}/${name}`;
  return null;
}
