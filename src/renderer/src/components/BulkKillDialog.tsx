import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { Info, Lock, Skull } from 'lucide-react';
import type { InstanceSummary } from '../../../core/types';
import {
  INACTIVE_SINCE_MS,
  bulkRequest,
  PRESETS,
  checkedLive,
  applyInitialPreset,
  initialSelection,
  pickSelection,
  toggleSelection,
  fetchInactive,
  includeLaunchers,
  presetState,
  type BulkRequest,
  type BulkSelection,
  type InactiveState,
  type Preset,
} from '../bulkKill';
import { useFocusTrap } from '../focusTrap';
import { CATEGORY_META } from '../categories';
import { formatAge, formatCpu, formatKB } from '../format';
import { sortInstances } from '../instances';
import { DuplicateBadge } from './CategoryTag';

const DAY = 86400;

interface Props {
  title: string;
  /** Instances proposées (relevées à l'ouverture), protégées comprises. */
  instances: InstanceSummary[];
  /** « Tout arrêter » : id du groupe dont les lanceurs partent avec les instances. */
  launchersOf?: string;
  /** Clés des instances présentes au dernier snapshot : les autres sont grisées et ignorées. */
  liveKeys: ReadonlySet<string>;
  /** Pids ayant déjà reçu SIGTERM à l'ouverture (instances décochées par défaut). */
  pendingPids: { has(pid: number): boolean };
  nameOf: (inst: InstanceSummary) => string;
  onConfirm: (req: BulkRequest) => void;
  onCancel: () => void;
  /** Raccourci appliqué une fois son état connu (« Libérer » : quand l'historique d'1 h est lu) ; rien de coché avant. */
  initialPreset?: Preset;
  /** Garder l'ordre reçu (« Libérer » : groupes qui grossissent d'abord) au lieu du tri par catégorie et âge. */
  ordered?: boolean;
}

