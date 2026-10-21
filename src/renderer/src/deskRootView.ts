// Bureau prioritaire, protection mémoire système (fenêtre, logique pure) : résumé, action proposée, message après coup.
import type { DeskRootResult, DeskRootStatus } from '../../core/antigel/deskRoot';

/** Diffusé après une action : la carte Métriques et Réglages relisent l'état. */
export const DESK_ROOT_CHANGED = 'pw:desk-root-changed';

export interface DeskRootSummary {
  text: string;
  tone: 'ok' | 'warn' | 'off';
  /** install : « Activer » ; update : « Mettre à jour » ; null : rien à proposer. */
  action: 'install' | 'update' | null;
  canRemove: boolean;
}

const list = (u: string[]) => (u.length > 1 ? `${u.slice(0, -1).join(', ')} et ${u.at(-1)}` : u[0] ?? '');

export function deskRootSummary(st: DeskRootStatus): DeskRootSummary {
  const units = st.levels.map((l) => l.unit);
  const zero = st.levels.filter((l) => !(l.low !== null && l.low > 0)).map((l) => l.unit);
  const sim = st.fake ? ' (simulé)' : '';
  let s: DeskRootSummary;
  if (st.files === 'absent') {
    if (st.effective) s = { text: 'Déjà assurée par le système (memory.low posé ailleurs) : rien à faire.', tone: 'ok', action: null, canRemove: false };
    else if (st.targetMB === null) s = { text: 'Réserve du bureau inconnue : rien à proposer pour l’instant.', tone: 'off', action: null, canRemove: false };
    else {
      s = {
        text: `Non activée : ${list(units)} n’ont aucune protection mémoire, celle du bureau reste donc sans effet. « Activer » y pose ${st.targetMB} Mo (réserve du bureau).`,
        tone: 'warn', action: 'install', canRemove: false,
      };
    }
  } else if (st.files === 'installed') {
    s = st.effective
      ? { text: `Active : ${st.installedMB} Mo protégés sur ${list(units)} (memory.low vérifié).`, tone: 'ok', action: null, canRemove: true }
      : { text: `Fichiers en place, mais memory.low reste à 0 sur ${zero.join(', ')} : se déconnecter puis se reconnecter.`, tone: 'warn', action: null, canRemove: true };
  } else {
    s = {
      text: st.installedMB !== null && st.targetMB !== null
        ? `À mettre à jour : posée à ${st.installedMB} Mo, la réserve du bureau est maintenant de ${st.targetMB} Mo.`
        : 'À mettre à jour : fichiers de l’app incomplets ou modifiés à la main.',
      tone: 'warn', action: st.targetMB === null ? null : 'update', canRemove: true,
    };
  }
  return { ...s, text: `${s.text}${sim}` };
}

export function deskRootToast(r: DeskRootResult): { message: string; kind: 'info' | 'error' } {
  return { message: r.message, kind: r.ok || r.reason === 'cancelled' || r.reason === 'stale' ? 'info' : 'error' };
}
