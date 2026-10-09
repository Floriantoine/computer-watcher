import { describe, expect, test } from 'vitest';
import { nextVersion, parseArgs, release, tagMessage, type Run } from './release';

type Call = string;

/** Faux git/npm : réponses par commande (préfixe), journal des appels. */
function fake(o: { branch?: string; status?: string; tagExists?: boolean; testsFail?: boolean; prevTag?: string | null; log?: string } = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const run: Run = (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    if (line === 'git rev-parse --abbrev-ref HEAD') return { code: 0, stdout: `${o.branch ?? 'main'}\n` };
    if (line === 'git status --porcelain') return { code: 0, stdout: o.status ?? '' };
    if (line.startsWith('git rev-parse -q --verify refs/tags/')) return { code: o.tagExists ? 0 : 1, stdout: '' };
    if (line === 'git describe --tags --abbrev=0 --match v*') return o.prevTag ? { code: 0, stdout: `${o.prevTag}\n` } : { code: 128, stdout: '' };
    if (line.startsWith('git log')) return { code: 0, stdout: o.log ?? 'feat: une chose\nfix: une autre\nchore(release): v0.1.0\n' };
    if (line === 'npm test') return { code: o.testsFail ? 1 : 0, stdout: '' };
    return { code: 0, stdout: '' };
  };
  return { run, calls, out, log: (m: string) => out.push(m) };
}

const pkg = () => ({ version: '0.1.0' });

describe('parseArgs', () => {
  test('patch | minor | major, --dry-run', () => {
    expect(parseArgs(['patch'])).toEqual({ bump: 'patch', dryRun: false });
    expect(parseArgs(['minor', '--dry-run'])).toEqual({ bump: 'minor', dryRun: true });
    expect(() => parseArgs([])).toThrow(/patch\|minor\|major/);
    expect(() => parseArgs(['huge'])).toThrow();
    expect(() => parseArgs(['patch', '--push'])).toThrow(/--push/);
  });
});

describe('nextVersion', () => {
  test('incréments semver', () => {
    expect(nextVersion('0.1.0', 'patch')).toBe('0.1.1');
    expect(nextVersion('0.1.9', 'minor')).toBe('0.2.0');
    expect(nextVersion('1.4.2', 'major')).toBe('2.0.0');
    expect(() => nextVersion('1.0.0-beta.1', 'patch')).toThrow();
  });
});

describe('tagMessage', () => {
  test('liste des commits depuis la version précédente, sans les commits de version', () => {
    expect(tagMessage('0.1.1', 'feat: une chose\nfix: une autre\nchore(release): v0.1.0\n')).toBe('Computer Watcher v0.1.1\n\n- feat: une chose\n- fix: une autre\n');
    expect(tagMessage('0.1.1', '')).toBe('Computer Watcher v0.1.1\n');
  });
  test('jargon de revue retiré : sujets « revue », références (r1–r3), (p1–p4), (M1–M6), (B1 bis), chore/test/merge', () => {
    const subjects = [
      'fix(earlyoom): mineurs de la revue de l\'installation (M1–M6)',
      'fix(tmp): revérification par le chemin réel (r1–r3)',
      'feat(tmp): supprimer des éléments de /tmp (B1 bis)',
      'fix(tmp): quarantaine désignée par son descripteur (revue N1)',
      'chore(mesure): MEASURE_QUERIES',
      'test(tmp): marge de 30 s',
      'merge: main',
      'feat(processus): les tuiles du haut trient les groupes',
    ].join('\n');
    expect(tagMessage('0.1.2', subjects)).toBe(
      'Computer Watcher v0.1.2\n\n- fix(tmp): revérification par le chemin réel\n- feat(tmp): supprimer des éléments de /tmp\n- feat(processus): les tuiles du haut trient les groupes\n',
    );
  });
  test('première version (aucune étiquette précédente) : message rédigé, pas de liste de commits', () => {
    const m = tagMessage('0.1.0', 'fix: x (revue N1)\nfeat: y', { first: true });
    expect(m.startsWith('Computer Watcher v0.1.0\n\nPremière version publique.')).toBe(true);
    expect(m).not.toContain('revue');
    expect(m).toContain('- ');
  });
});

describe('release', () => {
  test('arbre modifié : refusé avant tout test ou écriture', () => {
    const f = fake({ status: ' M src/main/index.ts\n' });
    expect(() => release({ bump: 'patch', dryRun: false }, { run: f.run, readPkg: pkg, log: f.log })).toThrow(/non commitées/);
    expect(f.calls).not.toContain('npm test');
    expect(f.calls.some((c) => c.startsWith('git commit') || c.startsWith('git tag') || c.startsWith('npm version'))).toBe(false);
  });
  test('mauvaise branche : refusé', () => {
    const f = fake({ branch: 'feat/x' });
    expect(() => release({ bump: 'patch', dryRun: false }, { run: f.run, readPkg: pkg, log: f.log })).toThrow(/main/);
    expect(f.calls).not.toContain('npm test');
  });
  test('étiquette déjà présente : refusé', () => {
    const f = fake({ tagExists: true });
    expect(() => release({ bump: 'patch', dryRun: false }, { run: f.run, readPkg: pkg, log: f.log })).toThrow(/v0\.1\.1 existe déjà/);
  });
  test('tests en échec : rien n’est modifié', () => {
    const f = fake({ testsFail: true });
    expect(() => release({ bump: 'patch', dryRun: false }, { run: f.run, readPkg: pkg, log: f.log })).toThrow(/npm test/);
    expect(f.calls.some((c) => c.startsWith('npm version') || c.startsWith('git commit'))).toBe(false);
  });
  test('--dry-run : vérifications et tests, aucune écriture, commande de push affichée', () => {
    const f = fake();
    expect(release({ bump: 'patch', dryRun: true }, { run: f.run, readPkg: pkg, log: f.log })).toBe('0.1.1');
    expect(f.calls).toContain('npm test');
    expect(f.calls).toContain('npm run typecheck');
    expect(f.calls.some((c) => c.startsWith('npm version') || c.startsWith('git commit') || c.startsWith('git tag') || c.startsWith('git add'))).toBe(false);
    expect(f.calls.some((c) => c.startsWith('git push'))).toBe(false);
    expect(f.out.join('\n')).toContain('git push --atomic origin main v0.1.1');
    expect(f.out.join('\n')).toContain('Première version publique.');
  });
  test('réel : version, commit « chore(release): vX.Y.Z », étiquette annotée, jamais de push', () => {
    const f = fake({ prevTag: 'v0.1.0' });
    expect(release({ bump: 'minor', dryRun: false }, { run: f.run, readPkg: pkg, log: f.log })).toBe('0.2.0');
    const writes = f.calls.filter((c) => /^(npm version|git add|git commit|git tag)/.test(c));
    expect(writes).toEqual([
      'npm version 0.2.0 --no-git-tag-version',
      'git add package.json package-lock.json',
      'git commit -m chore(release): v0.2.0',
      'git tag -a v0.2.0 -m Computer Watcher v0.2.0\n\n- feat: une chose\n- fix: une autre\n',
    ]);
    expect(f.calls).toContain('git log --no-merges --pretty=format:%s v0.1.0..HEAD');
    expect(f.calls.some((c) => c.startsWith('git push'))).toBe(false);
    expect(f.out.join('\n')).toContain('git push --atomic origin main v0.2.0');
  });
});
