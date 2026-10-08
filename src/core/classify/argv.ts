const INTERPRETERS = /^(node|nodejs|python[\d.]*|bun|deno|ruby|php)$/;

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
    if (!argv[i].startsWith('-')) return i;
  }
  return 0;
}
