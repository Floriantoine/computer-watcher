import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SystemInfo } from '../types';
import { parseLoadavg, parseMeminfo, parsePsiSome10 } from './parse';

export function readSystem(procRoot = '/proc'): SystemInfo {
  let psiSome10: number | null = null;
  try {
    psiSome10 = parsePsiSome10(readFileSync(join(procRoot, 'pressure', 'memory'), 'utf8'));
  } catch {
    // noyau sans PSI
  }
  return {
    ...parseMeminfo(readFileSync(join(procRoot, 'meminfo'), 'utf8')),
    load1: parseLoadavg(readFileSync(join(procRoot, 'loadavg'), 'utf8')),
    psiSome10,
  };
}
