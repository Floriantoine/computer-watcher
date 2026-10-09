import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence } from 'motion/react';
import {
  AppWindow,
  ArrowLeft,
  BellRing,
  Bot,
  Clock,
  HardDrive,
  Info,
  Layers,
  ShieldCheck,
  Sparkles,
  Tags,
  TrendingUp,
  TriangleAlert,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { DEFAULT_CONFIG } from '../../../core/defaults';
import type { Config, ConfigState, MemoryMetric, RecorderState } from '../../../core/types';
import { CATEGORY_META } from '../categories';
import { overrideRows, withDetectPorts, withoutOverride } from '../classifySettings';
import { AlertsSettings } from './AlertsSettings';
import { formatKB } from '../format';
import { pollWhileLive } from '../history';
import { EarlyoomPanel, type EarlyoomAttention } from './EarlyoomPanel';
import { RulesPanel } from './RulesPanel';
import { SettingsConfirm } from './SettingsConfirm';
import { AboutSetup, AutostartRow } from './AppSetup';
import { AboutPanel } from './UpdatePopup';
import { Card, NumberField, Row, SaveBar, Switch } from './settingsUi';
import { recorderToForm, validateRecorderForm, type RecorderErrors, type RecorderForm } from '../recorderForm';
import {
  SETTINGS_SECTIONS,
  initialSection,
  numbersDirty,
  readStoredSection,
  sectionAttention,
  sectionByKey,
  writeStoredSection,
  type FormState,
  type SettingsSection,
} from '../settingsNav';
import type { RecorderNumField } from '../../../core/recorderBounds';

interface Props {
  state: ConfigState;
  onSave: (c: Config) => void;
  onBack: () => void;
  onInstallDesktop: () => void;
  onToast: (message: string, kind?: 'error' | 'info') => void;
  /** La config a été modifiée côté main (interrupteur) : le parent la recharge. */
  onConfigChanged: () => void;
  /** Réglages › À propos › « Relancer l'accueil ». */
  onReopenOnboarding: () => void;
  /** Lien profond : section demandée par la route (nouvel objet à chaque navigation). */
  request?: { section?: SettingsSection };
}

const MEM_METRICS: [MemoryMetric, string][] = [['rss', 'RSS (rapide)'], ['pss', 'PSS (précis)']];

const ICONS: Record<SettingsSection, LucideIcon> = {
  protected: ShieldCheck,
  others: Layers,
  display: Sparkles,
  classify: Tags,
  alerts: BellRing,
  rules: Bot,
  recorder: HardDrive,
  earlyoom: Wrench,
  desktop: AppWindow,
  about: Info,
};

type RecField = { f: RecorderNumField; label: string; short: string; unit: string; step?: string; help?: string };
const REC_GROUPS: { title: string; icon: LucideIcon; help?: string; fields: RecField[] }[] = [
  {
    title: 'Intervalle et rétention',
    icon: Clock,
    fields: [
      { f: 'intervalSec', label: 'Intervalle', short: 'Intervalle', unit: 's', help: 'Une mesure toutes les n secondes.' },
      { f: 'detailHours', label: 'Rétention détaillée', short: 'Rétention détaillée', unit: 'h', help: 'Chaque mesure, processus compris.' },
      { f: 'summaryDays', label: 'Rétention résumée', short: 'Rétention résumée', unit: 'j', help: 'Moyennes par minute et par heure, événements.' },
    ],
  },
  {
    title: 'Seuils',
    icon: Layers,
    fields: [
      { f: 'procMinMemMB', label: 'Seuil mémoire processus', short: 'Mémoire d’un processus', unit: 'Mo' },
      { f: 'procMinCpuPercent', label: 'Seuil CPU processus', short: 'CPU d’un processus', unit: '%', step: '0.5' },
      { f: 'groupMinMemMB', label: 'Seuil mémoire groupe', short: 'Mémoire d’un groupe', unit: 'Mo', help: 'Groupes plus petits cumulés dans «\u00a0Petits groupes\u00a0».' },
      { f: 'tmpfsAlertMB', label: 'Alerte fichiers en mémoire (/tmp, shm)', short: 'Alerte /tmp, shm', unit: 'Mo', help: 'Fichiers en mémoire (Shmem) au-delà de ce seuil.' },
    ],
  },
  {
    title: 'Fuites',
    icon: TrendingUp,
    help: 'Alerte quand la mémoire d’un groupe monte d’au moins la hausse pendant la durée.',
    fields: [
      { f: 'leakMinMinutes', label: 'Fuite : durée', short: 'Durée', unit: 'min' },
      { f: 'leakMinGrowthMB', label: 'Fuite : hausse', short: 'Hausse', unit: 'Mo' },
    ],
  },
];

const CALM: FormState = { dirty: false, invalid: false };

export function SettingsView({ state, onSave, onBack, onInstallDesktop, onToast, onConfigChanged, onReopenOnboarding, request }: Props) {
  const { config, warning, invalid } = state;
  const [section, setSection] = useState<SettingsSection>(() => initialSection(request?.section, readStoredSection()));
  const select = useCallback((s: SettingsSection) => {
    setSection(s);
    writeStoredSection(s);
  }, []);
  // Lien profond alors que les Réglages sont déjà ouverts : la route change d'objet, la section suit.
  useEffect(() => {
    if (request?.section) select(request.section);
  }, [request, select]);

  const [entry, setEntry] = useState('');
  const [memMB, setMemMB] = useState(String(config.othersThreshold.memMB));
  const [cpu, setCpu] = useState(String(config.othersThreshold.cpuPercent));

  const [rec, setRec] = useState<RecorderState | null>(null);
  const [form, setForm] = useState<RecorderForm>(() => recorderToForm(config.recorder));
  const [errors, setErrors] = useState<RecorderErrors>({});
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmOverrides, setConfirmOverrides] = useState(false);
  const overrides = overrideRows(config.classify.overrides);
  const [now, setNow] = useState(() => Date.now());
  const [alertsForm, setAlertsForm] = useState<FormState>(CALM);
  const [rulesForm, setRulesForm] = useState<FormState>(CALM);
  const ruleIssues = state.ruleIssues ?? [];
  const [eo, setEo] = useState<EarlyoomAttention>({ ...CALM, status: null });
  /** Zone de notification présente sur ce bureau ? null tant que la réponse n'est pas arrivée. */
  const [trayOk, setTrayOk] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    window.procWatch.tray.available().then(
      (ok) => alive && setTrayOk(ok),
      () => alive && setTrayOk(false),
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      window.procWatch.recorder.status().then(
        (r) => {
          if (alive) {
            setRec(r);
            setNow(Date.now());
          }
        },
        () => {},
      );
    // fenêtre réduite ou cachée dans la barre des tâches : pas de sondage
    const stop = pollWhileLive(() => void load(), 5000);
    return () => {
      alive = false;
      stop();
    };
  }, []);

  const setField = (f: keyof RecorderForm, v: string) => {
    setForm((x) => ({ ...x, [f]: v }));
    setErrors((e) => ({ ...e, [f]: undefined }));
  };
  const saveRecorder = () => {
    const r = validateRecorderForm(form, config.recorder.enabled);
    setErrors(r.errors);
    if (r.value) onSave({ ...config, recorder: r.value });
  };
  const toggleRecorder = async () => {
    if (busy || !rec) return;
    setBusy(true);
    try {
      setRec(await window.procWatch.recorder.setEnabled(!rec.enabled));
      onConfigChanged();
    } catch (e) {
      onToast(`Enregistrement non modifié : ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const clearHistory = async () => {
    setConfirmClear(false);
    try {
      const r = await window.procWatch.recorder.clearHistory();
      const copies = r.backups ? ` et ${r.backups} copie${r.backups > 1 ? 's' : ''} de sécurité supprimée${r.backups > 1 ? 's' : ''}` : '';
      onToast(
        r.mode === 'deleted'
          ? `Historique supprimé${copies} ; une base neuve sera créée au prochain démarrage du service`
          : `Vidage demandé au service : effectif d'ici une minute${copies}`,
        'info',
      );
    } catch (e) {
      onToast(`Historique non vidé : ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const st = rec?.status ?? null;
  const tone = !rec ? 'off' : rec.running ? 'ok' : rec.enabled ? 'warn' : 'off';
  const toneLabel = !rec ? 'Chargement…' : rec.running ? 'Actif' : rec.enabled ? 'Ne répond pas' : 'Désactivé';
  const ago = st?.lastSampleAt ? Math.max(0, Math.round((now - st.lastSampleAt) / 1000)) : null;
  const jobErrors = Object.entries(st?.jobErrors ?? {}).filter(([, v]) => v) as [string, string][];

  const add = () => {
    const v = entry.trim();
    if (!v || config.protected.includes(v)) return;
    onSave({ ...config, protected: [...config.protected, v] });
    setEntry('');
  };
  const remove = (v: string) => onSave({ ...config, protected: config.protected.filter((x) => x !== v) });
  const othersValid = (s: string) => s.trim() !== '' && Number.isFinite(Number(s)) && Number(s) >= 0;
  const saveThresholds = () => {
    const m = Number(memMB);
    const c = Number(cpu);
    if (memMB.trim() && cpu.trim() && Number.isFinite(m) && m >= 0 && Number.isFinite(c) && c >= 0) onSave({ ...config, othersThreshold: { memMB: m, cpuPercent: c } });
  };

  // État des formulaires (points de la barre et indicateurs « non enregistré »).
  const othersState: FormState = {
    dirty: numbersDirty({ memMB, cpu }, { memMB: config.othersThreshold.memMB, cpu: config.othersThreshold.cpuPercent }),
    invalid: !othersValid(memMB) || !othersValid(cpu),
  };
  const recorderState: FormState = {
    dirty: numbersDirty(form, config.recorder as unknown as Record<string, number>),
    invalid: Object.keys(validateRecorderForm(form, config.recorder.enabled).errors).length > 0,
  };
  const attention = sectionAttention({
    protectedEntry: entry,
    protectedList: config.protected,
    others: othersState,
    alerts: alertsForm,
    recorder: { ...recorderState, status: rec ? { available: rec.available, enabled: rec.enabled, running: rec.running } : null },
    earlyoom: eo,
    rules: { ...rulesForm, issues: ruleIssues.length },
  });

  const tabs = useRef(new Map<SettingsSection, HTMLButtonElement>());
  // Rangée d'onglets défilante (fenêtre étroite) : l'onglet choisi reste visible.
  useEffect(() => {
    if (window.matchMedia?.('(max-width: 900px)').matches) tabs.current.get(section)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [section]);
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, id: SettingsSection) => {
    const next = sectionByKey(id, e.key);
    if (!next) return;
    e.preventDefault();
    tabs.current.get(next)?.focus();
  };
  const [focused, setFocused] = useState<SettingsSection | null>(null);
  // Tabulation itinérante : seul l'onglet sélectionné (ou celui qui a le focus) est atteint par Tab.
  const tabStop = focused ?? section;

  const panel = (id: SettingsSection, testid: string | undefined, body: ReactNode) => {
    const meta = SETTINGS_SECTIONS.find((s) => s.id === id)!;
    const Icon = ICONS[id];
    return (
      <div
        key={id}
        role="tabpanel"
        id={`settings-panel-${id}`}
        aria-labelledby={`settings-tab-${id}`}
        hidden={section !== id}
        className="settings-panel"
        data-testid={testid}
      >
        <header className="s-head">
          <h3><Icon size={17} strokeWidth={2} />{meta.label}</h3>
          <p>{meta.description}</p>
        </header>
        {body}
      </div>
    );
  };

  return (
    <>
      <div className="page-head">
        <button className="back" title="Retour" aria-label="Retour" onClick={onBack}>
          <ArrowLeft size={16} strokeWidth={2} />
        </button>
        <h2>Réglages</h2>
      </div>
      <div className="settings settings-layout">
        <nav className="settings-nav" aria-label="Sections des réglages">
          <div role="tablist" aria-orientation="vertical" aria-label="Sections des réglages" className="settings-tabs">
            {SETTINGS_SECTIONS.map(({ id, label }) => {
              const Icon = ICONS[id];
              const a = attention[id];
              return (
                <button
                  key={id}
                  ref={(el) => {
                    if (el) tabs.current.set(id, el);
                    else tabs.current.delete(id);
                  }}
                  type="button"
                  role="tab"
                  id={`settings-tab-${id}`}
                  aria-controls={`settings-panel-${id}`}
                  aria-selected={section === id}
                  tabIndex={tabStop === id ? 0 : -1}
                  data-testid={`settings-nav-${id}`}
                  className={section === id ? 'active' : ''}
                  onClick={() => select(id)}
                  onKeyDown={(e) => onTabKey(e, id)}
                  onFocus={() => setFocused(id)}
                  onBlur={() => setFocused(null)}
                  title={a ? a.reasons.join(' · ') : undefined}
                >
                  <Icon size={15} strokeWidth={2} />
                  <span className="s-nav-label">{label}</span>
                  {a && <span className={`s-dot ${a.tone}`} data-testid={`settings-dot-${id}`} aria-label={a.reasons.join(', ')} role="img" />}
                </button>
              );
            })}
          </div>
        </nav>

        <div className="settings-main">
          {warning && (
            <div className="warning">
              <TriangleAlert size={15} strokeWidth={2.2} />
              <span>{warning}</span>
            </div>
          )}

          {panel(
            'protected',
            'protected-panel',
            <Card title="Programmes protégés" icon={<ShieldCheck size={14} strokeWidth={2} />}>
              <p className="hint">
                Nom exact du processus, ou expression régulière entre slashs (ex. <code>/^systemd/</code>). Les tuer demande toujours une
                confirmation. Enregistré dès l'ajout ou le retrait.
              </p>
              <div className="pills">
                {config.protected.length === 0 && <span className="hint" style={{ margin: 0 }}>Aucun programme protégé.</span>}
                {config.protected.map((p) => (
                  <span key={p} className={`pill ${invalid.includes(p) ? 'invalid' : ''}`} title={invalid.includes(p) ? 'Regex invalide, ignorée' : ''}>
                    {p}
                    <button onClick={() => remove(p)} aria-label={`Retirer ${p}`} title={`Retirer ${p}`}>
                      <X size={12} strokeWidth={2.4} />
                    </button>
                  </span>
                ))}
              </div>
              <div className="s-add">
                <input
                  value={entry}
                  placeholder="nom ou /regex/"
                  aria-label="Programme à protéger"
                  data-testid="protected-entry"
                  onChange={(e) => setEntry(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && add()}
                />
                <button className="primary" onClick={add} disabled={!entry.trim()}>Ajouter</button>
              </div>
              <div className="s-foot">
                {attention.protected && (
                  <span className="s-unsaved" role="status">
                    <i aria-hidden />
                    Saisie pas encore ajoutée
                  </span>
                )}
                <button onClick={() => onSave({ ...config, protected: [...DEFAULT_CONFIG.protected] })}>Réinitialiser</button>
              </div>
            </Card>,
          )}

          {panel(
            'others',
            'others-panel',
            <Card title="Seuils de regroupement" icon={<Layers size={14} strokeWidth={2} />}>
              <Row label="Mémoire en dessous de" error={othersValid(memMB) ? null : 'Un nombre ≥ 0 est attendu'}>
                {(id) => <NumberField id={id} value={memMB} unit="Mo" ariaLabel="Mémoire" invalid={!othersValid(memMB)} onChange={setMemMB} onEnter={saveThresholds} />}
              </Row>
              <Row
                label="et CPU en dessous de"
                error={othersValid(cpu) ? null : 'Un nombre ≥ 0 est attendu'}
                help="Les groupes sous ces deux seuils sont rassemblés dans une seule carte."
              >
                {(id) => <NumberField id={id} value={cpu} step="0.5" unit="%" ariaLabel="CPU" invalid={!othersValid(cpu)} onChange={setCpu} onEnter={saveThresholds} />}
              </Row>
              <SaveBar dirty={othersState.dirty} onSave={saveThresholds} testid="others-save" />
            </Card>,
          )}

          {panel(
            'display',
            'effects-panel',
            <Card title="Affichage" icon={<Sparkles size={14} strokeWidth={2} />}>
              <Row label="Mémoire affichée" help="PSS répartit la mémoire partagée entre les processus ; l'historique reste en RSS.">
                {() => (
                  <div className="range-selector mem-metric" role="radiogroup" aria-label="Mémoire affichée" data-testid="mem-metric">
                    {MEM_METRICS.map(([m, label]) => (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={config.ui.memoryMetric === m}
                        data-testid={`mem-metric-${m}`}
                        className={config.ui.memoryMetric === m ? 'active' : ''}
                        onClick={() => config.ui.memoryMetric !== m && onSave({ ...config, ui: { ...config.ui, memoryMetric: m } })}
                      >
                        {config.ui.memoryMetric === m && <span className="range-indicator" />}
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </Row>
              <Row label="Effets visuels réduits" help="Sans flou ni animations superflues : moins de travail pour la carte graphique et le processeur.">
                {(id) => (
                  <Switch
                    id={id}
                    checked={config.ui.reducedEffects}
                    label="Effets visuels réduits"
                    onToggle={() => onSave({ ...config, ui: { ...config.ui, reducedEffects: !config.ui.reducedEffects } })}
                  />
                )}
              </Row>
              <Row label="Icône dans la barre des tâches" help="Anneau de la RAM utilisée, coloré selon la pression ; menu avec la mémoire, « Libérer de la mémoire… » et « Quitter ».">
                {(id) => (
                  <span data-testid="tray-icon">
                    <Switch
                      id={id}
                      checked={config.ui.trayIcon}
                      label="Icône dans la barre des tâches"
                      onToggle={() => onSave({ ...config, ui: { ...config.ui, trayIcon: !config.ui.trayIcon } })}
                    />
                  </span>
                )}
              </Row>
              <Row
                label="Fermer la fenêtre la garde dans la barre des tâches"
                help={
                  trayOk === false
                    ? "Pas de zone de notification sur ce bureau : fermer la fenêtre quitte l'app."
                    : "Fenêtre cachée : la collecte est suspendue comme fenêtre réduite. « Quitter » dans le menu de l'icône ferme vraiment."
                }
              >
                {(id) => (
                  <span data-testid="close-to-tray">
                    <Switch
                      id={id}
                      checked={config.ui.closeToTray && config.ui.trayIcon && trayOk !== false}
                      label="Fermer la fenêtre la garde dans la barre des tâches"
                      disabled={!config.ui.trayIcon || trayOk === false}
                      onToggle={() => onSave({ ...config, ui: { ...config.ui, closeToTray: !config.ui.closeToTray } })}
                    />
                  </span>
                )}
              </Row>
              <AutostartRow onToast={onToast} />
              <p className="hint s-auto">Enregistré dès le changement.</p>
            </Card>,
          )}

          {panel(
            'classify',
            'classify-panel',
            <>
              <Card title="Détection" icon={<Tags size={14} strokeWidth={2} />}>
                <p className="hint">
                  Les instances (front, back, BDD…) sont classées automatiquement. Une correction faite avec « Reclasser » dans le détail d'un
                  projet est retenue pour ce projet et ce motif de commande.
                </p>
                <Row label="Détecter les ports" help="Ports TCP en écoute des projets et des bases, lus toutes les 10 s. Ceux des processus d'autres utilisateurs ne sont pas lisibles.">
                  {(id) => (
                    <Switch id={id} checked={config.classify.detectPorts} label="Détecter les ports" onToggle={() => onSave(withDetectPorts(config, !config.classify.detectPorts))} />
                  )}
                </Row>
              </Card>
              <Card title={<>Corrections manuelles{overrides.length > 0 && <span className="cat-count">{overrides.length}</span>}</>}>
                {overrides.length === 0 ? (
                  <p className="hint" style={{ margin: 0 }} data-testid="overrides-empty">Aucune correction : tout est classé automatiquement.</p>
                ) : (
                  <>
                    <ul className="overrides" data-testid="overrides-list">
                      {overrides.map((o) => {
                        const m = CATEGORY_META[o.category];
                        const Icon = m.icon;
                        return (
                          <li key={o.key} data-testid="override-row">
                            <span className="ov-project" title={o.scope}>{o.project}</span>
                            <code className="ov-sig" title={o.signature}>{o.signature || '—'}</code>
                            <span className="cat-tag" style={{ '--cat': m.color } as CSSProperties}>
                              <Icon size={11} strokeWidth={2.4} />
                              {m.label}
                            </span>
                            <button
                              className="ov-remove"
                              onClick={() => onSave(withoutOverride(config, o.key))}
                              aria-label={`Retirer la correction ${o.signature} de ${o.project}`}
                              title="Retirer (revenir à l'automatique)"
                            >
                              <X size={13} strokeWidth={2.4} />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="s-foot">
                      <button className="danger" onClick={() => setConfirmOverrides(true)}>Tout effacer</button>
                    </div>
                  </>
                )}
              </Card>
              <AnimatePresence>
                {confirmOverrides && (
                  <SettingsConfirm
                    key="overrides"
                    id="overrides-title"
                    title={`Effacer les ${overrides.length} correction${overrides.length > 1 ? 's' : ''} ?`}
                    text="Toutes les instances reviendront au classement automatique."
                    confirmLabel="Tout effacer"
                    onCancel={() => setConfirmOverrides(false)}
                    onConfirm={() => {
                      setConfirmOverrides(false);
                      onSave(withoutOverride(config, null));
                    }}
                  />
                )}
              </AnimatePresence>
            </>,
          )}

          {panel('alerts', undefined, <AlertsSettings config={config} onSave={onSave} onFormState={setAlertsForm} recorder={rec} />)}

          {panel('rules', 'rules-panel', <RulesPanel config={config} issues={ruleIssues} onSaved={onConfigChanged} onFormState={setRulesForm} />)}

          {panel(
            'recorder',
            'recorder-panel',
            <>
              <Card title="Service" icon={<HardDrive size={14} strokeWidth={2} />}>
                <p className="hint">Un service en arrière-plan note la mémoire, le CPU et les événements pour l'onglet Métriques, même quand proc-watch est fermé.</p>
                <Row label="Enregistrer l'historique" help={rec && !rec.available ? undefined : 'Démarre ou arrête le service systemd utilisateur.'}>
                  {(id) => (
                    <Switch id={id} checked={!!rec?.enabled} label="Enregistrer l'historique" disabled={!rec || !rec.available || busy} onToggle={() => void toggleRecorder()} />
                  )}
                </Row>
                {rec && !rec.available && <p className="hint rec-note">systemd utilisateur indisponible : l'enregistrement en arrière-plan ne peut pas être installé</p>}
                <div className="rec-status s-status">
                  <span className={`dot ${tone}`} aria-hidden />
                  <strong data-testid="recorder-state">{toneLabel}</strong>
                  {ago !== null && <span>Dernier échantillon il y a {ago} s</span>}
                  {st && <span>Base : {formatKB(Math.round(st.dbSizeBytes / 1024))}</span>}
                  {st && (
                    <span>
                      Kills earlyoom :{' '}
                      <button className="s-link" data-testid="recorder-earlyoom-link" onClick={() => select('earlyoom')}>
                        {st.earlyoomSource === 'ok' ? 'suivis' : 'indisponibles'}
                      </button>
                    </span>
                  )}
                </div>
                {st?.lastError && <p className="rec-error">{st.lastError}</p>}
                {st?.warning && <p className="hint rec-note">{st.warning}</p>}
                {jobErrors.map(([k, v]) => (
                  <p key={k} className="rec-error">{k} : {v}</p>
                ))}
              </Card>

              <div className="s-grid s-grid-3">
                {REC_GROUPS.map(({ title, icon: Icon, help, fields }) => (
                  <Card key={title} title={title} icon={<Icon size={14} strokeWidth={2} />}>
                    {fields.map(({ f, label, short, unit, step, help: h }) => (
                      <Row key={f} label={short} help={h} error={errors[f]}>
                        {(id) => <NumberField id={id} step={step} value={form[f]} unit={unit} ariaLabel={label} invalid={!!errors[f]} onChange={(v) => setField(f, v)} onEnter={saveRecorder} />}
                      </Row>
                    ))}
                    {help && <p className="hint s-card-note">{help}</p>}
                  </Card>
                ))}
              </div>
              <SaveBar dirty={recorderState.dirty} onSave={saveRecorder} testid="recorder-save" />

              <Card title="Zone de danger" icon={<TriangleAlert size={14} strokeWidth={2} />} danger testid="danger-zone">
                <div className="s-danger-row">
                  <p className="hint" style={{ margin: 0 }}>Supprime toutes les mesures et tous les événements enregistrés. Une confirmation est demandée.</p>
                  <button className="danger" onClick={() => setConfirmClear(true)}>Vider l'historique</button>
                </div>
              </Card>
              <AnimatePresence>
                {confirmClear && (
                  <SettingsConfirm
                    key="clear"
                    id="clear-title"
                    title="Vider tout l'historique ?"
                    text="Toutes les mesures et tous les événements enregistrés seront supprimés. Cette action est définitive."
                    confirmLabel="Vider"
                    onCancel={() => setConfirmClear(false)}
                    onConfirm={() => void clearHistory()}
                  />
                )}
              </AnimatePresence>
            </>,
          )}

          {panel('earlyoom', undefined, <EarlyoomPanel protectedList={config.protected} onToast={onToast} onAttention={setEo} />)}

          {panel(
            'desktop',
            'desktop-panel',
            <Card title="Raccourci" icon={<AppWindow size={14} strokeWidth={2} />}>
              <div className="s-danger-row">
                <p className="hint" style={{ margin: 0 }}>Crée un raccourci proc-watch dans le menu de ton bureau (version AppImage ou .deb).</p>
                <button className="primary" onClick={onInstallDesktop}>Ajouter au menu des applications</button>
              </div>
            </Card>,
          )}

          {panel(
            'about',
            'about-panel',
            <>
              <AboutPanel onToast={onToast} />
              <AboutSetup onToast={onToast} onReopenOnboarding={onReopenOnboarding} />
            </>,
          )}
        </div>
      </div>
    </>
  );
}
