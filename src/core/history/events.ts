import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

export type EventType = 'earlyoom_kill' | 'pressure' | 'gap' | 'app_kill' | 'leak' | 'tmpfs' | 'forecast' | 'rule_action' | 'rule_dry_run' | 'earlyoom_setup' | 'tmp_clean' | 'disk_low' | 'disk_clean';

const EARLYOOM = /sending (SIGTERM|SIGKILL) to process (\d+)(?: uid (\d+))? "([^"]*)"/;

export function parseEarlyoom(message: string): { signal: 'SIGTERM' | 'SIGKILL'; pid: number; uid: number | null; name: string } | null {
  const m = message.match(EARLYOOM);
  if (!m) return null;
  return { signal: m[1] as 'SIGTERM' | 'SIGKILL', pid: Number(m[2]), uid: m[3] ? Number(m[3]) : null, name: m[4] };
}

export function parseJournalLine(line: string): { ts: number; message: string } | null {
  try {
    const o = JSON.parse(line) as { __REALTIME_TIMESTAMP?: string; MESSAGE?: unknown };
    if (!o.__REALTIME_TIMESTAMP || typeof o.MESSAGE !== 'string') return null;
    const ts = Math.floor(Number(o.__REALTIME_TIMESTAMP) / 1000);
    if (!Number.isFinite(ts)) return null;
    return { ts, message: o.MESSAGE };
  } catch {
    return null;
  }
}

export function detectGap(lastTs: number | null, now: number, intervalSec: number): { from: number; to: number } | null {
  if (lastTs === null || now - lastTs <= 3 * intervalSec * 1000) return null;
  return { from: lastTs, to: now };
}

export function shouldRecordPressure(psi: number | null, lastPressureTs: number | null, now: number): boolean {
  if (psi === null || psi < 25) return false;
  return lastPressureTs === null || now - lastPressureTs >= 60_000;
}

/** `belowSince` : début de la période continue sous le seuil de réarmement (null si au-dessus). */
export interface TmpfsAlertState { lastTs: number | null; armed: boolean; belowSince: number | null }

const TMPFS_REPEAT_MS = 3600_000;
/** Hystérésis : réarmée seulement sous 90 % du seuil, pendant 5 min continues (évite le battement autour du seuil). */
const TMPFS_REARM_RATIO = 0.9;
const TMPFS_REARM_MS = 5 * 60_000;

/**
 * Alerte « fichiers en mémoire » : Shmem strictement au-dessus du seuil, et (réarmée, ou jamais émise, ou dernière
 * il y a au moins 1 h). Réarmement après 5 min continues sous 90 % du seuil. Shmem inconnu (null) : rien.
 */
export function shouldRecordTmpfs(
  shmemKB: number | null,
  thresholdKB: number,
  state: TmpfsAlertState,
  now: number,
): { record: boolean; state: TmpfsAlertState } {
  if (shmemKB === null) return { record: false, state };
  if (shmemKB > thresholdKB) {
    if (state.armed || state.lastTs === null || now - state.lastTs >= TMPFS_REPEAT_MS) {
      return { record: true, state: { lastTs: now, armed: false, belowSince: null } };
    }
    return { record: false, state: { ...state, belowSince: null } };
  }
  if (shmemKB >= thresholdKB * TMPFS_REARM_RATIO) return { record: false, state: { ...state, belowSince: null } };
  const belowSince = state.belowSince ?? now;
  return { record: false, state: { lastTs: state.lastTs, armed: state.armed || now - belowSince >= TMPFS_REARM_MS, belowSince } };
}

/** Installation / activation d'earlyoom lancée depuis l'app (pkexec exécuté) : mode, résultat, code de sortie (null : délai dépassé). */
export interface EarlyoomSetupEvent {
  ts: number;
  type: 'earlyoom_setup';
  groupKey: null;
  detail: { mode: 'install' | 'activate'; ok: boolean; code: number | null; timedOut?: true };
}

function parseSetupEvent(obj: Record<string, unknown>): EarlyoomSetupEvent | null {
  if (obj.groupKey !== null) return null;
  const d = obj.detail;
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return null;
  const { mode, ok, code, timedOut } = d as Record<string, unknown>;
  if (mode !== 'install' && mode !== 'activate') return null;
  if (typeof ok !== 'boolean' || !(code === null || Number.isSafeInteger(code))) return null;
  return { ts: obj.ts as number, type: 'earlyoom_setup', groupKey: null, detail: { mode, ok, code: code as number | null, ...(timedOut === true ? { timedOut: true as const } : {}) } };
}

