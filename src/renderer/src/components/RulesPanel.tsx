import { APP_DISPLAY_NAME } from '../../../core/appName';
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence } from 'motion/react';
import { Bot, ChevronDown, FlaskConical, LayoutTemplate, Pencil, Plus, ShieldAlert, Trash2, TriangleAlert } from 'lucide-react';
import { CATEGORIES } from '../../../core/classify/categories';
import { MAX_RULES, OPT_IN_APPS, RULE_TEMPLATES } from '../../../core/rules/config';
import type { Rule, RuleIssue, RuleStats } from '../../../core/rules/types';
import type { Config } from '../../../core/types';
import { CATEGORY_META } from '../categories';
import { pollWhileLive } from '../history';
import {
  formToRule, newRuleFrom, ruleSummary, ruleToForm, statsLabel, withRule, withRuleEnabled, withRuleMode, withRulesEnabled, withoutRule,
  type RuleErrors, type RuleForm,
} from '../rulesForm';
import type { FormState } from '../settingsNav';
import { ipcErrorMessage } from '../viewModel';
import { SettingsConfirm } from './SettingsConfirm';
import { Card, Row, SaveBar, Switch } from './settingsUi';
import '../rules.css';

interface Props {
  config: Config;
  /** Règles du fichier refusées par la validation (ignorées seules). */
  issues: RuleIssue[];
  /** La config a été enregistrée côté main : le parent la recharge. */
  onSaved: () => void;
  onFormState?: (s: FormState) => void;
}

const KINDS: [RuleForm['kind'], string][] = [['memory', 'Mémoire'], ['inactive', 'Inactivité'], ['forecast', 'Prévision']];
const STATS_EVERY_MS = 60_000;

/** Champ texte (nombre décimal à virgule possible) suivi de son unité. */
function TextField({ id, value, onChange, unit, ariaLabel, invalid, testid, wide }: {
  id: string; value: string; onChange: (v: string) => void; unit?: string; ariaLabel: string; invalid?: boolean; testid?: string; wide?: boolean;
}) {
  return (
    <>
      <input
        id={id}
        className={wide ? 'rule-text wide' : 'rule-text'}
        inputMode={wide ? 'text' : 'decimal'}
        value={value}
        aria-label={ariaLabel}
        aria-invalid={!!invalid}
        data-testid={testid}
        onChange={(e) => onChange(e.target.value)}
      />
      {unit && <span className="s-unit">{unit}</span>}
    </>
  );
}

