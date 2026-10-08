import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, MotionConfig, motion, useIsPresent } from 'motion/react';
import { compileProtection } from '../../core/protection';
import type { Category, Config, ConfigState, GroupSummary, InstanceSummary, KillResult, KillSignal, KillTarget, ProcNode, Snapshot } from '../../core/types';
import { bulkDialogTitle, chunkTargets, runBulkKill, type BulkRequest } from './bulkKill';
import { AlertPopups, useAlertPopups } from './components/AlertPopups';
import { BulkKillDialog } from './components/BulkKillDialog';
import { ConfirmDialog } from './components/ConfirmDialog';
import { DetailView } from './components/DetailView';
import { SettingsView } from './components/SettingsView';
import { Toasts, type Toast } from './components/Toasts';
import { MainView } from './components/MainView';
import { MetricsView } from './components/MetricsView';
import { SystemBar, type SystemSparks } from './components/SystemBar';
import { TopNav } from './components/TopNav';
import { LiveBuffer, setLive, useHistory } from './history';
import { instanceKillPlan, projectName, reclassifyMessage, reclassifyScope, skipInstanceKill } from './instances';
import { leakMemOf } from './memMetric';
import { readOthersOpen, writeOthersOpen } from './othersFold';
import { leakTimes } from './recorderForm';
import { findGroup, visibleGroups, ipcErrorMessage, killResultMessages, killRequestForGroup, killRequestForProc, trackKills, type KillRequest, type ViewFilter } from './viewModel';

