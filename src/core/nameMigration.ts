// src/core/nameMigration.ts — migration proc-watch → computer-watcher : décisions pures (sans import Node), partagées
// par le main (exécution, src/main/migrateName.ts) et le renderer (Réglages › À propos).

/** Étapes, dans l'ordre de la spécification. */
export type MigrationStep = 'stop-legacy-service' | 'move-dirs' | 'new-service' | 'desktop' | 'appimage';
export const MIGRATION_STEPS: readonly MigrationStep[] = ['stop-legacy-service', 'move-dirs', 'new-service', 'desktop', 'appimage'];

/**
 * État tenu dans `migration.json` (dossier de config) : étapes faites, erreurs de la dernière tentative, anciens éléments
 * laissés en place (jamais fusionnés ni supprimés), étapes ignorées (PROC_WATCH_NO_RECORDER_SYNC : refaites ensuite).
 */
export interface MigrationState {
  version: 1;
  done: MigrationStep[];
  errors: Partial<Record<MigrationStep, string>>;
  leftInPlace: string[];
  skipped?: Partial<Record<MigrationStep, string>>;
}

export interface MigrationReport {
  status: 'done' | 'partial' | 'deferred' | 'nothing';
  done: MigrationStep[];
  errors: Partial<Record<MigrationStep, string>>;
  leftInPlace: string[];
  skipped: Partial<Record<MigrationStep, string>>;
}

export interface DirMove { from: string; to: string }

/**
 * Décision pour un dossier : 'move' | 'skip-absent' | 'keep-both' (nouveau non vide : rien fusionné, rien supprimé) |
 * 'replace-empty' (nouveau vide : remplacé par l'ancien) | 'refuse' (lien, montage, autre type).
 */
export type DirDecision = 'move' | 'skip-absent' | 'keep-both' | 'replace-empty' | 'refuse';

export function decideDirMove(o: { legacy: 'absent' | 'dir' | 'link' | 'mount' | 'other'; next: 'absent' | 'empty' | 'non-empty' | 'link' | 'other' }): DirDecision {
  if (o.legacy === 'absent') return 'skip-absent';
  if (o.legacy !== 'dir') return 'refuse';
  switch (o.next) {
    case 'absent': return 'move';
    case 'empty': return 'replace-empty';
    case 'non-empty': return 'keep-both';
    default: return 'refuse';
  }
}

const isStep = (x: unknown): x is MigrationStep => typeof x === 'string' && (MIGRATION_STEPS as readonly string[]).includes(x);
const isStepMap = (x: unknown): x is Partial<Record<MigrationStep, string>> =>
  typeof x === 'object' && x !== null && !Array.isArray(x) && Object.entries(x).every(([k, v]) => isStep(k) && typeof v === 'string');

/** Contenu de migration.json ; illisible, invalide ou d'une autre version → null (la migration repart de zéro : idempotente). */
export function parseMigrationState(text: string | null): MigrationState | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return null;
  if (!Array.isArray(r.done) || !r.done.every(isStep)) return null;
  if (!isStepMap(r.errors)) return null;
  if (!Array.isArray(r.leftInPlace) || !r.leftInPlace.every((p) => typeof p === 'string')) return null;
  if (r.skipped !== undefined && !isStepMap(r.skipped)) return null;
  return {
    version: 1,
    done: [...new Set(r.done)],
    errors: r.errors,
    leftInPlace: r.leftInPlace as string[],
    ...(r.skipped !== undefined ? { skipped: r.skipped as Partial<Record<MigrationStep, string>> } : {}),
  };
}

export const serializeMigrationState = (s: MigrationState): string => `${JSON.stringify(s, null, 2)}\n`;

/**
 * Étapes restantes, dans l'ordre. Tout fait → 'nothing' (jamais refait) ; aucun état et rien d'ancien → 'nothing' (nouvelle
 * installation) ; une ancienne instance de l'app tourne encore avec ces dossiers → 'deferred' (rien n'est touché).
 */
export function nextSteps(s: MigrationState | null, ctx: { legacyPresent: boolean; legacyInstanceAlive: boolean }): MigrationStep[] | 'deferred' | 'nothing' {
  if (s && MIGRATION_STEPS.every((x) => s.done.includes(x))) return 'nothing';
  if (!s && !ctx.legacyPresent) return 'nothing';
  if (ctx.legacyInstanceAlive) return 'deferred';
  return MIGRATION_STEPS.filter((x) => !s?.done.includes(x));
}

/** Bilan d'une tentative à partir de l'état : faite (rien en erreur, rien laissé), sinon partielle. */
export function reportOf(s: MigrationState): MigrationReport {
  const failed = Object.keys(s.errors).length > 0 || s.leftInPlace.length > 0;
  return { status: failed ? 'partial' : 'done', done: [...s.done], errors: { ...s.errors }, leftInPlace: [...s.leftInPlace], skipped: { ...(s.skipped ?? {}) } };
}

const STEP_LABELS: Record<MigrationStep, string> = {
  'stop-legacy-service': 'Arrêt de l’ancien service',
  'move-dirs': 'Déplacement des dossiers',
  'new-service': 'Nouveau service',
  desktop: 'Entrées du menu et du démarrage',
  appimage: 'Copie de l’AppImage',
};

/** Lignes affichées (Réglages › À propos, boîte native au démarrage) ; rien à migrer : aucune ligne. */
export function migrationLines(r: MigrationReport): string[] {
  switch (r.status) {
    case 'nothing': return [];
    case 'done': return ['Migration depuis proc-watch : faite.'];
    case 'deferred':
      return ['Migration depuis proc-watch : différée : une ancienne version (proc-watch) est encore ouverte. La quitter, puis relancer Computer Watcher.'];
    case 'partial':
      return [
        'Migration depuis proc-watch : partielle.',
        ...MIGRATION_STEPS.flatMap((s) => (r.errors[s] ? [`${STEP_LABELS[s]} : ${r.errors[s]}`] : [])),
        ...r.leftInPlace.map((p) => `Laissé en place : ${p}`),
      ];
  }
}
