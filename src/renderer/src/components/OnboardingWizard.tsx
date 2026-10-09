// Assistant d'accueil : installer comme une app (AppImage), démarrer avec la session, historique, earlyoom.
import { APP_DISPLAY_NAME } from '../../../core/appName';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { AppWindow, Check, CircleAlert, HardDrive, KeyRound, Power, RotateCw, ShieldCheck, Sparkles } from 'lucide-react';
import { ONBOARDING_STEPS, stepPosition, wizardKey, type OnboardingInfo, type OnboardingStep, type InstallOutcome } from '../../../core/onboarding';
import { setupNeed } from '../../../core/earlyoomSetup';
import type { EarlyoomStatus, RecorderState } from '../../../core/types';
import { useFocusTrap } from '../focusTrap';
import { autostartResult, installResult, originalDeletionResult, recorderResult, type ResultText } from '../onboardingText';
import { ipcErrorMessage } from '../viewModel';
import { runEarlyoomSetup } from './EarlyoomSetupPopup';
import { Switch } from './settingsUi';
import '../onboarding.css';

const ICONS: Record<OnboardingStep, typeof AppWindow> = { install: AppWindow, autostart: Power, history: HardDrive, earlyoom: ShieldCheck };

const err = (e: unknown): ResultText => ({ tone: 'error', lines: [ipcErrorMessage(e)] });

function Result({ r, testid }: { r: ResultText | undefined; testid: string }) {
  if (!r) return null;
  return (
    <div className={`onb-result ${r.tone}`} role="status" data-testid={testid}>
      {r.tone === 'ok' ? <Check size={14} strokeWidth={2.4} aria-hidden /> : <CircleAlert size={14} strokeWidth={2.2} aria-hidden />}
      <div>
        {r.lines.map((l) => (
          <p key={l}>{l}</p>
        ))}
      </div>
    </div>
  );
}

