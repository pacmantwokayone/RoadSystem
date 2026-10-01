// Built-in profiles — plain profile source code, editable in the editor like any user profile.
// Swiss road hierarchy (paths → Autobahn). Dimensions are plausible approximations of the VSS norms,
// NOT a normative reference: check against the current VSS / SSV before using them for anything official.

export const TRAMPELPFAD = `
// Trampelpfad: kaum sichtbarer Pfad, unregelmässig
export const params = {
  width:  { type: 'float', label: 'Breite', min: 0.25, max: 0.9, step: 0.05, default: 0.45 },
  wobble: { type: 'float', label: 'Unruhe', min: 0, max: 1, step: 0.05, default: 0.8 },
};
export default (p, R) => R.profile('Trampelpfad').rank(0)
  .thickness(0.2).bodyMaterial('subgrade').smooth(2)
  .center(p.width, 'path_dirt', { kind: 'path' })
  .both(h => h.slope(0.3, -0.04, 'grass', { kind: 'verge' }).slope(0.7, -0.15, 'grass', { kind: 'verge' }))
  .vary(({ s }) => ({
    widthMul: 1 + 0.45 * p.wobble * R.noise1(s * 0.25),
    offsetX: 0.4 * p.wobble * R.noise1(s * 0.09 + 31),
  }));
`;

export const WANDERWEG = `
// Wanderweg: schmaler Erdpfad, Breite und Verlauf "wackeln" entlang der Strecke
export const params = {
  width:  { type: 'float', label: 'Breite', min: 0.4, max: 1.6, step: 0.05, default: 0.8 },
  wobble: { type: 'float', label: 'Unruhe', min: 0, max: 1, step: 0.05, default: 0.5 },
  benches: { type: 'bool', label: 'Rastbänke', default: true },
};
export default (p, R) => {
  const prof = R.profile('Wanderweg').rank(0)
    .thickness(0.3).bodyMaterial('subgrade').smooth(3)
    .center(p.width, 'path_dirt', { kind: 'path' })
    .both(h => h
      .slope(0.4, -0.06, 'grass', { kind: 'verge' })
      .slope(0.9, -0.2, 'grass', { kind: 'verge' }))
    .vary(({ s }) => ({
      widthMul: 1 + 0.3 * p.wobble * R.noise1(s * 0.18),
      offsetX: 0.35 * p.wobble * R.noise1(s * 0.06 + 100),
    }));
  // Wegweiser: prof.scatter('sign:wanderweg:Rigi|2 h', { at: [8], offset: 0.6 })
  if (p.benches) prof.scatter('bench', { spacing: 260, offset: 0.9, jitterAlong: 25, side: 'right', face: 'road' });
  return prof;
};
`;

export const WALDWEG = `
// Waldweg: Erd-/Kiesweg mit Laubboden an den Rändern
export const params = {
  width: { type: 'float', label: 'Breite', min: 1.2, max: 3.0, step: 0.1, default: 2.0 },
};
export default (p, R) => R.profile('Waldweg').rank(1)
  .thickness(0.35).bodyMaterial('subgrade').smooth(5)
  .center(Math.max(0.5, p.width - 1.0), 'gravel_fine', { kind: 'path' })
  .both(h => h
    .surface(0.5, 'path_dirt', { kind: 'path' })
    .slope(0.6, -0.08, 'forest', { kind: 'verge' })
    .slope(1.2, -0.25, 'forest', { kind: 'verge' }));
`;

export const FUSSWEG = `
// Fussweg (befestigt): schmaler Belag mit seitlichem Grünstreifen
export const params = {
  width: { type: 'float', label: 'Breite', min: 1.0, max: 3.0, step: 0.1, default: 1.6 },
  lamps: { type: 'bool',  label: 'Wegbeleuchtung', default: false },
};
export default (p, R) => {
  const prof = R.profile('Fussweg').rank(1)
    .thickness(0.35).bodyMaterial('subgrade').smooth(6)
    .center(p.width, 'sidewalk', { kind: 'walkable' })
    .both(h => h
      .step(-0.04, 'curb', { kind: 'curb' })
      .slope(0.7, -0.05, 'grass', { kind: 'verge' })
      .slope(1.0, -0.2, 'grass', { kind: 'verge' }));
  if (p.lamps) prof.lamps({ asset: 'lamp_small', spacing: 30, side: 'left', offset: 0.5 });
  return prof;
};
`;

