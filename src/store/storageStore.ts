// localStorage-backed store (demo / offline). Same revision semantics as the server.

import { sanitizeRoadsDocument } from '../network/doc';
import type { RoadsDocument } from '../network/types';
import { sanitizeLibraryDocument, type LibraryDocument, type RoadStore, type SaveResult } from './types';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class StorageStore implements RoadStore {
  constructor(private readonly storage: StorageLike, private readonly prefix = 'roadsystem') {}

  private read(key: string): unknown {
    try {
      const raw = this.storage.getItem(`${this.prefix}:${key}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: unknown): string | null {
    try {
      this.storage.setItem(`${this.prefix}:${key}`, JSON.stringify(value));
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : 'storage error';
    }
  }

  async loadRoads(location: string): Promise<RoadsDocument | null> {
    const raw = this.read(`roads:${location}`);
    return raw ? sanitizeRoadsDocument(raw) : null;
  }

  async saveRoads(location: string, doc: RoadsDocument, baseRevision?: number): Promise<SaveResult> {
    const cur = await this.loadRoads(location);
    const curRev = cur?.revision ?? 0;
    if (baseRevision !== undefined && cur && baseRevision !== curRev) return { ok: false, conflict: true, serverRevision: curRev };
    const next = sanitizeRoadsDocument(doc);
    next.revision = curRev + 1;
    const err = this.write(`roads:${location}`, next);
    return err ? { ok: false, conflict: false, error: err } : { ok: true, revision: next.revision };
  }

  async loadLibrary(): Promise<LibraryDocument | null> {
    const raw = this.read('library');
    return raw ? sanitizeLibraryDocument(raw) : null;
  }

  async saveLibrary(doc: LibraryDocument, baseRevision?: number): Promise<SaveResult> {
    const cur = await this.loadLibrary();
    const curRev = cur?.revision ?? 0;
    if (baseRevision !== undefined && cur && baseRevision !== curRev) return { ok: false, conflict: true, serverRevision: curRev };
    const next = sanitizeLibraryDocument(doc);
    next.revision = curRev + 1;
    const err = this.write('library', next);
    return err ? { ok: false, conflict: false, error: err } : { ok: true, revision: next.revision };
  }
}
