import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { AppWindow, ArrowLeft, HardDrive, Layers, ShieldCheck, Trash2, TriangleAlert, Wrench, X } from 'lucide-react';
import { DEFAULT_CONFIG } from '../../../core/defaults';
import type { Config, ConfigState, RecorderState } from '../../../core/types';
import { formatKB } from '../format';
import { recorderToForm, validateRecorderForm, type RecorderErrors, type RecorderForm } from '../recorderForm';

interface Props {
  state: ConfigState;
  onSave: (c: Config) => void;
  onBack: () => void;
  onInstallDesktop: () => void;
  onToast: (message: string, kind?: 'error' | 'info') => void;
  /** La config a été modifiée côté main (interrupteur) : le parent la recharge. */
  onConfigChanged: () => void;
}

export function SettingsView({ state, onSave, onBack, onInstallDesktop, onToast, onConfigChanged }: Props) {
  const { config, warning, invalid } = state;
  const [entry, setEntry] = useState('');
  const [memMB, setMemMB] = useState(String(config.othersThreshold.memMB));
  const [cpu, setCpu] = useState(String(config.othersThreshold.cpuPercent));

  const [rec, setRec] = useState<RecorderState | null>(null);
  const [form, setForm] = useState<RecorderForm>(() => recorderToForm(config.recorder));
  const [errors, setErrors] = useState<RecorderErrors>({});
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [now, setNow] = useState(() => Date.now());

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
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
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
      await window.procWatch.recorder.clearHistory();
      onToast("Historique vidé (effectif d'ici une minute)", 'info');
    } catch (e) {
      onToast(`Historique non vidé : ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const st = rec?.status ?? null;
  const tone = !rec ? 'off' : rec.running ? 'ok' : rec.enabled ? 'warn' : 'off';
  const toneLabel = !rec ? 'Chargement…' : rec.running ? 'Actif' : rec.enabled ? 'Ne répond pas' : 'Désactivé';
  const ago = st?.lastSampleAt ? Math.max(0, Math.round((now - st.lastSampleAt) / 1000)) : null;
  const jobErrors = Object.entries(st?.jobErrors ?? {}).filter(([, v]) => v) as [string, string][];
  const FIELDS: { f: keyof RecorderForm; label: string; unit: string; step?: string }[] = [
    { f: 'intervalSec', label: 'Intervalle', unit: 's' },
    { f: 'detailHours', label: 'Rétention détaillée', unit: 'h' },
    { f: 'summaryDays', label: 'Rétention résumée', unit: 'j' },
    { f: 'procMinMemMB', label: 'Seuil mémoire processus', unit: 'Mo' },
    { f: 'procMinCpuPercent', label: 'Seuil CPU processus', unit: '%', step: '0.5' },
    { f: 'groupMinMemMB', label: 'Seuil mémoire groupe', unit: 'Mo' },
    { f: 'leakMinMinutes', label: 'Fuite : durée', unit: 'min' },
    { f: 'leakMinGrowthMB', label: 'Fuite : hausse', unit: 'Mo' },
  ];

  const add = () => {
    const v = entry.trim();
    if (!v || config.protected.includes(v)) return;
    onSave({ ...config, protected: [...config.protected, v] });
    setEntry('');
  };
  const remove = (v: string) => onSave({ ...config, protected: config.protected.filter((x) => x !== v) });
  const saveThresholds = () => {
    const m = Number(memMB);
    const c = Number(cpu);
    if (memMB.trim() && cpu.trim() && Number.isFinite(m) && m >= 0 && Number.isFinite(c) && c >= 0) onSave({ ...config, othersThreshold: { memMB: m, cpuPercent: c } });
  };

  return (
    <>
      <div className="page-head">
        <button className="back" title="Retour" aria-label="Retour" onClick={onBack}>
          <ArrowLeft size={16} strokeWidth={2} />
        </button>
        <h2>Réglages</h2>
      </div>
      <div className="settings">
        {warning && (
          <div className="warning">
            <TriangleAlert size={15} strokeWidth={2.2} />
            <span>{warning}</span>
          </div>
        )}

        <section>
          <h3><ShieldCheck size={15} strokeWidth={2} />Programmes protégés</h3>
          <p className="hint">Nom exact du processus, ou expression régulière entre slashs (ex. <code>/^systemd/</code>). Les tuer demande toujours une confirmation.</p>
          <div className="pills">
            {config.protected.map((p) => (
              <span key={p} className={`pill ${invalid.includes(p) ? 'invalid' : ''}`} title={invalid.includes(p) ? 'Regex invalide, ignorée' : ''}>
                {p}
                <button onClick={() => remove(p)} aria-label={`Retirer ${p}`} title={`Retirer ${p}`}>
                  <X size={12} strokeWidth={2.4} />
                </button>
              </span>
            ))}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <input value={entry} placeholder="nom ou /regex/" onChange={(e) => setEntry(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
            <button onClick={add}>Ajouter</button>
            <button onClick={() => onSave({ ...config, protected: [...DEFAULT_CONFIG.protected] })}>Réinitialiser</button>
          </div>
        </section>

        <section>
          <h3><Layers size={15} strokeWidth={2} />Carte « Autres »</h3>
          <p className="hint">Les groupes sous ces deux seuils sont rassemblés dans une seule carte.</p>
          <div className="row">
            <label>Mémoire &lt; <input type="number" min="0" value={memMB} onChange={(e) => setMemMB(e.target.value)} style={{ width: 80 }} /> Mo</label>
            <label>et CPU &lt; <input type="number" min="0" step="0.5" value={cpu} onChange={(e) => setCpu(e.target.value)} style={{ width: 70 }} /> %</label>
            <button onClick={saveThresholds}>Enregistrer</button>
          </div>
        </section>

        <section>
          <h3><AppWindow size={15} strokeWidth={2} />Menu des applications</h3>
          <p className="hint">Crée un raccourci proc-watch dans le menu de ton bureau (version AppImage ou .deb).</p>
          <button onClick={onInstallDesktop}>Ajouter au menu des applications</button>
        </section>

        <section data-testid="recorder-panel">
          <h3><HardDrive size={15} strokeWidth={2} />Enregistrement</h3>
          <p className="hint">Un service en arrière-plan note la mémoire, le CPU et les événements pour l'onglet Métriques, même quand proc-watch est fermé.</p>
          <div className="rec-switch">
            <button
              type="button"
              role="switch"
              aria-checked={!!rec?.enabled}
              aria-label="Enregistrer l'historique"
              className="switch"
              disabled={!rec || !rec.available || busy}
              onClick={() => void toggleRecorder()}
            >
              <i />
            </button>
            <span>Enregistrer l'historique</span>
          </div>
          {rec && !rec.available && <p className="hint rec-note">systemd utilisateur indisponible : l'enregistrement en arrière-plan ne peut pas être installé</p>}
          <div className="rec-status">
            <span className={`dot ${tone}`} aria-hidden />
            <strong data-testid="recorder-state">{toneLabel}</strong>
            {ago !== null && <span>Dernier échantillon il y a {ago} s</span>}
            {st && <span>Base : {formatKB(Math.round(st.dbSizeBytes / 1024))}</span>}
            {st && <span>Kills earlyoom : {st.earlyoomSource === 'ok' ? 'suivis' : 'indisponibles'}</span>}
          </div>
          {st?.lastError && <p className="rec-error">{st.lastError}</p>}
          {st?.warning && <p className="hint rec-note">{st.warning}</p>}
          {jobErrors.map(([k, v]) => (
            <p key={k} className="rec-error">{k} : {v}</p>
          ))}
          <div className="rec-fields">
            {FIELDS.map(({ f, label, unit, step }) => (
              <div key={f} className="rec-field">
                <label>
                  {label}
                  <input type="number" min="0" step={step} value={form[f]} aria-invalid={!!errors[f]} aria-label={label} onChange={(e) => setField(f, e.target.value)} style={{ width: 84 }} />
                  {unit}
                </label>
                {errors[f] && <span className="field-error">{errors[f]}</span>}
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={saveRecorder}>Enregistrer</button>
            <button className="danger" onClick={() => setConfirmClear(true)}>Vider l'historique</button>
          </div>
          <AnimatePresence>
            {confirmClear && <ClearDialog key="clear" onCancel={() => setConfirmClear(false)} onConfirm={() => void clearHistory()} />}
          </AnimatePresence>
        </section>

        <section>
          <h3><Wrench size={15} strokeWidth={2} />earlyoom</h3>
          <p className="hint">Bientôt : configurer earlyoom depuis proc-watch.</p>
        </section>
      </div>
    </>
  );
}

function ClearDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const isPresent = useIsPresent();
  const guard = (fn: () => void) => () => {
    if (isPresent) fn();
  };
  return (
    <motion.div
      className="overlay"
      onClick={guard(onCancel)}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      style={{ pointerEvents: isPresent ? undefined : 'none' }}
    >
      <motion.div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="clear-title"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.94, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6, transition: { duration: 0.14 } }}
        transition={{ type: 'spring', stiffness: 420, damping: 28, mass: 0.8 }}
      >
        <div className="dialog-head">
          <span className="ico" aria-hidden><Trash2 size={17} strokeWidth={2} /></span>
          <h3 id="clear-title">Vider tout l'historique ?</h3>
        </div>
        <p className="hint" style={{ margin: 0 }}>Toutes les mesures et tous les événements enregistrés seront supprimés. Cette action est définitive.</p>
        <div className="actions">
          <button onClick={guard(onCancel)}>Annuler</button>
          <button className="danger" onClick={guard(onConfirm)}>Vider</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
