// A ready-made water test scene for the demo and the standalone test page: a plateau lake high in the mountains, a mountain
// stream that tumbles through rapids and drops ~400 m over a cliff into a plunge pool, a river through the valley with a small
// fall, a side stream that joins it, and a lower lake the river flows into. SIM coordinates.

import { autoLevelRiver } from './autolevel';
import type { NodeDef, RoadDef, RoadPoint } from '../network/types';
import { buildRoundabout } from '../network/roundabout';
import type { LakeDef, RiverDef, RiverPoint } from './types';

/** the level ground of the road test field */
export const TRAFFIC_PAD = { x: 4380, z: 2350, flat: 700, blend: 380, y: 782 } as const;

/** the hill between the village and the cliff foot, pierced by the Tunnelstrasse */
export const TUNNEL_RIDGE = { x: 3800, z: 2480, amp: 60, sx: 95, sz: 230 } as const;

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
  const rg = TUNNEL_RIDGE;
  return valleyHeight(x, z) + rg.amp * Math.exp(-((x - rg.x) ** 2) / (2 * rg.sx * rg.sx) - ((z - rg.z) ** 2) / (2 * rg.sz * rg.sz));
}

/** the terrain without the tunnel ridge (what the Tunnelstrasse's height is planned against) */
export function valleyHeight(x: number, z: number): number {
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
  const top = plateau + noise(1) * (0.3 + 1.9 * rough) + 25 * smooth(2500, 2200, x) - Math.max(0, x - 2900) * 0.066 + hills * rough;
  const floor = valley - (x - cliffX) * 0.018 + noise(0.6) * 1.4 + walls * 0.8 + (Math.sin(x / 190 + 1) * Math.sin(z / 240) * 12 + Math.sin(x / 73 - z / 97) * 3) * calm;
  const h = top + (floor - top) * cliff + walls * (1 - cliff) * 0.5;
  // a level basin for the town and the motorway (see waterDemoNetwork)
  const pad = TRAFFIC_PAD;
  const w = 1 - smooth(pad.flat, pad.flat + pad.blend, Math.hypot(x - pad.x, z - pad.z));
  return h + (pad.y - h) * w;
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
        P(2918, 3000, { width: 6 }), P(3000, 3012, { seg: 'rapids' }), P(3070, 2995, { seg: 'rapids' }), P(3150, 3008, { seg: 'rapids' }), P(3240, 2990, { seg: 'rapids' }), P(3330, 3004, { width: 7 }),
        P(3384, 3000, { width: 8, seg: 'fall' }), // the lip
        P(3428, 3000, { width: 10 }), // the foot, ~400 m lower
        P(3520, 3010, { width: 12 }), P(3640, 2990), P(3780, 3005, { width: 14 }),
      ],
    }, ground, lakes),
    // the river through the valley: small fall, rapids, into the lower lake
    autoLevelRiver({
      id: 'talfluss', name: 'Talfluss', style: 'fluss', endLake: 'unterer-see',
      points: [
        P(3780, 3005, { width: 14 }), P(3900, 3030), P(3985, 3015, { seg: 'fall', width: 16 }), P(4000, 3015, { width: 17 }), // a 10 m step
        P(4040, 3000, { seg: 'rapids' }), P(4110, 2990, { seg: 'rapids' }), P(4200, 3010), P(4330, 3040, { width: 18 }), P(4460, 3020), P(4590, 2995), P(4720, 3000, { width: 20 }),
      ],
    }, ground, lakes, { minFallDrop: 10 }),
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
  hub: { label: 'Verkehrsfeld', cam: [3750, 1000, -1900, 4380, 783, -2330] },
  roundabout: { label: 'Kreisel', cam: [4230, 815, -2395, 4150, 783, -2480] },
  signals: { label: 'Ampelkreuzung', cam: [4605, 800, -2545, 4550, 783, -2480] },
  tee: { label: 'Dorf-T', cam: [4210, 800, -2150, 4150, 782, -2205] },
  motorway: { label: 'Autobahn + Ausfahrt', cam: [4150, 835, -1880, 4380, 782, -2040] },
  tunnelEast: { label: 'Tunnelportal Ost', cam: [4075, 800, -2420, 3960, 788, -2480] },
  tunnelWest: { label: 'Tunnelportal West', cam: [3560, 850, -2520, 3640, 792, -2480] },
  confluence: { label: 'Zusammenfluss', cam: [3960, 830, -3090, 3900, 795, -3028] },
};

/**
 * The road test field on the level ground south of the river: the Talstrasse comes over the bridge into a roundabout; from there a village
 * street with a T-junction, a main road to a signalised crossing, a dead-end side road — and a motorway to the south with an exit that
 * climbs to the crossing. (Everything in SIM coordinates; non-bridge points follow the terrain.)
 */