export interface AppKillEvent {
  ts: number;
  type: 'app_kill';
  groupKey: string | null;
  /** `targets` : identité pid + startTicks des processus tués (absente des événements plus anciens). */
  detail: { pids: number[]; signal: string; targets?: { pid: number; startTicks: number }[] };
}

/** Éléments de /tmp supprimés depuis l'app (B1 bis). */
export interface TmpCleanEvent {
  ts: number;
  type: 'tmp_clean';
  groupKey: null;
  /** `partial` : un élément a pu être supprimé en partie (échec en cours de route, reste en quarantaine). */
  detail: { freedKB: number; deleted: string[]; refused: { name: string; reason: string }[]; partial?: true };
}

/** Ménage du disque depuis la page Disque : familles traitées, refusées (avec la raison), place libérée (statfs). */
export interface DiskCleanEvent {
  ts: number;
  type: 'disk_clean';
  groupKey: null;
  detail: { freedKB: number; done: string[]; refused: { id: string; reason: string }[] };
}

export type AppEvent = AppKillEvent | EarlyoomSetupEvent | TmpCleanEvent | DiskCleanEvent;

function parseDiskClean(obj: Record<string, unknown>): DiskCleanEvent | null {
  if (obj.groupKey !== null) return null;
  const d = obj.detail as Record<string, unknown> | null;
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return null;
  if (!Number.isFinite(d.freedKB as number)) return null;
  if (!Array.isArray(d.done) || !d.done.every((n: unknown) => typeof n === 'string')) return null;
  const okRefused = (x: unknown) => typeof x === 'object' && x !== null && typeof (x as { id: unknown }).id === 'string' && typeof (x as { reason: unknown }).reason === 'string';
  if (!Array.isArray(d.refused) || !d.refused.every(okRefused)) return null;
  return {
    ts: obj.ts as number,
    type: 'disk_clean',
    groupKey: null,
    detail: {
      freedKB: d.freedKB as number,
      done: [...(d.done as string[])],
      refused: (d.refused as { id: string; reason: string }[]).map((r) => ({ id: r.id, reason: r.reason })),
    },
  };
}

function parseTmpClean(obj: Record<string, unknown>): TmpCleanEvent | null {
  if (obj.groupKey !== null) return null;
  const d = obj.detail as Record<string, unknown> | null;
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return null;
  if (!Number.isFinite(d.freedKB as number)) return null;
  if (!Array.isArray(d.deleted) || !d.deleted.every((n: unknown) => typeof n === 'string')) return null;
  const okRefused = (x: unknown) => typeof x === 'object' && x !== null && typeof (x as { name: unknown }).name === 'string' && typeof (x as { reason: unknown }).reason === 'string';
  if (!Array.isArray(d.refused) || !d.refused.every(okRefused)) return null;
  return {
    ts: obj.ts as number,
    type: 'tmp_clean',
    groupKey: null,
    detail: {
      freedKB: d.freedKB as number,
      deleted: [...(d.deleted as string[])],
      refused: (d.refused as { name: string; reason: string }[]).map((r) => ({ name: r.name, reason: r.reason })),
      ...(d.partial === true ? { partial: true as const } : {}),
    },
  };
}

export const formatAppEvent = (e: AppEvent) => JSON.stringify(e) + '\n';

