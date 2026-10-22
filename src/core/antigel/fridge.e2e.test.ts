// Frigo (anti-gel lot 3), e2e RÉEL (`npm run test:fridge`, PROC_WATCH_ANTIGEL_E2E=1) : vrai gestionnaire systemd utilisateur,
// vrais cgroups, mais SEULEMENT des processus créés ici (tail, petit allocateur), sous des unités de test seulement :
//   cwatch.slice/cwatch-e2e<id>.slice                 slice de test racine (plafonds, swap permise)
//     └ cwatch-e2e<id>-a.slice                        slice de projet de test (budget, part de swap 8 Mo) : gelée, part de
//                                                     swap levée, reclaim, dégelée
//       ├ cwatch-e2e<id>-1.scope                      tail + allocateur
//       └ cwatch-e2e<id>-2.scope                      tentative de scope sous la slice gelée (refusée par systemd)
// Jamais d'appel sur cwatch.slice ni sur une unité cwatch-p-… ; tout est dégelé puis arrêté à la fin (nettoyage toujours exécuté).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { fridgeDepsFor } from '../../recorder/fridgeDeps';
import { cleanEnv, systemBin } from '../childEnv';
import { parseStat } from '../collector/parse';
import { probeAvailability, readCgroup, reverify } from './cgroupfs';
import { reclaimTarget } from './fridge';
import { MiB } from './limits';
import { BusctlError, createBusctl, createSystemdClient } from './systemd';
import { isTestUnitName, scopePath, slicePath } from './units';

const RUN = process.env.PROC_WATCH_ANTIGEL_E2E === '1';
const SYSFS = '/sys/fs/cgroup';
// 64 Mo touchés à chaque ligne reçue, « ok » en retour : preuve qu'il tourne (ou non) ; aucune autre activité
const ALLOC = "const k=[];process.stdin.on('data',()=>{for(let i=0;i<8;i++)k.push(Buffer.alloc(8*1024*1024,1));process.stdout.write('ok\\n')});setInterval(()=>{},1e6);";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn: () => boolean, ms: number, what: string) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`délai dépassé : ${what}`);
    await sleep(100);
  }
};
const startTicks = (pid: number) => parseStat(readFileSync(`/proc/${pid}/stat`, 'utf8')).starttime;
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');
const ignoreGone = (e: unknown) => {
  if (!(e instanceof BusctlError && e.code === 'no-unit')) throw e;
};
const alive = (k: ChildProcess) => k.exitCode === null && k.signalCode === null;

function systemctlRead(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['--user', ...args], { env: cleanEnv(process.env), timeout: 7000, maxBuffer: 64 * 1024 }, (err, out, errText) => {
      if (err) reject(new Error(`systemctl : ${String(errText).trim() || err.message}`));
      else resolve(String(out));
    });
  });
}

