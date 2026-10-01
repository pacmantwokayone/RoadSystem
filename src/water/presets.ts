// Built-in water styles — plain code, editable in the editor. Colours and sizes are plausible alpine waters.

export const BACH = `
// Bach: schmal, klar, viele Steine, weisse Stromschnellen
export const params = {
  width: { type: 'float', label: 'Breite', min: 1, max: 8, step: 0.1, default: 2.6 },
  rocks: { type: 'float', label: 'Steine / 100 m', min: 0, max: 60, step: 1, default: 16 },
};
export default (p, W) => W.river('Bach')
  .size(p.width, 0.5)
  .colors({ shallow: 0x8fd6cc, deep: 0x2f7c86, foam: 0xf6fafb })
  .clarity(0.85)
  .flow({ speed: 1.8, ripple: 0.7, turbulence: 0.35, streaks: 0.55 })
  .banks({ width: 3, slope: 0.7, material: 'gravel', strip: 0.9 })
  .rocks({ density: p.rocks, min: 0.25, max: 1.2, inWater: 0.5 })
  .foam({ edge: 0.6, obstacles: 0.95, rapids: 0.85, fall: 1 })
  .particles({ flecks: 1.2, size: 0.11, spray: 0.6, mist: 0.6 })
  .fall({ spread: 0.5, poolDepth: 2.5, poolRadius: 1.0, streak: 0.8, wallSlope: 3 });
`;

export const WILDBACH = `
// Wildbach: steil, schnell, weiss, grosse Blöcke
export const params = {
  width: { type: 'float', label: 'Breite', min: 2, max: 12, step: 0.1, default: 4.5 },
  rocks: { type: 'float', label: 'Blöcke / 100 m', min: 0, max: 80, step: 1, default: 34 },
};
export default (p, W) => W.river('Wildbach')
  .size(p.width, 0.7)
  .colors({ shallow: 0x9edad0, deep: 0x3b8a8f, foam: 0xffffff })
  .clarity(0.7)
  .flow({ speed: 3.4, ripple: 0.9, turbulence: 0.5, streaks: 0.8 })
  .banks({ width: 4, slope: 0.9, material: 'gravel', strip: 1.2 })
  .rocks({ density: p.rocks, min: 0.4, max: 2.2, inWater: 0.6, color: 0x7d7c78 })
  .foam({ edge: 0.8, obstacles: 1, rapids: 1, fall: 1 })
  .particles({ flecks: 2, size: 0.14, spray: 0.9, mist: 0.8 })
  .fall({ spread: 0.7, poolDepth: 4, poolRadius: 1.1, streak: 0.95, wallSlope: 3.5 });
`;

export const FLUSS = `
// Fluss: breit, ruhig, grünlich
export const params = {
  width: { type: 'float', label: 'Breite', min: 6, max: 40, step: 0.5, default: 14 },
};
export default (p, W) => W.river('Fluss')
  .size(p.width, 2.4)
  .colors({ shallow: 0x8fbfa8, deep: 0x1d4a4f, foam: 0xf2f6f4 })
  .clarity(0.45)
  .flow({ speed: 1.3, ripple: 0.5, turbulence: 0.1, streaks: 0.4 })
  .banks({ width: 7, slope: 0.35, material: 'gravel_fine', strip: 2.5 })
  .rocks({ density: 5, min: 0.3, max: 1.4, inWater: 0.35 })
  .foam({ edge: 0.35, obstacles: 0.7, rapids: 0.7, fall: 1 })
  .particles({ flecks: 0.7, size: 0.16, spray: 0.4, mist: 0.5 })
  .fall({ spread: 0.4, poolDepth: 5, poolRadius: 0.8, streak: 0.7, wallSlope: 1.4 });
`;

export const STROM = `
// Strom: sehr breit, träge, trüb
export const params = {
  width: { type: 'float', label: 'Breite', min: 20, max: 120, step: 1, default: 40 },
};
export default (p, W) => W.river('Strom')
  .size(p.width, 5)
  .colors({ shallow: 0x8a9c7a, deep: 0x26403a, foam: 0xeeeeea })
  .clarity(0.25)
  .flow({ speed: 1.0, ripple: 0.35, turbulence: 0.05, streaks: 0.3 })
  .banks({ width: 12, slope: 0.25, material: 'gravel_fine', strip: 4 })
  .rocks({ density: 2, min: 0.4, max: 1.6, inWater: 0.2 })
  .foam({ edge: 0.25, obstacles: 0.6, rapids: 0.6, fall: 1 })
  .particles({ flecks: 0.4, size: 0.22, spray: 0.3, mist: 0.4 })
  .fall({ spread: 0.3, poolDepth: 8, poolRadius: 0.7, streak: 0.6, wallSlope: 1.2 });
`;

export const BERGSEE = `
// Bergsee: klares Türkis, steinige Ufer
export const params = {
  waves: { type: 'float', label: 'Wellen', min: 0, max: 0.4, step: 0.01, default: 0.05 },
};
export default (p, W) => W.lake('Bergsee')
  .size(10, 9)
  .colors({ shallow: 0x86e6d8, deep: 0x0d4766, foam: 0xf6fafb })
  .clarity(0.9)
  .waves({ height: p.waves, scale: 9, speed: 0.6 })
  .flow({ ripple: 0.3 })
  .banks({ width: 7, slope: 0.4, material: 'gravel', strip: 2 })
  .rocks({ density: 7, min: 0.3, max: 1.6, inWater: 0.35 })
  .foam({ edge: 0.5, obstacles: 0.8, rapids: 0, fall: 1 })
  .particles({ flecks: 0.15, size: 0.1, spray: 0.2, mist: 0.2 });
`;

export const GLETSCHERSEE = `
// Gletschersee: milchig-türkis, trüb, kalt
export default (p, W) => W.lake('Gletschersee')
  .size(10, 14)
  .colors({ shallow: 0xa6ece0, deep: 0x2a8fa6, foam: 0xffffff })
  .clarity(0.18)
  .waves({ height: 0.03, scale: 12, speed: 0.4 })
  .banks({ width: 8, slope: 0.3, material: 'gravel_fine', strip: 3 })
  .rocks({ density: 4, min: 0.3, max: 1.8, inWater: 0.25, color: 0xa09d96 })
  .foam({ edge: 0.35, obstacles: 0.6, rapids: 0, fall: 1 });
`;

export const WEIHER = `
// Weiher: flach, grün-braun, ruhig
export default (p, W) => W.lake('Weiher')
  .size(10, 2.2)
  .colors({ shallow: 0x8aa078, deep: 0x2f4a38, foam: 0xe8ede4 })
  .clarity(0.3)
  .waves({ height: 0.02, scale: 5, speed: 0.3 })
  .banks({ width: 5, slope: 0.25, material: 'gravel_fine', strip: 2 })
  .rocks({ density: 3, min: 0.2, max: 0.9, inWater: 0.2 })
  .foam({ edge: 0.2, obstacles: 0.5, rapids: 0, fall: 1 })
  .particles({ flecks: 0.2, size: 0.16, spray: 0, mist: 0 });
`;

export const WATER_PRESET_SOURCES: Record<string, string> = {
  bach: BACH,
  wildbach: WILDBACH,
  fluss: FLUSS,
  strom: STROM,
  bergsee: BERGSEE,
  gletschersee: GLETSCHERSEE,
  weiher: WEIHER,
};
