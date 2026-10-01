import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { MockStreamTerrain } from '../src/terrain/mockStreamTerrain';
import { RoadSystem } from '../src/runtime/roadSystem';
import { ProfileLibrary } from '../src/profile/library';
import { planPhases, SignalController, carLamps, pedLamps } from '../src/junction/signals';
import { SignalLayer } from '../src/props/signalLayer';
import { planSignalSetup } from '../src/props/signalHeads';
import { PropMaterials } from '../src/props/materials';
import type { NodeDef, RoadDef } from '../src/network/types';

const dir = (deg: number) => ({ x: Math.cos((deg * Math.PI) / 180), z: Math.sin((deg * Math.PI) / 180) });

describe('phase plan', () => {
  it('X crossing: two phases of opposite pairs', () => {
    const p = planPhases([dir(0), dir(90), dir(180), dir(270)]);
    expect(p.phases).toHaveLength(2);
    expect(p.phases.map((ph) => [...ph].sort())).toEqual(expect.arrayContaining([[0, 2], [1, 3]]));
  });
  it('T junction: the through road shares a phase, the side road has its own', () => {
    const p = planPhases([dir(0), dir(180), dir(90)]);
    expect(p.phases).toHaveLength(2);
    expect(p.phases.some((ph) => ph.length === 2 && ph.includes(0) && ph.includes(1))).toBe(true);
    expect(p.phases.some((ph) => ph.length === 1 && ph[0] === 2)).toBe(true);
  });
  it('Y junction (120° apart): every arm its own phase', () => {
    expect(planPhases([dir(0), dir(120), dir(240)]).phases).toEqual(expect.arrayContaining([[0], [1], [2]]));
  });
  it('a slightly skewed crossing still pairs; a strongly skewed one does not', () => {
    expect(planPhases([dir(0), dir(165), dir(90), dir(270)]).phases.filter((ph) => ph.length === 2)).toHaveLength(2);
    expect(planPhases([dir(0), dir(120), dir(90), dir(270)]).phases.some((ph) => ph.includes(0) && ph.includes(1))).toBe(false);
  });
  it('every arm appears in exactly one phase', () => {
    for (const degs of [[0, 90], [0, 72, 144, 216, 288], [0, 180, 45, 225, 100, 280]]) {
      const p = planPhases(degs.map(dir));
      expect(p.phases.flat().sort()).toEqual(degs.map((_, i) => i));
    }
  });
});

