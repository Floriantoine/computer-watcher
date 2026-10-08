import { describe, expect, it } from 'vitest';
import { categoryForPorts } from './portRules';

describe('categoryForPorts', () => {
  it.each([[5173, 'front'], [5174, 'front'], [4200, 'front'], [3001, 'front'],
    [5432, 'db'], [6379, 'db'], [3306, 'db'], [27017, 'db'], [7700, 'db'], [9200, 'db'],
    [4000, 'back'], [5000, 'back'], [8000, 'back'], [8080, 'back'], [8081, 'back'], [9000, 'back']])('port %i -> %s', (p, c) => {
    expect(categoryForPorts([p], '')).toBe(c);
  });
  it('3000 : front avec next/react-scripts, sinon back', () => {
    expect(categoryForPorts([3000], 'node next dev')).toBe('front');
    expect(categoryForPorts([3000], 'react-scripts start')).toBe('front');
    expect(categoryForPorts([3000], 'node server.js')).toBe('back');
  });
  it('port inconnu ou vide -> null', () => {
    expect(categoryForPorts([1234], '')).toBeNull();
    expect(categoryForPorts([], 'x')).toBeNull();
  });
});
