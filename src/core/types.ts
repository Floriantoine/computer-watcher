import type { AlertsConfig } from './alerts';
import type { EarlyoomSettings } from './earlyoom';
import type { EarlyoomEnabled, EarlyoomReminderConfig } from './earlyoomSetup';
import type { RuleIssue, RulesConfig } from './rules/types';
import type { OpenPortsInfo } from './openPorts';

export interface ProcSample {
  pid: number;
  ppid: number;
  /** Nom court, tel que dans /proc/<pid>/status (Name) */
  name: string;
  /** Ligne de commande complète, ou "[name]" pour un thread noyau */
  cmdline: string;
  uid: number;
  /** starttime brut de /proc/<pid>/stat, en ticks depuis le boot (sert à détecter la réutilisation d'un PID) */
  startTicks: number;
  ageSec: number;
  /** utime + stime en ticks */
  cpuTicks: number;
  rssKB: number;
  swapKB: number;
  /** Dossier de travail, null si illisible */
  cwd: string | null;
  cwdDeleted: boolean;
}

export interface ProcInfo extends ProcSample {
  /** % d'un cœur, comme top */
  cpuPercent: number;
  /** Mode PSS : PSS demandé mais illisible (autre utilisateur, hidepid…) ; rssKB reste alors le RSS. */
  pssDenied?: boolean;
  /** Mode PSS : processus affiché pas encore lu (lectures étalées sur plusieurs passes) ; rssKB reste le RSS. */
  pssPending?: boolean;
}

export interface SystemInfo {
  memTotalKB: number;
  memAvailableKB: number;
  swapTotalKB: number;
  swapFreeKB: number;
  load1: number;
  /** /proc/pressure/memory "some avg10", null si PSI indisponible */
  psiSome10: number | null;
  /** Champ Shmem de /proc/meminfo : fichiers en mémoire (/tmp, /dev/shm) et mémoire partagée */
  shmemKB: number | null;
}

export interface ProcNode {
  proc: ProcInfo;
  children: ProcNode[];
}

export type GroupKind = 'claude' | 'app' | 'project' | 'deleted' | 'command' | 'others';

export interface Group {
  id: string;
  kind: GroupKind;
  label: string;
  /** Noms de commandes distincts, affichés en badges (projets uniquement) */
  tags: string[];
  /** Nom de processus ajouté à la liste protégée par le bouton « Protéger » */
  rootName: string;
  roots: ProcNode[];
  pids: number[];
  procCount: number;
  cpuPercent: number;
  rssKB: number;
  swapKB: number;
  oldestAgeSec: number;
  protected: boolean;
  killable: boolean;
  /** Seulement pour la carte « Autres » */
  subgroups: Group[];
  /** Pids sortis d'une session Claude (outil de dev lancé par Claude dans un projet, et ses descendants) ; absent si aucun. */
  launchedByClaude?: number[];
}

/** Groupe sans son arbre de processus : ce que reçoit le renderer à chaque snapshot. */
export interface GroupSummary extends Omit<Group, 'roots' | 'subgroups' | 'launchedByClaude'> {
  subgroups: GroupSummary[];
  /** Mode PSS : processus du groupe comptés en RSS (PSS illisible ou pas encore lu) ; absent si aucun ou en RSS. */
  pssFallback?: number;
  categories: Category[];
  instances: InstanceSummary[];
}

/** Ce que le renderer suit : le groupe ouvert dans le détail (son arbre est envoyé) et la recherche en cours. */
export interface Watch {
  groupId: string | null;
  query: string;
  /** Carte « Autres » dépliée sur la page Processus (ses sous-groupes sont alors résumés). */
  othersOpen?: boolean;
  /** Panneau « Ports ouverts » affiché : les ports de tous les processus de l'utilisateur sont lus. */
  ports?: boolean;
}

export interface Snapshot {
  takenAt: number;
  /** UID de l'utilisateur qui fait tourner l'app */
  currentUid: number;
  system: SystemInfo;
  /** Les sous-groupes de « Autres » ne sont détaillés que quand « Autres » est déplié, ou lui ou l'un d'eux suivi (sinon liste vide). */
  groups: GroupSummary[];
  /** Ids de tous les groupes, sous-groupes de « Autres » compris */
  groupIds: string[];
  /** Recherche (déjà nettoyée) pour laquelle `matches` a été calculé */
  query: string;
  /** Ids des groupes de premier niveau dont le libellé, une commande ou un dossier contient `query` ; null sans recherche */
  matches: string[] | null;
  /** `Watch.groupId` pour lequel ce snapshot a été construit (le détail attend ce snapshot avant de conclure) */
  watched: string | null;
  /** Arbre du groupe suivi (`Watch.groupId`), null si aucun ou s'il n'existe plus */
  detail: { groupId: string; roots: ProcNode[] } | null;
  /** Mémoire affichée : 'pss' → les rssKB des processus et des groupes sont des PSS (repli RSS signalé par pssDenied). */
  memMetric: MemoryMetric;
  /** Ports ouverts : non nul seulement si `Watch.ports` ou une recherche de port (`:3000`). */
  openPorts: OpenPortsInfo | null;
}