export function waterDemoNetwork(ground: (x: number, z: number) => number = waterDemoHeight): { roads: RoadDef[]; nodes: NodeDef[] } {
  const g = (x: number, z: number): RoadPoint => ({ x, y: ground(x, z), z });
  const gs = (list: Array<[number, number]>): RoadPoint[] => list.map(([x, z]) => g(x, z));
  const bridgeDeck = Math.round((Math.max(ground(4150, 2945), ground(4150, 3055), ground(4150, 3000) + 4) + 1.2) * 2) / 2;
  const bp = (z: number): RoadPoint => ({ x: 4150, y: bridgeDeck, z, mode: 'bridge' });
  // the tunnel climbs from the village level to the level of the valley floor on the far side of the ridge
  const yEast = valleyHeight(4050, 2480) + 0.3, yWest = valleyHeight(3640, 2480) + 0.3;
  const tp = (x: number): RoadPoint => ({ x, y: yEast + ((yWest - yEast) * (3960 - x)) / 320, z: 2480, mode: 'tunnel' });

  const rb = buildRoundabout({
    id: 'kreisel', x: 4150, z: 2480, y: ground(4150, 2480), radius: 24,
    arms: [
      { angle: Math.PI / 2, profile: 'hauptstrasse', name: 'Talstrasse', road: { bridge: 'balkenbruecke' }, points: [g(4150, 3360), g(4150, 3200), bp(3055), bp(3000), bp(2945), g(4150, 2800), g(4150, 2650)] },
      { angle: 0, profile: 'hauptstrasse', name: 'Hauptstrasse', road: { startNode: 'sig' }, points: gs([[4550, 2480], [4350, 2480]]) },
      { angle: -Math.PI / 2, profile: 'dorfstrasse', name: 'Dorfstrasse', road: { startNode: 'tee' }, points: gs([[4150, 2200], [4150, 2340]]) },
      // the Tunnelstrasse: west through the ridge in a tunnel, ending in a turning place just beyond the far portal
      { angle: Math.PI, profile: 'hauptstrasse', name: 'Tunnelstrasse', points: [g(3585, 2480), tp(3640), tp(3720), tp(3800), tp(3880), tp(3960), g(4050, 2480)] },
    ],
  });
  const nodes: NodeDef[] = [
    ...rb.nodes,
    { id: 'sig', x: 4550, y: ground(4550, 2480), z: 2480, control: 'signals', crosswalks: 'all' },
    { id: 'tee', x: 4150, y: ground(4150, 2200), z: 2200 },
    { id: 'ab', x: 4300, y: ground(4300, 1992), z: 1992, control: 'none' },
    { id: 'ramp', x: 4550, y: ground(4550, 2262), z: 2262 },
  ];
  const roads: RoadDef[] = [
    ...rb.roads,
    // signalised crossing: the main road continues east, a village street crosses it
    { id: 'haupt-ost', name: 'Hauptstrasse (Ost)', profile: 'hauptstrasse', points: gs([[4550, 2480], [4700, 2480], [4860, 2510]]), startNode: 'sig' },
    { id: 'dorf-nord', name: 'Dorfstrasse (Nord)', profile: 'dorfstrasse', points: gs([[4550, 2720], [4550, 2600], [4550, 2480]]), endNode: 'sig' },
    { id: 'dorf-sued', name: 'Dorfstrasse (Süd)', profile: 'dorfstrasse', points: gs([[4550, 2480], [4550, 2370], [4550, 2262]]), startNode: 'sig', endNode: 'ramp' },
    // village T-junction
    { id: 'quartier-west', name: 'Quartierstrasse', profile: 'quartierstrasse', points: gs([[3900, 2200], [4030, 2200], [4150, 2200]]), endNode: 'tee' },
    { id: 'quartier-ost', name: 'Quartierstrasse (2)', profile: 'quartierstrasse', points: gs([[4150, 2200], [4270, 2206], [4400, 2216]]), startNode: 'tee' },
    // motorway with an exit that leads up to the signalised crossing
    { id: 'bahn-west', name: 'Autobahn', profile: 'autobahn', points: gs([[3750, 1980], [3950, 1985], [4130, 1990], [4300, 1992]]), endNode: 'ab' },
    { id: 'bahn-ost', name: 'Autobahn (2)', profile: 'autobahn', points: gs([[4300, 1992], [4500, 2000], [4750, 2015], [5000, 2040]]), startNode: 'ab' },
    { id: 'ausfahrt', name: 'Ausfahrt', profile: 'auffahrt', points: gs([[4300, 1992], [4385, 2030], [4470, 2100], [4528, 2190], [4550, 2262]]), startNode: 'ab', endNode: 'ramp' },
  ];
  return { roads, nodes };
}
