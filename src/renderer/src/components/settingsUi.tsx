import { useId, type ReactNode } from 'react';

/** Carte de réglages (surface glass) ; `danger` : contour rouge (Zone de danger). */
export function Card({ title, icon, children, danger, testid, className }: {
  title?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  danger?: boolean;
  testid?: string;
  className?: string;
}) {
  return (
    <div className={`s-card${danger ? ' s-danger' : ''}${className ? ` ${className}` : ''}`} data-testid={testid}>
      {title && (
        <h4 className="s-card-title">
          {icon}
          {title}
        </h4>
      )}
      {children}
    </div>
  );
}

/**
 * Ligne de formulaire : libellé à gauche, contrôle aligné à droite (unité après le champ), aide et erreur dessous.
 * `children` reçoit l'id à poser sur le contrôle (lien avec le libellé).
 */
export function Row({ label, help, error, children }: { label: ReactNode; help?: ReactNode; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="s-row">
      <label className="s-label" htmlFor={id}>{label}</label>
      <div className="s-ctl">{children(id)}</div>
      {error && <span className="field-error s-error">{error}</span>}
      {help && <p className="s-help">{help}</p>}
    </div>
  );
}

/** Champ numérique de largeur fixe suivi de son unité. */
export function NumberField({ id, value, onChange, unit, ariaLabel, invalid, min = '0', max, step, testid, onEnter }: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  unit: string;
  ariaLabel: string;
  invalid?: boolean;
  min?: string;
  max?: number;
  step?: string;
  testid?: string;
  onEnter?: () => void;
}) {
  return (
    <>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel}
        aria-invalid={!!invalid}
        data-testid={testid}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onEnter ? (e) => e.key === 'Enter' && onEnter() : undefined}
      />
      <span className="s-unit">{unit}</span>
    </>
  );
}

/** Pied de section : indicateur de modifications, puis le bouton principal en bas à droite. */
export function SaveBar({ dirty, onSave, disabled, label = 'Enregistrer', children, testid }: {
  dirty: boolean;
  onSave: () => void;
  disabled?: boolean;
  label?: ReactNode;
  children?: ReactNode;
  testid?: string;
}) {
  return (
    <div className="s-foot">
      {children}
      {dirty && (
        <span className="s-unsaved" role="status" data-testid={testid ? `${testid}-unsaved` : undefined}>
          <i aria-hidden />
          Modifications non enregistrées
        </span>
      )}
      <button className="primary" disabled={disabled ?? !dirty} onClick={onSave} data-testid={testid}>
        {label}
      </button>
    </div>
  );
}

/** Interrupteur (role="switch"), aligné à droite dans une ligne. */
export function Switch({ id, checked, label, onToggle, disabled }: { id?: string; checked: boolean; label: string; onToggle: () => void; disabled?: boolean }) {
  return (
    <button id={id} type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={onToggle}>
      <i />
    </button>
  );
}
