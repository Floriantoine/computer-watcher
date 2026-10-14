import { describe, expect, test } from 'vitest';
import { anonymousVolumes, dockerPruneArgs, isDockerAction, parseDockerSize, parseJsonLines, reclaimByAction, stoppedContainers, unusedImages } from './docker';

const VOL = 'a'.repeat(64);

describe('docker (pur)', () => {
  test('argv figés (jamais system prune, jamais --volumes)', () => {
    expect(dockerPruneArgs('images')).toEqual(['image', 'prune', '-a', '-f']);
    expect(dockerPruneArgs('containers')).toEqual(['container', 'prune', '-f']);
    expect(dockerPruneArgs('volumes')).toEqual(['volume', 'prune', '-f']);
    expect(isDockerAction('system')).toBe(false);
  });
  test('tailles décimales de docker → Ko', () => {
    expect(parseDockerSize('0B')).toBe(0);
    expect(parseDockerSize('1.5kB')).toBe(1);
    expect(parseDockerSize('12.3MB')).toBe(Math.round(12.3e6 / 1024));
    expect(parseDockerSize('1.2GB (37%)')).toBe(Math.round(1.2e9 / 1024));
    expect(parseDockerSize('beaucoup')).toBeNull();
  });
  test('lignes JSON : lignes invalides ignorées sans exception', () => {
    expect(parseJsonLines('{"a":1}\npas du json\n[1]\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
  test('place récupérable par action (docker system df)', () => {
    const df = parseJsonLines([
      '{"Type":"Images","TotalCount":"5","Active":"2","Size":"3GB","Reclaimable":"1.2GB (40%)"}',
      '{"Type":"Containers","TotalCount":"3","Active":"1","Size":"20MB","Reclaimable":"10MB (50%)"}',
      '{"Type":"Local Volumes","TotalCount":"2","Active":"1","Size":"500MB","Reclaimable":"???"}',
    ].join('\n'));
    expect(reclaimByAction(df)).toEqual({ images: Math.round(1.2e9 / 1024), containers: Math.round(10e6 / 1024), volumes: null });
  });
  test('images inutilisées : aucune conteneur (même arrêté) ne s’en sert', () => {
    const images = [
      { Repository: 'demo/web', Tag: '1.0', ID: 'aaa111', Size: '120MB' },
      { Repository: 'demo/base', Tag: 'latest', ID: 'bbb222', Size: '80MB' },
      { Repository: 'demo/old', Tag: '0.9', ID: 'ccc333', Size: '300MB' },
      { Repository: '<none>', Tag: '<none>', ID: 'ddd444', Size: '50MB' },
    ];
    const containers = [{ Image: 'demo/web:1.0', State: 'running' }, { Image: 'demo/base', State: 'exited' }];
    expect(unusedImages(images, containers)).toEqual(['demo/old:0.9 (300MB)', '<sans nom> ddd444 (50MB)']);
  });
  test('conteneurs arrêtés ; volumes anonymes (les nommés sont gardés par docker volume prune)', () => {
    expect(stoppedContainers([
      { Names: 'web-1', Image: 'demo/web:1.0', State: 'running', Status: 'Up 2 hours' },
      { Names: 'vieux-1', Image: 'demo/web:1.0', State: 'exited', Status: 'Exited (0) 3 weeks ago' },
      { Names: 'neuf-1', Image: 'demo/base', State: 'created', Status: 'Created' },
    ])).toEqual(['vieux-1 (demo/web:1.0, Exited (0) 3 weeks ago)', 'neuf-1 (demo/base, Created)']);
    expect(anonymousVolumes([{ Name: VOL }, { Name: 'donnees' }])).toEqual({ anonymous: [VOL], named: 1 });
  });
});
