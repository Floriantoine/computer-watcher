import type { KillResult, KillSignal, KillTarget, ProcSample } from './types';

export type KillFn = (pid: number, signal: KillSignal) => void;

/** Cibles au plus par appel du handler `kill` (au-delà : erreur ; le renderer envoie par lots). */
export const MAX_KILL_TARGETS = 2000;

const isKillTarget = (t: unknown): t is KillTarget =>
  typeof t === 'object' && t !== null && Number.isInteger((t as KillTarget).pid) && Number.isInteger((t as KillTarget).startTicks);

/**
 * Requête `kill` venue du renderer : cibles `{pid, startTicks}` nettoyées et signal, ou null si invalide.
 * Lève une erreur au-delà de MAX_KILL_TARGETS (le renderer l'affiche, au lieu d'un « rien d'arrêté » muet).
 */
export function killRequest(targets: unknown, signal: unknown): { targets: KillTarget[]; signal: KillSignal } | null {
  if (!Array.isArray(targets) || !targets.every(isKillTarget)) return null;
  if (signal !== 'SIGTERM' && signal !== 'SIGKILL') return null;
  if (targets.length > MAX_KILL_TARGETS) throw new Error('Trop de cibles (2 000 au plus)');
  return { targets: targets.map(({ pid, startTicks }) => ({ pid, startTicks })), signal };
}

export function planKill(
  targets: KillTarget[],
  procs: ProcSample[],
  guards: { selfPid: number; currentUid: number },
): { ordered: number[]; refused: KillResult[] } {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const children = new Map<number, number[]>();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);

  const forbidden = new Set<number>([1, guards.selfPid]);
  // Fail closed : si la chaîne d'ancêtres de l'app n'est pas entièrement connue, on refuse tout.
  let chainKnown = byPid.has(guards.selfPid);
  if (chainKnown) {
    const seen = new Set<number>([guards.selfPid]);
    let cur = byPid.get(guards.selfPid)!;
    while (cur.ppid !== 1 && cur.ppid !== 0) {
      if (!Number.isInteger(cur.ppid) || cur.ppid < 0) {
        chainKnown = false;
        break;
      }
      const parent = byPid.get(cur.ppid);
      if (!parent || seen.has(parent.pid)) {
        chainKnown = false;
        break;
      }
      seen.add(parent.pid);
      forbidden.add(parent.pid);
      cur = parent;
    }
  }
  if (!chainKnown) {
    return { ordered: [], refused: [...new Set(targets.map((t) => t.pid))].map((pid) => ({ pid, ok: false, error: 'SELF' })) };
  }
  const stack = [...(children.get(guards.selfPid) ?? [])];
  while (stack.length) {
    const pid = stack.pop()!;
    if (forbidden.has(pid)) continue;
    forbidden.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }

  const refused: KillResult[] = [];
  const allowed: number[] = [];
  const seenPids = new Set<number>();
  for (const { pid, startTicks } of targets) {
    if (seenPids.has(pid)) continue;
    seenPids.add(pid);
    const p = byPid.get(pid);
    // PID absent ou réutilisé par un autre processus (startTicks différent) : « déjà parti ».
    if (!p || p.startTicks !== startTicks) refused.push({ pid, ok: false, error: 'ESRCH' });
    else if (forbidden.has(pid)) refused.push({ pid, ok: false, error: 'SELF' });
    else if (p.uid !== guards.currentUid) refused.push({ pid, ok: false, error: 'EPERM' });
    else allowed.push(pid);
  }

  const depth = (pid: number) => {
    let d = 0;
    const seen = new Set<number>();
    for (let cur = byPid.get(pid); cur && !seen.has(cur.pid); cur = byPid.get(cur.ppid)) {
      seen.add(cur.pid);
      d++;
    }
    return d;
  };
  allowed.sort((a, b) => depth(b) - depth(a));
  return { ordered: allowed, refused };
}

export function sendSignals(pids: number[], signal: KillSignal, kill: KillFn = (pid, s) => process.kill(pid, s)): KillResult[] {
  return pids.map((pid) => {
    if (!Number.isInteger(pid) || pid <= 1) return { pid, ok: false, error: 'EINVAL' };
    try {
      kill(pid, signal);
      return { pid, ok: true };
    } catch (e) {
      return { pid, ok: false, error: (e as NodeJS.ErrnoException).code ?? String(e) };
    }
  });
}
