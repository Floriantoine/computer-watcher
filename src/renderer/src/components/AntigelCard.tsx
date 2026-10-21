import { Snowflake } from 'lucide-react';
import type { AntigelView } from '../../../core/antigel/state';
import { antigelCard } from '../antigel';
import { formatKB } from '../format';
import { cardTone } from '../theme';

/** Métriques : mémoire de cwatch.slice face à son plafond, ralentissements, arrêts par le noyau sous le plafond. */
export function AntigelCard({ view, onSettings }: { view: AntigelView | null; onSettings?: () => void }) {
  const m = antigelCard(view);
  return (
    <section className={`antigel-card tone-${m.tone}`} data-testid="antigel-card" aria-label="Plafond de travail">
      <div className="antigel-head">
        <Snowflake size={15} strokeWidth={2} />
        <h3>{m.title}</h3>
        <span className="spacer" />
        {onSettings && <button type="button" onClick={onSettings}>Réglages</button>}
      </div>
      {m.usedKB !== null && m.highKB !== null && (
        <>
          <div className="mono antigel-mem" data-testid="antigel-mem">
            {formatKB(m.usedKB)} / {formatKB(m.highKB)}
            {m.maxKB !== null && <small> · arrêt au-delà de {formatKB(m.maxKB)}</small>}
          </div>
          <div className="bar"><i className={`tone-${cardTone(m.fillPercent ?? 0)}`} style={{ width: `${m.fillPercent ?? 0}%` }} /></div>
        </>
      )}
      {m.lines.map((l) => <p key={l} className="sub">{l}</p>)}
      {m.late.map((l) => <p key={l.text} className="sub antigel-late" title={l.hint} data-testid="antigel-late">{l.text}</p>)}
    </section>
  );
}
