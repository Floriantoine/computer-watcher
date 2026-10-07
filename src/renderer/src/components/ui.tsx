import { useEffect, type MouseEvent } from 'react';
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { AppWindow, Bot, Folder, Package, SquareTerminal, Trash2, X, Zap, type LucideIcon } from 'lucide-react';
import type { GroupKind } from '../../../core/types';
import { formatKB } from '../format';
import { groupIconColor } from '../theme';

const KIND_ICONS: Record<GroupKind, LucideIcon> = {
  claude: Bot,
  app: AppWindow,
  project: Folder,
  deleted: Trash2,
  command: SquareTerminal,
  others: Package,
};

/** Carré d'icône d'un groupe, teinte stable dérivée de son id. */
export function GroupIcon({ id, kind, size = 'md' }: { id: string; kind: GroupKind; size?: 'sm' | 'md' | 'lg' }) {
  const Icon = KIND_ICONS[kind];
  const px = size === 'lg' ? 17 : size === 'sm' ? 13 : 15;
  return (
    <span className={`ico ${size === 'lg' ? 'lg' : ''}`} style={{ background: groupIconColor(id) }} aria-hidden>
      <Icon size={px} strokeWidth={2} />
    </span>
  );
}

/**
 * Nombre (en Ko) qui glisse doucement vers sa nouvelle valeur, affiché avec `format`.
 * Pas d'animation si le texte affiché ne change pas : un snapshot identique ne relance rien.
 */
export function AnimatedNumber({ value, format = formatKB, className }: { value: number; format?: (n: number) => string; className?: string }) {
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) => format(Math.round(v)));
  const reduce = useReducedMotion();
  useEffect(() => {
    const from = mv.get();
    if (from === value) return;
    if (reduce || format(Math.round(from)) === format(value)) {
      mv.jump(value);
      return;
    }
    const controls = animate(mv, value, { duration: 0.7, ease: [0.22, 1, 0.36, 1] });
    return () => controls.stop();
  }, [value, reduce, format, mv]);
  return <motion.span className={className}>{text}</motion.span>;
}

interface KillProps {
  pending?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
  onClick: (e: MouseEvent) => void;
}

/** Bouton kill : carré icône rose ; pulse tant qu'un SIGTERM envoyé attend la fin du processus. */
export function KillButton({ pending, disabled, size = 'md', onClick }: KillProps) {
  return (
    <motion.button
      type="button"
      className={`kill ${size === 'sm' ? 'sm' : ''} ${pending ? 'is-pending' : ''}`}
      title="Tuer"
      aria-label="Tuer"
      aria-busy={pending || undefined}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.92 }}
      onClick={onClick}
    >
      <X size={size === 'sm' ? 13 : 15} strokeWidth={2.4} />
    </motion.button>
  );
}

/** « Forcer (SIGKILL) » : apparaît avec un léger shake pour attirer l'œil. */
export function ForceButton({ onClick }: { onClick: (e: MouseEvent) => void }) {
  return (
    <motion.button
      type="button"
      className="danger force"
      initial={{ opacity: 0, x: 0 }}
      animate={{ opacity: 1, x: [0, -5, 5, -3, 3, 0] }}
      transition={{ opacity: { duration: 0.15 }, x: { duration: 0.42, ease: 'easeInOut' } }}
      whileTap={{ scale: 0.94 }}
      onClick={onClick}
    >
      <Zap size={13} strokeWidth={2.4} />
      Forcer (SIGKILL)
    </motion.button>
  );
}
