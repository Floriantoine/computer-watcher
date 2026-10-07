import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  Config, ConfigState, Culprit, GroupHistory, GroupsHistory, HistoryEvent, KillResult, KillTarget, KillSignal, ProcsHistory, RangePreset,
  RecorderState, Snapshot, SystemSeries, TimeRange, TopOptions, TopResult,
} from '../core/types';

const api = {
  onSnapshot(cb: (s: Snapshot) => void): () => void {
    const handler = (_e: IpcRendererEvent, s: Snapshot) => cb(s);
    ipcRenderer.on('snapshot', handler);
    return () => {
      ipcRenderer.removeListener('snapshot', handler);
    };
  },
  kill: (targets: KillTarget[], signal: KillSignal): Promise<KillResult[]> => ipcRenderer.invoke('kill', targets, signal),
  getConfig: (): Promise<ConfigState> => ipcRenderer.invoke('config:get'),
  setConfig: (c: Config): Promise<ConfigState> => ipcRenderer.invoke('config:set', c),
  installDesktopEntry: (): Promise<string> => ipcRenderer.invoke('desktop:install'),
  history: {
    system: (r: RangePreset | TimeRange): Promise<SystemSeries | null> => ipcRenderer.invoke('history:system', r),
    groups: (r: RangePreset | TimeRange, keys?: string[]): Promise<GroupsHistory | null> => ipcRenderer.invoke('history:groups', r, keys),
    group: (key: string, r: RangePreset | TimeRange): Promise<GroupHistory | null> => ipcRenderer.invoke('history:group', key, r),
    procs: (key: string, r: RangePreset | TimeRange): Promise<ProcsHistory | null> => ipcRenderer.invoke('history:procs', key, r),
    culprits: (ts: number): Promise<Culprit[]> => ipcRenderer.invoke('history:culprits', ts),
    top: (r: RangePreset | TimeRange, o?: TopOptions): Promise<TopResult> => ipcRenderer.invoke('history:top', r, o),
    events: (r: RangePreset | TimeRange): Promise<HistoryEvent[]> => ipcRenderer.invoke('history:events', r),
  },
  recorder: {
    status: (): Promise<RecorderState> => ipcRenderer.invoke('recorder:status'),
    setEnabled: (enabled: boolean): Promise<RecorderState> => ipcRenderer.invoke('recorder:setEnabled', enabled),
    clearHistory: (): Promise<{ mode: 'deleted' | 'requested'; backups: number }> => ipcRenderer.invoke('recorder:clearHistory'),
  },
};

contextBridge.exposeInMainWorld('procWatch', api);

export type ProcWatchApi = typeof api;