/** Confirmation d'un kill groupé : liste cochable, raccourcis de pré-sélection, « Tuer (n) ». */
export function BulkKillDialog({ title, instances, launchersOf, liveKeys, pendingPids, nameOf, onConfirm, onCancel, initialPreset, ordered }: Props) {
  // Pendant la sortie animée, le dialogue ne doit plus déclencher d'action (pas de double envoi).
  const isPresent = useIsPresent();
  const list = useMemo(() => (ordered ? instances : sortInstances(instances)), [instances, ordered]);
  // raccourci initial : appliqué une seule fois, et jamais par-dessus un choix fait à la main (case ou raccourci)
  const [sel, setSel] = useState<BulkSelection>(() => initialSelection(instances, pendingPids, initialPreset));
  const { selected, preset } = sel;
  const [inactive, setInactive] = useState<InactiveState>({});

  useEffect(() => {
    let alive = true;
    const keys = instances.map((i) => i.key);
    const ask = (since: number) =>
      fetchInactive(keys, Date.now() - since, (k, s) => window.procWatch.classify.inactive(k, s)).catch(() => 'error' as const);
    void ask(INACTIVE_SINCE_MS.inactive1h).then((h1) => alive && setInactive((s) => ({ ...s, h1 })));
    void ask(INACTIVE_SINCE_MS.inactive1d).then((d1) => alive && setInactive((s) => ({ ...s, d1 })));
    return () => {
      alive = false;
    };
  }, [instances]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isPresent) onCancel();
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [isPresent, onCancel]);

  const checked = checkedLive(list, selected, liveKeys);
  const withLaunchers = includeLaunchers(launchersOf, list, selected, liveKeys);
  const historyError = inactive.h1 === 'error' || inactive.d1 === 'error';
  const noHistory = !historyError && (inactive.h1 === null || inactive.d1 === null);
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box);
  const protectedCount = list.filter((i) => i.protected).length;

  const pick = (p: Preset) => setSel((s) => pickSelection(s, list, p, inactive));
  useEffect(() => {
    setSel((s) => applyInitialPreset(s, list, initialPreset, inactive));
  }, [initialPreset, inactive, list]);
  const guard = (fn: () => void) => () => {
    if (isPresent) fn();
  };

  return (
    <motion.div
      className="overlay"
      onClick={guard(onCancel)}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      style={{ pointerEvents: isPresent ? undefined : 'none' }}
    >
      <motion.div
        ref={box}
        className="dialog bulk-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="bulk-title"
        data-testid="bulk-kill-dialog"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.94, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6, transition: { duration: 0.14 } }}
        transition={{ type: 'spring', stiffness: 420, damping: 28, mass: 0.8 }}
      >
        <div className="dialog-head">
          <span className="ico" aria-hidden><Skull size={17} strokeWidth={2} /></span>
          <div>
            <h3 id="bulk-title">{title}</h3>
            <p className="bulk-sub">
              {list.length} instance{list.length > 1 ? 's' : ''} proposée{list.length > 1 ? 's' : ''}
              {protectedCount > 0 && <> · {protectedCount} protégée{protectedCount > 1 ? 's' : ''}, décochée{protectedCount > 1 ? 's' : ''}</>}
            </p>
          </div>
        </div>

        <div className="bulk-presets" role="group" aria-label="Pré-sélection">
          {PRESETS.map((p) => {
            const st = presetState(p.id, inactive);
            return (
              <button
                key={p.id}
                type="button"
                className={`bulk-preset ${preset === p.id ? 'on' : ''}`}
                aria-pressed={preset === p.id}
                data-testid={`bulk-preset-${p.id}`}
                disabled={!st.enabled}
                title={st.reason}
                onClick={() => pick(p.id)}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        {historyError && (
          <p className="bulk-note"><Info size={13} strokeWidth={2.2} /> « Inactives » : historique indisponible (erreur).</p>
        )}
        {noHistory && (
          <p className="bulk-note"><Info size={13} strokeWidth={2.2} /> « Inactives » indisponible : pas d'historique (service d'enregistrement arrêté ou sans données).</p>
        )}

        <div className="bulk-rows" role="table" aria-label="Instances à arrêter">
          <div className="bulk-row bulk-head" role="row">
            <span role="columnheader" aria-label="Cochée" />
            <span role="columnheader">Projet</span>
            <span role="columnheader">Catégorie</span>
            <span role="columnheader">Commande</span>
            <span role="columnheader">Ports</span>
            <span role="columnheader" className="num">Depuis</span>
            <span role="columnheader" className="num">RAM</span>
            <span role="columnheader" className="num" title="CPU au moment de l'ouverture (pas une moyenne)">CPU (instant)</span>
          </div>
          {list.map((i) => {
            const m = CATEGORY_META[i.category];
            const Icon = m.icon;
            const gone = !liveKeys.has(i.key);
            const id = `bulk-${i.key}`;
            return (
              <label
                key={i.key}
                htmlFor={id}
                className={`bulk-row ${gone ? 'gone' : ''} ${i.protected ? 'prot' : ''}`}
                role="row"
                data-testid="bulk-row"
                style={{ '--cat': m.color } as CSSProperties}
                title={gone ? 'Instance disparue depuis l\'ouverture : ignorée' : undefined}
              >
                <span role="cell">
                  <input id={id} type="checkbox" checked={!gone && selected.has(i.key)} disabled={gone} onChange={() => setSel((s) => toggleSelection(s, i.key))} />
                </span>
                <span className="bulk-proj" role="cell" title={i.project ?? undefined}>{nameOf(i)}</span>
                <span className="inst-cat" role="cell">
                  <span className="inst-ico" aria-hidden><Icon size={12} strokeWidth={2.3} /></span>
                  <span className="inst-cat-label">{m.label}</span>
                </span>
                <span className="inst-label mono" role="cell" title={i.label}>
                  {i.protected && (
                    <span className="bulk-lock" title="Processus protégé : à cocher soi-même" aria-label="Protégée" role="img">
                      <Lock size={11} strokeWidth={2.4} />
                    </span>
                  )}
                  <span className="inst-label-text">{i.label}</span>
                  {i.duplicate && <DuplicateBadge />}
                  {gone && <span className="bulk-gone">disparue</span>}
                </span>
                <span className="inst-ports mono" role="cell">{i.ports.length ? i.ports.map((p) => `:${p}`).join(' ') : '—'}</span>
                <span className={`num mono ${i.ageSec > DAY ? 'old' : ''}`} role="cell">{formatAge(i.ageSec)}</span>
                <span className="num mono" role="cell">{formatKB(i.rssKB + i.swapKB)}</span>
                <span className="num mono" role="cell">{formatCpu(i.cpuPercent)}</span>
              </label>
            );
          })}
        </div>

        {launchersOf && (
          <p className="bulk-note" data-testid="bulk-launchers">
            <Info size={13} strokeWidth={2.2} />
            {withLaunchers
              ? 'Les lanceurs du projet (npm, sh…) seront aussi arrêtés.'
              : 'Lanceurs du projet (npm, sh…) conservés : toutes les instances ne sont pas cochées.'}
          </p>
        )}

        <div className="actions">
          <button onClick={guard(onCancel)} autoFocus data-testid="bulk-cancel">Annuler</button>
          <button
            className="danger"
            data-testid="bulk-confirm"
            disabled={checked.length === 0}
            onClick={guard(() => onConfirm(bulkRequest(list, selected, liveKeys, launchersOf)))}
          >
            Tuer ({checked.length})
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
