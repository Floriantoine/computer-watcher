import { useLayoutEffect, useRef, type MouseEvent } from 'react';
import { motion, useReducedMotionConfig } from 'motion/react';
import { AppWindow, Bot, Folder, Package, SquareTerminal, Trash2, TrendingUp, X, Zap, type LucideIcon } from 'lucide-react';
import type { GroupKind } from '../../../core/types';
import { formatKB } from '../format';
import { TWEEN_TICK_MS, tweenSteps, worthAnimating } from '../motionBudget';
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
 * Nombre (en Ko) qui glisse vers sa nouvelle valeur, affiché avec `format`.
 * Le texte est écrit directement dans le DOM, 20 fois par seconde au plus (pas une image par rafraîchissement d'écran),
 * et seulement si le glissement afficherait une valeur intermédiaire ; sinon, ou animations réduites (système ou réglage), saut direct.
 */
export function AnimatedNumber({ value, format = formatKB, className }: { value: number; format?: (n: number) => string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  // Préférence système ou réglage « Effets visuels réduits » (MotionConfig).
  const reduce = !!useReducedMotionConfig();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const show = (v: number) => {
      shown.current = v;
      const text = format(Math.round(v));
      // Modifier le nœud texte existant (et pas textContent) évite de recréer son objet de mise en page.
      if (el.firstChild) {
        if (el.firstChild.nodeValue !== text) el.firstChild.nodeValue = text;
      } else el.textContent = text;
    };
    const from = shown.current;
    if (from === null || reduce || !worthAnimating(from, value, format)) {
      show(value);
      return;
    }
    const steps = tweenSteps(from, value);
    let i = 0;
    const timer = setInterval(() => {
      show(steps[i++]!);
      if (i >= steps.length) clearInterval(timer);
    }, TWEEN_TICK_MS);
    return () => clearInterval(timer);
  }, [value, reduce, format]);
  return <span ref={ref} className={className} />;
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

/** Badge ambre « fuite ? » ; le clic ouvre Métriques sans ouvrir le détail du groupe. */
export function LeakBadge({ onClick }: { onClick: (e: MouseEvent) => void }) {
  return (
    <button type="button" className="leak-badge" data-testid="leak-badge" title="Mémoire en hausse continue — voir Métriques" onClick={onClick}>
      <TrendingUp size={11} strokeWidth={2.4} />fuite ?
    </button>
  );
}
