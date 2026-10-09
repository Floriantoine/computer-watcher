// Installation / activation d'earlyoom depuis l'app (B8 bis) : logique pure partagée par le main et le renderer.
import { buildEarlyoomArgs, type EarlyoomSettings } from './earlyoom';

/** Seul paramètre de mode accepté du renderer et transmis au script root, comparé à l'identique (jamais interprété). */
export type EarlyoomSetupMode = 'install' | 'activate';
export const isSetupMode = (x: unknown): x is EarlyoomSetupMode => x === 'install' || x === 'activate';

/** `systemctl is-enabled earlyoom` réduit à ce qui compte ici. */
export type EarlyoomEnabled = 'enabled' | 'disabled' | 'masked' | 'other' | 'unknown';

export interface EarlyoomServiceState {
  installed: boolean;
  active: 'active' | 'inactive' | 'failed' | 'unknown';
  enabled: EarlyoomEnabled;
}

/** Valeurs par défaut de la ligne (formulaire de Réglages › earlyoom et installation) : 8,5 / 35,25, aucune préférence. */
export const EARLYOOM_DEFAULT_SETTINGS: Readonly<EarlyoomSettings> = Object.freeze({ memTerm: 8, memKill: 5, swapTerm: 35, swapKill: 25, prefer: [] as string[] });

/**
 * Ce qu'il reste à faire : installer (binaire absent), activer (installé mais arrêté, ou pas lancé au démarrage) ou rien.
 * Masqué : choix délibéré de l'utilisateur, on ne propose rien. État inconnu (systemctl absent ou muet) : rien non plus.
 */
export function setupNeed(s: EarlyoomServiceState): EarlyoomSetupMode | null {
  if (!s.installed) return 'install';
  if (s.enabled === 'masked') return null;
  if (s.active === 'inactive' || s.active === 'failed' || s.enabled === 'disabled') return 'activate';
  return null;
}

export const EARLYOOM_REMINDER_SNOOZE_MS = 7 * 24 * 3600_000;

/** Config : « Ne plus rappeler pendant 7 jours » cliqué à `snoozedAt` (horodatage du main, jamais du renderer). */
export interface EarlyoomReminderConfig { snoozedAt: number }

/** Entrée de config illisible → absente (le rappel revient) ; jamais une raison d'invalider toute la config. */
export function validateEarlyoomReminder(raw: unknown): EarlyoomReminderConfig | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const t = (raw as Record<string, unknown>).snoozedAt;
  return Number.isSafeInteger(t) && (t as number) >= 0 ? { snoozedAt: t as number } : undefined;
}

/** Pause en cours : cliquée il y a moins de 7 jours. Un horodatage futur (horloge reculée, fichier édité) est ignoré : la pause ne dépasse jamais 7 jours. */
export function reminderSnoozed(snoozedAt: number | undefined, now: number): boolean {
  if (snoozedAt === undefined || !Number.isSafeInteger(snoozedAt) || snoozedAt < 0) return false;
  return snoozedAt <= now && now - snoozedAt < EARLYOOM_REMINDER_SNOOZE_MS;
}

/** Pop-up du lancement : mode à proposer, ou null (rien à faire, « Plus tard » cliqué dans cette session, ou pause de 7 jours). */
export function reminderMode(o: { status: EarlyoomServiceState; snoozedAt: number | undefined; later: boolean; now: number }): EarlyoomSetupMode | null {
  if (o.later || reminderSnoozed(o.snoozedAt, o.now)) return null;
  return setupNeed(o.status);
}

/** Réglages de la ligne écrite : ceux du fichier existant s'ils respectent la politique, sinon les valeurs par défaut. */
export function setupSettings(file: { settings: EarlyoomSettings } | null): EarlyoomSettings {
  if (file && buildEarlyoomArgs(file.settings, []).ok) return { ...file.settings, prefer: [...file.settings.prefer] };
  return { ...EARLYOOM_DEFAULT_SETTINGS, prefer: [] };
}

/**
 * Gestionnaires de paquets reconnus, dans l'ordre de détection (chemins absolus, jamais le PATH), avec leur commande
 * d'installation non interactive. Le script root est généré depuis cette constante (paquet constant : earlyoom).
 */
export const PACKAGE_MANAGERS = [
  { name: 'pacman', varName: 'pacman', path: '/usr/bin/pacman', args: ['-S', '--needed', '--noconfirm', 'earlyoom'] },
  {
    name: 'apt-get', varName: 'apt_get', path: '/usr/bin/apt-get',
    // confold : un /etc/default/earlyoom déjà présent est gardé sans question (proc-watch l'écrit ensuite, avec .bak).
    args: ['-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', 'install', '-y', 'earlyoom'],
  },
  { name: 'dnf', varName: 'dnf', path: '/usr/bin/dnf', args: ['install', '-y', 'earlyoom'] },
  { name: 'zypper', varName: 'zypper', path: '/usr/bin/zypper', args: ['--non-interactive', 'install', 'earlyoom'] },
] as const;
export type PackageManagerName = (typeof PACKAGE_MANAGERS)[number]['name'];

/** Pour la confirmation seulement : le script root refait la détection lui-même. */
export function detectPackageManager(exists: (p: string) => boolean): PackageManagerName | null {
  return PACKAGE_MANAGERS.find((m) => exists(m.path))?.name ?? null;
}
