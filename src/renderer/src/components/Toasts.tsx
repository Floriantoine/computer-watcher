import { AnimatePresence, motion } from 'motion/react';
import { CircleAlert, CircleCheck } from 'lucide-react';

export interface Toast {
  id: number;
  message: string;
  kind: 'error' | 'info';
}

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout="position"
            className={`toast ${t.kind}`}
            initial={{ opacity: 0, x: 48 }}
            // Une erreur arrive avec un petit shake ; une info glisse simplement.
            animate={t.kind === 'error' ? { opacity: 1, x: [48, 0, -6, 5, -3, 0] } : { opacity: 1, x: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.25 } }}
            transition={
              t.kind === 'error'
                ? { opacity: { duration: 0.2 }, x: { duration: 0.6, times: [0, 0.4, 0.55, 0.7, 0.85, 1], ease: 'easeOut' } }
                : { type: 'spring', stiffness: 380, damping: 32 }
            }
          >
            {t.kind === 'error' ? <CircleAlert size={15} strokeWidth={2.2} /> : <CircleCheck size={15} strokeWidth={2.2} />}
            <span>{t.message}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
