// Guardrail geometry: the rail is extruded along the run (stations at every road sample plus the ends),
// the posts are ordinary placements (see place.ts). Cross-sections are given in (dx, dy): dx = metres
// AWAY from the road, dy = height above the surface at the rail's position.

import * as THREE from 'three';
import type { ChunkSampler } from './sampler';
import type { RailRun } from './place';
import type { GeometryBatch } from './batch';

interface Shape {
  material: string;
  pts: Array<[number, number]>;
  /** closed polygon (counter-clockwise in (dx, dy)) instead of an open polyline */
  closed: boolean;
}

/** how the end terminal is formed: dip the whole section, shrink its height, or nothing */
type TerminalMode = 'dip' | 'shrink' | 'none';

const box = (x0: number, x1: number, y0: number, y1: number, material: string): Shape => ({
  material, closed: true, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
});

export const RAIL_SHAPES: Record<RailRun['variant'], { shapes: Shape[]; terminal: TerminalMode }> = {
  // W-beam: two ridges towards the road
  steel: {
    terminal: 'dip',
    shapes: [{ material: 'steel', closed: false, pts: [[0, 0.48], [-0.045, 0.53], [0, 0.58], [0, 0.62], [-0.045, 0.67], [0, 0.72], [0, 0.79]] }],
  },
  // New-Jersey profile
  concrete: {
    terminal: 'shrink',
    shapes: [{
      material: 'concrete_barrier', closed: true,
      pts: [[-0.3, 0], [0.3, 0], [0.3, 0.08], [0.2, 0.35], [0.13, 0.8], [-0.13, 0.8], [-0.2, 0.35], [-0.3, 0.08]],
    }],
  },
  wood: {
    terminal: 'none',
    shapes: [box(-0.05, 0.05, 0.42, 0.62, 'wood'), box(-0.05, 0.05, 0.72, 0.92, 'wood')],
  },
  cable: {
    terminal: 'none',
    shapes: [box(-0.012, 0.012, 0.5, 0.524, 'steel_dark'), box(-0.012, 0.012, 0.64, 0.664, 'steel_dark'), box(-0.012, 0.012, 0.78, 0.804, 'steel_dark')],
  },
};

const smooth = (t: number): number => t * t * (3 - 2 * t);

export function buildRail(sampler: ChunkSampler, run: RailRun, batch: GeometryBatch): void {
  const def = RAIL_SHAPES[run.variant];
  const sg = run.side === 'right' ? 1 : -1;

  // stations: ends, every ring in between, and a fine grid inside the terminals
  const set = new Set<number>([run.sA, run.sB]);
  for (let r = 0; r < sampler.sections.length; r++) {
    const s = sampler.rt.samples[sampler.sampleIndex(r)].s;
    if (s > run.sA + 1e-6 && s < run.sB - 1e-6) set.add(s);
  }
  if (def.terminal !== 'none' && run.terminal > 0) {
    for (const [free, from, dir] of [[run.startFree, run.sA, 1], [run.endFree, run.sB, -1]] as const) {
      if (!free) continue;
      for (let d = 0.5; d < run.terminal; d += 0.5) {
        const s = from + dir * d;
        if (s > run.sA + 1e-6 && s < run.sB - 1e-6) set.add(s);
      }
    }
  }
  const stations = [...set].sort((a, b) => a - b);
  if (stations.length < 2) return;

  /** 0 = full height, 1 = fully lowered */
  const lower = (s: number): number => {
    let t = 0;
    if (run.startFree && run.terminal > 0) t = Math.max(t, 1 - Math.min(1, (s - run.sA) / run.terminal));
    if (run.endFree && run.terminal > 0) t = Math.max(t, 1 - Math.min(1, (run.sB - s) / run.terminal));
    return smooth(Math.max(0, Math.min(1, t)));
  };

  const pts = stations.map((s) => sampler.point(s, run.xp));
  const out = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3();
  const tri = new THREE.Vector3();

  for (const shape of def.shapes) {
    const raw = batch.addRaw(shape.material);
    const m = shape.pts.length;
    const segs = shape.closed ? m : m - 1;
    const world = (st: number, dx: number, dy: number, o: THREE.Vector3): THREE.Vector3 => {
      const P = pts[st];
      const t = lower(stations[st]);
      let y = dy;
      if (def.terminal === 'dip') y = dy - 0.4 * t;
      else if (def.terminal === 'shrink') y = dy * (1 - 0.75 * t);
      out.set(P.right.x * sg, P.right.y * sg, P.right.z * sg);
      return o.copy(P.pos).addScaledVector(out, dx).addScaledVector(P.up, y);
    };
    for (let k = 0; k < segs; k++) {
      const [ax, ay] = shape.pts[k], [bx, by] = shape.pts[(k + 1) % m];
      // outward normal in (dx, dy) of the segment direction (CCW polygons: (ey, -ex))
      let nx = by - ay, ny = -(bx - ax);
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl; ny /= nl;
      for (let st = 0; st < stations.length - 1; st++) {
        const P0 = pts[st], P1 = pts[st + 1];
        const quad: THREE.Vector3[] = [world(st, ax, ay, new THREE.Vector3()), world(st, bx, by, new THREE.Vector3()), world(st + 1, ax, ay, new THREE.Vector3()), world(st + 1, bx, by, new THREE.Vector3())];
        const normals = [P0, P0, P1, P1].map((P) => {
          out.set(P.right.x * sg, P.right.y * sg, P.right.z * sg);
          return new THREE.Vector3().addScaledVector(out, nx).addScaledVector(P.up, ny).normalize();
        });
        const idx = quad.map((p, i) => raw.vertex(p, normals[i], i < 2 ? 0 : 1, stations[st] ));
        // wind so the face normal agrees with the analytic normal
        a.subVectors(quad[1], quad[0]); b.subVectors(quad[2], quad[0]); tri.crossVectors(a, b);
        n.copy(normals[0]);
        if (tri.dot(n) >= 0) { raw.tri(idx[0], idx[1], idx[2]); raw.tri(idx[1], idx[3], idx[2]); }
        else { raw.tri(idx[0], idx[2], idx[1]); raw.tri(idx[1], idx[2], idx[3]); }
      }
    }
    // end caps for closed shapes
    if (shape.closed) {
      for (const [st, free, sgn] of [[0, run.startFree, -1], [stations.length - 1, run.endFree, 1]] as const) {
        if (!free) continue;
        const P = pts[st];
        const nrm = new THREE.Vector3(P.tangent.x * sgn, 0, P.tangent.z * sgn);
        const ring = shape.pts.map(([dx, dy]) => raw.vertex(world(st, dx, dy, new THREE.Vector3()), nrm));
        for (let i = 1; i < m - 1; i++) {
          const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3();
          world(st, shape.pts[0][0], shape.pts[0][1], pa); world(st, shape.pts[i][0], shape.pts[i][1], pb); world(st, shape.pts[i + 1][0], shape.pts[i + 1][1], pc);
          a.subVectors(pb, pa); b.subVectors(pc, pa); tri.crossVectors(a, b);
          if (tri.dot(nrm) >= 0) raw.tri(ring[0], ring[i], ring[i + 1]); else raw.tri(ring[0], ring[i + 1], ring[i]);
        }
      }
    }
  }
}
