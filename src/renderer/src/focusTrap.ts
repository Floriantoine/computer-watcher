import { useEffect, type RefObject } from 'react';

/**
 * Tab dans un dialogue modal : index à focaliser pour rester dedans, ou null pour laisser faire le navigateur.
 * `current` = index de l'élément actif parmi les focalisables (-1 s'il est hors du dialogue).
 */
export function trapFocusIndex(current: number, count: number, shift: boolean): number | null {
  if (count <= 0) return null;
  if (current < 0) return shift ? count - 1 : 0;
  if (!shift && current === count - 1) return 0;
  if (shift && current === 0) return count - 1;
  return null;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** Garde le focus clavier (Tab / Maj+Tab) dans `ref` tant que le dialogue est monté. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const next = trapFocusIndex(items.indexOf(document.activeElement as HTMLElement), items.length, e.shiftKey);
      if (next === null) return;
      e.preventDefault();
      items[next]?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ref]);
}
