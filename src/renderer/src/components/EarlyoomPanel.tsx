import { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, TriangleAlert, Wrench } from 'lucide-react';
import { ignoreConversions, ignoreList } from '../../../core/earlyoom';
import type { EarlyoomStatus } from '../../../core/types';
import { formFromStatus, lastEarlyoomKills, validateEarlyoomForm, type EarlyoomForm } from '../earlyoomForm';
import { formatInstant } from '../metrics';

interface Props {
  protectedList: string[];
  onToast: (m: string, kind?: 'error' | 'info') => void;
}

const ACTIVE: Record<EarlyoomStatus['active'], { label: string; tone: string }> = {
  active: { label: 'actif', tone: 'ok' },
  inactive: { label: 'inactif', tone: 'off' },
  failed: { label: 'en échec', tone: 'bad' },
  unknown: { label: 'état inconnu', tone: 'off' },
};

const FIELDS: { f: Exclude<keyof EarlyoomForm, 'prefer'>; label: string; max: number }[] = [
  { f: 'memTerm', label: 'Mémoire ≤ (SIGTERM)', max: 50 },
  { f: 'memKill', label: 'Mémoire ≤ (SIGKILL)', max: 50 },
  { f: 'swapTerm', label: 'Swap ≤ (SIGTERM)', max: 100 },
  { f: 'swapKill', label: 'Swap ≤ (SIGKILL)', max: 100 },
];

