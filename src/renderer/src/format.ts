export function formatKB(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / (1024 * 1024)).toFixed(1).replace('.', ',')} Go`;
  if (kb >= 1024) return `${Math.round(kb / 1024)} Mo`;
  return `${kb} Ko`;
}

export function formatAge(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h`;
  return `${Math.floor(sec / 86400)} j`;
}

export function formatCpu(p: number): string {
  return `${Math.round(p)} %`;
}
