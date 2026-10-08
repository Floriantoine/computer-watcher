import { describe, expect, it } from 'vitest';
import { portModes } from './portModes';

describe('portModes', () => {
  const w = (query: string, ports?: boolean) => ({ groupId: null, query, ports });
  it('« Détecter les ports » coupé : le classement ne lit aucun port, mais la recherche :port et le panneau lisent toujours', () => {
    expect(portModes({ detectPorts: false, watch: w(':3000'), visible: true })).toEqual({ classify: false, sweep: true });
    expect(portModes({ detectPorts: false, watch: w('', true), visible: true })).toEqual({ classify: false, sweep: true });
    expect(portModes({ detectPorts: false, watch: w('vite'), visible: true })).toEqual({ classify: false, sweep: false });
  });
  it('réglage actif : classement ; lecture de tous les ports seulement panneau ouvert ou recherche :port', () => {
    expect(portModes({ detectPorts: true, watch: w(''), visible: true })).toEqual({ classify: true, sweep: false });
    expect(portModes({ detectPorts: true, watch: w('port:22'), visible: true })).toEqual({ classify: true, sweep: true });
  });
  it('fenêtre cachée ou réduite : jamais de lecture de tous les ports (un watch reçu caché n\'en lance pas)', () => {
    expect(portModes({ detectPorts: true, watch: w(':3000', true), visible: false })).toEqual({ classify: true, sweep: false });
  });
});
