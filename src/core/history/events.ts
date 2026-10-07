import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

export type EventType = 'earlyoom_kill' | 'pressure' | 'gap' | 'app_kill' | 'leak';

const EARLYOOM = /sending (SIGTERM|SIGKILL) to process (\d+)(?: uid (\d+))? "([^"]*)"/;

export function parseEarlyoom(message: string) {
  const m = message.match(EARLYOOM);
  if (!m) return null;
  return { signal: m[1] as 'SIGTERM' | 'SIGKILL', pid: Number(m[2]), uid: m[3] ? Number(m[3]) : null, name: m[4] };
}

export function parseJournalLine(line: string): { ts: number; message: string } | null {
  try {
    const o = JSON.parse(line) as { __REALTIME_TIMESTAMP?: string; MESSAGE?: unknown };
    if (!o.__REALTIME_TIMESTAMP || typeof o.MESSAGE !== 'string') return null;
    return { ts: Math.floor(Number(o.__REALTIME_TIMESTAMP) / 1000), message: o.MESSAGE };
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
      const o = JSON.parse(line) as AppEvent;
      if (Number.isFinite(o.ts) && o.type === 'app_kill' && Array.isArray(o.detail?.pids)) out.push(o);
    } catch {
      // ligne invalide ignorée
    }
  }
  return out;
}

export function ingestAppEvents(path: string): AppEvent[] {
  if (!existsSync(path)) return [];
  const work = `${path}.ingest`;
  renameSync(path, work);
  try {
    return parseAppEvents(readFileSync(work, 'utf8'));
  } finally {
    rmSync(work, { force: true });
  }
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
