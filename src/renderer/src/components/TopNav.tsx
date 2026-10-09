import { memo } from 'react';
import { motion } from 'motion/react';
import { ChartLine, Cpu, FolderOpen, Settings } from 'lucide-react';
import type { Route } from '../App';

interface Props {
  route: Route;
  onNavigate: (r: Route) => void;
  /** Alertes non vues : badge sur l'onglet Métriques. */
  unseen?: number;
}

/** Onglets du haut, dans l'ordre : Processus, Métriques, /tmp. */
export const NAV_TABS = [
  { id: 'main', label: 'Processus', icon: Cpu, to: { view: 'main' } as Route },
  { id: 'metrics', label: 'Métriques', icon: ChartLine, to: { view: 'metrics' } as Route },
  { id: 'tmp', label: '/tmp', icon: FolderOpen, to: { view: 'tmp' } as Route },
] as const;

/** Onglet actif : le détail d'un groupe relève de Processus ; Réglages n'a pas d'onglet. */
const activeTab = (r: Route) => (r.view === 'metrics' || r.view === 'tmp' ? r.view : r.view === 'settings' ? null : 'main');

/**
 * Mémoïsée : son indicateur d'onglet (layoutId) déclencherait sinon, à chaque snapshot, une mesure de mise en page
 * de tous les éléments animés de la page (cartes comprises).
 */
export const TopNav = memo(function TopNav({ route, onNavigate, unseen = 0 }: Props) {
  const active = activeTab(route);
  return (
    <nav className="topnav">
      <div className="tabs" role="tablist">
        {NAV_TABS.map(({ id, label, icon: Icon, to }) => (
          <button key={id} role="tab" aria-selected={active === id} className={`tab${active === id ? ' active' : ''}`} data-testid={`tab-${id}`} onClick={() => onNavigate(to)}>
            {active === id && <motion.span layoutId="tab" className="tab-indicator" transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }} />}
            <Icon size={14} strokeWidth={2} />
            <span>{label}</span>
            {id === 'metrics' && unseen > 0 && (
              <span className="tab-badge" data-testid="metrics-badge" aria-label={`${unseen} alerte${unseen > 1 ? 's' : ''} non vue${unseen > 1 ? 's' : ''}`}>
                {unseen > 99 ? '99+' : unseen}
              </span>
            )}
          </button>
        ))}
      </div>
      <button className={`icon-btn${route.view === 'settings' ? ' active' : ''}`} title="Réglages" aria-label="Réglages" onClick={() => onNavigate({ view: 'settings' })}>
        <Settings size={16} strokeWidth={2} />
      </button>
    </nav>
  );
});