test.skipIf(!RUN)(
  'slice de projet de test : FreezeUnit récursif, scope refusé sous la slice gelée, memory.reclaim, ThawUnit (asynchrone puis synchrone), nettoyage',
  async () => {
    const uid = process.getuid!();
    const busctl = systemBin('busctl', existsSync);
    const systemctl = systemBin('systemctl', existsSync);
    const tailBin = systemBin('tail', existsSync);
    expect(busctl && systemctl && tailBin).toBeTruthy();
    const avail = probeAvailability({ procRoot: '/proc', sysfsRoot: SYSFS, uid, selfPid: process.pid, busctl });
    expect(avail).toMatchObject({ ok: true });
    if (!avail.ok) return;

    const id = randomBytes(5).toString('hex');
    const slice = `cwatch-e2e${id}.slice`;
    const projSlice = `cwatch-e2e${id}-a.slice`;
    const scope1 = `cwatch-e2e${id}-1.scope`;
    const scope2 = `cwatch-e2e${id}-2.scope`;
    for (const u of [slice, projSlice, scope1, scope2]) expect(isTestUnitName(u), u).toBe(true);
    const sliceDir = join(SYSFS, avail.userBase, slicePath(slice));
    const projCg = `${avail.userBase}/${slicePath(projSlice)}`;
    const projDir = join(SYSFS, projCg);
    const scopeCg = (s: string) => `${avail.userBase}/${scopePath(s, projSlice)}`;

    const client = createSystemdClient(createBusctl(busctl!, process.env));
    const fridge = fridgeDepsFor({ env: process.env, uid, selfPid: process.pid })!;
    const kids: ChildProcess[] = [];
    const seen: string[] = [];
    let bodyErr: { e: unknown } | null = null;
    let oks = 0;
    try {
      const tail = spawn(tailBin!, ['-f', '/dev/null'], { stdio: 'ignore' });
      kids.push(tail);
      const alloc = spawn(process.execPath, ['-e', ALLOC], { stdio: ['pipe', 'pipe', 'inherit'] });
      kids.push(alloc);
      alloc.stdout!.on('data', (b: Buffer) => { oks += String(b).split('ok').length - 1; });
      const tail2 = spawn(tailBin!, ['-f', '/dev/null'], { stdio: 'ignore' });
      kids.push(tail2);
      await wait(() => [tail, alloc, tail2].every((k) => !!k.pid && readCgroup('/proc', k.pid) !== null), 5000, 'enfants lancés');
      const own = readCgroup('/proc', tail.pid!)!;

      // 1) slice de test racine (swap permise : le reclaim peut pousser l'anonyme en swap) et slice de projet de test
      await client.ensureSlice(slice, { reserveBytes: 0, highBytes: 768 * MiB, maxBytes: 1024 * MiB, swapMaxBytes: 512 * MiB });
      // budget de la slice de projet : freinage et plafond dur loin de ses 64 Mo, part de swap de 8 Mo seulement
      await client.ensureProjectSlice(projSlice, { highBytes: 256 * MiB, maxBytes: 512 * MiB, swapMaxBytes: 8 * MiB });
      await wait(() => existsSync(projDir), 5000, 'slice de projet créée');
      expect(read(projDir, 'memory.swap.max').trim()).toBe(String(8 * MiB));
      const live = reverify('/proc', uid, [tail, alloc].map((k) => ({ pid: k.pid!, startTicks: startTicks(k.pid!) })), own);
      expect(live).toHaveLength(2);
      await client.startScope(scope1, projSlice, live.map((t) => t.pid));
      await wait(() => readCgroup('/proc', alloc.pid!) === scopeCg(scope1), 5000, 'tail et allocateur dans le scope');
      alloc.stdin!.write('go\n');
      await wait(() => oks === 1, 10_000, 'allocateur : 64 Mo touchés');

      // 2) gel : FreezeUnit sur la slice de projet, récursif (le scope passe « frozen-by-parent »)
      await fridge.client.freeze(projSlice);
      await wait(() => fridge.read(projCg, 'cgroup.freeze')?.trim() === '1' && /^frozen 1$/m.test(read(projDir, 'cgroup.events')), 5000, 'slice gelée');
      await wait(() => /^frozen 1$/m.test(read(join(projDir, scope1), 'cgroup.events')), 5000, 'scope gelé');
      const st = (await systemctlRead(systemctl!, ['show', '-p', 'FreezerState', '--value', projSlice, scope1])).trim().split('\n').filter(Boolean);
      expect(st).toEqual(['frozen', 'frozen-by-parent']);
      seen.push(`${projDir} : cgroup.freeze=${read(projDir, 'cgroup.freeze').trim()} ; cgroup.events ${read(projDir, 'cgroup.events').replace(/\n/g, ' ')}; FreezerState ${st.join(' / ')}`);
      // gelé : l'allocateur ne répond plus
      alloc.stdin!.write('go\n');
      await sleep(1500);
      expect(oks).toBe(1);
      // FreezeUnit répété : sans effet (idempotent)
      await fridge.client.freeze(projSlice);
      // part de swap du budget levée sur la slice gelée (SetUnitProperties MemorySwapMax=infinity) ; budget et plafond dur gardés
      await fridge.client.liftSwap(projSlice);
      await wait(() => read(projDir, 'memory.swap.max').trim() === 'max', 5000, 'part de swap levée');
      expect(read(projDir, 'memory.high').trim()).toBe(String(256 * MiB));
      expect(read(projDir, 'memory.max').trim()).toBe(String(512 * MiB));
      expect(/^frozen 1$/m.test(read(projDir, 'cgroup.events'))).toBe(true);
      seen.push(`part de swap levée sur la slice gelée : memory.swap.max=${read(projDir, 'memory.swap.max').trim()} memory.high=${read(projDir, 'memory.high').trim()} memory.max=${read(projDir, 'memory.max').trim()}`);

      // 3) scope neuf sous la slice gelée : busctl répond, mais systemd refuse le job ; le processus reste où il est
      const live2 = reverify('/proc', uid, [{ pid: tail2.pid!, startTicks: startTicks(tail2.pid!) }], own);
      await client.startScope(scope2, projSlice, live2.map((t) => t.pid));
      await sleep(1500);
      expect(readCgroup('/proc', tail2.pid!)).toBe(own);
      seen.push(`scope sous la slice gelée : /proc/${tail2.pid}/cgroup reste ${readCgroup('/proc', tail2.pid!)}`);

      // 4) reclaim par morceaux sur la slice gelée : memory.current baisse
      const before = Number(fridge.read(projCg, 'memory.current'));
      const target = reclaimTarget({
        stat: fridge.read(projCg, 'memory.stat'), currentBytes: before, swapFreeBytes: Number(/^SwapFree:\s+(\d+)/m.exec(readFileSync('/proc/meminfo', 'utf8'))![1]) * 1024,
        rootSwapMax: read(sliceDir, 'memory.swap.max'), rootSwapCurrent: read(sliceDir, 'memory.swap.current'),
      });
      expect(target).toBeGreaterThan(0);
      let done = 0;
      const results: string[] = [];
      for (let k = 0; k < 8 && done < target; k++) {
        const r = await fridge.reclaim(projCg, Math.min(16 * MiB, target - done));
        results.push(r);
        if (r === 'ok') done += Math.min(16 * MiB, target - done);
      }
      const after = Number(fridge.read(projCg, 'memory.current'));
      seen.push(`reclaim : cible ${target} o, écrits ${done} o (${results.join(',')}) ; memory.current ${before} → ${after} ; memory.swap.current=${read(projDir, 'memory.swap.current').trim()} ; zswap=${existsSync(join(projDir, 'memory.zswap.current')) ? read(projDir, 'memory.zswap.current').trim() : '?'}`);
      expect(after).toBeLessThan(before - 16 * MiB);
      // au-delà de l'ancienne part de swap (8 Mo) : la levée a servi
      expect(Number(read(projDir, 'memory.swap.current'))).toBeGreaterThan(8 * MiB);
      expect(oks).toBe(1); // toujours gelé
      await expect(fridge.reclaim(`${avail.userBase}/${slicePath(slice)}`, MiB)).rejects.toThrow(/refusé/); // jamais la slice racine

      // 5) réveil : ThawUnit ; l'allocateur reprend et répond à la ligne restée en attente
      await fridge.client.thaw(projSlice);
      await wait(() => /^frozen 0$/m.test(read(projDir, 'cgroup.events')) && /^frozen 0$/m.test(read(join(projDir, scope1), 'cgroup.events')), 5000, 'slice dégelée');
      await wait(() => oks === 2, 15_000, 'allocateur reparti');
      seen.push(`après ThawUnit : cgroup.freeze=${read(projDir, 'cgroup.freeze').trim()}, allocateur reparti (${oks} réponses)`);

      // 6) dégel synchrone (arrêt du service)
      await fridge.client.freeze(projSlice);
      await wait(() => read(projDir, 'cgroup.freeze').trim() === '1', 5000, 'regelée');
      fridge.client.thawSync(projSlice);
      expect(read(projDir, 'cgroup.freeze').trim()).toBe('0');
      await wait(() => /^frozen 0$/m.test(read(projDir, 'cgroup.events')), 5000, 'dégelée par thawSync');
      seen.push('thawSync : cgroup.freeze=0');
    } catch (e) {
      bodyErr = { e };
    }
    // Nettoyage (toujours) : dégel d'abord (jamais un processus laissé gelé), puis nos enfants par leur ChildProcess, puis unités de test.
    try {
      if (existsSync(projDir)) await fridge.client.thaw(projSlice);
    } catch (e) {
      console.error('[frigo e2e] dégel au nettoyage :', e);
    }
    const started = kids.filter((k) => k.pid !== undefined);
    for (const k of started) if (alive(k)) k.kill('SIGKILL');
    await Promise.race([
      Promise.all(started.map((k) => (alive(k) ? new Promise((r) => k.once('exit', r)) : null))),
      sleep(5000),
    ]);
    console.log(`[frigo e2e]\n${seen.join('\n')}`);
    const errs: unknown[] = [];
    for (const u of [scope2, scope1, projSlice, slice]) await client.stopTestUnit(u).catch(ignoreGone).catch((e) => errs.push(e));
    if (bodyErr) {
      for (const e of errs) console.error('[frigo e2e] nettoyage :', e);
      throw bodyErr.e;
    }
    if (errs.length > 0) throw errs[0];
    await wait(() => !existsSync(sliceDir), 10_000, 'slice de test retirée');
    const left = async () => (await systemctlRead(systemctl!, ['list-units', `cwatch-e2e${id}*`, '--all', '--plain', '--no-legend'])).trim();
    const t0 = Date.now();
    while ((await left()) !== '' && Date.now() - t0 < 10_000) await sleep(200);
    expect(await left()).toBe('');
  },
  120_000,
);
