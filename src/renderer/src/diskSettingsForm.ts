// Réglages → Disque (logique pure) : dossiers de projets (un par ligne) et seuil d'inactivité des node_modules.
import { MAX_PROJECT_ROOTS, normalizePath, normalizeProjectRoots } from '../../core/disk/projects';

export interface DiskSettingsForm { rootsText: string; days: string }

export const diskSettingsToForm = (ui: { diskProjectRoots: string[]; diskInactiveDays: number }): DiskSettingsForm => ({
  rootsText: ui.diskProjectRoots.join('\n'), days: String(ui.diskInactiveDays),
});

export function validateDiskSettingsForm(f: DiskSettingsForm, home: string | null): { ok: true; roots: string[]; days: number } | { ok: false; errors: { roots?: string; days?: string } } {
  const errors: { roots?: string; days?: string } = {};
  const raw = f.rootsText.split('\n').map((l) => l.trim()).filter(Boolean);
  const tilde = (l: string) => l === '~' || l.startsWith('~/');
  // Doublons fusionnés avant la limite (« /a » et « /a/ » comptent pour un).
  const lines = [...new Set(raw.map((l) => (home && tilde(l) ? `${home}${l.slice(1)}` : l)).map((l) => (l.startsWith('/') ? normalizePath(l) : l)))];
  const roots = normalizeProjectRoots(lines);
  if (!home && raw.some(tilde)) errors.roots = '~ indisponible : écris le chemin complet';
  else if (!roots) errors.roots = `Un chemin absolu par ligne (${MAX_PROJECT_ROOTS} au plus), jamais « / »`;
  const t = f.days.trim();
  const days = Number(t);
  if (!/^\d+$/.test(t) || days < 1 || days > 365) errors.days = 'Un nombre entier de 1 à 365 est attendu';
  return errors.roots || errors.days ? { ok: false, errors } : { ok: true, roots: roots!, days };
}
