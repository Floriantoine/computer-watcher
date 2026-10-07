import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

export type EventType = 'earlyoom_kill' | 'pressure' | 'gap' | 'app_kill' | 'leak';

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

export interface AppEvent {
  ts: number;
  type: 'app_kill';
  groupKey: string | null;
  detail: { pids: number[]; signal: string };
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

        // build fresh object
        out.push({
          ts: obj.ts as number,
          type: 'app_kill',
          groupKey: (obj.groupKey as string | null) ?? null,
          detail: {
            pids: detail.pids as number[],
            signal: detail.signal as string,
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

export function insertEvent(db: DatabaseSync, ts: number, type: EventType, groupKey: string | null, detail: object): void {
  db.prepare('INSERT INTO events(ts, type, group_id, detail) VALUES (?, ?, (SELECT id FROM groups WHERE key = ?), ?)').run(
    ts, type, groupKey, JSON.stringify(detail),
  );
}

export function lastSampleTs(db: DatabaseSync): number | null {
  return (db.prepare('SELECT MAX(ts) AS ts FROM system_samples').get() as { ts: number | null }).ts;
}

export function lastEventTs(db: DatabaseSync, type: EventType): number | null {
  return (db.prepare('SELECT MAX(ts) AS ts FROM events WHERE type = ?').get(type) as { ts: number | null }).ts;
}
