// Bridge data: what a bridge definition (code, see builder.ts) evaluates to. A bridge is not a separate road —
// it is a SECTION of a road (consecutive points with mode 'bridge'). The road's own cross-section (clipped to
// the carriageway) is the deck; everything here is what holds it up and what stands on it.

import type { ProfileData } from '../profile/types';
import type { PropSide } from '../props/rules';

export type PierShape = 'column' | 'wall' | 'twin' | 'hammer';
export type RailingType = 'steel' | 'parapet' | 'timber' | 'none';
export type SpandrelType = 'columns' | 'solid' | 'none';

export interface DeckSpec {
  /** thickness of the slab below the road surface, metres */
  thickness: number;
  /** material of the underside and the sides of the deck */
  material: string;
}

export interface GirderSpec {
  /** longitudinal beams under the deck */
  count: number;
  /** height below the deck, metres */
  depth: number;
  width: number;
  /** 0..1: how far out the outermost girders sit (fraction of the deck's half width) */
  spread: number;
  material: string;
}

export interface PierSpec {
  /** longest span between supports, metres; the section is divided into equal spans */
  maxSpan: number;
  shape: PierShape;
  /** size across the road / along the road, metres */
  width: number;
  depth: number;
  /** 0..1: the foot is this much narrower than the top (a slim batter) */
  taper: number;
  /** a crossbeam on top of the pier (always for 'hammer') */
  cap: boolean;
  capHeight: number;
  /** spans over ground closer than this to the underside get no pier, metres */
  minHeight: number;
  round: boolean;
  /** footing larger than the pier by this much on every side, metres (0 = none) */
  footing: number;
  material: string;
}

export interface AbutmentSpec {
  /** length of the abutment block along the road, metres */
  depth: number;
  /** length of the wing walls that retain the embankment beside the road, metres (0 = none) */
  wing: number;
  material: string;
}

export interface RailingSpec {
  type: RailingType;
  height: number;
  material: string;
}

export interface ArchSpec {
  /** rise of the arch as a fraction of its span (0.1 … 0.5) */
  rise: number;
  ribs: number;
  ribWidth: number;
  ribDepth: number;
  /** what fills the space between arch and deck */
  spandrel: SpandrelType;
  /** distance between spandrel columns, metres */
  spandrelSpacing: number;
  spread: number;
  material: string;
}

export interface TrussSpec {
  /** height of the side trusses above the deck, metres */
  height: number;
  /** length of one panel (the distance between two verticals), metres */
  panel: number;
  /** thickness of the members, metres */
  chord: number;
  material: string;
}

export interface BridgeLampSpec {
  asset: string;
  spacing: number;
  side: PropSide;
}

export interface BridgeData {
  name: string;
  deck: DeckSpec;
  girders: GirderSpec | null;
  piers: PierSpec | null;
  abutments: AbutmentSpec;
  railing: RailingSpec;
  arch: ArchSpec | null;
  truss: TrussSpec | null;
  lamps: BridgeLampSpec | null;
}

export const DEFAULT_DECK: DeckSpec = { thickness: 0.9, material: 'concrete' };

export const DEFAULT_BRIDGE: BridgeData = {
  name: 'Standard',
  deck: DEFAULT_DECK,
  girders: null,
  piers: null,
  abutments: { depth: 2.5, wing: 5, material: 'concrete' },
  railing: { type: 'steel', height: 1.1, material: 'steel' },
  arch: null,
  truss: null,
  lamps: null,
};

/** The bridge type used for a road that doesn't name one: by importance of the road. */
export function defaultBridgeName(profile: ProfileData): string {
  if (profile.rank <= 1) return 'holzsteg';
  if (profile.rank <= 4) return 'plattenbruecke';
  if (profile.rank <= 6) return 'balkenbruecke';
  return 'viadukt';
}