export const RADWEG = `
// Radweg: Asphaltband mit gestrichelter Mittellinie
export const params = {
  width:  { type: 'float', label: 'Breite', min: 1.5, max: 4.0, step: 0.1, default: 2.4 },
  center: { type: 'bool',  label: 'Mittellinie', default: true },
};
export default (p, R) => {
  const prof = R.profile('Radweg').rank(1)
    .thickness(0.4).bodyMaterial('subgrade').smooth(8)
    .center(p.width, 'asphalt_dark', { kind: 'lane' })
    .both(h => h
      .slope(0.4, -0.04, 'gravel_fine', { kind: 'verge' })
      .slope(1.0, -0.2, 'grass', { kind: 'verge' }));
  if (p.center) prof.markCenter({ width: 0.1, dash: 1.5, gap: 3 });
  return prof;
};
`;

export const HOLZSTEG = `
// Holzsteg: Bohlen quer zur Gehrichtung, Holzkörper
export const params = {
  width: { type: 'float', label: 'Breite', min: 0.7, max: 2.5, step: 0.1, default: 1.2 },
};
export default (p, R) => R.profile('Holzsteg').rank(0)
  .thickness(0.3).bodyMaterial('wood').smooth(1.5)
  .center(p.width, 'wood', { kind: 'walkable' })
  .both(h => h.step(-0.12, 'wood', { kind: 'curb' }).slope(0.5, -0.1, 'grass', { kind: 'verge' }));
`;

export const FLURSTRASSE = `
// Flurstrasse / Feldweg: zwei Fahrspuren (Spurrillen) mit Mittelgras
export const params = {
  width: { type: 'float', label: 'Breite', min: 2.2, max: 4.5, step: 0.1, default: 3.0 },
  grass: { type: 'bool',  label: 'Mittelgras', default: true },
};
export default (p, R) => R.profile('Flurstrasse').rank(2)
  .thickness(0.5).bodyMaterial('subgrade').smooth(6)
  .center(p.grass ? 0.5 : 0.01, p.grass ? 'grass' : 'gravel', { kind: 'median', core: true })
  .both(h => h
    .step(-0.06, 'dirt', { kind: 'rut' })
    .surface(0.7, 'dirt', { kind: 'lane', id: 'rut' })
    .surface(Math.max(0.1, p.width / 2 - 0.95), 'gravel', { kind: 'lane' })
    .slope(0.6, -0.1, 'grass', { kind: 'verge' })
    .slope(1.6, -0.35, 'grass', { kind: 'verge' }));
`;

export const SCHOTTERPISTE = `
// Schotterpiste: Kiesfahrbahn mit Dachprofil, seitlich Graben
export const params = {
  width: { type: 'float', label: 'Breite', min: 3, max: 6.5, step: 0.1, default: 4.4 },
  ditch: { type: 'bool',  label: 'Graben', default: true },
};
export default (p, R) => R.profile('Schotterpiste').rank(2)
  .thickness(0.6).bodyMaterial('subgrade').smooth(8)
  .both(h => {
    h.surface(p.width / 2, 'gravel', { kind: 'lane', slope: -0.03 })
     .slope(0.4, -0.05, 'gravel_fine', { kind: 'verge' });
    if (p.ditch) h.ditch(1.2, 0.3, 'grass'); else h.slope(1.2, -0.25, 'grass', { kind: 'verge' });
  });
`;

export const WALDSTRASSE = `
// Waldstrasse (Forststrasse): feiner Kies, schmale Böschung
export const params = {
  width: { type: 'float', label: 'Breite', min: 2.8, max: 5, step: 0.1, default: 3.6 },
};
export default (p, R) => R.profile('Waldstrasse').rank(2)
  .thickness(0.6).bodyMaterial('subgrade').smooth(9)
  .both(h => h
    .surface(p.width / 2, 'gravel_fine', { kind: 'lane', slope: -0.025 })
    .slope(0.5, -0.06, 'path_dirt', { kind: 'verge' })
    .ditch(1.0, 0.3, 'forest'));
`;

