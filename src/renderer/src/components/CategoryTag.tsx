import type { CSSProperties } from 'react';
import { Copy } from 'lucide-react';
import type { Category } from '../../../core/types';
import { CATEGORY_META } from '../categories';

/** Étiquette colorée d'une catégorie, avec le port principal (« Front :5173 »). */
export function CategoryTag({ category, port }: { category: Category; port?: number | null }) {
  const m = CATEGORY_META[category];
  const Icon = m.icon;
  return (
    <span className="cat-tag" data-testid="category-tag" style={{ '--cat': m.color } as CSSProperties} title={port ? `${m.label}, port ${port}` : m.label}>
      <Icon size={11} strokeWidth={2.4} />
      {m.label}
      {port ? <span className="cat-port">:{port}</span> : null}
    </span>
  );
}

export function DuplicateBadge() {
  return (
    <span className="dup-badge" data-testid="duplicate-badge" title="Une autre instance de même catégorie tourne déjà dans ce projet">
      <Copy size={10} strokeWidth={2.4} />
      en double
    </span>
  );
}

/** Instance lancée par une session Claude : rangée dans son projet, sortie de la carte Claude. Étiquette discrète, sans animation. */
export function ClaudeLaunchedBadge({ title }: { title?: string } = {}) {
  return (
    <span
      className="claude-badge"
      data-testid="claude-launched-badge"
      title={title ?? 'Outil de dev lancé par une session Claude dans ce projet (compté ici, plus dans la carte Claude)'}
    >
      lancé par Claude
    </span>
  );
}
