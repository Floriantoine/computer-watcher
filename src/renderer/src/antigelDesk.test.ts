import { describe, expect, test } from 'vitest';
import type { AntigelDeskState } from '../../core/antigel/deskState';
import { sampleState } from '../../core/antigel/testFixtures';
import { antigelCard } from './antigel';
import { deskLine, deskTerminals, deskUnitLabel } from './antigelDesk';
import { DESK_ROOT_DROPINS, deskRootContent, deskRootStatus } from '../../core/antigel/deskRoot';

const desk = (o: Partial<AntigelDeskState> = {}): AntigelDeskState => ({
  status: 'active', reason: null, cpu: true, io: false, memory: 'ineffective', units: ['session.slice', 'app.slice', 'cwatch.slice'], truncated: false, restoring: 0, ...o,
});

describe('fenêtre : bureau prioritaire', () => {
  test('libellés des terminaux et de Claude', () => {
    expect(deskUnitLabel('app-dev.warp.Warp@bee3f2ded2d04c3db563057c8e73379d.service')).toBe('Warp');
    expect(deskUnitLabel('app-com.anthropic.Claude-1634688.scope')).toBe('Claude');
    expect(deskUnitLabel('app-org.kde.konsole-42.scope')).toBe('konsole');
    expect(deskUnitLabel('app-computer\\x2dwatcher-2851454.scope')).toBe('computer-watcher');
    expect(deskTerminals(desk({ units: ['session.slice', 'app.slice', 'app-dev.warp.Warp@1.service', 'app-com.anthropic.Claude@2.service', 'app-com.anthropic.Claude-3.scope'] })))
      .toEqual(['Warp', 'Claude']);
  });

  test('ligne d’état : poids, protection sans effet ou posée, E/S, éteint, indisponible ; jamais « slice »', () => {
    expect(deskLine(undefined)).toBeNull();
    expect(deskLine(desk())).toBe('Bureau prioritaire : processeur : bureau 4× et applications 3× prioritaires sur le travail · protection mémoire sans effet ici (les niveaux système au-dessus de la session n’en ont pas).');
    expect(deskLine(desk({ memory: 'on', io: true, units: ['session.slice', 'app.slice', 'app-dev.warp.Warp@1.service'] })))
      .toBe('Bureau prioritaire : processeur : bureau 4× et applications 3× prioritaires sur le travail · mémoire du bureau protégée (Warp) · disque : bureau prioritaire.');
    expect(deskLine(desk({ cpu: false, memory: 'off' }))).toMatch(/contrôleur non délégué/);
    expect(deskLine(desk({ status: 'off' }))).toBe('Bureau prioritaire éteint.');
    expect(deskLine(desk({ status: 'unavailable', reason: 'gestionnaire systemd injoignable : x' }))).toBe('Bureau prioritaire indisponible : gestionnaire systemd injoignable : x.');
    expect(deskLine(desk({ truncated: true }))).toMatch(/trop de terminaux/);
    for (const d of [desk(), desk({ memory: 'on' })]) expect(deskLine(d)).not.toMatch(/slice/);
  });

  test('carte Métriques : une ligne de plus quand le service publie le bureau prioritaire', () => {
    const lines = antigelCard({ state: sampleState({ desk: desk() }), fresh: true }).lines;
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^Bureau prioritaire : processeur/);
    expect(antigelCard({ state: sampleState(), fresh: true }).lines).toHaveLength(1);
  });

  test('ligne d’état et protection mémoire système (mise à niveau root)', () => {
    const root = (mb: number | null, low: number, target: number | null = 4771) =>
      deskRootStatus({ files: DESK_ROOT_DROPINS.map((d) => (mb === null ? null : deskRootContent(d.section, mb))), lows: [low, low, low], targetMB: target, uid: 1000, recursiveprot: true });
    expect(deskLine(desk(), root(null, 0))).toMatch(/protection mémoire sans effet ici \(les niveaux système au-dessus de la session n’en ont pas\) : « Activer » la pose au niveau système\.$/);
    expect(deskLine(desk(), root(4771, 1))).toMatch(/protection mémoire système active, prise en compte par le service sous 5 min\.$/);
    expect(deskLine(desk(), root(4771, 0))).toMatch(/protection mémoire système posée mais pas encore effective \(se reconnecter\)\.$/);
    expect(deskLine(desk({ memory: 'on' }), root(4096, 1))).toMatch(/mémoire du bureau protégée · protection système à mettre à jour \(réserve changée\)\.$/);
    expect(deskLine(desk({ memory: 'on' }), root(4771, 1))).toMatch(/mémoire du bureau protégée\.$/);
    // réserve inconnue : rien à proposer
    expect(deskLine(desk(), root(null, 0, null))).toMatch(/n’en ont pas\)\.$/);
    for (const r of [root(null, 0), root(4771, 1), root(4771, 0), root(4096, 1)]) expect(deskLine(desk(), r)).not.toMatch(/slice/);
  });
});
