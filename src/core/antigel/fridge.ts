// Anti-gel (lot 3) : « mettre au frigo » un projet déjà rangé sous le plafond de travail. Gel de toute la slice du projet
// (FreezeUnit, récursif : ses scopes passent « frozen-by-parent »), puis memory.reclaim par morceaux pour pousser sa mémoire
// en swap / zswap ; « Réveiller » : ThawUnit. Les appels partent en arrière-plan, un à la fois : le tick n'attend jamais.
//
// Jamais gelé par oubli : aucun état persistant ; au démarrage du service, puis toutes les 60 s, toute slice de projet gelée
// que ce service n'a pas dans son frigo est dégelée ; interrupteur éteint (ou anti-gel non actif) : tout est dégelé ; arrêt
// du service : dégel synchrone (thawAllSync).
// Jamais hors de cwatch.slice : seule une slice cwatch-p-<clé>.slice attribuée par le contrôleur à la racine demandée,
// peuplée, hors « autres », sur son chemin réel …/cwatch.slice/cwatch-p.slice/<slice>, peut être gelée.
import { parseLimit, type Availability } from './cgroupfs';
import type { FridgeClient } from './fridgeSystemd';
import { MAX_FROZEN, type FridgeEntryState, type FridgeNotice, type FridgePhase, type FridgeRequest } from './fridgeState';
import type { AntigelState } from './state';
import { BusctlError } from './systemd';
import { OTHERS_SLICE, ROOT_SLICE, isProdProjectSliceName, isScopeName, slicePath } from './units';

export const SWEEP_EVERY_MS = 60_000;
export const PROBE_EVERY_MS = 300_000;
/** Morceau de memory.reclaim : une écriture courte, puis une pause (le noyau et le reste du bureau respirent). */
export const RECLAIM_CHUNK = 64 * 1024 * 1024;
export const RECLAIM_PAUSE_MS = 20;
/** Durée maximale d'une mise au frigo (reclaim compris) ; au-delà, le projet reste gelé, sans pousser plus. */
export const RECLAIM_MAX_MS = 120_000;
/** Swap libre jamais entamée par le frigo (le reste du système en a besoin). */
export const SWAP_MARGIN = 1024 * 1024 * 1024;
/** Au plus 64 Gio poussés par mise au frigo. */
export const RECLAIM_MAX_BYTES = 64 * 1024 * 1024 * 1024;
/** Dégel synchrone à l'arrêt : jamais plus de 15 s au total. */
export const STOP_DEADLINE_MS = 15_000;
/** Nouvel essai d'un réveil en échec. */
export const THAW_RETRY_MS = 60_000;
/** Attente de l'état effectif « frozen 1 » (cgroup.events) après FreezeUnit. */
export const FREEZE_CONFIRM_MS = 2_000;
/** Mémoire des processus vus au frigo (règle « inactif depuis T », au plus 720 h) : 31 jours, 20 000 processus au plus. */
const FROZEN_MEMORY_MS = 31 * 24 * 3600_000;
const FROZEN_MEMORY_MAX = 20_000;
const MAX_PIDS = 8192;

export interface FridgeDeps {
  client: FridgeClient;
  probe: () => Availability;
  /** Lecture d'un fichier de cgroup (`cg` : « /user.slice/… ») ; null : absent ou illisible. */
  read: (cg: string, file: string) => string | null;
  /** Sous-dossiers (cgroups enfants) ; null : absent. */
  list: (cg: string) => string[] | null;
  /** `bytes` écrits dans memory.reclaim du cgroup, hors de la boucle d'événements ; « again » : EAGAIN (pas tout récupéré). */
  reclaim: (cg: string, bytes: number) => Promise<'ok' | 'again'>;
  monoNow: () => number;
  log: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Swap libre en octets, relue avant chaque morceau de reclaim (/proc/meminfo) ; absente : valeur du tick de la demande. */
  swapFreeBytes?: () => number | null;
}

export interface FridgeTickInput {
  ts: number;
  /** État du contrôleur du lot 1 après son tick (attribution des slices, projets peuplés, statut). */
  antigel: AntigelState;
  swapFreeKB: number;
  requests: readonly FridgeRequest[];
}

