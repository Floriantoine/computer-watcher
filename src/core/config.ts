import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { xdgHome } from './paths';
import { appDir } from './appDirs';
import { join } from 'node:path';
import { DEFAULT_CLASSIFY, DEFAULT_CONFIG, DEFAULT_RECORDER, DEFAULT_UI } from './defaults';
import { inBounds, RECORDER_BOUNDS, type RecorderNumField } from './recorderBounds';
import { isCategory } from './classify/categories';
import { validateAlerts } from './alerts';
import { validateEarlyoomReminder } from './earlyoomSetup';
import { validateRulesDetailed } from './rules/config';
import type { RuleIssue } from './rules/types';
import type { Category, ClassifyConfig, Config, RecorderConfig, UiConfig } from './types';

export { DEFAULT_CONFIG };

const FILE = 'config.json';

export function configDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return appDir(xdgHome(env, 'XDG_CONFIG_HOME', join(home, '.config')));
}

function validateRecorder(raw: unknown): RecorderConfig | null {
  if (raw === undefined) return { ...DEFAULT_RECORDER };
  if (typeof raw !== 'object' || raw === null) return null;
  // champ ajouté après coup : absent d'une config existante → valeur par défaut (pas de réinitialisation)
  const r: Record<string, unknown> = {
    groupMinMemMB: DEFAULT_RECORDER.groupMinMemMB,
    tmpfsAlertMB: DEFAULT_RECORDER.tmpfsAlertMB,
    diskAlertPercent: DEFAULT_RECORDER.diskAlertPercent,
    diskAlertGB: DEFAULT_RECORDER.diskAlertGB,
    ...(raw as Record<string, unknown>),
  };
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
    tmpfsAlertMB: r.tmpfsAlertMB as number,
    diskAlertPercent: r.diskAlertPercent as number,
    diskAlertGB: r.diskAlertGB as number,
  };
}

function validateUi(raw: unknown): UiConfig | null {
  if (raw === undefined) return { ...DEFAULT_UI };
  if (typeof raw !== 'object' || raw === null) return null;
  // champs ajoutés après coup : absents d'une config existante → valeurs par défaut (pas de réinitialisation)
  const r: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const k of ['memoryMetric', 'trayIcon', 'closeToTray', 'swapSleepMinMB'] as const) if (r[k] === undefined) r[k] = DEFAULT_UI[k];
  if (typeof r.reducedEffects !== 'boolean') return null;
  const memoryMetric = r.memoryMetric;
  if (memoryMetric !== 'rss' && memoryMetric !== 'pss') return null;
  if (typeof r.trayIcon !== 'boolean' || typeof r.closeToTray !== 'boolean') return null;
  const sleep = r.swapSleepMinMB;
  if (!Number.isInteger(sleep) || (sleep as number) < 1 || (sleep as number) > 65_536) return null;
  return { reducedEffects: r.reducedEffects, memoryMetric, trayIcon: r.trayIcon, closeToTray: r.closeToTray, swapSleepMinMB: sleep as number };
}

export const MAX_OVERRIDES = 500;
export const MAX_OVERRIDE_KEY = 300;

function validateClassify(raw: unknown): ClassifyConfig | null {
  if (raw === undefined) return { ...DEFAULT_CLASSIFY, overrides: {} };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.detectPorts !== 'boolean') return null;
  const o = r.overrides;
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const keys = Object.keys(o);
  if (keys.length > MAX_OVERRIDES) return null;
  const overrides: Record<string, Category> = {};
  for (const k of keys) {
    const v = (o as Record<string, unknown>)[k];
    if (k.length > MAX_OVERRIDE_KEY || !isCategory(v)) return null;
    overrides[k] = v;
  }
  return { detectPorts: r.detectPorts, overrides };
}

/** Comme validateConfig, avec les règles refusées une à une (`ruleIssues`) ; une règle invalide n'invalide jamais la config. */
export function validateConfigDetailed(raw: unknown): { config: Config; ruleIssues: RuleIssue[] } | null {
  const config = validateConfig(raw);
  if (!config) return null;
  return { config, ruleIssues: validateRulesDetailed((raw as Record<string, unknown>).rules).issues };
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
  const classify = validateClassify(r.classify);
  if (!classify) return null;
  const alerts = validateAlerts(r.alerts);
  if (!alerts) return null;
  const { rules } = validateRulesDetailed(r.rules);
  // Rappel earlyoom illisible : simplement absent (le pop-up revient), jamais une raison de réinitialiser la config.
  const earlyoomReminder = validateEarlyoomReminder(r.earlyoomReminder);
  return {
    version: 1, protected: [...r.protected], othersThreshold: { memMB: t.memMB, cpuPercent: t.cpuPercent }, recorder, ui, classify, alerts, rules,
    ...(earlyoomReminder ? { earlyoomReminder } : {}),
  };
}

export function saveConfig(dir: string, config: Config): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  renameSync(tmp, join(dir, FILE));
}

/** `ruleIssues` : présent seulement si des règles du fichier sont refusées (ignorées seules, fichier non modifié). */
export function loadConfig(dir: string): { config: Config; warning: string | null; ruleIssues?: RuleIssue[] } {
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
  const checked = validateConfigDetailed(parsed);
  if (checked) return checked.ruleIssues.length ? { config: checked.config, warning: null, ruleIssues: checked.ruleIssues } : { config: checked.config, warning: null };
  try {
    renameSync(file, `${file}.bak`);
    saveConfig(dir, DEFAULT_CONFIG);
    return { config: structuredClone(DEFAULT_CONFIG), warning: 'config.json invalide : sauvegardé en config.json.bak, valeurs par défaut restaurées' };
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException).code;
    return { config: structuredClone(DEFAULT_CONFIG), warning: `Impossible d'écrire la configuration (${errCode}) : valeurs par défaut utilisées` };
  }
}
