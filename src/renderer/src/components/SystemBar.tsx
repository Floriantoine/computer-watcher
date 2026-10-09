import type { SystemInfo } from '../../../core/types';
import { formatKB } from '../format';
import { barWidth } from '../motionBudget';
import { gaugeTone, metricLevels } from '../theme';
import { swapPercent, type Level, type SystemTile } from '../viewModel';
import { Sparkline, type SparkTone } from './charts/Sparkline';
import { AnimatedNumber } from './ui';

const pct = (n: number) => `${Math.round(n)} %`;
const load = (n: number) => (n / 100).toFixed(1).replace('.', ',');
const CORES = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;

interface StatProps {
  label: string;
  value: number;
  format: (n: number) => string;
  sub?: string;
  percent?: number;
  tone?: string;
  level?: Level;
  spark?: (number | null)[];
  /** Clic : trie les groupes selon cette tuile. */
  onClick?: () => void;
  active?: boolean;
  sortLabel?: string;
}

function Stat({ label, value, format, sub, percent, tone, level = 'ok', spark, onClick, active, sortLabel }: StatProps) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={`stat lvl-${level}${onClick ? ' stat-sort' : ''}${active ? ' is-sorted' : ''}`}
      {...(onClick ? { type: 'button' as const, onClick, 'aria-pressed': !!active, title: active ? `Trié par ${sortLabel} — recliquer pour revenir au tri mémoire` : `Trier par ${sortLabel}` } : {})}
    >
      <small>{label}</small>
      <div className="stat-value">
        <AnimatedNumber value={value} format={format} className="b" />
        {sub && <span className="sub">{sub}</span>}
      </div>
      {spark && <Sparkline values={spark} tone={(tone ?? 'cpu') as SparkTone} height={26} />}
      {percent !== undefined && (
        <div className="bar"><i className={`tone-${tone}`} style={{ width: barWidth(percent) }} /></div>
      )}
    </Tag>
  );
}

export interface SystemSparks { mem: (number | null)[]; swap: (number | null)[]; psi: (number | null)[]; load: (number | null)[] }

export function SystemBar({ system, sparks, sortTile = null, onSortTile }: { system: SystemInfo; sparks?: SystemSparks; sortTile?: SystemTile | null; onSortTile?: (t: SystemTile) => void }) {
  const sortProps = (t: SystemTile, sortLabel: string) => (onSortTile ? { onClick: () => onSortTile(t), active: sortTile === t, sortLabel } : {});
  const levels = metricLevels(system);
  const memUsed = system.memTotalKB - system.memAvailableKB;
  const swapUsed = system.swapTotalKB - system.swapFreeKB;
  return (
    <div className="system-bar">
      <Stat label="Mémoire" value={memUsed} format={formatKB} sub={`/ ${formatKB(system.memTotalKB)}`} percent={(memUsed / system.memTotalKB) * 100} tone="mem" spark={sparks?.mem} {...sortProps('mem', 'mémoire')} />
      <Stat
        label="Swap"
        value={swapUsed}
        format={formatKB}
        sub={`/ ${formatKB(system.swapTotalKB)}`}
        percent={swapPercent(system)}
        tone={gaugeTone('swap', levels.swap)}
        level={levels.swap}
        spark={sparks?.swap}
        {...sortProps('swap', 'swap')}
      />
      {system.psiSome10 !== null && (
        <Stat label="Pression mémoire" value={system.psiSome10} format={pct} percent={system.psiSome10} tone={gaugeTone('psi', levels.psi)} level={levels.psi} spark={sparks?.psi} {...sortProps('psi', 'mémoire')} />
      )}
      {/* Charge ×100 pour que l'arrondi de AnimatedNumber garde une décimale. */}
      <Stat label="Charge" value={Math.round(system.load1 * 100)} format={load} sub={CORES ? `${CORES} threads` : undefined} tone="cpu" spark={sparks?.load} {...sortProps('load', 'CPU')} />
    </div>
  );
}
