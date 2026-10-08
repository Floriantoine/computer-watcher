import type { CommandMatch } from './match';
import { baseName, splitArgs } from './argv';

const INTERP = /^(node|nodejs|python[\d.]*|bun|deno|ruby|php)$/;
const SCRIPT_LIKE = [/\.(m?js|cjs|ts|py)$/, /^[\w.]+:\w+$/, /^[a-z][a-z-]*$/];

function reducePath(arg: string, projectRoot?: string | null): string {
  let a = arg;
  if (projectRoot) {
    const root = projectRoot.replace(/\/+$/, '');
    if (a.startsWith(root + '/')) a = a.slice(root.length + 1);
  }
  if (a.startsWith('./')) a = a.slice(2);
  if (a.startsWith('/')) a = baseName(a);
  return a.replace(/:\d+$/, '');
}

/** Motif de commande normalisé : clé de correction manuelle. */
export function signatureOf(
  chain: { name: string; cmdline: string }[],
  match: CommandMatch | null,
  projectRoot?: string | null,
): string {
  if (match) return match.label;
  const root = chain[0];
  if (!root) return '';
  const argv = splitArgs(root.cmdline);
  if (argv.length === 0) return root.name;
  const bin = baseName(argv[0]).replace(/:$/, '') || root.name;
  const args = argv.slice(1);
  let i = 0;
  // pour un interpréteur, saute les options (-m, --inspect…) ; sinon premier argument tel quel
  while (i < args.length && args[i].startsWith('-')) i++;
  const first = args[i];
  if (first === undefined || /^\d+$/.test(first)) return bin;
  const reduced = INTERP.test(bin) || !first.startsWith('-') ? reducePath(first, projectRoot) : '';
  if (!reduced || /^\d+$/.test(reduced)) return bin;
  return SCRIPT_LIKE.some((re) => re.test(reduced)) ? `${bin} ${reduced}` : bin;
}
