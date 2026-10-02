// Per-road runtime state: samples, chunks, and the lazy "wait until the terrain
// has settled" height resolution — the same idiom as riverField.resync(): a
// chunk is built once every sample it depends on is settled, never before, so
// nothing is baked onto a coarse fallback height that later floats.
//
// The terrain is sampled ACROSS the road too (centre, carriageway edges, outer
// edges). The design height follows the highest terrain under the carriageway,
// so the road surface is never buried by a hillside; the body walls then reach
// down to the terrain on the other side (see mesh/extrude.ts).

import { Vector3 } from 'three';
import type { RoadDef } from '../network/types';
import type { TerrainSource } from '../core/terrain';
import { dependencyRadius, designHeightAt, windowRange } from '../core/alignment';
import { makeFrame, type Frame } from '../core/frames';
import { sampleRoad, DEFAULT_SAMPLE_OPTIONS, NO_TRIM, type RoadSample, type SampledRoad, type SampleOptions, type Trim } from '../core/sampling';
import { flipZ } from '../core/world';
import { profileHeightAt, profileHeightInside, type ProfilePoint, type ProfileData } from '../profile/types';
import { DEFAULT_BRIDGE, type BridgeData } from '../structures/types';
import type { End } from '../network/graph';
import type { EdgeOpening, SwitchInfo } from '../network/attach';

export interface RoadRuntimeOptions {
  sample: SampleOptions;
  /** target chunk length along the path, metres */
  chunkLengthM: number;
  /** drape smoothing radius when the profile doesn't specify one, metres */
  smoothRadiusM: number;
  /** minimum height of the road surface above the terrain mesh under the carriageway, metres.
   * Without it a road on flat ground is coplanar with the terrain (and vanishes); mesh vs heightAt()
   * differences (triangulation, LOD, meshStride) would otherwise bury it on rough ground. */
  clearanceM: number;
}

export const DEFAULT_RUNTIME_OPTIONS: RoadRuntimeOptions = {
  sample: DEFAULT_SAMPLE_OPTIONS,
  chunkLengthM: 64,
  smoothRadiusM: 12,
  clearanceM: 0.15,
};

export type ChunkState = 'pending' | 'ready';

export interface RoadChunk {
  index: number;
  /** inclusive sample range; neighbouring chunks share their boundary sample */
  i0: number;
  i1: number;
  state: ChunkState;
}

