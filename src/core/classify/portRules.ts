import type { Category } from './categories';

const FRONT = new Set([5173, 5174, 4200, 3001]);
const DB = new Set([5432, 6379, 3306, 27017, 7700, 9200]);
const BACK = new Set([4000, 5000, 8000, 8080, 8081, 9000]);

const FRONT_PROGRAMS = new Set(['next', 'react-scripts']);

function hasFrontProgram(chainText: string): boolean {
  return chainText.split(/\s+/).some((tok) => FRONT_PROGRAMS.has((tok.split('/').pop() ?? '').toLowerCase()));
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
