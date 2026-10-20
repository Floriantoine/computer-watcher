// Anti-gel (lot 2, « bureau prioritaire ») : poids CPU (et E/S) du bureau au-dessus du travail, protection mémoire du bureau
// et des terminaux quand elle peut agir. Valeurs d'origine lues dans sysfs avant le premier changement, gardées (mémoire et
// antigel-desk.json) et restaurées à l'extinction ou quand une unité n'est plus visée. En régime établi : lectures sysfs
// seulement, aucun appel D-Bus ; un appel par unité dont une valeur diffère, un enchaînement à la fois, recul de 5 min si
// une valeur ne prend pas.
import type { ProcInfo } from '../types';
import { BusctlError } from './systemd';
import { DEFAULT_WEIGHT, deskTargets, isDeskSliceName, isDeskUnitName, type DeskCaps, type DeskWant } from './deskUnits';
import type { DeskClient, DeskProps } from './deskSystemd';
import type { AntigelDeskState } from './deskState';

export type { AntigelDeskState } from './deskState';
import { ROOT_SLICE } from './units';

export const DESK_PROBE_MS = 300_000;
export const DESK_RETRY_MS = 300_000;
/** Unités dont l'origine est gardée au plus (bureau, applications, 6 terminaux et leurs slices, cwatch.slice). */
export const MAX_ORIGINALS = 32;
const KEYS = ['memoryLow', 'cpuWeight', 'ioWeight'] as const;
type Key = (typeof KEYS)[number];

/** Valeurs d'origine d'une unité (seulement les propriétés changées) : memoryLow null = infinity ; poids null = « non défini ». */
export interface DeskOriginal { cgroup: string; memoryLow?: number | null; cpuWeight?: number | null; ioWeight?: number | null }
export type DeskOriginals = Record<string, DeskOriginal>;

export type DeskFile = 'cgroup.controllers' | 'cgroup.subtree_control' | 'cpu.weight' | 'io.weight' | 'memory.low' | 'memory.min';

export interface DeskDeps {
  client: DeskClient;
  /** Fichier de contrôle d'un cgroup (« /user.slice/… ») ; null : absent ou illisible. */
  readCg: (cgroup: string, file: DeskFile) => string | null;
  /** Origines relues au démarrage du service (antigel-desk.json) ; appelée une fois, à la création. */
  loadOriginals?: () => DeskOriginals;
  /** Sauvegarde des origines, à chaque changement, AVANT tout appel qui modifie une unité. */
  saveOriginals?: (o: DeskOriginals) => void;
  monoNow: () => number;
  log: (msg: string) => void;
}

export interface DeskTickInput {
  /** Plafond de travail actif et interrupteur « Bureau prioritaire » allumé. */
  on: boolean;
  userBase: string;
  procs: readonly ProcInfo[];
  uid: number;
  cgroupOf: (pid: number) => string | null;
  reserveBytes: number | null;
  rootExists: boolean;
}

export interface DeskController {
  tick(i: DeskTickInput): void;
  state(): AntigelDeskState;
  idle(): Promise<void>;
  calls(): number;
}

// ── lectures sysfs ───────────────────────────────────────────────────────────────────────────────────────────────────
const int = (t: string | null): number | null => (t !== null && /^\d+$/.test(t.trim()) ? Number(t.trim()) : null);
/** memory.low / memory.min : octets ; « max » → null (infinity) ; absent → undefined. */
function memValue(t: string | null): number | null | undefined {
  if (t === null) return undefined;
  if (t.trim() === 'max') return null;
  const n = int(t);
  return n !== null && Number.isSafeInteger(n) ? n : undefined;
}
const ioWeight = (t: string | null): number | null => {
  const m = t === null ? null : /^default\s+(\d+)\s*$/m.exec(t);
  return m ? Number(m[1]) : null;
};
type Cur = Record<Key, number | null | undefined>;

/** Valeur d'origine à garder : la valeur lue, sauf si elle vaut déjà la nôtre (service relancé sans fichier) : défaut. */
function originOf(k: Key, cur: number | null | undefined, want: number): number | null {
  if (k === 'memoryLow') return cur === undefined || cur === want ? 0 : cur;
  return cur === undefined || cur === null || cur === want || cur === DEFAULT_WEIGHT ? null : cur;
}
/** La valeur lue correspond-elle à l'origine (rien à restaurer) ? */
function atOrigin(k: Key, cur: number | null | undefined, orig: number | null): boolean {
  if (k === 'memoryLow') return cur === orig;
  return orig === null ? cur === DEFAULT_WEIGHT || cur === null : cur === orig;
}

