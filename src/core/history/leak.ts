// src/core/history/leak.ts
/** Fuite probable : ≥ 80 % des minutes en hausse sur la fenêtre, et hausse totale ≥ minGrowthKB. */
export function detectLeak(series: number[], minMinutes: number, minGrowthKB: number): { leak: boolean; growthKB: number } {
  if (series.length < minMinutes + 1) return { leak: false, growthKB: 0 };
  const w = series.slice(-(minMinutes + 1));
  let ups = 0;
  for (let i = 1; i < w.length; i++) if (w[i] > w[i - 1]) ups++;
  const growthKB = w[w.length - 1] - w[0];
  return { leak: ups / minMinutes >= 0.8 && growthKB >= minGrowthKB, growthKB };
}
