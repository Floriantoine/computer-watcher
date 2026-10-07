import type { SystemInfo } from '../../../core/types';
import { formatKB } from '../format';
import { pressureLevel, swapPercent } from '../viewModel';

function Gauge({ label, percent, level }: { label: string; percent: number; level: string }) {
  return (
    <div className="metric">
      <b>{label}</b>
      <div className="gauge"><i className={level} style={{ width: `${Math.min(100, percent)}%` }} /></div>
    </div>
  );
}

export function SystemBar({ system }: { system: SystemInfo }) {
  const level = pressureLevel(system);
  const memUsed = system.memTotalKB - system.memAvailableKB;
  const swapUsed = system.swapTotalKB - system.swapFreeKB;
  return (
    <div className="system-bar">
      <Gauge label={`RAM ${formatKB(memUsed)} / ${formatKB(system.memTotalKB)}`} percent={(memUsed / system.memTotalKB) * 100} level={level} />
      <Gauge label={`Swap ${formatKB(swapUsed)} / ${formatKB(system.swapTotalKB)}`} percent={swapPercent(system)} level={level} />
      {system.psiSome10 !== null && <Gauge label={`Pression mémoire ${system.psiSome10.toFixed(0)} %`} percent={system.psiSome10} level={level} />}
      <div className="metric"><b>Charge</b><span>{system.load1.toFixed(1)}</span></div>
    </div>
  );
}
