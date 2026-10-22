import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SystemInfo } from '../types';
import { parseLoadavg, parseMeminfo, parsePsiFull10, parsePsiSome10 } from './parse';

export function readSystem(procRoot = '/proc'): SystemInfo {
  let psiSome10: number | null = null;
  let psiFull10: number | null = null;
  try {
    const psi = readFileSync(join(procRoot, 'pressure', 'memory'), 'utf8');
    psiSome10 = parsePsiSome10(psi);
    psiFull10 = parsePsiFull10(psi);
  } catch {
    // noyau sans PSI
  }
  return {
    ...parseMeminfo(readFileSync(join(procRoot, 'meminfo'), 'utf8')),
    load1: parseLoadavg(readFileSync(join(procRoot, 'loadavg'), 'utf8')),
    psiSome10,
    psiFull10,
  };
}