export interface Fridge {
  tick(i: FridgeTickInput): void;
  /** Slices gelées (ou en cours de gel / de dégel) : le contrôleur n'y range plus rien. */
  frozenSlices(): ReadonlySet<string>;
  /** Processus des slices gelées (lus au dernier tick) : jamais visés par les règles automatiques. */
  frozenPids(): ReadonlySet<number>;
  publish(): { fridge: FridgeEntryState[]; fridgeNotice: FridgeNotice | null };
  /** Arrêt du service : tout ce qui est gelé est dégelé, de façon synchrone et bornée. */
  thawAllSync(): void;
  /**
   * Démarrage du service, avant tout le reste (base comprise) : toute slice de projet gelée est dégelée, de façon synchrone et
   * bornée. Un service qui ne démarre pas jusqu'au bout ne laisse donc jamais un projet gelé.
   */
  startupThawSync(): void;
  /** Le processus était-il au frigo à `sinceWall` ou après ? (« inactif depuis T » ne compte pas une période au frigo) */
  frozenSince(pid: number, sinceWall: number): boolean;
  idle(): Promise<void>;
}

/** `retryAt` : réveil en échec, nouvel essai à cette heure (horloge monotone) ; l'entrée reste (règles, contrôleur, badge). */
interface Entry { unit: string; root: string; since: number; phase: FridgePhase; reclaimedKB: number; abort: boolean; retryAt?: number }

const num = (t: string | null): number | null => {
  const s = t?.trim();
  if (!s || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
};

/** Champs anon / file de memory.stat (octets). */
export function parseMemoryStat(text: string | null): { anon: number; file: number } {
  const out = { anon: 0, file: 0 };
  for (const line of (text ?? '').split('\n')) {
    const [k, v] = line.trim().split(/\s+/);
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) continue;
    if (k === 'anon') out.anon = n;
    else if (k === 'file') out.file = n;
  }
  return out;
}

/**
 * Quantité à récupérer : tout le cache de fichiers (relu depuis le disque au réveil) + la mémoire anonyme dans la limite de
 * la swap disponible : swap libre moins SWAP_MARGIN, et marge de cwatch.slice (memory.swap.max − memory.swap.current) si
 * elle est comptée. Jamais plus que memory.current ni RECLAIM_MAX_BYTES.
 */
export function reclaimTarget(o: {
  stat: string | null; currentBytes: number | null; swapFreeBytes: number; rootSwapMax: string | null; rootSwapCurrent: string | null;
}): number {
  if (o.currentBytes === null || o.currentBytes <= 0) return 0;
  const { anon, file } = parseMemoryStat(o.stat);
  let room = Math.max(0, o.swapFreeBytes - SWAP_MARGIN);
  // fichier absent : swap non comptée par cgroup (swapaccount=0), seule la swap libre borne ; « max » : pas de plafond
  if (o.rootSwapMax !== null && o.rootSwapMax.trim() !== 'max') {
    const max = parseLimit(o.rootSwapMax);
    const cur = num(o.rootSwapCurrent);
    room = max === null || cur === null ? 0 : Math.min(room, Math.max(0, max - cur));
  }
  return Math.max(0, Math.floor(Math.min(file + Math.min(anon, room), o.currentBytes, RECLAIM_MAX_BYTES)));
}

const label = (root: string) => root.split('/').filter(Boolean).pop() ?? root;
const giB = (kb: number) => `${(kb / 1024 / 1024).toFixed(1).replace('.', ',')} Go`;