export interface RecorderConfig {
  enabled: boolean;
  intervalSec: number;
  detailHours: number;
  summaryDays: number;
  procMinMemMB: number;
  procMinCpuPercent: number;
  /** Groupes enregistrés individuellement si RAM+swap ≥ ce seuil (ou CPU ≥ procMinCpuPercent) ; les autres sont cumulés dans « Petits groupes ». */
  groupMinMemMB: number;
  leakMinMinutes: number;
  leakMinGrowthMB: number;
  /** Alerte « fichiers en mémoire » quand Shmem dépasse ce seuil (Mo). */
  tmpfsAlertMB: number;
  /** Alerte « disque presque plein » : libre sous max(diskAlertPercent % de la taille, diskAlertGB Go). */
  diskAlertPercent: number;
  diskAlertGB: number;
}

/** Mémoire affichée en direct : RSS (rapide) ou PSS (mémoire partagée répartie, lue dans smaps_rollup). */
export type MemoryMetric = 'rss' | 'pss';

export interface UiConfig {
  /** « Effets visuels réduits » : pas de flou, animations minimales */
  reducedEffects: boolean;
  /** Absent d'une config existante → 'rss'. L'historique reste toujours en RSS. */
  memoryMetric: MemoryMetric;
  /** Icône dans la barre des tâches (zone de notification) */
  trayIcon: boolean;
  /** Fermer la fenêtre la garde dans la barre des tâches (sans effet sans icône ou sans zone de notification) */
  closeToTray: boolean;
  /** Vue swap : seuil de swap cumulé (Mo) au-delà duquel un processus inactif est « endormi » */
  swapSleepMinMB: number;
}

export type { Category } from './classify/categories';
import type { Category } from './classify/categories';

export interface ClassifyConfig { detectPorts: boolean; overrides: Record<string, Category> }

export interface InstanceSummary {
  key: string; groupId: string; project: string | null; category: Category;
  source: 'manual' | 'command' | 'port' | 'package' | 'name' | 'unknown';
  signature: string; label: string; rootPid: number; rootStartTicks: number; pids: number[]; ports: number[];
  ageSec: number; rssKB: number; swapKB: number; cpuPercent: number;
  /** En double : même projet, même catégorie et même signature qu'une instance plus ancienne (instances reconnues seulement). */
  duplicate: boolean; protected: boolean;
  /** Instance lancée par une session Claude (sa racine sortie de la carte Claude vers son projet). */
  launchedBy?: 'claude';
}

export interface Config {
  version: 1;
  protected: string[];
  othersThreshold: { memMB: number; cpuPercent: number };
  recorder: RecorderConfig;
  ui: UiConfig;
  classify: ClassifyConfig;
  alerts: AlertsConfig;
  /** Règles automatiques (⑥) : éteintes par défaut. */
  rules: RulesConfig;
  /** « Ne plus rappeler pendant 7 jours » du pop-up earlyoom (horodatage du main) ; absent : rappel au lancement. */
  earlyoomReminder?: EarlyoomReminderConfig;
}

export interface ConfigState {
  config: Config;
  warning: string | null;
  /** Entrées regex invalides de la liste protégée */
  invalid: string[];
  /** Règles du fichier refusées par la validation (ignorées seules), affichées dans Réglages › Règles. */
  ruleIssues?: RuleIssue[];
}

/** PID + startTicks : startTicks identifie le processus et détecte un PID réutilisé. */
export interface KillTarget {
  pid: number;
  startTicks: number;
}

export type KillSignal = 'SIGTERM' | 'SIGKILL';

/** Réponse de `instances:targets` pour une clé (instance, ou groupe pour ses lanceurs). */
export interface InstanceTargets {
  key: string;
  targets: KillTarget[];
  /** Nom du processus de chaque cible (même ordre), pour revérifier la protection au moment du kill. */
  names: string[];
  /** Clé de groupe seulement : instances (tous groupes) dont la racine descend d'un de ses lanceurs. */
  covers?: string[];
}

export interface KillResult {
  pid: number;
  ok: boolean;
  /** Code errno (EPERM, ESRCH…) ou SELF quand le garde-fou refuse */
  error?: string;
}

