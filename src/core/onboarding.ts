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

/** `resume` : étape où reprendre après une relance depuis la copie installée. */
export interface OnboardingFile { version: 1; done: boolean; resume?: OnboardingStep }

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
  return isStep(r.resume) ? { version: 1, done: r.done, resume: r.resume } : { version: 1, done: r.done };
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
  desktopFile: string;
  source: string;
  /** L'app tourne déjà depuis la copie installée. */
  runningFromCopy: boolean;
  /** Le fichier téléchargé est distinct de la copie : sa suppression peut être proposée. */
  canDeleteSource: boolean;
  /** Démarrage automatique déjà actif : repointé vers la copie. */
  autostartUpdated: boolean;
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
export interface UninstallItem { kind: UninstallKind; path: string; label: string; dir?: boolean }

export interface UninstallResult {
  removed: string[];
  failed: { path: string; error: string }[];
  kept: { path: string; reason: string }[];
  /** Tout est retiré (copie de l'AppImage comprise) : l'app peut quitter. */
  done: boolean;
}

export const isUninstallOptions = (x: unknown): x is UninstallOptions =>
  typeof x === 'object' && x !== null && typeof (x as UninstallOptions).history === 'boolean' && typeof (x as UninstallOptions).config === 'boolean';
