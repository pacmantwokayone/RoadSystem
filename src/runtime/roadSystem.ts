// Owns all RoadRuntimes of a location and drives them with a cheap, budgeted
// per-frame resync() — the same shape as RiverField.resync()/PowerLines.resync(),
// but with an explicit budget because a road network is much larger than a
// handful of rivers.

import type { RoadDef } from '../network/types';
import type { TerrainSource } from '../core/terrain';
import { RoadRuntime, DEFAULT_RUNTIME_OPTIONS, type RoadChunk, type RoadRuntimeOptions } from './roadRuntime';

export interface ResyncBudget {
  /** how many pending chunks to inspect per call */
  checks: number;
  /** how many chunks may actually be built per call */
  builds: number;
}

export const DEFAULT_BUDGET: ResyncBudget = { checks: 256, builds: 4 };

export type ChunkListener = (road: RoadRuntime, chunk: RoadChunk) => void;

export class RoadSystem {
  private roads: RoadRuntime[] = [];
  private pending: Array<{ road: RoadRuntime; chunk: RoadChunk }> = [];
  private cursor = 0;
  private listeners = new Set<ChunkListener>();

  constructor(
    private readonly terrain: TerrainSource,
    private readonly opts: RoadRuntimeOptions = DEFAULT_RUNTIME_OPTIONS,
  ) {}

  get runtimes(): readonly RoadRuntime[] {
    return this.roads;
  }

  /** Whole-list replace, like RiverField.setRivers(). */
  setRoads(defs: RoadDef[]): void {
    this.roads = [];
    this.pending = [];
    this.cursor = 0;
    for (const def of defs) {
      if (def.points.length < 2) continue;
      const rt = new RoadRuntime(def, this.terrain, this.opts);
      this.roads.push(rt);
      for (const chunk of rt.chunks) this.pending.push({ road: rt, chunk });
    }
  }

  /** Called whenever a chunk's heights have been resolved (Phase 2: build its mesh here). */
  onChunkReady(cb: ChunkListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  stats(): { chunks: number; ready: number } {
    let chunks = 0;
    let ready = 0;
    for (const r of this.roads) {
      chunks += r.chunks.length;
      ready += r.chunks.length - r.pendingCount;
    }
    return { chunks, ready };
  }

  /** Cheap per-frame poll. Returns the number of chunks built this call. */
  resync(budget: ResyncBudget = DEFAULT_BUDGET): number {
    let built = 0;
    let checks = 0;
    const n = this.pending.length;
    let visited = 0;
    while (visited < n && checks < budget.checks && built < budget.builds) {
      if (this.cursor >= this.pending.length) this.cursor = 0;
      const entry = this.pending[this.cursor];
      visited++;
      checks++;
      if (entry.road.tryBuildChunk(entry.chunk)) {
        built++;
        this.pending.splice(this.cursor, 1);
        for (const cb of this.listeners) cb(entry.road, entry.chunk);
      } else {
        this.cursor++;
      }
    }
    return built;
  }
}
