// src/renderer/src/components/ReplayPanel.tsx — arbre reconstruit à l'instant examiné (survol ou instant figé), lecture seule
import { useMemo } from 'react';
import { History } from 'lucide-react';
import type { MemoryMetric, ProcNode } from '../../../core/types';
import { formatInstant } from '../metrics';
import { liveKeySet, liveMemMap, replayEmptyText, replayTree } from '../replay';
import type { Replay } from '../useReplay';
import { ReplayTree } from './ReplayTree';

/** Arbre reconstruit à l'instant examiné, à la place de l'arbre en direct. */
export function ReplayPanel({ replay, liveRoots, memMetric = 'rss' }: { replay: Replay; liveRoots: ProcNode[] | null; memMetric?: MemoryMetric }) {
  const instant = replay.instant!;
  const tree = replay.tree;
  const live = useMemo(() => liveKeySet(liveRoots), [liveRoots]);
  // Mémoire actuelle des processus encore vivants (écart « alors vs maintenant ») ; en PSS, pas comparable au RSS enregistré.
  const liveMem = useMemo(() => (memMetric === 'pss' ? undefined : liveMemMap(liveRoots)), [liveRoots, memMetric]);
  // Tant que l'arbre en direct n'est pas arrivé, personne n'est déclaré mort.
  const nodes = useMemo(
    () => (tree ? replayTree(tree.procs, (pid, st) => liveRoots === null || live.has(`${pid}:${st}`)) : []),
    [tree, live, liveRoots],
  );
  return (
    <div className="panel replay-panel">
      <div className="panel-head replay-banner" data-testid="replay-banner">
        <History size={14} strokeWidth={2} />
        {/* Instant de l'arbre affiché (l'arbre précédent reste à l'écran pendant le chargement du suivant). */}
        <h3>Arbre au {formatInstant(tree ? tree.ts : instant)}</h3>
        <span className="sub">
          — seuls les processus au-dessus des seuils d'enregistrement apparaissent{tree?.source === 'minute' ? ' (moyennes par minute)' : ''}
        </span>
        <span className="spacer" />
        <button className="tree-toggle-all" data-testid="replay-live" onClick={replay.live}>Revenir au direct</button>
      </div>
      {tree === undefined ? (
        <p className="empty">Chargement…</p>
      ) : tree === null ? (
        <p className="empty">Historique indisponible</p>
      ) : nodes.length === 0 ? (
        <p className="empty" data-testid="replay-empty">{replayEmptyText(tree)}</p>
      ) : (
        <ReplayTree nodes={nodes} at={tree.ts} omitted={tree.omitted} liveMem={liveMem} />
      )}
    </div>
  );
}
