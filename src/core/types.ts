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
}

export interface SystemInfo {
  memTotalKB: number;
  memAvailableKB: number;
  swapTotalKB: number;
  swapFreeKB: number;
  load1: number;
  /** /proc/pressure/memory "some avg10", null si PSI indisponible */
  psiSome10: number | null;
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
}

/** Groupe sans son arbre de processus : ce que reçoit le renderer à chaque snapshot. */
export interface GroupSummary extends Omit<Group, 'roots' | 'subgroups'> {
  subgroups: GroupSummary[];
  categories: Category[];
  instances: InstanceSummary[];
}

/** Ce que le renderer suit : le groupe ouvert dans le détail (son arbre est envoyé) et la recherche en cours. */
export interface Watch {
  groupId: string | null;
  query: string;
  /** Carte « Autres » dépliée sur la page Processus (ses sous-groupes sont alors résumés). */
  othersOpen?: boolean;
}

export interface Snapshot {
  takenAt: number;
  /** UID de l'utilisateur qui fait tourner proc-watch */
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
}

export interface UiConfig {
  /** « Effets visuels réduits » : pas de flou, animations minimales */
  reducedEffects: boolean;
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
}

export interface Config {
  version: 1;
  protected: string[];
  othersThreshold: { memMB: number; cpuPercent: number };
  recorder: RecorderConfig;
  ui: UiConfig;
  classify: ClassifyConfig;
}

export interface ConfigState {
  config: Config;
  warning: string | null;
  /** Entrées regex invalides de la liste protégée */
  invalid: string[];
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
export interface SystemSeries { ts: number[]; memUsedKB: number[]; swapUsedKB: number[]; memTotalKB: number; swapTotalKB: number; psi: (number | null)[]; cpu: number[]; load: number[] }
export interface GroupSeries { key: string; label: string; kind: GroupKind; memKB: (number | null)[] }
export interface GroupsHistory { ts: number[]; series: GroupSeries[] }
export interface GroupHistory { ts: number[]; rssKB: (number | null)[]; swapKB: (number | null)[]; cpu: (number | null)[] }
export interface ProcSeries { pid: number; startTicks: number; memKB: (number | null)[] }
export interface ProcsHistory { ts: number[]; series: ProcSeries[] }
export interface Culprit { key: string; label: string; kind: GroupKind; deltaKB: number; memKB: number }
/** Taille du top par moyenne (`limit`, 10) et du top par pic (`peakLimit`, 8). */
export interface TopOptions { limit?: number; peakLimit?: number }
export interface TopConsumer { key: string; label: string; kind: GroupKind; avgKB: number; maxKB: number; spark: number[] }
/** Les deux classements, calculés en un seul parcours. */
export interface TopResult { byAvg: TopConsumer[]; byMax: TopConsumer[] }
export interface HistoryEvent { ts: number; type: string; groupKey: string | null; groupLabel: string | null; detail: Record<string, unknown> }
export interface RecorderState {
  available: boolean; // systemd utilisateur disponible
  enabled: boolean; // config.recorder.enabled
  running: boolean; // statut écrit il y a moins de 3 intervalles
  status: RecorderStatus | null;
}
export interface RecorderStatus { pid: number; startedAt: number; lastSampleAt: number | null; lastError: string | null; earlyoomSource: 'ok' | 'unavailable'; dbSizeBytes: number; /** Avertissement non bloquant (ex. migration faite sans copie de sécurité) */ warning?: string | null; jobErrors?: Record<'tick' | 'minute' | 'earlyoom', string | null> }
