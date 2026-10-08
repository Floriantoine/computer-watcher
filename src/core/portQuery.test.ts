import { describe, expect, it } from 'vitest';
import { parsePortQuery } from './portQuery';

describe('parsePortQuery', () => {
  it('« :port » et « port:port », espaces et casse ignorés', () => {
    expect(parsePortQuery(':3000')).toBe(3000);
    expect(parsePortQuery('port:3000')).toBe(3000);
    expect(parsePortQuery(' :3000 ')).toBe(3000);
    expect(parsePortQuery('Port:8080')).toBe(8080);
    expect(parsePortQuery('PORT:3000')).toBe(3000);
    expect(parsePortQuery(':65535')).toBe(65535);
    expect(parsePortQuery(':1')).toBe(1);
  });
  it('hors bornes, incomplet, texte libre ou mélangé → null (recherche normale)', () => {
    for (const q of [':0', ':65536', ':30a', 'port:', ':', '3000', ':3000 vite', '', 'vite', ':-1', ':3000.5', ': 3000', ':0003000000'])
      expect(parsePortQuery(q)).toBeNull();
  });
});
