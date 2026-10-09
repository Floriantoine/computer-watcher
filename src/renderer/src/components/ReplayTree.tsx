// src/renderer/src/components/ReplayTree.tsx — arbre rejoué (lecture seule : aucun bouton de kill)
import { memo, type ReactElement } from 'react';
import { formatCpu, formatKB } from '../format';
import { nowDelta } from '../nowDelta';
import type { ProcTreeRow } from '../../../core/types';
import type { ReplayNode } from '../replay';

const p2 = (n: number) => String(n).padStart(2, '0');

/** « HH:MM », précédé de « dd/MM » si ce n'est pas le jour de `at`. */
function hhmm(ts: number, at: number): string {
  const d = new Date(ts);
  const t = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return d.toDateString() === new Date(at).toDateString() ? t : `${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${t}`;
}

interface RowProps {
  row: ProcTreeRow;
  depth: number;
  dead: boolean;
  /** « mort depuis HH:MM » ou « toujours là » */
  state: string;
  deltaText: string | null;
  deltaTitle: string | null;
}

const sameRow = (a: ProcTreeRow, b: ProcTreeRow): boolean =>
  a === b || (a.pid === b.pid && a.startTicks === b.startTicks && a.name === b.name && a.cpu === b.cpu && a.rssKB === b.rssKB && a.swapKB === b.swapKB);

/**
 * Ligne mémoïsée par valeurs (clé `pid:startTicks`) : quand l'aperçu passe à l'échantillon voisin, seules les lignes
 * dont une valeur affichée a changé sont re-rendues.
 */
const ReplayRow = memo(
  function ReplayRow({ row: r, depth, dead, state, deltaText, deltaTitle }: RowProps) {
    return (
      <tr className={dead ? 'dead' : ''} data-testid="replay-row">
        <td className="pid mono" style={{ paddingLeft: 10 + depth * 18 }}>{r.pid}</td>
        <td className="name">{r.name}</td>
        <td className="num mono">{formatCpu(r.cpu)}</td>
        <td className="num mono">
          {deltaText && <span className="row-delta" data-testid="row-delta" title={deltaTitle ?? undefined}>{deltaText}</span>}
          {formatKB(Math.round(r.rssKB))}
        </td>
        <td className="num mono">{r.swapKB === null ? '—' : formatKB(r.swapKB)}</td>
        <td className="state mono">{dead ? <span data-testid="replay-dead">{state}</span> : state}</td>
      </tr>
    );
  },
  (a, b) =>
    a.depth === b.depth && a.dead === b.dead && a.state === b.state && a.deltaText === b.deltaText &&
    a.deltaTitle === b.deltaTitle && sameRow(a.row, b.row),
);

/** `omitted` : processus au-delà de la taille maximale renvoyée (les plus petits), signalés en dernière ligne. */
/** `liveMem` : RSS actuel des processus encore vivants (écart « alors vs maintenant » sur la mémoire) ; absent : pas d'écart. */
function ReplayTreeImpl({ nodes, at, omitted = 0, liveMem }: { nodes: ReplayNode[]; at: number; omitted?: number; liveMem?: ReadonlyMap<string, number> }): ReactElement {
  const rows: ReactElement[] = [];
  const walk = (ns: ReplayNode[], depth: number) => {
    for (const n of ns) {
      const r = n.row;
      const d = n.dead ? null : nowDelta(r.rssKB, liveMem?.get(`${r.pid}:${r.startTicks}`), 'kb');
      const state = n.dead && n.diedAt !== null ? `mort depuis ${hhmm(n.diedAt, at)}` : 'toujours là';
      rows.push(
        <ReplayRow
          key={`${r.pid}:${r.startTicks}`}
          row={r}
          depth={depth}
          dead={n.dead && n.diedAt !== null}
          state={state}
          deltaText={d?.text ?? null}
          deltaTitle={d?.title ?? null}
        />,
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

/** Mémoïsé : l'aperçu au survol re-rend le détail à chaque image (tuiles), l'arbre seulement quand il change. */
export const ReplayTree = memo(ReplayTreeImpl);
