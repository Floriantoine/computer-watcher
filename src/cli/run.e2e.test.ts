// `computer-watcher run`, e2e RÉEL (`npm run test:antigel-run`, PROC_WATCH_ANTIGEL_E2E=1, après electron-vite build) :
// vrai gestionnaire systemd utilisateur, vrais cgroups, out/main/cli.js et out/main/index.js lancés par le vrai Electron.
// SEULEMENT des commandes à ce test (sh, cat, tail) sous des unités de test, jamais sous cwatch.slice elle-même :
//   cwatch.slice/cwatch-e2e<id>.slice                      slice de test racine (plafonds), remplace cwatch.slice
//     └ cwatch-e2e<id>-p<hachage>.slice                    slice de projet de test (dossier courant : un faux projet)
//       └ cwatch-e2e<id>-r<10>.scope                       un scope « run » par commande
// Arrêts : nos enfants par leur ChildProcess ; unités de test par stopTestUnit ; nettoyage toujours exécuté.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { probeAvailability } from '../core/antigel/cgroupfs';
import { GiB, MiB } from '../core/antigel/limits';
import { runProjectSlice } from '../core/antigel/run';
import { BusctlError, createBusctl, createSystemdClient } from '../core/antigel/systemd';
import { isTestUnitName, slicePath } from '../core/antigel/units';
import { cleanEnv, systemBin } from '../core/childEnv';

const RUN = process.env.PROC_WATCH_ANTIGEL_E2E === '1';
const SYSFS = '/sys/fs/cgroup';
const APP = resolve(__dirname, '../..');
const CLI = join(APP, 'out/main/cli.js');

