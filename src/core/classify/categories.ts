export const CATEGORIES = ['front', 'back', 'db', 'worker', 'test', 'build', 'container', 'browser', 'ai', 'system', 'unknown'] as const;
export type Category = (typeof CATEGORIES)[number];
export const isCategory = (v: unknown): v is Category => typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v);
export const DUPLICATE_CATEGORIES: ReadonlySet<Category> = new Set<Category>(['front', 'back', 'worker', 'db']);
