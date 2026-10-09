// `npm run release -- patch|minor|major [--dry-run]` : prépare une version localement, ne pousse jamais.
// Fichier autonome (imports node: seulement, syntaxe TypeScript effaçable) : exécuté directement par Node (scripts/release.mjs).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type Bump = 'patch' | 'minor' | 'major';
export interface ReleaseArgs { bump: Bump; dryRun: boolean }
export type Run = (cmd: string, args: string[], opts?: { inherit?: boolean }) => { code: number; stdout: string; stderr?: string };

const BUMPS: readonly string[] = ['patch', 'minor', 'major'];
const USAGE = 'Usage : npm run release -- patch|minor|major [--dry-run]';

export function parseArgs(argv: string[]): ReleaseArgs {
  let bump: Bump | null = null;
  let dryRun = false;
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true;
    else if (BUMPS.includes(a) && !bump) bump = a as Bump;
    else throw new Error(`Argument inconnu : ${a}\n${USAGE}`);
  }
  if (!bump) throw new Error(USAGE);
  return { bump, dryRun };
}

export function nextVersion(current: string, bump: Bump): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) throw new Error(`Version actuelle non prise en charge : ${current} (attendu X.Y.Z)`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

/** Message de l'étiquette annotée (repris comme notes de la version GitHub par le workflow release). */
export function tagMessage(version: string, subjects: string): string {
  const lines = subjects
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('chore(release)'));
  return `proc-watch v${version}\n${lines.length ? `\n${lines.map((s) => `- ${s}`).join('\n')}\n` : ''}`;
}

export function release(args: ReleaseArgs, d: { run: Run; readPkg: () => { version: string }; log: (m: string) => void }): string {
  const git = (...a: string[]) => d.run('git', a);
  const must = (cmd: string, a: string[], what: string, inherit = false) => {
    const r = d.run(cmd, a, { inherit });
    if (r.code !== 0) throw new Error(`Échec de ${what} (${[cmd, ...a].join(' ')})${r.stderr ? ` :\n${r.stderr.trim()}` : ''}`);
    return r.stdout;
  };

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  if (branch !== 'main') throw new Error(`Branche actuelle : ${branch}. Une version se prépare depuis main.`);
  const status = git('status', '--porcelain').stdout;
  if (status.trim()) throw new Error(`Modifications non commitées :\n${status}Commiter ou mettre de côté avant de préparer une version.`);

  const version = nextVersion(d.readPkg().version, args.bump);
  const tag = `v${version}`;
  if (git('rev-parse', '-q', '--verify', `refs/tags/${tag}`).code === 0) throw new Error(`L'étiquette ${tag} existe déjà.`);

  d.log(`Version ${d.readPkg().version} → ${version}${args.dryRun ? ' (essai : rien ne sera modifié)' : ''}`);
  d.log('Tests…');
  must('npm', ['test'], 'npm test', true);
  d.log('Vérification des types…');
  must('npm', ['run', 'typecheck'], 'npm run typecheck', true);

  const prev = git('describe', '--tags', '--abbrev=0', '--match', 'v*');
  const range = prev.code === 0 ? [`${prev.stdout.trim()}..HEAD`] : ['-n', '30', 'HEAD'];
  const message = tagMessage(version, git('log', '--no-merges', '--pretty=format:%s', ...range).stdout);
  const push = `git push --atomic origin main ${tag}`;

  if (args.dryRun) {
    d.log(`\nSeraient exécutés :\n  npm version ${version} --no-git-tag-version\n  git commit -m "chore(release): ${tag}"\n  git tag -a ${tag}`);
    d.log(`\nMessage de l'étiquette (notes de la version) :\n${message}`);
    d.log(`Puis, à lancer soi-même pour publier :\n  ${push}`);
    return version;
  }

  must('npm', ['version', version, '--no-git-tag-version'], 'la mise à jour de la version');
  must('git', ['add', 'package.json', 'package-lock.json'], 'git add');
  must('git', ['commit', '-m', `chore(release): ${tag}`], 'git commit');
  must('git', ['tag', '-a', tag, '-m', message], "la création de l'étiquette");
  d.log(`\nVersion ${tag} prête localement (commit et étiquette annotée). Rien n'a été poussé.`);
  d.log(`Pour publier (le workflow « release » construit l'AppImage, le .deb et latest-linux.yml) :\n  ${push}`);
  d.log(`Pour annuler avant de pousser :\n  git tag -d ${tag} && git reset --hard HEAD~1`);
  return version;
}

export const defaultRun: Run = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: opts?.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export function main(argv: string[]): number {
  try {
    const args = parseArgs(argv);
    release(args, { run: defaultRun, readPkg: () => JSON.parse(readFileSync('package.json', 'utf8')), log: (m) => console.log(m) });
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
