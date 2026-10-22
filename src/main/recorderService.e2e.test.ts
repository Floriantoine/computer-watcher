// Unité du service d'enregistrement, e2e RÉEL (PROC_WATCH_ANTIGEL_E2E=1 npx vitest run src/main/recorderService.e2e.test.ts) :
// les directives de protection de recorderUnit() (Slice, MemoryLow, OOMScoreAdjust, ManagedOOMPreference) passées telles
// quelles au vrai gestionnaire systemd utilisateur, sur une unité de TEST transitoire `cwatch-e2e<id>-rec.service` qui ne
// lance que `sleep`, arrêtée à la fin (nettoyage toujours exécuté). Jamais le vrai service computer-watcher-recorder,
// jamais une propriété posée sur session.slice (l'unité de test y est seulement rangée).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { cleanEnv, systemBin } from '../core/childEnv';
import { RECORDER_MEMORY_LOW_MB, recorderUnit } from './recorderService';

const RUN = process.env.PROC_WATCH_ANTIGEL_E2E === '1';

/** Chemin absolu, argv figé, sans shell, environnement nettoyé, délai borné. */
const runFile = (bin: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(bin, args, { env: cleanEnv(process.env), timeout: 10_000, maxBuffer: 64 * 1024 }, (err, out, errText) => {
      if (err) reject(new Error(String(errText).trim() || err.message));
      else resolve(String(out));
    });
  });

test.skipIf(!RUN)('directives de protection du service acceptées et effectives : session.slice, memory.low, oom_score_adj, oomd', async () => {
  const systemdRun = systemBin('systemd-run', existsSync);
  const systemctl = systemBin('systemctl', existsSync);
  const sleep = systemBin('sleep', existsSync);
  expect(systemdRun && systemctl && sleep).toBeTruthy();
  const unit = `cwatch-e2e${randomBytes(5).toString('hex')}-rec.service`;
  expect(unit).toMatch(/^cwatch-e2e[0-9a-f]{10}-rec\.service$/);
  // directives de la section [Service] de la vraie unité (hors ExecStart, Environment et Restart)
  const text = recorderUnit(['/usr/bin/true']);
  const props = text.slice(text.indexOf('[Service]'), text.indexOf('[Install]')).split('\n')
    .filter((l) => /^(Slice|MemoryLow|OOMScoreAdjust|ManagedOOMPreference)=/.test(l));
  expect(props).toEqual(['Slice=session.slice', `MemoryLow=${RECORDER_MEMORY_LOW_MB}M`, 'OOMScoreAdjust=100', 'ManagedOOMPreference=avoid']);
  try {
    await runFile(systemdRun!, ['--user', '--quiet', '--collect', `--unit=${unit}`, ...props.flatMap((p) => ['-p', p]), sleep!, '60']);
    const show = Object.fromEntries(
      (await runFile(systemctl!, ['--user', 'show', unit, '-p', 'ControlGroup,MainPID,ManagedOOMPreference,ActiveState'])).trim().split('\n').map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i), l.slice(i + 1)];
      }),
    );
    expect(show.ActiveState).toBe('active');
    expect(show.ControlGroup).toMatch(new RegExp(`^/user\\.slice/user-\\d+\\.slice/user@\\d+\\.service/session\\.slice/${unit.replace(/\./g, '\\.')}$`));
    expect(Number(readFileSync(`/sys/fs/cgroup${show.ControlGroup}/memory.low`, 'utf8'))).toBe(RECORDER_MEMORY_LOW_MB * 1024 * 1024);
    expect(show.ManagedOOMPreference).toBe('avoid');
    // plancher : la valeur du gestionnaire utilisateur (parent direct du processus) ; en dessous, systemd ignore la directive
    const pid = Number(show.MainPID);
    const ppid = Number(/^PPid:\s+(\d+)$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))![1]);
    const managerAdj = Number(readFileSync(`/proc/${ppid}/oom_score_adj`, 'utf8'));
    expect(Number(readFileSync(`/proc/${pid}/oom_score_adj`, 'utf8'))).toBe(Math.max(100, managerAdj));
  } finally {
    await runFile(systemctl!, ['--user', 'stop', unit]).catch(() => {});
  }
  // arrêtée et ramassée (--collect) : plus rien de chargé
  await expect(runFile(systemctl!, ['--user', 'is-active', unit])).rejects.toThrow();
});
