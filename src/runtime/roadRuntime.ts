// Per-road runtime state: samples, chunks, and the lazy "wait until the terrain
// has settled" height resolution — the same idiom as riverField.resync(): a
// chunk is built once every sample it depends on is settled, never before, so
// nothing is baked onto a coarse fallback height that later floats.

import type { RoadDef } from '../network/types';
import type { TerrainSource } from '../core/terrain';
import { designHeightAt, windowRange } from '../core/alignment';
import { sampleRoad, DEFAULT_SAMPLE_OPTIONS, type RoadSample, type SampledRoad, type SampleOptions } from '../core/sampling';
import { flipZ } from '../core/world';

export interface RoadRuntimeOptions {
  sample: SampleOptions;
  /** target chunk length along the path, metres */
  chunkLengthM: number;
  /** drape smoothing radius, metres (profile-dependent from Phase 2 on) */
  smoothRadiusM: number;
}

export const DEFAULT_RUNTIME_OPTIONS: RoadRuntimeOptions = {
  sample: DEFAULT_SAMPLE_OPTIONS,
  chunkLengthM: 64,
  smoothRadiusM: 12,
};

export type ChunkState = 'pending' | 'ready';

export interface RoadChunk {
  index: number;
  /** inclusive sample range; neighbouring chunks share their boundary sample */
  i0: number;
  i1: number;
  state: ChunkState;
}

export class RoadRuntime {
  readonly def: RoadDef;
  readonly sampled: SampledRoad;
  readonly samples: RoadSample[];
  readonly chunks: RoadChunk[] = [];
  /** terrain height per sample (NaN = not yet read) */
  readonly ground: Float64Array;
  /** final design height per sample (NaN until its chunk is ready) */
  readonly designY: Float64Array;
  private readonly settled: Uint8Array;
  private readonly authored: Float64Array;
  private readonly sArr: Float64Array;
  private readonly fixedW: Float64Array;
  private readonly window: Array<[number, number]>;

  constructor(
    def: RoadDef,
    private readonly terrain: TerrainSource,
    readonly opts: RoadRuntimeOptions = DEFAULT_RUNTIME_OPTIONS,
  ) {
    this.def = def;
    this.sampled = sampleRoad(def, opts.sample);
    this.samples = this.sampled.samples;
    const n = this.samples.length;
    this.ground = new Float64Array(n).fill(NaN);
    this.designY = new Float64Array(n).fill(NaN);
    this.settled = new Uint8Array(n);
    this.authored = Float64Array.from(this.samples, (s) => s.pos.y);
    this.sArr = Float64Array.from(this.samples, (s) => s.s);
    this.fixedW = Float64Array.from(this.samples, (s) => s.fixedWeight);
    this.window = this.samples.map((_, i) => windowRange(this.sArr, i, opts.smoothRadiusM));

    let i0 = 0;
    for (let i = 1; i < n; i++) {
      if (this.samples[i].s - this.samples[i0].s >= opts.chunkLengthM || i === n - 1) {
        this.chunks.push({ index: this.chunks.length, i0, i1: i, state: 'pending' });
        i0 = i;
      }
    }
    if (this.chunks.length === 0 && n >= 2) this.chunks.push({ index: 0, i0: 0, i1: n - 1, state: 'pending' });
  }

  get pendingCount(): number {
    let c = 0;
    for (const ch of this.chunks) if (ch.state === 'pending') c++;
    return c;
  }

  private needsGround(j: number): boolean {
    return this.fixedW[j] < 1;
  }

  private isSampleSettled(j: number): boolean {
    if (this.settled[j]) return true;
    const p = this.samples[j].pos;
    if (!this.terrain.isSettledAt(p.x, flipZ(p.z))) return false;
    const h = this.terrain.heightAt(p.x, flipZ(p.z));
    if (h === null) return false;
    this.ground[j] = h;
    this.settled[j] = 1;
    return true;
  }

  /** True when every terrain sample this chunk's heights depend on has settled. */
  chunkReady(chunk: RoadChunk): boolean {
    const lo = this.window[chunk.i0][0];
    const hi = this.window[chunk.i1][1];
    for (let j = lo; j <= hi; j++) {
      if (this.needsGround(j) && !this.isSampleSettled(j)) return false;
    }
    return true;
  }

  /** Resolves design heights for the chunk if (and only if) it is ready. */
  tryBuildChunk(chunk: RoadChunk): boolean {
    if (chunk.state === 'ready') return false;
    if (!this.chunkReady(chunk)) return false;
    const inp = { s: this.sArr, ground: this.ground, authored: this.authored, fixedWeight: this.fixedW };
    for (let i = chunk.i0; i <= chunk.i1; i++) {
      this.designY[i] = designHeightAt(inp, i, this.opts.smoothRadiusM);
    }
    chunk.state = 'ready';
    return true;
  }
}