export const ALPSTRASSE = `
// Alp-/Güterstrasse: schmal, Kies, Steinkante
export const params = {
  width: { type: 'float', label: 'Breite', min: 2.5, max: 4.5, step: 0.1, default: 3.2 },
  guardrail: { type: 'bool', label: 'Holzleitplanke an Abstürzen', default: true },
};
export default (p, R) => {
  const prof = R.profile('Alpstrasse').rank(2)
    .thickness(0.5).bodyMaterial('subgrade').smooth(7)
    .both(h => h
      .surface(p.width / 2, 'gravel', { kind: 'lane', slope: -0.02 })
      .slope(0.35, -0.05, 'rock', { kind: 'verge' })
      .slope(1.4, -0.3, 'grass', { kind: 'verge' }));
  if (p.guardrail) prof.guardrail('both', { variant: 'wood', offset: 0.2, minDrop: 2.5, minDropBend: 1.5 });
  return prof;
};
`;

export const GEMEINDESTRASSE = `
// Gemeindestrasse: schmaler Asphalt ohne Mittellinie
export const params = {
  width:    { type: 'float', label: 'Fahrbahnbreite', min: 3.5, max: 7, step: 0.1, default: 5.0 },
  shoulder: { type: 'float', label: 'Bankett', min: 0.2, max: 1.5, step: 0.1, default: 0.5 },
  lamps:    { type: 'enum',  label: 'Strassenlaternen', options: ['keine', 'links', 'rechts', 'beidseitig'], default: 'keine' },
};
export default (p, R) => {
  const prof = R.profile('Gemeindestrasse').rank(3)
    .thickness(0.7).bodyMaterial('subgrade').smooth(12)
    .both(h => h
      .surface(p.width / 2, 'asphalt', { kind: 'lane', slope: -0.025 })
      .surface(p.shoulder, 'gravel_fine', { kind: 'shoulder', slope: -0.04 })
      .ditch(1.4, 0.35, 'grass'));
  if (p.lamps !== 'keine') prof.lamps({ asset: 'lamp_small', spacing: 38, offset: 0.6, side: { links: 'left', rechts: 'right', beidseitig: 'both' }[p.lamps], stagger: true });
  return prof;
};
`;

export const DORFSTRASSE = `
// Dorfstrasse: Pflaster, Granit-Randsteine, Trottoir
export const params = {
  width:    { type: 'float', label: 'Fahrbahnbreite', min: 4, max: 8, step: 0.1, default: 5.6 },
  sidewalk: { type: 'float', label: 'Trottoir', min: 0, max: 3, step: 0.1, default: 1.6 },
  lamps:    { type: 'bool',  label: 'Strassenlaternen', default: true },
};
export default (p, R) => {
  const prof = R.profile('Dorfstrasse').rank(3)
    .thickness(0.7).bodyMaterial('subgrade').smooth(10)
    .both(h => {
      h.surface(p.width / 2, 'cobble', { kind: 'lane', slope: -0.02 })
       .step(0.12, 'curb', { kind: 'curb' })
       .surface(0.15, 'granite', { kind: 'curb' });
      if (p.sidewalk > 0.05) h.surface(p.sidewalk, 'sidewalk', { kind: 'walkable', core: true });
      h.slope(0.8, -0.1, 'grass', { kind: 'verge' });
    });
  // lamps stand on the pavement edge (negative offset = inwards from the carriageway edge)
  if (p.lamps) prof.lamps({ asset: 'lamp_small', spacing: 32, offset: p.sidewalk > 0.05 ? -0.35 : 0.4, side: 'both', stagger: true });
  return prof;
};
`;

