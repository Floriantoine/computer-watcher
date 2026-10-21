// Réglages → Plafond de travail, « Lancer les commandes lourdes directement dans le budget » : textes et décisions (logique pure).
import { WRAP_LABELS, type WrapApplyResponse, type WrapItemStatus, type WrapPart, type WrapSetupStatus } from '../../core/wrapSetup';

export const WRAP_TITLE = 'Lancer les commandes lourdes directement dans le budget';

/** Pourquoi, en deux phrases. */
export const WRAP_WHY =
  'Un test lancé depuis un terminal ou par Claude Code démarre hors du plafond : le service ne l’y déplace qu’après coup, et la mémoire qu’il a déjà allouée reste comptée ailleurs (terminal, Claude) jusqu’à sa fin. ' +
  'Ces trois éléments font démarrer jest, vitest, tsc, npm test… directement dans le budget du projet, sans rien changer à ce que vous tapez.';

export const WRAP_LIMITS: readonly string[] = [
  'Warp a son propre éditeur de ligne : le bloc zsh peut ne pas y agir (le hook Claude Code, lui, ne dépend pas du terminal).',
  'Le hook ne vaut que pour les nouvelles sessions de Claude Code ; le bloc zsh, pour les nouveaux terminaux.',
  'Les règles d’autorisation « Bash(npm test:*) » de Claude Code ne reconnaîtront plus la commande réécrite (computer-watcher run -- npm test) : Claude demandera plus souvent.',
];

export const WRAP_ROLE: Record<WrapPart, string> = {
  command: 'Appelée par zsh et par Claude Code pour décider si une ligne passe dans le budget.',
  zshrc: 'Réécrit à la volée, avant leur lancement, les commandes lourdes tapées dans un terminal zsh.',
  claude: 'Hook PreToolUse : les commandes Bash lourdes de Claude Code passent par « computer-watcher run ».',
};

export const wrapItemTitle = (i: WrapItemStatus) => WRAP_LABELS[i.part];

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

export function stateBadge(i: WrapItemStatus): { text: string; tone: Tone } {
  switch (i.state) {
    case 'ours':
      return i.ok ? { text: 'Installé', tone: 'ok' } : { text: 'À mettre à jour', tone: 'warn' };
    case 'foreign':
      return i.ok ? { text: 'Déjà en place (pas de Computer Watcher)', tone: 'ok' } : { text: 'Présent, pas de Computer Watcher', tone: 'warn' };
    case 'unreadable':
      return { text: 'Illisible', tone: 'bad' };
    default:
      return { text: 'Absent', tone: 'muted' };
  }
}

/** Titre de l'aperçu : ce que « Installer » ajoute, ou ce qui est en place. */
export function previewLabel(i: WrapItemStatus): string {
  if (i.state === 'ours') return 'Ajouté par Computer Watcher :';
  return i.part === 'command' ? 'Fichier créé par « Installer » :' : i.part === 'zshrc' ? 'Ajouté à la fin du fichier :' : 'Ajouté à settings.json (le reste inchangé) :';
}

export function summaryLine(s: WrapSetupStatus): string {
  if (s.complete) return 'Tout est en place : les commandes lourdes démarrent directement dans le budget de leur projet.';
  const n = s.items.filter((i) => i.ok).length;
  return `${n} élément${n > 1 ? 's' : ''} sur ${s.items.length} en place.`;
}

export const canInstallAll = (s: WrapSetupStatus) => s.items.some((i) => i.canInstall);

/** Toast après « Installer » / « Retirer » ; null si annulé. */
export function applyToast(r: WrapApplyResponse, action: 'install' | 'remove'): { message: string; kind: 'info' | 'error' } | null {
  if (r.cancelled) return null;
  if (r.errors.length) return { message: r.errors.map((e) => `${WRAP_LABELS[e.part]} : ${e.error}`).join(' — '), kind: 'error' };
  const changed = r.results.filter((x) => x.changed);
  if (!changed.length) return { message: 'Rien à faire : déjà en place', kind: 'info' };
  const what = changed.map((x) => WRAP_LABELS[x.part]).join(', ');
  const bak = changed.filter((x) => x.backup).length;
  const saved = bak ? ` (sauvegarde${bak > 1 ? 's' : ''} à côté des fichiers)` : '';
  return { message: `${action === 'install' ? 'Installé' : 'Retiré'} : ${what}${saved}`, kind: 'info' };
}

// ---------------------------------------------------------------- rappel au lancement

export const WRAP_REMINDER = {
  title: 'Commandes lourdes : les lancer dans le budget',
  body: 'Le Plafond de travail est actif, mais les tests lancés depuis un terminal ou par Claude Code démarrent encore hors budget. Un réglage les y fait démarrer directement.',
  go: 'Voir le réglage',
  later: 'Plus tard',
  never: 'Ne plus afficher',
};
