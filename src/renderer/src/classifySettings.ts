import type { Category, Config } from '../../core/types';

/** Une correction manuelle telle que listée dans Réglages → Classement. */
export interface OverrideRow {
  /** Clé de la config (`${portée}|${motif}`) */
  key: string;
  /** Nom affiché : dernier segment de la racine du projet, sinon id du groupe sans préfixe */
  project: string;
  /** Racine du projet ou id du groupe (affichée en titre) */
  scope: string;
  signature: string;
  category: Category;
}

function displayName(scope: string): string {
  if (scope.startsWith('/')) return scope.split('/').filter(Boolean).pop() ?? scope;
  return scope.replace(/^(app|command|project|deleted):/, '');
}

/** Corrections de la config, découpées au dernier « | » (un motif n'en contient pas, un chemin peut), triées par projet puis motif. */
export function overrideRows(overrides: Record<string, Category>): OverrideRow[] {
  return Object.entries(overrides)
    .map(([key, category]) => {
      const i = key.lastIndexOf('|');
      const scope = i < 0 ? key : key.slice(0, i);
      return { key, project: displayName(scope), scope, signature: i < 0 ? '' : key.slice(i + 1), category };
    })
    .sort((a, b) => a.project.localeCompare(b.project) || a.signature.localeCompare(b.signature) || a.key.localeCompare(b.key));
}

/** Config sans la correction `key` (null : sans aucune correction). */
export function withoutOverride(config: Config, key: string | null): Config {
  const overrides: Record<string, Category> = {};
  if (key !== null) for (const [k, v] of Object.entries(config.classify.overrides)) if (k !== key) overrides[k] = v;
  return { ...config, classify: { ...config.classify, overrides } };
}

export const withDetectPorts = (config: Config, detectPorts: boolean): Config => ({ ...config, classify: { ...config.classify, detectPorts } });
