import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BellRing, Bot, FlaskConical, FolderOpen, Gauge, Hourglass, Settings2, Skull, TrendingUp, X, type LucideIcon } from 'lucide-react';
import { alertMessage, type AlertEvent, type AlertType, type AlertsConfig } from '../../../core/alerts';
import type { ConfigState } from '../../../core/types';
import type { Route } from '../App';
import { badgeCount, clickTarget, pendingPopups, popupAction, popupSnooze, popupStack, sameUnseen, seenAfterClose } from '../alertPopups';
import { useHistory } from '../history';
import { settingsSectionForAlert } from '../settingsNav';
import { eventMarkers, formatInstant } from '../metrics';
import { TmpDirsList } from './TmpDirsList';
import '../alerts.css';

const ICONS: Record<AlertType, LucideIcon> = {
  leak: TrendingUp, earlyoom_kill: Skull, pressure: Gauge, tmpfs: FolderOpen, forecast: Hourglass, rule_action: Bot, rule_dry_run: FlaskConical,
};
const COLORS: Partial<Record<AlertType, string>> = { forecast: '#ffb547', rule_action: '#ff5c8a', rule_dry_run: '#8b91a0' };
const colorOf = (e: AlertEvent) => COLORS[e.type] ?? eventMarkers([e])[0]!.color;

const NONE: AlertEvent[] = [];

/**
 * Alertes non vues (rafraîchies toutes les 10 s, même référence si rien n'a changé), fermeture = vue (persistante),
 * ouverture sur `--alert=<id>`. `close` et `closeAll` sont stables (AlertPopups est mémoïsé).
 */
export function useAlertPopups(o: { alerts: AlertsConfig | undefined; onState: (s: ConfigState) => void; onOpenAlert: (e: AlertEvent) => void }) {
  const cfg = o.alerts;
  // refetch quand le filtre côté main change (vues, ids fermés, canaux)
  const key = cfg ? `${cfg.seenUpTo}|${cfg.seenIds.join(',')}|${JSON.stringify(cfg.channels)}` : '';
  const data = useHistory(() => window.procWatch.alerts.unseen(), [key], 10_000, sameUnseen);
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(() => new Set());
  const pending = useMemo(() => (cfg && data ? pendingPopups(data.alerts, cfg, dismissed) : NONE), [cfg, data, dismissed]);
  const badge = useMemo(() => (data ? badgeCount(data.total, data.alerts, dismissed) : 0), [data, dismissed]);

  const latest = useRef({ cfg, data, dismissed, pending, onState: o.onState, onOpenAlert: o.onOpenAlert });
  latest.current = { cfg, data, dismissed, pending, onState: o.onState, onOpenAlert: o.onOpenAlert };

  const close = useCallback((id: number) => {
    const { cfg, data, dismissed, onState } = latest.current;
    if (!cfg) return;
    const d = new Set(dismissed).add(id);
    setDismissed(d);
    const upTo = seenAfterClose(data?.alerts ?? [], cfg, d);
    window.procWatch.alerts.markSeen(upTo > cfg.seenUpTo ? { upTo, ids: [id] } : { ids: [id] }).then(onState, () => {});
  }, []);
  const closeAll = useCallback(() => {
    const { dismissed, pending, onState } = latest.current;
    setDismissed(new Set([...dismissed, ...pending.map((e) => e.id)]));
    window.procWatch.alerts.seenAll().then(onState, () => {});
  }, []);

  // Notification « Ouvrir » : au lancement (`--alert=<id>` gardé par le main) ou app déjà ouverte (second lancement).
  useEffect(() => {
    const go = (id: number | null) => {
      if (id !== null) window.procWatch.alerts.get(id).then((e) => e && latest.current.onOpenAlert(e), () => {});
    };
    window.procWatch.alerts.takePending().then(go, () => {});
    return window.procWatch.alerts.onOpen((id) => {
      void window.procWatch.alerts.takePending().catch(() => {});
      go(id);
    });
  }, []);

  return { pending, badge, close, closeAll };
}

interface Props {
  pending: AlertEvent[];
  onClose: (id: number) => void;
  onCloseAll: () => void;
  groupPresent: (key: string) => boolean;
  onNavigate: (r: Route) => void;
  /** « Libérer… » d'une alerte de prévision : kill groupé pré-rempli. */
  onFree: () => void;
  /** « Ignorer 30 min » d'une alerte de prévision (le service n'alerte plus pendant 30 min), puis fermeture. */
  onSnooze: (id: number) => void;
}

/** Pop-ups en haut à droite : restent jusqu'à fermeture, 3 au plus, le reste regroupé en « + n autres ». */
export const AlertPopups = memo(function AlertPopups({ pending, onClose, onCloseAll, groupPresent, onNavigate, onFree, onSnooze }: Props) {
  const { visible, more } = popupStack(pending);
  // Mesure de mise en page seulement quand la pile change (pas à chaque snapshot).
  const stackKey = `${visible.map((e) => e.id).join(',')}|${more > 0}`;
  const [tmpOpen, setTmpOpen] = useState<number | null>(null);
  return (
    <div className="alert-popups" role="region" aria-label="Alertes" aria-live="polite" data-testid="alert-popups">
      <AnimatePresence initial={false}>
        {visible.map((e) => {
          const Icon = ICONS[e.type] ?? BellRing;
          const { title, body } = alertMessage(e);
          const action = popupAction(e, groupPresent);
          const snooze = popupSnooze(e);
          const open = action.kind === 'tmp' && tmpOpen === e.id;
          return (
            <motion.div
              key={e.id}
              layout="position"
              layoutDependency={stackKey}
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
                      const target = clickTarget(e, groupPresent);
                      if (target === 'tmp') setTmpOpen(open ? null : e.id);
                      else if (target === 'free') onFree();
                      else onNavigate(target);
                    }}
                  >
                    {action.label}
                  </button>
                  {snooze && (
                    <button data-testid="alert-popup-snooze" onClick={() => onSnooze(e.id)}>
                      {snooze}
                    </button>
                  )}
                  <button onClick={() => onClose(e.id)}>Fermer</button>
                  <button
                    className="alert-popup-settings"
                    data-testid="alert-popup-settings"
                    title={e.type === 'earlyoom_kill' ? 'Réglages earlyoom' : 'Régler les alertes'}
                    aria-label={e.type === 'earlyoom_kill' ? 'Réglages earlyoom' : 'Régler les alertes'}
                    onClick={() => onNavigate({ view: 'settings', section: settingsSectionForAlert(e.type) })}
                  >
                    <Settings2 size={12} strokeWidth={2} />
                  </button>
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
            layoutDependency={stackKey}
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
});
