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
