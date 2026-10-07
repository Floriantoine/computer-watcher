import { motion } from 'motion/react';
import { ChartLine, Cpu, Settings } from 'lucide-react';
import type { Route } from '../App';

interface Props {
  route: Route;
  onNavigate: (r: Route) => void;
}

export function TopNav({ route, onNavigate }: Props) {
  const active = route.view === 'metrics' ? 'metrics' : route.view === 'settings' ? null : 'main';
  const tabs = [
    { id: 'main', label: 'Processus', icon: Cpu, to: { view: 'main' } as Route },
    { id: 'metrics', label: 'Métriques', icon: ChartLine, to: { view: 'metrics' } as Route },
  ] as const;
  return (
    <nav className="topnav">
      <div className="tabs" role="tablist">
        {tabs.map(({ id, label, icon: Icon, to }) => (
          <button key={id} role="tab" aria-selected={active === id} className={`tab${active === id ? ' active' : ''}`} onClick={() => onNavigate(to)}>
            {active === id && <motion.span layoutId="tab" className="tab-indicator" transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }} />}
            <Icon size={14} strokeWidth={2} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <button className={`icon-btn${route.view === 'settings' ? ' active' : ''}`} title="Réglages" aria-label="Réglages" onClick={() => onNavigate({ view: 'settings' })}>
        <Settings size={16} strokeWidth={2} />
      </button>
    </nav>
  );
}
