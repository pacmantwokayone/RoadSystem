// Templates the editor can drop into the map: a motorway interchange, a roundabout, a railway station with a siding. They only create
// ordinary roads and nodes (with `attach` where something branches), so afterwards everything is edited like any other road: drag points,
// change profiles, bridge types, lane lengths, delete single roads.

import { buildRoundabout } from '../network/roundabout';
import { buildStackInterchange } from '../network/interchange';
import { defaultAttach } from '../network/branchDefaults';
import { ProfileLibrary } from '../profile/library';
import type { NodeDef, RoadDef, RoadPoint } from '../network/types';

export type TemplateKind = 'interchange' | 'roundabout' | 'station';

export interface TemplateParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface TemplateContext {
  /** where it goes (SIM) */
  x: number;
  z: number;
  ground: (x: number, z: number) => number;
  /** unique prefix for ids */
  uid: string;
  params: Record<string, number>;
  library: ProfileLibrary;
}

export interface TemplateDef {
  label: string;
  hint: string;
  params: TemplateParam[];
  build(ctx: TemplateContext): { roads: RoadDef[]; nodes: NodeDef[] };
}

let counter = 0;
export const newTemplateId = (): string => `t${Date.now().toString(36)}${(counter++).toString(36)}`;

export const TEMPLATES: Record<TemplateKind, TemplateDef> = {
  interchange: {
    label: 'Autobahnkreuz',
    hint: 'Autobahn am Boden, Hochstrasse darüber auf Stelzen, vier Rampen mit Verzögerungs-/Beschleunigungsstreifen. Gelände sollte hier flach sein.',
    params: [
      { key: 'lift', label: 'Höhe Hochstrasse (m)', min: 7, max: 25, step: 0.5, default: 11 },
      { key: 'radius', label: 'Rampenradius (m)', min: 90, max: 260, step: 5, default: 160 },
      { key: 'lane', label: 'Spurzusatz (m)', min: 0, max: 250, step: 10, default: 100 },
    ],
    build: (c) => {
      const lane = c.params.lane;
      const ic = buildStackInterchange({
        id: c.uid, x: c.x, z: c.z, ground: c.ground, lift: c.params.lift, radius: c.params.radius, laneLength: lane,
        lengthA: Math.max(450, c.params.radius + 340 + lane), lengthB: Math.max(640, c.params.radius + 340 + lane + 150), grade: 0.05,
      });
      return { roads: ic.roads, nodes: [] };
    },
  },
  roundabout: {
    label: 'Kreisel',
    hint: 'Ring mit Mittelinsel und gleichmässig verteilten Zufahrten (Kein Vortritt an den Zufahrten).',
    params: [
      { key: 'radius', label: 'Radius (m)', min: 14, max: 45, step: 1, default: 24 },
      { key: 'arms', label: 'Zufahrten', min: 3, max: 6, step: 1, default: 4 },
      { key: 'length', label: 'Länge der Zufahrten (m)', min: 40, max: 400, step: 10, default: 140 },
    ],
    build: (c) => {
      const n = Math.round(c.params.arms);
      const rb = buildRoundabout({
        id: c.uid, x: c.x, z: c.z, y: c.ground(c.x, c.z), radius: c.params.radius,
        arms: Array.from({ length: n }, (_, k) => ({ angle: (k / n) * Math.PI * 2, profile: 'hauptstrasse', name: `Zufahrt ${k + 1}`, length: c.params.length })),
      });
      return { roads: rb.roads, nodes: rb.nodes };
    },
  },
  station: {
    label: 'Bahnhof mit Weiche',
    hint: 'Doppelspur mit Bahnhof (Perrons, Dächer) und einem Abstellgleis, das über eine Weiche abzweigt. Gerade, ost–west.',
    params: [
      { key: 'length', label: 'Bahnhofslänge (m)', min: 120, max: 400, step: 10, default: 220 },
      { key: 'approach', label: 'Strecke je Seite (m)', min: 150, max: 800, step: 25, default: 350 },
    ],
    build: (c) => {
      const L = c.params.length, A = c.params.approach;
      const x0 = c.x - L / 2 - A, x1 = c.x - L / 2, x2 = c.x + L / 2, x3 = c.x + L / 2 + A;
      const y = (x: number): number => c.ground(x, c.z) + 0.45;
      const line = (xs: number[]): RoadPoint[] => xs.map((x) => ({ x, y: y(x), z: c.z }));
      const steps = (a: number, b: number, n: number): number[] => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
      const west: RoadDef = { id: `${c.uid}-west`, name: 'Strecke West', profile: 'gleis_doppel', points: line(steps(x0, x1, Math.max(2, Math.round(A / 120)))) };
      const bhf: RoadDef = { id: `${c.uid}-bahnhof`, name: 'Bahnhof', profile: 'bahnhof', points: line(steps(x1, x2, Math.max(2, Math.round(L / 110)))) };
      const east: RoadDef = { id: `${c.uid}-ost`, name: 'Strecke Ost', profile: 'gleis_doppel', points: line(steps(x2, x3, Math.max(2, Math.round(A / 120)))) };
      const parent = c.library.resolve('gleis_doppel'), child = c.library.resolve('gleis');
      const attach = defaultAttach({ parent: east, parentProfile: parent, childProfile: child, at: { x: x2 + 40, z: c.z }, side: 1, kind: 'exit' });
      const siding: RoadDef = {
        id: `${c.uid}-stich`, name: 'Abstellgleis', profile: 'gleis', attach,
        points: [{ x: x2 + 200, y: y(x2 + 200), z: c.z - 6.75 }, { x: x2 + 260, y: y(x2 + 260), z: c.z - 6.75 }],
      };
      return { roads: [west, bhf, east, siding], nodes: [] };
    },
  },
};

export function defaultTemplateParams(kind: TemplateKind): Record<string, number> {
  return Object.fromEntries(TEMPLATES[kind].params.map((p) => [p.key, p.default]));
}
