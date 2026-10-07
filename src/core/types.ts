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

export interface Snapshot {
  takenAt: number;
  /** UID de l'utilisateur qui fait tourner proc-watch */
  currentUid: number;
  system: SystemInfo;
  groups: Group[];
}

export interface RecorderConfig {
  enabled: boolean;
  intervalSec: number;
  detailHours: number;
  summaryDays: number;
  procMinMemMB: number;
  procMinCpuPercent: number;
  leakMinMinutes: number;
  leakMinGrowthMB: number;
}

export interface Config {
  version: 1;
  protected: string[];
  othersThreshold: { memMB: number; cpuPercent: number };
  recorder: RecorderConfig;
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
export interface TopConsumer { key: string; label: string; kind: GroupKind; avgKB: number; maxKB: number; spark: number[] }
export interface HistoryEvent { ts: number; type: string; groupKey: string | null; groupLabel: string | null; detail: Record<string, unknown> }
export interface RecorderState {
  available: boolean; // systemd utilisateur disponible
  enabled: boolean; // config.recorder.enabled
  running: boolean; // statut écrit il y a moins de 3 intervalles
  status: RecorderStatus | null;
}
export interface RecorderStatus { pid: number; startedAt: number; lastSampleAt: number | null; lastError: string | null; earlyoomSource: 'ok' | 'unavailable'; dbSizeBytes: number; jobErrors?: Record<'tick' | 'minute' | 'earlyoom', string | null> }
