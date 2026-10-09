// Assistant d'accueil (logique pure) : étapes, fichier d'état (`onboarding.json` du dossier de config), ouverture, clavier.

export type OnboardingStep = 'install' | 'autostart' | 'history' | 'earlyoom';

export const ONBOARDING_STEPS: Record<OnboardingStep, { title: string; short: string }> = {
  install: { title: 'Installer comme une app', short: 'Installer' },
  autostart: { title: 'Démarrer avec la session', short: 'Démarrage' },
  history: { title: 'Historique', short: 'Historique' },
  earlyoom: { title: 'Protection contre les gels', short: 'earlyoom' },
};

const ALL: OnboardingStep[] = ['install', 'autostart', 'history', 'earlyoom'];
const isStep = (x: unknown): x is OnboardingStep => typeof x === 'string' && (ALL as string[]).includes(x);

/** L'installation n'a de sens que pour une AppImage (`process.env.APPIMAGE`) : 4 étapes, sinon 3. */
export function onboardingSteps(appImage: boolean): OnboardingStep[] {
  return appImage ? [...ALL] : ALL.filter((s) => s !== 'install');
}

export const stepPosition = (index: number, count: number) => `Étape ${index + 1} sur ${count}`;

/** Accord « supprimer le fichier téléchargé », pour la copie relancée : chemin, empreinte, inode, échéance (ms). */
export interface DeleteConsent { path: string; sha256: string; ino: number; expires: number }

/** Validité de l'accord : la copie relancée démarre en quelques secondes. */
export const DELETE_CONSENT_TTL_MS = 5 * 60_000;

/**
 * `resume` : étape où reprendre après une relance depuis la copie installée ; `deleteOriginal` : accord donné dans
 * l'instance précédente (jamais par la ligne de commande), consommé une seule fois.
 */
export interface OnboardingFile { version: 1; done: boolean; resume?: OnboardingStep; deleteOriginal?: DeleteConsent }

function parseConsent(x: unknown): DeleteConsent | null {
  if (typeof x !== 'object' || x === null) return null;
  const c = x as Record<string, unknown>;
  if (typeof c.path !== 'string' || !c.path.startsWith('/') || /[\x00-\x1f\x7f]/.test(c.path)) return null;
  if (typeof c.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(c.sha256)) return null;
  if (!Number.isSafeInteger(c.ino) || (c.ino as number) <= 0) return null;
  if (typeof c.expires !== 'number' || !Number.isFinite(c.expires)) return null;
  return { path: c.path, sha256: c.sha256, ino: c.ino as number, expires: c.expires };
}

/**
 * Prend l'accord (une seule fois) : `rest` est le fichier sans accord, à réécrire tout de suite, avant toute suppression.
 * Accord expiré : refusé.
 */
export function takeDeleteConsent(f: OnboardingFile | null, now: number): { consent: DeleteConsent | null; error: string | null; rest: OnboardingFile | null } {
  if (!f) return { consent: null, error: null, rest: null };
  const { deleteOriginal, ...rest } = f;
  if (!deleteOriginal) return { consent: null, error: null, rest };
  if (now > deleteOriginal.expires) return { consent: null, error: 'accord expiré : fichier téléchargé non supprimé', rest };
  // f2 : échéance plus lointaine que la durée de validité : accord fabriqué, refusé
  if (deleteOriginal.expires > now + DELETE_CONSENT_TTL_MS) return { consent: null, error: 'échéance de l’accord invalide : fichier téléchargé non supprimé', rest };
  return { consent: deleteOriginal, error: null, rest };
}

export function parseOnboardingFile(text: string | null): OnboardingFile | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || typeof r.done !== 'boolean') return null;
  const consent = parseConsent(r.deleteOriginal);
  return { version: 1, done: r.done, ...(isStep(r.resume) ? { resume: r.resume } : {}), ...(consent ? { deleteOriginal: consent } : {}) };
}

export const serializeOnboarding = (f: OnboardingFile) => JSON.stringify(f) + '\n';

