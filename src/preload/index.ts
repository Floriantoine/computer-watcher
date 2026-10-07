import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Config, ConfigState, KillResult, KillSignal, Snapshot } from '../core/types';

const api = {
  onSnapshot(cb: (s: Snapshot) => void): () => void {
    const handler = (_e: IpcRendererEvent, s: Snapshot) => cb(s);
    ipcRenderer.on('snapshot', handler);
    return () => {
      ipcRenderer.removeListener('snapshot', handler);
    };
  },
  kill: (pids: number[], signal: KillSignal): Promise<KillResult[]> => ipcRenderer.invoke('kill', pids, signal),
  getConfig: (): Promise<ConfigState> => ipcRenderer.invoke('config:get'),
  setConfig: (c: Config): Promise<ConfigState> => ipcRenderer.invoke('config:set', c),
  installDesktopEntry: (): Promise<string> => ipcRenderer.invoke('desktop:install'),
};

contextBridge.exposeInMainWorld('procWatch', api);

export type ProcWatchApi = typeof api;
