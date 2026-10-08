import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createNotifier, notifyArgs, resolveBin, type NotifyRequest } from './notify';

/** Faux notify-send : note chaque appel (un argument par ligne, `---` entre deux appels), puis exécute `body`. */
function fakeBin(body: string, opts: { help?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pw-notify-'));
  const calls = join(dir, 'calls');
  const bin = join(dir, 'notify-send');
  const help = opts.help ?? 'Usage:\n  notify-send [OPTION…] <SUMMARY> [BODY]\n  -u, --urgency=LEVEL\n  -A, --action=[NAME=]Text…\n  -a, --app-name=APP_NAME';
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--help" ]; then printf '%s\\n' '${help.replace(/'/g, '')}'; exit 0; fi
for a in "$@"; do printf '%s\\n' "$a"; done >> '${calls}'
printf '%s\\n' '---' >> '${calls}'
${body}
`,
  );
  chmodSync(bin, 0o755);
  const read = (): string[][] => {
    if (!existsSync(calls)) return [];
    return readFileSync(calls, 'utf8').split('---\n').filter(Boolean).map((c) => c.split('\n').filter((l, i, a) => i < a.length - 1 || l));
  };
  return { dir, bin, calls: read };
}

const req = (o: Partial<NotifyRequest> = {}): NotifyRequest => ({
  title: 'Fuite probable : acme',
  body: '+3,0 Go en 60 min',
  urgency: 'critical',
  actions: [{ id: 'open', label: 'Ouvrir' }],
  waitMs: 5000,
  ...o,
});

const silentLog = () => {
  const lines: string[] = [];
  return { lines, log: (m: string) => lines.push(m) };
};

describe('notifyArgs', () => {
  test('arguments exacts, titre et corps littéraux après `--` (pas de shell)', () => {
    expect(notifyArgs(req({ body: '$(rm -rf ~)' }), true)).toEqual([
      '--app-name=proc-watch', '--urgency=critical', '--icon=dialog-warning', '--action=open=Ouvrir', '--', 'Fuite probable : acme', '$(rm -rf ~)',
    ]);
    expect(notifyArgs(req({ urgency: 'normal' }), false)).toEqual([
      '--app-name=proc-watch', '--urgency=normal', '--icon=dialog-warning', '--', 'Fuite probable : acme', '+3,0 Go en 60 min',
    ]);
  });
});

describe('resolveBin', () => {
  test('chemin absolu trouvé une fois dans PATH ; entrées relatives ignorées ; absent → null', () => {
    const { dir, bin } = fakeBin('exit 0');
    const empty = mkdtempSync(join(tmpdir(), 'pw-notify-'));
    mkdirSync(join(empty, 'notify-send')); // un dossier du même nom n'est pas un exécutable
    expect(resolveBin('notify-send', `relative:${empty}:${dir}:/nope`)).toBe(bin);
    expect(resolveBin('notify-send', `${empty}:/nope`)).toBeNull();
    expect(resolveBin('notify-send', undefined)).toBeNull();
  });
});

describe('createNotifier', () => {
  test('moderne : --action détecté, arguments exacts, id de l’action choisie renvoyé', async () => {
    const f = fakeBin("echo open");
    const n = createNotifier({ bin: f.bin, log: () => {} });
    expect(n.state()).toBe('unknown');
    await expect(n.notify(req())).resolves.toBe('open');
    expect(n.state()).toBe('actions');
    expect(f.calls()).toEqual([[
      '--app-name=proc-watch', '--urgency=critical', '--icon=dialog-warning', '--action=open=Ouvrir', '--', 'Fuite probable : acme', '+3,0 Go en 60 min',
    ]]);
  });

  test('moderne, notification fermée sans action : null', async () => {
    const f = fakeBin('exit 0');
    await expect(createNotifier({ bin: f.bin, log: () => {} }).notify(req())).resolves.toBeNull();
  });

  test('id inconnu sur stdout : null (seuls les ids demandés sont rendus)', async () => {
    const f = fakeBin('echo rm');
    await expect(createNotifier({ bin: f.bin, log: () => {} }).notify(req())).resolves.toBeNull();
  });

  test('sans --action (vieux libnotify) : notification simple, sans action, résout null', async () => {
    const f = fakeBin('exit 0', { help: 'Usage:\n  -u, --urgency=LEVEL\n  -a, --app-name=APP_NAME' });
    const n = createNotifier({ bin: f.bin, log: () => {} });
    await expect(n.notify(req())).resolves.toBeNull();
    expect(n.state()).toBe('plain');
    expect(f.calls()).toEqual([['--app-name=proc-watch', '--urgency=critical', '--icon=dialog-warning', '--', 'Fuite probable : acme', '+3,0 Go en 60 min']]);
  });

  test('--help annonce --action mais l’option est refusée : bascule en simple et renvoie sans action', async () => {
    const f = fakeBin(`case "$*" in *--action*) echo "Unknown option --action=open=Ouvrir" >&2; exit 1;; esac; exit 0`);
    const { lines, log } = silentLog();
    const n = createNotifier({ bin: f.bin, log });
    await expect(n.notify(req())).resolves.toBeNull();
    expect(n.state()).toBe('plain');
    expect(f.calls().map((c) => c.some((a) => a.startsWith('--action')))).toEqual([true, false]);
    expect(lines).toHaveLength(1);
  });

  test('binaire absent : unavailable, null, une seule ligne de journal pour deux appels, aucune exception', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pw-notify-'));
    const { lines, log } = silentLog();
    let t = 0;
    const n = createNotifier({ bin: join(dir, 'nope'), log, now: () => t });
    await expect(n.notify(req())).resolves.toBeNull();
    t += 60_000;
    await expect(n.notify(req())).resolves.toBeNull();
    expect(n.state()).toBe('unavailable');
    expect(lines).toHaveLength(1);
  });

  test('absent de PATH : unavailable sans exception', async () => {
    const { log } = silentLog();
    const n = createNotifier({ pathEnv: '/nope', log });
    await expect(n.notify(req())).resolves.toBeNull();
    expect(n.state()).toBe('unavailable');
  });

  test('sans démon (code 1, rien écrit) : null, pas d’exception, reste en mode actions', async () => {
    const f = fakeBin('exit 1');
    const n = createNotifier({ bin: f.bin, log: () => {} });
    await expect(n.notify(req())).resolves.toBeNull();
    expect(n.state()).toBe('actions');
  });

  test('ne rend jamais la main : tué après waitMs, résout null', async () => {
    const f = fakeBin('echo $$ > "$(dirname "$0")/pid"; exec sleep 600');
    const n = createNotifier({ bin: f.bin, log: () => {} });
    const t0 = Date.now();
    await expect(n.notify(req({ waitMs: 300 }))).resolves.toBeNull();
    expect(Date.now() - t0).toBeLessThan(3000);
    const pid = Number(readFileSync(join(f.dir, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  test('un seul notify-send en attente : le précédent est tué', async () => {
    const f = fakeBin('echo $$ >> "$(dirname "$0")/pids"; exec sleep 600');
    const n = createNotifier({ bin: f.bin, log: () => {} });
    const first = n.notify(req({ waitMs: 60_000 }));
    // attend que le premier soit lancé
    for (let i = 0; i < 100 && !existsSync(join(f.dir, 'pids')); i++) await new Promise((r) => setTimeout(r, 20));
    const second = n.notify(req({ waitMs: 300 }));
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    const pids = readFileSync(join(f.dir, 'pids'), 'utf8').trim().split('\n').map(Number);
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  test('sans action demandée : jamais --action, même si supporté', async () => {
    const f = fakeBin('exit 0');
    await createNotifier({ bin: f.bin, log: () => {} }).notify(req({ actions: [] }));
    expect(f.calls()[0]!.some((a) => a.startsWith('--action'))).toBe(false);
  });
});
