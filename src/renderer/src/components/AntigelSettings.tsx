import { useEffect, useState } from 'react';
import { Snowflake, Trash2 } from 'lucide-react';
import type { Config } from '../../../core/types';
import { deskLine } from '../antigelDesk';
import { DEFAULT_BUDGET_MB } from '../../../core/antigel/config';
import { antigelStatusLine, budgetEffect, budgetEffectLine, budgetLabel, budgetRows, budgetUsage, formatGo, formatGoInput, reserveHint, validateBudget, validateReserve, withBudget, withNoBudget } from '../antigel';
import { useAntigel } from '../useAntigel';
import { DeskRootRow, useDeskRoot } from './DeskRoot';
import { Card, Row, SaveBar, Switch } from './settingsUi';

/** Réglages → Plafond de travail : interrupteur (allumé par défaut), réserve pour le bureau, budget par défaut, budgets par projet. */
export function AntigelSettingsCard({ config, onSave }: { config: Config; onSave: (c: Config) => void }) {
  const view = useAntigel();
  const root = useDeskRoot();
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
  const deskText = ag.enabled && view?.fresh && view.state?.status === 'active' ? deskLine(view.state.desk, root) : null;
  // budget par défaut de chaque projet : null = aucun ; le champ garde la dernière valeur (ou 5 Go) quand il est éteint
  const def = ag.defaultBudgetMB ?? null;
  const defSaved = formatGoInput(def ?? DEFAULT_BUDGET_MB);
  const [defText, setDefText] = useState(defSaved);
  useEffect(() => setDefText(defSaved), [defSaved]);
  const dv = validateBudget(defText);
  const defDirty = def !== null && defText.trim() !== defSaved;
  const saveDef = () => {
    if (def !== null && dv.ok) onSave({ ...config, antigel: { ...ag, defaultBudgetMB: dv.mb } });
  };
  const toggleDef = () => onSave({ ...config, antigel: { ...ag, defaultBudgetMB: def === null ? (dv.ok ? dv.mb : DEFAULT_BUDGET_MB) : null } });
  const budgets = budgetRows(ag, view);
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
      <DeskRootRow disabled={!ag.enabled || ag.desk === false} />
      <Row label="Réserve pour le bureau" error={v.ok ? null : v.error} help={reserveHint(memTotalKB)}>
        {(id) => (
          <input id={id} data-testid="antigel-reserve" inputMode="decimal" placeholder="automatique" value={text}
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
        )}
      </Row>
      <SaveBar dirty={dirty} disabled={!v.ok || !dirty} onSave={save} testid="antigel-save" />
      <Row label="Budget par défaut de chaque projet" error={def !== null && !dv.ok ? dv.error : null}
        help="Budget mémoire de chaque projet capturé qui n’a pas le sien (mêmes plafonds de sa slice de projet qu’un budget posé à la main : freinage, part de swap, plafond dur) ; jamais pour les vérifications hors projet. Un budget posé sur un projet l’emporte ; « Sans budget » en exclut un projet. Éteint : aucun budget par défaut.">
        {(id) => (
          <span className="antigel-default-budget">
            <Switch checked={def !== null} label="Budget par défaut de chaque projet" disabled={!ag.enabled} onToggle={toggleDef} />
            <input id={id} data-testid="antigel-default-budget" inputMode="decimal" value={defText} disabled={def === null} aria-label="Budget par défaut, en Go"
              onChange={(e) => setDefText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveDef(); }} />
            <span className="sub">Go</span>
          </span>
        )}
      </Row>
      {def !== null && <p className="sub antigel-budget-effect" data-testid="antigel-default-effect">{budgetEffectLine(dv.ok ? dv.mb : def, true)}</p>}
      <SaveBar dirty={defDirty} disabled={!dv.ok || !defDirty} onSave={saveDef} testid="antigel-default-save" />
      <h4 className="antigel-budgets-title">Budgets par projet</h4>
      {budgets.length === 0 ? (
        <p className="sub">Aucun budget propre à un projet. Pour en poser un : onglet Processus, ouvrir un projet, puis « Budget mémoire… ».</p>
      ) : (
        <ul className="antigel-budgets">
          {budgets.map(({ root, mb, source }) => {
            const use = budgetUsage(view, root);
            const excluded = ag.noBudget?.includes(root) ?? false;
            return (
              <li key={root} data-testid="antigel-budget-row" data-root={root} data-source={source}>
                <span className="mono" title={root}>{budgetLabel(root)}</span>
                <span className="mono" title={mb === null ? undefined : budgetEffect(mb)}>
                  {mb === null ? 'sans budget' : formatGo(mb)}
                  {source === 'default' && <small className="sub"> (par défaut)</small>}
                </span>
                {source === 'explicit' ? (
                  <button type="button" title={def === null || excluded ? 'Le projet n’aura plus de budget' : `Le projet reprendra le budget par défaut (${formatGo(def)})`}
                    onClick={() => onSave({ ...config, antigel: { ...ag, budgets: withBudget(ag.budgets, root, null) } })}>
                    <Trash2 size={13} strokeWidth={2} /> Retirer
                  </button>
                ) : source === 'default' ? (
                  <button type="button" title="Ce projet n’aura aucun budget, même avec le budget par défaut" onClick={() => onSave({ ...config, antigel: withNoBudget(ag, root, true) })}>
                    Sans budget
                  </button>
                ) : excluded ? (
                  <button type="button" title="Ce projet reprend le budget par défaut" onClick={() => onSave({ ...config, antigel: withNoBudget(ag, root, false) })}>
                    Budget par défaut
                  </button>
                ) : <span />}
                {use && <small className="sub antigel-budget-use" title={use.hint ?? undefined} data-testid="antigel-budget-use">{use.text}</small>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
