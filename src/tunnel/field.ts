// The ground in front of a tunnel portal: a cutting (Einschnitt). The road runs at its design height into the hillside, so the hill in
// front of the portal has to be dug away down to the road: a flat floor with 1 : 1.5 slopes, rising slowly away from the portal and
// fading into the terrain. A pure function of (x, z, base height), like the water's WaterField; SIM coordinates.

import type { RoadRuntime } from '../runtime/roadRuntime';
import { tunnelDims, tunnelSections } from './sections';

export interface Portal {
  road: string;
  end: 'start' | 'end';
  /** centre of the portal plane (SIM) and the horizontal direction pointing OUT of the tunnel */
  x: number;
  z: number;
  dx: number;
  dz: number;
  /** road surface height at the portal */
  y: number;
  /** half width of the cutting floor */
  hw: number;
  /** height of the portal's top edge above the road: behind the portal the hillside is cut back from here at 45° */
  roof: number;
}

export const CUT_LENGTH_M = 130;
/** how far behind the portal plane the hillside is cut back (only where it is higher than the 45° slope) */
export const NOTCH_M = 90;
const NOTCH_SLOPE = 1.1;
const FLOOR_BELOW_M = 0.3;
const SLOPE = 1.5; // horizontal : vertical of the cutting's sides
const RISE_AFTER_M = 28; // the floor starts climbing this far from the portal …
const RISE_RATE = 0.055; // … at 5.5 %
const smooth = (a: number, b: number, v: number): number => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

export function portalsOf(rt: RoadRuntime): Portal[] {
  const out: Portal[] = [];
  const dims = tunnelDims(rt);
  for (const sec of tunnelSections(rt)) {
    for (const end of ['start', 'end'] as const) {
      if (end === 'start' ? !sec.portalStart : !sec.portalEnd) continue;
      const smp = rt.samples[end === 'start' ? sec.i0 : sec.i1];
      const sign = end === 'start' ? -1 : 1;
      const tx = smp.tangent.x, tz = smp.tangent.z, l = Math.hypot(tx, tz) || 1;
      // THREE z is mirrored with respect to SIM
      out.push({ road: rt.def.id, end, x: smp.pos.x, z: -smp.pos.z, dx: (sign * tx) / l, dz: (-sign * tz) / l, y: smp.pos.y, hw: dims.halfW, roof: dims.wall + dims.rise + 1.4 });
    }
  }
  return out;
}

export class TunnelField {
  constructor(readonly portals: readonly Portal[]) {}

  get empty(): boolean { return this.portals.length === 0; }

  /** bounding rect of everything the field can change */
  bounds(): { minX: number; minZ: number; maxX: number; maxZ: number } | null {
    if (!this.portals.length) return null;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of this.portals) {
      const reach = CUT_LENGTH_M + 70;
      for (const [x, z] of [[p.x - reach, p.z - reach], [p.x + reach, p.z + reach]]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    }
    return { minX, minZ, maxX, maxZ };
  }

  modify(x: number, z: number, base: number): number {
    let h = base;
    for (const p of this.portals) {
      const rx = x - p.x, rz = z - p.z;
      const u = rx * p.dx + rz * p.dz;
      if (u < -NOTCH_M || u > CUT_LENGTH_M) continue;
      const v = Math.abs(-rx * p.dz + rz * p.dx);
      const lateral = Math.max(0, v - (p.hw + 1.4)) / SLOPE;
      let target: number;
      if (u >= 0) target = p.y - FLOOR_BELOW_M + Math.max(0, u - RISE_AFTER_M) * RISE_RATE + lateral;
      else target = p.y + p.roof + -u * NOTCH_SLOPE + lateral; // above the mouth the earth is cut back at 45°
      if (target >= h) continue;
      const w = u >= 0 ? 1 - smooth(CUT_LENGTH_M - 45, CUT_LENGTH_M, u) : 1 - smooth(NOTCH_M - 25, NOTCH_M, -u);
      h += (target - h) * w;
    }
    return h;
  }
}
