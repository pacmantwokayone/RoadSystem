// Bridge piers that stand in the water are obstacles: the water shader draws a foam ring around them and a wake behind them.
// Reads the road system's bridge sections and the water field; used as WaterLayer's `externalObstacles`.

import type { RoadSystem } from '../runtime/roadSystem';
import { bridgeSections, pierPositionsFor } from '../structures/sections';
import { flipZ } from '../core/world';
import type { WaterSystem } from './system';
import type { ExternalObstacle } from './riverMesh';

export function bridgePierObstacles(roads: RoadSystem, water: WaterSystem): (riverId: string) => ExternalObstacle[] {
  return (riverId) => {
    const out: ExternalObstacle[] = [];
    for (const rt of roads.runtimes) {
      const piers = rt.bridge?.piers;
      if (!piers) continue;
      for (const sec of bridgeSections(rt)) {
        for (const s of pierPositionsFor(rt, sec, piers.maxSpan)) {
          const p = rt.sampled.curve.pointAt(s);
          const hit = water.field.waterAt(p.x, flipZ(p.z));
          if (hit && hit.kind === 'river' && hit.id === riverId) out.push({ x: p.x, z: p.z, r: Math.max(0.6, piers.width / 2) });
        }
      }
    }
    return out;
  };
}
