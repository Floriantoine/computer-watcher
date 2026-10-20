// IPC `antigel:state` : lecture bornée de l'état écrit par le service. Le main n'appelle jamais busctl.
import { antigelView, type AntigelView } from '../core/antigel/state';
import { readStateFileBounded } from '../core/antigel/stateFile';
import { antigelStatePath } from '../core/paths';

export function readAntigelView(dataDir: string, now: number, intervalSec: number): AntigelView {
  let text: string | null = null;
  try {
    text = readStateFileBounded(antigelStatePath(dataDir));
  } catch {
    text = null;
  }
  return antigelView(text, now, intervalSec);
}
