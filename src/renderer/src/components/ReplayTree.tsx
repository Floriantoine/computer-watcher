// src/renderer/src/components/ReplayTree.tsx — arbre rejoué (lecture seule : aucun bouton de kill)
import type { ReactElement } from 'react';
import { formatCpu, formatKB } from '../format';
import { nowDelta } from '../nowDelta';
import type { ReplayNode } from '../replay';

const p2 = (n: number) => String(n).padStart(2, '0');

/** « HH:MM », précédé de « dd/MM » si ce n'est pas le jour de `at`. */
function hhmm(ts: number, at: number): string {
  const d = new Date(ts);
  const t = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return d.toDateString() === new Date(at).toDateString() ? t : `${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${t}`;
}

/** `omitted` : processus au-delà de la taille maximale renvoyée (les plus petits), signalés en dernière ligne. */
/** `liveMem` : RSS actuel des processus encore vivants (écart « alors vs maintenant » sur la mémoire) ; absent : pas d'écart. */
export function ReplayTree({ nodes, at, omitted = 0, liveMem }: { nodes: ReplayNode[]; at: number; omitted?: number; liveMem?: ReadonlyMap<string, number> }): ReactElement {
  const rows: ReactElement[] = [];
  const walk = (ns: ReplayNode[], depth: number) => {
    for (const n of ns) {
      const r = n.row;
      const d = n.dead ? null : nowDelta(r.rssKB, liveMem?.get(`${r.pid}:${r.startTicks}`), 'kb');
      rows.push(
        <tr key={`${r.pid}:${r.startTicks}`} className={n.dead ? 'dead' : ''} data-testid="replay-row">
          <td className="pid mono" style={{ paddingLeft: 10 + depth * 18 }}>{r.pid}</td>
          <td className="name">{r.name}</td>
          <td className="num mono">{formatCpu(r.cpu)}</td>
          <td className="num mono">
            {d && <span className={`row-delta delta-${d.tone}`} data-testid="row-delta" title={d.title}>{d.text}</span>}
            {formatKB(Math.round(r.rssKB))}
          </td>
          <td className="num mono">{r.swapKB === null ? '—' : formatKB(r.swapKB)}</td>
          <td className="state mono">
            {n.dead && n.diedAt !== null ? <span data-testid="replay-dead">mort depuis {hhmm(n.diedAt, at)}</span> : 'toujours là'}
          </td>
        </tr>,
      );
      walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  if (omitted > 0) {
    rows.push(
      <tr key="__omitted" className="omitted" data-testid="replay-omitted">
        <td colSpan={6} className="mono">… {omitted} autres processus (les plus petits) non affichés</td>
      </tr>,
    );
  }
  return (
    <div className="panel-scroll">
      <table className="tree replay-tree" data-testid="replay-tree">
        <thead>
          <tr><th>PID</th><th>Nom</th><th className="num">CPU</th><th className="num" title="Mémoire résidente enregistrée par le service (RSS), pas la PSS">RSS (enregistrée)</th><th className="num">Swap</th><th>État</th></tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}
