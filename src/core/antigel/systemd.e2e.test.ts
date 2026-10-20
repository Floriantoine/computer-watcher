// Plafond de travail (anti-gel), e2e RÉEL (`npm run test:antigel`, PROC_WATCH_ANTIGEL_E2E=1) : vrai gestionnaire systemd
// utilisateur, vrais cgroups, mais SEULEMENT des processus créés ici (tail, petit allocateur), arrêtés par leur propre
// ChildProcess.kill, sous des unités de test seulement (amendement A1) :
//   cwatch.slice/cwatch-e2e<id>.slice                         slice de test racine (plafonds)
//     └ cwatch-e2e<id>-a.slice                                slice de projet de test (budget MemoryHigh)
//       ├ cwatch-e2e<id>-1.scope                              scope neuf : tail
//       └ cwatch-e2e<id>-2.scope                              scope neuf : allocateur
// Jamais d'appel sur cwatch.slice ni sur une unité cwatch-p-… ; tout est arrêté à la fin (nettoyage toujours exécuté).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { cleanEnv, systemBin } from '../childEnv';
import { parseStat } from '../collector/parse';
import { parseLimit, parseMemoryEvents, probeAvailability, readCgroup, reverify } from './cgroupfs';
import { MiB } from './limits';
import { BusctlError, createBusctl, createSystemdClient } from './systemd';
import { isTestUnitName, scopePath, slicePath } from './units';

const RUN = process.env.PROC_WATCH_ANTIGEL_E2E === '1';
const SYSFS = '/sys/fs/cgroup';
// 12 × 8 Mo touchés (96 Mo) à la demande : au-dessus du MemoryHigh de la slice de test (64 Mo), sous son MemoryMax (256 Mo)
const ALLOC = "const k=[];process.stdin.on('data',()=>{for(let i=0;i<12;i++)k.push(Buffer.alloc(8*1024*1024,1));process.stdout.write('ok\\n')});setInterval(()=>{},1e6);";

