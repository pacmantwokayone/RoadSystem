// A ready-made water test scene for the demo and the standalone test page: a plateau lake high in the mountains, a mountain
// stream that tumbles through rapids and drops ~400 m over a cliff into a plunge pool, a river through the valley with a small
// fall, a side stream that joins it, and a lower lake the river flows into. SIM coordinates.

import { autoLevelRiver } from './autolevel';
import type { RoadDef } from '../network/types';
import type { LakeDef, RiverDef, RiverPoint } from './types';

const smooth = (a: number, b: number, v: number): number => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

export const WATER_DEMO = {
  plateau: 1200,
  valley: 800,
  /** the cliff runs along x = CLIFF_X (steep over CLIFF_W metres) */
  cliffX: 3400,
  cliffW: 44,
  centreZ: 3000,
} as const;

/** terrain of the demo scene (SIM x, z → height) */
export function waterDemoHeight(x: number, z: number): number {
  const { plateau, valley, cliffX, cliffW, centreZ } = WATER_DEMO;
  const noise = (k: number): number => Math.sin(x / (170 * k) + z / (230 * k)) * 3 + Math.sin(x / (61 * k) - z / (83 * k)) * 1.2;
  const dz = Math.abs(z - centreZ);
  // the corridor along the waters stays calm; away from it the land gets rough and the valley narrows into mountains
  const rough = smooth(120, 420, dz);
  const calm = smooth(150, 500, dz);
  const walls = smooth(260, 900, dz) * 420 + smooth(500, 1400, dz) * 320;
  // the cliff edge meanders away from the stream (and runs straight through the fall)
  const cx = cliffX + (70 * Math.sin((z - centreZ) / 190) + 35 * Math.sin((z - centreZ) / 71 + 1.3)) * smooth(40, 260, dz);
  const cliff = smooth(cx - cliffW / 2, cx + cliffW / 2, x); // 0 on the plateau, 1 in the valley
  const hills = Math.sin(x / 260) * Math.sin(z / 310) * 26 + Math.sin(x / 97 + z / 131) * 8 + Math.sin(z / 53 - x / 71) * 3;
  const top = plateau + noise(1) * 2.2 + 25 * smooth(2500, 2200, x) - Math.max(0, x - 2900) * 0.04 + hills * rough;
  const floor = valley - (x - cliffX) * 0.018 + noise(0.6) * 1.4 + walls * 0.8 + (Math.sin(x / 190 + 1) * Math.sin(z / 240) * 12 + Math.sin(x / 73 - z / 97) * 3) * calm;
  return top + (floor - top) * cliff + walls * (1 - cliff) * 0.5;
}

const P = (x: number, z: number, extra: Partial<RiverPoint> = {}): RiverPoint => ({ x, y: 0, z, ...extra });

