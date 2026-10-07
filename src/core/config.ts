import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, DEFAULT_RECORDER, DEFAULT_UI } from './defaults';
import { inBounds, RECORDER_BOUNDS, type RecorderNumField } from './recorderBounds';
import type { Config, RecorderConfig, UiConfig } from './types';

export { DEFAULT_CONFIG };

const FILE = 'config.json';

export function configDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'proc-watch');
}

function validateRecorder(raw: unknown): RecorderConfig | null {
  if (raw === undefined) return { ...DEFAULT_RECORDER };
  if (typeof raw !== 'object' || raw === null) return null;
  // champ ajouté après coup : absent d'une config existante → valeur par défaut (pas de réinitialisation)
  const r: Record<string, unknown> = { groupMinMemMB: DEFAULT_RECORDER.groupMinMemMB, ...(raw as Record<string, unknown>) };
  if (typeof r.enabled !== 'boolean') return null;
  for (const f of Object.keys(RECORDER_BOUNDS) as RecorderNumField[]) if (!inBounds(r[f], RECORDER_BOUNDS[f])) return null;
  return {
    enabled: r.enabled,
    intervalSec: r.intervalSec as number,
    detailHours: r.detailHours as number,
    summaryDays: r.summaryDays as number,
    procMinMemMB: r.procMinMemMB as number,
    procMinCpuPercent: r.procMinCpuPercent as number,
    groupMinMemMB: r.groupMinMemMB as number,
    leakMinMinutes: r.leakMinMinutes as number,
    leakMinGrowthMB: r.leakMinGrowthMB as number,
  };
}

function validateUi(raw: unknown): UiConfig | null {
  if (raw === undefined) return { ...DEFAULT_UI };
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.reducedEffects !== 'boolean') return null;
  return { reducedEffects: r.reducedEffects };
}

export function validateConfig(raw: unknown): Config | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return null;
  if (!Array.isArray(r.protected) || !r.protected.every((x) => typeof x === 'string')) return null;
  const t = r.othersThreshold as Record<string, unknown> | undefined;
  if (!t || typeof t.memMB !== 'number' || typeof t.cpuPercent !== 'number') return null;
  if (!(t.memMB >= 0) || !(t.cpuPercent >= 0)) return null;
  const recorder = validateRecorder(r.recorder);
  if (!recorder) return null;
  const ui = validateUi(r.ui);
  if (!ui) return null;
  return { version: 1, protected: [...r.protected], othersThreshold: { memMB: t.memMB, cpuPercent: t.cpuPercent }, recorder, ui };
}

export function saveConfig(dir: string, config: Config): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  renameSync(tmp, join(dir, FILE));
}

export function loadConfig(dir: string): { config: Config; warning: string | null } {
  const file = join(dir, FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      try {
        saveConfig(dir, DEFAULT_CONFIG);
        return { config: structuredClone(DEFAULT_CONFIG), warning: null };
      } catch (e) {
        const saveCode = (e as NodeJS.ErrnoException).code;
        return { config: structuredClone(DEFAULT_CONFIG), warning: `Impossible d'écrire la configuration (${saveCode}) : valeurs par défaut utilisées` };
      }
    }
    return { config: structuredClone(DEFAULT_CONFIG), warning: `config.json illisible (${code}) : valeurs par défaut utilisées, fichier non modifié` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const config = validateConfig(parsed);
  if (config) return { config, warning: null };
  try {
    renameSync(file, `${file}.bak`);
    saveConfig(dir, DEFAULT_CONFIG);
    return { config: structuredClone(DEFAULT_CONFIG), warning: 'config.json invalide : sauvegardé en config.json.bak, valeurs par défaut restaurées' };
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    return { config: structuredClone(DEFAULT_CONFIG), warning: `Impossible d'écrire la configuration (${errCode}) : valeurs par défaut utilisées` };
  }
}
