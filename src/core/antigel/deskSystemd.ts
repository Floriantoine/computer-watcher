// Anti-gel (lot 2) : SetUnitProperties du bureau prioritaire. Runtime seulement (rien de persistant), noms validés,
// trois propriétés possibles et rien d'autre : MemoryLow (protection), CPUWeight, IOWeight (poids). Jamais de plafond,
// de gel ni de signal hors de cwatch.slice ; cwatch.slice ne reçoit que des poids.
import { INFINITY_T } from './limits';
import { WEIGHT_MAX, WEIGHT_MIN, isDeskSliceName, isDeskUnitName } from './deskUnits';
import { head, type BusctlRun } from './systemd';
import { isRootSliceName, isTestUnitName } from './units';

/** memoryLow : octets (null : infinity) ; cpuWeight / ioWeight : 1 à 10 000 (null : « non défini », défaut de systemd). */
export interface DeskProps { memoryLow?: number | null; cpuWeight?: number | null; ioWeight?: number | null }
const KEYS = ['memoryLow', 'cpuWeight', 'ioWeight'] as const;
const MAX_LOW = 2 ** 52;

function weight(v: number | null): string {
  if (v === null) return INFINITY_T;
  // 0 vaut « idle » pour systemd (cpu.idle) : jamais envoyé
  if (!Number.isInteger(v) || v < WEIGHT_MIN || v > WEIGHT_MAX) throw new Error(`poids refusé : ${v}`);
  return String(v);
}
function low(v: number | null): string {
  if (v === null) return INFINITY_T;
  if (!Number.isSafeInteger(v) || v < 0 || v > MAX_LOW) throw new Error(`protection mémoire refusée : ${v}`);
  return String(v);
}

export function setDeskPropsArgv(unit: string, p: DeskProps): string[] {
  const desk = isDeskSliceName(unit) || isDeskUnitName(unit);
  const test = isTestUnitName(unit);
  const work = isRootSliceName(unit) && !test; // cwatch.slice : poids seulement
  if (!desk && !test && !work) throw new Error(`unité refusée : ${unit}`);
  if (Object.keys(p).some((k) => !(KEYS as readonly string[]).includes(k))) throw new Error('propriété refusée');
  const props: string[] = [];
  if (p.memoryLow !== undefined) {
    if (work) throw new Error(`protection mémoire refusée sur ${unit}`);
    props.push('MemoryLow', 't', low(p.memoryLow));
  }
  if (p.cpuWeight !== undefined) props.push('CPUWeight', 't', weight(p.cpuWeight));
  if (p.ioWeight !== undefined) props.push('IOWeight', 't', weight(p.ioWeight));
  if (!props.length) throw new Error('aucune propriété');
  return [...head('SetUnitProperties', 'sba(sv)'), unit, 'true', String(props.length / 3), ...props];
}

export interface DeskClient {
  setProps(unit: string, p: DeskProps): Promise<void>;
  /** Appels busctl lancés depuis la création. */
  calls(): number;
}

export function createDeskClient(run: BusctlRun): DeskClient {
  let n = 0;
  return {
    async setProps(unit, p) {
      const argv = setDeskPropsArgv(unit, p); // validé avant le comptage : un nom refusé ne lance rien
      n++;
      await run(argv);
    },
    calls: () => n,
  };
}