/** Boutons à bascule (plusieurs choix) : catégories, applis. */
function Toggles<T extends string>({ items, selected, onChange, label, testid }: {
  items: { value: T; label: string; color?: string }[]; selected: readonly T[]; onChange: (v: T[]) => void; label: string; testid?: string;
}) {
  return (
    <div className="rule-toggles" role="group" aria-label={label} data-testid={testid}>
      {items.map((it) => {
        const on = selected.includes(it.value);
        return (
          <button
            key={it.value}
            type="button"
            aria-pressed={on}
            className={on ? 'on' : ''}
            style={it.color ? ({ '--cat': it.color } as CSSProperties) : undefined}
            onClick={() => onChange(on ? selected.filter((x) => x !== it.value) : [...selected, it.value])}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Réglages › Règles : interrupteur général, liste (activée, mode, résumé, dernier déclenchement, compte sur 7 j),
 * modèles, éditeur par champs (aucun texte interprété). Simulation → Active seulement après confirmation.
 */
export function RulesPanel({ config, issues, onSaved, onFormState }: Props) {
  const rules = config.rules;
  const [stats, setStats] = useState<Record<string, RuleStats>>({});
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    const load = () =>
      window.procWatch.rules.stats().then(
        (s) => {
          if (alive) {
            setStats(s);
            setNow(Date.now());
          }
        },
        () => {},
      );
    const stop = pollWhileLive(() => void load(), STATS_EVERY_MS);
    return () => {
      alive = false;
      stop();
    };
  }, []);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (next: Config): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      await window.procWatch.setConfig(next);
      setError(null);
      onSaved();
      return true;
    } catch (e) {
      // refus du main (nouvelle règle active, règle invalide…) : affiché tel quel
      setError(ipcErrorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const [draft, setDraft] = useState<{ rule: Rule; form: RuleForm; isNew: boolean } | null>(null);
  const [errors, setErrors] = useState<RuleErrors>({});
  const [confirmActive, setConfirmActive] = useState<Rule | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Rule | null>(null);
  const [tplOpen, setTplOpen] = useState(false);
  const tplRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tplOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !tplRef.current?.contains(e.target as Node)) setTplOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [tplOpen]);

  const ids = useMemo(() => new Set(rules.list.map((r) => r.id)), [rules.list]);
  const full = rules.list.length >= MAX_RULES;
  const parsed = draft ? formToRule(draft.form, draft.rule) : null;
  const dirty = !!draft && (draft.isNew || JSON.stringify(draft.form) !== JSON.stringify(ruleToForm(draft.rule)));
  const invalid = !!parsed && Object.keys(parsed.errors).length > 0;
  useEffect(() => onFormState?.({ dirty, invalid }), [dirty, invalid, onFormState]);
  const backToSim = !!draft && !!parsed?.rule && draft.rule.mode === 'active' && JSON.stringify(parsed.rule.condition) !== JSON.stringify(draft.rule.condition);

  const edit = (rule: Rule, isNew = false) => {
    setDraft({ rule, form: ruleToForm(rule), isNew });
    setErrors({});
    setError(null);
  };
  const setForm = (patch: Partial<RuleForm>) => {
    setDraft((d) => (d ? { ...d, form: { ...d.form, ...patch } } : d));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch) as (keyof RuleForm)[]) delete next[k];
      return next;
    });
  };
  const saveDraft = async () => {
    if (!draft) return;
    const r = formToRule(draft.form, draft.rule);
    setErrors(r.errors);
    if (!r.rule) return;
    if (await save(withRule(config, r.rule))) setDraft(null);
  };
  const addTemplate = async (t: (typeof RULE_TEMPLATES)[number]) => {
    setTplOpen(false);
    await save(withRule(config, newRuleFrom(t, ids, Date.now())));
  };

  const nameId = useId();
  const f = draft?.form;
  // erreurs en direct (le bouton Enregistrer reste désactivé tant qu'il y en a), plus celles du dernier essai
  const err: RuleErrors = { ...errors, ...(parsed?.errors ?? {}) };

  return (
    <div className="s-stack rules-panel">
      <Card title="Règles automatiques" icon={<Bot size={14} strokeWidth={2} />}>
        <p className="rules-warning" data-testid="rules-warning">
          <ShieldAlert size={15} strokeWidth={2} aria-hidden />
          <span>
            Les règles tournent dans le service d'enregistrement, même app fermée. Jamais les programmes protégés ni Claude, Warp, les
            shells, le bureau, systemd et {APP_DISPLAY_NAME}. 10 actions par heure au plus.
          </span>
        </p>
        <Row label="Règles automatiques" help="Éteint : rien ne tourne, pas même les simulations. Chaque nouvelle règle démarre en Simulation (journal « aurait arrêté… », aucun signal).">
          {(id) => (
            <span data-testid="rules-master">
              <Switch id={id} checked={rules.enabled} label="Règles automatiques" disabled={busy} onToggle={() => void save(withRulesEnabled(config, !rules.enabled))} />
            </span>
          )}
        </Row>
      </Card>

      {error && (
        <div className="warning" role="alert" data-testid="rules-error">
          <TriangleAlert size={15} strokeWidth={2.2} />
          <span>{error}</span>
        </div>
      )}
      {issues.length > 0 && (
        <div className="warning" data-testid="rules-issues">
          <TriangleAlert size={15} strokeWidth={2.2} />
          <div>
            {issues.map((i) => (
              <p key={`${i.index}-${i.id}`} className="rules-issue">
                {i.index < 0 ? i.error : `Règle ${i.name ? `« ${i.name} »` : `n° ${i.index + 1}`} ignorée (désactivée) : ${i.error}.`}
              </p>
            ))}
            <p className="rules-issue muted">Modifiée à la main dans config.json ; elle sera retirée du fichier au prochain enregistrement des réglages.</p>
          </div>
        </div>
      )}

      <Card title={<>Règles<span className="cat-count">{rules.list.length}/{MAX_RULES}</span></>}>
        {rules.list.length === 0 ? (
          <p className="hint" style={{ margin: 0 }} data-testid="rules-empty">Aucune règle. Ajoute-en une, ou pars d'un modèle.</p>
        ) : (
          <ul className="rules-list" data-testid="rules-list">
            {rules.list.map((r) => (
              <li key={r.id} data-testid="rule-row" className={r.enabled ? '' : 'off'}>
                <Switch checked={r.enabled} label={`Activer « ${r.name} »`} disabled={busy} onToggle={() => void save(withRuleEnabled(config, r.id, !r.enabled))} />
                <button
                  type="button"
                  className={`rule-mode ${r.mode}`}
                  data-testid={`rule-mode-${r.id}`}
                  disabled={busy}
                  title={r.mode === 'simulate' ? 'Passer en Active (confirmation demandée)' : 'Repasser en Simulation'}
                  onClick={() => (r.mode === 'simulate' ? setConfirmActive(r) : void save(withRuleMode(config, r.id, 'simulate')))}
                >
                  {r.mode === 'simulate' ? <FlaskConical size={12} strokeWidth={2.2} /> : <Bot size={12} strokeWidth={2.2} />}
                  {r.mode === 'simulate' ? 'Simulation' : 'Active'}
                </button>
                <div className="rule-text-col">
                  <strong className="rule-name">{r.name}</strong>
                  <span className="rule-summary">{ruleSummary(r)}</span>
                  <span className="rule-stats" data-testid="rule-stats">{statsLabel(stats[r.id], now)}</span>
                </div>
                <div className="rule-actions">
                  <button className="icon-btn sm" title="Modifier" aria-label={`Modifier « ${r.name} »`} onClick={() => edit(r)}>
                    <Pencil size={13} strokeWidth={2.2} />
                  </button>
                  <button className="icon-btn sm" title="Supprimer" aria-label={`Supprimer « ${r.name} »`} onClick={() => setConfirmDelete(r)}>
                    <Trash2 size={13} strokeWidth={2.2} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="s-foot">
          {full && <span className="hint">Au plus {MAX_RULES} règles.</span>}
          <div className="rules-tpl" ref={tplRef}>
            <button type="button" data-testid="rules-templates" disabled={full || busy} aria-haspopup="menu" aria-expanded={tplOpen} onClick={() => setTplOpen((o) => !o)}>
              <LayoutTemplate size={13} strokeWidth={2.2} />
              Modèles
              <ChevronDown size={13} strokeWidth={2.2} />
            </button>
            {tplOpen && (
              <div className="rules-tpl-menu" role="menu">
                {RULE_TEMPLATES.map((t) => (
                  <button key={t.name} type="button" role="menuitem" data-testid="rules-template" onClick={() => void addTemplate(t)}>
                    <strong>{t.name}</strong>
                    <span>{ruleSummary({ ...t, id: 'x', createdAt: 0 })}</span>
                  </button>
                ))}
                <p className="hint">Ajoutée désactivée, en Simulation.</p>
              </div>
            )}
          </div>
          <button className="primary" data-testid="rules-add" disabled={full || busy} onClick={() => edit(newRuleFrom(null, ids, Date.now()), true)}>
            <Plus size={13} strokeWidth={2.4} />
            Ajouter
          </button>
        </div>
      </Card>

      {draft && f && (
        <Card title={draft.isNew ? 'Nouvelle règle' : `Modifier « ${draft.rule.name} »`} icon={<Pencil size={14} strokeWidth={2} />} testid="rule-editor">
          <Row label="Nom" error={err.name}>
            {() => <TextField id={nameId} wide value={f.name} ariaLabel="Nom de la règle" invalid={!!err.name} testid="rule-name" onChange={(v) => setForm({ name: v })} />}
          </Row>
          <Row label="Condition">
            {() => (
              <div className="range-selector" role="radiogroup" aria-label="Condition" data-testid="rule-kind">
                {KINDS.map(([k, label]) => (
                  <button key={k} type="button" role="radio" aria-checked={f.kind === k} className={f.kind === k ? 'active' : ''} onClick={() => setForm({ kind: k })}>
                    {f.kind === k && <span className="range-indicator" />}
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            )}
          </Row>
          {f.kind === 'memory' && (
            <>
              <Row label="Cible" help={f.target === 'instance' ? 'Les processus de l’instance (serveur de dev, tests…).' : 'Tous les processus du groupe, moins les garde-fous.'}>
                {(id) => (
                  <select id={id} value={f.target} onChange={(e) => setForm({ target: e.target.value as RuleForm['target'] })} data-testid="rule-target">
                    <option value="instance">Instance</option>
                    <option value="group">Groupe</option>
                  </select>
                )}
              </Row>
              <Row label="Reconnue par">
                {(id) => (
                  <select id={id} value={f.matchBy} onChange={(e) => setForm({ matchBy: e.target.value as RuleForm['matchBy'] })} data-testid="rule-match-by">
                    <option value="name">Nom</option>
                    <option value="category">Catégorie</option>
                  </select>
                )}
              </Row>
              {f.matchBy === 'name' ? (
                <Row label="Nom" error={err.matchValue} help="Comparé tel quel, sans tenir compte des majuscules (jamais une expression régulière).">
                  {(id) => <TextField id={id} wide value={f.matchValue} ariaLabel="Nom à comparer" invalid={!!err.matchValue} testid="rule-match-value" onChange={(v) => setForm({ matchValue: v })} />}
                </Row>
              ) : (
                <Row label="Catégorie">
                  {(id) => (
                    <select id={id} value={f.matchCategory} onChange={(e) => setForm({ matchCategory: e.target.value as RuleForm['matchCategory'] })} data-testid="rule-match-category">
                      {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_META[c].label}</option>)}
                    </select>
                  )}
                </Row>
              )}
              <Row label="Au-dessus de" error={err.overGB} help="RAM + swap.">
                {(id) => <TextField id={id} value={f.overGB} unit="Go" ariaLabel="Seuil mémoire" invalid={!!err.overGB} testid="rule-over" onChange={(v) => setForm({ overGB: v })} />}
              </Row>
              <Row label="Pendant" error={err.forMin}>
                {(id) => <TextField id={id} value={f.forMin} unit="min" ariaLabel="Durée" invalid={!!err.forMin} testid="rule-for-min" onChange={(v) => setForm({ forMin: v })} />}
              </Row>
            </>
          )}
          {f.kind === 'inactive' && (
            <>
              <Row label="Catégories" error={err.categories} help="Instances de projets seulement (jamais une appli ni Claude) ; aucune mesure de CPU ≥ 1 % sur la période.">
                {() => (
                  <Toggles
                    label="Catégories"
                    testid="rule-categories"
                    items={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_META[c].label, color: CATEGORY_META[c].color }))}
                    selected={f.categories}
                    onChange={(categories) => setForm({ categories })}
                  />
                )}
              </Row>
              <Row label="Inactive depuis" error={err.forHours} help="Sans historique couvrant toute la période (service récent, trou d’enregistrement), rien n’est arrêté.">
                {(id) => <TextField id={id} value={f.forHours} unit="h" ariaLabel="Durée d’inactivité" invalid={!!err.forHours} testid="rule-for-hours" onChange={(v) => setForm({ forHours: v })} />}
              </Row>
            </>
          )}
          {f.kind === 'forecast' && (
            <>
              <Row label="Épuisement prévu dans moins de" error={err.underMin} help="Prévision de l’alerte « Mémoire bientôt épuisée », confirmée depuis 30 s. Cible : le plus gros groupe qui grossit sur 5 min.">
                {(id) => <TextField id={id} value={f.underMin} unit="min" ariaLabel="Délai" invalid={!!err.underMin} testid="rule-under-min" onChange={(v) => setForm({ underMin: v })} />}
              </Row>
              <Row label="Applis visables" help="Par défaut aucune appli (navigateur, éditeur…) : seulement les projets et les commandes. Jamais Claude.">
                {() => (
                  <Toggles label="Applis visables" testid="rule-apps" items={OPT_IN_APPS.map((a) => ({ value: a, label: a }))} selected={f.includeApps} onChange={(includeApps) => setForm({ includeApps })} />
                )}
              </Row>
            </>
          )}
          <SaveBar dirty={dirty} disabled={busy || invalid} onSave={() => void saveDraft()} testid="rule-save">
            {backToSim && <span className="hint s-foot-note">Condition modifiée : la règle repassera en Simulation.</span>}
            <button type="button" onClick={() => setDraft(null)} data-testid="rule-cancel">Annuler</button>
          </SaveBar>
        </Card>
      )}

      <AnimatePresence>
        {confirmActive && (
          <SettingsConfirm
            key="active"
            id="rule-active-title"
            title={`Passer « ${confirmActive.name} » en Active ?`}
            text="Cette règle pourra arrêter des processus sans confirmation : SIGTERM, puis SIGKILL 5 s plus tard s'ils sont toujours là. Les garde-fous restent appliqués."
            confirmLabel="Passer en Active"
            focusCancel
            icon={<Bot size={17} strokeWidth={2} />}
            onCancel={() => setConfirmActive(null)}
            onConfirm={() => {
              const r = confirmActive;
              setConfirmActive(null);
              void save(withRuleMode(config, r.id, 'active'));
            }}
          >
            <p className="rule-confirm-summary">{ruleSummary(confirmActive)}</p>
          </SettingsConfirm>
        )}
        {confirmDelete && (
          <SettingsConfirm
            key="delete"
            id="rule-delete-title"
            title={`Supprimer « ${confirmDelete.name} » ?`}
            text="Son journal reste dans l'historique (Alertes)."
            confirmLabel="Supprimer"
            onCancel={() => setConfirmDelete(null)}
            onConfirm={() => {
              const r = confirmDelete;
              setConfirmDelete(null);
              if (draft?.rule.id === r.id) setDraft(null);
              void save(withoutRule(config, r.id));
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
