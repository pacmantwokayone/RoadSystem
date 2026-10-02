// A motorway interchange built from roads and branches (no junction patches): motorway A runs along the ground, motorway B crosses it high
// above on a viaduct, and four flyover ramps — one in every quadrant — leave B in the air, swing through a quarter turn while sinking,
// and join A on the ground. Where a ramp is still more than a few metres up it is a bridge on its own piers; where it comes down it lies on an
// embankment. Everything is plain RoadDefs: edit, save and load like any other road. The ramps are attached to the motorways (see attach.ts):
// move a motorway and the exits, deceleration lanes and merges move with it.

import type { AttachDef, RoadDef, RoadPoint } from './types';
import { arcLengthNear, branchPoints, headLength } from './branch';

export interface InterchangeSpec {
  id: string;
  /** centre of the crossing (SIM) */
  x: number;
  z: number;
  /** ground height used for the heights of A and the ramps' ends */
  ground: (x: number, z: number) => number;
  /** deck height of the elevated motorway B above A, metres (default 13) */
  lift?: number;
  /** radius of the quarter-turn ramps, metres (default 190) */
  radius?: number;
  /** half length of A and B, metres */
  lengthA?: number;
  lengthB?: number;
  mainProfile?: string;
  rampProfile?: string;
  halfMain?: number;
  halfRamp?: number;
  /** bridge type of the elevated parts (default: by profile) */
  bridge?: string;
  /** maximum grade of B's approach embankments (default 4.5 %) */
  grade?: number;
  /** length of the deceleration / acceleration lane, metres (default 100) */
  laneLength?: number;
}

export interface Interchange {
  roads: RoadDef[];
  /** the elevated motorway's deck height at its crossing, absolute */
  deckY: number;
}

export function buildStackInterchange(spec: InterchangeSpec): Interchange {
  const { x: cx, z: cz, ground } = spec;
  const lift = spec.lift ?? 13;
  const R = spec.radius ?? 190;
  const LA = spec.lengthA ?? 900, LB = spec.lengthB ?? 1000;
  const main = spec.mainProfile ?? 'autobahn', ramp = spec.rampProfile ?? 'auffahrt';
  const hm = spec.halfMain ?? 11, hr = spec.halfRamp ?? 3;
  const lane = { grow: 50, parallel: spec.laneLength ?? 100, taper: 70, gap: 2 };
  const L = headLength(lane);
  const lat = hm + hr + lane.gap; // lateral position of a ramp beside the motorway once it has separated
  const grade = spec.grade ?? 0.045;
  const y0 = ground(cx, cz);
  const deckY = y0 + lift;
  const gY = (x: number, z: number): number => ground(x, z);

  // A: on the ground, west to east
  const aXs: number[] = [];
  for (let d = -LA; d <= LA; d += 100) aXs.push(cx + d);
  const A: RoadDef = { id: `${spec.id}-A`, name: 'Autobahn A', profile: main, points: aXs.map((x) => ({ x, y: gY(x, cz), z: cz })) };

  // B: south to north. Full height as far out as the ramps leave it, then down an embankment (and a first stretch of viaduct) to the ground
  const dTop = lat + R + L + 60;
  const climbLen = lift / grade;
  const heightAt = (d: number): number => Math.min(lift, Math.max(0, lift - (d - dTop) * grade));
  const ds = new Set<number>([0]);
  for (let d = 80; d <= dTop; d += 80) ds.add(d);
  ds.add(dTop);
  for (let d = dTop + 80; d < dTop + climbLen; d += 80) ds.add(d);
  ds.add(dTop + climbLen);
  for (let d = dTop + climbLen + 150; d <= LB; d += 200) ds.add(d);
  const half = [...ds].sort((a, b) => b - a);
  const mk = (d: number, sign: number): RoadPoint => {
    const z = cz + sign * d, h = heightAt(d);
    if (h <= 0.01) return { x: cx, y: gY(cx, z), z };
    if (h > 5.5) return { x: cx, y: y0 + h, z, mode: 'bridge' };
    return { x: cx, y: gY(cx, z) + h, z, elev: 'fixed' };
  };
  const bPts: RoadPoint[] = [];
  for (const d of half) bPts.push(mk(d, -1));
  bPts.push({ x: cx, y: deckY, z: cz, mode: 'bridge' });
  for (const d of [...half].reverse()) bPts.push(mk(d, 1));
  const B: RoadDef = { id: `${spec.id}-B`, name: 'Autobahn B (Hochstrasse)', profile: main, ...(spec.bridge ? { bridge: spec.bridge } : {}), points: bPts };

  const roads: RoadDef[] = [A, B];
  const quadrants: Array<[1 | -1, 1 | -1]> = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (const [sx, sz] of quadrants) {
    // arc: start S beside B heading to the centre, quarter turn towards sx, end E beside A heading outwards
    const S = { x: cx + sx * lat, z: cz + sz * (lat + R) };
    const C = { x: S.x + sx * R, z: S.z };
    const E = { x: C.x, z: cz + sz * lat };
    // the exit leaves B far out and runs towards the centre; the entry joins A far out and runs back from the centre
    const exit: AttachDef = {
      road: B.id, at: { x: cx, z: cz + sz * (lat + R + L) }, side: sx, dir: (sz > 0 ? -1 : 1) as 1 | -1,
      halfMain: hm, halfBranch: hr, ...lane, head: 0,
    };
    const entry: AttachDef = {
      road: A.id, at: { x: E.x + sx * L, z: cz }, side: (sz > 0 ? -1 : 1) as 1 | -1, dir: (sx > 0 ? -1 : 1) as 1 | -1,
      halfMain: hm, halfBranch: hr, ...lane, head: 0,
    };
    const sB = arcLengthNear(B, exit.at.x, exit.at.z);
    const sA = arcLengthNear(A, entry.at.x, entry.at.z);
    const head = branchPoints({ main: B, s: sB, side: exit.side, dir: exit.dir, halfMain: hm, halfBranch: hr, ...lane, tail: [] });
    const tailA = branchPoints({ main: A, s: sA, side: entry.side, dir: entry.dir, halfMain: hm, halfBranch: hr, ...lane, tail: [], merge: true });
    exit.head = head.length;
    entry.head = tailA.length;
    const yS = head[head.length - 1].y, yE = tailA[0].y;
    const steps = 14;
    const arc: RoadPoint[] = [];
    for (let k = 1; k < steps; k++) {
      const a = (k / steps) * (Math.PI / 2);
      // from S (angle pointing away from the centre of the quarter circle) to E
      const px = C.x - sx * R * Math.cos(a);
      const pz = C.z - sz * R * Math.sin(a);
      const y = yS + (yE - yS) * (k / steps);
      const h = y - gY(px, pz);
      arc.push(h > 4.5 ? { x: px, y, z: pz, mode: 'bridge' } : { x: px, y: Math.max(y, gY(px, pz) + 0.3), z: pz, elev: 'fixed' });
    }
    roads.push({
      id: `${spec.id}-ramp${sx > 0 ? 'E' : 'W'}${sz > 0 ? 'N' : 'S'}`, name: `Rampe ${sz > 0 ? 'Nord' : 'Süd'}-${sx > 0 ? 'Ost' : 'West'}`, profile: ramp,
      ...(spec.bridge ? { bridge: spec.bridge } : {}), points: [...head, ...arc, ...tailA], attach: exit, attachEnd: entry,
    });
  }
  return { roads, deckY };
}
