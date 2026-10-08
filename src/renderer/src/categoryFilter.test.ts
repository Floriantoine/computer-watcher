import { describe, expect, test } from 'vitest';
import type { Category, GroupSummary, InstanceSummary } from '../../core/types';
import { categoryDisplayKey, countByCategory, filterGroups, instancesLine, killCount, parseSelection, pillCategories, pillLabel, primaryTag, selectionCandidates, showKillSelection, showProjectsOnlyHint } from './categoryFilter';

let n = 0;
const inst = (category: Category, extra: Partial<InstanceSummary> = {}): InstanceSummary => {
  n++;
  return {
    key: `k${n}`, groupId: 'g', project: '/p', category, source: 'command', signature: 'x', label: 'x', rootPid: 100 + n, rootStartTicks: n,
    pids: [100 + n], ports: [], ageSec: 100, rssKB: 1000, swapKB: 0, cpuPercent: 0, duplicate: false, protected: false, ...extra,
  };
};
const grp = (id: string, instances: InstanceSummary[], extra: Partial<GroupSummary> = {}): GroupSummary => {
  const categories = [...new Set(instances.map((i) => i.category))];
  return {
    id, kind: 'project', label: id, tags: [], rootName: 'node', pids: instances.flatMap((i) => i.pids), procCount: instances.length,
    cpuPercent: 0, rssKB: 0, swapKB: 0, oldestAgeSec: 0, protected: false, killable: true, subgroups: [], categories, instances, ...extra,
  };
};

const shop = grp('shop', [inst('front', { ports: [5173] }), inst('back', { ports: [3000] }), inst('back', { ports: [3001], duplicate: true })]);
const blog = grp('blog', [inst('front', { ports: [5174] }), inst('db', { ports: [5432], protected: true })]);
const chrome = grp('chrome', [inst('browser')], { kind: 'app' });
const others = grp('others', [], { kind: 'others', categories: ['front'], subgroups: [grp('o1', [inst('front')])] });
const all = [shop, blog, chrome, others];

describe('countByCategory', () => {
  test('compte les instances par catégorie, « Autres » exclu', () => {
    const c = countByCategory(all);
    expect(c.get('front')).toBe(2);
    expect(c.get('back')).toBe(2);
    expect(c.get('db')).toBe(1);
    expect(c.get('browser')).toBe(1);
    expect(c.has('test')).toBe(false);
  });
});

describe('filterGroups', () => {
  test('sélection vide = tout (même tableau)', () => {
    expect(filterGroups(all, new Set())).toBe(all);
  });
  test('garde un groupe si une de ses catégories est sélectionnée', () => {
    expect(filterGroups(all, new Set<Category>(['db'])).map((g) => g.id)).toEqual(['blog']);
    expect(filterGroups(all, new Set<Category>(['back', 'browser'])).map((g) => g.id)).toEqual(['shop', 'chrome']);
  });
  test('« Autres » n\'est jamais retenu par un filtre', () => {
    expect(filterGroups(all, new Set<Category>(['front'])).map((g) => g.id)).toEqual(['shop', 'blog']);
  });
});

describe('selectionCandidates (« Tuer la sélection »)', () => {
  test('instances des catégories sélectionnées des groupes projet et dossier supprimé, protégées comprises (le dialogue les décoche)', () => {
    const c = selectionCandidates(all, new Set<Category>(['front', 'db']));
    expect(c.map((i) => [i.ports[0], i.protected])).toEqual([[5173, false], [5174, false], [5432, true]]);
    expect(killCount(c)).toBe(2);
  });
  test('autres sortes de groupes (appli, Claude, commande) : visibles sous le filtre mais jamais visées', () => {
    const sel = new Set<Category>(['browser', 'system', 'ai']);
    const claude = grp('claude', [inst('ai')], { kind: 'claude' });
    const sys = grp('command:pipewire', [inst('system')], { kind: 'command' });
    expect(filterGroups([chrome, claude, sys], sel).map((g) => g.id)).toEqual(['chrome', 'claude', 'command:pipewire']);
    expect(selectionCandidates([chrome, claude, sys], sel)).toEqual([]);
    const gone = grp('deleted', [inst('front', { ports: [5173] })], { kind: 'deleted' });
    expect(selectionCandidates([gone, chrome], new Set<Category>(['front', 'browser'])).map((i) => i.ports[0])).toEqual([5173]);
  });
  test('sélection vide → aucune ; groupes sans processus du user et « Autres » ignorés', () => {
    expect(selectionCandidates(all, new Set())).toEqual([]);
    const foreign = grp('root', [inst('db')], { killable: false });
    expect(selectionCandidates([foreign, others], new Set<Category>(['db', 'front']))).toEqual([]);
  });
});