/** indices into RoadRuntime.lat */
export const LAT = { OUTER_L: 0, CORE_L: 1, CENTRE: 2, CORE_R: 3, OUTER_R: 4 } as const;

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class RoadRuntime {
  readonly def: RoadDef;
  readonly profile: ProfileData;
  readonly sampled: SampledRoad;
  readonly samples: RoadSample[];
  readonly chunks: RoadChunk[] = [];
  readonly seed: number;
  /** terrain height at 5 lateral positions per sample (NaN = not read), see LAT */
  readonly lat: Float64Array[];
  /** envelope used for alignment: max terrain height under the carriageway */
  readonly ground: Float64Array;
  /** final design height per sample (NaN until its chunk is ready) */
  readonly designY: Float64Array;
  readonly smoothRadiusM: number;
  private readonly innerSettled: Uint8Array;
  private readonly outerSettled: Uint8Array;
  private readonly authored: Float64Array;
  private readonly sArr: Float64Array;
  private readonly fixedW: Float64Array;
  private readonly rightHx: Float64Array;
  private readonly rightHz: Float64Array;
  private readonly window: Array<[number, number]>;
  /** profile surface height (relative to the design line) at the carriageway edges and the centre */
  private readonly surfY: { left: number; centre: number; right: number };

  constructor(
    def: RoadDef,
    private readonly terrain: TerrainSource,
    profile: ProfileData,
    readonly opts: RoadRuntimeOptions = DEFAULT_RUNTIME_OPTIONS,
    readonly trim: Trim = NO_TRIM,
    /** what the road's bridge sections look like (deck thickness, piers, railings …) */
    readonly bridge: BridgeData = DEFAULT_BRIDGE,
  ) {
    this.def = def;
    this.profile = profile;
    this.seed = hashString(def.id);
    this.smoothRadiusM = profile.smoothRadiusM ?? opts.smoothRadiusM;
    this.surfY = {
      left: profileHeightAt(profile, -profile.coreHalfWidth),
      centre: profileHeightAt(profile, 0),
      right: profileHeightAt(profile, profile.coreHalfWidth),
    };
    this.sampled = sampleRoad(def, opts.sample, trim);
    this.samples = this.sampled.samples;
    const n = this.samples.length;
    this.lat = Array.from({ length: 5 }, () => new Float64Array(n).fill(NaN));
    this.ground = new Float64Array(n).fill(NaN);
    this.designY = new Float64Array(n).fill(NaN);
    this.innerSettled = new Uint8Array(n);
    this.outerSettled = new Uint8Array(n);
    this.authored = Float64Array.from(this.samples, (s) => s.pos.y);
    this.sArr = Float64Array.from(this.samples, (s) => s.s);
    this.fixedW = Float64Array.from(this.samples, (s) => s.fixedWeight);
    // horizontal right vector (banking-free) for lateral terrain probes
    this.rightHx = new Float64Array(n);
    this.rightHz = new Float64Array(n);
    this.samples.forEach((s, i) => {
      const f0 = makeFrame(s.tangent, 0);
      this.rightHx[i] = f0.right.x;
      this.rightHz[i] = f0.right.z;
    });
    this.window = this.samples.map((_, i) => windowRange(this.sArr, i, dependencyRadius(this.smoothRadiusM, true)));

    let i0 = 0;
    for (let i = 1; i < n; i++) {
      if (this.samples[i].s - this.samples[i0].s >= opts.chunkLengthM || i === n - 1) {
        this.chunks.push({ index: this.chunks.length, i0, i1: i, state: 'pending' });
        i0 = i;
      }
    }
    if (this.chunks.length === 0 && n >= 2) this.chunks.push({ index: 0, i0: 0, i1: n - 1, state: 'pending' });
  }

  /** the other roads of the same system (bridge piers keep clear of roads that pass underneath); set by the RoadSystem */
  siblings: () => readonly RoadRuntime[] = () => [];

  /** stretches of the road's edge that stay open because a branch leaves or joins there (set by the RoadSystem, see attach.ts) */
  openings: readonly EdgeOpening[] = [];
  /** track switches that leave this road (set by the RoadSystem) */
  switches: readonly SwitchInfo[] = [];
  /** signature of the roads running under this road's bridges and of the openings: the road is rebuilt when it changes */
  envKey = '';

  /** resolves a bridge type by name (set by the RoadSystem): a point may name its own type, see RoadPoint.bridge */
  namedBridge: (name: string) => BridgeData = () => this.bridge;
  private bridgeCache = new Map<string, BridgeData>();
  private pointBridgeNames: Array<string | undefined> | null = null;

  /** the bridge type named for the segment a sample lies on (undefined = the road's own) */
  bridgeNameAt(sampleIndex: number): string | undefined {
    if (!this.pointBridgeNames) {
      const names: Array<string | undefined> = [];
      this.def.points.forEach((p, k) => { names.push(p.bridge ?? (k > 0 ? names[k - 1] : undefined)); });
      this.pointBridgeNames = names;
    }
    return this.pointBridgeNames[Math.min(this.samples[sampleIndex].seg, this.pointBridgeNames.length - 1)];
  }

  /** what the bridge looks like at a sample: the type named by the nearest point before it, else the road's own */
  bridgeOfSample(sampleIndex: number): BridgeData {
    const name = this.bridgeNameAt(sampleIndex);
    if (name === undefined) return this.bridge;
    let b = this.bridgeCache.get(name);
    if (!b) { b = this.namedBridge(name); this.bridgeCache.set(name, b); }
    return b;
  }

  /** is arc length s on `side` (+1 = right) inside an opening? */
  isOpen(side: 1 | -1, s: number): boolean {
    for (const o of this.openings) if (o.side === side && s >= o.s0 && s <= o.s1) return true;
    return false;
  }

  /** Design height at authored point k (falls back to its authored y until the chunk is built). */
  pointDesignY(k: number): number {
    const y = this.designY[this.sampled.pointSample[k]];
    return Number.isNaN(y) ? this.def.points[k].y : y;
  }

  /** Terrain height at a THREE-space position, or null while that spot hasn't settled (props, guardrail rules). */
  groundAtThree(x: number, zThree: number): number | null {
    const z = flipZ(zThree);
    if (!this.terrain.isSettledAt(x, z)) return null;
    return this.terrain.heightAt(x, z);
  }

  /** Sample index at a road end (after trimming). */
  endIndex(end: End): number {
    return end === 'start' ? 0 : this.samples.length - 1;
  }

  /** The chunk that contains a road end. */
  endChunk(end: End): RoadChunk {
    return end === 'start' ? this.chunks[0] : this.chunks[this.chunks.length - 1];
  }

  endReady(end: End): boolean {
    return this.endChunk(end).state === 'ready';
  }

  /** Cross-section at a road end: centre (at design height), frame, and the carriageway half width. */
  endCross(end: End): { index: number; pos: Vector3; frame: Frame; halfCore: number; halfCarriage: number; widthScale: number } {
    const index = this.endIndex(end);
    const s = this.samples[index];
    return {
      index,
      pos: new Vector3(s.pos.x, this.designY[index], s.pos.z),
      frame: this.designFrame(index),
      halfCore: this.profile.coreHalfWidth * s.widthScale,
      halfCarriage: this.profile.carriageHalfWidth * s.widthScale,
      widthScale: s.widthScale,
    };
  }

  get pendingCount(): number {
    let c = 0;
    for (const ch of this.chunks) if (ch.state === 'pending') c++;
    return c;
  }

  /** Bridge samples read the terrain too (piers stand on it), although their height never follows it. */
  private needsGround(j: number): boolean {
    return this.fixedW[j] < 1 || this.samples[j].mode === 'bridge';
  }

  private bridgeProfile: ProfilePoint[] | null = null;

  /** The profile's points as they are on a bridge: everything beyond the carriageway (verges, ditches) collapses onto
   * the carriageway's edge — same number of points, so a chunk can mix road and bridge rings. */
  bridgePoints(): ProfilePoint[] {
    if (!this.bridgeProfile) {
      const c = this.profile.coreHalfWidth;
      const yl = profileHeightInside(this.profile, -c), yr = profileHeightInside(this.profile, c);
      this.bridgeProfile = this.profile.points.map((p) => (Math.abs(p.x) <= c + 1e-9 ? p : { x: Math.sign(p.x) * c + 0, y: p.x < 0 ? yl : yr }));
    }
    return this.bridgeProfile;
  }

  /** Lateral offset (m) of probe `k` at sample j. */
  private probeOffset(j: number, k: number): number {
    const w = this.samples[j].widthScale;
    const { coreHalfWidth: c, outerHalfWidth: o } = this.profile;
    switch (k) {
      case LAT.OUTER_L: return -o * w;
      case LAT.CORE_L: return -c * w;
      case LAT.CENTRE: return 0;
      case LAT.CORE_R: return c * w;
      default: return o * w;
    }
  }

  /** Reads terrain at probe k; false if that spot hasn't settled yet. */
  private probe(j: number, k: number): boolean {
    const p = this.samples[j].pos;
    const off = this.probeOffset(j, k);
    const x = p.x + this.rightHx[j] * off;
    const zThree = p.z + this.rightHz[j] * off;
    const z = flipZ(zThree);
    if (!this.terrain.isSettledAt(x, z)) return false;
    const h = this.terrain.heightAt(x, z);
    if (h === null) return false;
    this.lat[k][j] = h;
    return true;
  }

  private isInnerSettled(j: number): boolean {
    if (this.innerSettled[j]) return true;
    for (const k of [LAT.CORE_L, LAT.CENTRE, LAT.CORE_R]) {
      if (Number.isNaN(this.lat[k][j]) && !this.probe(j, k)) return false;
    }
    // the surface must clear the terrain at the carriageway edges too, where the profile (crown) lies below the design line
    this.ground[j] = Math.max(
      this.lat[LAT.CORE_L][j] - this.surfY.left,
      this.lat[LAT.CENTRE][j] - this.surfY.centre,
      this.lat[LAT.CORE_R][j] - this.surfY.right,
    );
    this.innerSettled[j] = 1;
    return true;
  }

  private isOuterSettled(j: number): boolean {
    if (this.outerSettled[j]) return true;
    for (const k of [LAT.OUTER_L, LAT.OUTER_R]) {
      if (Number.isNaN(this.lat[k][j]) && !this.probe(j, k)) return false;
    }
    this.outerSettled[j] = 1;
    return true;
  }

  /** Sample range whose design height a chunk resolves: the chunk plus one sample on each
   * side, so frames (pitch) at the chunk borders match the neighbouring chunk exactly. */
  private heightRange(chunk: RoadChunk): [number, number] {
    return [Math.max(0, chunk.i0 - 1), Math.min(this.samples.length - 1, chunk.i1 + 1)];
  }

  /** True when every terrain sample this chunk's geometry depends on has settled. */
  chunkReady(chunk: RoadChunk): boolean {
    const [h0, h1] = this.heightRange(chunk);
    const lo = this.window[h0][0];
    const hi = this.window[h1][1];
    for (let j = lo; j <= hi; j++) {
      if (this.needsGround(j) && !this.isInnerSettled(j)) return false;
    }
    for (let j = chunk.i0; j <= chunk.i1; j++) {
      if (this.needsGround(j) && !this.isOuterSettled(j)) return false;
    }
    return true;
  }

  /** Resolves design heights for the chunk if (and only if) it is ready. */
  tryBuildChunk(chunk: RoadChunk): boolean {
    if (chunk.state === 'ready') return false;
    if (!this.chunkReady(chunk)) return false;
    const inp = { s: this.sArr, ground: this.ground, authored: this.authored, fixedWeight: this.fixedW };
    const [h0, h1] = this.heightRange(chunk);
    for (let i = h0; i <= h1; i++) {
      const y = designHeightAt(inp, i, this.smoothRadiusM, { dilate: true }) + this.opts.clearanceM * (1 - this.fixedW[i]);
      // the approach ramp towards a fixed point (a bridge end, say) blends terrain-following with the authored height and
      // could dip below the terrain: a road is never buried — only fully fixed samples keep exactly their authored height
      const buried = this.fixedW[i] < 1 && Number.isFinite(this.ground[i]) ? this.ground[i] + this.opts.clearanceM : -Infinity;
      this.designY[i] = Math.max(y, buried);
    }
    chunk.state = 'ready';
    return true;
  }

  /** Cross-section frame at sample i from the DESIGN height profile (pitch + banking).
   * Valid for samples of a ready chunk. */
  designFrame(i: number): Frame {
    const a = Math.max(0, i - 1);
    const b = Math.min(this.samples.length - 1, i + 1);
    const pa = this.samples[a].pos;
    const pb = this.samples[b].pos;
    const t = new Vector3(pb.x - pa.x, this.designY[b] - this.designY[a], pb.z - pa.z);
    if (t.lengthSq() < 1e-12) t.copy(this.samples[i].tangent);
    return makeFrame(t, this.samples[i].banking);
  }
}
