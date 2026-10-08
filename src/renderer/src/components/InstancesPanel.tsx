import { memo, useCallback, useRef, useState, type CSSProperties } from 'react';
import { Boxes, PenLine, Zap } from 'lucide-react';
import type { Category, GroupSummary, InstanceSummary, MemoryMetric } from '../../../core/types';
import { CATEGORY_META } from '../categories';
import { formatAge, formatCpu, formatKB } from '../format';
import { memLabel } from '../memMetric';
import { headerKillActions, instanceRowEqual, instanceSpark, showRevertToAuto, sortInstances } from '../instances';
import { DuplicateBadge } from './CategoryTag';
import { ReclassMenu } from './ReclassMenu';
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
   * Dialogue de confirmation groupée (BulkKillDialog), pré-filtré : instances proposées (protégées comprises) et, pour
   * « Tout arrêter », l'id du groupe dont les lanceurs s'ajoutent. Absent : boutons désactivés.
   */
  onKillInstances?: (instances: InstanceSummary[], launchersOf?: string) => void;
  memMetric?: MemoryMetric;
}

/** Callbacks stables passés aux lignes (elles sont mémoïsées) : ils lisent les props du dernier rendu. */
interface RowActions {
  menu: (key: string | null) => void;
  reclassify: (inst: InstanceSummary, c: Category | null) => void;
  kill: (inst: InstanceSummary) => void;
  force: (pids: number[]) => void;
}

/** Section « Instances » du détail d'un groupe projet : une ligne par instance, « Reclasser », kill par instance. */
export function InstancesPanel(props: Props) {
  const { group, sparks, ticksOf, stuckPids, pendingPids, onKillInstances, memMetric = 'rss' } = props;
  const mem = memLabel(memMetric);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const actionsRef = useRef<RowActions | null>(null);
  actionsRef.current ??= {
    menu: setMenuFor,
    reclassify: (inst, c) => {
      setMenuFor(null);
      latest.current.onReclassify(inst, c);
    },
    kill: (inst) => latest.current.onKillInstance(inst),
    force: (pids) => latest.current.onForce(pids),
  };
  const rowActions = actionsRef.current;
  const bulk = headerKillActions(group);
  const list = sortInstances(group.instances);
  return (
    <section className="instances-panel" data-testid="instances-panel">
      <div className="chart-panel-head">
        <h3><Boxes size={14} strokeWidth={2} /> Instances <span className="inst-count">{list.length}</span></h3>
        <span className="spacer" />
        {bulk.map((a) => (
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
        <div className="inst-row inst-head" role="row">
          <span role="columnheader">Catégorie</span>
          <span role="columnheader">Commande</span>
          <span role="columnheader">Ports</span>
          <span role="columnheader">1 h</span>
          <span role="columnheader" className="num">Depuis</span>
          <span role="columnheader" className="num" title={memMetric === 'pss' ? "PSS (mémoire partagée répartie) et swap de l'instance" : "Mémoire vive et swap de l'instance"}>{mem} + swap</span>
          <span role="columnheader" className="num">CPU</span>
          <span role="columnheader" className="sr-only">Actions</span>
        </div>
        {list.map((i) => (
          <InstanceRow
            key={i.key}
            inst={i}
            spark={instanceSpark(i, sparks, ticksOf)}
            stuck={i.pids.filter((p) => stuckPids.has(p))}
            pending={i.pids.some((p) => pendingPids.has(p))}
            canKill={group.killable}
            menuOpen={menuFor === i.key}
            memLabel={mem}
            actions={rowActions}
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
  memLabel: string;
  actions: RowActions;
}

function InstanceRowImpl({ inst: i, spark, stuck, pending, canKill, menuOpen, memLabel: memName, actions }: RowProps) {
  const m = CATEGORY_META[i.category];
  const Icon = m.icon;
  const manual = i.source === 'manual';
  const onOpen = useCallback((open: boolean) => actions.menu(open ? i.key : null), [actions, i.key]);
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
      <span className={`num mono ${i.ageSec > DAY ? 'old' : ''}`} role="cell">{formatAge(i.ageSec)}</span>
      <span className="num mono" role="cell" title={`${memName} ${formatKB(i.rssKB)} + swap ${formatKB(i.swapKB)}`}>{formatKB(i.rssKB + i.swapKB)}</span>
      <span className="num mono" role="cell">{formatCpu(i.cpuPercent)}</span>
      <span className="inst-act" role="cell">
        <ReclassMenu
          current={i.category}
          revert={showRevertToAuto(i)}
          open={menuOpen}
          onOpen={onOpen}
          onPick={(c) => actions.reclassify(i, c)}
        />
        {stuck.length ? (
          <ForceButton onClick={() => actions.force(stuck)} />
        ) : (
          <KillButton size="sm" pending={pending} disabled={!canKill} onClick={() => actions.kill(i)} />
        )}
      </span>
    </div>
  );
}

/** Ne se re-rend que si ce que la ligne affiche a changé (les actions sont stables). */
const InstanceRow = memo(InstanceRowImpl, (a, b) => a.actions === b.actions && a.memLabel === b.memLabel && instanceRowEqual(a, b));