/** rivers and lakes of the demo scene, levels set from the terrain */
export function waterDemoWaters(ground: (x: number, z: number) => number = waterDemoHeight): { rivers: RiverDef[]; lakes: LakeDef[] } {
  const lakes: LakeDef[] = [
    {
      id: 'oberer-see', name: 'Oberer See', style: 'bergsee', level: 1197, depth: 14,
      outline: [[2540, 3000], [2600, 2930], [2720, 2905], [2850, 2925], [2920, 3000], [2880, 3085], [2760, 3125], [2630, 3100]].map(([x, z]) => ({ x, z })),
    },
    {
      id: 'unterer-see', name: 'Unterer See', style: 'weiher', level: 764, depth: 7,
      outline: [[4720, 2960], [4800, 2915], [4900, 2925], [4960, 3000], [4915, 3085], [4810, 3100], [4730, 3055]].map(([x, z]) => ({ x, z })),
    },
  ];
  const rivers: RiverDef[] = [
    // the mountain stream: out of the upper lake, through rapids, over the cliff
    autoLevelRiver({
      id: 'bergbach', name: 'Bergbach', style: 'wildbach', startLake: 'oberer-see',
      points: [
        P(2918, 3000, { width: 6 }), P(3000, 3012), P(3080, 2995, { seg: 'rapids' }), P(3160, 3008), P(3240, 2990, { seg: 'rapids' }), P(3330, 3004, { width: 7 }),
        P(3384, 3000, { width: 8, seg: 'fall' }), // the lip
        P(3428, 3000, { width: 10 }), // the foot, ~400 m lower
        P(3520, 3010, { width: 12 }), P(3640, 2990), P(3780, 3005, { width: 14 }),
      ],
    }, ground, lakes),
    // the river through the valley: small fall, rapids, into the lower lake
    autoLevelRiver({
      id: 'talfluss', name: 'Talfluss', style: 'fluss', endLake: 'unterer-see',
      points: [
        P(3780, 3005, { width: 14 }), P(3900, 3030), P(3990, 3015, { seg: 'fall', width: 15 }), P(4000, 3015), // a small step
        P(4100, 2990, { seg: 'rapids' }), P(4200, 3010), P(4330, 3040, { width: 18 }), P(4460, 3020), P(4590, 2995), P(4720, 3000, { width: 20 }),
      ],
    }, ground, lakes),
    // a side stream from the south that joins the river
    autoLevelRiver({
      id: 'seitenbach', name: 'Seitenbach', style: 'bach', endRiver: 'talfluss',
      points: [P(3900, 2640, { width: 3 }), P(3920, 2740), P(3880, 2840, { seg: 'rapids' }), P(3905, 2930), P(3900, 3028, { width: 4 })],
    }, ground),
  ];
  return { rivers, lakes };
}

/** a few good looks at the scene: [camera x, y, z (THREE space!), target x, y, z] */
export const WATER_DEMO_VIEWS: Record<string, { label: string; cam: [number, number, number, number, number, number] }> = {
  overview: { label: 'Überblick', cam: [4700, 1500, -2100, 3400, 900, -3000] },
  fall: { label: 'Wasserfall (400 m)', cam: [3680, 1030, -3180, 3410, 880, -3000] },
  fallTop: { label: 'Kante des Falls', cam: [3345, 1215, -3010, 3425, 940, -3000] },
  pool: { label: 'Gumpen am Fuss', cam: [3560, 850, -3070, 3430, 800, -3000] },
  rapids: { label: 'Stromschnellen', cam: [3160, 1235, -3045, 3160, 1190, -3008] },
  upperLake: { label: 'Oberer See', cam: [2640, 1290, -3260, 2740, 1197, -3010] },
  river: { label: 'Talfluss', cam: [4200, 860, -3160, 4200, 790, -3010] },
  step: { label: 'Kleiner Fall', cam: [3950, 820, -3070, 3995, 795, -3015] },
  lowerLake: { label: 'Unterer See', cam: [4640, 830, -3200, 4830, 764, -3010] },
  bridge: { label: 'Brücke über den Fluss', cam: [4215, 822, -3090, 4150, 786, -3000] },
  confluence: { label: 'Zusammenfluss', cam: [3960, 830, -3090, 3900, 795, -3028] },
};

/** a road that crosses the valley river on a bridge (the bridge piers stand in the water); the deck clears the ground at both ends */
export function waterDemoRoads(ground: (x: number, z: number) => number = waterDemoHeight): RoadDef[] {
  const x = 4150;
  const deck = Math.round((Math.max(ground(x, 2945), ground(x, 3055), ground(x, 3000) + 4) + 1.2) * 2) / 2;
  const pts: Array<[number, boolean]> = [[2640, false], [2800, false], [2945, true], [3000, true], [3055, true], [3200, false], [3360, false]];
  return [{
    id: 'talstrasse', name: 'Talstrasse', profile: 'hauptstrasse', bridge: 'balkenbruecke',
    points: pts.map(([z, bridge]) => (bridge ? { x, y: deck, z, mode: 'bridge' as const } : { x, y: ground(x, z), z })),
  }];
}