export type RangePreset = '1h' | '6h' | '24h' | '7d' | '30d';
export interface TimeRange { from: number; to: number }
export interface SystemSeries {
  ts: number[]; memUsedKB: number[]; swapUsedKB: number[]; memTotalKB: number; swapTotalKB: number; psi: (number | null)[]; cpu: number[]; load: number[];
  /** Fichiers en mémoire (Shmem) au pic du bucket ; null avant v4 (base non migrée ou données antérieures). */
  shmemKB: (number | null)[];
  /** Somme des pics de tous les groupes par bucket ; null si aucun groupe enregistré dans le bucket. */
  groupsKB: (number | null)[];
}
/** Espace libre par partition surveillée (schéma v6) : libre au plus bas de chaque bucket, taille la plus récente. */
export interface DiskSeries { mount: string; sizeKB: number; availKB: (number | null)[] }
export interface DiskHistory { ts: number[]; series: DiskSeries[] }
export interface GroupSeries { key: string; label: string; kind: GroupKind; memKB: (number | null)[] }
export interface GroupsHistory { ts: number[]; series: GroupSeries[] }
/** `procCount` : nombre de processus (max du bucket), seulement depuis les échantillons détaillés. */
export interface GroupHistory { ts: number[]; rssKB: (number | null)[]; swapKB: (number | null)[]; cpu: (number | null)[]; procCount?: (number | null)[] }
export interface ProcSeries { pid: number; startTicks: number; memKB: (number | null)[] }
export interface ProcsHistory { ts: number[]; series: ProcSeries[] }
export interface Culprit { key: string; label: string; kind: GroupKind; deltaKB: number; memKB: number }
/** Taille du top par moyenne (`limit`, 10) et du top par pic (`peakLimit`, 8). */
export interface TopOptions { limit?: number; peakLimit?: number }
export interface TopConsumer { key: string; label: string; kind: GroupKind; avgKB: number; maxKB: number; spark: number[] }
/** Les deux classements, calculés en un seul parcours. */
export interface TopResult { byAvg: TopConsumer[]; byMax: TopConsumer[] }
/** Processus enregistré d'un groupe à un instant (rejeu) ; swapKB null pour les agrégats par minute. */
export interface ProcTreeRow { pid: number; startTicks: number; ppid: number | null; name: string; rssKB: number; swapKB: number | null; cpu: number; sampleTs: number; lastSeenTs: number }
/**
 * `recorded` : le service échantillonnait autour de ts (sinon trou d'enregistrement) ; `omitted` : processus au-delà
 * des PROC_TREE_MAX plus gros, non renvoyés.
 */
export interface ProcTreeAt { ts: number; source: 'detail' | 'minute'; procs: ProcTreeRow[]; recorded: boolean; omitted: number }
/** Taille et occupation du système de fichiers de /tmp (statfs), et RAM totale, en Ko : tuiles de la page /tmp. */
export interface TmpFsStats {
  /** Racine lue (« /tmp », sauf racine de test). */
  root: string;
  sizeKB: number;
  usedKB: number;
  memTotalKB: number;
  /** tmpfs (ou ramfs) : ses fichiers occupent la RAM ; faux pour un /tmp sur disque. */
  inRam: boolean;
}
export interface TmpDirUsage { path: string; sizeKB: number }
/** Occupation actuelle de /tmp (tmpfs, en RAM), calculée à la demande par le main, en lecture seule. */
export interface TmpUsage {
  /** Plus gros dossiers de premier niveau, décroissants */
  dirs: TmpDirUsage[];
  /** Fichiers posés directement dans /tmp (cumul) */
  rootFilesKB: number;
  /** Dossiers illisibles ignorés */
  skipped: number;
  /** Arrêt au plafond d'entrées ou de durée : tailles « au moins » */
  truncated: boolean;
}
export interface HistoryEvent { ts: number; type: string; groupKey: string | null; groupLabel: string | null; detail: Record<string, unknown> }
export interface RecorderState {
  available: boolean; // systemd utilisateur disponible
  enabled: boolean; // config.recorder.enabled
  running: boolean; // statut écrit il y a moins de 3 intervalles
  status: RecorderStatus | null;
}
export interface RecorderStatus { pid: number; startedAt: number; lastSampleAt: number | null; lastError: string | null; earlyoomSource: 'ok' | 'unavailable'; dbSizeBytes: number; /** Avertissement non bloquant (ex. migration faite sans copie de sécurité) */ warning?: string | null; jobErrors?: Partial<Record<'tick' | 'minute' | 'earlyoom' | 'rules', string | null>>; /** Prévision ② : en préparation (moins de 6 min depuis le démarrage), calculée, ou indisponible (moins de 5 échantillons sur 5 min) */ forecast?: 'warming' | 'ok' | 'unavailable' }

/** État d'earlyoom vu par l'app (Réglages › earlyoom). */
export interface EarlyoomStatus {
  /** /usr/bin/earlyoom (ou PROC_WATCH_EARLYOOM_BIN, pour les captures) */
  installed: boolean;
  /** Sortie de `earlyoom -v` (« earlyoom 1.9.0 » → « 1.9.0 ») */
  version: string | null;
  /** `systemctl is-active earlyoom` */
  active: 'active' | 'inactive' | 'failed' | 'unknown';
  /** `systemctl is-enabled earlyoom` (lancé au démarrage) */
  enabled: EarlyoomEnabled;
  /** /etc/default/earlyoom lu */
  file: { settings: EarlyoomSettings; converted: string[]; line: string } | null;
  installHint: string;
}
export type ApplyResult =
  | { ok: true; line: string }
  /** stale : l'état d'earlyoom a changé depuis l'affichage (installation, activation) : rien à faire ou autre action. */
  | { ok: false; reason: 'cancelled' | 'invalid' | 'failed' | 'unavailable' | 'stale'; message: string };
