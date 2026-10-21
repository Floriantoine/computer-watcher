import { Snowflake } from 'lucide-react';
import type { AntigelView } from '../../../core/antigel/state';
import { antigelCard } from '../antigel';
import { cardTone } from '../theme';

/** Métriques : travail et marge avant ralentissement (plafond dynamique), ce qui freine, budgets des projets en cours. */
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
      {m.usedKB !== null && m.highKB !== null && m.memLine !== null && (
        <>
          <div className="mono antigel-mem" data-testid="antigel-mem" title={m.memHint ?? undefined}>{m.memLine}</div>
          <div className="bar"><i className={`tone-${cardTone(m.fillPercent ?? 0)}`} style={{ width: `${m.fillPercent ?? 0}%` }} /></div>
        </>
      )}
      {m.lines.map((l) => <p key={l} className="sub">{l}</p>)}
      {/* une ligne de budget qui porte la mention hors budget garde le data-testid « antigel-late » du lot précédent */}
      {m.budgets.map((b) => (
        <p key={b.text} className={`sub antigel-budget-line${b.throttled ? ' throttled' : ''}${b.hint ? ' antigel-late' : ''}`} title={b.hint ?? undefined}
          data-testid={b.hint ? 'antigel-late' : 'antigel-budget-line'}>{b.text}</p>
      ))}
      {m.late.map((l) => <p key={l.text} className="sub antigel-late" title={l.hint} data-testid="antigel-late">{l.text}</p>)}
    </section>
  );
}
