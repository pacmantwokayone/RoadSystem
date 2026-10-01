// Traffic-light control: an automatic phase plan from the junction's topology, and a fixed-time
// controller that is a pure function of time (so it can be sampled, tested, synchronised across clients).
//
// Phase plan: arms that lie roughly opposite each other (within ±PAIR_TOLERANCE of 180°) share a phase
// (through traffic of one road), every other arm has a phase of its own. Phases run in angular order.
// Per phase: [red-yellow 1 s] green · yellow 3 s · all-red 2 s (the red-yellow of the NEXT phase is the
// last second of that all-red). Pedestrian crossings over an arm are green in every phase that doesn't
// give that arm's own phase green — i.e. while the cross traffic runs (turning traffic is permissive).

import type { SignalMode } from '../network/types';

export interface Dir {
  x: number;
  z: number;
}

/** how far from exactly opposite two arms may be to share a phase, radians (≈ 30°) */
export const PAIR_TOLERANCE = 0.52;

export interface PhasePlan {
  /** arm indices per phase, phases in cycle order */
  phases: number[][];
}

export function planPhases(dirs: readonly Dir[]): PhasePlan {
  const ang = dirs.map((d) => Math.atan2(d.z, d.x));
  const order = [...dirs.keys()].sort((a, b) => ang[a] - ang[b]);
  const used = new Set<number>();
  const phases: number[][] = [];
  const diff = (a: number, b: number): number => {
    let d = Math.abs(ang[a] - ang[b]);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  };
  for (const a of order) {
    if (used.has(a)) continue;
    used.add(a);
    let best = -1, bestErr = PAIR_TOLERANCE;
    for (const b of order) {
      if (used.has(b)) continue;
      const err = Math.abs(diff(a, b) - Math.PI);
      if (err < bestErr) { best = b; bestErr = err; }
    }
    if (best >= 0) { used.add(best); phases.push([a, best].sort((x, y) => ang[x] - ang[y])); } else phases.push([a]);
  }
  return { phases };
}

export type CarState = 'red' | 'redyellow' | 'green' | 'yellow' | 'flashing' | 'off';
export type PedState = 'red' | 'green' | 'off';

export interface SignalTiming {
  greenS: number;
  yellowS: number;
  allRedS: number;
  /** red-yellow before green, taken from the end of the all-red */
  redYellowS: number;
  /** pedestrians get red this long before their phase ends */
  pedClearS: number;
  /** pedestrians' green starts this long after the phase starts */
  pedDelayS: number;
}

export const DEFAULT_TIMING: SignalTiming = { greenS: 20, yellowS: 3, allRedS: 2, redYellowS: 1, pedClearS: 5, pedDelayS: 1 };

export interface SignalFrame {
  /** state of the lights facing each arm */
  cars: CarState[];
  /** state of the pedestrian lights at the crossing over each arm */
  peds: PedState[];
}

export class SignalController {
  readonly timing: SignalTiming;
  readonly cycleS: number;
  private readonly starts: number[] = [];
  private readonly phaseOfArm: number[];

  constructor(
    readonly plan: PhasePlan,
    readonly armCount: number,
    readonly mode: SignalMode = 'fixed',
    timing: Partial<SignalTiming> = {},
    /** seconds added to the clock (each junction can run out of step) */
    readonly offsetS = 0,
  ) {
    this.timing = { ...DEFAULT_TIMING, ...timing };
    const len = this.timing.greenS + this.timing.yellowS + this.timing.allRedS;
    plan.phases.forEach((_, k) => this.starts.push(k * len));
    this.cycleS = len * plan.phases.length;
    this.phaseOfArm = new Array(armCount).fill(-1);
    plan.phases.forEach((arms, k) => arms.forEach((a) => { this.phaseOfArm[a] = k; }));
  }

  /** Light state for every arm and pedestrian crossing at time t (seconds). */
  at(t: number): SignalFrame {
    if (this.mode === 'off') return { cars: this.fill('off'), peds: this.fillPed('off') };
    if (this.mode === 'flashing' || this.plan.phases.length < 2) {
      // blinking yellow for everybody, pedestrians stay red
      return { cars: this.fill(this.mode === 'flashing' ? 'flashing' : 'green'), peds: this.fillPed('red') };
    }
    const T = this.timing;
    const c = (((t + this.offsetS) % this.cycleS) + this.cycleS) % this.cycleS;
    const cars: CarState[] = new Array(this.armCount).fill('red');
    const peds: PedState[] = new Array(this.armCount).fill('red');
    this.plan.phases.forEach((arms, k) => {
      const start = this.starts[k];
      // time since this phase's green began, wrapped around the cycle
      const since = (((c - start) % this.cycleS) + this.cycleS) % this.cycleS;
      let st: CarState = 'red';
      if (since < T.greenS) st = 'green';
      else if (since < T.greenS + T.yellowS) st = 'yellow';
      else if (since >= this.cycleS - T.redYellowS) st = 'redyellow';
      for (const a of arms) cars[a] = st;
      // pedestrians over arms NOT in this phase walk while this phase is green
      if (since >= T.pedDelayS && since < T.greenS - T.pedClearS) {
        for (let a = 0; a < this.armCount; a++) if (this.phaseOfArm[a] !== k) peds[a] = 'green';
      }
    });
    // an arm that is in a phase of its own never walks while its own phase is running
    for (let a = 0; a < this.armCount; a++) if (cars[a] !== 'red' && cars[a] !== 'redyellow') peds[a] = 'red';
    return { cars, peds };
  }

  private fill(s: CarState): CarState[] { return new Array(this.armCount).fill(s); }
  private fillPed(s: PedState): PedState[] { return new Array(this.armCount).fill(s); }
}

/** Which of the three lamps (top red, middle yellow, bottom green) are lit for a car state at time t. */
export function carLamps(state: CarState, t: number): { r: boolean; y: boolean; g: boolean } {
  switch (state) {
    case 'red': return { r: true, y: false, g: false };
    case 'redyellow': return { r: true, y: true, g: false };
    case 'green': return { r: false, y: false, g: true };
    case 'yellow': return { r: false, y: true, g: false };
    case 'flashing': return { r: false, y: Math.floor(t) % 2 === 0, g: false };
    default: return { r: false, y: false, g: false };
  }
}

export function pedLamps(state: PedState): { r: boolean; g: boolean } {
  return { r: state === 'red', g: state === 'green' };
}
