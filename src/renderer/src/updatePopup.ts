// Pop-up « Mise à jour disponible » et section « À propos » (logique pure) : textes et actions selon l'état du main.
import type { UpdateState, UpdateView } from '../../core/update';

export type UpdateAction = { kind: 'download' | 'install' | 'later' | 'ignore' | 'open'; label: string };

export interface UpdatePopupText { title: string; body: string; progress: number | null; actions: UpdateAction[] }

const LATER: UpdateAction = { kind: 'later', label: 'Plus tard' };
const IGNORE: UpdateAction = { kind: 'ignore', label: 'Ignorer cette version' };

export function updatePopupText(v: UpdateView): UpdatePopupText {
  const s = v.state;
  const version = s.available?.version ?? '';
  const notes = s.available?.notes || 'Nouvelle version de proc-watch.';
  const title = `Mise à jour ${version} disponible`;
  switch (s.phase) {
    case 'downloading':
      return { title, body: `Téléchargement… ${Math.round(s.progress ?? 0)} %`, progress: s.progress ?? 0, actions: [] };
    case 'ready':
      return {
        title,
        body:
          'Téléchargée et vérifiée. proc-watch va se fermer, remplacer son AppImage puis redémarrer ; le service ' +
          "d'enregistrement sera relancé avec la nouvelle version.",
        progress: null,
        actions: [{ kind: 'install', label: 'Redémarrer et installer' }, LATER],
      };
    case 'error':
      return { title, body: `Échec du téléchargement : ${s.error ?? 'erreur inconnue'}`, progress: null, actions: [{ kind: 'download', label: 'Réessayer' }, LATER] };
    default:
      if (s.mode === 'relaunch')
        return {
          title,
          body: `${notes} Cette AppImage n’est pas la copie installée : lancez proc-watch depuis le menu pour mettre à jour.`,
          progress: null,
          actions: [LATER, IGNORE],
        };
      if (s.mode === 'notify')
        return {
          title,
          body: `${notes} Ce format d’installation ne se met pas à jour tout seul : une mise à jour est disponible sur la page des versions.`,
          progress: null,
          actions: [{ kind: 'open', label: 'Voir la version' }, LATER, IGNORE],
        };
      return { title, body: notes, progress: null, actions: [{ kind: 'download', label: 'Mettre à jour' }, LATER, IGNORE] };
  }
}

const MODE_TEXT: Record<UpdateState['mode'], string> = {
  install: 'AppImage : mise à jour téléchargée et vérifiée (sha512), installée au redémarrage, sur demande.',
  relaunch: 'AppImage lancée hors de la copie installée (~/Applications) : lancez proc-watch depuis le menu pour mettre à jour.',
  notify: 'Paquet (.deb) : notification seulement, la mise à jour se télécharge depuis la page des versions.',
  off: 'Lancée depuis les sources : aucune vérification des mises à jour.',
};

/** Lignes de Réglages › À propos. */
export function aboutLines(s: UpdateState, fmtTime: (ms: number) => string): { mode: string; last: string } {
  const mode = MODE_TEXT[s.mode];
  if (s.lastCheck === null) return { mode, last: 'Jamais vérifié' };
  const result =
    s.lastResult === 'error' ? `échec (${s.error ?? 'erreur inconnue'})` : s.available ? `version ${s.available.version} disponible` : 'à jour';
  return { mode, last: `Dernière vérification : ${fmtTime(s.lastCheck)} — ${result}` };
}
