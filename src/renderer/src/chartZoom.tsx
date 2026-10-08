import { useEffect, useRef, useState } from 'react';
import { RotateCcw, ZoomIn } from 'lucide-react';
import type { TimeRange } from '../../core/types';
import { formatAxisTime } from './components/charts/uplotTheme';
import { dragPan, toZoom, wheelPan, wheelZoom, zoomRange, type ZoomState } from './metrics';

/** Zoom d'au moins 10 min : en deçà, l'axe du temps (HH:mm) répéterait les mêmes graduations. */
export const MIN_ZOOM_MS = 10 * 60_000;

export type WheelEvent = { anchor: number; delta: number; pan: boolean };
export type DragPanEvent = { dxPx: number; widthPx: number; phase: 'start' | 'move' | 'end' };

/**
 * Zoom partagé par les graphes d'une vue : glisser, Ctrl + molette (zoom), Maj + molette et clic molette (déplacement),
 * double-clic (retour). `zoom` recharge les données ; `view` suit les gestes tout de suite. Un zoom collé au bout suit
 * le direct : la fenêtre avance à chaque rafraîchissement.
 */
export function useChartZoom(fullMs: number) {
  const [zoom, setZoomNow] = useState<ZoomState | null>(null);
  const zoomRef = useRef<ZoomState | null>(null);
  zoomRef.current = zoom;
  const [view, setView] = useState<TimeRange | null>(null);
  const viewRef = useRef<TimeRange | null>(null);
  viewRef.current = view;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragging = useRef(false);
  const dragStart = useRef<TimeRange | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const bounds = (): TimeRange => {
    const now = Date.now();
    return { from: now - fullMs, to: now };
  };
  const currentView = (b: TimeRange): TimeRange => viewRef.current ?? (zoomRef.current ? zoomRange(zoomRef.current, b.to) : b);
  const commitLater = (next: TimeRange | null, delay = 250) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setZoomNow(next ? toZoom(next, Date.now()) : null), delay);
  };
  const setZoom = (r: TimeRange | null) => {
    if (timer.current) clearTimeout(timer.current);
    setView(r);
    setZoomNow(r ? toZoom(r, Date.now()) : null);
  };

  return {
    zoom,
    view,
    setZoom,
    /** Plage à charger : celle du zoom (qui avance s'il est en direct), sinon la plage complète. */
    range: (): TimeRange => (zoomRef.current ? zoomRange(zoomRef.current, Date.now()) : bounds()),
    /** Zoom figé : les données ne bougent pas, pas de rafraîchissement. */
    frozen: zoom !== null && zoom.to !== null,
    /** À appeler quand des données fraîches arrivent : en direct, la fenêtre affichée devient la leur. */
    onData: () => {
      if (zoomRef.current?.to === null && !dragging.current) setView(null);
    },
    onSelectRange: (r: TimeRange | null) => {
      if (!r) return setZoom(null);
      const mid = (r.from + r.to) / 2;
      const half = Math.max(r.to - r.from, MIN_ZOOM_MS) / 2;
      setZoom({ from: Math.round(mid - half), to: Math.round(mid + half) });
    },
    onWheel: (w: WheelEvent) => {
      const b = bounds();
      if (w.pan && !zoomRef.current && !viewRef.current) return; // rien à déplacer sans zoom
      const cur = currentView(b);
      const next = w.pan ? wheelPan(cur, b, w.delta) : wheelZoom(cur, b, w.anchor, w.delta, MIN_ZOOM_MS);
      setView(next);
      commitLater(next);
    },
    onDragPan: (d: DragPanEvent) => {
      const b = bounds();
      if (d.phase === 'start') {
        dragStart.current = zoomRef.current || viewRef.current ? currentView(b) : null;
        dragging.current = dragStart.current !== null;
        if (timer.current) clearTimeout(timer.current);
        return;
      }
      if (!dragStart.current) return;
      const next = dragPan(dragStart.current, b, d.dxPx, d.widthPx);
      setView(next);
      if (d.phase === 'end') {
        dragging.current = false;
        dragStart.current = null;
        commitLater(next, 0);
      }
    },
  };
}

/** Pastille du zoom (« En direct » ou fenêtre figée) + bouton de retour à la plage complète. */
export function ZoomChip({ zoom, onReset }: { zoom: ZoomState | null; onReset: () => void }) {
  if (!zoom) return null;
  return (
    <>
      {zoom.to === null ? (
        <span className="zoom-chip mono live" data-testid="zoom-live" title="Collé au bout : la fenêtre avance avec le temps">
          <i className="live-dot" />En direct · {formatAxisTime(Date.now() - zoom.span, zoom.span)} → maintenant
        </span>
      ) : (
        <span className="zoom-chip mono" title="Fenêtre figée : revenez au bout pour suivre le direct">
          <ZoomIn size={12} strokeWidth={2} />{formatAxisTime(zoom.to - zoom.span, zoom.span)} → {formatAxisTime(zoom.to, zoom.span)}
        </span>
      )}
      <button onClick={onReset} data-testid="reset-zoom">
        <RotateCcw size={13} strokeWidth={2} /> Réinitialiser le zoom
      </button>
    </>
  );
}
