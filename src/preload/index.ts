import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  Category, Config, ConfigState, Culprit, InstanceTargets, ProcInfo, Watch, GroupHistory, GroupsHistory, HistoryEvent, KillResult, KillTarget, KillSignal, ProcsHistory, RangePreset,
  RecorderState, Snapshot, SystemSeries, TimeRange, TmpUsage, TopOptions, TopResult,
} from '../core/types';

const api = {
  onSnapshot(cb: (s: Snapshot) => void): () => void {
    const handler = (_e: IpcRendererEvent, s: Snapshot) => cb(s);
    ipcRenderer.on('snapshot', handler);
    return () => {
      ipcRenderer.removeListener('snapshot', handler);
    };
  },
  /** false quand la collecte en direct est suspendue (fenêtre réduite ou cachée), true à la reprise. */
  onLive(cb: (live: boolean) => void): () => void {
    const handler = (_e: IpcRendererEvent, live: boolean) => cb(live);
    ipcRenderer.on('live', handler);
    return () => {
      ipcRenderer.removeListener('live', handler);
    };
  },
  /** Groupe ouvert dans le détail (son arbre arrive dans les snapshots) et recherche en cours. */
  watch: (w: Watch): Promise<void> => ipcRenderer.invoke('watch', w),
  /** Processus d'un groupe (dernier snapshot), pour préparer un kill de groupe. */
  groupProcs: (groupId: string): Promise<ProcInfo[]> => ipcRenderer.invoke('group:procs', groupId),
  kill: (targets: KillTarget[], signal: KillSignal): Promise<KillResult[]> => ipcRenderer.invoke('kill', targets, signal),
  getConfig: (): Promise<ConfigState> => ipcRenderer.invoke('config:get'),
  setConfig: (c: Config): Promise<ConfigState> => ipcRenderer.invoke('config:set', c),
  installDesktopEntry: (): Promise<string> => ipcRenderer.invoke('desktop:install'),
  classify: {
    /** Correction manuelle (`scope` = racine du projet ou id du groupe) ; `null` : retour à l'automatique. */
    set: (scope: string, signature: string, category: Category | null): Promise<ConfigState> =>
      ipcRenderer.invoke('classify:set', scope, signature, category),
    /** Clés (≤ 200) des instances sans CPU ≥ 1 % depuis `sinceMs` ; null si l'historique est absent. */
    inactive: (keys: string[], sinceMs: number): Promise<string[] | null> => ipcRenderer.invoke('classify:inactive', keys, sinceMs),
  },
  instances: {
    /** Cibles de kill (≤ 200 clés) du dernier snapshot : processus d'une instance, ou lanceurs (et instances couvertes) pour une clé de groupe. */
    targets: (keys: string[]): Promise<InstanceTargets[]> => ipcRenderer.invoke('instances:targets', keys),
  },
  history: {
    system: (r: RangePreset | TimeRange): Promise<SystemSeries | null> => ipcRenderer.invoke('history:system', r),
    groups: (r: RangePreset | TimeRange, keys?: string[]): Promise<GroupsHistory | null> => ipcRenderer.invoke('history:groups', r, keys),
    group: (key: string, r: RangePreset | TimeRange): Promise<GroupHistory | null> => ipcRenderer.invoke('history:group', key, r),
    procs: (key: string, r: RangePreset | TimeRange): Promise<ProcsHistory | null> => ipcRenderer.invoke('history:procs', key, r),
    culprits: (ts: number): Promise<Culprit[]> => ipcRenderer.invoke('history:culprits', ts),
    top: (r: RangePreset | TimeRange, o?: TopOptions): Promise<TopResult> => ipcRenderer.invoke('history:top', r, o),
    events: (r: RangePreset | TimeRange): Promise<HistoryEvent[]> => ipcRenderer.invoke('history:events', r),
  },
  tmp: {
    /** Plus gros dossiers de /tmp à cet instant (lecture seule, au plus 100 000 entrées ou 2 s). */
    topDirs: (): Promise<TmpUsage> => ipcRenderer.invoke('tmp:topDirs'),
  },
  recorder: {
    status: (): Promise<RecorderState> => ipcRenderer.invoke('recorder:status'),
    setEnabled: (enabled: boolean): Promise<RecorderState> => ipcRenderer.invoke('recorder:setEnabled', enabled),
    clearHistory: (): Promise<{ mode: 'deleted' | 'requested'; backups: number }> => ipcRenderer.invoke('recorder:clearHistory'),
  },
};

contextBridge.exposeInMainWorld('procWatch', api);

export type ProcWatchApi = typeof api;
