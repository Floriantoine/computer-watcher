import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BellRing, FlaskConical, FolderOpen, Gauge, Hourglass, ShieldAlert, Skull, TrendingUp, X, type LucideIcon } from 'lucide-react';
import { alertMessage, type AlertEvent, type AlertType, type AlertsConfig } from '../../../core/alerts';
import type { ConfigState } from '../../../core/types';
import { pendingPopups, popupAction, popupStack, seenAfterClose, seenAfterCloseAll } from '../alertPopups';
import { useHistory } from '../history';
import { eventMarkers, formatInstant } from '../metrics';
import { TmpDirsList } from './TmpDirsList';
import '../alerts.css';

const ICONS: Record<AlertType, LucideIcon> = {
  leak: TrendingUp, earlyoom_kill: Skull, pressure: Gauge, tmpfs: FolderOpen, forecast: Hourglass, rule_action: ShieldAlert, rule_dry_run: FlaskConical,
};
const COLORS: Partial<Record<AlertType, string>> = { forecast: '#ffb547', rule_action: '#ff5c8a', rule_dry_run: '#8b91a0' };
const colorOf = (e: AlertEvent) => COLORS[e.type] ?? eventMarkers([e])[0]!.color;

/** Alertes non vues (rafraîchies toutes les 10 s), fermeture = vue, ouverture sur `--alert=<id>`. */
export function useAlertPopups(o: { alerts: AlertsConfig | undefined; onState: (s: ConfigState) => void; onOpenAlert: (e: AlertEvent) => void }) {
  const seenUpTo = o.alerts?.seenUpTo;
  const events = useHistory(() => window.procWatch.alerts.unseen(), [seenUpTo], 10_000);
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(new Set());
  const pending = o.alerts ? pendingPopups(events, o.alerts, dismissed) : [];

  const markSeen = (ts: number) => {
    if (o.alerts && ts > o.alerts.seenUpTo) window.procWatch.alerts.markSeen(ts).then(o.onState, () => {});
  };
  const close = (id: number) => {
    if (!o.alerts) return;
    const d = new Set(dismissed).add(id);
    setDismissed(d);
    markSeen(seenAfterClose(events ?? [], o.alerts, d));
  };
  const closeAll = () => {
    if (!o.alerts) return;
    setDismissed(new Set([...dismissed, ...pending.map((e) => e.id)]));
    markSeen(seenAfterCloseAll(events ?? [], o.alerts));
  };

  // Notification « Ouvrir » : au lancement (`--alert=<id>` gardé par le main) ou app déjà ouverte (second lancement).
  const openRef = useRef(o.onOpenAlert);
  openRef.current = o.onOpenAlert;
  useEffect(() => {
    const go = (id: number | null) => {
      if (id !== null) window.procWatch.alerts.get(id).then((e) => e && openRef.current(e), () => {});
    };
    window.procWatch.alerts.takePending().then(go, () => {});
    return window.procWatch.alerts.onOpen((id) => {
      void window.procWatch.alerts.takePending().catch(() => {});
      go(id);
    });
  }, []);

  return { pending, close, closeAll };
}

interface Props {
  pending: AlertEvent[];
  onClose: (id: number) => void;
  onCloseAll: () => void;
  groupPresent: (key: string) => boolean;
  onOpenGroup: (key: string) => void;
  onOpenInstant: (ts: number) => void;
}

/** Pop-ups en haut à droite : restent jusqu'à fermeture, 3 au plus, le reste regroupé en « + n autres ». */
export function AlertPopups({ pending, onClose, onCloseAll, groupPresent, onOpenGroup, onOpenInstant }: Props) {
  const { visible, more } = popupStack(pending);
  const [tmpOpen, setTmpOpen] = useState<number | null>(null);
  return (
    <div className="alert-popups" role="region" aria-label="Alertes" aria-live="polite" data-testid="alert-popups">
      <AnimatePresence initial={false}>
        {visible.map((e) => {
          const Icon = ICONS[e.type] ?? BellRing;
          const { title, body } = alertMessage(e);
          const action = popupAction(e, groupPresent);
          const open = action.kind === 'tmp' && tmpOpen === e.id;
          return (
            <motion.div
              key={e.id}
              layout="position"
              className="alert-popup"
              data-testid="alert-popup"
              style={{ '--alert': colorOf(e) } as CSSProperties}
              initial={{ opacity: 0, x: 40, scale: 0.98 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
              transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            >
              <span className="alert-popup-ico" aria-hidden>
                <Icon size={15} strokeWidth={2.2} />
              </span>
              <div className="alert-popup-main">
                <div className="alert-popup-head">
                  <strong title={title}>{title}</strong>
                  <span className="mono">{formatInstant(e.ts)}</span>
                </div>
                {body && <p>{body}</p>}
                {open && (
                  <div className="alert-popup-tmp">
                    <TmpDirsList />
                  </div>
                )}
                <div className="alert-popup-actions">
                  <button
                    className="alert-popup-go"
                    aria-expanded={action.kind === 'tmp' ? open : undefined}
                    onClick={() => {
                      if (action.kind === 'tmp') setTmpOpen(open ? null : e.id);
                      else if (action.kind === 'group') onOpenGroup(action.groupKey);
                      else onOpenInstant(action.ts);
                    }}
                  >
                    {action.label}
                  </button>
                  <button onClick={() => onClose(e.id)}>Fermer</button>
                </div>
              </div>
              <button className="alert-popup-x" aria-label={`Fermer l’alerte ${title}`} title="Fermer" onClick={() => onClose(e.id)}>
                <X size={13} strokeWidth={2.4} />
              </button>
            </motion.div>
          );
        })}
        {more > 0 && (
          <motion.div
            key="more"
            layout="position"
            className="alert-popup-more"
            data-testid="alert-popups-more"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <span>+ {more} {more > 1 ? 'autres' : 'autre'}</span>
            <button onClick={onCloseAll}>Tout fermer</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