export const QUARTIERSTRASSE = `
// Quartierstrasse: Bordstein, Trottoir, einseitiges Parkfeld je Seite
export const params = {
  lane:     { type: 'float', label: 'Spurbreite', min: 2.5, max: 3.5, step: 0.05, default: 2.9 },
  parking:  { type: 'float', label: 'Parkfeld', min: 0, max: 2.6, step: 0.1, default: 2.0 },
  sidewalk: { type: 'float', label: 'Trottoir', min: 0, max: 3, step: 0.1, default: 2.0 },
  lamps:    { type: 'bool',  label: 'Strassenlaternen', default: true },
};
export default (p, R) => {
  const prof = R.profile('Quartierstrasse').rank(3)
  .thickness(0.7).bodyMaterial('subgrade').smooth(10)
  .both(h => {
    h.surface(p.lane, 'asphalt', { kind: 'lane', slope: -0.02 });
    if (p.parking > 0.05) h.surface(p.parking, 'asphalt_dark', { kind: 'parking', slope: -0.015 }).edgeLine({ back: 0.05, width: 0.1, color: 'white' });
    h.step(0.12, 'curb', { kind: 'curb' }).surface(0.15, 'granite', { kind: 'curb' });
    if (p.sidewalk > 0.05) h.surface(p.sidewalk, 'sidewalk', { kind: 'walkable' });
    h.slope(0.8, -0.1, 'grass', { kind: 'verge' });
  });
  if (p.lamps) prof.lamps({ asset: 'lamp_small', spacing: 30, offset: p.sidewalk > 0.05 ? -0.4 : 0.4, side: 'left' });
  return prof;
};
`;

export const NEBENSTRASSE = `
// Nebenstrasse: Asphalt, optionale Leitlinie
export const params = {
  lane:   { type: 'float', label: 'Spurbreite', min: 2.5, max: 3.5, step: 0.05, default: 2.9 },
  center: { type: 'bool',  label: 'Leitlinie', default: false },
  guardrail: { type: 'bool', label: 'Leitplanke an Abstürzen', default: true },
  posts:  { type: 'bool',  label: 'Leitpfosten', default: true },
};
export default (p, R) => {
  const prof = R.profile('Nebenstrasse').rank(4)
    .thickness(0.7).bodyMaterial('subgrade').smooth(14)
    .both(h => h
      .surface(p.lane, 'asphalt', { kind: 'lane', slope: -0.025 })
      .surface(0.4, 'asphalt_worn', { kind: 'shoulder', slope: -0.04 })
      .slope(0.6, -0.05, 'gravel_fine', { kind: 'verge' })
      .ditch(1.4, 0.35, 'grass'));
  if (p.center) prof.markCenter({ dash: 3, gap: 6 });
  if (p.guardrail) prof.guardrail('both', { offset: 0.3 });
  if (p.posts) prof.scatter('delineator', { spacing: 50, offset: 0.55, side: 'both' });
  return prof;
};
`;

export const HAUPTSTRASSE = `
// Hauptstrasse / Landstrasse: Dachprofil, Leit- und Randlinien, Bankett, Graben
export const params = {
  laneWidth: { type: 'float', label: 'Spurbreite', min: 2.5, max: 4, step: 0.05, default: 3.0 },
  shoulder:  { type: 'float', label: 'Bankett',    min: 0.2, max: 2.5, step: 0.1, default: 0.8 },
  crown:     { type: 'float', label: 'Quergefälle', min: 0.0, max: 0.06, step: 0.005, default: 0.025 },
  ditch:     { type: 'bool',  label: 'Graben', default: true },
  lines:     { type: 'bool',  label: 'Markierungen', default: true },
  edge:      { type: 'enum',  label: 'Randlinie', options: ['solid', 'dashed'], default: 'solid' },
  guardrail: { type: 'bool',  label: 'Leitplanke an Abstürzen', default: true },
  posts:     { type: 'bool',  label: 'Leitpfosten', default: true },
};
export default (p, R) => {
  const prof = R.profile('Hauptstrasse').rank(5)
    .thickness(0.8).bodyMaterial('subgrade').smooth(18)
    .both(h => {
      h.surface(p.laneWidth, 'asphalt', { kind: 'lane', slope: -p.crown, id: 'lane' });
      if (p.lines) h.edgeLine({ back: 0.2, style: p.edge, dash: 1, gap: 1 });
      h.surface(p.shoulder, 'asphalt_worn', { kind: 'shoulder', slope: -0.04 })
       .slope(0.8, -0.05, 'gravel', { kind: 'verge' });
      if (p.ditch) h.ditch(1.6, 0.4, 'grass');
      else h.slope(1.6, -0.3, 'grass', { kind: 'verge' });
    });
  if (p.lines) prof.markCenter({ dash: 3, gap: 9 });
  if (p.guardrail) prof.guardrail('both', { offset: 0.3 });
  if (p.posts) prof.scatter('delineator', { spacing: 50, offset: 0.6, side: 'both' });
  return prof;
};
`;

