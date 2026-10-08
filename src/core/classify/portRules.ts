import type { Category } from './categories';

const FRONT = new Set([5173, 5174, 4200, 3001]);
const DB = new Set([5432, 6379, 3306, 27017, 7700, 9200]);
const BACK = new Set([4000, 5000, 8000, 8080, 8081, 9000]);

export function categoryForPorts(ports: number[], chainText: string): Category | null {
  for (const p of ports) {
    if (FRONT.has(p)) return 'front';
    if (DB.has(p)) return 'db';
    if (p === 3000) return /\b(next|react-scripts)\b/.test(chainText) ? 'front' : 'back';
    if (BACK.has(p)) return 'back';
  }
  return null;
}
