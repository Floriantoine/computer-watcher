// Réglages (logique pure) : sections de la barre latérale, section mémorisée, points d'attention, saisie modifiée.

import { APP_DISPLAY_NAME } from '../../core/appName';

export type SettingsSection = 'protected' | 'others' | 'display' | 'classify' | 'alerts' | 'rules' | 'recorder' | 'earlyoom' | 'desktop' | 'about';

export const SETTINGS_SECTIONS: { id: SettingsSection; label: string; description: string }[] = [
  { id: 'protected', label: 'Protégés', description: 'Programmes dont le kill demande toujours une confirmation.' },
  { id: 'others', label: 'Carte « Autres »', description: 'Seuils sous lesquels les petits groupes sont rassemblés dans une seule carte.' },
  { id: 'display', label: 'Affichage', description: 'Mémoire affichée, effets visuels et barre des tâches.' },
  { id: 'classify', label: 'Classement', description: 'Classement automatique des instances, ports et corrections manuelles.' },
  { id: 'alerts', label: 'Alertes', description: 'Où chaque type d’alerte est signalé, et à quelle fréquence.' },
  { id: 'rules', label: 'Règles', description: 'Arrêts automatiques sous conditions, exécutés par le service d’enregistrement.' },
  { id: 'recorder', label: 'Enregistrement', description: 'Service d’arrière-plan qui alimente l’onglet Métriques.' },
  { id: 'earlyoom', label: 'earlyoom', description: 'Tue le processus le plus gourmand avant que le système ne gèle.' },
  { id: 'desktop', label: 'Menu des applications', description: `Raccourci ${APP_DISPLAY_NAME} dans le menu du bureau.` },
  { id: 'about', label: 'À propos', description: 'Version installée et mises à jour.' },
];

const IDS = SETTINGS_SECTIONS.map((s) => s.id);

export const SECTION_STORAGE_KEY = 'pw.settingsSection';

export const isSettingsSection = (x: unknown): x is SettingsSection => typeof x === 'string' && (IDS as string[]).includes(x);

/** Section ouverte : celle demandée par la route (lien profond), sinon la dernière mémorisée, sinon Protégés. */
export function initialSection(fromRoute: unknown, stored: unknown): SettingsSection {
  if (isSettingsSection(fromRoute)) return fromRoute;
  if (isSettingsSection(stored)) return stored;
  return 'protected';
}

const defaultStorage = (): Storage | undefined => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

/** Section mémorisée ; stockage absent, qui lève ou valeur inconnue → null. */
export function readStoredSection(storage: Pick<Storage, 'getItem'> | null | undefined = defaultStorage()): SettingsSection | null {
  try {
    const v = storage?.getItem(SECTION_STORAGE_KEY);
    return isSettingsSection(v) ? v : null;
  } catch {
    return null;
  }
}

/** Mémorise la section ; stockage indisponible → valable pour la session seulement. */
export function writeStoredSection(s: SettingsSection, storage: Pick<Storage, 'setItem'> | undefined = defaultStorage()): void {
  try {
    storage?.setItem(SECTION_STORAGE_KEY, s);
  } catch {
    /* stockage indisponible */
  }
}

/** Navigation clavier dans la barre : flèches (avec bouclage), Début, Fin ; autre touche → null. */
export function sectionByKey(current: SettingsSection, key: string): SettingsSection | null {
  const i = IDS.indexOf(current);
  const n = IDS.length;
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return IDS[(i + 1) % n]!;
    case 'ArrowUp':
    case 'ArrowLeft':
      return IDS[(i - 1 + n) % n]!;
    case 'Home':
      return IDS[0]!;
    case 'End':
      return IDS[n - 1]!;
    default:
      return null;
  }
}

/** Formulaire numérique modifié par rapport aux valeurs enregistrées (même nombre écrit autrement : non modifié). */
export function numbersDirty(form: Record<string, string>, saved: Record<string, number>): boolean {
  return Object.keys(form).some((k) => {
    const raw = form[k]!.trim();
    if (raw === '') return true;
    const n = Number(raw);
    return !Number.isFinite(n) || n !== saved[k];
  });
}

const lines = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean);

/** Texte multiligne modifié (lignes vides et espaces en bord ignorés). */
export function linesDirty(a: string, b: string): boolean {
  const x = lines(a);
  const y = lines(b);
  return x.length !== y.length || x.some((l, i) => l !== y[i]);
}

