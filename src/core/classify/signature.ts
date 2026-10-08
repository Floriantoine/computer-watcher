import type { CommandMatch } from './match';
import { baseName, isInterpreter, splitArgs, VALUE_OPTIONS } from './argv';

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
  const interp = isInterpreter(bin);
  let first: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      if (interp) {
        if (a === '-m') { first = args[i + 1]; break; }
        if (VALUE_OPTIONS.has(a)) i++;
      } else if (!a.includes('=') && i + 1 < args.length && /^(\d+|.*[./].*)$/.test(args[i + 1]) && !args[i + 1].startsWith('-')) {
        i++; // valeur d'option (nombre, fichier, chemin)
      }
      continue;
    }
    first = a;
    break;
  }
  if (first === undefined) return bin;
  const reduced = reducePath(first, projectRoot);
  if (!reduced || /^\d+$/.test(reduced)) return bin;
  return SCRIPT_LIKE.some((re) => re.test(reduced)) ? `${bin} ${reduced}` : bin;
}
