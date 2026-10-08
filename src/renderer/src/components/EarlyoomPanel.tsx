import { useCallback, useEffect, useState } from 'react';
import { Activity, Copy, KeyRound, TriangleAlert } from 'lucide-react';
import { ignoreConversions, ignoreList } from '../../../core/earlyoom';
import type { EarlyoomStatus } from '../../../core/types';
import { formFromStatus, lastEarlyoomKills, validateEarlyoomForm, type EarlyoomForm } from '../earlyoomForm';
import { formatInstant } from '../metrics';
import { linesDirty, numbersDirty, tokenDiff, type FormState } from '../settingsNav';
import { Card, NumberField, Row, SaveBar } from './settingsUi';

interface Props {
  protectedList: string[];
  onToast: (m: string, kind?: 'error' | 'info') => void;
  /** État pour le point de la barre latérale (installé, actif, saisie modifiée ou invalide). */
  onAttention?: (s: EarlyoomAttention) => void;
}

export type EarlyoomAttention = FormState & { status: { installed: boolean; active: string } | null };

const ACTIVE: Record<EarlyoomStatus['active'], { label: string; tone: string }> = {
  active: { label: 'actif', tone: 'ok' },
  inactive: { label: 'inactif', tone: 'off' },
  failed: { label: 'en échec', tone: 'bad' },
  unknown: { label: 'état inconnu', tone: 'off' },
};

const FIELDS: { f: Exclude<keyof EarlyoomForm, 'prefer'>; label: string; short: string; max: number }[] = [
  { f: 'memTerm', label: 'Mémoire ≤ (SIGTERM)', short: 'SIGTERM sous', max: 50 },
  { f: 'memKill', label: 'Mémoire ≤ (SIGKILL)', short: 'SIGKILL sous', max: 50 },
  { f: 'swapTerm', label: 'Swap ≤ (SIGTERM)', short: 'SIGTERM sous', max: 100 },
  { f: 'swapKill', label: 'Swap ≤ (SIGKILL)', short: 'SIGKILL sous', max: 100 },
];

export function EarlyoomPanel({ protectedList, onToast, onAttention }: Props) {
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

  // Saisie modifiée / invalide, calculée avant les retours anticipés (règle des hooks).
  const initial = st ? formFromStatus(st) : null;
  const dirty =
    !!st?.installed && !!form && !!initial &&
    (numbersDirty({ memTerm: form.memTerm, memKill: form.memKill, swapTerm: form.swapTerm, swapKill: form.swapKill }, {
      memTerm: Number(initial.memTerm), memKill: Number(initial.memKill), swapTerm: Number(initial.swapTerm), swapKill: Number(initial.swapKill),
    }) || linesDirty(form.prefer, initial.prefer));
  const invalid = !!st?.installed && !!form && Object.keys(validateEarlyoomForm(form, protectedList).errors).length > 0;
  const installed = st ? st.installed : null;
  const active = st?.active ?? null;
  useEffect(() => {
    onAttention?.({ status: installed === null ? null : { installed, active: active ?? 'unknown' }, dirty, invalid });
  }, [installed, active, dirty, invalid, onAttention]);

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

  if (!st || !form) {
    return (
      <div className="s-stack" data-testid="earlyoom-panel">
        <Card>
          <p className="hint" style={{ margin: 0 }}>{loadError ? `État d'earlyoom illisible : ${loadError}` : 'Chargement…'}</p>
        </Card>
      </div>
    );
  }

  if (!st.installed) {
    return (
      <div className="s-stack" data-testid="earlyoom-panel">
        <Card title="État" icon={<Activity size={14} strokeWidth={2} />}>
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
        </Card>
      </div>
    );
  }

  const v = validateEarlyoomForm(form, protectedList);
  const current = st.file?.line ?? null;
  const unchanged = v.preview !== undefined && v.preview === current;
  const a = ACTIVE[st.active];
  const ignore = ignoreList(protectedList);
  const conversions = ignoreConversions(protectedList);
  const setField = (f: keyof EarlyoomForm, value: string) => setForm((x) => (x ? { ...x, [f]: value } : x));
  const thresholds = (title: string, fields: typeof FIELDS) => (
    <Card title={title}>
      {fields.map(({ f, label, short, max }) => (
        <Row key={f} label={short} error={v.errors[f]}>
          {(id) => <NumberField id={id} min="1" max={max} value={form[f]} unit="%" ariaLabel={label} invalid={!!v.errors[f]} onChange={(x) => setField(f, x)} />}
        </Row>
      ))}
    </Card>
  );

  return (
    <div className="s-stack" data-testid="earlyoom-panel">
      <Card title="État" icon={<Activity size={14} strokeWidth={2} />}>
        <div className="rec-status">
          <span className={`dot ${a.tone}`} aria-hidden />
          <strong data-testid="earlyoom-state">earlyoom{st.version ? ` ${st.version}` : ''} · {a.label}</strong>
        </div>
        <h4 className="eo-title">Derniers kills</h4>
        {kills.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>Aucun kill enregistré ces 7 derniers jours.</p>
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
      </Card>

      <div className="s-grid">
        {thresholds('Seuils mémoire', FIELDS.slice(0, 2))}
        {thresholds('Seuils swap', FIELDS.slice(2))}
      </div>
      <p className="hint s-under">earlyoom envoie SIGTERM sous le premier seuil de mémoire disponible <em>et</em> de swap libre, puis SIGKILL sous le second.</p>

      <Card title="Exclusions (jamais tués)">
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
      </Card>

      <Card title="Préférences (tués en premier)">
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
      </Card>

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

      <Card title="Aperçu de /etc/default/earlyoom">
        <div className="eo-lines">
          <span className="eo-label">Actuel</span>
          <pre data-testid="earlyoom-current">{current ?? 'Aucune ligne EARLYOOM_ARGS dans /etc/default/earlyoom'}</pre>
          <span className="eo-label">Nouveau</span>
          <pre data-testid="earlyoom-preview" className={v.preview ? '' : 'eo-none'}>
            {v.preview
              ? tokenDiff(current, v.preview).map((t, i) => (t.changed ? <mark key={i} className="eo-diff">{t.text}</mark> : t.text))
              : 'Corriger les erreurs ci-dessus'}
          </pre>
        </div>
        <SaveBar
          dirty={dirty}
          disabled={!v.settings || unchanged || applying}
          onSave={() => v.settings && v.preview && void apply(v.settings, v.preview)}
          testid="earlyoom-apply"
          label={
            <>
              <KeyRound size={14} strokeWidth={2} />
              {applying ? 'Application…' : 'Appliquer (mot de passe)'}
            </>
          }
        >
          <span className="hint s-foot-note">
            {unchanged
              ? 'Identique à la configuration actuelle'
              : "proc-watch demande confirmation avec la ligne « Nouveau », puis le mot de passe administrateur. L'ancien fichier est copié en .bak ; il est restauré si earlyoom ne reste pas actif."}
          </span>
        </SaveBar>
      </Card>
    </div>
  );
}
