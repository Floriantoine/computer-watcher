// Lancer les commandes lourdes directement dans le budget : état, installation et retrait des trois éléments
// (commande `computer-watcher` dans le PATH, bloc ~/.zshrc, hook ~/.claude/settings.json). Chaque élément s'installe et se
// retire séparément, de façon idempotente. Tous les chemins viennent de `WrapSetupDeps` (HOME, PATH, ZDOTDIR,
// CLAUDE_CONFIG_DIR injectés) : les tests ne touchent jamais les vrais fichiers.
// Règles : sauvegarde horodatée à côté du fichier avant toute écriture, écriture atomique (temporaire puis rename, lien
// symbolique suivi pour ~/.zshrc et settings.json : le fichier pointé est modifié, le lien reste), jamais un fichier
// qui n'est pas de l'app écrasé ou retiré, rien créé si le programme concerné (zsh, Claude Code) n'est pas là.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  accessSync, closeSync, constants as C, copyFileSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync,
  unlinkSync, writeSync,
} from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import {
  addClaudeHook, addZshBlock, backupName, CLAUDE_HOOK_ENTRY, claudeHookState, isOurLauncher, launcherScript, launcherTargetPath, removeClaudeHook,
  removeZshBlock, WRAP_LABELS, WRAP_PARTS, wrapSelection, zshBlock, zshrcState, type LauncherTarget, type WrapAction, type WrapActionResult,
  type WrapApplyResponse, type WrapItemStatus, type WrapPart, type WrapSetupStatus, type WrapTarget,
} from '../core/wrapSetup';
import { readFileSafe, removeFileSafe, writeFileSafe } from './safeFs';

export interface WrapSetupDeps {
  home: string;
  /** PATH, ZDOTDIR, CLAUDE_CONFIG_DIR, SHELL. */
  env: NodeJS.ProcessEnv;
  /** Shell de connexion de l'utilisateur (/etc/passwd), null si inconnu. */
  loginShell: string | null;
  /** Ce que le lanceur appellera ; null : aucun exécutable connu. */
  target: LauncherTarget | null;
  /** `<fichier> should-wrap --help` répond (code 0, usage attendu) ? */
  probe: (file: string) => Promise<boolean>;
  now: () => Date;
}

const MAX_BYTES = 4 * 1024 * 1024;
const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const absEnv = (v: string | undefined) => (v && isAbsolute(v) ? v.replace(/\/+$/, '') || '/' : null);

export function wrapPaths(d: Pick<WrapSetupDeps, 'home' | 'env'>) {
  const binDir = join(d.home, '.local', 'bin');
  const zdot = absEnv(d.env.ZDOTDIR);
  const claudeDir = absEnv(d.env.CLAUDE_CONFIG_DIR) ?? join(d.home, '.claude');
  return {
    binDir,
    launcher: join(binDir, 'computer-watcher'),
    zshrc: join(zdot ?? d.home, '.zshrc'),
    claudeDir,
    settings: join(claudeDir, 'settings.json'),
  };
}

