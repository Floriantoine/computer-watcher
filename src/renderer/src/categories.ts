import { CircleQuestionMark, Container, Cpu, Database, FlaskConical, Globe, Hammer, Monitor, Server, Sparkles, Workflow, type LucideIcon } from 'lucide-react';
import type { Category } from '../../core/types';

export { CATEGORIES } from '../../core/classify/categories';

export interface CategoryMeta {
  /** Libellé des pastilles et des étiquettes */
  label: string;
  /** Forme courte du résumé des instances (« 1 front :5173 ») */
  short: string;
  /** Teinte de l'étiquette (passée en variable CSS --cat) */
  color: string;
  icon: LucideIcon;
}

export const CATEGORY_META: Record<Category, CategoryMeta> = {
  front: { label: 'Front', short: 'front', color: '#5cc8ff', icon: Monitor },
  back: { label: 'Back', short: 'back', color: '#a78bff', icon: Server },
  db: { label: 'BDD', short: 'BDD', color: '#ffb547', icon: Database },
  worker: { label: 'Worker', short: 'worker', color: '#5ee0b8', icon: Workflow },
  test: { label: 'Tests', short: 'tests', color: '#c3e86b', icon: FlaskConical },
  build: { label: 'Outils', short: 'outils', color: '#8fa3c0', icon: Hammer },
  container: { label: 'Conteneur', short: 'conteneur', color: '#4fa3ff', icon: Container },
  browser: { label: 'Navigateur', short: 'navigateur', color: '#ff8a3d', icon: Globe },
  ai: { label: 'IA', short: 'IA', color: '#e07cff', icon: Sparkles },
  system: { label: 'Système', short: 'système', color: '#9aa0ad', icon: Cpu },
  unknown: { label: 'Inconnu', short: 'inconnu', color: '#7d8391', icon: CircleQuestionMark },
};
