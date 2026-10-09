import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AlertEvent } from '../core/alerts';
import type { EarlyoomSettings } from '../core/earlyoom';
import type { SunNode } from '../core/disk/sunTree';
import type { EarlyoomSetupMode } from '../core/earlyoomSetup';
import type { AboutInfo, AutostartInfo, InstallOutcome, OnboardingInfo, UninstallItem, UninstallOptions, UninstallResult } from '../core/onboarding';
import type { MigrationReport } from '../core/nameMigration';
import type { RuleStats } from '../core/rules/types';
import type { SwapView } from '../core/swap';
import type { TmpDeleteItem, TmpDeleteOutcome, TmpListing } from '../core/tmpClean';
import type { UpdateView } from '../core/update';
import type {
  ApplyResult, Category, EarlyoomStatus, Config, ConfigState, Culprit, InstanceTargets, ProcInfo, Watch, GroupHistory, GroupsHistory, HistoryEvent, KillResult, KillTarget, KillSignal, ProcsHistory, ProcTreeAt, RangePreset,
  RecorderState, Snapshot, SystemSeries, TimeRange, TmpFsStats, TmpUsage, TopOptions, TopResult,
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
  swap: {
    /** Vue swap (onglet Métriques) d'après le dernier snapshot ; null avant le premier snapshot. */
    view: (): Promise<SwapView | null> => ipcRenderer.invoke('swap:view'),
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
    /** Pop-up du lancement : mode à proposer (null : rien à faire, « Plus tard » ou pause de 7 jours) et état lu. */
    reminder: (): Promise<{ mode: EarlyoomSetupMode | null; status: EarlyoomStatus }> => ipcRenderer.invoke('earlyoom:reminder'),
    /** « Plus tard » (jusqu'au prochain lancement) ou « Ne plus rappeler pendant 7 jours » (config, horodatée par le main). */
    remindLater: (kind: 'later' | 'week'): Promise<ConfigState> => ipcRenderer.invoke('earlyoom:remindLater', kind),
    /**
     * Installer et configurer / Activer : le main relit l'état (le mot-clé doit y correspondre), construit la ligne, la montre
     * dans une confirmation native avec le paquet, puis un seul pkexec d'un script fixe.
     */
    setup: (mode: EarlyoomSetupMode): Promise<ApplyResult> => ipcRenderer.invoke('earlyoom:setup', mode),
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
  rules: {
    /** Dernier déclenchement et nombre sur 7 j, par id de règle ({} sans historique). */
    stats: (): Promise<Record<string, RuleStats>> => ipcRenderer.invoke('rules:stats'),
  },
  tray: {
    /** Le bureau a-t-il une zone de notification (StatusNotifierWatcher) ? Sinon fermer la fenêtre quitte l'app. */
    available: (): Promise<boolean> => ipcRenderer.invoke('tray:available'),
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
    /** Taille et occupation de /tmp (statfs) et RAM totale, en lecture seule (tuiles de la page /tmp). */
    stats: (): Promise<TmpFsStats> => ipcRenderer.invoke('tmp:stats'),
    /** Plus gros éléments de premier niveau, chacun avec sa raison de refus éventuelle. */
    entries: (): Promise<TmpListing> => ipcRenderer.invoke('tmp:entries'),
    /** Suppression définitive (au plus 50 éléments), revérifiée par le main élément par élément. */
    delete: (items: TmpDeleteItem[]): Promise<TmpDeleteOutcome> => ipcRenderer.invoke('tmp:delete', items),
    /** Vide les quarantaines restées (suppressions interrompues), après confirmation native du main. */
    emptyQuarantine: (): Promise<TmpDeleteOutcome> => ipcRenderer.invoke('tmp:emptyQuarantine'),
  },
  disk: {
    /** Arbre du dossier personnel pour le soleil (gardé 10 min ; `force` : « Actualiser »). */
    scan: (force = false): Promise<{ tree: SunNode; truncated: boolean; at: number }> => ipcRenderer.invoke('disk:scan', force),
    /** Page quittée : le parcours en cours est annulé 30 s plus tard. */
    leaveScan: (): Promise<void> => ipcRenderer.invoke('disk:scan-cancel'),
    /** Ko lus par le parcours en cours. */
    onScanProgress(cb: (kb: number) => void): () => void {
      const handler = (_e: IpcRendererEvent, kb: number) => cb(kb);
      ipcRenderer.on('disk:scan-progress', handler);
      return () => {
        ipcRenderer.removeListener('disk:scan-progress', handler);
      };
    },
  },
  /** Assistant d'accueil (premier lancement, rouvrable depuis Réglages › À propos). */
  onboarding: {
    get: (): Promise<OnboardingInfo> => ipcRenderer.invoke('onboarding:get'),
    /** Terminé ou « Passer » : ne revient plus au lancement. */
    finish: (): Promise<void> => ipcRenderer.invoke('onboarding:finish'),
    /** AppImage seulement : copie dans ~/Applications/computer-watcher.AppImage et entrée de menu vers la copie. */
    install: (): Promise<InstallOutcome> => ipcRenderer.invoke('onboarding:install'),
    /** Relance depuis la copie ; `deleteOriginal` : supprime d'abord le fichier téléchargé (confirmation native du main). */
    relaunch: (deleteOriginal: boolean): Promise<{ relaunched: boolean }> => ipcRenderer.invoke('onboarding:relaunch', deleteOriginal),
  },
  /** Démarrer avec la session (~/.config/autostart/computer-watcher.desktop, `--hidden`). */
  autostart: {
    get: (): Promise<AutostartInfo> => ipcRenderer.invoke('autostart:get'),
    set: (on: boolean): Promise<AutostartInfo> => ipcRenderer.invoke('autostart:set', on),
  },
  about: {
    info: (): Promise<AboutInfo> => ipcRenderer.invoke('about:info'),
  },
  /** Migration depuis proc-watch (Réglages › À propos). */
  migration: {
    state: (): Promise<MigrationReport> => ipcRenderer.invoke('migration:state'),
    /** Refait les étapes restantes ; celles d'avant l'ouverture des dossiers (service, déplacement) relancent l'app. */
    retry: (): Promise<{ report: MigrationReport; relaunching: boolean }> => ipcRenderer.invoke('migration:retry'),
  },
  uninstall: {
    /** Aperçu : exactement ce qui sera retiré, et le texte de la confirmation native. */
    plan: (o: UninstallOptions): Promise<{ items: UninstallItem[]; message: string; detail: string }> => ipcRenderer.invoke('uninstall:plan', o),
    /** Confirmation native puis désinstallation ; tout retiré → l'app quitte. */
    run: (o: UninstallOptions): Promise<{ cancelled: true } | { cancelled: false; result: UninstallResult }> => ipcRenderer.invoke('uninstall:run', o),
  },
  update: {
    /** État des mises à jour (version, mode, dernière vérification, version proposée) et réglages. */
    get: (): Promise<UpdateView> => ipcRenderer.invoke('update:get'),
    /** « Vérifier maintenant » (même si la vérification automatique est désactivée). */
    check: (): Promise<UpdateView> => ipcRenderer.invoke('update:check'),
    /** AppImage seulement : téléchargement (sha512 vérifié), progression dans onView. */
    download: (): Promise<UpdateView> => ipcRenderer.invoke('update:download'),
    /** Version téléchargée et vérifiée : remplace l'AppImage et redémarre l'app. */
    install: (): Promise<void> => ipcRenderer.invoke('update:install'),
    /** « Réessayer » : réinstalle depuis le fichier vérifié en cache (installation échouée), sinon retélécharge. */
    retry: (): Promise<UpdateView> => ipcRenderer.invoke('update:retry'),
    later: (): Promise<UpdateView> => ipcRenderer.invoke('update:later'),
    ignore: (): Promise<UpdateView> => ipcRenderer.invoke('update:ignore'),
    setPrefs: (p: { enabled?: boolean; prerelease?: boolean }): Promise<UpdateView> => ipcRenderer.invoke('update:setPrefs', p),
    /** Page des versions du dépôt dans le navigateur (adresse vérifiée par le main). */
    openRelease: (url: string): Promise<void> => ipcRenderer.invoke('update:openRelease', url),
    onView(cb: (v: UpdateView) => void): () => void {
      const handler = (_e: IpcRendererEvent, v: UpdateView) => cb(v);
      ipcRenderer.on('update:view', handler);
      return () => {
        ipcRenderer.removeListener('update:view', handler);
      };
    },
  },
  recorder: {
    status: (): Promise<RecorderState> => ipcRenderer.invoke('recorder:status'),
    setEnabled: (enabled: boolean): Promise<RecorderState> => ipcRenderer.invoke('recorder:setEnabled', enabled),
    clearHistory: (): Promise<{ mode: 'deleted' | 'requested'; backups: number }> => ipcRenderer.invoke('recorder:clearHistory'),
  },
};

contextBridge.exposeInMainWorld('procWatch', api);

export type ProcWatchApi = typeof api;
