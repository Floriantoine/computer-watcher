import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AlertEvent } from '../core/alerts';
import type { EarlyoomSettings } from '../core/earlyoom';
import type {
  ApplyResult, Category, EarlyoomStatus, Config, ConfigState, Culprit, InstanceTargets, ProcInfo, Watch, GroupHistory, GroupsHistory, HistoryEvent, KillResult, KillTarget, KillSignal, ProcsHistory, ProcTreeAt, RangePreset,
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
    /** Arbre enregistré du groupe à l'instant ts (rejeu) ; null sans base ou requête invalide. */
    procTree: (key: string, ts: number): Promise<ProcTreeAt | null> => ipcRenderer.invoke('history:procTree', key, ts),
    culprits: (ts: number): Promise<Culprit[]> => ipcRenderer.invoke('history:culprits', ts),
    top: (r: RangePreset | TimeRange, o?: TopOptions): Promise<TopResult> => ipcRenderer.invoke('history:top', r, o),
    /** Événements de la plage ; avec `groupKey`, seulement ceux du groupe et les pressions système. */
    events: (r: RangePreset | TimeRange, groupKey?: string): Promise<HistoryEvent[]> => ipcRenderer.invoke('history:events', r, groupKey),
  },
  earlyoom: {
    status: (): Promise<EarlyoomStatus> => ipcRenderer.invoke('earlyoom:status'),
    /**
     * Le main reconstruit la ligne (liste protégée de sa config), refuse si elle diffère de `expectedLine` (l'aperçu),
     * la montre dans une confirmation native, puis lance pkexec d'un script fixe avec la ligne en argument.
     */
    apply: (s: EarlyoomSettings, expectedLine: string): Promise<ApplyResult> => ipcRenderer.invoke('earlyoom:apply', s, expectedLine),
  },
  alerts: {
    /** Alertes non vues (les 100 plus récentes d'abord) et leur nombre total. */
    unseen: (): Promise<{ total: number; alerts: AlertEvent[] }> => ipcRenderer.invoke('alerts:unseen'),
    get: (id: number): Promise<AlertEvent | null> => ipcRenderer.invoke('alerts:get', id),
    /** Pop-ups fermés : vues jusqu'à `upTo` inclus, et `ids` fermées au-delà. */
    markSeen: (req: { upTo?: number; ids?: number[] }): Promise<ConfigState> => ipcRenderer.invoke('alerts:markSeen', req),
    /** « Tout fermer ». */
    seenAll: (): Promise<ConfigState> => ipcRenderer.invoke('alerts:seenAll'),
    /** Alerte demandée au lancement (`--alert=<id>`), une seule fois. */
    takePending: (): Promise<number | null> => ipcRenderer.invoke('alerts:takePending'),
    /** Notification « Ouvrir » cliquée alors que l'app tournait déjà. */
    onOpen(cb: (id: number) => void): () => void {
      const handler = (_e: IpcRendererEvent, id: number) => cb(id);
      ipcRenderer.on('alert:open', handler);
      return () => {
        ipcRenderer.removeListener('alert:open', handler);
      };
    },
  },
  forecast: {
    /** « Ignorer 30 min » d'une alerte de prévision : le service n'en envoie plus avant cette heure (ms) renvoyée. */
    snooze: (): Promise<number> => ipcRenderer.invoke('forecast:snooze'),
  },
  free: {
    /** « Libérer de la mémoire » demandé (`--free`, barre des tâches) et pas encore pris : une seule fois. */
    takePending: (): Promise<boolean> => ipcRenderer.invoke('free:takePending'),
    /** « Libérer de la mémoire » demandé alors que l'app tournait déjà. */
    onFree(cb: () => void): () => void {
      const handler = () => cb();
      ipcRenderer.on('free', handler);
      return () => {
        ipcRenderer.removeListener('free', handler);
      };
    },
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
