import { useMemo, useState, type MouseEvent } from 'react';
import { FolderOpen } from 'lucide-react';
import type { FamilyId } from '../../../core/disk/families';
import { findNode, sunArcs, type Arc, type SunNode } from '../../../core/disk/sunTree';
import { arcPath, OTHER_COLOR, sunColors } from '../disk';
import { formatKB } from '../format';

interface Props {
  tree: SunNode;
  /** Dossier affiché au centre. */
  current: string;
  onEnter: (path: string) => void;
  onUp: () => void;
  familyOf: (path: string) => FamilyId | null;
  isHighlighted: (path: string) => boolean;
  onToggleFamily: (id: FamilyId) => void;
  onOpen: (path: string) => void;
}

const SIZE = 320;
const C = SIZE / 2;
/** Rayons des anneaux (3 niveaux visibles) : centre, puis bord de chaque niveau. */
const RADII = [46, 96, 132, 156];
/** Segments plus fins que cet angle : pas dessinés (le parent les montre déjà). */
const MIN_ANGLE = 0.4;

const shortPath = (root: string, p: string) => (p === root ? '~' : p.startsWith(`${root}/`) ? `~/${p.slice(root.length + 1)}` : p);

/** Soleil façon Filelight : anneaux = niveaux de dossiers, angle ∝ taille ; clic = entrer, centre = remonter. */
export function SunburstChart({ tree, current, onEnter, onUp, familyOf, isHighlighted, onToggleFamily, onOpen }: Props) {
  const node = findNode(tree, current) ?? tree;
  const arcs = useMemo(() => sunArcs(node, 3).filter((a) => a.a1 - a.a0 >= MIN_ANGLE), [node]);
  // une teinte par dossier de premier niveau du dossier affiché
  const color = useMemo(() => sunColors(node), [node]);
  const sizeOf = useMemo(() => {
    const m = new Map<string, number>([[node.path, node.sizeKB]]);
    for (const a of arcs) m.set(a.path, a.sizeKB);
    return m;
  }, [arcs, node]);
  const [hover, setHover] = useState<{ arc: Arc; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const parentOf = (a: Arc) => (a.depth === 1 ? node.path : a.path.slice(0, a.path.lastIndexOf('/')));
  const hasChildren = (path: string) => (findNode(node, path)?.children.length ?? 0) > 0;

  const place = (e: MouseEvent) => {
    const box = (e.currentTarget as SVGElement).ownerSVGElement?.parentElement?.getBoundingClientRect();
    return { x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) };
  };
  const click = (a: Arc) => {
    setMenu(null);
    if (a.other) return;
    const fam = familyOf(a.path);
    if (fam) onToggleFamily(fam);
    else if (hasChildren(a.path)) onEnter(a.path);
  };

  return (
    <div className="sun" data-testid="disk-sun" onMouseLeave={() => setHover(null)}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={`Occupation de ${shortPath(tree.path, node.path)}`}>
        {arcs.map((a) => {
          const fam = a.other ? null : familyOf(a.path);
          const lit = !!fam && isHighlighted(a.path);
          return (
            <path
              key={a.path}
              data-testid="disk-sun-arc"
              data-path={a.path}
              data-family={fam ?? undefined}
              className={`sun-arc${fam ? ' family' : ''}${lit ? ' lit' : ''}`}
              d={arcPath(C, C, RADII[a.depth - 1] + 1, RADII[a.depth], a.a0, a.a1)}
              fill={a.other ? OTHER_COLOR : color(a.path)}
              fillOpacity={a.other ? 1 : lit ? 1 : fam ? 0.9 : a.depth === 1 ? 1 : a.depth === 2 ? 0.55 : 0.35}
              stroke={fam ? '#ffffff' : 'var(--bg)'}
              strokeWidth={lit ? 2.5 : 1.2}
              role="button"
              tabIndex={0}
              aria-label={`${a.name}, ${formatKB(a.sizeKB)}`}
              onMouseMove={(e) => setHover({ arc: a, ...place(e) })}
              onClick={() => click(a)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), click(a))}
              onContextMenu={(e) => {
                e.preventDefault();
                if (a.other || fam || !hasChildren(a.path)) return;
                setMenu({ path: a.path, ...place(e) });
              }}
            />
          );
        })}
        <g
          className={`sun-center${node.path !== tree.path ? ' can-up' : ''}`}
          data-testid="disk-sun-center"
          role="button"
          tabIndex={0}
          aria-label="Remonter d’un niveau"
          onClick={() => node.path !== tree.path && onUp()}
          onKeyDown={(e) => e.key === 'Enter' && node.path !== tree.path && onUp()}
        >
          <circle cx={C} cy={C} r={RADII[0] - 2} />
          <text x={C} y={C - 3} textAnchor="middle" className="sun-center-name">
            {node.path === tree.path ? '~' : node.name.length > 14 ? `${node.name.slice(0, 13)}…` : node.name}
          </text>
          <text x={C} y={C + 13} textAnchor="middle" className="sun-center-size">{formatKB(node.sizeKB)}</text>
        </g>
      </svg>
      {hover && !menu && (
        <div className="sun-tip" style={{ left: hover.x + 12, top: hover.y + 12 }} data-testid="disk-sun-tip">
          <b>{hover.arc.name}</b>
          {!hover.arc.other && <span className="mono">{shortPath(tree.path, hover.arc.path)}</span>}
          <span>
            {formatKB(hover.arc.sizeKB)} · {Math.round((100 * hover.arc.sizeKB) / Math.max(1, sizeOf.get(parentOf(hover.arc)) ?? node.sizeKB))} % du parent
          </span>
          {!hover.arc.other && familyOf(hover.arc.path) && <span className="sun-tip-fam">Récupérable : clic pour cocher</span>}
        </div>
      )}
      {menu && (
        <div className="sun-menu" style={{ left: menu.x, top: menu.y }} role="menu" onMouseLeave={() => setMenu(null)}>
          <button
            role="menuitem"
            data-testid="disk-sun-open"
            onClick={() => {
              onOpen(menu.path);
              setMenu(null);
            }}
          >
            <FolderOpen size={13} strokeWidth={2} /> Ouvrir dans le gestionnaire de fichiers
          </button>
        </div>
      )}
    </div>
  );
}
