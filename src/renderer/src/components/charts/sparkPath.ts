export function sparkPath(values: (number | null)[], w: number, h: number, min?: number, max?: number): { line: string; area: string } {
  const pts = values.flatMap((v, i) => (v === null ? [] : [[i, v] as [number, number]]));
  if (pts.length === 0) return { line: '', area: '' };
  const lo = min ?? Math.min(...pts.map(([, v]) => v));
  const hi = max ?? Math.max(...pts.map(([, v]) => v));
  const n = Math.max(1, values.length - 1);
  const x = (i: number) => +((i / n) * w).toFixed(1);
  const y = (v: number) => (hi === lo ? h / 2 : +(h - ((v - lo) / (hi - lo)) * h).toFixed(1));
  let line = '';
  let prev = -2;
  for (const [i, v] of pts) {
    line += `${i === prev + 1 ? 'L' : 'M'}${x(i)},${y(v)}`;
    prev = i;
  }
  const first = pts[0][0];
  const last = pts[pts.length - 1][0];
  const area = 'M' + pts.map(([i, v]) => `${x(i)},${y(v)}`).join('L') + `L${x(last)},${h}L${x(first)},${h}Z`;
  return { line, area };
}