/** Chemin affiché : HOME remplacé par ~. */
export const tilde = (home: string, p: string) => (p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

// ---------------------------------------------------------------- lecture et écriture

type Read = { kind: 'absent' } | { kind: 'error'; error: string } | { kind: 'text'; text: string };

/** Fichier texte (lien suivi), borné. */
function readText(path: string): Read {
  try {
    const st = statSync(path);
    if (!st.isFile()) return { kind: 'error', error: `${path} n’est pas un fichier ordinaire` };
    if (st.size > MAX_BYTES) return { kind: 'error', error: `${path} est trop gros pour être modifié ici` };
    return { kind: 'text', text: readFileSync(path, 'utf8') };
  } catch (e) {
    if (code(e) === 'ENOENT') {
      // lien cassé : présent mais illisible
      try {
        if (lstatSync(path).isSymbolicLink()) return { kind: 'error', error: `${path} est un lien vers un fichier absent` };
      } catch {
        /* vraiment absent */
      }
      return { kind: 'absent' };
    }
    return { kind: 'error', error: `${path} : ${code(e) ?? msg(e)}` };
  }
}

/** Fichier réel visé (lien symbolique suivi) ; absent : le chemin lui-même. */
function realTarget(path: string): string {
  try {
    return lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

/**
 * Écriture atomique : temporaire exclusif dans le dossier du fichier réel, mêmes droits, fsync, puis rename. `expected` :
 * contenu lu au départ ; si le fichier a changé entre-temps (autre programme), rien n'est écrit.
 */
function atomicReplace(path: string, data: string, expected: string | null, defaultMode = 0o644): void {
  const real = realTarget(path);
  const dir = dirname(real);
  let mode = defaultMode;
  try {
    mode = statSync(real).mode & 0o7777;
  } catch {
    /* nouveau fichier */
  }
  const tmp = join(dir, `.${basename(real)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, mode);
  let ino: number | null = fstatSync(fd).ino;
  try {
    try {
      const buf = Buffer.from(data);
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const now = readText(real);
    const current = now.kind === 'text' ? now.text : null;
    if (now.kind === 'error' || current !== expected) throw new Error(`${path} a changé pendant l’opération : rien n’est écrit (réessayer)`);
    renameSync(tmp, real);
    ino = null;
    try {
      const dfd = openSync(dir, C.O_RDONLY | C.O_DIRECTORY);
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      /* fsync de dossier refusé */
    }
  } finally {
    if (ino !== null) {
      try {
        if (lstatSync(tmp).ino === ino) unlinkSync(tmp);
      } catch {
        /* déjà parti */
      }
    }
  }
}

/** Copie de sauvegarde horodatée à côté du chemin affiché (jamais écrasée : suffixe -2, -3… si besoin). */
function backup(path: string, now: Date): string {
  const base = backupName(path, now);
  for (let i = 1; i < 100; i++) {
    const dest = i === 1 ? base : base.replace(/\.bak$/, `-${i}.bak`);
    try {
      copyFileSync(path, dest, C.COPYFILE_EXCL);
      return dest;
    } catch (e) {
      if (code(e) !== 'EEXIST') throw new Error(`sauvegarde impossible (${dest}) : ${code(e) ?? msg(e)} ; rien n’est modifié`);
    }
  }
  throw new Error(`sauvegarde impossible à côté de ${path} : rien n’est modifié`);
}

// ---------------------------------------------------------------- commande dans le PATH

/** Premier `computer-watcher` exécutable du PATH (dossiers absolus seulement), null sinon. */
export function findInPath(pathVar: string | undefined, name = 'computer-watcher'): string | null {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const p = join(dir, name);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, C.X_OK);
      return p;
    } catch {
      /* suivant */
    }
  }
  return null;
}

const inPath = (pathVar: string | undefined, dir: string) => (pathVar ?? '').split(delimiter).some((p) => p.replace(/\/+$/, '') === dir);

type LauncherFile = { kind: 'none' } | { kind: 'ours'; text: string } | { kind: 'foreign'; why: string } | { kind: 'unreadable'; error: string };

function launcherFile(path: string): LauncherFile {
  let l;
  try {
    l = lstatSync(path);
  } catch (e) {
    return code(e) === 'ENOENT' ? { kind: 'none' } : { kind: 'unreadable', error: `${code(e) ?? msg(e)}` };
  }
  if (l.isSymbolicLink()) return { kind: 'foreign', why: 'lien symbolique' };
  if (!l.isFile()) return { kind: 'foreign', why: 'pas un fichier ordinaire' };
  try {
    const text = readFileSync(path, 'utf8');
    return isOurLauncher(text) ? { kind: 'ours', text } : { kind: 'foreign', why: 'sans le marqueur de Computer Watcher' };
  } catch (e) {
    return { kind: 'unreadable', error: `${code(e) ?? msg(e)}` };
  }
}

async function commandStatus(d: WrapSetupDeps): Promise<WrapItemStatus> {
  const p = wrapPaths(d);
  const home = d.home;
  const file = launcherFile(p.launcher);
  const first = findInPath(d.env.PATH);
  const working = first !== null && (await d.probe(first).catch(() => false));
  const wanted = d.target ? launcherScript(d.target) : null;
  const binOk = inPath(d.env.PATH, p.binDir);
  const warnings: string[] = [];
  const base = { part: 'command' as const, path: p.launcher, preview: wanted ?? '', canRemove: file.kind === 'ours' };
  const pathWarning = `${tilde(home, p.binDir)} n’est pas dans le PATH de l’app : s’il manque aussi dans celui du terminal, ajouter « export PATH="$HOME/.local/bin:$PATH" » à ~/.zshrc, sinon ni zsh ni Claude Code ne trouveront la commande.`;
  if (file.kind === 'ours') {
    const target = launcherTargetPath(file.text);
    const targetOk = target !== null && (() => {
      try {
        return statSync(target).isFile();
      } catch {
        return false;
      }
    })();
    if (!binOk) warnings.push(pathWarning);
    else if (first !== null && first !== p.launcher) warnings.push(`Une autre commande passe avant dans le PATH : ${first}.`);
    const outdated = wanted !== null && file.text !== wanted;
    const selfOk = targetOk && (first === p.launcher ? working : await d.probe(p.launcher).catch(() => false));
    return {
      ...base, state: 'ours', ok: selfOk,
      detail: targetOk ? `Installée par Computer Watcher : appelle ${target}.` : `Installée par Computer Watcher, mais ${target ?? 'sa cible'} n’existe plus : « Installer » la met à jour.`,
      canInstall: wanted !== null && (outdated || !targetOk), blocked: wanted === null && !targetOk ? noTarget : null, warnings,
    };
  }
  if (file.kind === 'foreign' || file.kind === 'unreadable') {
    const why = file.kind === 'foreign' ? `existe déjà (${file.why})` : `est illisible (${file.error})`;
    return {
      ...base, state: file.kind, ok: working,
      detail: working ? `La commande ${first} répond déjà : rien à faire.` : `${tilde(home, p.launcher)} ${why} et ne répond pas à « should-wrap ».`,
      canInstall: false,
      blocked: working ? null : `${tilde(home, p.launcher)} ${why} : jamais écrasé. Le mettre à jour à la main (voir le README) ou le supprimer, puis « Installer ».`,
      warnings,
    };
  }
  if (working) {
    return { ...base, state: 'foreign', path: first!, ok: true, detail: `La commande ${first} répond déjà : rien à faire.`, canInstall: false, blocked: null, warnings };
  }
  if (wanted !== null && !binOk) warnings.push(pathWarning);
  if (first !== null) warnings.push(`${first} est dans le PATH mais ne répond pas à « should-wrap » (ancienne version ?) et passera avant le lanceur.`);
  return {
    ...base, state: 'absent', ok: false,
    detail: wanted ? `Aucune commande computer-watcher utilisable : « Installer » crée ${tilde(home, p.launcher)}.` : 'Aucune commande computer-watcher utilisable.',
    canInstall: wanted !== null, blocked: wanted === null ? noTarget : null, warnings,
  };
}

const noTarget = 'Exécutable de l’app introuvable (ni AppImage, ni paquet installé) : impossible d’écrire le lanceur.';

// ---------------------------------------------------------------- ~/.zshrc

const isZsh = (s: string | null | undefined) => !!s && basename(s) === 'zsh';

function zshrcStatus(d: WrapSetupDeps): WrapItemStatus {
  const p = wrapPaths(d);
  const shown = tilde(d.home, p.zshrc);
  const r = readText(p.zshrc);
  const base = { part: 'zshrc' as const, path: p.zshrc, preview: zshBlock(), warnings: [] as string[] };
  if (r.kind === 'error') return { ...base, state: 'unreadable', ok: false, detail: r.error, canInstall: false, canRemove: false, blocked: `${shown} illisible : rien n’est modifié.` };
  if (r.kind === 'absent') {
    const shell = d.loginShell ?? d.env.SHELL ?? null;
    const zsh = isZsh(d.loginShell) || (!d.loginShell && isZsh(d.env.SHELL));
    return {
      ...base, state: 'absent', ok: false, detail: `${shown} n’existe pas.`, canInstall: zsh, canRemove: false,
      blocked: zsh ? null : `zsh n’est pas votre shell (${shell ?? 'inconnu'}) : ${shown} n’est pas créé.`,
    };
  }
  const s = zshrcState(r.text);
  if (s === 'broken') {
    return { ...base, state: 'unreadable', ok: false, detail: `Bloc computer-watcher incomplet dans ${shown}.`, canInstall: false, canRemove: false, blocked: `Bloc incomplet dans ${shown} : à corriger à la main.` };
  }
  if (s === 'ours') return { ...base, state: 'ours', ok: true, detail: `Bloc présent à la fin de ${shown}.`, canInstall: false, canRemove: true, blocked: null };
  if (s === 'foreign') return { ...base, state: 'foreign', ok: true, detail: `${shown} charge déjà shell-init (ajouté à la main) : laissé tel quel.`, canInstall: false, canRemove: false, blocked: null };
  return { ...base, state: 'absent', ok: false, detail: `Rien dans ${shown}.`, canInstall: true, canRemove: false, blocked: null };
}

// ---------------------------------------------------------------- ~/.claude/settings.json

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export const CLAUDE_PREVIEW = `"hooks": { "PreToolUse": [ …, ${JSON.stringify(CLAUDE_HOOK_ENTRY)} ] }`;

function claudeStatus(d: WrapSetupDeps): WrapItemStatus {
  const p = wrapPaths(d);
  const shown = tilde(d.home, p.settings);
  const base = { part: 'claude' as const, path: p.settings, preview: CLAUDE_PREVIEW, warnings: [] as string[] };
  if (!isDir(p.claudeDir)) {
    return {
      ...base, state: 'absent', ok: false, detail: `Claude Code n’est pas installé (${tilde(d.home, p.claudeDir)} absent).`, canInstall: false, canRemove: false,
      blocked: `Claude Code n’est pas installé (${tilde(d.home, p.claudeDir)} absent) : rien n’est créé.`,
    };
  }
  const r = readText(p.settings);
  if (r.kind === 'error') return { ...base, state: 'unreadable', ok: false, detail: r.error, canInstall: false, canRemove: false, blocked: `${shown} illisible : rien n’est modifié.` };
  const text = r.kind === 'text' ? r.text : null;
  const s = claudeHookState(text);
  if (s === 'invalid') {
    let why = '';
    try {
      addClaudeHook(text);
    } catch (e) {
      why = msg(e);
    }
    return { ...base, state: 'unreadable', ok: false, detail: `${shown} : ${why}`, canInstall: false, canRemove: false, blocked: `${shown} : ${why}` };
  }
  if (s === 'ours') return { ...base, state: 'ours', ok: true, detail: `Hook présent dans ${shown} (nouvelles sessions de Claude Code).`, canInstall: false, canRemove: true, blocked: null };
  if (s === 'foreign') return { ...base, state: 'foreign', ok: true, detail: `${shown} appelle déjà claude-hook (ajouté à la main) : laissé tel quel.`, canInstall: false, canRemove: false, blocked: null };
  return { ...base, state: 'absent', ok: false, detail: text === null ? `${shown} n’existe pas : il sera créé.` : `Aucun hook computer-watcher dans ${shown}.`, canInstall: true, canRemove: false, blocked: null };
}

// ---------------------------------------------------------------- état, installation, retrait

export async function wrapStatus(d: WrapSetupDeps): Promise<WrapSetupStatus> {
  const items = [await commandStatus(d), zshrcStatus(d), claudeStatus(d)];
  return { items, complete: items.every((i) => i.ok) };
}

export async function itemStatus(d: WrapSetupDeps, part: WrapPart): Promise<WrapItemStatus> {
  return part === 'command' ? commandStatus(d) : part === 'zshrc' ? zshrcStatus(d) : claudeStatus(d);
}

const result = (part: WrapPart, changed: boolean, message: string, backupPath: string | null = null, warnings: string[] = []): WrapActionResult => ({
  part, changed, message, backup: backupPath, warnings,
});

/** Installe un élément ; déjà en place : rien. Refus (fichier étranger, JSON invalide, programme absent) : exception claire. */
export async function installWrap(d: WrapSetupDeps, part: WrapPart): Promise<WrapActionResult> {
  const p = wrapPaths(d);
  const s = await itemStatus(d, part);
  if (!s.canInstall) {
    if (s.ok) return result(part, false, s.detail, null, s.warnings);
    throw new Error(s.blocked ?? s.detail);
  }
  if (part === 'command') {
    const script = launcherScript(d.target!);
    writeFileSafe([d.home], p.launcher, script, 0o755, {
      guard: (cur) => (cur !== null && isOurLauncher(cur) ? null : `${p.launcher} n’est pas de Computer Watcher : jamais écrasé`),
    });
    const after = await commandStatus(d);
    return result(part, true, `Lanceur écrit : ${p.launcher}`, null, after.warnings);
  }
  if (part === 'zshrc') {
    const r = readText(p.zshrc);
    if (r.kind === 'error') throw new Error(r.error);
    const before = r.kind === 'text' ? r.text : null;
    const next = addZshBlock(before ?? '');
    if (next === before) return result(part, false, 'Bloc déjà présent');
    const bak = before !== null ? backup(p.zshrc, d.now()) : null;
    atomicReplace(p.zshrc, next, before);
    return result(part, true, `Bloc ajouté à la fin de ${p.zshrc} (nouveaux terminaux)`, bak);
  }
  const r = readText(p.settings);
  if (r.kind === 'error') throw new Error(r.error);
  const before = r.kind === 'text' ? r.text : null;
  const next = addClaudeHook(before);
  if (next === before) return result(part, false, 'Hook déjà présent');
  const bak = before !== null ? backup(p.settings, d.now()) : null;
  atomicReplace(p.settings, next, before);
  return result(part, true, `Hook ajouté dans ${p.settings} (nouvelles sessions de Claude Code)`, bak);
}

/** Retire ce que l'app a écrit pour un élément ; rien de l'app : rien. */
export async function removeWrap(d: WrapSetupDeps, part: WrapPart): Promise<WrapActionResult> {
  const p = wrapPaths(d);
  if (part === 'command') {
    const f = launcherFile(p.launcher);
    if (f.kind === 'none') return result(part, false, 'Lanceur déjà absent');
    if (f.kind !== 'ours') throw new Error(`${p.launcher} n’est pas de Computer Watcher : laissé en place`);
    // revérifié juste avant (fichier ordinaire, marqueur), puis retiré sans suivre de lien
    const again = readFileSafe([d.home], p.launcher);
    if (again === null || !isOurLauncher(again)) throw new Error(`${p.launcher} a changé : laissé en place`);
    removeFileSafe([d.home], p.launcher);
    return result(part, true, `Lanceur retiré : ${p.launcher}`);
  }
  const path = part === 'zshrc' ? p.zshrc : p.settings;
  const r = readText(path);
  if (r.kind === 'absent') return result(part, false, `${path} absent : rien à retirer`);
  if (r.kind === 'error') throw new Error(r.error);
  const next = part === 'zshrc' ? removeZshBlock(r.text) : removeClaudeHook(r.text);
  if (next === r.text) return result(part, false, 'Rien de Computer Watcher à retirer');
  const bak = backup(path, d.now());
  atomicReplace(path, next, r.text);
  return result(part, true, part === 'zshrc' ? `Bloc retiré de ${path}` : `Hook retiré de ${path}`, bak);
}

/** Éléments installés par l'app (pour la désinstallation de l'app), dans l'ordre de retrait : hook, bloc, lanceur. */
export function ownedWrapParts(d: Pick<WrapSetupDeps, 'home' | 'env'>): { part: WrapPart; path: string }[] {
  const p = wrapPaths(d);
  const out: { part: WrapPart; path: string }[] = [];
  const s = readText(p.settings);
  if (s.kind === 'text' && claudeHookState(s.text) === 'ours') out.push({ part: 'claude', path: p.settings });
  const z = readText(p.zshrc);
  if (z.kind === 'text' && zshrcState(z.text) === 'ours') out.push({ part: 'zshrc', path: p.zshrc });
  if (launcherFile(p.launcher).kind === 'ours') out.push({ part: 'command', path: p.launcher });
  return out;
}

/** Texte de la confirmation native : fichiers modifiés et emplacement des sauvegardes. */
export function wrapConfirmText(home: string, action: 'install' | 'remove', items: readonly WrapItemStatus[]): { message: string; detail: string; confirm: string } {
  const what = (i: WrapItemStatus) => {
    const f = tilde(home, i.path);
    if (i.part === 'command') return action === 'install' ? `• ${f} : lanceur créé (exécutable)` : `• ${f} : lanceur supprimé`;
    if (i.part === 'zshrc') return action === 'install' ? `• ${f} : bloc de 4 lignes ajouté à la fin` : `• ${f} : bloc computer-watcher retiré`;
    return action === 'install' ? `• ${f} : une entrée ajoutée dans hooks.PreToolUse, le reste inchangé` : `• ${f} : l’entrée computer-watcher retirée de hooks.PreToolUse`;
  };
  const edited = items.filter((i) => i.part !== 'command');
  const backups = edited.length
    ? ['', 'Sauvegarde avant écriture, à côté de chaque fichier :', ...edited.map((i) => `  ${tilde(home, i.path)}.computer-watcher-AAAAMMJJ-HHMMSS.bak`)]
    : [];
  const labels = items.map((i) => WRAP_LABELS[i.part]).join(', ');
  return {
    message: action === 'install' ? `Installer le lancement dans le budget (${labels}) ?` : `Retirer le lancement dans le budget (${labels}) ?`,
    detail: [action === 'install' ? 'Fichiers modifiés :' : 'Fichiers modifiés :', ...items.map(what), ...backups].join('\n'),
    confirm: action === 'install' ? 'Installer' : 'Retirer',
  };
}

export { WRAP_PARTS };

/** Sonde réelle : `<fichier> should-wrap --help`, 10 s au plus, sortie bornée ; vrai si l'usage attendu revient. */
export function realProbe(file: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    const clean = { ...env };
    delete clean.ELECTRON_RUN_AS_NODE;
    execFile(file, ['should-wrap', '--help'], { timeout: 10_000, maxBuffer: 64 * 1024, env: clean }, (err, stdout) => {
      resolve(!err && /computer-watcher should-wrap/.test(String(stdout)));
    });
  });
}

/**
 * « Installer » / « Retirer » depuis Réglages : état relu, éléments choisis ici (jamais de chemin venu du renderer),
 * confirmation (fichiers modifiés et sauvegardes), puis chaque élément à son tour ; une erreur n'arrête pas les autres.
 */
export async function applyWrap(
  d: WrapSetupDeps, action: WrapAction, part: WrapTarget,
  confirm: (c: { message: string; detail: string; confirm: string }) => Promise<boolean>,
): Promise<WrapApplyResponse> {
  const before = await wrapStatus(d);
  const items = wrapSelection(before, action, part);
  if (!items.length) return { cancelled: false, results: [], errors: [], status: before };
  if (!(await confirm(wrapConfirmText(d.home, action, items)))) return { cancelled: true };
  const results: WrapActionResult[] = [];
  const errors: { part: WrapPart; error: string }[] = [];
  for (const i of items) {
    try {
      results.push(action === 'install' ? await installWrap(d, i.part) : await removeWrap(d, i.part));
    } catch (e) {
      errors.push({ part: i.part, error: msg(e) });
    }
  }
  return { cancelled: false, results, errors, status: await wrapStatus(d) };
}
