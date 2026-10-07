export interface StatFields {
  ppid: number;
  utime: number;
  stime: number;
  starttime: number;
}

/** Les champs après le nom commencent après la DERNIÈRE ')' : le nom peut contenir espaces et parenthèses. */
export function parseStat(content: string): StatFields {
  const close = content.lastIndexOf(')');
  if (close < 0) throw new Error('stat malformé');
  const f = content.slice(close + 1).trim().split(/\s+/);
  // f[0] = état (champ 3 de proc(5)), donc champ N = f[N - 3]
  return { ppid: Number(f[1]), utime: Number(f[11]), stime: Number(f[12]), starttime: Number(f[19]) };
}

export interface StatusFields {
  name: string;
  uid: number;
  rssKB: number;
  swapKB: number;
}

function field(content: string, key: string): string | undefined {
  const m = content.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return m ? m[1] : undefined;
}

export function parseStatus(content: string): StatusFields {
  return {
    name: field(content, 'Name') ?? '',
    uid: Number((field(content, 'Uid') ?? '-1').split(/\s+/)[0]),
    rssKB: parseInt(field(content, 'VmRSS') ?? '0', 10),
    swapKB: parseInt(field(content, 'VmSwap') ?? '0', 10),
  };
}

export function parseCmdline(raw: string): string {
  return raw.split('\0').filter(Boolean).join(' ');
}

export function parseMeminfo(content: string) {
  const kb = (key: string) => parseInt(field(content, key) ?? '0', 10);
  return {
    memTotalKB: kb('MemTotal'),
    memAvailableKB: kb('MemAvailable'),
    swapTotalKB: kb('SwapTotal'),
    swapFreeKB: kb('SwapFree'),
  };
}

export function parseLoadavg(content: string): number {
  return parseFloat(content.split(/\s+/)[0]);
}

export function parsePsiSome10(content: string): number | null {
  const m = content.match(/^some avg10=([\d.]+)/m);
  return m ? parseFloat(m[1]) : null;
}
