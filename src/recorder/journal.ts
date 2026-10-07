// src/recorder/journal.ts
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Suit les messages d'earlyoom ; onState('unavailable') si journalctl est absent ou s'arrête. */
export function followEarlyoom(onLine: (line: string) => void, onState: (s: 'ok' | 'unavailable') => void): () => void {
  let stopped = false;
  const child = spawn('journalctl', ['-u', 'earlyoom', '-f', '-o', 'json', '-n', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.on('error', () => onState('unavailable'));
  child.on('spawn', () => onState('ok'));
  child.on('exit', () => {
    if (!stopped) onState('unavailable');
  });
  createInterface({ input: child.stdout }).on('line', onLine);
  return () => {
    stopped = true;
    child.kill();
  };
}
