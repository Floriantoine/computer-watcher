// Réglages → Disque (logique pure) : dossiers de projets (un par ligne) et seuil d'inactivité des node_modules.
import { MAX_PROJECT_ROOTS, normalizeProjectRoots } from '../../core/disk/projects';

export interface DiskSettingsForm { rootsText: string; days: string }

export const diskSettingsToForm = (ui: { diskProjectRoots: string[]; diskInactiveDays: number }): DiskSettingsForm => ({
  rootsText: ui.diskProjectRoots.join('\n'), days: String(ui.diskInactiveDays),
});

export function validateDiskSettingsForm(f: DiskSettingsForm, home: string | null): { ok: true; roots: string[]; days: number } | { ok: false; errors: { roots?: string; days?: string } } {
  const errors: { roots?: string; days?: string } = {};
  const lines = f.rootsText.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => (home && (l === '~' || l.startsWith('~/')) ? `${home}${l.slice(1)}` : l));
  const roots = normalizeProjectRoots(lines);
  if (!roots) errors.roots = `Un chemin absolu par ligne (${MAX_PROJECT_ROOTS} au plus), jamais « / »`;
  const t = f.days.trim();
  const days = Number(t);
  if (!/^\d+$/.test(t) || days < 1 || days > 365) errors.days = 'Un nombre entier de 1 à 365 est attendu';
  return errors.roots || errors.days ? { ok: false, errors } : { ok: true, roots: roots!, days };
}