describe('règles d\'affichage de la barre', () => {
  test('bouton « Tuer la sélection » : seulement avec un filtre actif et au moins une cible non protégée', () => {
    expect(showKillSelection(new Set(), 3)).toBe(false);
    expect(showKillSelection(new Set<Category>(['front']), 0)).toBe(false);
    expect(showKillSelection(new Set<Category>(['front']), 1)).toBe(true);
  });
  test('pastilles : catégories présentes, plus une catégorie sélectionnée tombée à 0 (pour pouvoir la retirer), dans l\'ordre', () => {
    const counts = new Map<Category, number>([['db', 1], ['front', 2]]);
    expect(pillCategories(counts, new Set())).toEqual(['front', 'db']);
    expect(pillCategories(counts, new Set<Category>(['test']))).toEqual(['front', 'db', 'test']);
    expect(pillCategories(new Map(), new Set())).toEqual([]);
  });
  test('indication « ne vise que les projets » : filtre actif sans aucune instance de projet candidate', () => {
    expect(showProjectsOnlyHint(new Set(), [])).toBe(false);
    expect(showProjectsOnlyHint(new Set<Category>(['db']), [])).toBe(true);
    expect(showProjectsOnlyHint(new Set<Category>(['db']), selectionCandidates(all, new Set<Category>(['db'])))).toBe(false);
    expect(showProjectsOnlyHint(new Set<Category>(['browser']), selectionCandidates(all, new Set<Category>(['browser'])))).toBe(true);
  });
  test('nom accessible d\'une pastille', () => {
    expect(pillLabel('front', 1)).toBe('Front, 1 instance');
    expect(pillLabel('db', 0)).toBe('BDD, 0 instance');
    expect(pillLabel('test', 3)).toBe('Tests, 3 instances');
  });
});

describe('primaryTag', () => {
  test('catégorie la plus significative avec son port principal', () => {
    expect(primaryTag(shop)).toEqual({ category: 'front', port: 5173 });
    expect(primaryTag(grp('api', [inst('back', { ports: [9229, 3000] })]))).toEqual({ category: 'back', port: 3000 });
  });
  test('une instance avec port l\'emporte à catégorie égale', () => {
    expect(primaryTag(grp('x', [inst('back'), inst('back', { ports: [8000] })]))).toEqual({ category: 'back', port: 8000 });
  });
  test('à catégorie égale, l\'instance d\'origine l\'emporte sur le doublon', () => {
    expect(primaryTag(grp('x', [inst('back', { ports: [5000], duplicate: true }), inst('back', { ports: [4000] })]))).toEqual({ category: 'back', port: 4000 });
  });
  test('sans instance ou seulement inconnue → null', () => {
    expect(primaryTag(grp('x', []))).toBeNull();
    expect(primaryTag(grp('x', [inst('unknown')]))).toBeNull();
    expect(primaryTag(chrome)).toEqual({ category: 'browser', port: null });
  });
});

describe('instancesLine', () => {
  test('résumé par catégorie avec ports', () => {
    expect(instancesLine(shop)).toBe('1 front :5173 · 2 back :3000 :3001');
    expect(instancesLine(grp('w', [inst('front', { ports: [5173] }), inst('worker')]))).toBe('1 front :5173 · 1 worker');
  });
  test('inconnues sans port masquées ; une inconnue qui écoute reste ; rien → ligne vide', () => {
    expect(instancesLine(grp('x', [inst('front', { ports: [5173] }), inst('unknown')]))).toBe('1 front :5173');
    expect(instancesLine(grp('x', [inst('unknown'), inst('unknown', { ports: [7000] })]))).toBe('1 inconnu :7000');
    expect(instancesLine(grp('x', [inst('unknown')]))).toBe('');
  });
  test('au plus 2 ports affichés par catégorie ; vide sans instance', () => {
    // port principal = le plus petit port de chaque instance
    expect(instancesLine(grp('x', [inst('front', { ports: [2, 1] }), inst('front', { ports: [3] }), inst('front', { ports: [4] })]))).toBe('3 front :1 :3 …');
    expect(instancesLine(grp('x', [inst('db', { ports: [5432] }), inst('unknown', { ports: [7000] })]))).toBe('1 BDD :5432 · 1 inconnu :7000');
    expect(instancesLine(grp('x', []))).toBe('');
  });
});

describe('categoryDisplayKey', () => {
  test('stable si rien d\'affiché ne change, différent sinon', () => {
    const a = grp('x', [inst('front', { ports: [5173], rssKB: 1 })]);
    const b = { ...a, instances: a.instances.map((i) => ({ ...i, rssKB: 99, cpuPercent: 5 })) };
    expect(categoryDisplayKey(a)).toBe(categoryDisplayKey(b));
    const c = { ...a, instances: a.instances.map((i) => ({ ...i, duplicate: true })) };
    const d = { ...a, instances: a.instances.map((i) => ({ ...i, ports: [5174] })) };
    expect(categoryDisplayKey(c)).not.toBe(categoryDisplayKey(a));
    expect(categoryDisplayKey(d)).not.toBe(categoryDisplayKey(a));
  });
});

describe('parseSelection (localStorage)', () => {
  test('ne garde que les catégories connues', () => {
    expect([...parseSelection('["front","nope","db",3]')]).toEqual(['front', 'db']);
    expect(parseSelection('pas du json').size).toBe(0);
    expect(parseSelection(null).size).toBe(0);
    expect(parseSelection('{"a":1}').size).toBe(0);
  });
});

test('groupe hors projet reclassé « Back » depuis l\'en-tête : reste hors du kill groupé', () => {
  const gitstatusd = grp('command:gitstatusd', [inst('back', { source: 'manual', groupId: 'command:gitstatusd', project: null })], { kind: 'command' });
  expect(selectionCandidates([gitstatusd], new Set<Category>(['back']))).toEqual([]);
  expect(selectionCandidates([shop, gitstatusd], new Set<Category>(['back'])).every((i) => i.groupId !== 'command:gitstatusd')).toBe(true);
});
