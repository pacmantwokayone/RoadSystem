// Persistence contract. Mirrors the game's rivers idiom (one JSON document per
// location, whole-document replace) and adds an OPTIONAL revision for optimistic
// locking: a save names the revision it was based on, a server that has moved
// on answers with a conflict instead of silently overwriting.

import type { RoadsDocument } from '../network/types';

export interface LibraryDocument {
  version: 1;
  revision?: number;
  /** profile name → source code */
  profiles: Record<string, string>;
}

export type SaveResult =
  | { ok: true; revision: number }
  | { ok: false; conflict: true; serverRevision?: number }
  | { ok: false; conflict: false; error: string };

export interface RoadStore {
  /** null = nothing stored yet (or unreachable) */
  loadRoads(location: string): Promise<RoadsDocument | null>;
  saveRoads(location: string, doc: RoadsDocument, baseRevision?: number): Promise<SaveResult>;
  loadLibrary(): Promise<LibraryDocument | null>;
  saveLibrary(doc: LibraryDocument, baseRevision?: number): Promise<SaveResult>;
}

export function sanitizeLibraryDocument(raw: unknown): LibraryDocument {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const profiles: Record<string, string> = {};
  if (typeof obj.profiles === 'object' && obj.profiles !== null) {
    for (const [k, v] of Object.entries(obj.profiles)) if (typeof v === 'string' && k) profiles[k] = v;
  }
  const doc: LibraryDocument = { version: 1, profiles };
  if (typeof obj.revision === 'number' && Number.isFinite(obj.revision)) doc.revision = Math.max(0, Math.floor(obj.revision));
  return doc;
}