const wait = async (fn: () => boolean, ms: number, what: string) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`délai dépassé : ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const startTicks = (pid: number) => parseStat(readFileSync(`/proc/${pid}/stat`, 'utf8')).starttime;
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');
const limitOf = (dir: string, f: string) => parseLimit(read(dir, f));
const ignoreGone = (e: unknown) => {
  if (!(e instanceof BusctlError && e.code === 'no-unit')) throw e;
};
const alive = (k: ChildProcess) => k.exitCode === null && k.signalCode === null;

/** Lecture seule par systemctl --user (chemin absolu, argv figé, sans shell) ; jamais d'écriture. */
function systemctlRead(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['--user', ...args], { env: cleanEnv(process.env), timeout: 7000, maxBuffer: 64 * 1024 }, (err, out, errText) => {
      if (err) reject(new Error(`systemctl : ${String(errText).trim() || err.message}`));
      else resolve(String(out));
    });
  });
}

test.skipIf(!RUN)(
  'slice de test plafonnée → slice de projet (budget) → deux scopes neufs : chemins réels, OOMPolicy, CollectMode, ralentissement, retrait, nettoyage',
  async () => {
    const uid = process.getuid!();
    const busctl = systemBin('busctl', existsSync);
    const systemctl = systemBin('systemctl', existsSync);
    const tailBin = systemBin('tail', existsSync);
    expect(busctl, 'busctl').not.toBeNull();
    expect(systemctl, 'systemctl').not.toBeNull();
    expect(tailBin, 'tail').not.toBeNull();
    const avail = probeAvailability({ procRoot: '/proc', sysfsRoot: SYSFS, uid, selfPid: process.pid, busctl });
    expect(avail).toMatchObject({ ok: true });
    if (!avail.ok) return;

    const id = randomBytes(5).toString('hex');
    const slice = `cwatch-e2e${id}.slice`;
    const projSlice = `cwatch-e2e${id}-a.slice`;
    const scope1 = `cwatch-e2e${id}-1.scope`;
    const scope2 = `cwatch-e2e${id}-2.scope`;
    for (const u of [slice, projSlice, scope1, scope2]) expect(isTestUnitName(u), u).toBe(true);
    // hiérarchie implicite créée par les « - » : la slice de projet est rangée SOUS la slice de test, elle-même sous cwatch.slice
    expect(slicePath(projSlice)).toBe(`cwatch.slice/${slice}/${projSlice}`);
    const sliceDir = join(SYSFS, avail.userBase, slicePath(slice));
    const projDir = join(SYSFS, avail.userBase, slicePath(projSlice));
    const scopeCg = (s: string) => `${avail.userBase}/${scopePath(s, projSlice)}`;
    const sliceCg = `${avail.userBase}/${slicePath(slice)}`;

    const client = createSystemdClient(createBusctl(busctl!, process.env));
    const kids: ChildProcess[] = [];
    const seen: string[] = [];
    let bodyErr: { e: unknown } | null = null;
    try {
      const tail = spawn(tailBin!, ['-f', '/dev/null'], { stdio: 'ignore' });
      kids.push(tail);
      const alloc = spawn(process.execPath, ['-e', ALLOC], { stdio: ['pipe', 'ignore', 'inherit'] });
      kids.push(alloc);
      await wait(() => !!tail.pid && !!alloc.pid && readCgroup('/proc', tail.pid) !== null && readCgroup('/proc', alloc.pid) !== null, 5000, 'enfants lancés');
      const own = readCgroup('/proc', tail.pid!)!;
      expect(own.startsWith(`${avail.userBase}/`), 'enfant sous le gestionnaire utilisateur').toBe(true);
      expect(readCgroup('/proc', alloc.pid!)).toBe(own);

      // 1) slice de test racine : MemoryHigh 64 Mo, MemoryMax 256 Mo, pas de swap
      await client.ensureSlice(slice, { reserveBytes: 0, highBytes: 64 * MiB, maxBytes: 256 * MiB, swapMaxBytes: 0 });
      await wait(() => existsSync(sliceDir), 5000, 'slice de test créée');
      expect(limitOf(sliceDir, 'memory.high')).toBe(64 * MiB);
      expect(limitOf(sliceDir, 'memory.max')).toBe(256 * MiB);
      expect(read(sliceDir, 'memory.swap.max').trim()).toBe('0');
      seen.push(`${sliceDir} : memory.high=${read(sliceDir, 'memory.high').trim()} memory.max=${read(sliceDir, 'memory.max').trim()} memory.swap.max=${read(sliceDir, 'memory.swap.max').trim()}`);

      // 2) slice de projet de test avec un budget (48 Mo), sur le chemin réel …/cwatch.slice/cwatch-e2e<id>.slice/cwatch-e2e<id>-a.slice
      await client.ensureProjectSlice(projSlice, 48 * MiB);
      await wait(() => existsSync(projDir), 5000, 'slice de projet créée');
      expect(limitOf(projDir, 'memory.high')).toBe(48 * MiB);
      expect(read(projDir, 'memory.max').trim()).toBe('max'); // seul le budget MemoryHigh est posé sur la slice de projet
      seen.push(`${projDir} : memory.high=${read(projDir, 'memory.high').trim()} memory.max=${read(projDir, 'memory.max').trim()}`);

      // 7b) slice de projet déjà chargée : « exists » → bascule sur SetUnitProperties (deux appels, budget changé dans /sys)
      const before = client.calls();
      await client.ensureProjectSlice(projSlice, 40 * MiB);
      expect(client.calls() - before).toBe(2);
      await wait(() => limitOf(projDir, 'memory.high') === 40 * MiB, 5000, 'budget reposé par SetUnitProperties');
      seen.push(`${projDir} après ensureProjectSlice sur slice chargée : memory.high=${read(projDir, 'memory.high').trim()}`);
      await client.ensureProjectSlice(projSlice, 48 * MiB);
      await wait(() => limitOf(projDir, 'memory.high') === 48 * MiB, 5000, 'budget 48 Mo reposé');

      // 3) premier scope neuf avec tail (revérifié juste avant), second scope neuf dans la même slice avec l'allocateur
      const t1 = reverify('/proc', uid, [{ pid: tail.pid!, startTicks: startTicks(tail.pid!) }], own);
      expect(t1.map((t) => t.pid)).toEqual([tail.pid]);
      await client.startScope(scope1, projSlice, t1.map((t) => t.pid));
      await wait(() => readCgroup('/proc', tail.pid!) === scopeCg(scope1), 5000, 'tail dans le premier scope');
      const t2 = reverify('/proc', uid, [{ pid: alloc.pid!, startTicks: startTicks(alloc.pid!) }], own);
      expect(t2.map((t) => t.pid)).toEqual([alloc.pid]);
      await client.startScope(scope2, projSlice, t2.map((t) => t.pid));
      await wait(() => readCgroup('/proc', alloc.pid!) === scopeCg(scope2), 5000, 'allocateur dans le second scope');
      seen.push(`/proc/${tail.pid}/cgroup (tail) : ${readCgroup('/proc', tail.pid!)}`);
      seen.push(`/proc/${alloc.pid}/cgroup (allocateur) : ${readCgroup('/proc', alloc.pid!)}`);

      // 7a) PID « recyclé » : starttime différent → écarté avant tout appel
      expect(reverify('/proc', uid, [{ pid: tail.pid!, startTicks: startTicks(tail.pid!) + 1 }], scopeCg(scope1))).toEqual([]);

      // 4) OOMPolicy=continue et CollectMode=inactive-or-failed conservés sur les deux scopes (lecture seule)
      for (const s of [scope1, scope2]) {
        const v = (await systemctlRead(systemctl!, ['show', '-p', 'OOMPolicy', '--value', s])).trim();
        expect(v, `OOMPolicy de ${s}`).toBe('continue');
        seen.push(`systemctl --user show -p OOMPolicy --value ${s} : ${v}`);
        const c = (await systemctlRead(systemctl!, ['show', '-p', 'CollectMode', '--value', s])).trim();
        expect(c, `CollectMode de ${s}`).toBe('inactive-or-failed');
        seen.push(`systemctl --user show -p CollectMode --value ${s} : ${c}`);
      }

      // 5) le plafond global s'applique au-dessus : chaque scope est descendant de la slice de test plafonnée ; le budget
      // du projet est d'abord retiré (6a) pour que ce soit bien le MemoryHigh de la slice de test qui freine l'allocateur
      for (const s of [scope1, scope2]) expect(scopeCg(s).startsWith(`${sliceCg}/`)).toBe(true);
      // 6a) budget de la slice de projet retiré : infinity → « max » dans /sys
      await client.setProjectHigh(projSlice, null);
      await wait(() => read(projDir, 'memory.high').trim() === 'max', 5000, 'budget retiré');
      seen.push(`${projDir} après retrait du budget : memory.high=${read(projDir, 'memory.high').trim()}`);
      const ev0 = parseMemoryEvents(read(sliceDir, 'memory.events')).high;
      const local0 = parseMemoryEvents(read(sliceDir, 'memory.events.local')).high;
      alloc.stdin!.write('go\n');
      await wait(() => parseMemoryEvents(read(sliceDir, 'memory.events.local')).high > local0, 30_000, 'ralentissement par la slice de test');
      const ev1 = parseMemoryEvents(read(sliceDir, 'memory.events')).high;
      expect(ev1).toBeGreaterThan(ev0);
      seen.push(`${sliceDir}/memory.events high : ${ev0} → ${ev1} ; memory.events.local high : ${local0} → ${parseMemoryEvents(read(sliceDir, 'memory.events.local')).high} ; memory.current=${read(sliceDir, 'memory.current').trim()}`);

      // 6b) interrupteur éteint : plafonds de la slice de test remis à infinity
      await client.setSlice(slice, null);
      await wait(() => ['memory.high', 'memory.max', 'memory.swap.max'].every((f) => read(sliceDir, f).trim() === 'max'), 5000, 'plafonds retirés');
      seen.push(`${sliceDir} après extinction : memory.high=${read(sliceDir, 'memory.high').trim()} memory.max=${read(sliceDir, 'memory.max').trim()} memory.swap.max=${read(sliceDir, 'memory.swap.max').trim()}`);
    } catch (e) {
      bodyErr = { e }; // relancée en priorité après le nettoyage
    }
    // Nettoyage (toujours exécuté) : nos enfants seulement, par leur ChildProcess ; un enfant sans pid n'a jamais démarré.
    const started = kids.filter((k) => k.pid !== undefined);
    for (const k of started) if (alive(k)) k.kill('SIGKILL');
    await Promise.race([
      Promise.all(started.map((k) => (alive(k) ? new Promise((r) => k.once('exit', r)) : null))),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    console.log(`[antigel e2e]\n${seen.join('\n')}`);
    // toutes les unités de test sont tentées, même si l'une échoue
    const errs: unknown[] = [];
    for (const u of [scope1, scope2, projSlice, slice]) await client.stopTestUnit(u).catch(ignoreGone).catch((e) => errs.push(e));
    if (bodyErr) {
      for (const e of errs) console.error('[antigel e2e] nettoyage :', e);
      throw bodyErr.e;
    }
    if (errs.length > 0) throw errs[0];
    await wait(() => !existsSync(sliceDir), 10_000, 'slice de test retirée');
    // plus aucune unité de ce test (les slices arrêtées sont oubliées par systemd)
    const left = async () => (await systemctlRead(systemctl!, ['list-units', `cwatch-e2e${id}*`, '--all', '--plain', '--no-legend'])).trim();
    const t0 = Date.now();
    while ((await left()) !== '' && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 200));
    expect(await left()).toBe('');
  },
  120_000,
);
