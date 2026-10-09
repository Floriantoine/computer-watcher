// Mesure des familles récupérables (service une fois par jour, ou l'app à la demande) : `du` à basse priorité
// (ionice idle, nice 19), une seule partition (-x), liens jamais suivis (-P) ; résultat dans disk-families.json.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnv, systemBin } from '../childEnv';
import {
  browserVersionsToDrop, FAMILIES, familyPaths, JOURNAL_DIR, PKG_CACHE_DIRS, pacmanReclaimKB, isFamilyId,
  type FamiliesFile, type FamilyMeasure, type FamilyRoots,
} from './families';

/** Ko occupés par chaque chemin (absent ou illisible : pas dans la table). */
export type DuFn = (paths: string[]) => Promise<Map<string, number>>;

const DU_TIMEOUT_MS = 10 * 60_000;
/** Taille gardée par `journalctl --vacuum-size=500M`. */
export const JOURNAL_KEEP_KB = 500 * 1024;

export const defaultDu: DuFn = (paths) =>
  new Promise((resolve) => {
    const du = systemBin('du', existsSync);
    if (!du || !paths.length) return resolve(new Map());
    const ionice = systemBin('ionice', existsSync);
    const nice = systemBin('nice', existsSync);
    const argv = [...(ionice ? [ionice, '-c3'] : []), ...(nice ? [nice, '-n', '19'] : []), du, '-s', '-k', '-x', '-P', '--', ...paths];
    execFile(argv[0], argv.slice(1), { timeout: DU_TIMEOUT_MS, maxBuffer: 1 << 20, encoding: 'utf8', env: cleanEnv(process.env) }, (_err, stdout) => {
      // un chemin illisible fait sortir du en erreur : les autres lignes restent valables
      const out = new Map<string, number>();
      for (const line of String(stdout ?? '').split('\n')) {
        const tab = line.indexOf('\t');
        if (tab > 0 && /^\d+$/.test(line.slice(0, tab))) out.set(line.slice(tab + 1), Number(line.slice(0, tab)));
      }
      resolve(out);
    });
  });

/** « … take up 3.9G … » de `journalctl --disk-usage` → Ko. */
export function parseJournalUsage(text: string): number | null {
  const m = /take up ([\d.]+)\s*([KMGT])?/i.exec(text);
  if (!m) return null;
  const mult: Record<string, number> = { K: 1, M: 1024, G: 1024 * 1024, T: 1024 * 1024 * 1024 };
  return Math.round(Number(m[1]) * (m[2] ? mult[m[2].toUpperCase()] : 1 / 1024));
}

/** Taille des journaux lue sans privilège ; null : inconnue. */
export function defaultJournal(): Promise<number | null> {
  return new Promise((resolve) => {
    const bin = systemBin('journalctl', existsSync);
    if (!bin) return resolve(null);
    execFile(bin, ['--disk-usage'], { timeout: 10_000, encoding: 'utf8', env: cleanEnv(process.env) }, (_e, stdout) => resolve(parseJournalUsage(String(stdout ?? ''))));
  });
}

const present = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const isRealDir = (p: string) => {
  try {
    const s = lstatSync(p);
    return s.isDirectory() && !s.isSymbolicLink();
  } catch {
    return false;
  }
};
const list = (p: string) => {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
};

/** Versions de navigateurs de test à retirer (chemins complets) : ms-playwright/<nav>-<n>, puppeteer/<nav>/<plateforme>-<version>. */
export function browserDropPaths(roots: FamilyRoots): string[] {
  const [pw, pp] = familyPaths('test-browsers', roots);
  const out: string[] = [];
  if (isRealDir(pw)) out.push(...browserVersionsToDrop(list(pw)).map((n) => join(pw, n)));
  if (isRealDir(pp)) {
    for (const b of list(pp)) {
      const dir = join(pp, b);
      if (isRealDir(dir)) out.push(...browserVersionsToDrop(list(dir)).map((n) => join(dir, n)));
    }
  }
  return out;
}

export interface MeasureOptions {
  du?: DuFn;
  /** Caches de paquets présents (défaut : ceux de PKG_CACHE_DIRS qui existent). */
  pkgDirs?: string[];
  /** Taille des journaux ; null : famille omise (pas de journaux persistants). */
  journal?: (() => Promise<number | null>) | null;
  now?: () => number;
}

/** Une mesure par famille présente (dossier absent : famille omise). */
export async function measureFamilies(roots: FamilyRoots, o: MeasureOptions = {}): Promise<FamilyMeasure[]> {
  const du = o.du ?? defaultDu;
  const now = o.now ?? Date.now;
  const sum = async (paths: string[]) => {
    if (!paths.length) return 0;
    const m = await du(paths);
    return paths.reduce((s, p) => s + (m.get(p) ?? 0), 0);
  };
  const out: FamilyMeasure[] = [];
  for (const def of FAMILIES) {
    try {
      if (def.id === 'pkg-cache') {
        const dir = (o.pkgDirs ?? PKG_CACHE_DIRS.filter(isRealDir))[0];
        if (!dir) continue;
        const files = list(dir).flatMap((name) => {
          try {
            const s = lstatSync(join(dir, name));
            return s.isFile() ? [{ name, sizeKB: s.blocks / 2 }] : [];
          } catch {
            return [];
          }
        });
        const size = files.reduce((s, f) => s + f.sizeKB, 0);
        out.push({ id: def.id, sizeKB: size, reclaimKB: files.some((f) => f.name.includes('.pkg.tar')) ? pacmanReclaimKB(files, 2) : size, at: now() });
        continue;
      }
      if (def.id === 'journal') {
        const journal = o.journal === undefined ? (existsSync(JOURNAL_DIR) || existsSync('/run/log/journal') ? defaultJournal : null) : o.journal;
        if (!journal) continue;
        const kb = await journal();
        out.push({ id: def.id, sizeKB: kb, reclaimKB: kb === null ? null : Math.max(0, kb - JOURNAL_KEEP_KB), at: now() });
        continue;
      }
      const paths = familyPaths(def.id, roots).filter(present);
      if (!paths.length) continue;
      const size = await sum(paths);
      const reclaim = def.id === 'test-browsers' ? await sum(browserDropPaths(roots)) : size;
      out.push({ id: def.id, sizeKB: size, reclaimKB: reclaim, at: now() });
    } catch (e) {
      out.push({ id: def.id, sizeKB: null, reclaimKB: null, at: now(), error: (e as Error).message });
    }
  }
  return out;
}

const isMeasure = (m: unknown): m is FamilyMeasure => {
  if (typeof m !== 'object' || m === null) return false;
  const x = m as Record<string, unknown>;
  const num = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
  return isFamilyId(x.id) && num(x.sizeKB) && num(x.reclaimKB) && typeof x.at === 'number' && (x.error === undefined || typeof x.error === 'string');
};

export function readFamiliesFile(path: string): FamiliesFile | null {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (typeof o.at !== 'number' || !Array.isArray(o.families) || !o.families.every(isMeasure)) return null;
    return { at: o.at, families: o.families };
  } catch {
    return null;
  }
}

/** Écriture atomique (temporaire puis rename), 0600. */
export function writeFamiliesFile(path: string, f: FamiliesFile): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 });
  renameSync(tmp, path);
}
