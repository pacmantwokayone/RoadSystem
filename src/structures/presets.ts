// Built-in bridge types — plain bridge code, editable like profiles. Dimensions are plausible approximations, not
// a structural design: they are meant to look right from a wingsuit, not to carry a load.

export const PLATTENBRUECKE = `
// Plattenbrücke: schlanke Betonplatte, kurze Spannweiten (Bach, kleine Strasse)
export const params = {
  maxSpan: { type: 'float', label: 'Max. Spannweite', min: 8, max: 30, step: 1, default: 16 },
  thickness: { type: 'float', label: 'Plattendicke', min: 0.4, max: 1.4, step: 0.05, default: 0.7 },
};
export default (p, B) => B.bridge('Plattenbrücke')
  .deck({ thickness: p.thickness, material: 'concrete' })
  .piers({ maxSpan: p.maxSpan, shape: 'wall', width: 3.5, depth: 0.8, minHeight: 1.5, footing: 0.3 })
  .abutments({ depth: 2.0, wing: 5 })
  .railing('steel');
`;

export const BALKENBRUECKE = `
// Balkenbrücke: Platte auf Längsträgern, Pfeiler mit Querriegel
export const params = {
  maxSpan: { type: 'float', label: 'Max. Spannweite', min: 15, max: 60, step: 1, default: 30 },
  girders:  { type: 'int',   label: 'Längsträger', min: 2, max: 6, default: 3 },
  railing:  { type: 'enum',  label: 'Geländer', options: ['steel', 'parapet'], default: 'steel' },
  lamps:    { type: 'bool',  label: 'Laternen', default: false },
};
export default (p, B) => {
  const b = B.bridge('Balkenbrücke')
    .deck({ thickness: 0.45, material: 'concrete' })
    .girders({ count: p.girders, depth: 1.1, width: 0.55, spread: 0.7 })
    .piers({ maxSpan: p.maxSpan, shape: 'hammer', width: 1.3, depth: 1.3, capHeight: 0.8, taper: 0.15, round: true, footing: 0.5, minHeight: 3 })
    .abutments({ depth: 2.8, wing: 7 })
    .railing(p.railing);
  if (p.lamps) b.lamps({ asset: 'lamp_small', spacing: 30, side: 'both' });
  return b;
};
`;

export const VIADUKT = `
// Viadukt: hoher Kastenträger auf schlanken Zwillingspfeilern (Autobahn, Talquerung)
export const params = {
  maxSpan: { type: 'float', label: 'Max. Spannweite', min: 25, max: 100, step: 1, default: 48 },
  box:     { type: 'float', label: 'Trägerhöhe', min: 1.2, max: 4, step: 0.1, default: 2.2 },
};
export default (p, B) => B.bridge('Viadukt')
  .deck({ thickness: p.box, material: 'concrete' })
  .piers({ maxSpan: p.maxSpan, shape: 'twin', width: 1.8, depth: 2.2, taper: 0.3, cap: true, capHeight: 1.2, footing: 0.8, minHeight: 4 })
  .abutments({ depth: 4, wing: 10 })
  .railing('parapet');
`;

export const BOGENBRUECKE = `
// Bogenbrücke: Steinbogen mit Zwickelstützen (Alpentäler)
export const params = {
  maxSpan:  { type: 'float', label: 'Spannweite', min: 15, max: 80, step: 1, default: 36 },
  rise:     { type: 'float', label: 'Pfeilhöhe (Anteil)', min: 0.1, max: 0.45, step: 0.01, default: 0.25 },
  spandrel: { type: 'enum',  label: 'Zwickel', options: ['columns', 'solid'], default: 'columns' },
};
export default (p, B) => B.bridge('Bogenbrücke')
  .deck({ thickness: 0.6, material: 'granite' })
  .arch({ rise: p.rise, ribs: 2, ribWidth: 1.4, ribDepth: 1.0, spandrel: p.spandrel, spandrelSpacing: 5, spread: 0.85, material: 'granite' })
  .piers({ maxSpan: p.maxSpan, shape: 'wall', width: 3.5, depth: 2.2, taper: 0.2, footing: 0.6, minHeight: 2, material: 'granite' })
  .abutments({ depth: 3.5, wing: 8, material: 'granite' })
  .railing({ type: 'parapet', height: 1.0, material: 'granite' });
`;

export const FACHWERKBRUECKE = `
// Fachwerkbrücke: Stahlfachwerk beidseitig über der Fahrbahn
export const params = {
  maxSpan: { type: 'float', label: 'Max. Spannweite', min: 20, max: 70, step: 1, default: 40 },
  height:  { type: 'float', label: 'Fachwerkhöhe', min: 3, max: 9, step: 0.5, default: 5.5 },
  panel:   { type: 'float', label: 'Feldlänge', min: 3, max: 10, step: 0.5, default: 5 },
};
export default (p, B) => B.bridge('Fachwerkbrücke')
  .deck({ thickness: 0.55, material: 'concrete' })
  .truss({ height: p.height, panel: p.panel, chord: 0.35, material: 'steel_dark' })
  .piers({ maxSpan: p.maxSpan, shape: 'column', width: 1.6, depth: 2.2, taper: 0.2, round: false, footing: 0.6, minHeight: 3 })
  .abutments({ depth: 3, wing: 6 })
  .railing('none');
`;

export const HOLZSTEG_BRUECKE = `
// Holzsteg: Bohlenbelag auf zwei Balken, Holzgeländer (Wanderwege)
export const params = {
  maxSpan: { type: 'float', label: 'Max. Spannweite', min: 3, max: 12, step: 0.5, default: 6 },
};
export default (p, B) => B.bridge('Holzsteg')
  .deck({ thickness: 0.25, material: 'wood' })
  .girders({ count: 2, depth: 0.35, width: 0.25, spread: 0.85, material: 'wood' })
  .piers({ maxSpan: p.maxSpan, shape: 'twin', width: 1.0, depth: 0.28, round: true, footing: 0, minHeight: 1.2, material: 'wood' })
  .abutments({ depth: 1.0, wing: 0, material: 'wood' })
  .railing('timber');
`;

export const EISENBAHNBRUECKE = `
// Eisenbahnbrücke: Betontrog auf Pfeilerjochen (Schotterbett bleibt, Fahrleitungsmasten stehen auf dem Rand)
export const params = {
  maxSpan: { type: 'float', label: 'Max. Spannweite', min: 15, max: 70, step: 1, default: 36 },
  box:     { type: 'float', label: 'Trägerhöhe', min: 0.8, max: 3, step: 0.1, default: 1.5 },
};
export default (p, B) => B.bridge('Eisenbahnbrücke')
  .deck({ thickness: p.box, material: 'concrete' })
  .piers({ maxSpan: p.maxSpan, shape: 'wall', width: 3.2, depth: 1.6, taper: 0.25, cap: true, capHeight: 0.9, footing: 0.7, minHeight: 3 })
  .abutments({ depth: 3, wing: 8 })
  .railing('steel');
`;

export const BRIDGE_PRESET_SOURCES: Record<string, string> = {
  holzsteg: HOLZSTEG_BRUECKE,
  plattenbruecke: PLATTENBRUECKE,
  balkenbruecke: BALKENBRUECKE,
  viadukt: VIADUKT,
  bogenbruecke: BOGENBRUECKE,
  fachwerkbruecke: FACHWERKBRUECKE,
  eisenbahnbruecke: EISENBAHNBRUECKE,
};
