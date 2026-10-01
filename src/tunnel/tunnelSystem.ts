// Keeps the terrain cut in front of tunnel portals in sync with the roads: when a road with a tunnel section is added or edited, the portals
// are found, the cutting field is rebuilt, the terrain is regenerated there (after a short debounce) and the roads near it are rebuilt
// on the new ground.

import type { RoadSystem } from '../runtime/roadSystem';
import type { ModifierFn } from '../terrain/mockStreamTerrain';
import type { Rect } from '../core/terrain';
import { portalsOf, TunnelField, type Portal } from './field';
import { tunnelSections } from './sections';

export interface TunnelTerrain {
  setModifier?(id: string, fn: ModifierFn | null): void;
  invalidate?(rect?: Rect): number;
}

const union = (a: Rect | null, b: Rect | null): Rect | null => (!a ? b : !b ? a : { minX: Math.min(a.minX, b.minX), minZ: Math.min(a.minZ, b.minZ), maxX: Math.max(a.maxX, b.maxX), maxZ: Math.max(a.maxZ, b.maxZ) });

export class TunnelSystem {
  private key = '';
  private field = new TunnelField([]);
  private dirty: Rect | null = null;
  private since = 0;

  constructor(
    private readonly roads: RoadSystem,
    private readonly terrain: TunnelTerrain,
    private readonly debounceMs = 160,
    private readonly now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  ) {}

  get portals(): readonly Portal[] { return this.field.portals; }

  /** call once per frame */
  update(): void {
    const withTunnel = this.roads.runtimes.filter((rt) => tunnelSections(rt).length > 0);
    const key = withTunnel.map((rt) => `${rt.def.id}:${rt.def.points.map((p) => `${p.x.toFixed(1)},${p.z.toFixed(1)},${p.y.toFixed(1)},${p.mode ?? ''}`).join(';')}`).join('|');
    if (key !== this.key) {
      this.key = key;
      const before = this.field.bounds();
      const portals: Portal[] = [];
      for (const rt of withTunnel) portals.push(...portalsOf(rt));
      this.field = new TunnelField(portals);
      this.dirty = union(this.dirty, union(before, this.field.bounds()));
      this.since = this.now();
    }
    if (this.dirty && this.now() - this.since >= this.debounceMs) {
      const rect = this.dirty;
      this.dirty = null;
      const field = this.field;
      this.terrain.setModifier?.('tunnel', field.empty ? null : (x, z, b) => field.modify(x, z, b));
      this.terrain.invalidate?.(rect);
      this.roads.invalidateRect(rect, 0);
    }
  }
}