describe('signal controller', () => {
  const plan = { phases: [[0, 2], [1, 3]] };
  const ctl = new SignalController(plan, 4, 'fixed', { greenS: 20 });
  const grid = Array.from({ length: 2000 }, (_, i) => i * 0.25);

  it('cycle = Σ (green + yellow + all-red)', () => {
    expect(ctl.cycleS).toBe(2 * (20 + 3 + 2));
  });

  it('is periodic', () => {
    for (const t of [0, 3.3, 24.9, 25, 40.5]) expect(ctl.at(t)).toEqual(ctl.at(t + ctl.cycleS));
  });

  it('conflicting directions are never released together', () => {
    for (const t of grid) {
      const f = ctl.at(t);
      const go = (a: number): boolean => f.cars[a] === 'green' || f.cars[a] === 'yellow' || f.cars[a] === 'redyellow';
      // arms of different phases: if one is "go" the other must be fully red
      expect(go(0) && go(1)).toBe(false);
      expect(go(0) && go(3)).toBe(false);
      expect(go(2) && go(1)).toBe(false);
      // arms of the same phase always agree
      expect(f.cars[0]).toBe(f.cars[2]);
      expect(f.cars[1]).toBe(f.cars[3]);
    }
  });

  it('follows the Swiss sequence red → red-yellow → green → yellow → red', () => {
    const seq: string[] = [];
    for (const t of grid) {
      const s = ctl.at(t).cars[0];
      if (seq[seq.length - 1] !== s) seq.push(s);
    }
    // starts green at t = 0 (cycle starts with phase 0)
    expect(seq.slice(0, 5)).toEqual(['green', 'yellow', 'red', 'redyellow', 'green']);
  });

  it('red-yellow lasts 1 s, yellow 3 s, there is an all-red gap between phases', () => {
    const dur = (arm: number, state: string): number => grid.filter((t) => t < ctl.cycleS && ctl.at(t).cars[arm] === state).length * 0.25;
    expect(dur(0, 'yellow')).toBe(3);
    expect(dur(0, 'redyellow')).toBe(1);
    expect(dur(0, 'green')).toBe(20);
    // all-red: both groups red for at least 1 s (2 s clearance minus the red-yellow of the next phase)
    const allRed = grid.filter((t) => t < ctl.cycleS && ctl.at(t).cars.every((c) => c === 'red')).length * 0.25;
    expect(allRed).toBeGreaterThanOrEqual(2);
  });

  it('pedestrians cross an arm only while its own traffic is stopped and the cross traffic runs, and clear before it ends', () => {
    let seen = false;
    for (const t of grid) {
      const f = ctl.at(t);
      for (let a = 0; a < 4; a++) {
        if (f.peds[a] === 'green') {
          seen = true;
          expect(f.cars[a]).toBe('red');
          // the cross traffic (other phase) has green at that moment
          const other = plan.phases.find((ph) => !ph.includes(a))![0];
          expect(f.cars[other]).toBe('green');
        }
      }
    }
    expect(seen).toBe(true);
    // pedestrian green ends at least pedClearS before the phase's green ends
    const walkEnd = grid.filter((t) => t < 20 && ctl.at(t).peds[1] === 'green').pop();
    // arm 1 belongs to phase 1; phase 0 runs 0…20 s → walkers over arm 1 stop ≥ 5 s before 20
    expect(walkEnd).toBeLessThanOrEqual(15);
  });

  it('flashing: everyone blinks yellow, pedestrians red; off: dark', () => {
    const fl = new SignalController(plan, 4, 'flashing');
    expect(fl.at(5).cars).toEqual(['flashing', 'flashing', 'flashing', 'flashing']);
    expect(fl.at(5).peds).toEqual(['red', 'red', 'red', 'red']);
    expect(carLamps('flashing', 4).y).toBe(true);
    expect(carLamps('flashing', 5).y).toBe(false);
    const off = new SignalController(plan, 4, 'off');
    expect(off.at(5).cars.every((c) => c === 'off')).toBe(true);
    expect(carLamps('off', 0)).toEqual({ r: false, y: false, g: false });
  });

  it('offset shifts the whole plan; lamps map states correctly', () => {
    const shifted = new SignalController(plan, 4, 'fixed', { greenS: 20 }, 25);
    expect(shifted.at(0).cars[1]).toBe(ctl.at(25).cars[1]);
    expect(carLamps('redyellow', 0)).toEqual({ r: true, y: true, g: false });
    expect(pedLamps('green')).toEqual({ r: false, g: true });
  });
});

// ---- signals on a real junction ----------------------------------------------------------------

const lib = new ProfileLibrary();
function build(node: Partial<NodeDef>, profile = 'hauptstrasse', arms: Array<[number, number]> = [[3000, 3000], [3600, 3000], [3300, 2700], [3300, 3300]]): { sys: RoadSystem; layer: SignalLayer } {
  const t = new MockStreamTerrain({ heightFn: () => 800 });
  t.loadRectSync(0, 0, 6000, 6000, 4);
  t.loadRectSync(2700, 2400, 3900, 3600, 0);
  const sys = new RoadSystem(t, (d) => lib.resolve(d.profile, d.params));
  const layer = new SignalLayer(sys, {}, new PropMaterials(() => null));
  const roads: RoadDef[] = arms.map(([x, z], i) => ({
    id: `r${i}`, name: `r${i}`, profile,
    points: [[x, z], [(x + 3300) / 2, (z + 3000) / 2], [3300, 3000]].map(([px, pz]) => ({ x: px, y: 800, z: pz })),
    endNode: 'X',
  }));
  sys.setNetwork(roads, [{ id: 'X', x: 3300, y: 800, z: 3000, ...node }]);
  let g = 0;
  while ((sys.stats().ready < sys.stats().chunks || sys.junctionStats().ready < sys.junctionStats().total) && g++ < 300) sys.resync({ checks: 999, builds: 99 });
  return { sys, layer };
}

