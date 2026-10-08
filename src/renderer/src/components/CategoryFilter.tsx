import { memo, type CSSProperties } from 'react';
import { Layers, Zap } from 'lucide-react';
import type { Category } from '../../../core/types';
import { CATEGORY_META } from '../categories';
import { pillCategories, pillLabel, showKillSelection } from '../categoryFilter';

interface Props {
  counts: Map<Category, number>;
  selected: ReadonlySet<Category>;
  onChange: (next: Set<Category>) => void;
  /** Instances que « Tuer la sélection » cocherait par défaut (hors protégées) */
  killCount: number;
  /** Filtre actif sans instance de projet candidate : courte indication à la place du bouton */
  projectsOnlyHint: boolean;
  /** Absent tant que le dialogue groupé n'existe pas : bouton désactivé */
  onKillSelection?: () => void;
}

/** Pastilles de catégories sous la barre d'outils : multi-sélection, « Toutes » remet à zéro. */
function CategoryFilterImpl({ counts, selected, onChange, killCount, projectsOnlyHint, onKillSelection }: Props) {
  const shown = pillCategories(counts, selected);
  if (shown.length === 0) return null;
  const toggle = (c: Category) => {
    const next = new Set(selected);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    onChange(next);
  };
  return (
    <div className="cat-filter" data-testid="category-filter" role="group" aria-label="Filtrer par catégorie">
      <button type="button" className={`cat-pill${selected.size === 0 ? ' active' : ''}`} data-testid="category-all" aria-pressed={selected.size === 0} onClick={() => onChange(new Set())}>
        <Layers size={13} strokeWidth={2.2} />
        Toutes
      </button>
      {shown.map((c) => {
        const m = CATEGORY_META[c];
        const Icon = m.icon;
        const on = selected.has(c);
        return (
          <button
            key={c}
            type="button"
            className={`cat-pill${on ? ' active' : ''}`}
            data-testid={`category-pill-${c}`}
            aria-pressed={on}
            aria-label={pillLabel(c, counts.get(c) ?? 0)}
            style={{ '--cat': m.color } as CSSProperties}
            onClick={() => toggle(c)}
          >
            <Icon size={13} strokeWidth={2.2} />
            {m.label}
            <span className="cat-count">{counts.get(c) ?? 0}</span>
          </button>
        );
      })}
      {projectsOnlyHint && <span className="cat-hint" data-testid="kill-projects-only">Le kill groupé ne vise que les projets</span>}
      {showKillSelection(selected, killCount) && (
        <button
          type="button"
          className="danger cat-kill"
          data-testid="kill-selection"
          disabled={!onKillSelection}
          title={onKillSelection ? 'Arrêter les instances des catégories choisies (projets seulement)' : 'Bientôt disponible'}
          onClick={onKillSelection}
        >
          <Zap size={13} strokeWidth={2.4} />
          Tuer la sélection ({killCount})
        </button>
      )}
    </div>
  );
}

const sameCounts = (a: Map<Category, number>, b: Map<Category, number>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** Ne se re-rend pas à chaque snapshot si les compteurs n'ont pas bougé. */
export const CategoryFilter = memo(
  CategoryFilterImpl,
  (a, b) => a.selected === b.selected && a.onChange === b.onChange && a.onKillSelection === b.onKillSelection && a.killCount === b.killCount && a.projectsOnlyHint === b.projectsOnlyHint && sameCounts(a.counts, b.counts),
);
