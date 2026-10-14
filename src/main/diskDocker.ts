// Docker pour la page Disque : binaire système, argv figés, jamais de shell ; rien si `docker info` ne répond pas.
// PROC_WATCH_DISK_DOCKER_FAKE=1 hors paquet (bout en bout) : Docker simulé, aucun processus lancé.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cleanEnv, systemBin } from '../core/childEnv';
import {
  anonymousVolumes, dockerPruneArgs, isDockerAction, parseJsonLines, reclaimByAction, stoppedContainers, unusedImages,
  type DockerAction, type DockerView,
} from '../core/disk/docker';
import { lastLine } from './gitRun';

export type DockerRun = (args: string[], o: { timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

const INFO = ['info', '--format', '{{.ServerVersion}}'];
const PRUNE_TIMEOUT_MS = 10 * 60_000;
/** Note d'une action dont la liste d'éléments n'a pas pu être lue. */
export const DOCKER_DETAIL_MISSING = 'détail indisponible';

/** Docker simulé (développement seulement) : sorties figées, appels enregistrés dans globalThis.__pwDockerFakeCalls. */
export function fakeDocker(args: string[]): { code: number; stdout: string; stderr: string } {
  const g = globalThis as unknown as { __pwDockerFakeCalls?: string[][] };
  (g.__pwDockerFakeCalls ??= []).push([...args]);
  const k = args.join(' ');
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
  if (k === INFO.join(' ')) return ok('27.1.1\n');
  if (k === 'system df --format {{json .}}') {
    return ok([
      '{"Type":"Images","TotalCount":"2","Active":"1","Size":"420MB","Reclaimable":"300MB (71%)"}',
      '{"Type":"Containers","TotalCount":"2","Active":"1","Size":"2MB","Reclaimable":"1MB (50%)"}',
      '{"Type":"Local Volumes","TotalCount":"2","Active":"0","Size":"60MB","Reclaimable":"60MB (100%)"}',
    ].join('\n'));
  }
  if (k === 'image ls --format {{json .}}') {
    return ok('{"Repository":"demo/web","Tag":"1.0","ID":"aaa111","Size":"120MB"}\n{"Repository":"demo/old","Tag":"0.9","ID":"ccc333","Size":"300MB"}\n');
  }
  if (k === 'ps -a --format {{json .}}') {
    return ok('{"Names":"web-1","Image":"demo/web:1.0","State":"running","Status":"Up 2 hours"}\n{"Names":"vieux-1","Image":"demo/web:1.0","State":"exited","Status":"Exited (0) 3 weeks ago"}\n');
  }
  if (k === 'volume ls --filter dangling=true --format {{json .}}') return ok(`{"Name":"${'a'.repeat(64)}"}\n{"Name":"donnees"}\n`);
  if (args[1] === 'prune') return ok('Total reclaimed space: 0B\n');
  return { code: 1, stdout: '', stderr: 'commande simulée inconnue' };
}

/** Lanceur de docker ; null si le binaire est absent (et sans simulation). */
export function dockerRunner(env: NodeJS.ProcessEnv, isPackaged: boolean, exists: (p: string) => boolean = existsSync): { fake: boolean; run: DockerRun } | null {
  if (!isPackaged && env.PROC_WATCH_DISK_DOCKER_FAKE === '1') return { fake: true, run: async (args) => fakeDocker(args) };
  const bin = systemBin('docker', exists);
  if (!bin) return null;
  const e = cleanEnv(env);
  return {
    fake: false,
    run: (args, o) =>
      new Promise((resolve) => {
        execFile(bin, args, { env: e, timeout: o.timeoutMs, maxBuffer: 8 << 20, encoding: 'utf8' }, (err, stdout, stderr) => {
          const out = String(stdout ?? '');
          if (!err) return resolve({ code: 0, stdout: out, stderr: String(stderr ?? '') });
          if ((err as { killed?: boolean }).killed) return resolve({ code: 124, stdout: out, stderr: 'délai dépassé' });
          // jamais de rejet : code de sortie, sinon 125 (lancement impossible, sortie trop longue…)
          const code = (err as NodeJS.ErrnoException).code as unknown;
          resolve({ code: typeof code === 'number' ? code : 125, stdout: out, stderr: String(stderr ?? '') || err.message });
        });
      }),
  };
}

async function quiet(run: DockerRun, args: string[]) {
  try {
    return await run(args, { timeoutMs: 15_000 });
  } catch {
    return null;
  }
}

/** Vue Docker : null si `docker info` ne répond pas (démon arrêté, droits manquants). */
export async function dockerStatus(run: DockerRun): Promise<DockerView | null> {
  const info = await quiet(run, INFO);
  const version = info?.stdout.trim() ?? '';
  if (!info || info.code !== 0 || !/^[\w.+-]{1,40}$/.test(version)) return null;
  const [df, images, ps, vols] = await Promise.all([
    quiet(run, ['system', 'df', '--format', '{{json .}}']),
    quiet(run, ['image', 'ls', '--format', '{{json .}}']),
    quiet(run, ['ps', '-a', '--format', '{{json .}}']),
    quiet(run, ['volume', 'ls', '--filter', 'dangling=true', '--format', '{{json .}}']),
  ]);
  const rows = (r: Awaited<ReturnType<typeof quiet>>) => (r && r.code === 0 ? parseJsonLines(r.stdout) : null);
  const reclaim = reclaimByAction(rows(df) ?? []);
  const imgs = rows(images);
  const cs = rows(ps);
  const vs = rows(vols);
  const v = vs ? anonymousVolumes(vs) : null;
  const missing = { note: DOCKER_DETAIL_MISSING };
  return {
    version,
    actions: [
      { id: 'images', reclaimKB: reclaim.images, items: imgs && cs ? unusedImages(imgs, cs) : [], ...(imgs && cs ? {} : missing) },
      { id: 'containers', reclaimKB: reclaim.containers, items: cs ? stoppedContainers(cs) : [], ...(cs ? {} : missing) },
      {
        id: 'volumes', reclaimKB: reclaim.volumes, items: v?.anonymous ?? [],
        ...(!v ? missing : v.named ? { note: `${v.named} volume${v.named > 1 ? 's' : ''} nommé${v.named > 1 ? 's' : ''} inutilisé${v.named > 1 ? 's' : ''} gardé${v.named > 1 ? 's' : ''} (docker volume prune ne retire que les anonymes)` } : {}),
      },
    ],
  };
}

/** Revérification avant la confirmation et juste avant l'action : docker répond-il encore ? */
export async function checkDocker(run: DockerRun): Promise<string | null> {
  const info = await quiet(run, INFO);
  return info && info.code === 0 ? null : 'Docker ne répond plus';
}

export async function dockerPrune(run: DockerRun, a: DockerAction): Promise<void> {
  if (!isDockerAction(a)) throw new Error('action refusée');
  const r = await run(dockerPruneArgs(a), { timeoutMs: PRUNE_TIMEOUT_MS });
  if (r.code !== 0) throw new Error(`docker a refusé : ${lastLine(r.stderr) || `code ${r.code}`}`);
}
