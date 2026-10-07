import { useState } from 'react';
import { DEFAULT_CONFIG } from '../../../core/defaults';
import type { Config, ConfigState } from '../../../core/types';

interface Props {
  state: ConfigState;
  onSave: (c: Config) => void;
  onBack: () => void;
  onInstallDesktop: () => void;
}

export function SettingsView({ state, onSave, onBack, onInstallDesktop }: Props) {
  const { config, warning, invalid } = state;
  const [entry, setEntry] = useState('');
  const [memMB, setMemMB] = useState(String(config.othersThreshold.memMB));
  const [cpu, setCpu] = useState(String(config.othersThreshold.cpuPercent));

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
    if (Number.isFinite(m) && m >= 0 && Number.isFinite(c) && c >= 0) onSave({ ...config, othersThreshold: { memMB: m, cpuPercent: c } });
  };

  return (
    <>
      <div className="detail-head">
        <button className="link" onClick={onBack}>← Retour</button>
        <h2>Réglages</h2>
      </div>
      <div className="settings">
        {warning && <div className="warning">{warning}</div>}

        <section>
          <h3>Programmes protégés</h3>
          <p className="hint">Nom exact du processus, ou expression régulière entre slashs (ex. <code>/^systemd/</code>). Les tuer demande toujours une confirmation.</p>
          <div className="chips">
            {config.protected.map((p) => (
              <span key={p} className={`chip ${invalid.includes(p) ? 'invalid' : ''}`} title={invalid.includes(p) ? 'Regex invalide, ignorée' : ''}>
                {p}
                <button onClick={() => remove(p)} aria-label={`Retirer ${p}`}>✕</button>
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
          <h3>Carte « Autres »</h3>
          <p className="hint">Les groupes sous ces deux seuils sont rassemblés dans une seule carte.</p>
          <div className="row">
            <label>Mémoire &lt; <input type="number" min="0" value={memMB} onChange={(e) => setMemMB(e.target.value)} style={{ width: 80 }} /> Mo</label>
            <label>et CPU &lt; <input type="number" min="0" step="0.5" value={cpu} onChange={(e) => setCpu(e.target.value)} style={{ width: 70 }} /> %</label>
            <button onClick={saveThresholds}>Enregistrer</button>
          </div>
        </section>

        <section>
          <h3>Menu des applications</h3>
          <p className="hint">Crée un raccourci proc-watch dans le menu de ton bureau (version AppImage ou .deb).</p>
          <button onClick={onInstallDesktop}>Ajouter au menu des applications</button>
        </section>

        <section>
          <h3>earlyoom</h3>
          <p className="hint">Bientôt : configurer earlyoom depuis proc-watch.</p>
        </section>
      </div>
    </>
  );
}