const wait = async (fn: () => boolean, ms: number, what: string) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`délai dépassé : ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const ignoreGone = (e: unknown) => {
  if (!(e instanceof BusctlError && e.code === 'no-unit')) throw e;
};
const alive = (k: ChildProcess) => k.exitCode === null && k.signalCode === null;
const cgroupOfPid = (pid: number) => {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim();
  } catch {
    return '';
  }
};

/** Lignes « …fdinfo/N:flags: <octal> » dont le drapeau O_NONBLOCK (04000) est posé. */
const nonBlocking = (out: string) => out.split('\n').filter((l) => /fdinfo\/\d:flags:/.test(l) && (parseInt(l.split(/\s+/).pop()!, 8) & 0o4000) !== 0);

interface Done { code: number | null; signal: NodeJS.Signals | null; out: string; err: string; pid: number }

function systemctlRead(bin: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    execFile(bin, ['--user', ...args], { env: cleanEnv(process.env), timeout: 7000, maxBuffer: 64 * 1024 }, (err, out, e) => {
      if (err) rej(new Error(`systemctl : ${String(e).trim() || err.message}`));
      else res(String(out));
    });
  });
}

test.skipIf(!RUN)(
  'run : cgroup réel sous la slice de test, même PID, code de sortie, stdin, argument littéral, --mem, TTY, signaux, entrée de l’app, repli sans plafond',
  async () => {
    const electron = createRequire(import.meta.url)('electron') as unknown as string;
    const busctl = systemBin('busctl', existsSync);
    const systemctl = systemBin('systemctl', existsSync);
    const script = systemBin('script', existsSync);
    expect(existsSync(CLI), 'out/main/cli.js (electron-vite build)').toBe(true);
    expect(busctl).not.toBeNull();
    expect(systemctl).not.toBeNull();
    const avail = probeAvailability({ procRoot: '/proc', sysfsRoot: SYSFS, uid: process.getuid!(), selfPid: process.pid, busctl });
    expect(avail).toMatchObject({ ok: true });
    if (!avail.ok) return;

    const id = randomBytes(5).toString('hex');
    const slice = `cwatch-e2e${id}.slice`;
    // faux projet sous un HOME de test (~/.cache/pw-…) : racine git → slice de projet de test « p<hachage> »
    const home = join(homedir(), '.cache', `pw-l4-e2e-${id}`);
    const proj = join(home, 'demo');
    mkdirSync(join(proj, '.git'), { recursive: true });
    mkdirSync(join(proj, 'src'), { recursive: true });
    const projSlice = runProjectSlice({ root: proj, taken: new Map(), test: slice });
    const othersSlice = runProjectSlice({ root: null, taken: new Map(), test: slice });
    for (const u of [slice, projSlice, othersSlice]) expect(isTestUnitName(u), u).toBe(true);
    const projCg = `${avail.userBase}/${slicePath(projSlice)}`;
    expect(projCg).toBe(`${avail.userBase}/cwatch.slice/${slice}/${projSlice}`);
    const SCOPE_RE = new RegExp(`^0::${projCg.replace(/[.]/g, '\\.')}/cwatch-e2e${id}-r[a-z0-9]{10}\\.scope$`);

    const env: NodeJS.ProcessEnv = {
      ...cleanEnv(process.env), HOME: home, XDG_CONFIG_HOME: join(home, 'c'), XDG_DATA_HOME: join(home, 'd'), XDG_CACHE_HOME: join(home, 'k'),
      PROC_WATCH_RUN_ROOT_SLICE: slice, PROC_WATCH_NO_RECORDER_SYNC: '1',
    };
    delete env.PROC_WATCH_NO_ANTIGEL;
    delete env.ELECTRON_RUN_AS_NODE;
    const nodeEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
    const client = createSystemdClient(createBusctl(busctl!, process.env));
    const kids: ChildProcess[] = [];
    const scopes = new Set<string>();
    const seen: string[] = [];
    const launch = (argv: string[], o: { env?: NodeJS.ProcessEnv; stdin?: string; cwd?: string } = {}) => {
      const k = spawn(argv[0]!, argv.slice(1), { cwd: o.cwd ?? join(proj, 'src'), env: o.env ?? nodeEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      kids.push(k);
      let out = '';
      let err = '';
      k.stdout!.on('data', (b) => (out += b));
      k.stderr!.on('data', (b) => (err += b));
      if (o.stdin !== undefined) k.stdin!.end(o.stdin);
      const done = new Promise<Done>((res) => k.on('close', (code, signal) => res({ code, signal, out, err, pid: k.pid! })));
      return { k, done };
    };
    const note = (cg: string) => {
      const m = /\/(cwatch-e2e[a-z0-9]+-r[a-z0-9]{10}\.scope)$/.exec(cg);
      if (m) scopes.add(m[1]!);
    };
    const runCli = (args: string[], o?: Parameters<typeof launch>[1]) => launch([electron, CLI, 'run', ...args], o);
    let bodyErr: { e: unknown } | null = null;
    try {
      await client.ensureSlice(slice, { reserveBytes: GiB, highBytes: 512 * MiB, maxBytes: GiB, swapMaxBytes: 0 });

      // 1) même PID que le processus lancé (execve), cgroup réel du scope « run », --mem → memory.high du scope,
      //    argument transmis tel quel (aucun shell, aucune expansion), code de sortie de la commande
      const sh = 'echo "pid=$$"; cat /proc/self/cgroup; cat "/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/memory.high"; printf "%s\\n" "$1"; ls /proc/self/fd | tr "\\n" " "; echo; grep "^SigIgn" /proc/self/status; exit 3';
      const r1 = await runCli(['--mem', '512M', '--', '/bin/sh', '-c', sh, 'sh', 'lit$HOME `id` ;'], {}).done;
      const lines = r1.out.trim().split('\n');
      seen.push(`1) code=${r1.code} stdout=${JSON.stringify(lines)} stderr=${JSON.stringify(r1.err)}`);
      expect(r1.code).toBe(3);
      expect(r1.err).toBe('');
      expect(lines[0]).toBe(`pid=${r1.pid}`);
      expect(lines[1]).toMatch(SCOPE_RE);
      note(lines[1]!);
      expect(lines[2]).toBe(String(512 * MiB));
      expect(lines[3]).toBe('lit$HOME `id` ;');
      // descripteurs hérités fermés : 0, 1, 2 (et celui de ls lui-même)
      expect(lines[4]!.trim().split(' ').filter((fd) => Number(fd) > 3)).toEqual([]);
      // aucun signal ignoré hérité de Node (SIGPIPE, SIGXFSZ) : `… | head` finit comme lancé directement (revue I2)
      expect(lines[5]).toBe('SigIgn:\t0000000000000000');

      // 2) entrée standard transmise
      const r2 = await runCli(['--', 'cat'], { stdin: 'bonjour\n' }).done;
      seen.push(`2) code=${r2.code} stdout=${JSON.stringify(r2.out)}`);
      expect(r2).toMatchObject({ code: 0, out: 'bonjour\n', err: '' });

      // 3) commande longue : propriétés réelles du scope, puis SIGINT (Ctrl+C) et SIGTERM reçus par la commande elle-même
      for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        const t = runCli(['--', 'tail', '-f', '/dev/null']);
        await wait(() => SCOPE_RE.test(cgroupOfPid(t.k.pid!)) && readFileSync(`/proc/${t.k.pid}/comm`, 'utf8').trim() === 'tail', 10_000, 'tail dans son scope');
        const cg = cgroupOfPid(t.k.pid!);
        note(cg);
        const scope = cg.split('/').pop()!;
        if (sig === 'SIGINT') {
          const show = await systemctlRead(systemctl!, ['show', scope, '-p', 'Slice', '-p', 'OOMPolicy', '-p', 'CollectMode', '-p', 'Description', '-p', 'MemoryHigh', '-p', 'MemoryMax']);
          seen.push(`3) ${scope} :\n${show.trim()}`);
          expect(show).toContain(`Slice=${projSlice}`);
          expect(show).toContain('OOMPolicy=continue');
          expect(show).toContain('CollectMode=inactive-or-failed');
          expect(show).toContain('Description=Computer Watcher anti-gel (computer-watcher run)');
          expect(show).toContain('MemoryHigh=infinity');
          expect(show).toContain('MemoryMax=infinity');
        }
        t.k.kill(sig);
        const r = await t.done;
        seen.push(`3) ${sig} → code=${r.code} signal=${r.signal}`);
        expect(r).toMatchObject({ code: null, signal: sig });
      }

      // 4) terminal transmis (pty de script(1)) : la commande voit un TTY en entrée et en sortie
      if (script) {
        const r4 = await launch([script, '-qec', `${electron} ${CLI} run -- /bin/sh -c 'test -t 0 && test -t 1 && echo TTY-OK; exit 4'`, '/dev/null'], { stdin: '' }).done;
        seen.push(`4) script : code=${r4.code} stdout=${JSON.stringify(r4.out)}`);
        expect(r4.code).toBe(4);
        expect(r4.out).toContain('TTY-OK');
      } else seen.push('4) script(1) absent : TTY non vérifié');

      // 5) entrée de l'app (index.js en mode Electron complet → execve en mode Node), hors projet : slice « autres »
      // options de type Electron/Node APRÈS « -- » : à la commande, jamais lues par Electron (revue I3)
      const r5 = await launch([electron, APP, 'run', '--', '/bin/sh', '-c', 'cat /proc/self/cgroup; grep "^flags" /proc/self/fdinfo/0 /proc/self/fdinfo/1 /proc/self/fdinfo/2; exit 6', 'sh', '--type=x', '--inspect-brk=0'], { env, cwd: '/' }).done;
      seen.push(`5) app : code=${r5.code} stdout=${JSON.stringify(r5.out.trim())}`);
      expect(r5.code).toBe(6);
      const cg5 = r5.out.trim().split('\n').find((l) => l.startsWith('0::')) ?? '';
      expect(cg5.startsWith(`0::${avail.userBase}/cwatch.slice/${slice}/${othersSlice}/cwatch-e2e${id}-r`)).toBe(true);
      note(cg5);
      expect(nonBlocking(r5.out)).toEqual([]);

      // 6) plafond éteint (slice de test remise à infinity) : avertissement, commande lancée quand même, hors cwatch
      await client.setSlice(slice, null);
      const r6 = await runCli(['--mem', '1G', '--', '/bin/sh', '-c', 'cat /proc/self/cgroup; grep "^flags" /proc/self/fdinfo/1 /proc/self/fdinfo/2; exit 5']).done;
      seen.push(`6) éteint : code=${r6.code} stderr=${JSON.stringify(r6.err)} stdout=${JSON.stringify(r6.out.trim())}`);
      expect(r6.code).toBe(5);
      expect(r6.err).toMatch(/^computer-watcher : plafond de travail éteint .*commande lancée sans plafond \(--mem ignoré\)\.\n$/);
      expect(r6.out).not.toContain('cwatch');
      // l'avertissement n'a pas rendu la sortie d'erreur non bloquante pour la commande (revue I1)
      expect(r6.out).toMatch(/fdinfo\/2:flags/);
      expect(nonBlocking(r6.out)).toEqual([]);

      // 7) commande introuvable : 127 ; « -- » oublié : 2 ; aucune unité créée (plafond remis pour que l'essai compte)
      await client.setSlice(slice, { reserveBytes: GiB, highBytes: 512 * MiB, maxBytes: GiB, swapMaxBytes: 0 });
      const runUnits = async () => (await systemctlRead(systemctl!, ['list-units', `cwatch-e2e${id}-r*`, '--all', '--plain', '--no-legend'])).trim();
      const t = runCli(['--', 'tail', '-f', '/dev/null']);
      await wait(() => SCOPE_RE.test(cgroupOfPid(t.k.pid!)), 10_000, 'tail témoin dans son scope');
      note(cgroupOfPid(t.k.pid!));
      const before = await runUnits();
      expect(before).toMatch(/cwatch-e2e[a-z0-9]+-r[a-z0-9]{10}\.scope/); // la liste voit bien les scopes « run »
      const r7 = await runCli(['--', `introuvable-${id}`]).done;
      expect(r7.code).toBe(127);
      const r8 = await runCli(['/bin/sh', '-c', 'exit 7']).done;
      seen.push(`7) introuvable : code=${r7.code} ; sans -- : code=${r8.code} stderr=${JSON.stringify(r8.err)}`);
      expect(r8.code).toBe(2);
      expect(r8.err).toMatch(/« -- » manquant/);
      expect(await runUnits()).toBe(before);
      t.k.kill('SIGTERM');
      await t.done;
    } catch (e) {
      bodyErr = { e };
    }
    // Nettoyage (toujours) : nos enfants seulement ; unités de test seulement.
    const started = kids.filter((k) => k.pid !== undefined);
    for (const k of started) if (alive(k)) k.kill('SIGKILL');
    await Promise.race([
      Promise.all(started.map((k) => (alive(k) ? new Promise((r) => k.once('exit', r)) : null))),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    console.log(`[run e2e]\n${seen.join('\n')}`);
    const errs: unknown[] = [];
    for (const u of [...scopes, projSlice, othersSlice, slice]) await client.stopTestUnit(u).catch(ignoreGone).catch((e) => errs.push(e));
    rmSync(home, { recursive: true, force: true });
    if (bodyErr) {
      for (const e of errs) console.error('[run e2e] nettoyage :', e);
      throw bodyErr.e;
    }
    if (errs.length > 0) throw errs[0];
    const left = async () => (await systemctlRead(systemctl!, ['list-units', `cwatch-e2e${id}*`, '--all', '--plain', '--no-legend'])).trim();
    const t0 = Date.now();
    while ((await left()) !== '' && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 200));
    expect(await left()).toBe('');
  },
  120_000,
);