export function createFridge(deps: FridgeDeps): Fridge {
  const client = deps.client;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const entries = new Map<string, Entry>();
  /** Dégels en file ou en cours (slices peut-être encore gelées, hors de `entries` pour celles trouvées par le balayage). */
  const thawing = new Set<string>();
  let avail: Availability | null = null;
  let probedAt = 0;
  let sweptAt: number | null = null;
  let pids: ReadonlySet<number> = new Set();
  let notice: FridgeNotice | null = null;
  let lastTs = 0;
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  /** Reclaims à part de la file des appels : un réveil n'attend jamais le reclaim d'un autre projet. */
  let reclaimChain: Promise<void> = Promise.resolve();
  let reclaiming = 0;
  let stopped = false;
  const lastFrozen = new Map<number, number>();

  const base = () => (avail?.ok ? avail.userBase : null);
  const cgOf = (b: string, slice: string) => `${b}/${slicePath(slice)}`;
  /** Slices de projet de production : seulement sous …/cwatch.slice/cwatch-p.slice/ (algorithme des « - » de systemd). */
  const projectsDir = (b: string) => `${b}/${ROOT_SLICE}/cwatch-p.slice`;
  const say = (root: string | null, text: string, ok: boolean) => {
    deps.log(`anti-gel (frigo) : ${text}`);
    if (root !== null) notice = { root, text: text.slice(0, 300), ok, at: lastTs };
  };
  const queue = (job: () => Promise<void>) => {
    pending++;
    chain = chain.then(job).catch((e) => deps.log(`anti-gel (frigo) : ${e instanceof Error ? e.message : String(e)}`)).finally(() => {
      pending--;
    });
  };
  /** Gel demandé sur la slice elle-même (cgroup.freeze) : « gelée par nous ou par un autre ». */
  const frozenNow = (b: string, slice: string) => deps.read(cgOf(b, slice), 'cgroup.freeze')?.trim() === '1';
  /** Gel effectif (cgroup.events « frozen 1 ») : tous les processus de la slice sont arrêtés. */
  const frozenEffective = (b: string, slice: string) => /^frozen 1$/m.test(deps.read(cgOf(b, slice), 'cgroup.events') ?? '');

  const queueThaw = (slice: string, root: string | null, why: string) => {
    if (thawing.has(slice)) return;
    const e = entries.get(slice);
    if (e) {
      e.abort = true;
      e.phase = 'thawing';
    }
    thawing.add(slice);
    queue(async () => {
      try {
        await client.thaw(slice);
        entries.delete(slice);
        say(root, `« ${root ? label(root) : slice} » réveillé (${why})`, true);
      } catch (err) {
        if (err instanceof BusctlError && err.code === 'no-unit') entries.delete(slice);
        else {
          // l'entrée reste (toujours gelée : règles, contrôleur et badge la voient) ; nouvel essai dans 60 s. Une slice trouvée
          // par le balayage (sans entrée) est reprise par le balayage suivant.
          const cur = entries.get(slice);
          if (cur) cur.retryAt = deps.monoNow() + THAW_RETRY_MS;
          say(root, `réveil de « ${root ? label(root) : slice} » en échec, nouvel essai sous une minute : ${err instanceof Error ? err.message : String(err)}`, false);
        }
      } finally {
        thawing.delete(slice);
      }
    });
  };

  const reclaimLoop = async (e: Entry, b: string, swapFreeKB: number) => {
    const cg = cgOf(b, e.unit);
    const rootCg = `${b}/${ROOT_SLICE}`;
    const before = num(deps.read(cg, 'memory.current'));
    const swapFree = () => deps.swapFreeBytes?.() ?? swapFreeKB * 1024;
    const target = reclaimTarget({
      stat: deps.read(cg, 'memory.stat'), currentBytes: before, swapFreeBytes: swapFree(),
      rootSwapMax: deps.read(rootCg, 'memory.swap.max'), rootSwapCurrent: deps.read(rootCg, 'memory.swap.current'),
    });
    /** Place de swap encore permise, relue avant chaque morceau (autres projets au frigo, reste du système). */
    const room = (): number => {
      let r = swapFree() - SWAP_MARGIN;
      const max = deps.read(rootCg, 'memory.swap.max');
      if (max !== null && max.trim() !== 'max') {
        const m = parseLimit(max);
        const c = num(deps.read(rootCg, 'memory.swap.current'));
        r = m === null || c === null ? 0 : Math.min(r, m - c);
      }
      return r;
    };
    const t0 = deps.monoNow();
    let done = 0;
    let again = 0;
    while (done < target && again < 2 && !e.abort && deps.monoNow() - t0 < RECLAIM_MAX_MS) {
      // dégelé entre-temps (systemctl thaw, slice disparue) : jamais de reclaim sur un projet qui tourne
      if (!frozenNow(b, e.unit) || !frozenEffective(b, e.unit)) break;
      // plus de place en swap (marge atteinte) : arrêt, le noyau choisit lui-même ce qu'il pousse
      if (room() <= 0) break;
      const n = Math.min(RECLAIM_CHUNK, target - done);
      let r: 'ok' | 'again';
      try {
        r = await deps.reclaim(cg, n);
      } catch (err) {
        deps.log(`anti-gel (frigo) : reclaim de ${e.unit} interrompu : ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      if (r === 'again') again++;
      else {
        again = 0;
        done += n;
      }
      const cur = num(deps.read(cg, 'memory.current'));
      if (cur !== null && before !== null) e.reclaimedKB = Math.max(0, Math.round((before - cur) / 1024));
      await sleep(RECLAIM_PAUSE_MS);
    }
  };

  const freeze = (slice: string, root: string, ts: number, swapFreeKB: number) => {
    const e: Entry = { unit: slice, root, since: ts, phase: 'freezing', reclaimedKB: 0, abort: false };
    entries.set(slice, e);
    queue(async () => {
      if (entries.get(slice) !== e || e.abort || stopped) return; // réveil demandé avant le gel, ou service à l'arrêt
      const b = base();
      if (!b) return void entries.delete(slice);
      try {
        await client.freeze(slice);
      } catch (err) {
        entries.delete(slice);
        say(root, `mise au frigo de « ${label(root)} » en échec : ${err instanceof Error ? err.message : String(err)}`, false);
        // gel peut-être partiel (délai dépassé) : dégel par sécurité
        queueThaw(slice, null, 'gel en échec');
        return;
      }
      // gel effectif (tous les processus arrêtés) avant tout reclaim
      const t0 = deps.monoNow();
      for (let k = 0; k < FREEZE_CONFIRM_MS / 100 && !(frozenNow(b, slice) && frozenEffective(b, slice)) && deps.monoNow() - t0 < FREEZE_CONFIRM_MS; k++) await sleep(100);
      if (!(frozenNow(b, slice) && frozenEffective(b, slice))) {
        entries.delete(slice);
        say(root, `mise au frigo de « ${label(root)} » non confirmée par le noyau : projet réveillé`, false);
        queueThaw(slice, null, 'gel non confirmé');
        return;
      }
      if (e.abort) return;
      // part de swap du budget (memory.swap.max de la slice) levée avant de pousser : sinon le reclaim s'arrêterait à elle ;
      // le contrôleur la repose au réveil. Échec : le frigo pousse quand même, borné par elle.
      const swapMax = deps.read(cgOf(b, slice), 'memory.swap.max');
      if (swapMax !== null && swapMax.trim() !== 'max') {
        try {
          await client.liftSwap(slice);
        } catch (err) {
          deps.log(`anti-gel (frigo) : part de swap de ${slice} gardée : ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (e.abort) return;
      e.phase = 'reclaiming';
      // reclaim hors de la file des appels : un réveil (de ce projet ou d'un autre) part tout de suite
      reclaiming++;
      reclaimChain = reclaimChain.then(async () => {
        if (entries.get(slice) !== e || e.abort) return;
        await reclaimLoop(e, b, swapFreeKB);
        if (entries.get(slice) !== e || e.abort) return;
        e.phase = 'frozen';
        say(root, `« ${label(root)} » au frigo${e.reclaimedKB >= 1024 ? ` : ≈ ${giB(e.reclaimedKB)} sortis de la RAM` : ''}`, true);
      }).catch((err) => deps.log(`anti-gel (frigo) : ${err instanceof Error ? err.message : String(err)}`)).finally(() => {
        reclaiming--;
      });
    });
  };

  const sweep = (b: string) => {
    const names = deps.list(projectsDir(b)) ?? [];
    for (const n of names) {
      if (!isProdProjectSliceName(n) || entries.has(n) || thawing.has(n)) continue;
      if (frozenNow(b, n)) queueThaw(n, null, 'gelé sans être dans le frigo du service');
    }
  };

  const readPids = (b: string): Set<number> => {
    const out = new Set<number>();
    for (const slice of new Set([...entries.keys(), ...thawing])) {
      const cg = cgOf(b, slice);
      for (const scope of deps.list(cg) ?? []) {
        if (!isScopeName(scope)) continue;
        for (const l of (deps.read(`${cg}/${scope}`, 'cgroup.procs') ?? '').split('\n')) {
          const p = num(l);
          if (p !== null && p > 1 && out.size < MAX_PIDS) out.add(p);
        }
      }
    }
    return out;
  };

  const requestFreeze = (r: FridgeRequest, i: FridgeTickInput, b: string) => {
    const a = i.antigel;
    if (a.status !== 'active' || !a.enabled) return say(r.root, `« ${label(r.root)} » non mis au frigo : plafond de travail éteint ou indisponible`, false);
    const slice = Object.entries(a.slices).find(([, root]) => root === r.root)?.[0];
    const placed = slice !== undefined && isProdProjectSliceName(slice) && slice !== OTHERS_SLICE &&
      a.projects.some((p) => p.unit === slice && p.root === r.root && p.procs > 0);
    if (!placed) return say(r.root, `« ${label(r.root)} » non mis au frigo : aucun de ses processus n’est sous le plafond de travail`, false);
    const cur = entries.get(slice);
    if (cur) {
      if (cur.phase === 'thawing') say(r.root, `« ${label(r.root)} » : réveil en cours, réessayer dans un instant`, false);
      return;
    }
    if (thawing.has(slice)) return say(r.root, `« ${label(r.root)} » : réveil en cours, réessayer dans un instant`, false);
    if (entries.size >= MAX_FROZEN) return say(r.root, `« ${label(r.root)} » non mis au frigo : déjà ${MAX_FROZEN} projets au frigo`, false);
    const cg = cgOf(b, slice);
    if (!cg.startsWith(`${projectsDir(b)}/`) || deps.read(cg, 'cgroup.freeze') === null) {
      return say(r.root, `« ${label(r.root)} » non mis au frigo : sa slice est introuvable sous le plafond de travail`, false);
    }
    freeze(slice, r.root, i.ts, i.swapFreeKB);
  };

  const requestThaw = (r: FridgeRequest, i: FridgeTickInput, b: string) => {
    for (const e of entries.values()) if (e.root === r.root) return queueThaw(e.unit, e.root, 'demandé');
    const slice = Object.entries(i.antigel.slices).find(([, root]) => root === r.root)?.[0];
    if (slice && isProdProjectSliceName(slice) && slice !== OTHERS_SLICE && frozenNow(b, slice)) return queueThaw(slice, r.root, 'demandé');
    say(r.root, `« ${label(r.root)} » n’est pas au frigo`, true);
  };

  return {
    tick(i) {
      lastTs = i.ts;
      const now = deps.monoNow();
      if (avail === null || (!avail.ok && now - probedAt >= PROBE_EVERY_MS)) {
        avail = deps.probe();
        probedAt = now;
      }
      const b = base();
      if (!b) {
        for (const r of i.requests) if (r.action === 'freeze') say(r.root, `« ${label(r.root)} » non mis au frigo : plafond de travail indisponible`, false);
        pids = new Set();
        return;
      }
      // une seule demande par racine : la dernière
      const last = new Map<string, FridgeRequest>();
      for (const r of i.requests) last.set(r.root, r);
      for (const r of last.values()) (r.action === 'freeze' ? requestFreeze : requestThaw)(r, i, b);
      // interrupteur éteint, réserve trop grande, indisponible : plus rien au frigo
      if (i.antigel.status !== 'active' || !i.antigel.enabled) {
        for (const e of [...entries.values()]) if (e.phase !== 'thawing') queueThaw(e.unit, e.root, 'plafond de travail éteint');
      }
      // réveils en échec : nouvel essai
      for (const e of [...entries.values()]) {
        if (e.phase === 'thawing' && !thawing.has(e.unit) && (e.retryAt ?? Infinity) <= now) queueThaw(e.unit, e.root, 'nouvel essai');
      }
      // projets dégelés par un autre (systemctl thaw) ou slice disparue : sortis du frigo
      for (const e of [...entries.values()]) {
        if (e.phase !== 'frozen' && e.phase !== 'reclaiming') continue;
        const f = deps.read(cgOf(b, e.unit), 'cgroup.freeze')?.trim();
        // plus aucun processus (tous arrêtés, « Forcer ») : réveillé, sinon le projet resterait invisible et fermé au plafond
        if (f === '1' && /^populated 0$/m.test(deps.read(cgOf(b, e.unit), 'cgroup.events') ?? '')) {
          queueThaw(e.unit, e.root, 'plus aucun processus');
          continue;
        }
        if (f === '1') continue;
        entries.delete(e.unit);
        e.abort = true;
        say(e.root, f === undefined ? `« ${label(e.root)} » : slice disparue, sortie du frigo` : `« ${label(e.root)} » réveillé hors de l’app`, true);
      }
      if (sweptAt === null || now - sweptAt >= SWEEP_EVERY_MS || now < sweptAt) {
        sweptAt = now;
        sweep(b);
      }
      pids = entries.size || thawing.size ? readPids(b) : new Set();
      // processus vus au frigo (horloge murale) : « inactif depuis T » ne compte jamais une période au frigo
      for (const p of pids) lastFrozen.set(p, i.ts);
      if (lastFrozen.size > FROZEN_MEMORY_MAX || (lastFrozen.size && now === sweptAt)) {
        for (const [p, at] of lastFrozen) if (i.ts - at > FROZEN_MEMORY_MS || i.ts < at) lastFrozen.delete(p);
        while (lastFrozen.size > FROZEN_MEMORY_MAX) lastFrozen.delete(lastFrozen.keys().next().value!);
      }
    },
    frozenSince: (pid, sinceWall) => (lastFrozen.get(pid) ?? -Infinity) >= sinceWall,
    frozenSlices: () => new Set([...entries.keys(), ...thawing]),
    frozenPids: () => pids,
    publish: () => ({
      fridge: [...entries.values()].slice(0, MAX_FROZEN).map((e) => ({ unit: e.unit, root: e.root, since: e.since, phase: e.phase, reclaimedKB: e.reclaimedKB })),
      fridgeNotice: notice,
    }),
    startupThawSync() {
      const now = deps.monoNow();
      avail = deps.probe();
      probedAt = now;
      const b = base();
      if (!b) return;
      sweptAt = now;
      const t0 = deps.monoNow();
      for (const n of deps.list(projectsDir(b)) ?? []) {
        if (!isProdProjectSliceName(n) || !frozenNow(b, n)) continue;
        if (deps.monoNow() - t0 > STOP_DEADLINE_MS) {
          deps.log('anti-gel (frigo) : démarrage, dégel interrompu (délai) ; le balayage reprendra');
          sweptAt = null;
          break;
        }
        try {
          client.thawSync(n);
          deps.log(`anti-gel (frigo) : ${n} dégelée au démarrage du service`);
        } catch (err) {
          sweptAt = null; // balayage au premier tick
          deps.log(`anti-gel (frigo) : dégel de ${n} au démarrage en échec : ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    thawAllSync() {
      stopped = true;
      const t0 = deps.monoNow();
      const b = base();
      const all = new Set([...entries.keys(), ...thawing]);
      if (b) for (const n of deps.list(projectsDir(b)) ?? []) if (isProdProjectSliceName(n) && frozenNow(b, n)) all.add(n);
      for (const e of entries.values()) e.abort = true;
      for (const s of all) {
        if (deps.monoNow() - t0 > STOP_DEADLINE_MS) {
          deps.log('anti-gel (frigo) : arrêt, dégel interrompu (délai) ; le prochain démarrage du service dégèlera le reste');
          break;
        }
        try {
          client.thawSync(s);
          deps.log(`anti-gel (frigo) : ${s} dégelée à l’arrêt du service`);
        } catch (err) {
          deps.log(`anti-gel (frigo) : dégel de ${s} à l’arrêt en échec : ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      entries.clear();
    },
    async idle() {
      while (pending > 0 || reclaiming > 0) {
        await chain;
        await reclaimChain;
      }
    },
  };
}