describe('signal layer', () => {
  it('builds lights only at nodes with control "signals"', () => {
    expect(build({}).layer.count).toBe(0);
    expect(build({ control: 'stop' }).layer.count).toBe(0);
    expect(build({ control: 'signals' }).layer.count).toBe(1);
  });

  it('one car head per arm, facing the approaching traffic, beside the road on its right', () => {
    const { sys } = build({ control: 'signals' });
    const j = sys.junctions[0];
    const setup = planSignalSetup(j)!;
    const cars = setup.heads.filter((h) => h.kind === 'car');
    expect(cars).toHaveLength(4);
    expect(new Set(cars.map((h) => h.arm)).size).toBe(4);
    const centre = new THREE.Vector3(3300, 0, -3000);
    for (const h of cars) {
      const front = new THREE.Vector3(Math.sin(h.yaw), 0, Math.cos(h.yaw));
      const out = new THREE.Vector3(h.pos.x - centre.x, 0, h.pos.z - centre.z);
      expect(front.dot(out.clone().normalize())).toBeGreaterThan(0.85); // faces away from the node = at the incoming traffic
      expect(out.length()).toBeGreaterThan(6);
      expect(out.length()).toBeLessThan(30);
      expect(Math.abs(h.pos.y - 800)).toBeLessThan(1);
    }
  });

  it('no pedestrian lights without zebra crossings; with them (Dorfstrasse) two per arm', () => {
    expect(planSignalSetup(build({ control: 'signals' }).sys.junctions[0])!.heads.filter((h) => h.kind === 'ped')).toHaveLength(0);
    const peds = planSignalSetup(build({ control: 'signals' }, 'dorfstrasse').sys.junctions[0])!.heads.filter((h) => h.kind === 'ped');
    expect(peds).toHaveLength(8);
  });

  it('lamps switch with time: exactly one car lamp per head lit during green/red, pedestrians red or green', () => {
    const { layer } = build({ control: 'signals' }, 'dorfstrasse');
    const heads = layer.heads('X');
    for (const t of [0, 5, 10, 21, 24, 30, 45]) {
      layer.update(t);
      const lamps = layer.lampStates('X');
      heads.forEach((h, i) => {
        const lit = ['r', 'y', 'g'].filter((id) => lamps.get(`${i}:${id}`));
        if (h.kind === 'car') expect(lit.length).toBeGreaterThanOrEqual(1);
        else expect(lit.length).toBe(1);
        expect(lit.length).toBeLessThanOrEqual(2);
      });
    }
    // two opposite arms are green together at some time, and never together with a cross arm
    const ctl = layer.controllerOf('X')!;
    let sawGreen = false;
    for (let t = 0; t < ctl.cycleS; t += 0.5) {
      const f = ctl.at(t);
      const greens = f.cars.map((c, i) => (c === 'green' ? i : -1)).filter((i) => i >= 0);
      if (greens.length) sawGreen = true;
      expect(greens.length === 0 || greens.length === 2).toBe(true);
    }
    expect(sawGreen).toBe(true);
  });

  it('flashing mode: all arms blink yellow; off mode: nothing lit', () => {
    const f = build({ control: 'signals', signalMode: 'flashing' });
    f.layer.update(4);
    expect([...f.layer.lampStates('X')].filter(([k, on]) => on && k.endsWith(':y')).length).toBe(4);
    f.layer.update(5);
    expect([...f.layer.lampStates('X')].filter(([, on]) => on).length).toBe(0);
    const o = build({ control: 'signals', signalMode: 'off' });
    o.layer.update(7);
    expect([...o.layer.lampStates('X')].filter(([, on]) => on).length).toBe(0);
  });

  it('removing or replacing the node cleans up', () => {
    const { sys, layer } = build({ control: 'signals' });
    expect(layer.group.children.length).toBe(2);
    sys.setNetwork([], []);
    expect(layer.count).toBe(0);
    expect(layer.group.children.length).toBe(0);
  });

  it('a junction with fewer than 3 motor-road arms gets no lights', () => {
    const { layer } = build({ control: 'signals' }, 'hauptstrasse', [[3000, 3000], [3600, 3000]]);
    expect(layer.count).toBe(0);
  });
});