export function OnboardingWizard({ info, onClose, onToast }: {
  info: OnboardingInfo;
  /** Terminé ou « Passer » : le parent ferme et le main retient que l'accueil est fait. */
  onClose: () => void;
  onToast: (m: string, kind?: 'error' | 'info') => void;
}) {
  const steps = info.steps;
  const [index, setIndex] = useState(info.start);
  const step = steps[index]!;
  const [results, setResults] = useState<Partial<Record<OnboardingStep, ResultText>>>(() =>
    info.originalDeletion ? { install: originalDeletionResult(info.originalDeletion) } : {},
  );
  const setResult = (s: OnboardingStep, r: ResultText) => setResults((x) => ({ ...x, [s]: r }));
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusTrap(box);
  useEffect(() => heading.current?.focus(), [index]);

  // 1. Installer
  const [installed, setInstalled] = useState<InstallOutcome | null>(null);
  const [deleteOriginal, setDeleteOriginal] = useState(false);
  // 2. Démarrage avec la session (coché par défaut)
  const [autoOn, setAutoOn] = useState(true);
  const [autoTarget, setAutoTarget] = useState<string | null | undefined>(undefined);
  // 3. Historique
  const [rec, setRec] = useState<RecorderState | null>(null);
  // 4. earlyoom
  const [eo, setEo] = useState<EarlyoomStatus | null>(null);

  useEffect(() => {
    window.procWatch.autostart.get().then((a) => setAutoTarget(a.target), () => setAutoTarget(null));
    window.procWatch.recorder.status().then(setRec, () => {});
    window.procWatch.earlyoom.status().then(setEo, () => {});
  }, []);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const install = () =>
    run(async () => {
      try {
        const r = await window.procWatch.onboarding.install();
        setInstalled(r);
        setResult('install', installResult(r));
      } catch (e) {
        setResult('install', err(e));
      }
    });
  const relaunch = () =>
    run(async () => {
      try {
        const r = await window.procWatch.onboarding.relaunch(deleteOriginal);
        if (r.relaunched) setResult('install', { tone: 'ok', lines: ['Relance depuis la copie…'] });
      } catch (e) {
        setResult('install', err(e));
      }
    });
  const applyAutostart = async (): Promise<boolean> => {
    if (autoTarget === null) return true; // indisponible (dev) : rien à écrire
    try {
      setResult('autostart', autostartResult(await window.procWatch.autostart.set(autoOn)));
      return true;
    } catch (e) {
      setResult('autostart', err(e));
      return false;
    }
  };
  const toggleRecorder = () =>
    run(async () => {
      try {
        const r = await window.procWatch.recorder.setEnabled(!rec?.enabled);
        setRec(r);
        setResult('history', recorderResult(r));
      } catch (e) {
        setResult('history', err(e));
      }
    });
  const eoMode = eo ? setupNeed(eo) : null;
  const setupEarlyoom = () =>
    run(async () => {
      if (!eoMode) return;
      const r = await runEarlyoomSetup(eoMode, onToast);
      setResult('earlyoom', r.ok ? { tone: 'ok', lines: [eoMode === 'install' ? 'earlyoom installé, configuré et actif' : 'earlyoom configuré et actif'] } : { tone: r.reason === 'cancelled' ? 'warn' : 'error', lines: [r.message] });
      window.procWatch.earlyoom.status().then(setEo, () => {});
    });

  const finish = useCallback(() => {
    window.procWatch.onboarding.finish().catch(() => {});
    onClose();
  }, [onClose]);
  const next = () =>
    run(async () => {
      if (step === 'autostart' && !(await applyAutostart())) return;
      if (index === steps.length - 1) finish();
      else setIndex(index + 1);
    });

  const onKey = (e: React.KeyboardEvent) => {
    const a = wizardKey(e.key, index, steps.length, e.altKey);
    if (!a) return;
    e.preventDefault();
    if (a.kind === 'skip') finish();
    else setIndex(a.index);
  };

  const body: Record<OnboardingStep, () => ReactNode> = {
    install: () => (
      <>
        <p>
          {APP_DISPLAY_NAME} tourne depuis le fichier téléchargé. L’installer le copie dans <code>~/Applications</code> et l’ajoute au menu des
          applications avec son icône. Les mises à jour automatiques remplaceront cette copie.
        </p>
        <dl className="onb-paths">
          <dt>Fichier lancé</dt>
          <dd><code>{info.appImage}</code></dd>
          <dt>Copie</dt>
          <dd><code>{info.dest}</code></dd>
        </dl>
        {info.runningFromCopy && !results.install && <p className="hint">Déjà installée : {APP_DISPLAY_NAME} tourne depuis la copie.</p>}
        <div className="onb-actions">
          <button className="primary" data-testid="onb-install" disabled={busy} onClick={() => void install()}>
            <AppWindow size={14} strokeWidth={2} />
            {info.runningFromCopy || info.installed ? 'Vérifier l’installation' : 'Installer'}
          </button>
        </div>
        <Result r={results.install} testid="onb-install-result" />
        {installed && !installed.runningFromCopy && (
          <div className="onb-relaunch">
            {installed.canDeleteSource && (
              <label className="onb-check">
                <input type="checkbox" checked={deleteOriginal} onChange={(e) => setDeleteOriginal(e.target.checked)} data-testid="onb-delete-original" />
                <span>
                  Supprimer le fichier téléchargé d’origine : <code>{installed.source}</code>
                </span>
              </label>
            )}
            <button className="primary" data-testid="onb-relaunch" disabled={busy || !installed.executable} onClick={() => void relaunch()}>
              <RotateCw size={14} strokeWidth={2} />
              Relancer depuis la copie
            </button>
            <p className="hint">
              L’accueil reprend à l’étape suivante dans la copie relancée.
              {deleteOriginal && ' Le fichier téléchargé est supprimé par la copie, une fois démarrée, s’il n’a pas changé.'}
            </p>
          </div>
        )}
      </>
    ),
    autostart: () => (
      <>
        <p>
          {APP_DISPLAY_NAME} démarre à l’ouverture de session, caché dans la barre des tâches (ou fenêtre réduite si le bureau n’en a pas) :
          l’icône montre la mémoire utilisée en permanence.
        </p>
        <div className="onb-switch">
          <Switch id="onb-autostart" checked={autoOn && autoTarget !== null} label="Démarrer avec la session" disabled={autoTarget === null || busy} onToggle={() => setAutoOn((v) => !v)} />
          <label htmlFor="onb-autostart">Démarrer avec la session</label>
        </div>
        {autoTarget === null && <p className="hint">Disponible uniquement dans la version installée (AppImage ou .deb).</p>}
        {autoTarget && <p className="hint">Entrée écrite dans <code>~/.config/autostart/computer-watcher.desktop</code>, appliquée avec « Suivant ». Modifiable dans Réglages › Affichage.</p>}
        <Result r={results.autostart} testid="onb-autostart-result" />
      </>
    ),
    history: () => (
      <>
        <p>Un service en arrière-plan note ce qui se passe, même fenêtre fermée, pour répondre à « qu’est-ce qui a fait geler la machine à 3 h ? ».</p>
        <ul className="onb-facts">
          <li><strong>Ce qui est noté</strong> : mémoire, swap et CPU du système et des groupes toutes les 5 s ; les processus de plus de 50 Mo ou 1 % de CPU, ligne de commande comprise ; les kills, les interventions d’earlyoom et les alertes.</li>
          <li><strong>Où</strong> : <code>{info.dataDir}/metrics.db</code>, en local seulement (fichiers en 0600).</li>
          <li><strong>Combien de place</strong> : environ 0,4 Go à 30 jours sur une machine calme, jusqu’à ~1,1 Go en développement intensif. Rétention et seuils réglables dans Réglages › Enregistrement.</li>
        </ul>
        <div className="onb-switch">
          <Switch id="onb-recorder" checked={!!rec?.enabled} label="Enregistrer l’historique" disabled={!rec || !rec.available || busy} onToggle={() => void toggleRecorder()} />
          <label htmlFor="onb-recorder">Enregistrer l’historique</label>
        </div>
        <Result r={results.history ?? (rec ? recorderResult(rec) : undefined)} testid="onb-history-result" />
      </>
    ),
    earlyoom: () => (
      <>
        <p>
          earlyoom tue le processus le plus gourmand avant que la mémoire saturée ne gèle tout le système. {APP_DISPLAY_NAME} peut l’installer, le
          configurer (terminaux, Claude et session toujours exclus) et l’activer, avec un seul mot de passe administrateur.
        </p>
        <p className="onb-eo-state" data-testid="onb-earlyoom-state">
          {!eo ? 'Lecture de l’état…' : !eo.installed ? 'earlyoom n’est pas installé.' : eoMode ? 'earlyoom est installé mais pas actif au démarrage.' : `earlyoom ${eo.version ?? ''} est installé et actif.`}
        </p>
        {eoMode && (
          <div className="onb-actions">
            <button className="primary" data-testid="onb-earlyoom-setup" disabled={busy} onClick={() => void setupEarlyoom()}>
              <KeyRound size={14} strokeWidth={2} />
              {eoMode === 'install' ? 'Installer et configurer' : 'Activer'}
            </button>
          </div>
        )}
        <Result r={results.earlyoom} testid="onb-earlyoom-result" />
      </>
    ),
  };

  const Icon = ICONS[step];
  return (
    <motion.div className="overlay onb-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
      <motion.div
        ref={box}
        className="dialog onb"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onb-title"
        aria-describedby="onb-pos"
        data-testid="onboarding"
        onKeyDown={onKey}
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      >
        <header className="onb-head">
          <span className="onb-logo" aria-hidden><Sparkles size={16} strokeWidth={2} /></span>
          <div>
            <h2>Bienvenue dans {APP_DISPLAY_NAME}</h2>
            <p id="onb-pos">{stepPosition(index, steps.length)}</p>
          </div>
        </header>
        <div className="onb-body">
          <ol className="onb-steps" aria-label="Étapes">
            {steps.map((s, i) => {
              const r = results[s];
              const I = ICONS[s];
              return (
                <li key={s} className={`${i === index ? 'current' : ''} ${r ? r.tone : ''}`} aria-current={i === index ? 'step' : undefined}>
                  <button type="button" tabIndex={-1} onClick={() => !busy && setIndex(i)} data-testid={`onb-step-${s}`}>
                    <span className="onb-step-ico">{r?.tone === 'ok' ? <Check size={13} strokeWidth={2.6} /> : <I size={13} strokeWidth={2} />}</span>
                    <span>{ONBOARDING_STEPS[s].title}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <section className="onb-content" data-testid={`onb-content-${step}`}>
            <h3 id="onb-title" ref={heading} tabIndex={-1}>
              <Icon size={17} strokeWidth={2} />
              {ONBOARDING_STEPS[step].title}
            </h3>
            {body[step]()}
          </section>
        </div>
        <footer className="onb-foot">
          <button className="onb-skip" data-testid="onb-skip" onClick={finish} title="Échap">Passer</button>
          <span className="onb-hint" aria-hidden>Alt+← / Alt+→ pour naviguer, Échap pour passer</span>
          <button data-testid="onb-prev" disabled={index === 0 || busy} onClick={() => setIndex(index - 1)}>Précédent</button>
          <button className="primary" data-testid="onb-next" disabled={busy} onClick={() => void next()}>
            {index === steps.length - 1 ? 'Terminer' : 'Suivant'}
          </button>
        </footer>
      </motion.div>
    </motion.div>
  );
}