export function parseAppEvents(text: string): AppEvent[] {
  const out: AppEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as unknown;
      if (typeof o !== 'object' || o === null) continue;
      const obj = o as Record<string, unknown>;

      // validate ts
      if (!Number.isFinite(obj.ts as number)) continue;

      if (obj.type === 'earlyoom_setup') {
        const e = parseSetupEvent(obj);
        if (e) out.push(e);
        continue;
      }
      if (obj.type === 'tmp_clean') {
        const t = parseTmpClean(obj);
        if (t) out.push(t);
        continue;
      }
      if (obj.type === 'disk_clean') {
        const t = parseDiskClean(obj);
        if (t) out.push(t);
        continue;
      }

      // validate type
      if (obj.type !== 'app_kill') continue;

      // validate groupKey (must be null or string)
      if (obj.groupKey !== null && typeof obj.groupKey !== 'string') continue;

      // validate detail.pids (array of finite numbers)
      if (!Array.isArray(obj.detail) && typeof obj.detail === 'object' && obj.detail !== null) {
        const detail = obj.detail as Record<string, unknown>;
        if (!Array.isArray(detail.pids) || !detail.pids.every((p: unknown) => Number.isFinite(p as number))) continue;

        // validate detail.signal (string)
        if (typeof detail.signal !== 'string') continue;

        // optional targets (pid + startTicks) : kept only when well-formed
        const t = detail.targets;
        const targets =
          Array.isArray(t) && t.every((x: unknown) => typeof x === 'object' && x !== null &&
            Number.isInteger((x as { pid: unknown }).pid) && Number.isInteger((x as { startTicks: unknown }).startTicks))
            ? (t as { pid: number; startTicks: number }[]).map((x) => ({ pid: x.pid, startTicks: x.startTicks }))
            : null;

        // build fresh object
        out.push({
          ts: obj.ts as number,
          type: 'app_kill',
          groupKey: (obj.groupKey as string | null) ?? null,
          detail: {
            pids: detail.pids as number[],
            signal: detail.signal as string,
            ...(targets ? { targets } : {}),
          },
        });
      }
    } catch {
      // ligne invalide ignorée
    }
  }
  return out;
}

export function takeAppEvents(path: string): { events: AppEvent[]; ack: () => void } {
  const work = `${path}.ingest`;

  // if .ingest exists (leftover from crash), process it without renaming over it
  if (!existsSync(work) && existsSync(path)) {
    renameSync(path, work);
  }

  // no .ingest file → return empty
  if (!existsSync(work)) {
    return { events: [], ack: () => {} };
  }

  // read and parse (may throw, don't delete on error)
  const content = readFileSync(work, 'utf8');
  const events = parseAppEvents(content);

  return {
    events,
    ack: () => {
      rmSync(work, { force: true });
    },
  };
}

/** Renvoie l'id de l'événement (sert à `--alert=<id>`). */
export function insertEvent(db: DatabaseSync, ts: number, type: EventType, groupKey: string | null, detail: object): number {
  const r = db.prepare('INSERT INTO events(ts, type, group_id, detail) VALUES (?, ?, (SELECT id FROM groups WHERE key = ?), ?)').run(
    ts, type, groupKey, JSON.stringify(detail),
  );
  return Number(r.lastInsertRowid);
}

export function lastSampleTs(db: DatabaseSync): number | null {
  return (db.prepare('SELECT MAX(ts) AS ts FROM system_samples').get() as { ts: number | null }).ts;
}

export function lastEventTs(db: DatabaseSync, type: EventType): number | null {
  return (db.prepare('SELECT MAX(ts) AS ts FROM events WHERE type = ?').get(type) as { ts: number | null }).ts;
}

/** Dernière alerte disk_low par point de montage depuis `since` (détail illisible ignoré). */
export function lastDiskLowByMount(db: DatabaseSync, since: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of db.prepare("SELECT ts, detail FROM events WHERE type = 'disk_low' AND ts >= ? ORDER BY ts").all(since) as { ts: number; detail: string }[]) {
    try {
      const m = (JSON.parse(r.detail) as { mount?: unknown }).mount;
      if (typeof m === 'string') out.set(m, r.ts);
    } catch {
      // détail illisible
    }
  }
  return out;
}

/** Événements de règles depuis `since` (ordre chronologique) ; détail sans `ruleId` ou `result` texte ignoré. */
export function ruleEventsSince(db: DatabaseSync, since: number): { ts: number; type: 'rule_action' | 'rule_dry_run'; ruleId: string; result: string }[] {
  const rows = db
    .prepare("SELECT ts, type, detail FROM events WHERE type IN ('rule_action', 'rule_dry_run') AND ts >= ? ORDER BY ts, id")
    .all(since) as { ts: number; type: 'rule_action' | 'rule_dry_run'; detail: string }[];
  const out: { ts: number; type: 'rule_action' | 'rule_dry_run'; ruleId: string; result: string }[] = [];
  for (const r of rows) {
    try {
      const d = JSON.parse(r.detail) as Record<string, unknown>;
      if (typeof d.ruleId === 'string' && typeof d.result === 'string') out.push({ ts: r.ts, type: r.type, ruleId: d.ruleId, result: d.result });
    } catch {
      // détail illisible ignoré
    }
  }
  return out;
}