/** Origines relues : unités et cgroups valides, valeurs bornées, au plus MAX_ORIGINALS ; le reste est ignoré. */
export function sanitizeOriginals(raw: unknown): DeskOriginals {
  const out: DeskOriginals = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [unit, v] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_ORIGINALS)) {
    if (!(isDeskSliceName(unit) || isDeskUnitName(unit) || unit === ROOT_SLICE)) continue;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) continue;
    const r = v as Record<string, unknown>;
    if (typeof r.cgroup !== 'string' || !r.cgroup.startsWith('/') || r.cgroup.length > 1024 || r.cgroup.split('/').some((s) => s === '..' || s === '.')) continue;
    if (!r.cgroup.endsWith(`/${unit}`)) continue;
    const o: DeskOriginal = { cgroup: r.cgroup };
    let ok = true;
    for (const k of KEYS) {
      const x = r[k];
      if (x === undefined) continue;
      const valid = x === null || (Number.isSafeInteger(x) && (x as number) >= (k === 'memoryLow' ? 0 : 1) && (x as number) <= (k === 'memoryLow' ? 2 ** 52 : 10_000));
      if (!valid || (k === 'memoryLow' && unit === ROOT_SLICE)) ok = false;
      else o[k] = x as number | null;
    }
    if (ok) out[unit] = o;
  }
  return out;
}