export function EarlyoomPanel({ protectedList, onToast }: Props) {
  const [st, setSt] = useState<EarlyoomStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<EarlyoomForm | null>(null);
  const [kills, setKills] = useState<{ ts: number; name: string; signal: string }[]>([]);
  const [applying, setApplying] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await window.procWatch.earlyoom.status();
      setSt(s);
      setForm(formFromStatus(s));
      setLoadError(null);
      if (s.installed) {
        window.procWatch.history.events('7d').then((ev) => setKills(lastEarlyoomKills(ev)), () => setKills([]));
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (settings: NonNullable<ReturnType<typeof validateEarlyoomForm>['settings']>, expectedLine: string) => {
    setApplying(true);
    try {
      const r = await window.procWatch.earlyoom.apply(settings, expectedLine);
      if (r.ok) onToast('earlyoom redémarré avec la nouvelle configuration', 'info');
      else onToast(r.message, 'error');
    } catch (e) {
      onToast(`earlyoom non modifié : ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setApplying(false);
      void load();
    }
  };

  const head = (
    <>
      <h3><Wrench size={15} strokeWidth={2} />earlyoom</h3>
      <p className="hint">Tue le processus le plus gourmand avant que le système ne gèle. proc-watch règle ses seuils et ses exclusions.</p>
    </>
  );

  if (!st || !form) {
    return (
      <section data-testid="earlyoom-panel">
        {head}
        <p className="hint">{loadError ? `État d'earlyoom illisible : ${loadError}` : 'Chargement…'}</p>
      </section>
    );
  }

  if (!st.installed) {
    return (
      <section data-testid="earlyoom-panel">
        {head}
        <p className="eo-absent">earlyoom n'est pas installé.</p>
        <div className="eo-cmd">
          <code data-testid="earlyoom-install">{st.installHint}</code>
          <button
            onClick={() => navigator.clipboard.writeText(st.installHint).then(() => onToast('Commande copiée', 'info'), () => onToast('Copie impossible'))}
          >
            <Copy size={13} strokeWidth={2} />
            Copier
          </button>
        </div>
      </section>
    );
  }

  const v = validateEarlyoomForm(form, protectedList);
  const current = st.file?.line ?? null;
  const unchanged = v.preview !== undefined && v.preview === current;
  const a = ACTIVE[st.active];
  const ignore = ignoreList(protectedList);
  const conversions = ignoreConversions(protectedList);
  const setField = (f: keyof EarlyoomForm, value: string) => setForm((x) => (x ? { ...x, [f]: value } : x));

  return (
    <section data-testid="earlyoom-panel">
      {head}
      <div className="rec-status">
        <span className={`dot ${a.tone}`} aria-hidden />
        <strong data-testid="earlyoom-state">earlyoom{st.version ? ` ${st.version}` : ''} · {a.label}</strong>
      </div>

      <h4 className="eo-title">Derniers kills</h4>
      {kills.length === 0 ? (
        <p className="hint">Aucun kill enregistré ces 7 derniers jours.</p>
      ) : (
        <ul className="eo-kills" data-testid="earlyoom-kills">
          {kills.map((k) => (
            <li key={`${k.ts}-${k.name}`}>
              <span className="eo-when">{formatInstant(k.ts)}</span>
              <strong>{k.name}</strong>
              {k.signal && <span className="eo-sig">{k.signal}</span>}
            </li>
          ))}
        </ul>
      )}

      <h4 className="eo-title">Seuils</h4>
      <p className="hint">earlyoom envoie SIGTERM sous le premier seuil de mémoire disponible <em>et</em> de swap libre, puis SIGKILL sous le second.</p>
      <div className="rec-fields">
        {FIELDS.map(({ f, label, max }) => (
          <div key={f} className="rec-field">
            <label>
              {label}
              <input type="number" min="1" max={max} value={form[f]} aria-invalid={!!v.errors[f]} aria-label={label} onChange={(e) => setField(f, e.target.value)} style={{ width: 70 }} />
              %
            </label>
            {v.errors[f] && <span className="field-error">{v.errors[f]}</span>}
          </div>
        ))}
      </div>

      <h4 className="eo-title">Exclusions (jamais tués)</h4>
      <p className="hint">Base + noms exacts de la liste protégée (les entrées /regex/ ne sont pas reprises), tronqués à 15 caractères comme le nom du processus ; les caractères spéciaux deviennent « . ».</p>
      <div className="pills" data-testid="earlyoom-ignore">
        {ignore.map((p) => (
          <span key={p} className="pill eo-pill">{p}</span>
        ))}
      </div>
      {conversions.some((c) => c.re) && (
        <p className="hint eo-conv" data-testid="earlyoom-ignore-converted">
          Noms adaptés (tronqués à 15 caractères, caractères hors <code>A-Z a-z 0-9 _ -</code> remplacés par « . ») :{' '}
          {conversions.filter((c) => c.re).map((c, i) => (
            <span key={c.name}>
              {i > 0 && ', '}
              <code>{c.name}</code> → <code>{c.re}</code>
            </span>
          ))}
        </p>
      )}
      {conversions.some((c) => !c.re) && (
        <p className="hint eo-conv" data-testid="earlyoom-ignore-dropped">
          Écartés (sans lettre, chiffre, _ ni -, le motif correspondrait à tout) :{' '}
          {conversions.filter((c) => !c.re).map((c, i) => (
            <span key={c.name}>
              {i > 0 && ', '}
              <code>{c.name}</code>
            </span>
          ))}
        </p>
      )}

      <h4 className="eo-title">Préférences (tués en premier)</h4>
      <p className="hint">Un motif par ligne : lettres, chiffres, <code>_ . -</code>, éventuellement terminé par <code>.*</code> (ex. <code>node.*</code>). « . » remplace tout autre caractère.</p>
      <textarea
        className="eo-prefer"
        aria-label="Préférences earlyoom"
        aria-invalid={!!v.errors.prefer}
        rows={Math.min(8, Math.max(3, form.prefer.split('\n').length))}
        value={form.prefer}
        spellCheck={false}
        onChange={(e) => setField('prefer', e.target.value)}
      />
      {v.errors.prefer && <span className="field-error">{v.errors.prefer}</span>}

      {st.file && st.file.converted.length > 0 && (
        <div className="warning eo-warning" data-testid="earlyoom-converted">
          <TriangleAlert size={15} strokeWidth={2.2} />
          <span>
            Antislash converti en « . » (systemd le supprime) :{' '}
            {st.file.converted.map((c, i) => (
              <span key={c}>
                {i > 0 && ', '}
                <code>{c}</code> → <code>{c.replace(/\\[\s\S]?/g, '.')}</code>
              </span>
            ))}
          </span>
        </div>
      )}

      <div className="eo-lines">
        <span className="eo-label">Actuel</span>
        <pre data-testid="earlyoom-current">{current ?? 'Aucune ligne EARLYOOM_ARGS dans /etc/default/earlyoom'}</pre>
        <span className="eo-label">Nouveau</span>
        <pre data-testid="earlyoom-preview" className={v.preview ? '' : 'eo-none'}>{v.preview ?? 'Corriger les erreurs ci-dessus'}</pre>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button data-testid="earlyoom-apply" disabled={!v.settings || unchanged || applying} onClick={() => v.settings && v.preview && void apply(v.settings, v.preview)}>
          <KeyRound size={14} strokeWidth={2} />
          {applying ? 'Application…' : 'Appliquer (mot de passe)'}
        </button>
        {unchanged ? (
          <span className="hint" style={{ margin: 0 }}>Identique à la configuration actuelle</span>
        ) : (
          <span className="hint" style={{ margin: 0 }}>proc-watch demande confirmation avec la ligne « Nouveau », puis le mot de passe administrateur. L'ancien fichier est copié en .bak ; il est restauré si earlyoom ne reste pas actif.</span>
        )}
      </div>

    </section>
  );
}
