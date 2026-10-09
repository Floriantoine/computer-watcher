// Textes des résultats de l'accueil et de la désinstallation (logique pure) : chemins exacts, ton du message.
import { APP_DISPLAY_NAME } from '../../core/appName';
import type { AutostartInfo, InstallOutcome, UninstallResult } from '../../core/onboarding';

export type Tone = 'ok' | 'warn' | 'error';
export interface ResultText { tone: Tone; lines: string[] }

export function installResult(r: InstallOutcome): ResultText {
  const head = r.status === 'already' ? `Déjà installée : ${r.dest}` : r.status === 'updated' ? `Copie remplacée : ${r.dest}` : `Copiée dans ${r.dest}`;
  return {
    tone: r.warnings.length ? 'warn' : 'ok',
    lines: [
      head,
      ...(r.desktopFile ? [`Entrée de menu : ${r.desktopFile}`] : []),
      ...(r.autostartUpdated ? ['Démarrage avec la session : repointé vers la copie'] : []),
      ...r.warnings,
    ],
  };
}

export function originalDeletionResult(d: { path: string; ok: boolean; message: string }): ResultText {
  return d.ok ? { tone: 'ok', lines: [`Fichier téléchargé supprimé : ${d.path}`] } : { tone: 'error', lines: [`Fichier téléchargé non supprimé : ${d.path} — ${d.message}`] };
}

export function autostartResult(a: AutostartInfo): ResultText {
  return { tone: 'ok', lines: [a.enabled ? `Activé : ${a.path}` : `Désactivé : ${a.path} retiré`] };
}

export function recorderResult(s: { available: boolean; enabled: boolean; running: boolean }): ResultText {
  if (!s.available) return { tone: 'warn', lines: ['systemd utilisateur indisponible : l’enregistrement en arrière-plan ne peut pas être installé'] };
  if (!s.enabled) return { tone: 'ok', lines: ['Désactivé : rien n’est enregistré'] };
  if (s.running) return { tone: 'ok', lines: ['Service actif : l’historique se remplit'] };
  return { tone: 'warn', lines: ['Activé, le service n’a pas encore répondu (quelques secondes)'] };
}

export function uninstallReport(r: UninstallResult): ResultText {
  return {
    tone: r.done ? 'ok' : 'error',
    lines: [
      ...r.removed.map((p) => `Retiré : ${p}`),
      ...r.failed.map((f) => `Échec : ${f.path} — ${f.error}`),
      ...r.kept.map((k) => `Laissé : ${k.path} — ${k.reason}`),
      r.done ? `${APP_DISPLAY_NAME} est désinstallé et va se fermer.` : `Désinstallation incomplète : ${APP_DISPLAY_NAME} reste ouvert.`,
    ],
  };
}
