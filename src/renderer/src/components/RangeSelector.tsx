import { useId } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import type { RangePreset } from '../../../core/types';

export const RANGE_PRESETS: RangePreset[] = ['1h', '6h', '24h', '7d', '30d'];

export const RANGE_LABELS: Record<RangePreset, string> = { '1h': '1 h', '6h': '6 h', '24h': '24 h', '7d': '7 j', '30d': '30 j' };

/** Contrôle segmenté vitré ; l'indicateur glisse d'une plage à l'autre. */
export function RangeSelector({ value, onChange }: { value: RangePreset; onChange: (r: RangePreset) => void }) {
  const layoutId = `range-${useId()}`;
  const reduce = useReducedMotion();
  return (
    <div className="range-selector" role="radiogroup" aria-label="Plage de temps">
      {RANGE_PRESETS.map((p) => (
        <button
          key={p}
          type="button"
          role="radio"
          aria-checked={value === p}
          data-testid={`range-${p}`}
          className={value === p ? 'active' : ''}
          onClick={() => onChange(p)}
        >
          {value === p && (
            <motion.span layoutId={layoutId} className="range-indicator" transition={reduce ? { duration: 0 } : { duration: 0.26, ease: [0.22, 1, 0.36, 1] }} />
          )}
          <span>{RANGE_LABELS[p]}</span>
        </button>
      ))}
    </div>
  );
}
