import { useEffect, useState } from 'react';
import { Snowflake, Trash2 } from 'lucide-react';
import type { Config } from '../../../core/types';
import { deskLine } from '../antigelDesk';
import { antigelStatusLine, budgetLabel, formatGo, formatGoInput, reserveHint, validateReserve, withBudget } from '../antigel';
import { useAntigel } from '../useAntigel';
import { Card, Row, SaveBar, Switch } from './settingsUi';

/** Réglages → Plafond de travail : interrupteur (allumé par défaut), réserve pour le bureau, budgets par projet. */
export function AntigelSettingsCard({ config, onSave }: { config: Config; onSave: (c: Config) => void }) {
  const view = useAntigel();
  const ag = config.antigel;
  const saved = ag.reserveMB === null ? '' : formatGoInput(ag.reserveMB);
  const [text, setText] = useState(saved);
  useEffect(() => setText(saved), [saved]);
  const memTotalKB = view?.state?.memTotalKB || null;
  const v = validateReserve(text, memTotalKB);
  const dirty = text.trim() !== saved;
  const save = () => {
    if (v.ok) onSave({ ...config, antigel: { ...ag, reserveMB: v.mb } });
  };
  const deskText = ag.enabled && view?.fresh && view.state?.status === 'active' ? deskLine(view.state.desk) : null;
  const budgets = Object.entries(ag.budgets).sort(([a], [b]) => a.localeCompare(b));
  return (
    <Card title="Plafond de travail" icon={<Snowflake size={14} strokeWidth={2} />} testid="antigel-settings">
      <p className="sub" data-testid="antigel-settings-status">{antigelStatusLine(view, ag.enabled)}</p>
      <Row label="Plafonner le travail" help="Tests, compilations et serveurs lancés depuis un terminal, un éditeur ou Claude passent dans une slice systemd dont la somme est plafonnée ; le bureau, les terminaux et Claude gardent leur réserve. Éteint : plus aucun déplacement, plafonds levés.">
        {(id) => <Switch id={id} checked={ag.enabled} label="Plafond de travail" onToggle={() => onSave({ ...config, antigel: { ...ag, enabled: !ag.enabled } })} />}
      </Row>
      <Row label="Bureau prioritaire" help="Le bureau, les terminaux et Claude passent avant le travail plafonné quand le processeur sature (poids CPU), et leur mémoire est protégée quand le système le permet. Réglages de la session seulement, jamais permanents ; éteint : valeurs d’origine remises.">
        {(id) => (
          <Switch id={id} checked={ag.desk !== false} disabled={!ag.enabled} label="Bureau prioritaire"
            onToggle={() => onSave({ ...config, antigel: { ...ag, desk: ag.desk === false } })} />
        )}
      </Row>
      {deskText && <p className="sub" data-testid="antigel-desk-status">{deskText}</p>}
      <Row label="Réserve pour le bureau" error={v.ok ? null : v.error} help={reserveHint(memTotalKB)}>
        {(id) => (
          <input id={id} data-testid="antigel-reserve" inputMode="decimal" placeholder="automatique" value={text}
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
        )}
      </Row>
      <SaveBar dirty={dirty} disabled={!v.ok || !dirty} onSave={save} testid="antigel-save" />
      <h4 className="antigel-budgets-title">Budgets par projet</h4>
      {budgets.length === 0 ? (
        <p className="sub">Aucun budget. Pour en poser un : onglet Processus, ouvrir un projet, puis « Budget mémoire… ».</p>
      ) : (
        <ul className="antigel-budgets">
          {budgets.map(([root, mb]) => (
            <li key={root} data-testid="antigel-budget-row" data-root={root}>
              <span className="mono" title={root}>{budgetLabel(root)}</span>
              <span className="mono">{formatGo(mb)}</span>
              <button type="button" onClick={() => onSave({ ...config, antigel: { ...ag, budgets: withBudget(ag.budgets, root, null) } })}>
                <Trash2 size={13} strokeWidth={2} /> Retirer
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
