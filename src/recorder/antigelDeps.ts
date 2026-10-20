// Vraies dépendances de l'anti-gel pour le service : busctl (systemBin), /proc, /sys/fs/cgroup. Coupées par
// PROC_WATCH_NO_ANTIGEL=1 (scripts de mesure et de bout en bout du service, apps de test : aucun vrai processus déplacé).
// Rien n'est lancé ni lu à la construction : busctl ne part qu'à un appel du client, depuis l'orchestrateur du service.
import { existsSync } from 'node:fs';
import { probeAvailability, readCgroup, readCgroupStats, reverify } from '../core/antigel/cgroupfs';
import { runScopeDeps } from '../core/antigel/runScopesFs';
import { BusctlError, createBusctl, createSystemdClient } from '../core/antigel/systemd';
import { systemBin } from '../core/childEnv';
import type { RecorderDeps } from './recorder';

export function antigelDepsFor(o: {
  env: NodeJS.ProcessEnv; uid: number; selfPid: number; exists?: (p: string) => boolean; procRoot?: string; sysfsRoot?: string;
}): RecorderDeps['antigel'] {
  if (o.env.PROC_WATCH_NO_ANTIGEL === '1') return undefined;
  const procRoot = o.procRoot ?? '/proc';
  const sysfsRoot = o.sysfsRoot ?? '/sys/fs/cgroup';
  const busctl = systemBin('busctl', o.exists ?? existsSync);
  const client = createSystemdClient(
    busctl ? createBusctl(busctl, o.env) : async () => { throw new BusctlError('busctl introuvable', 'unreachable'); },
  );
  return {
    client,
    probe: () => probeAvailability({ procRoot, sysfsRoot, uid: o.uid, selfPid: o.selfPid, busctl }),
    stats: (cg) => readCgroupStats(sysfsRoot, cg),
    cgroupOf: (pid) => readCgroup(procRoot, pid),
    reverify: (targets, cg) => reverify(procRoot, o.uid, targets, cg),
    // lot 4 : scopes ouverts par `computer-watcher run` (comptés, slice attribuée ; jamais déplacés)
    run: runScopeDeps(procRoot, sysfsRoot),
  };
}
