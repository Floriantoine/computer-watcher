// Bureau prioritaire (anti-gel, lot 2), fenêtre (logique pure) : libellés des unités et ligne d'état, sans jargon systemd.
import type { AntigelDeskState } from '../../core/antigel/deskState';
import { DESK_CPU_WEIGHT, TERMINAL_CPU_WEIGHT, WORK_CPU_WEIGHT } from '../../core/antigel/deskUnits';

/** Nom lisible d'une unité de terminal ou de Claude : « app-dev.warp.Warp@….service » → « Warp ». */
export function deskUnitLabel(unit: string): string {
  const base = unit
    .replace(/\.(service|scope|slice)$/, '')
    .replace(/@.*$/, '')
    .replace(/-\d+$/, '')
    .replace(/^app-/, '')
    .replace(/\\x([0-9a-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  return base.split('.').pop() || base;
}

const DESK_SLICES = new Set(['session.slice', 'app.slice', 'cwatch.slice', 'background.slice']);

/** Terminaux et Claude suivis (sans doublon de libellé, ordre stable). */
export const deskTerminals = (d: AntigelDeskState): string[] =>
  [...new Set(d.units.filter((u) => !u.endsWith('.slice') && !DESK_SLICES.has(u)).map(deskUnitLabel))];

/** Ligne de la carte Métriques et de Réglages ; null : service sans ce lot. */
export function deskLine(d: AntigelDeskState | null | undefined): string | null {
  if (!d) return null;
  if (d.status === 'off') return 'Bureau prioritaire éteint.';
  if (d.status === 'unavailable') return `Bureau prioritaire indisponible : ${d.reason ?? 'raison inconnue'}.`;
  const parts: string[] = [];
  const x = (w: number) => String(w / WORK_CPU_WEIGHT).replace('.', ',');
  parts.push(d.cpu
    ? `processeur : bureau ${x(DESK_CPU_WEIGHT)}× et applications ${x(TERMINAL_CPU_WEIGHT)}× prioritaires sur le travail`
    : 'processeur : contrôleur non délégué, poids non posés');
  if (d.memory === 'on') {
    const t = deskTerminals(d);
    parts.push(`mémoire du bureau protégée${t.length ? ` (${t.join(', ')})` : ''}`);
  } else if (d.memory === 'ineffective') {
    parts.push('protection mémoire sans effet ici (les niveaux système au-dessus de la session n’en ont pas)');
  }
  if (d.io) parts.push('disque : bureau prioritaire');
  if (d.truncated) parts.push('trop de terminaux : les premiers seulement');
  return `Bureau prioritaire : ${parts.join(' · ')}.`;
}
