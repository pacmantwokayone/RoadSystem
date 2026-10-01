// In-memory store with real revision semantics (tests, and the reference
// behaviour a server implementation must match).

import { sanitizeRoadsDocument } from '../network/doc';
import type { RoadsDocument } from '../network/types';
import { sanitizeLibraryDocument, type LibraryDocument, type RoadStore, type SaveResult } from './types';

export class MemoryStore implements RoadStore {
  private roads = new Map<string, RoadsDocument>();
  private library: LibraryDocument | null = null;

  async loadRoads(location: string): Promise<RoadsDocument | null> {
    const d = this.roads.get(location);
    return d ? structuredClone(d) : null;
  }

  async saveRoads(location: string, doc: RoadsDocument, baseRevision?: number): Promise<SaveResult> {
    const cur = this.roads.get(location);
    const curRev = cur?.revision ?? 0;
    if (baseRevision !== undefined && cur && baseRevision !== curRev) return { ok: false, conflict: true, serverRevision: curRev };
    const next = sanitizeRoadsDocument(doc);
    next.revision = curRev + 1;
    this.roads.set(location, next);
    return { ok: true, revision: next.revision };
  }

  async loadLibrary(): Promise<LibraryDocument | null> {
    return this.library ? structuredClone(this.library) : null;
  }

  async saveLibrary(doc: LibraryDocument, baseRevision?: number): Promise<SaveResult> {
    const curRev = this.library?.revision ?? 0;
    if (baseRevision !== undefined && this.library && baseRevision !== curRev) return { ok: false, conflict: true, serverRevision: curRev };
    const next = sanitizeLibraryDocument(doc);
    next.revision = curRev + 1;
    this.library = next;
    return { ok: true, revision: next.revision };
  }
}
