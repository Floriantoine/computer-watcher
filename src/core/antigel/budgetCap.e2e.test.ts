// Budget d'un projet : plafond dur et part de swap, e2e RÉEL (`npm run test:antigel`, PROC_WATCH_ANTIGEL_E2E=1) : vrai
// gestionnaire systemd utilisateur, vrais cgroups, vrai noyau, mais SEULEMENT des processus créés ici (tail, petits
// allocateurs node), arrêtés par leur propre ChildProcess.kill, sous des unités de test seulement :
//   cwatch.slice/cwatch-e2e<id>.slice                  slice de test racine (filet : 256 Mo au plus, swap 32 Mo)
//     ├ cwatch-e2e<id>-a.slice                         budget minuscule : freine à 60 Mo, swap 8 Mo, arrêt au-delà de 64 Mo
//     │ └ cwatch-e2e<id>-1.scope                       tail + allocateur
//     ├ cwatch-e2e<id>-b.slice                         sans budget (un autre projet)
//     │ └ cwatch-e2e<id>-2.scope                       tail
//     └ cwatch-e2e<id>-c.slice                         convergence : un allocateur qui tient 48 Mo, swap interdit
//       └ cwatch-e2e<id>-3.scope
// Jamais d'appel sur cwatch.slice ni sur une unité cwatch-p-… ; tout est arrêté à la fin (nettoyage toujours exécuté).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { cleanEnv, systemBin } from '../childEnv';
import { parseStat } from '../collector/parse';
import { parseLimit, parseMemoryEvents, probeAvailability, readCgroup, reverify } from './cgroupfs';
import { MiB, convergingMax, type ProjectCaps } from './limits';
import { BusctlError, createBusctl, createSystemdClient } from './systemd';
import { isTestUnitName, scopePath, slicePath } from './units';

const RUN = process.env.PROC_WATCH_ANTIGEL_E2E === '1';
const SYSFS = '/sys/fs/cgroup';
// « go » : 64 × 4 Mo touchés (256 Mo) ; « fini » n'est jamais écrit si le plafond dur arrête l'allocateur avant
const GROW = "const k=[];process.stdin.on('data',()=>{for(let i=0;i<64;i++)k.push(Buffer.alloc(4*1024*1024,1));process.stdout.write('fini\\n')});setInterval(()=>{},1e6);";
// « hold » : 12 × 4 Mo touchés (48 Mo) gardés, puis « ok »
const HOLD = "const k=[];process.stdin.on('data',()=>{for(let i=0;i<12;i++)k.push(Buffer.alloc(4*1024*1024,1));process.stdout.write('ok\\n')});setInterval(()=>{},1e6);";
// budget minuscule de la slice A : la même forme qu'un vrai budget (freinage, part de swap, plafond dur), en petit. Le
// freinage au-delà de memory.high ralentit énormément la montée (mesuré : 56 → 64 Mo, ~80 s pour un seul processus) :
// zone de freinage étroite ici pour un test court.
const CAPS_A: ProjectCaps = { highBytes: 60 * MiB, maxBytes: 64 * MiB, swapMaxBytes: 8 * MiB };
// slice C : d'abord sans freinage ni swap (la mémoire de l'allocateur reste en RAM), puis le budget visé (marge 16 Mo)
const OPEN_C: ProjectCaps = { highBytes: 512 * MiB, maxBytes: 512 * MiB, swapMaxBytes: 0 };
const CAPS_C: ProjectCaps = { highBytes: 16 * MiB, maxBytes: 32 * MiB, swapMaxBytes: 0 };

