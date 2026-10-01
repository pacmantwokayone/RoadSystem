// HTTP store for the game's PHP backend. Same shape as world/rivers.ts:
//   load : GET  <base>/roads-<location>.json   (static file), falling back to
//          GET  <base>/roads-save.php?location=<location>
//   save : POST <base>/roads-save.php   { location, roads, baseRevision? }
// Library: GET <base>/roadlib.json | roadlib-save.php, POST <base>/roadlib-save.php { profiles, baseRevision? }
//
// Revision protocol (backward-compatible extension of the rivers idiom):
//   - documents may carry `revision`
//   - a save sends `baseRevision`; the server answers 409 (optionally with
//     { revision } = its current one) if it has moved on, else 200 { ok, revision }
// A server that ignores revisions (200 without a body) still works: the client
// then assumes baseRevision + 1.

import { sanitizeRoadsDocument } from '../network/doc';
import type { RoadsDocument } from '../network/types';
import { sanitizeLibraryDocument, type LibraryDocument, type RoadStore, type SaveResult } from './types';

export interface HttpStoreOptions {
  /** API base, default `window.WINGSUIT_API ?? 'api'` like the game */
  base?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class HttpRoadStore implements RoadStore {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: HttpStoreOptions = {}) {
    this.base = opts.base ?? (globalThis as { WINGSUIT_API?: string }).WINGSUIT_API ?? 'api';
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  private async getJson(urls: string[]): Promise<unknown | null> {
    for (const url of urls) {
      try {
        const r = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (!r.ok) continue;
        return await r.json();
      } catch {
        // try the next shape; offline or no data yet means none
      }
    }
    return null;
  }

  private async post(url: string, body: unknown, baseRevision: number | undefined): Promise<SaveResult> {
    try {
      const r = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      let json: { revision?: unknown } = {};
      try { json = (await r.json()) as { revision?: unknown }; } catch { /* body optional */ }
      const rev = typeof json.revision === 'number' ? json.revision : undefined;
      if (r.status === 409) return { ok: false, conflict: true, serverRevision: rev };
      if (!r.ok) return { ok: false, conflict: false, error: `HTTP ${r.status}` };
      return { ok: true, revision: rev ?? (baseRevision ?? 0) + 1 };
    } catch (e) {
      return { ok: false, conflict: false, error: e instanceof Error ? e.message : 'network error' };
    }
  }

  async loadRoads(location: string): Promise<RoadsDocument | null> {
    const nc = Date.now();
    const raw = await this.getJson([
      `${this.base}/roads-${location}.json?nc=${nc}`,
      `${this.base}/roads-save.php?location=${encodeURIComponent(location)}&nc=${nc}`,
    ]);
    return raw === null ? null : sanitizeRoadsDocument(raw);
  }

  saveRoads(location: string, doc: RoadsDocument, baseRevision?: number): Promise<SaveResult> {
    return this.post(`${this.base}/roads-save.php`, { location, roads: doc.roads, nodes: doc.nodes ?? [], rivers: doc.rivers ?? [], lakes: doc.lakes ?? [], baseRevision }, baseRevision);
  }

  async loadLibrary(): Promise<LibraryDocument | null> {
    const nc = Date.now();
    const raw = await this.getJson([`${this.base}/roadlib.json?nc=${nc}`, `${this.base}/roadlib-save.php?nc=${nc}`]);
    return raw === null ? null : sanitizeLibraryDocument(raw);
  }

  saveLibrary(doc: LibraryDocument, baseRevision?: number): Promise<SaveResult> {
    return this.post(`${this.base}/roadlib-save.php`, { profiles: doc.profiles, materials: doc.materials ?? {}, bridges: doc.bridges ?? {}, waters: doc.waters ?? {}, baseRevision }, baseRevision);
  }
}
