// Anti-gel (lot 3) : fichier de demandes « frigo » / « réveiller » entre le main (qui écrit) et le service (qui prend).
// Le main n'appelle jamais busctl : il dépose une demande validée, le service la prend à son tick suivant et revalide tout.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeFridgeRequests, parseFridgeRequests, type FridgeRequest } from './fridgeState';
import { readStateFileBounded } from './stateFile';

/** Demandes plus vieilles (service arrêté au moment du clic) : ignorées, jamais un gel surprise au redémarrage. */
export const REQUEST_MAX_AGE_MS = 120_000;

export const fridgeRequestPath = (dataDir: string) => join(dataDir, 'antigel-fridge-request.json');

const readList = (path: string): FridgeRequest[] => {
  try {
    return parseFridgeRequests(readStateFileBounded(path));
  } catch {
    return [];
  }
};

/**
 * Main : ajoute une demande (une par racine, la dernière gagne) ; fichier 0600 écrit à côté puis renommé. Une course avec
 * la prise du service peut rejouer une demande déjà prise : sans effet, geler et réveiller sont idempotents.
 */
export function writeFridgeRequest(dataDir: string, r: FridgeRequest): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const p = fridgeRequestPath(dataDir);
  const list = mergeFridgeRequests(readList(p), r);
  const tmp = `${p}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, requests: list }), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, p);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Service : prise atomique (renommage), lecture bornée sans suivre de lien, suppression ; seules les demandes récentes
 * (moins de 2 min, pas plus de 5 s dans le futur) sont rendues. Aucune demande : [] (un seul renommage en échec, coût nul).
 */
export function takeFridgeRequests(dataDir: string, now: number): FridgeRequest[] {
  const p = fridgeRequestPath(dataDir);
  const taking = `${p}.${process.pid}.taking`;
  try {
    renameSync(p, taking);
  } catch {
    return [];
  }
  const list = readList(taking);
  rmSync(taking, { force: true });
  return list.filter((r) => r.at - now <= 5000 && now - r.at <= REQUEST_MAX_AGE_MS);
}
