import { useEffect, useMemo, useRef, useState } from 'react';
import { compileProtection } from '../../core/protection';
import type { Config, ConfigState, Group, KillSignal, KillTarget, ProcNode, Snapshot } from '../../core/types';
import { ConfirmDialog } from './components/ConfirmDialog';
import { DetailView } from './components/DetailView';
import { SettingsView } from './components/SettingsView';
import { Toasts } from './components/Toasts';
import { MainView } from './components/MainView';
import { SystemBar } from './components/SystemBar';
import { findGroup, flattenProcs, ipcErrorMessage, killResultMessages, killRequestForGroup, killRequestForProc, trackKills, type KillRequest, type ViewFilter } from './viewModel';

export type Route = { view: 'main' } | { view: 'detail'; groupId: string } | { view: 'settings' };

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [configState, setConfigState] = useState<ConfigState | null>(null);
  const [route, setRoute] = useState<Route>({ view: 'main' });
  const [filter, setFilter] = useState<ViewFilter>({ query: '', sort: 'mem', minAgeSec: 0 });
  const [stuckPids, setStuckPids] = useState<Set<number>>(new Set());
  const [toasts, setToasts] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<KillRequest | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const pending = useRef(new Map<number, number>());
  // startTicks relevé à l'envoi du SIGTERM : le SIGKILL « Forcer » le réutilise pour ne pas viser un PID réutilisé.
  const sentTicks = useRef(new Map<number, number>());

  useEffect(() => {
    window.procWatch.getConfig().then(setConfigState, (e: unknown) => setConfigError(ipcErrorMessage(e)));
    return window.procWatch.onSnapshot((s) => {
      setSnapshot(s);
      const present = new Set(s.groups.flatMap((g) => flattenProcs(g).map((p) => p.pid)));
      const r = trackKills(pending.current, present, Date.now());
      pending.current = r.pending;
      for (const pid of [...sentTicks.current.keys()]) if (!r.pending.has(pid)) sentTicks.current.delete(pid);
      setStuckPids(r.stuck);
    });
  }, []);

  const isProtected = useMemo(() => compileProtection(configState?.config.protected ?? []).isProtected, [configState]);

  const pushToast = (msg: string) => {
    setToasts((t) => [...t, msg]);
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

  if (configError) return <p className="empty">Impossible de charger la configuration : {configError}</p>;
  if (!snapshot || !configState) return <p className="empty">Chargement…</p>;

  const killGroup = (g: Group) => requestKill(killRequestForGroup(g, isProtected, snapshot.currentUid));
  const killProc = (n: ProcNode) => requestKill(killRequestForProc(n.proc, isProtected, snapshot.currentUid));

  async function saveConfig(next: Config) {
    try {
      setConfigState(await window.procWatch.setConfig(next));
    } catch (e) {
      pushToast(`Réglages non enregistrés : ${ipcErrorMessage(e)}`);
    }
  }

  function toggleProtect(g: Group) {
    const cfg = configState!.config;
    const list = cfg.protected.includes(g.rootName) ? cfg.protected.filter((x) => x !== g.rootName) : [...cfg.protected, g.rootName];
    void saveConfig({ ...cfg, protected: list });
  }

  return (
    <div data-testid="snapshot-ready">
      <SystemBar system={snapshot.system} />
      {route.view === 'main' && (
        <MainView
          groups={snapshot.groups}
          memTotalKB={snapshot.system.memTotalKB}
          filter={filter}
          onFilter={setFilter}
          stuckPids={stuckPids}
          onOpen={(g) => setRoute({ view: 'detail', groupId: g.id })}
          onKillGroup={killGroup}
          onForce={forceKill}
          onSettings={() => setRoute({ view: 'settings' })}
        />
      )}
      {route.view === 'detail' && (
        <DetailView
          group={findGroup(snapshot.groups, route.groupId)}
          stuckPids={stuckPids}
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
        />
      )}
      {route.view === 'settings' && (
        <SettingsView
          state={configState}
          onSave={(c) => void saveConfig(c)}
          onBack={() => setRoute({ view: 'main' })}
          onInstallDesktop={() =>
            window.procWatch.installDesktopEntry().then(
              (file) => pushToast(`Raccourci créé : ${file}`),
              (e: unknown) => pushToast(ipcErrorMessage(e)),
            )
          }
        />
      )}
      {confirm && (
        <ConfirmDialog
          request={confirm}
          onConfirm={() => {
            void sendKill(confirm.targets, 'SIGTERM');
            setConfirm(null);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
      <Toasts messages={toasts} />
    </div>
  );
}
