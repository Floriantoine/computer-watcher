import { useCallback, useEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ChevronDown, RotateCcw } from 'lucide-react';
import type { Category } from '../../../core/types';
import { CATEGORIES, CATEGORY_META } from '../categories';
import { menuIndex } from '../instances';

export interface ReclassMenuProps {
  current: Category;
  revert: boolean;
  open: boolean;
  onOpen: (open: boolean) => void;
  onPick: (c: Category | null) => void;
}

/** Bouton « Reclasser » et son menu de catégories (lignes d'instances, en-tête du détail des groupes hors projet). */
export function ReclassMenu({ current, revert, open, onOpen, onPick }: ReclassMenuProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // Fermeture au clavier ou par un choix : le focus revient sur « Reclasser » (sinon il tombe sur <body>).
  const close = useCallback(
    (refocus: boolean) => {
      onOpen(false);
      if (refocus) btn.current?.focus();
    },
    [onOpen],
  );
  useEffect(() => {
    if (!open) return;
    (menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.current?.querySelector<HTMLButtonElement>('button'))?.focus();
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open, close]);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const next = menuIndex(items.indexOf(document.activeElement as HTMLButtonElement), e.key, items.length);
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus();
  };
  const pick = (c: Category | null) => {
    onPick(c);
    btn.current?.focus();
  };
  return (
    <span className="reclass" ref={ref}>
      <button ref={btn} type="button" className="reclass-btn" data-testid="reclass-button" aria-haspopup="menu" aria-expanded={open} onClick={() => onOpen(!open)}>
        Reclasser <ChevronDown size={12} strokeWidth={2.2} />
      </button>
      {open && (
        <div className="reclass-menu" role="menu" aria-label="Reclasser l'instance" data-testid="reclass-menu" ref={menu} onKeyDown={onKeyDown}>
          {CATEGORIES.map((c) => {
            const m = CATEGORY_META[c];
            const Icon = m.icon;
            return (
              <button key={c} type="button" role="menuitemradio" aria-checked={c === current} tabIndex={-1} style={{ '--cat': m.color } as CSSProperties} onClick={() => pick(c)}>
                <Icon size={13} strokeWidth={2.2} />
                <span>{m.label}</span>
                {c === current && <Check size={13} strokeWidth={2.4} className="reclass-check" />}
              </button>
            );
          })}
          {revert && (
            <button type="button" role="menuitem" tabIndex={-1} className="reclass-auto" data-testid="reclass-auto" onClick={() => pick(null)}>
              <RotateCcw size={13} strokeWidth={2.2} />
              <span>Revenir à l'automatique</span>
            </button>
          )}
        </div>
      )}
    </span>
  );
}
