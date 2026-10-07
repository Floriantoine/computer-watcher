import { useEffect, useMemo, useRef, useState } from 'react';
import { compileProtection } from '../../core/protection';
import type { ConfigState, Group, KillSignal, Snapshot } from '../../core/types';
import { MainView } from './components/MainView';
import { SystemBar } from './components/SystemBar';
import { flattenProcs, killErrorMessage, killRequestForGroup, trackKills, type KillRequest, type ViewFilter } from './viewModel';

export type Route = { view: 'main' } | { view: 'detail'; groupId: string } | { view: 'settings' };

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [configState, setConfigState] = useState<ConfigState | null>(null);
  const [route, setRoute] = useState<Route>({ view: 'main' });
  const [filter, setFilter] = useState<ViewFilter>({ query: '', sort: 'mem', minAgeSec: 0 });
  const [stuckPids, setStuckPids] = useState<Set<number>>(new Set());
  const [toasts, setToasts] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<KillRequest | null>(null);
  const pending = useRef(new Map<number, number>());

  useEffect(() => {
    window.procWatch.getConfig().then(setConfigState);
    return window.procWatch.onSnapshot((s) => {
      setSnapshot(s);
      const present = new Set(s.groups.flatMap((g) => flattenProcs(g).map((p) => p.pid)));
      const r = trackKills(pending.current, present, Date.now());
      pending.current = r.pending;
      setStuckPids(r.stuck);
    });
  }, []);

  const isProtected = useMemo(() => compileProtection(configState?.config.protected ?? []).isProtected, [configState]);

  const pushToast = (msg: string) => {
    setToasts((t) => [...t, msg]);
    setTimeout(() => setToasts((t) => t.slice(1)), 5000);
  };

  async function sendKill(pids: number[], signal: KillSignal) {
    const results = await window.procWatch.kill(pids, signal);
    const now = Date.now();
    for (const r of results) {
      if (r.ok && signal === 'SIGTERM') pending.current.set(r.pid, now);
      const msg = killErrorMessage(r);
      if (msg) pushToast(msg);
    }
  }

  function requestKill(req: KillRequest) {
    if (req.pids.length === 0) return;
    if (req.needsConfirm) setConfirm(req);
    else void sendKill(req.pids, 'SIGTERM');
  }

  if (!snapshot || !configState) return <p className="empty">Chargement…</p>;

  const killGroup = (g: Group) => requestKill(killRequestForGroup(g, isProtected, snapshot.currentUid));

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
          onForce={(pids) => void sendKill(pids, 'SIGKILL')}
          onSettings={() => setRoute({ view: 'settings' })}
        />
      )}
      {/* Task 10 : DetailView, ConfirmDialog, Toasts. Task 11 : SettingsView. */}
      {confirm && (
        <div className="empty">
          {confirm.title} <button className="danger" onClick={() => { void sendKill(confirm.pids, 'SIGTERM'); setConfirm(null); }}>Confirmer</button>
          <button onClick={() => setConfirm(null)}>Annuler</button>
        </div>
      )}
      {toasts.map((t, i) => <p key={i} className="empty">{t}</p>)}
    </div>
  );
}