export const KANTONSSTRASSE = `
// Kantonsstrasse: breiter, durchgehende Randlinien, gelbe Sperrlinie als Option
export const params = {
  laneWidth: { type: 'float', label: 'Spurbreite', min: 3, max: 4, step: 0.05, default: 3.25 },
  shoulder:  { type: 'float', label: 'Bankett',    min: 0.3, max: 2.5, step: 0.1, default: 1.0 },
  noOvertaking: { type: 'bool', label: 'Sperrlinie (gelb)', default: false },
  guardrail: { type: 'bool', label: 'Leitplanke an Abstürzen', default: true },
  posts:     { type: 'bool', label: 'Leitpfosten', default: true },
  avenue:    { type: 'bool', label: 'Allee (Linden)', default: false },
};
export default (p, R) => {
  const prof = R.profile('Kantonsstrasse').rank(6)
    .thickness(0.9).bodyMaterial('subgrade').smooth(22)
    .both(h => h
      .surface(p.laneWidth, 'asphalt', { kind: 'lane', slope: -0.025 })
      .edgeLine({ back: 0.2 })
      .surface(p.shoulder, 'asphalt_worn', { kind: 'shoulder', slope: -0.04 })
      .slope(0.8, -0.05, 'gravel', { kind: 'verge' })
      .ditch(1.8, 0.45, 'grass'));
  if (p.noOvertaking) prof.markCenter({ style: 'double', color: 'yellow', spacing: 0.3 });
  else prof.markCenter({ dash: 3, gap: 9 });
  if (p.guardrail) prof.guardrail('both', { offset: 0.3 });
  if (p.posts) prof.scatter('delineator', { spacing: 50, offset: 0.6, side: 'both' });
  if (p.avenue) prof.scatter('tree_linden', { spacing: 22, offset: 3.2, side: 'both', jitterAlong: 1.2, jitterLateral: 0.4, scale: [0.85, 1.2], face: 'random' });
  return prof;
};
`;

export const AUTOSTRASSE = `
// Autostrasse: einbahnig, Doppel-Leitlinie, Pannenstreifen schmal
export const params = {
  laneWidth: { type: 'float', label: 'Spurbreite', min: 3, max: 4, step: 0.05, default: 3.5 },
  shoulder:  { type: 'float', label: 'Seitenstreifen', min: 0.5, max: 3, step: 0.1, default: 1.2 },
};
export default (p, R) => R.profile('Autostrasse').rank(7)
  .thickness(1.0).bodyMaterial('subgrade').smooth(35)
  .markCenter({ style: 'double', spacing: 0.3 })
  .both(h => h
    .surface(p.laneWidth, 'asphalt', { kind: 'lane', slope: -0.025 })
    .edgeLine({ back: 0.2 })
    .surface(p.shoulder, 'asphalt_worn', { kind: 'shoulder', slope: -0.04 })
    .slope(1.0, -0.06, 'gravel', { kind: 'verge' })
    .ditch(2.0, 0.5, 'grass'))
  .guardrail('both', { offset: 0.3 })
  .scatter('delineator', { spacing: 50, offset: 0.6, side: 'both' });
`;

export const AUTOBAHN = `
// Autobahn: zwei Richtungsfahrbahnen mit Betonleitwand in der Mitte, je 2 Fahrstreifen + Pannenstreifen
export const params = {
  lanes:    { type: 'int',   label: 'Fahrstreifen je Richtung', min: 1, max: 3, default: 2 },
  laneWidth:{ type: 'float', label: 'Spurbreite', min: 3.25, max: 4, step: 0.05, default: 3.75 },
  shoulder: { type: 'float', label: 'Pannenstreifen', min: 0, max: 3.5, step: 0.1, default: 3.0 },
  median:   { type: 'float', label: 'Mittelstreifen', min: 0.6, max: 4, step: 0.1, default: 1.0 },
};
export default (p, R) => R.profile('Autobahn').rank(8)
  .thickness(1.2).bodyMaterial('subgrade').smooth(45)
  .center(p.median, 'concrete', { y: 0.8, kind: 'barrier', core: false })
  .both(h => {
    h.step(-0.8, 'concrete', { kind: 'barrier', core: false }).edgeLine({ back: -0.25 });
    for (let i = 0; i < p.lanes; i++) {
      h.surface(p.laneWidth, 'asphalt', { kind: 'lane', slope: -0.025, id: 'lane' + i });
      if (i < p.lanes - 1) h.edgeLine({ back: 0, style: 'dashed', dash: 6, gap: 12 });
    }
    h.edgeLine({ back: 0.2, width: 0.2 });
    if (p.shoulder > 0.05) h.surface(p.shoulder, 'asphalt_worn', { kind: 'shoulder', slope: -0.04 });
    h.slope(1.2, -0.06, 'gravel', { kind: 'verge' }).ditch(2.2, 0.5, 'grass');
  })
  .guardrail('both', { offset: 0.3 })
  .scatter('delineator', { spacing: 50, offset: 0.6, side: 'both' })
  .scatter('km_stone', { spacing: 1000, offset: 0.9, side: 'right', face: 'road' });
`;

