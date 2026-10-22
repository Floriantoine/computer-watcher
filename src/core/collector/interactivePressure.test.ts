import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readInteractivePressure } from './interactivePressure';

const psi = (full: number) => `some avg10=${(full + 3).toFixed(2)} avg60=0.00 avg300=0.00 total=1\nfull avg10=${full.toFixed(2)} avg60=0.00 avg300=0.00 total=1\n`;

/** Faux /sys/fs/cgroup : `files` = chemin relatif sous user-1000.slice → contenu de memory.pressure. */
function cgroupRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pw-cg-'));
  const user = join(root, 'user.slice', 'user-1000.slice');
  mkdirSync(user, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(user, rel), { recursive: true });
    writeFileSync(join(user, rel, 'memory.pressure'), text);
  }
  return root;
}
const M = 'user@1000.service';

describe('pression mémoire du bureau et des applis', () => {
  test('le max de session.slice et app.slice', () => {
    const root = cgroupRoot({ [`${M}/session.slice`]: psi(12.5), [`${M}/app.slice`]: psi(47.25) });
    expect(readInteractivePressure({ cgroupRoot: root, uid: 1000, globalFull10: 3 })).toEqual({ percent: 47.25, scope: 'interactive' });
  });

  test('projet freiné par son budget (cwatch.slice et machine hautes) : le bureau et les applis restent à 0', () => {
    const root = cgroupRoot({
      [`${M}/session.slice`]: psi(0), [`${M}/app.slice`]: psi(0), [`${M}/cwatch.slice`]: psi(90), [`${M}/background.slice`]: psi(60),
    });
    expect(readInteractivePressure({ cgroupRoot: root, uid: 1000, globalFull10: 25 })).toEqual({ percent: 0, scope: 'interactive' });
  });

  test('sessions de connexion hors du gestionnaire utilisateur (bureau XFCE, TTY) : comptées', () => {
    const root = cgroupRoot({ [`${M}/session.slice`]: psi(0), [`${M}/app.slice`]: psi(1), 'session-2.scope': psi(52), 'session-c1.scope': psi(4) });
    expect(readInteractivePressure({ cgroupRoot: root, uid: 1000, globalFull10: 60 })).toEqual({ percent: 52, scope: 'interactive' });
  });

  test('une seule slice lisible : elle ; fichier sans ligne « full » : ignoré', () => {
    expect(readInteractivePressure({ cgroupRoot: cgroupRoot({ [`${M}/app.slice`]: psi(33) }), uid: 1000, globalFull10: 80 })).toEqual({ percent: 33, scope: 'interactive' });
    const root = cgroupRoot({ [`${M}/session.slice`]: 'some avg10=50.00 avg60=0 avg300=0 total=1\n', [`${M}/app.slice`]: psi(7) });
    expect(readInteractivePressure({ cgroupRoot: root, uid: 1000, globalFull10: 80 })).toEqual({ percent: 7, scope: 'interactive' });
  });

  test('aucun cgroup interactif lisible (pas de systemd, cgroups v1, autre uid) : PSI full de la machine, puis rien', () => {
    const empty = cgroupRoot({});
    expect(readInteractivePressure({ cgroupRoot: empty, uid: 1000, globalFull10: 41 })).toEqual({ percent: 41, scope: 'system' });
    expect(readInteractivePressure({ cgroupRoot: join(empty, 'absent'), uid: 1000, globalFull10: 41 })).toEqual({ percent: 41, scope: 'system' });
    expect(readInteractivePressure({ cgroupRoot: cgroupRoot({ [`${M}/app.slice`]: psi(70) }), uid: 1001, globalFull10: 41 })).toEqual({ percent: 41, scope: 'system' });
    expect(readInteractivePressure({ cgroupRoot: null, uid: 1000, globalFull10: 41 })).toEqual({ percent: 41, scope: 'system' });
    expect(readInteractivePressure({ cgroupRoot: empty, uid: 1000, globalFull10: null })).toBeNull();
    expect(readInteractivePressure({ cgroupRoot: empty, uid: 1000, globalFull10: Number.NaN })).toBeNull();
  });

  test('uid invalide : jamais de chemin construit, repli', () => {
    const root = cgroupRoot({ [`${M}/app.slice`]: psi(70) });
    for (const uid of [-1, 1.5, Number.NaN]) expect(readInteractivePressure({ cgroupRoot: root, uid, globalFull10: 9 })).toEqual({ percent: 9, scope: 'system' });
  });
});
