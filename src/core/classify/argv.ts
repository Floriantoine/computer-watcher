const INTERPRETERS = /^(node|nodejs|python[\d.]*|ruby)$/;

/** Options d'interpréteur qui consomment l'argument suivant (hors -m, dont la valeur est le programme). */
export const VALUE_OPTIONS: ReadonlySet<string> = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-e', '--eval', '-p', '--print', '-m']);
export const isInterpreter = (bin: string): boolean => INTERPRETERS.test(bin);

export const baseName = (s: string): string => {
  const t = s.replace(/\/+$/, '');
  const i = t.lastIndexOf('/');
  return i >= 0 ? t.slice(i + 1) : t;
};

/** Découpe une cmdline sur les espaces (les cmdline sont déjà jointes par espaces). */
export const splitArgs = (cmdline: string): string[] => cmdline.split(/\s+/).filter(Boolean);

/** Index du programme « significatif » : saute les interpréteurs et leurs options. */
export function programIndex(argv: string[]): number {
  if (argv.length === 0) return -1;
  if (!INTERPRETERS.test(argv[0])) return 0;
  for (let i = 1; i < argv.length; i++) {
    if (VALUE_OPTIONS.has(argv[i]) && !(argv[i] === '-m')) { i++; continue; }
    if (!argv[i].startsWith('-')) return i;
  }
  return 0;
}
