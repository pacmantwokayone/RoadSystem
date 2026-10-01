// Vertical alignment. `drape` roads follow the (settled) terrain, smoothed with
// a symmetric arc-length FIR kernel. A FIR filter is deliberate: every output
// sample depends only on input samples within ±radius, so chunks that are
// built at different times from the same data agree exactly on shared
// boundaries (an IIR/grade-limiting pass would not). Fixed (bridge/tunnel/
// fixed-point) samples keep their authored height and are excluded from the
// kernel so terrain below a bridge deck never pulls the approach down.

export interface AlignInput {
  /** arc length per sample */
  s: ArrayLike<number>;
  /** terrain height per sample (only read where fixedWeight < 1) */
  ground: ArrayLike<number>;
  /** authored height per sample */
  authored: ArrayLike<number>;
  /** 0..1 per sample */
  fixedWeight: ArrayLike<number>;
}

/** Kernel weight for |d| ≤ 1 (raised cosine). */
export function kernel(u: number): number {
  const a = Math.abs(u);
  return a >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * a));
}

/** First/last sample index whose arc length lies within [s - r, s + r]. */
export function windowRange(s: ArrayLike<number>, i: number, radiusM: number): [number, number] {
  const n = s.length;
  const si = s[i];
  let lo = i;
  while (lo > 0 && si - s[lo - 1] <= radiusM) lo--;
  let hi = i;
  while (hi < n - 1 && s[hi + 1] - si <= radiusM) hi++;
  return [lo, hi];
}

/** Design height at sample i. Reads `ground` only inside [lo, hi] of the window
 * and only where fixedWeight < 1. */
export function designHeightAt(inp: AlignInput, i: number, radiusM: number): number {
  const fw = inp.fixedWeight[i];
  if (fw >= 1) return inp.authored[i];
  let sum = 0;
  let wsum = 0;
  if (radiusM <= 0) {
    sum = inp.ground[i];
    wsum = 1;
  } else {
    const [lo, hi] = windowRange(inp.s, i, radiusM);
    for (let j = lo; j <= hi; j++) {
      const free = 1 - inp.fixedWeight[j];
      if (free <= 0) continue;
      // trapezoid width so non-uniform spacing doesn't bias the average
      const sPrev = j > lo ? inp.s[j - 1] : inp.s[j];
      const sNext = j < hi ? inp.s[j + 1] : inp.s[j];
      const dsj = Math.max(1e-6, (sNext - sPrev) * 0.5);
      const w = kernel((inp.s[j] - inp.s[i]) / radiusM) * free * dsj;
      sum += inp.ground[j] * w;
      wsum += w;
    }
  }
  const draped = wsum > 0 ? sum / wsum : inp.authored[i];
  return draped * (1 - fw) + inp.authored[i] * fw;
}