export const AUFFAHRT = `
// Auf-/Abfahrt: eine Fahrspur mit Randlinien und Seitenstreifen
export const params = {
  laneWidth: { type: 'float', label: 'Spurbreite', min: 3, max: 5, step: 0.1, default: 4.0 },
  shoulder:  { type: 'float', label: 'Seitenstreifen', min: 0.3, max: 2.5, step: 0.1, default: 1.0 },
};
export default (p, R) => R.profile('Auffahrt').rank(7)
  .thickness(1.0).bodyMaterial('subgrade').smooth(25)
  .center(p.laneWidth, 'asphalt', { kind: 'lane' })
  .both(h => h
    .edgeLine({ back: 0.2 })
    .surface(p.shoulder, 'asphalt_worn', { kind: 'shoulder', slope: -0.04 })
    .slope(1.0, -0.06, 'gravel', { kind: 'verge' })
    .ditch(1.8, 0.4, 'grass'))
  .guardrail('both', { offset: 0.3 })
  .scatter('delineator', { spacing: 50, offset: 0.6, side: 'both' });
`;

export const KREISEL = `
// Kreisel: einspuriger Ring (Einbahn), Bordstein zur Mittelinsel; Zufahrten haben Kein Vortritt (Rang 6 > Rang der Zufahrten)
export const params = {
  lane:   { type: 'float', label: 'Fahrbahnbreite', min: 3.5, max: 5.5, step: 0.1, default: 4.5 },
  apron:  { type: 'float', label: 'Überfahrbarer Rand', min: 0, max: 2, step: 0.1, default: 0.0 },
  lamps:  { type: 'bool',  label: 'Laternen aussen', default: true },
};
export default (p, R) => {
  const prof = R.profile('Kreisel').rank(6)
    .thickness(0.8).bodyMaterial('subgrade').smooth(3)
    .both(h => {
      h.surface(p.lane, 'asphalt', { kind: 'lane', slope: -0.02 }).edgeLine({ back: 0.12, width: 0.12, color: 'white' });
      if (p.apron > 0.05) h.surface(p.apron, 'granite', { kind: 'shoulder', slope: -0.02 });
      h.step(0.12, 'curb', { kind: 'curb' }).surface(0.15, 'granite', { kind: 'curb' });
      h.slope(1.2, -0.08, 'grass', { kind: 'verge' });
    });
  if (p.lamps) prof.lamps({ asset: 'lamp', spacing: 28, offset: 1.0, side: 'right' });
  return prof;
};
`;

export const PRESET_SOURCES: Record<string, string> = {
  trampelpfad: TRAMPELPFAD,
  wanderweg: WANDERWEG,
  waldweg: WALDWEG,
  fussweg: FUSSWEG,
  radweg: RADWEG,
  holzsteg: HOLZSTEG,
  flurstrasse: FLURSTRASSE,
  schotterpiste: SCHOTTERPISTE,
  waldstrasse: WALDSTRASSE,
  alpstrasse: ALPSTRASSE,
  gemeindestrasse: GEMEINDESTRASSE,
  dorfstrasse: DORFSTRASSE,
  quartierstrasse: QUARTIERSTRASSE,
  nebenstrasse: NEBENSTRASSE,
  hauptstrasse: HAUPTSTRASSE,
  kantonsstrasse: KANTONSSTRASSE,
  autostrasse: AUTOSTRASSE,
  autobahn: AUTOBAHN,
  auffahrt: AUFFAHRT,
  kreisel: KREISEL,
};
