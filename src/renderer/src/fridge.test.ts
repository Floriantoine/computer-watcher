import { describe, expect, test } from 'vitest';
import { sampleState } from '../../core/antigel/testFixtures';
import { antigelCard, antigelMarks, sameMark } from './antigel';
import { fridgeBadgeText, fridgeCardLine, fridgeDetailLine, fridgeEntry, newFridgeNotice } from './fridge';

const E = { unit: 'cwatch-p-alpha.slice', root: '/home/u/alpha', since: new Date(2026, 9, 20, 14, 5).getTime(), phase: 'frozen' as const, reclaimedKB: 2 * 1024 * 1024 };
const fresh = (o = {}) => ({ state: sampleState(o), fresh: true });

describe('fenêtre : frigo', () => {
  test('marque « au frigo » du projet, comparée par sameMark ; rien si l’état est vieux', () => {
    const v = fresh({ fridge: [E] });
    expect(antigelMarks(v).get('project:/home/u/alpha')).toEqual({ throttled: false, budgetMB: null, frozen: 'frozen' });
    expect(antigelMarks(fresh()).get('project:/home/u/alpha')).toEqual({ throttled: false, budgetMB: null });
    expect(sameMark({ throttled: false, budgetMB: null, frozen: 'frozen' }, { throttled: false, budgetMB: null })).toBe(false);
    expect(fridgeEntry(v, '/home/u/alpha')).toEqual(E);
    expect(fridgeEntry({ ...v, fresh: false }, '/home/u/alpha')).toBeNull();
    expect(fridgeEntry(v, null)).toBeNull();
  });

  test('textes : badge, détail, carte Métriques', () => {
    expect(fridgeBadgeText('freezing')).toBe('mise au frigo…');
    expect(fridgeBadgeText('reclaiming')).toBe('au frigo');
    expect(fridgeBadgeText('thawing')).toBe('réveil…');
    expect(fridgeDetailLine(E)).toMatch(/^Au frigo depuis 14:05 · ≈ 2(,0)? Go sortis de la RAM\. /);
    expect(fridgeDetailLine({ ...E, reclaimedKB: 0 })).toMatch(/^Au frigo depuis 14:05\. /);
    expect(fridgeCardLine(fresh({ fridge: [E, { ...E, unit: 'cwatch-p-beta.slice', root: '/home/u/beta' }] }))).toMatch(/^2 projets au frigo · ≈ 4(,0)? Go sortis de la RAM$/);
    expect(fridgeCardLine(fresh())).toBeNull();
    expect(antigelCard(fresh({ fridge: [E] })).lines.at(-1)).toMatch(/^1 projet au frigo/);
  });

  test('notices : seulement celles arrivées après la première lecture', () => {
    const v = fresh({ fridgeNotice: { root: '/home/u/alpha', text: '« alpha » au frigo', ok: true, at: 50 } });
    expect(newFridgeNotice(v, null)).toBeNull();
    expect(newFridgeNotice(v, 50)).toBeNull();
    expect(newFridgeNotice(v, 10)).toEqual({ text: '« alpha » au frigo', ok: true, at: 50 });
  });
});
