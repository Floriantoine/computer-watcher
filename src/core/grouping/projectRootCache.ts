import { findProjectRoot } from './projectRoot';

export function createProjectRootCache(find: (cwd: string) => string | null = findProjectRoot, max = 5000) {
  const cache = new Map<string, string | null>();
  return (cwd: string): string | null => {
    if (cache.has(cwd)) return cache.get(cwd)!;
    if (cache.size >= max) cache.clear();
    const root = find(cwd);
    cache.set(cwd, root);
    return root;
  };
}