export function createDeskPriority(deps: DeskDeps): DeskController {
  const originals = new Map<string, DeskOriginal>(Object.entries(sanitizeOriginals(deps.loadOriginals?.() ?? {})));
  let caps: (DeskCaps & { reason: string | null }) | null = null;
  let capsAt = 0;
  let downUntil = -Infinity;
  let downReason: string | null = null;
  /** Dernières valeurs envoyées par unité, et prochain essai permis si elles n'ont pas pris. */
  const posed = new Map<string, string>();
  const retryAt = new Map<string, number>();
  let inFlight: Promise<void> | null = null;
  let lastError: string | null = null;
  let st: AntigelDeskState = { status: 'off', reason: null, cpu: false, io: false, memory: 'off', units: [], truncated: false, restoring: 0 };

  const report = (msg: string) => {
    if (msg !== lastError) deps.log(`anti-gel (bureau prioritaire) : ${msg}`);
    lastError = msg;
  };
  const snapshot = (): DeskOriginals => Object.fromEntries([...originals].map(([u, o]) => [u, { ...o }]));
  const save = () => {
    try {
      deps.saveOriginals?.(snapshot());
    } catch (e) {
      report(`origines non enregistrées : ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const probe = (userBase: string): DeskCaps & { reason: string | null } => {
    const sub = deps.readCg(userBase, 'cgroup.subtree_control');
    const words = new Set((sub ?? '').trim().split(/\s+/));
    const cpu = words.has('cpu');
    const io = words.has('io');
    // Protection mémoire : bornée par celle de chaque ancêtre (memory_recursiveprot) ; sans protection sur user.slice,
    // user-<uid>.slice et user@<uid>.service (unités système), une MemoryLow posée dans la session n'agit pas.
    const parts = userBase.split('/').filter(Boolean);
    const chain = parts.map((_, k) => `/${parts.slice(0, k + 1).join('/')}`);
    const prot = (cg: string) => {
      const l = memValue(deps.readCg(cg, 'memory.low'));
      const m = memValue(deps.readCg(cg, 'memory.min'));
      return l === null || m === null || (l ?? 0) > 0 || (m ?? 0) > 0;
    };
    const memory = words.has('memory') && chain.length > 0 && chain.every(prot);
    const reason = sub === null ? 'contrôleurs de la session illisibles' : null;
    return { cpu, io, memory, reason };
  };

  const read = (cgroup: string, w: DeskWant | undefined, o: DeskOriginal | undefined): Cur => {
    const need = (k: Key) => (w && w[k] !== undefined) || (o && o[k] !== undefined);
    return {
      memoryLow: need('memoryLow') ? memValue(deps.readCg(cgroup, 'memory.low')) : undefined,
      cpuWeight: need('cpuWeight') ? int(deps.readCg(cgroup, 'cpu.weight')) : undefined,
      ioWeight: need('ioWeight') ? ioWeight(deps.readCg(cgroup, 'io.weight')) : undefined,
    };
  };

  type Step = { unit: string; props: DeskProps; restored: Key[]; key: string };
  const runSteps = (steps: Step[]) => {
    if (!steps.length) return;
    inFlight = (async () => {
      let failed = false;
      for (const s of steps) {
        try {
          await deps.client.setProps(s.unit, s.props);
          if (s.restored.length) {
            const o = originals.get(s.unit);
            if (o) {
              for (const k of s.restored) delete o[k];
              if (KEYS.every((k) => o[k] === undefined)) originals.delete(s.unit);
              save();
            }
          }
        } catch (e) {
          failed = true;
          const code = e instanceof BusctlError ? e.code : 'other';
          const msg = e instanceof Error ? e.message : String(e);
          report(msg);
          if (code === 'denied' || code === 'unreachable' || code === 'timeout') {
            downUntil = deps.monoNow() + DESK_PROBE_MS;
            downReason = `gestionnaire systemd injoignable : ${msg}`;
            return;
          }
          if (code === 'no-unit' && !s.unit.endsWith('.slice')) {
            originals.delete(s.unit); // service ou scope disparu : plus rien à restaurer
            save();
          }
        }
      }
      if (!failed && lastError !== null) {
        deps.log('anti-gel (bureau prioritaire) : appels systemd rétablis');
        lastError = null;
      }
    })().finally(() => {
      inFlight = null;
    });
  };

  const tick = (i: DeskTickInput) => {
    const now = deps.monoNow();
    if (downUntil > now) {
      st = { ...st, status: 'unavailable', reason: downReason, restoring: originals.size };
      return;
    }
    if (caps === null || now - capsAt >= DESK_PROBE_MS) {
      caps = probe(i.userBase);
      capsAt = now;
    }
    const t = i.on && i.reserveBytes !== null
      ? deskTargets({ procs: i.procs, uid: i.uid, userBase: i.userBase, cgroupOf: i.cgroupOf, reserveBytes: i.reserveBytes, caps, rootExists: i.rootExists })
      : null;
    const want = t?.units ?? new Map<string, DeskWant>();
    const memory = !i.on ? 'off' : caps.memory ? 'on' : 'ineffective';
    st = {
      status: i.on ? (caps.reason ? 'unavailable' : 'active') : 'off', reason: i.on ? caps.reason : null, cpu: i.on && caps.cpu, io: i.on && caps.io,
      memory, units: [...want.keys()], truncated: t?.truncated ?? false, restoring: [...originals.keys()].filter((u) => !want.has(u)).length,
    };
    if (inFlight) return;

    const steps: Step[] = [];
    let dirty = false;
    for (const unit of new Set([...want.keys(), ...originals.keys()])) {
      const w = want.get(unit);
      const o = originals.get(unit);
      const cgroup = w?.cgroup ?? o!.cgroup;
      const exists = deps.readCg(cgroup, 'cgroup.controllers') !== null;
      if (!exists) {
        // Unité disparue : un service ou un scope ne revient pas sous ce nom (rien à restaurer) ; une slice peut revenir et
        // reprendrait nos valeurs runtime : ses origines sont restaurées malgré tout.
        if (o && !unit.endsWith('.slice')) {
          originals.delete(unit);
          dirty = true;
        } else if (o && !w) {
          const restored = KEYS.filter((k) => o[k] !== undefined);
          const props: DeskProps = Object.fromEntries(restored.map((k) => [k, o[k]]));
          if ((retryAt.get(unit) ?? -Infinity) <= now) {
            retryAt.set(unit, now + DESK_RETRY_MS);
            steps.push({ unit, props, restored, key: '' });
          }
        }
        continue;
      }
      const cur = read(cgroup, w, o);
      const props: DeskProps = {};
      const restored: Key[] = [];
      // propriétés gardées mais plus voulues (interrupteur éteint, terminal fermé, protection devenue sans effet)
      if (o) {
        for (const k of KEYS) {
          if (o[k] === undefined || (w && w[k] !== undefined)) continue;
          restored.push(k);
          if (!atOrigin(k, cur[k], o[k]!)) props[k] = o[k];
        }
      }
      if (w) {
        let entry = o;
        for (const k of KEYS) {
          const v = w[k];
          if (v === undefined) continue;
          if (!entry || entry[k] === undefined) {
            if (!entry && originals.size >= MAX_ORIGINALS) break; // jamais une valeur posée sans origine gardée
            entry ??= { cgroup };
            entry[k] = originOf(k, cur[k], v);
            originals.set(unit, entry);
            dirty = true;
          }
          if (cur[k] !== v) props[k] = v;
        }
        // une valeur voulue sans origine gardée (limite atteinte) n'est jamais posée
        for (const k of KEYS) if (props[k] !== undefined && w[k] !== undefined && entry?.[k] === undefined) delete props[k];
      }
      if (!Object.keys(props).length) {
        if (restored.length) {
          // déjà à l'origine : rien à appeler
          for (const k of restored) delete o![k];
          if (KEYS.every((k) => o![k] === undefined)) originals.delete(unit);
          dirty = true;
        }
        if (w) posed.delete(unit);
        continue;
      }
      const key = JSON.stringify(props);
      if (posed.get(unit) === key && (retryAt.get(unit) ?? -Infinity) > now) continue; // pas encore pris : recul
      posed.set(unit, key);
      retryAt.set(unit, now + DESK_RETRY_MS);
      steps.push({ unit, props, restored, key });
    }
    for (const u of [...posed.keys()]) if (!want.has(u) && !originals.has(u)) posed.delete(u);
    for (const u of [...retryAt.keys()]) if (!want.has(u) && !originals.has(u)) retryAt.delete(u);
    if (dirty) save(); // origines enregistrées AVANT tout appel qui modifie une unité
    st.restoring = [...originals.keys()].filter((u) => !want.has(u)).length;
    runSteps(steps);
  };

  return {
    tick,
    // restoring relu en direct : la fin d'un enchaînement en vol compte
    state: () => ({ ...st, units: [...st.units], restoring: [...originals.keys()].filter((u) => !st.units.includes(u)).length }),
    async idle() {
      while (inFlight) await inFlight;
    },
    calls: () => deps.client.calls(),
  };
}
