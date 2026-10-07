// Pur et sans import Node : utilisé aussi par le renderer.
export function alignSeries(rows: { t: number; key: string; v: number }[]) {
  const ts = [...new Set(rows.map((r) => r.t))].sort((a, b) => a - b);
  const index = new Map(ts.map((t, i) => [t, i]));
  const byKey = new Map<string, (number | null)[]>();
  for (const r of rows) {
    let arr = byKey.get(r.key);
    if (!arr) {
      arr = Array(ts.length).fill(null);
      byKey.set(r.key, arr);
    }
    arr[index.get(r.t)!] = r.v;
  }
  return { ts, byKey };
}

export function stackSeries(series: (number | null)[][]): number[][] {
  const out: number[][] = [];
  let acc: number[] | null = null;
  for (const s of series) {
    const row = s.map((v, i) => (v ?? 0) + (acc ? acc[i] : 0));
    out.push(row);
    acc = row;
  }
  return out;
}

export function topKeysByMax(byKey: Map<string, (number | null)[]>, n: number): string[] {
  return [...byKey]
    .map(([k, s]) => [k, Math.max(0, ...s.map((v) => v ?? 0))] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}