const wait = async (fn: () => boolean, ms: number, what: string) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`délai dépassé : ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const startTicks = (pid: number) => parseStat(readFileSync(`/proc/${pid}/stat`, 'utf8')).starttime;
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');
const limitOf = (dir: string, f: string) => parseLimit(read(dir, f));
const eventsOf = (dir: string, f = 'memory.events') => parseMemoryEvents(read(dir, f));
const ignoreGone = (e: unknown) => {
  if (!(e instanceof BusctlError && e.code === 'no-unit')) throw e;
};
const alive = (k: ChildProcess) => k.exitCode === null && k.signalCode === null;
const mib = (n: number | null) => (n === null ? 'max' : `${Math.round((n / MiB) * 10) / 10} Mio`);

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
  'plafond dur d’un budget : le noyau arrête un processus de CE projet seulement, slice et scope survivent, autre projet intact ; ' +
    'convergence sans arrêt immédiat ; retrait ; nettoyage',
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
    const root = `cwatch-e2e${id}.slice`;
    const [sa, sb, sc] = ['a', 'b', 'c'].map((x) => `cwatch-e2e${id}-${x}.slice`) as [string, string, string];
    const [scope1, scope2, scope3] = ['1', '2', '3'].map((x) => `cwatch-e2e${id}-${x}.scope`) as [string, string, string];
    for (const u of [root, sa, sb, sc, scope1, scope2, scope3]) expect(isTestUnitName(u), u).toBe(true);
    const dir = (s: string) => join(SYSFS, avail.userBase, slicePath(s));
    const scopeCg = (scope: string, s: string) => `${avail.userBase}/${scopePath(scope, s)}`;
    const show = async (unit: string, prop: string) => (await systemctlRead(systemctl!, ['show', '-p', prop, '--value', unit])).trim();

    const client = createSystemdClient(createBusctl(busctl!, process.env));
    const kids: ChildProcess[] = [];
    const seen: string[] = [];
    let bodyErr: { e: unknown } | null = null;
    try {
      const tailA = spawn(tailBin!, ['-f', '/dev/null'], { stdio: 'ignore' });
      const grow = spawn(process.execPath, ['-e', GROW], { stdio: ['pipe', 'pipe', 'inherit'] });
      const tailB = spawn(tailBin!, ['-f', '/dev/null'], { stdio: 'ignore' });
      const hold = spawn(process.execPath, ['-e', HOLD], { stdio: ['pipe', 'pipe', 'inherit'] });
      kids.push(tailA, grow, tailB, hold);
      let grown = '';
      grow.stdout!.on('data', (b) => { grown += String(b); });
      let held = '';
      hold.stdout!.on('data', (b) => { held += String(b); });
      await wait(() => kids.every((k) => !!k.pid && readCgroup('/proc', k.pid) !== null), 5000, 'enfants lancés');
      const own = readCgroup('/proc', tailA.pid!)!;
      expect(own.startsWith(`${avail.userBase}/`), 'enfants sous le gestionnaire utilisateur').toBe(true);
      const move = async (scope: string, s: string, ks: ChildProcess[]) => {
        const t = reverify('/proc', uid, ks.map((k) => ({ pid: k.pid!, startTicks: startTicks(k.pid!) })), own);
        expect(t.map((x) => x.pid)).toEqual(ks.map((k) => k.pid));
        await client.startScope(scope, s, t.map((x) => x.pid));
        await wait(() => ks.every((k) => readCgroup('/proc', k.pid!) === scopeCg(scope, s)), 5000, `${scope} peuplé`);
      };

      // 1) slice de test racine (filet), puis slice A avec son budget : les trois propriétés arrivent dans /sys
      await client.ensureSlice(root, { reserveBytes: 0, highBytes: 192 * MiB, maxBytes: 256 * MiB, swapMaxBytes: 32 * MiB });
      await client.ensureProjectSlice(sa, CAPS_A);
      await wait(() => existsSync(dir(sa)), 5000, 'slice A créée');
      expect(limitOf(dir(sa), 'memory.high')).toBe(60 * MiB);
      expect(limitOf(dir(sa), 'memory.max')).toBe(64 * MiB);
      expect(limitOf(dir(sa), 'memory.swap.max')).toBe(8 * MiB);
      // le noyau arrête UN processus (le plus gros), jamais le groupe : memory.oom.group à 0
      expect(read(dir(sa), 'memory.oom.group').trim()).toBe('0');
      seen.push(`slice A : memory.high=${mib(limitOf(dir(sa), 'memory.high'))} memory.max=${mib(limitOf(dir(sa), 'memory.max'))} memory.swap.max=${mib(limitOf(dir(sa), 'memory.swap.max'))} memory.oom.group=0`);
      seen.push(`systemctl show ${sa} : MemoryHigh=${await show(sa, 'MemoryHigh')} MemoryMax=${await show(sa, 'MemoryMax')} MemorySwapMax=${await show(sa, 'MemorySwapMax')}`);

      // 2) slice B sans budget (un autre projet) : rien de posé
      await client.ensureProjectSlice(sb, null);
      await wait(() => existsSync(dir(sb)), 5000, 'slice B créée');
      for (const f of ['memory.high', 'memory.max', 'memory.swap.max']) expect(read(dir(sb), f).trim(), f).toBe('max');

      // 3) scopes : tail + allocateur dans A, tail dans B ; OOMPolicy=continue, memory.oom.group à 0
      await move(scope1, sa, [tailA, grow]);
      await move(scope2, sb, [tailB]);
      for (const s of [scope1, scope2]) expect(await show(s, 'OOMPolicy'), `OOMPolicy de ${s}`).toBe('continue');
      expect(read(join(SYSFS, scopeCg(scope1, sa)), 'memory.oom.group').trim()).toBe('0');

      // 4) l'allocateur dépasse : arrêté par le noyau DANS la slice A (SIGKILL), sans jamais finir ses 256 Mo
      const rootLocal0 = eventsOf(dir(root), 'memory.events.local');
      const t0 = Date.now();
      grow.stdin!.write('go\n');
      // relevés toutes les 5 s pendant la montée (mémoire, swap, événements, état du processus)
      const sample = () => {
        const e = eventsOf(dir(sa));
        let st = '?';
        try {
          st = /^State:\s+(\S+)/m.exec(readFileSync(`/proc/${grow.pid}/status`, 'utf8'))?.[1] ?? '?';
        } catch { st = 'fini'; }
        seen.push(`  t=${((Date.now() - t0) / 1000).toFixed(1)} s current=${mib(limitOf(dir(sa), 'memory.current'))} swap=${mib(limitOf(dir(sa), 'memory.swap.current'))} high=${e.high} max=${e.max} oom=${e.oom} oom_kill=${e.oomKill} état=${st}`);
      };
      const timer = setInterval(sample, 5000);
      try {
        await wait(() => !alive(grow), 120_000, 'allocateur arrêté par le noyau');
      } finally {
        clearInterval(timer);
      }
      const killMs = Date.now() - t0;
      expect(grow.signalCode).toBe('SIGKILL');
      expect(grown).not.toMatch(/fini/);
      const evA = eventsOf(dir(sa));
      const localA = eventsOf(dir(sa), 'memory.events.local');
      expect(evA.oomKill).toBeGreaterThanOrEqual(1);
      // l'arrêt vient de la limite de la slice A elle-même (« oom » local), pas de la slice de test racine
      expect(localA.oom).toBeGreaterThanOrEqual(1);
      expect(eventsOf(dir(root), 'memory.events.local').oom).toBe(rootLocal0.oom);
      // empreinte maximale : RAM ≤ MemoryMax (à quelques Mo près : le noyau laisse la tâche qu'il arrête finir ses dernières
      // allocations au-delà, pour qu'elle meure vite ; mesuré jusqu'à +2,2 Mo), swap ≤ MemorySwapMax (jamais dépassé)
      const peak = limitOf(dir(sa), 'memory.peak');
      const swapPeak = existsSync(join(dir(sa), 'memory.swap.peak')) ? limitOf(dir(sa), 'memory.swap.peak') : null;
      expect(peak).not.toBeNull();
      expect(peak!).toBeLessThanOrEqual(CAPS_A.maxBytes + 4 * MiB);
      if (swapPeak !== null) expect(swapPeak).toBeLessThanOrEqual(CAPS_A.swapMaxBytes);
      seen.push(`arrêt en ${killMs} ms ; slice A memory.events : high=${evA.high} max=${evA.max} oom=${evA.oom} oom_kill=${evA.oomKill} (local oom=${localA.oom})`);
      seen.push(`empreinte maximale de la slice A : memory.peak=${mib(peak)} (MemoryMax ${mib(CAPS_A.maxBytes)}) memory.swap.peak=${mib(swapPeak)} (MemorySwapMax ${mib(CAPS_A.swapMaxBytes)})`);

      // 5) survivants : le tail de A (même scope), le scope et la slice A ; le tail de B, sans aucun arrêt dans B
      await sleep(1000);
      expect(alive(tailA), 'tail de A vivant').toBe(true);
      expect(readCgroup('/proc', tailA.pid!)).toBe(scopeCg(scope1, sa));
      expect(await show(scope1, 'ActiveState')).toBe('active');
      expect(await show(sa, 'ActiveState')).toBe('active');
      expect(alive(tailB), 'tail de B vivant').toBe(true);
      expect(eventsOf(dir(sb)).oomKill).toBe(0);
      expect(await show(scope2, 'ActiveState')).toBe('active');
      seen.push(`après l'arrêt : tail de A vivant (${scope1} ${await show(scope1, 'ActiveState')}, ${sa} ${await show(sa, 'ActiveState')}) ; tail de B vivant, oom_kill de B = ${eventsOf(dir(sb)).oomKill}`);

      // 6) budget retiré : les trois propriétés repassent à « max »
      await client.setProjectCaps(sa, null);
      await wait(() => ['memory.high', 'memory.max', 'memory.swap.max'].every((f) => read(dir(sa), f).trim() === 'max'), 5000, 'plafonds de A retirés');
      seen.push(`slice A après retrait : memory.high=${read(dir(sa), 'memory.high').trim()} memory.max=${read(dir(sa), 'memory.max').trim()} memory.swap.max=${read(dir(sa), 'memory.swap.max').trim()}`);

      // 7) convergence : un projet qui tient déjà 48 Mo (en RAM, swap interdit) reçoit un budget de 16 Mo (arrêt à 32 Mo)
      await client.ensureProjectSlice(sc, OPEN_C);
      await wait(() => existsSync(dir(sc)), 5000, 'slice C créée');
      await move(scope3, sc, [hold]);
      hold.stdin!.write('hold\n');
      await wait(() => /ok/.test(held), 20_000, 'allocateur C à 48 Mo');
      const cur = Number(read(dir(sc), 'memory.current').trim());
      expect(cur).toBeGreaterThanOrEqual(48 * MiB);
      // plafond dur posé par la convergence : jamais sous l'usage actuel + marge → aucun arrêt
      const posedMax = convergingMax(CAPS_C, cur, OPEN_C.maxBytes);
      expect(posedMax).toBeGreaterThanOrEqual(cur + (CAPS_C.maxBytes - CAPS_C.highBytes));
      await client.setProjectCaps(sc, { ...CAPS_C, maxBytes: posedMax });
      await wait(() => limitOf(dir(sc), 'memory.max') === posedMax, 5000, 'plafond provisoire posé');
      await sleep(2000);
      expect(alive(hold), 'allocateur C vivant sous le plafond provisoire').toBe(true);
      expect(eventsOf(dir(sc)).oomKill).toBe(0);
      expect(limitOf(dir(sc), 'memory.high')).toBe(16 * MiB);
      seen.push(`slice C : memory.current=${mib(cur)} ; plafond provisoire memory.max=${mib(limitOf(dir(sc), 'memory.max'))} (budget 16 Mio, plafond visé 32 Mio) → allocateur vivant, oom_kill=0`);
      // ce qu'éviterait la convergence : le plafond visé posé tel quel sous l'usage
      await client.setProjectCaps(sc, CAPS_C);
      await wait(() => limitOf(dir(sc), 'memory.max') === CAPS_C.maxBytes, 5000, 'plafond visé posé');
      await sleep(2000);
      const evC = eventsOf(dir(sc));
      seen.push(`slice C : plafond visé posé sous l'usage → memory.current=${mib(limitOf(dir(sc), 'memory.current'))} memory.max=${mib(limitOf(dir(sc), 'memory.max'))} events max=${evC.max} oom=${evC.oom} oom_kill=${evC.oomKill} ; allocateur ${alive(hold) ? 'vivant' : `arrêté (${hold.signalCode})`}`);
      if (alive(hold)) {
        hold.stdin!.write('hold\n');
        await wait(() => !alive(hold), 10_000, 'arrêt à la prochaine allocation');
        seen.push(`slice C : prochaine allocation → allocateur arrêté (${hold.signalCode}), oom_kill=${eventsOf(dir(sc)).oomKill}`);
      }
      expect(hold.signalCode).toBe('SIGKILL');
      expect(eventsOf(dir(sc)).oomKill).toBeGreaterThanOrEqual(1);
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
    console.log(`[budget-cap e2e]\n${seen.join('\n')}`);
    // toutes les unités de test sont tentées, même si l'une échoue
    const errs: unknown[] = [];
    for (const u of [scope1, scope2, scope3, sa, sb, sc, root]) await client.stopTestUnit(u).catch(ignoreGone).catch((e) => errs.push(e));
    if (bodyErr) {
      for (const e of errs) console.error('[budget-cap e2e] nettoyage :', e);
      throw bodyErr.e;
    }
    if (errs.length > 0) throw errs[0];
    await wait(() => !existsSync(dir(root)), 10_000, 'slice de test retirée');
    // plus aucune unité de ce test (les slices arrêtées sont oubliées par systemd)
    const left = async () => (await systemctlRead(systemctl!, ['list-units', `cwatch-e2e${id}*`, '--all', '--plain', '--no-legend'])).trim();
    const t1 = Date.now();
    while ((await left()) !== '' && Date.now() - t1 < 10_000) await new Promise((r) => setTimeout(r, 200));
    expect(await left()).toBe('');
  },
  210_000,
);
