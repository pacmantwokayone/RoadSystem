// The `B` API handed to bridge code:
//
//   export const params = { span: { type: 'float', min: 12, max: 60, default: 28 } };
//   export default (p, B) => B.bridge('Balkenbrücke')
//     .deck({ thickness: 0.9, material: 'concrete' })
//     .girders({ count: 3, depth: 1.2 })
//     .piers({ maxSpan: p.span, shape: 'twin', width: 1.2 })
//     .abutments({ depth: 2.5, wing: 6 })
//     .railing('steel');
//
// Every option is validated and clamped in `finish()`, so a typo can't produce broken geometry.

import { sidesOfSafe } from './util';
import type {
  AbutmentSpec, ArchSpec, BridgeData, BridgeLampSpec, DeckSpec, GirderSpec, PierSpec, PierShape, RailingSpec, RailingType, SpandrelType, TrussSpec,
} from './types';
import { DEFAULT_BRIDGE } from './types';

const num = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const str = (v: unknown, d: string): string => (typeof v === 'string' && v ? v : d);
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : d);

export type DeckOpts = Partial<DeckSpec>;
export type GirderOpts = Partial<GirderSpec>;
export type PierOpts = Partial<PierSpec>;
export type AbutmentOpts = Partial<AbutmentSpec>;
export type RailingOpts = Partial<RailingSpec>;
export type ArchOpts = Partial<ArchSpec>;
export type TrussOpts = Partial<TrussSpec>;
export type LampOpts = Partial<BridgeLampSpec>;

export class BridgeBuilder {
  private _deck: DeckSpec = { ...DEFAULT_BRIDGE.deck };
  private _girders: GirderSpec | null = null;
  private _piers: PierSpec | null = null;
  private _abutments: AbutmentSpec = { ...DEFAULT_BRIDGE.abutments };
  private _railing: RailingSpec = { ...DEFAULT_BRIDGE.railing };
  private _arch: ArchSpec | null = null;
  private _truss: TrussSpec | null = null;
  private _lamps: BridgeLampSpec | null = null;

  constructor(readonly name: string) {}

  deck(o: DeckOpts = {}): this {
    this._deck = { thickness: num(o.thickness, 0.1, 6, this._deck.thickness), material: str(o.material, this._deck.material) };
    return this;
  }

  /** Longitudinal beams under the deck. */
  girders(o: GirderOpts = {}): this {
    this._girders = {
      count: Math.round(num(o.count, 1, 8, 3)), depth: num(o.depth, 0.1, 6, 1.2), width: num(o.width, 0.1, 3, 0.5),
      spread: num(o.spread, 0, 1, 0.75), material: str(o.material, this._deck.material),
    };
    return this;
  }

  /** Supports under the deck, as many as the span asks for; they grow down to the terrain. */
  piers(o: PierOpts = {}): this {
    const shape = oneOf<PierShape>(o.shape, ['column', 'wall', 'twin', 'hammer'], 'column');
    this._piers = {
      maxSpan: num(o.maxSpan, 6, 150, 28), shape, width: num(o.width, 0.2, 12, 1.2), depth: num(o.depth, 0.2, 8, 1.2),
      taper: num(o.taper, 0, 0.8, 0), cap: o.cap ?? shape === 'hammer', capHeight: num(o.capHeight, 0.2, 3, 0.9),
      minHeight: num(o.minHeight, 0, 50, 2), round: o.round ?? false, footing: num(o.footing, 0, 3, 0.4), material: str(o.material, this._deck.material),
    };
    return this;
  }

  abutments(o: AbutmentOpts = {}): this {
    this._abutments = { depth: num(o.depth, 0.5, 12, 2.5), wing: num(o.wing, 0, 30, 5), material: str(o.material, this._deck.material) };
    return this;
  }

  /** `'steel'`, `'parapet'`, `'timber'`, `'none'`, or `{ type, height, material }`. */
  railing(o: RailingType | RailingOpts = {}): this {
    const opts: RailingOpts = typeof o === 'string' ? { type: o } : o;
    const type = oneOf<RailingType>(opts.type, ['steel', 'parapet', 'timber', 'none'], 'steel');
    const defaults: Record<RailingType, { h: number; m: string }> = { steel: { h: 1.1, m: 'steel' }, parapet: { h: 1.0, m: 'concrete_barrier' }, timber: { h: 1.1, m: 'wood' }, none: { h: 0, m: 'steel' } };
    this._railing = { type, height: num(opts.height, 0.3, 3, defaults[type].h), material: str(opts.material, defaults[type].m) };
    return this;
  }

  /** Arch ribs below the deck (open spandrel columns or solid fill). */
  arch(o: ArchOpts = {}): this {
    this._arch = {
      rise: num(o.rise, 0.08, 0.5, 0.22), ribs: Math.round(num(o.ribs, 1, 6, 2)), ribWidth: num(o.ribWidth, 0.3, 4, 1.0), ribDepth: num(o.ribDepth, 0.3, 3, 0.9),
      spandrel: oneOf<SpandrelType>(o.spandrel, ['columns', 'solid', 'none'], 'columns'), spandrelSpacing: num(o.spandrelSpacing, 2, 20, 6),
      spread: num(o.spread, 0, 1, 0.8), material: str(o.material, this._deck.material),
    };
    return this;
  }

  /** Steel truss (Fachwerk) along both sides, standing above the deck. */
  truss(o: TrussOpts = {}): this {
    this._truss = { height: num(o.height, 2, 14, 5.5), panel: num(o.panel, 2, 20, 5), chord: num(o.chord, 0.1, 1.5, 0.35), material: str(o.material, 'steel_dark') };
    return this;
  }

  /** Street lamps along the deck edges. */
  lamps(o: LampOpts = {}): this {
    this._lamps = { asset: str(o.asset, 'lamp_small'), spacing: num(o.spacing, 5, 120, 30), side: sidesOfSafe(o.side) };
    return this;
  }

  finish(): BridgeData {
    return {
      name: this.name, deck: this._deck, girders: this._girders, piers: this._piers, abutments: this._abutments,
      railing: this._railing, arch: this._arch, truss: this._truss, lamps: this._lamps,
    };
  }
}

export interface BridgeApi {
  bridge(name: string): BridgeBuilder;
  clamp(v: number, lo: number, hi: number): number;
  lerp(a: number, b: number, t: number): number;
}

export const bridgeApi: BridgeApi = {
  bridge: (name) => new BridgeBuilder(name),
  clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
  lerp: (a, b, t) => a + (b - a) * t,
};
