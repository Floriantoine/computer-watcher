import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, MotionConfig, motion, useIsPresent } from 'motion/react';
import { compileProtection } from '../../core/protection';
import type { Category, Config, ConfigState, GroupSummary, InstanceSummary, KillSignal, KillTarget, ProcNode, Snapshot } from '../../core/types';
import { ConfirmDialog } from './components/ConfirmDialog';
import { DetailView } from './components/DetailView';
import { SettingsView } from './components/SettingsView';
import { Toasts, type Toast } from './components/Toasts';
import { MainView } from './components/MainView';
import { MetricsView } from './components/MetricsView';
import { SystemBar, type SystemSparks } from './components/SystemBar';
import { TopNav } from './components/TopNav';
import { LiveBuffer, setLive, useHistory } from './history';
import { projectName, reclassifyMessage, reclassifyScope } from './instances';
import { leakTimes } from './recorderForm';
import { findGroup, visibleGroups, ipcErrorMessage, killResultMessages, killRequestForGroup, killRequestForInstance, killRequestForProc, trackKills, type KillRequest, type ViewFilter } from './viewModel';

export type Route = { view: 'main' } | { view: 'detail'; groupId: string } | { view: 'settings' } | { view: 'metrics'; at?: number };

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [configState, setConfigState] = useState<ConfigState | null>(null);
  const [route, setRoute] = useState<Route>({ view: 'main' });
  const [filter, setFilter] = useState<ViewFilter>({ query: '', sort: 'mem', minAgeSec: 0 });
  const [stuckPids, setStuckPids] = useState<Set<number>>(new Set());
  // Miroir d'affichage de `pending` (SIGTERM envoyé, processus encore là) : fait pulser les boutons kill.
  const [pendingPids, setPendingPids] = useState<Set<number>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const [confirm, setConfirm] = useState<KillRequest | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const pending = useRef(new Map<number, number>());
  // startTicks relevé à l'envoi du SIGTERM : le SIGKILL « Forcer » le réutilise pour ne pas viser un PID réutilisé.
  const sentTicks = useRef(new Map<number, number>());

  const live = useRef(new LiveBuffer());

  useEffect(() => {
    window.procWatch.getConfig().then(setConfigState, (e: unknown) => setConfigError(ipcErrorMessage(e)));
    const offLive = window.procWatch.onLive(setLive);
    const offSnapshot = window.procWatch.onSnapshot((s) => {
      live.current.push(s.takenAt, s.system, s.groups.filter((g) => g.kind !== 'others'));
      setSnapshot(s);
      const present = new Set(s.groups.flatMap((g) => g.pids));
      const r = trackKills(pending.current, present, Date.now());
      pending.current = r.pending;
      for (const pid of [...sentTicks.current.keys()]) if (!r.pending.has(pid)) sentTicks.current.delete(pid);
      setStuckPids(r.stuck);
      setPendingPids(new Set(r.pending.keys()));
    });
    return () => {
      offLive();
      offSnapshot();
    };
  }, []);

  // Le main n'envoie l'arbre que du groupe ouvert, et fait la recherche plein texte (commandes, dossiers).
  const detailId = route.view === 'detail' ? route.groupId : null;
  useEffect(() => {
    window.procWatch.watch({ groupId: detailId, query: filter.query }).catch(() => {});
  }, [detailId, filter.query]);
  // Résultat de recherche valable seulement pour la requête en cours ; en attente de la réponse du main : pas de filtre.
  const query = filter.query.trim();
  const matches = useMemo(
    () => (snapshot?.matches && snapshot.query === query ? new Set(snapshot.matches) : null),
    [snapshot, query],
  );

  // Clés des cartes affichées (hors « Autres »), triées pour ne relancer la requête que si l'ensemble change.
  const visibleKeys = useMemo(
    () => (snapshot ? visibleGroups(snapshot.groups, filter, matches).filter((g) => g.kind !== 'others').map((g) => g.id).sort() : []),
    [snapshot, filter, matches],
  );
  const keysId = visibleKeys.join('|');
  const sysHist = useHistory(() => window.procWatch.history.system('1h'), []);
  const groupHist = useHistory(
    () => (visibleKeys.length ? window.procWatch.history.groups('1h', visibleKeys) : Promise.resolve(null)),
    [keysId],
  );
  const histByKey = useMemo(() => new Map((groupHist?.series ?? []).map((s) => [s.key, s.memKB])), [groupHist]);
  const sparkOf = (id: string): (number | null)[] => {
    const h = histByKey.get(id);
    return h && h.length >= 2 ? h : live.current.group(id);
  };

  const events24h = useHistory(() => window.procWatch.history.events('24h'), [], 60_000);
  const leakAt = useMemo(() => {
    const mem = new Map((snapshot?.groups ?? []).map((g) => [g.id, g.rssKB + g.swapKB]));
    return leakTimes(events24h, snapshot?.takenAt ?? Date.now(), (k) => mem.get(k));
  }, [events24h, snapshot]);

  const groupIds = useMemo(() => new Set(snapshot?.groupIds ?? []), [snapshot]);

  const isProtected = useMemo(() => compileProtection(configState?.config.protected ?? []).isProtected, [configState]);

  const pushToast = (message: string, kind: Toast['kind'] = 'error') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.slice(1)), 5000);
  };

  async function sendKill(targets: KillTarget[], signal: KillSignal) {
    let results;
    try {
      results = await window.procWatch.kill(targets, signal);
    } catch (e) {
      pushToast(ipcErrorMessage(e));
      return;
    }
    const now = Date.now();
    for (const r of results) {
      if (r.ok && signal === 'SIGTERM') {
        pending.current.set(r.pid, now);
        const t = targets.find((x) => x.pid === r.pid);
        if (t) sentTicks.current.set(r.pid, t.startTicks);
      }
    }
    setPendingPids(new Set(pending.current.keys()));
    for (const msg of killResultMessages(results)) pushToast(msg);
  }

  // « Forcer » : on réutilise le startTicks du SIGTERM ; sans lui, on ne vise rien.
  function forceKill(pids: number[]) {
    const targets = pids.flatMap((pid) => {
      const startTicks = sentTicks.current.get(pid);
      return startTicks === undefined ? [] : [{ pid, startTicks }];
    });
    if (targets.length) void sendKill(targets, 'SIGKILL');
  }

  function requestKill(req: KillRequest) {
    if (req.targets.length === 0) return;
    if (req.needsConfirm) setConfirm(req);
    else void sendKill(req.targets, 'SIGTERM');
  }

  const reducedEffects = !!configState?.config.ui.reducedEffects;
  useEffect(() => {
    if (reducedEffects) document.documentElement.dataset.effects = 'reduced';
    else delete document.documentElement.dataset.effects;
  }, [reducedEffects]);

  if (configError) return <p className="empty">Impossible de charger la configuration : {configError}</p>;
  if (!snapshot || !configState) return <p className="empty">Chargement…</p>;

  const routeKey = route.view === 'detail' ? `detail:${route.groupId}` : route.view;

  const currentUid = snapshot.currentUid;
  const killGroup = (g: GroupSummary) => {
    window.procWatch.groupProcs(g.id).then(
      (procs) => {
        if (procs.length === 0) pushToast("Ce groupe n'existe plus");
        else requestKill(killRequestForGroup(g, procs, isProtected, currentUid));
      },
      (e: unknown) => pushToast(ipcErrorMessage(e)),
    );
  };
  const killProc = (n: ProcNode) => requestKill(killRequestForProc(n.proc, isProtected, snapshot.currentUid));
  // Kill d'une instance : cibles {pid, startTicks} du dernier snapshot côté main, puis le chemin habituel (confirmation si protégée).
  const killInstance = (inst: InstanceSummary) => {
    Promise.all([window.procWatch.instances.targets([inst.key]), window.procWatch.groupProcs(inst.groupId)]).then(
      ([entries, procs]) => {
        const targets = entries.find((e) => e.key === inst.key)?.targets ?? [];
        const req = killRequestForInstance(inst, targets, procs, isProtected, currentUid);
        if (req.targets.length === 0) pushToast("Cette instance n'existe plus");
        else requestKill(req);
      },
      (e: unknown) => pushToast(ipcErrorMessage(e)),
    );
  };
  const reclassify = (inst: InstanceSummary, category: Category | null) => {
    const name = projectName(inst, findGroup(snapshot.groups, inst.groupId)?.label ?? inst.groupId);
    window.procWatch.classify.set(reclassifyScope(inst), inst.signature, category).then(
      (state) => {
        setConfigState(state);
        pushToast(reclassifyMessage(category, name), 'info');
      },
      (e: unknown) => pushToast(ipcErrorMessage(e)),
    );
  };

  async function saveConfig(next: Config) {
    try {
      setConfigState(await window.procWatch.setConfig(next));
    } catch (e) {
      pushToast(`Réglages non enregistrés : ${ipcErrorMessage(e)}`);
    }
  }

  function toggleProtect(g: GroupSummary) {
    const cfg = configState!.config;
    const list = cfg.protected.includes(g.rootName) ? cfg.protected.filter((x) => x !== g.rootName) : [...cfg.protected, g.rootName];
    void saveConfig({ ...cfg, protected: list });
  }

  const sparks: SystemSparks =
    sysHist && sysHist.ts.length >= 2
      ? { mem: sysHist.memUsedKB, swap: sysHist.swapUsedKB, psi: sysHist.psi, load: sysHist.load }
      : (() => {
          const pts = live.current.system();
          return { mem: pts.map((p) => p.memUsedKB), swap: pts.map((p) => p.swapUsedKB), psi: pts.map((p) => p.psi), load: pts.map((p) => p.load) };
        })();

  return (
    <MotionConfig reducedMotion={reducedEffects ? 'always' : 'user'}>
      <div data-testid="snapshot-ready">
        <TopNav route={route} onNavigate={setRoute} />
        <SystemBar system={snapshot.system} sparks={sparks} />
        <AnimatePresence mode="wait" initial={false}>
          <RouteFade key={routeKey}>
            {route.view === 'main' && (
              <MainView
                groups={snapshot.groups}
                matches={matches}
                memTotalKB={snapshot.system.memTotalKB}
                filter={filter}
                onFilter={setFilter}
                stuckPids={stuckPids}
                pendingPids={pendingPids}
                onOpen={(g) => setRoute({ view: 'detail', groupId: g.id })}
                onKillGroup={killGroup}
                onForce={forceKill}
                sparkOf={sparkOf}
                leakAt={leakAt}
                onLeak={(ts) => setRoute({ view: 'metrics', at: ts })}
              />
            )}
            {route.view === 'detail' && (
              <DetailView
                group={findGroup(snapshot.groups, route.groupId)}
                roots={snapshot.detail?.groupId === route.groupId ? snapshot.detail.roots : null}
                pending={snapshot.watched !== route.groupId}
                stuckPids={stuckPids}
                pendingPids={pendingPids}
                currentUid={snapshot.currentUid}
                rootProtectedByName={(() => {
                  const g = findGroup(snapshot.groups, route.groupId);
                  return !!g && configState.config.protected.includes(g.rootName);
                })()}
                onBack={() => setRoute({ view: 'main' })}
                onOpenGroup={(id) => setRoute({ view: 'detail', groupId: id })}
                onKillGroup={killGroup}
                onKillProc={killProc}
                onForce={forceKill}
                onToggleProtect={toggleProtect}
                onReclassify={reclassify}
                onKillInstance={killInstance}
              />
            )}
            {route.view === 'metrics' && (
              <MetricsView
                at={route.at}
                canOpen={(key) => groupIds.has(key)}
                onOpenGroup={(key) => groupIds.has(key) && setRoute({ view: 'detail', groupId: key })}
              />
            )}
            {route.view === 'settings' && (
              <SettingsView
                state={configState}
                onSave={(c) => void saveConfig(c)}
                onBack={() => setRoute({ view: 'main' })}
                onToast={pushToast}
                onConfigChanged={() => void window.procWatch.getConfig().then(setConfigState, () => {})}
                onInstallDesktop={() =>
                  window.procWatch.installDesktopEntry().then(
                    (file) => pushToast(`Raccourci créé : ${file}`, 'info'),
                    (e: unknown) => pushToast(ipcErrorMessage(e)),
                  )
                }
              />
            )}
          </RouteFade>
        </AnimatePresence>
        <AnimatePresence>
          {confirm && (
            <ConfirmDialog
              key="confirm"
              request={confirm}
              onConfirm={() => {
                void sendKill(confirm.targets, 'SIGTERM');
                setConfirm(null);
              }}
              onCancel={() => setConfirm(null)}
            />
          )}
        </AnimatePresence>
        <Toasts toasts={toasts} />
      </div>
    </MotionConfig>
  );
}

/** Transition de route : fondu + glissement de 8 px ; la vue sortante n'accepte plus de clics. */
function RouteFade({ children }: { children: ReactNode }) {
  const isPresent = useIsPresent();
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      style={{ pointerEvents: isPresent ? undefined : 'none' }}
    >
      {children}
    </motion.div>
  );
}
