// Built-in profiles — plain profile source code, editable in the editor like
// any user profile. Swiss road hierarchy; more families follow in Phase 5.

export const FLURSTRASSE = `
// Flurstrasse / Feldweg: zwei Fahrspuren (Spurrillen) mit Mittelgras
export const params = {
  width: { type: 'float', label: 'Breite', min: 2.2, max: 4.5, step: 0.1, default: 3.0 },
  grass: { type: 'bool',  label: 'Mittelgras', default: true },
};

export default (p, R) => R.profile('Flurstrasse')
  .thickness(0.5).bodyMaterial('subgrade').smooth(6)
  .center(p.grass ? 0.5 : 0.01, p.grass ? 'grass' : 'gravel', { kind: 'median', core: true })
  .both(h => h
    .step(-0.06, 'dirt', { kind: 'rut' })
    .surface(0.7, 'dirt', { kind: 'lane', id: 'rut' })
    .surface(Math.max(0.1, p.width / 2 - 0.95), 'gravel', { kind: 'lane' })
    .slope(0.6, -0.1, 'grass', { kind: 'verge' })
    .slope(1.6, -0.35, 'grass', { kind: 'verge' }));
`;

export const HAUPTSTRASSE = `
// Hauptstrasse / Landstrasse: Dachprofil, Bankett, Graben
export const params = {
  laneWidth: { type: 'float', label: 'Spurbreite', min: 2.5, max: 4, step: 0.05, default: 3.0 },
  shoulder:  { type: 'float', label: 'Bankett',    min: 0.2, max: 2.5, step: 0.1, default: 0.8 },
  crown:     { type: 'float', label: 'Quergefälle', min: 0.0, max: 0.06, step: 0.005, default: 0.025 },
  ditch:     { type: 'bool',  label: 'Graben', default: true },
};

export default (p, R) => R.profile('Hauptstrasse')
  .thickness(0.8).bodyMaterial('subgrade').smooth(18)
  .both(h => {
    h.surface(p.laneWidth, 'asphalt', { kind: 'lane', slope: -p.crown, id: 'lane' })
     .surface(p.shoulder, 'asphalt_worn', { kind: 'shoulder', slope: -0.04 })
     .slope(0.8, -0.05, 'gravel', { kind: 'verge' });
    if (p.ditch) h.ditch(1.6, 0.4, 'grass');
    else h.slope(1.6, -0.3, 'grass', { kind: 'verge' });
  });
`;

export const WANDERWEG = `
// Wanderweg: schmaler Erdpfad, Breite und Verlauf "wackeln" entlang der Strecke
export const params = {
  width:  { type: 'float', label: 'Breite', min: 0.4, max: 1.6, step: 0.05, default: 0.8 },
  wobble: { type: 'float', label: 'Unruhe', min: 0, max: 1, step: 0.05, default: 0.5 },
};

export default (p, R) => R.profile('Wanderweg')
  .thickness(0.3).bodyMaterial('subgrade').smooth(3)
  .center(p.width, 'path_dirt', { kind: 'path' })
  .both(h => h
    .slope(0.4, -0.06, 'grass', { kind: 'verge' })
    .slope(0.9, -0.2, 'grass', { kind: 'verge' }))
  .vary(({ s }) => ({
    widthMul: 1 + 0.3 * p.wobble * R.noise1(s * 0.18),
    offsetX: 0.35 * p.wobble * R.noise1(s * 0.06 + 100),
  }));
`;

export const PRESET_SOURCES: Record<string, string> = {
  flurstrasse: FLURSTRASSE,
  hauptstrasse: HAUPTSTRASSE,
  wanderweg: WANDERWEG,
};