export interface FormState { dirty: boolean; invalid: boolean }
export interface AttentionInput {
  /** Texte du champ « Ajouter » des protégés. */
  protectedEntry: string;
  protectedList: readonly string[];
  others: FormState;
  alerts: FormState;
  /** null : pas encore lu. */
  recorder: FormState & { status: { available: boolean; enabled: boolean; running: boolean } | null };
  earlyoom: FormState & { status: { installed: boolean; active: string; enabled?: string } | null };
  /** Réglages › Règles : éditeur ouvert (modifié, invalide) et règles du fichier refusées. */
  rules?: FormState & { issues: number };
}
export type AttentionTone = 'error' | 'dirty' | 'warn';
export interface Attention { tone: AttentionTone; reasons: string[] }

const INVALID = 'Valeur invalide';
const DIRTY = 'Modifications non enregistrées';

function attention(form: FormState | null, warning: string | null): Attention | undefined {
  const reasons: string[] = [];
  if (form?.invalid) reasons.push(INVALID);
  if (form?.dirty) reasons.push(DIRTY);
  if (warning) reasons.push(warning);
  if (!reasons.length) return undefined;
  const tone: AttentionTone = form?.invalid ? 'error' : form?.dirty ? 'dirty' : 'warn';
  return { tone, reasons };
}

function recorderWarning(s: AttentionInput['recorder']['status']): string | null {
  if (!s) return null;
  if (!s.available) return 'systemd utilisateur indisponible';
  if (!s.enabled) return 'Enregistrement désactivé';
  if (!s.running) return 'Le service d’enregistrement ne répond pas';
  return null;
}

function earlyoomWarning(s: AttentionInput['earlyoom']['status']): string | null {
  if (!s) return null;
  if (!s.installed) return 'earlyoom n’est pas installé';
  if (s.active !== 'active') return 'earlyoom n’est pas actif';
  if (s.enabled === 'disabled') return 'earlyoom ne démarre pas avec le système';
  return null;
}

/** earlyoom absent, arrêté ou pas lancé au démarrage : point rouge tant que ce n'est pas réglé (B8 bis), quel que soit le formulaire. */
function earlyoomAttention(i: AttentionInput['earlyoom']): Attention | undefined {
  const a = attention(i, earlyoomWarning(i.status));
  return a && earlyoomWarning(i.status) ? { ...a, tone: 'error' } : a;
}

/** Points de la barre latérale : section → ton (invalide > modifié > avertissement) et raisons (infobulle). */
export function sectionAttention(i: AttentionInput): Partial<Record<SettingsSection, Attention>> {
  const entry = i.protectedEntry.trim();
  const out: Partial<Record<SettingsSection, Attention>> = {
    protected: entry && !i.protectedList.includes(entry) ? { tone: 'dirty', reasons: ['Saisie pas encore ajoutée'] } : undefined,
    others: attention(i.others, null),
    alerts: attention(i.alerts, null),
    recorder: attention(i.recorder, recorderWarning(i.recorder.status)),
    earlyoom: earlyoomAttention(i.earlyoom),
    rules: i.rules?.issues
      ? { tone: 'error', reasons: [`${i.rules.issues} règle${i.rules.issues > 1 ? 's' : ''} invalide${i.rules.issues > 1 ? 's' : ''} ignorée${i.rules.issues > 1 ? 's' : ''}`] }
      : attention(i.rules ?? null, null),
  };
  for (const k of Object.keys(out) as SettingsSection[]) if (!out[k]) delete out[k];
  return out;
}

/** Section des réglages liée à une alerte : un kill earlyoom ouvre earlyoom, le reste ouvre Alertes. */
export function settingsSectionForAlert(type: string): SettingsSection {
  return type === 'earlyoom_kill' ? 'earlyoom' : 'alerts';
}

/** Aperçu « Nouveau » : jetons (séparés par les espaces) absents de la ligne actuelle, à surligner. */
export function tokenDiff(current: string | null, next: string): { text: string; changed: boolean }[] {
  const parts = next.split(/(\s+)/).filter((p) => p !== '');
  if (current === null) return parts.map((text) => ({ text, changed: false }));
  const left = new Map<string, number>();
  for (const t of current.split(/\s+/)) if (t) left.set(t, (left.get(t) ?? 0) + 1);
  return parts.map((text) => {
    if (/^\s+$/.test(text)) return { text, changed: false };
    const n = left.get(text) ?? 0;
    if (n > 0) {
      left.set(text, n - 1);
      return { text, changed: false };
    }
    return { text, changed: true };
  });
}