export type Route = { view: 'main' } | { view: 'detail'; groupId: string } | { view: 'settings' } | { view: 'metrics'; at?: number };

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [configState, setConfigState] = useState<ConfigState | null>(null);
  const [route, setRoute] = useState<Route>({ view: 'main' });
  const [filter, setFilter] = useState<ViewFilter>({ query: '', sort: 'mem', minAgeSec: 0 });
  // Carte « Autres » dépliée (mémorisée) : le main n'en résume les sous-groupes que sur la page Processus.
  const [othersOpen, setOthersOpen] = useState(readOthersOpen);
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
  // Kills d'instance en cours de préparation (garde contre le double clic).
  const instKillsInFlight = useRef(new Set<string>());
  // Dialogue de kill groupé ouvert, et envoi groupé en cours (un seul à la fois : garde contre le double clic).
  const [bulk, setBulk] = useState<{ instances: InstanceSummary[]; launchersOf?: string; title: string } | null>(null);
  const bulkInFlight = useRef(false);

  const live = useRef(new LiveBuffer());
  const alertPopups = useAlertPopups({
    alerts: configState?.config.alerts,
    onState: setConfigState,
    onOpenAlert: (e) => setRoute({ view: 'metrics', at: e.ts }),
  });

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
  const othersShown = othersOpen && route.view === 'main';
  useEffect(() => {
    window.procWatch.watch({ groupId: detailId, query: filter.query, othersOpen: othersShown }).catch(() => {});
  }, [detailId, filter.query, othersShown]);
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
    // En PSS, la mémoire affichée n'est pas comparable à celle enregistrée (RSS) : pas de filtre sur la baisse.
    return leakTimes(events24h, snapshot?.takenAt ?? Date.now(), leakMemOf(snapshot?.memMetric ?? 'rss', mem));
  }, [events24h, snapshot]);

  const groupIds = useMemo(() => new Set(snapshot?.groupIds ?? []), [snapshot]);
  // Clés des instances du dernier snapshot (sous-groupes compris) : le dialogue groupé grise celles qui ont disparu.
  const liveKeys = useMemo(() => {
    const out = new Set<string>();
    const walk = (gs: readonly GroupSummary[]) => {
      for (const g of gs) {
        for (const i of g.instances) out.add(i.key);
        walk(g.subgroups);
      }
    };
    walk(snapshot?.groups ?? []);
    return out;
  }, [snapshot]);

  const isProtected = useMemo(() => compileProtection(configState?.config.protected ?? []).isProtected, [configState]);

  const pushToast = (message: string, kind: Toast['kind'] = 'error') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.slice(1)), 5000);
  };

  /** Mémorise les SIGTERM envoyés (boutons qui pulsent, puis « Forcer » avec le même startTicks). */
  function noteSent(targets: KillTarget[], results: KillResult[], signal: KillSignal) {
    if (signal !== 'SIGTERM') return;
    const now = Date.now();
    const ticks = new Map(targets.map((t) => [t.pid, t.startTicks]));
    for (const r of results) {
      if (!r.ok) continue;
      pending.current.set(r.pid, now);
      const t = ticks.get(r.pid);
      if (t !== undefined) sentTicks.current.set(r.pid, t);
    }
    setPendingPids(new Set(pending.current.keys()));
  }

  /** Un appel du handler `kill` (≤ 2 000 cibles). */
  async function killBatch(batch: KillTarget[], signal: KillSignal): Promise<KillResult[]> {
    const results = await window.procWatch.kill(batch, signal);
    noteSent(batch, results, signal);
    return results;
  }

  /** Envoie un signal par lots de 2 000 au plus ; une erreur IPC n'efface pas les erreurs des lots déjà envoyés. */
  async function sendKill(targets: KillTarget[], signal: KillSignal) {
    const results: KillResult[] = [];
    let error: string | null = null;
    for (const batch of chunkTargets(targets)) {
      try {
        results.push(...(await killBatch(batch, signal)));
      } catch (e) {
        error = ipcErrorMessage(e);
        break;
      }
    }
    for (const msg of killResultMessages(results)) pushToast(msg);
    if (error) pushToast(error);
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
  // Un second clic pendant la demande, ou après un SIGTERM déjà envoyé à tous ses processus, est ignoré.
  const killInstance = (inst: InstanceSummary) => {
    if (skipInstanceKill(inst, instKillsInFlight.current, pending.current)) return;
    instKillsInFlight.current.add(inst.key);
    Promise.all([window.procWatch.instances.targets([inst.key]), window.procWatch.groupProcs(inst.groupId)])
      .then(
        ([entries, procs]) => {
          const plan = instanceKillPlan(inst, entries, procs, isProtected, currentUid);
          if ('error' in plan) pushToast(plan.error);
          else requestKill(plan.request);
        },
        (e: unknown) => pushToast(ipcErrorMessage(e)),
      )
      .finally(() => instKillsInFlight.current.delete(inst.key));
  };
  const groupLabel = (id: string) => findGroup(snapshot.groups, id)?.label ?? id;
  const nameOf = (inst: InstanceSummary) => projectName(inst, groupLabel(inst.groupId));
  // Kill groupé : ouvre le dialogue (ignoré pendant un envoi groupé en cours).
  const killInstances = (instances: InstanceSummary[], launchersOf?: string) => {
    if (bulkInFlight.current || bulk || instances.length === 0) return;
    const one = instances.every((i) => i.groupId === instances[0]!.groupId) ? nameOf(instances[0]!) : null;
    setBulk({ instances, launchersOf, title: bulkDialogTitle(instances, launchersOf, one) });
  };
  // « Tuer (n) » : cibles fraîches du main, puis le handler `kill` (≤ 2 000 cibles par appel), puis un toast récapitulatif.
  const confirmBulk = async (req: BulkRequest) => {
    if (bulkInFlight.current) return;
    bulkInFlight.current = true;
    setBulk(null);
    try {
      const s = await runBulkKill(req, {
        targets: (k) => window.procWatch.instances.targets(k),
        kill: (batch) => killBatch(batch, 'SIGTERM'),
        isProtected,
        errorMessage: ipcErrorMessage,
      });
      pushToast(s.message, s.kind);
    } finally {
      bulkInFlight.current = false;
    }
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
        <TopNav route={route} onNavigate={setRoute} unseen={alertPopups.pending.length} />
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
                onKillInstances={killInstances}
                othersOpen={othersOpen}
                memMetric={snapshot.memMetric}
                onToggleOthers={(open) => {
                  writeOthersOpen(open);
                  setOthersOpen(open);
                }}
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
                onKillInstances={killInstances}
                memMetric={snapshot.memMetric}
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
          {bulk && (
            <BulkKillDialog
              key="bulk"
              title={bulk.title}
              instances={bulk.instances}
              launchersOf={bulk.launchersOf}
              liveKeys={liveKeys}
              pendingPids={pending.current}
              nameOf={nameOf}
              onConfirm={(req) => void confirmBulk(req)}
              onCancel={() => setBulk(null)}
            />
          )}
        </AnimatePresence>
        <Toasts toasts={toasts} />
        <AlertPopups
          pending={alertPopups.pending}
          onClose={alertPopups.close}
          onCloseAll={alertPopups.closeAll}
          groupPresent={(key) => groupIds.has(key)}
          onOpenGroup={(key) => setRoute({ view: 'detail', groupId: key })}
          onOpenInstant={(ts) => setRoute({ view: 'metrics', at: ts })}
        />
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
