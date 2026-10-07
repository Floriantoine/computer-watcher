export interface Protection {
  isProtected(name: string): boolean;
  invalid: string[];
}

/** Une entrée est un nom exact, ou une regex écrite entre slashs : /^systemd/ */
export function compileProtection(entries: string[]): Protection {
  const exact = new Set<string>();
  const regexes: RegExp[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    const m = entry.match(/^\/(.+)\/$/);
    if (!m) {
      exact.add(entry);
      continue;
    }
    try {
      regexes.push(new RegExp(m[1]));
    } catch {
      invalid.push(entry);
    }
  }
  return { isProtected: (name) => exact.has(name) || regexes.some((r) => r.test(name)), invalid };
}
