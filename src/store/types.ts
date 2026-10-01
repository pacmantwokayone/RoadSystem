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
  /** material name → source code (optional: older documents have none) */
  materials?: Record<string, string>;
  /** bridge type name → source code (optional) */
  bridges?: Record<string, string>;
  /** water style name → source code (optional) */
  waters?: Record<string, string>;
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
  const strings = (raw: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (typeof raw === 'object' && raw !== null) {
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && k) out[k] = v;
    }
    return out;
  };
  const doc: LibraryDocument = { version: 1, profiles: strings(obj.profiles) };
  const materials = strings(obj.materials);
  if (Object.keys(materials).length) doc.materials = materials;
  const bridges = strings(obj.bridges);
  if (Object.keys(bridges).length) doc.bridges = bridges;
  const waters = strings(obj.waters);
  if (Object.keys(waters).length) doc.waters = waters;
  if (typeof obj.revision === 'number' && Number.isFinite(obj.revision)) doc.revision = Math.max(0, Math.floor(obj.revision));
  return doc;
}