/**
 * Au lancement : seulement au tout premier (config créée par ce lancement), ou pour reprendre un accueil interrompu par la
 * relance depuis la copie. Une config existante sans fichier (version antérieure) n'ouvre rien : l'accueil reste dans À propos.
 */
export function shouldOpenOnboarding(o: { file: OnboardingFile | null; freshConfig: boolean }): boolean {
  if (o.file) return !o.file.done;
  return o.freshConfig;
}

export function startIndex(steps: readonly OnboardingStep[], resume: OnboardingStep | undefined): number {
  const i = resume ? steps.indexOf(resume) : -1;
  return i < 0 ? 0 : i;
}

export type WizardAction = { kind: 'skip' } | { kind: 'go'; index: number };

/** Échap : passer ; Alt+← / Alt+→ : étape précédente / suivante (les flèches seules restent aux champs). */
export function wizardKey(key: string, index: number, count: number, alt = false): WizardAction | null {
  if (key === 'Escape') return { kind: 'skip' };
  if (!alt) return null;
  if (key === 'ArrowRight' && index < count - 1) return { kind: 'go', index: index + 1 };
  if (key === 'ArrowLeft' && index > 0) return { kind: 'go', index: index - 1 };
  return null;
}

// ---------------------------------------------------------------- types partagés main / renderer

export interface InstallOutcome {
  status: 'installed' | 'updated' | 'already';
  dest: string;
  /** Entrée de menu écrite, ou null si une entrée étrangère a été laissée (voir `warnings`). */
  desktopFile: string | null;
  source: string;
  /** L'app tourne déjà depuis la copie installée. */
  runningFromCopy: boolean;
  /** Le fichier téléchargé est distinct de la copie : sa suppression peut être proposée. */
  canDeleteSource: boolean;
  /** Démarrage automatique déjà actif : repointé vers la copie. */
  autostartUpdated: boolean;
  /** SHA-256 de l'AppImage lancée, identique à celui de la copie relue. */
  sha256: string;
  /** La copie peut être exécutée (sinon : montage noexec, relance impossible). */
  executable: boolean;
  /** Éléments laissés en place (entrées étrangères…) ou problèmes non bloquants. */
  warnings: string[];
}

export interface OnboardingInfo {
  /** Ouvert au lancement (premier lancement, ou reprise après la relance depuis la copie). */
  open: boolean;
  steps: OnboardingStep[];
  start: number;
  /** AppImage lancée (`process.env.APPIMAGE`), sinon null (.deb, dev). */
  appImage: string | null;
  /** Destination de la copie et état actuel. */
  dest: string;
  installed: boolean;
  runningFromCopy: boolean;
  /** Dossier de l'historique (explication de l'étape Historique). */
  dataDir: string;
  /** Copie relancée avec le consentement de supprimer le fichier téléchargé : résultat. */
  originalDeletion?: { path: string; ok: boolean; message: string };
}

export interface AutostartInfo {
  enabled: boolean;
  path: string;
  /** Programme lancé à l'ouverture de session ; null en version de développement (indisponible). */
  target: string | null;
}

export interface AboutInfo {
  version: string;
  appImage: string | null;
  /** ~/Applications/proc-watch.AppImage si elle existe. */
  installedCopy: string | null;
  packaged: boolean;
}

export interface UninstallOptions { history: boolean; config: boolean }
export type UninstallKind = 'autostart' | 'desktop' | 'icon' | 'service' | 'history' | 'config' | 'appimage';
/** `tree` : arborescence du profil Chromium de l'app (configuration), retirée sans suivre de lien. */
export interface UninstallItem { kind: UninstallKind; path: string; label: string; dir?: boolean; tree?: boolean }

export interface UninstallResult {
  removed: string[];
  failed: { path: string; error: string }[];
  kept: { path: string; reason: string }[];
  /** Tout est retiré (copie de l'AppImage comprise) : l'app peut quitter. */
  done: boolean;
}

export const isUninstallOptions = (x: unknown): x is UninstallOptions =>
  typeof x === 'object' && x !== null && typeof (x as UninstallOptions).history === 'boolean' && typeof (x as UninstallOptions).config === 'boolean';
