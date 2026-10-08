import type { Category } from './categories';

const FRONT = new Set([5173, 5174, 4200, 3001]);
const DB = new Set([5432, 6379, 3306, 27017, 7700, 9200]);
const BACK = new Set([4000, 5000, 8000, 8080, 8081, 9000]);

const FRONT_PROGRAMS = new Set(['next', 'react-scripts']);

function hasFrontProgram(chainText: string): boolean {
  const toks = chainText.split(/\s+/).filter(Boolean);
  if (toks.some((t) => /(^|\/)node_modules\/(next|react-scripts)\//i.test(t))) return true;
  const isFront = (t: string) => FRONT_PROGRAMS.has((t.split('/').pop() ?? '').toLowerCase());
  if (toks.length === 0) return false;
  if (isFront(toks[0])) return true;
  const firstArg = toks.slice(1).find((t) => !t.startsWith('-'));
  return firstArg !== undefined && isFront(firstArg);
}

// Précédence quand plusieurs ports : db > front > back.
export function categoryForPorts(ports: number[], chainText: string): Category | null {
  let front = false; let back = false;
  for (const p of ports) {
    if (DB.has(p)) return 'db';
    if (FRONT.has(p)) front = true;
    else if (p === 3000) { if (hasFrontProgram(chainText)) front = true; else back = true; }
    else if (BACK.has(p)) back = true;
  }
  return front ? 'front' : back ? 'back' : null;
}
