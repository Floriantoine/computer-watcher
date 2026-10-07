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

export interface Config {
  version: 1;
  protected: string[];
  othersThreshold: { memMB: number; cpuPercent: number };
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
