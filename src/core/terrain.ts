// The only thing the road system knows about the game's terrain. Shaped to be
// satisfied directly by the game's StreamTerrain (coordinates are SIM space).

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface TerrainSource {
  /** Ground height at sim (x, z). `null` while nothing there has streamed in.
   * May return a coarse fallback height before the tile is settled. */
  heightAt(x: number, z: number): number | null;
  /** True once the finest tile that will EVER cover (x, z) is loaded — the
   * height is then final and safe to bake permanent geometry onto. */
  isSettledAt(x: number, z: number): boolean;
}
