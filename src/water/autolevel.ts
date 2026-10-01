// "Pegel aus Terrain": sets the water level of river points from the ground they lie on. The level is the running minimum of the
// terrain along the river (water never runs uphill), a little below the ground so the channel is cut rather than built up.
// Points right after a waterfall lip are taken from the ground there (the foot of the fall), so a fall of any height works.

import type { LakeDef, RiverDef, RiverPoint } from './types';

export interface AutoLevelOptions {
  /** how far below the ground the water sits at a point, metres */
  below: number;
  /** fixed level of the first point (the river leaves a lake) */
  startLevel?: number;
  /** fixed level of the last point (the river enters a lake) */
  endLevel?: number;
  /** a waterfall whose ground does not fall at least this much still drops by this much, metres */
  minFallDrop: number;
}

export const DEFAULT_AUTO_LEVEL: AutoLevelOptions = { below: 0.4, minFallDrop: 4 };

export function autoLevel(points: readonly RiverPoint[], ground: (x: number, z: number) => number, opts: Partial<AutoLevelOptions> = {}): RiverPoint[] {
  const o = { ...DEFAULT_AUTO_LEVEL, ...opts };
  const out: RiverPoint[] = [];
  let run = Infinity;
  points.forEach((p, i) => {
    let y = Math.min(run, ground(p.x, p.z) - o.below);
    if (i === 0 && o.startLevel !== undefined) y = o.startLevel;
    if (i > 0 && points[i - 1].seg === 'fall') y = Math.min(y, out[i - 1].y - o.minFallDrop);
    if (i === points.length - 1 && o.endLevel !== undefined) y = Math.min(o.endLevel, run);
    run = Math.min(run, y);
    out.push({ ...p, y });
  });
  return out;
}

/** Same for a whole river def; the levels of lakes it leaves / enters are taken from `lakes`. Returns a new def. */
export function autoLevelRiver(def: RiverDef, ground: (x: number, z: number) => number, lakes: readonly LakeDef[] = [], opts: Partial<AutoLevelOptions> = {}): RiverDef {
  const start = def.startLake ? lakes.find((l) => l.id === def.startLake)?.level : undefined;
  const end = def.endLake ? lakes.find((l) => l.id === def.endLake)?.level : undefined;
  return { ...def, points: autoLevel(def.points, ground, { startLevel: start, endLevel: end, ...opts }) };
}
