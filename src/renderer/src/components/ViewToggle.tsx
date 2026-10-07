import { LayoutGrid, List } from 'lucide-react';

export type ViewMode = 'cards' | 'list';

const STORAGE_KEY = 'pw.view';

export function loadView(): ViewMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'list' ? 'list' : 'cards';
  } catch {
    return 'cards';
  }
}

function saveView(v: ViewMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* stockage indisponible : le choix reste valable pour la session */
  }
}

export function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  const pick = (v: ViewMode) => () => {
    saveView(v);
    onChange(v);
  };
  return (
    <div className="view-toggle" role="group" aria-label="Affichage">
      <button type="button" data-testid="view-cards" className={value === 'cards' ? 'active' : ''} aria-pressed={value === 'cards'} title="Cartes" aria-label="Cartes" onClick={pick('cards')}>
        <LayoutGrid size={15} strokeWidth={2} />
      </button>
      <button type="button" data-testid="view-list" className={value === 'list' ? 'active' : ''} aria-pressed={value === 'list'} title="Liste" aria-label="Liste" onClick={pick('list')}>
        <List size={15} strokeWidth={2} />
      </button>
    </div>
  );
}
