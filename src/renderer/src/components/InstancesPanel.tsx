import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Boxes, Check, ChevronDown, PenLine, RotateCcw, Zap } from 'lucide-react';
import type { Category, GroupSummary, InstanceSummary } from '../../../core/types';
import { CATEGORIES, CATEGORY_META } from '../categories';
import { formatAge, formatCpu, formatKB } from '../format';
import { headerKillActions, instanceSpark, sortInstances } from '../instances';
import { DuplicateBadge } from './CategoryTag';
import { Sparkline } from './charts/Sparkline';
import { ForceButton, KillButton } from './ui';

const DAY = 86400;

interface Props {
  group: GroupSummary;
  /** Séries mémoire des processus déjà chargées pour l'arbre (`procSparkMap`) */
  sparks: ReadonlyMap<string, (number | null)[]>;
  /** pid → startTicks d'après l'arbre du groupe (pour retrouver les séries des processus non racines) */
  ticksOf: ReadonlyMap<number, number>;
  stuckPids: Set<number>;
  pendingPids: Set<number>;
  onReclassify: (inst: InstanceSummary, category: Category | null) => void;
  onKillInstance: (inst: InstanceSummary) => void;
  onForce: (pids: number[]) => void;
  /**
   * Dialogue de confirmation groupée (Task 9), pré-filtré : instances proposées (protégées comprises) et, pour
   * « Tout arrêter », l'id du groupe dont les lanceurs s'ajoutent. Absent tant que le dialogue n'existe pas : boutons désactivés.
   */
  onKillInstances?: (instances: InstanceSummary[], launchersOf?: string) => void;
}

/** Section « Instances » du détail d'un groupe projet : une ligne par instance, « Reclasser », kill par instance. */
export function InstancesPanel({ group, sparks, ticksOf, stuckPids, pendingPids, onReclassify, onKillInstance, onForce, onKillInstances }: Props) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const actions = headerKillActions(group);
  const list = sortInstances(group.instances);
  return (
    <section className="instances-panel" data-testid="instances-panel">
      <div className="chart-panel-head">
        <h3><Boxes size={14} strokeWidth={2} /> Instances <span className="inst-count">{list.length}</span></h3>
        <span className="spacer" />
        {actions.map((a) => (
          <button
            key={a.id}
            type="button"
            className="danger inst-bulk"
            data-testid={`instances-kill-${a.id}`}
            disabled={!onKillInstances}
            title={onKillInstances ? `${a.label} : ${a.instances.length} instance${a.instances.length > 1 ? 's' : ''} à confirmer` : 'Bientôt disponible'}
            onClick={() => onKillInstances?.(a.instances, a.launchersOf)}
          >
            <Zap size={13} strokeWidth={2.4} />
            {a.label}
          </button>
        ))}
      </div>
      <div className="inst-rows" role="table" aria-label="Instances">
        {list.map((i) => (
          <InstanceRow
            key={i.key}
            inst={i}
            spark={instanceSpark(i, sparks, ticksOf)}
            stuck={i.pids.filter((p) => stuckPids.has(p))}
            pending={i.pids.some((p) => pendingPids.has(p))}
            canKill={group.killable}
            menuOpen={menuFor === i.key}
            onMenu={(open) => setMenuFor(open ? i.key : null)}
            onReclassify={(c) => {
              setMenuFor(null);
              onReclassify(i, c);
            }}
            onKill={() => onKillInstance(i)}
            onForce={onForce}
          />
        ))}
      </div>
    </section>
  );
}

interface RowProps {
  inst: InstanceSummary;
  spark: (number | null)[] | undefined;
  stuck: number[];
  pending: boolean;
  canKill: boolean;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  onReclassify: (c: Category | null) => void;
  onKill: () => void;
  onForce: (pids: number[]) => void;
}

function InstanceRow({ inst: i, spark, stuck, pending, canKill, menuOpen, onMenu, onReclassify, onKill, onForce }: RowProps) {
  const m = CATEGORY_META[i.category];
  const Icon = m.icon;
  const manual = i.source === 'manual';
  return (
    <div className="inst-row" role="row" data-testid="instance-row" style={{ '--cat': m.color } as CSSProperties}>
      <span className="inst-cat" role="cell">
        <span className="inst-ico" aria-hidden><Icon size={13} strokeWidth={2.3} /></span>
        <span className="inst-cat-label">{m.label}</span>
        {manual && (
          <span className="inst-manual" data-testid="instance-manual" title="Classée à la main" aria-label="Classée à la main" role="img">
            <PenLine size={11} strokeWidth={2.4} />
          </span>
        )}
      </span>
      <span className="inst-label mono" role="cell" title={i.label}>
        <span className="inst-label-text">{i.label}</span>
        {i.duplicate && <DuplicateBadge />}
      </span>
      <span className="inst-ports mono" role="cell">{i.ports.length ? i.ports.map((p) => `:${p}`).join(' ') : '—'}</span>
      <span className="inst-spark" role="cell" title="RAM sur 1 h">
        {spark && spark.filter((v) => v !== null).length >= 2 ? <Sparkline values={spark} tone="mem" height={18} /> : <span className="mono muted">—</span>}
      </span>
      <span className={`num mono ${i.ageSec > DAY ? 'old' : ''}`} role="cell" title="Ancienneté">{formatAge(i.ageSec)}</span>
      <span className="num mono" role="cell" title="RAM + swap">{formatKB(i.rssKB + i.swapKB)}</span>
      <span className="num mono" role="cell" title="CPU">{formatCpu(i.cpuPercent)}</span>
      <span className="inst-act" role="cell">
        <ReclassMenu current={i.category} manual={manual} open={menuOpen} onOpen={onMenu} onPick={onReclassify} />
        {stuck.length ? (
          <ForceButton onClick={() => onForce(stuck)} />
        ) : (
          <KillButton size="sm" pending={pending} disabled={!canKill} onClick={onKill} />
        )}
      </span>
    </div>
  );
}

function ReclassMenu({ current, manual, open, onOpen, onPick }: { current: Category; manual: boolean; open: boolean; onOpen: (open: boolean) => void; onPick: (c: Category | null) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open, onOpen]);
  return (
    <span className="reclass" ref={ref}>
      <button type="button" className="reclass-btn" data-testid="reclass-button" aria-haspopup="menu" aria-expanded={open} onClick={() => onOpen(!open)}>
        Reclasser <ChevronDown size={12} strokeWidth={2.2} />
      </button>
      {open && (
        <div className="reclass-menu" role="menu" data-testid="reclass-menu">
          {CATEGORIES.map((c) => {
            const m = CATEGORY_META[c];
            const Icon = m.icon;
            return (
              <button key={c} type="button" role="menuitemradio" aria-checked={c === current} style={{ '--cat': m.color } as CSSProperties} onClick={() => onPick(c)}>
                <Icon size={13} strokeWidth={2.2} />
                <span>{m.label}</span>
                {c === current && <Check size={13} strokeWidth={2.4} className="reclass-check" />}
              </button>
            );
          })}
          {manual && (
            <button type="button" role="menuitem" className="reclass-auto" data-testid="reclass-auto" onClick={() => onPick(null)}>
              <RotateCcw size={13} strokeWidth={2.2} />
              <span>Revenir à l'automatique</span>
            </button>
          )}
        </div>
      )}
    </span>
  );
}
