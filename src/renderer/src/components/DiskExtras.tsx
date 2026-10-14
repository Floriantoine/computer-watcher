import { Container, FolderGit2, Package, TriangleAlert } from 'lucide-react';
import { DOCKER_LABELS } from '../../../core/disk/docker';
import type { ExtrasView } from '../../../core/disk/extras';
import { dockerActionEmpty, inactiveText, measuredAt, type ExtraKind, type ExtraSelection } from '../disk';
import { formatKB } from '../format';

interface Props {
  extras: ExtrasView | null;
  error: string | null;
  loading: boolean;
  sel: ExtraSelection;
  busy: boolean;
  onToggle(kind: ExtraKind, key: string): void;
  onOpenSettings?: () => void;
}

function ExtraRow({ testid, k, checked, disabled, label, sizeKB, sub, why, onChange }: {
  testid: string; k: string; checked: boolean; disabled: boolean; label: string; sizeKB: number | null; sub: string; why?: string | null; onChange: () => void;
}) {
  const id = `x-${testid}-${k}`;
  return (
    <li className={`disk-family${checked ? ' on' : ''}${why ? ' refused' : ''}`} data-testid={testid} data-key={k}>
      <input type="checkbox" id={id} checked={checked} disabled={disabled || !!why} onChange={onChange} />
      <label htmlFor={id} className="name">{label}</label>
      <span className="size mono">{sizeKB === null ? 'taille inconnue' : formatKB(sizeKB)}</span>
      <span className="when">{sub}</span>
      {why && <span className="why" data-testid="disk-extra-why">{why}</span>}
    </li>
  );
}

/** Sections du lot 2 : node_modules inactifs, worktrees fusionnés, dossiers inconnus de ~/.cache, Docker. */
export function DiskExtras({ extras: x, error, loading, sel, busy, onToggle, onOpenSettings }: Props) {
  if (error && !x) return <div className="chart-empty small" role="alert">{error}</div>;
  if (!x) return <div className="chart-empty small" data-testid="disk-extras-status">Analyse des projets, de ~/.cache et de Docker…</div>;
  // Après un échec d'actualisation, l'ancienne liste reste lisible mais rien n'y est cochable.
  const locked = busy || !!error;
  return (
    <div className="disk-extras" data-testid="disk-extras">
      {error && <div className="chart-empty small" role="alert">{error} · liste précédente, non cochable : actualise</div>}
      <div className="sub" data-testid="disk-extras-status">
        {loading ? 'Analyse…' : measuredAt(x.at).replace(/^mesuré/, 'analysé')} · dossiers de projets :{' '}
        {x.projectRoots.roots.length ? x.projectRoots.roots.join(', ') : 'aucun'}
        {x.projectRoots.isDefault ? ' (défaut)' : ''}
        {x.projectRoots.missing.length ? ` · introuvable : ${x.projectRoots.missing.join(', ')}` : ''}
        {x.truncated ? ' · incomplet : trop de dossiers' : ''}
        {onOpenSettings && (
          <>
            {' '}
            <button className="crumb-link" onClick={onOpenSettings}>Réglages</button>
          </>
        )}
      </div>

      <h4 className="disk-sub"><Package size={13} strokeWidth={2} /> node_modules inactifs (plus de {x.days} j)</h4>
      {x.nodeModules.length ? (
        <ul className="disk-family-list">
          {x.nodeModules.map((c) => (
            <ExtraRow key={c.path} testid="disk-nm-row" k={c.path} checked={sel.nodeModules.has(c.path)} disabled={locked} label={`node_modules de ${c.label}`}
              sizeKB={c.sizeKB} sub={inactiveText(c, x.days)} onChange={() => onToggle('nodeModules', c.path)} />
          ))}
        </ul>
      ) : <div className="chart-empty small">Aucun node_modules inactif</div>}

      <h4 className="disk-sub"><FolderGit2 size={13} strokeWidth={2} /> Worktrees fusionnés</h4>
      {x.gitMissing ? <div className="chart-empty small">git introuvable (/usr/bin/git)</div> : x.worktrees.length ? (
        <ul className="disk-family-list">
          {x.worktrees.map((c) => (
            <ExtraRow key={c.path} testid="disk-wt-row" k={c.path} checked={sel.worktrees.has(c.path)} disabled={locked} label={`worktree ${c.label}`} sizeKB={c.sizeKB}
              sub={`${c.path} · git worktree remove puis git branch -d (jamais forcé)`} why={c.refusal} onChange={() => onToggle('worktrees', c.path)} />
          ))}
        </ul>
      ) : <div className="chart-empty small">Aucun worktree fusionné</div>}
      {x.projectErrors.map((e) => <div key={e} className="sub">{e}</div>)}

      <h4 className="disk-sub"><TriangleAlert size={13} strokeWidth={2} /> Autres dossiers de ~/.cache</h4>
      {x.cacheDirs.refusal ? <div className="chart-empty small">{x.cacheDirs.refusal}</div> : x.cacheDirs.dirs.length ? (
        <>
          <p className="disk-warning">Inconnu : vérifie avant. Ces dossiers ne sont pas reconnus ; une appli peut y garder autre chose qu’un cache.</p>
          <ul className="disk-family-list">
            {x.cacheDirs.dirs.map((c) => (
              <ExtraRow key={c.name} testid="disk-cache-row" k={c.name} checked={sel.cacheDirs.has(c.name)} disabled={locked} label={`~/.cache/${c.name}`} sizeKB={c.sizeKB}
                sub="inconnu : vérifie avant" why={c.refusal} onChange={() => onToggle('cacheDirs', c.name)} />
            ))}
          </ul>
        </>
      ) : <div className="chart-empty small">Rien d’autre dans ~/.cache</div>}

      {x.docker && (
        <>
          <h4 className="disk-sub"><Container size={13} strokeWidth={2} /> Docker {x.docker.version}</h4>
          <ul className="disk-family-list">
            {x.docker.actions.map((a) => (
              <ExtraRow key={a.id} testid="disk-docker-row" k={a.id} checked={sel.docker.has(a.id)} disabled={locked || dockerActionEmpty(a)} label={DOCKER_LABELS[a.id]} sizeKB={a.reclaimKB}
                sub={[a.items.slice(0, 5).join(', ') || 'rien à retirer', a.items.length > 5 ? `… et ${a.items.length - 5} autres` : '', a.note ?? ''].filter(Boolean).join(' · ')}
                onChange={() => onToggle('docker', a.id)} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
