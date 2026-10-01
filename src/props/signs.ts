// Road sign catalogue, drawn procedurally onto a canvas (Swiss signalisation, SSV). Every sign has a
// plate shape (the polygon the sign is cut to) and a draw function that paints the face; the plate
// geometry's UVs map the whole canvas onto the shape's bounding box.
//
// Asset names: `sign:<id>` or `sign:<id>:<text>` (text for the signs that carry a label; `|` = new line),
// e.g. `sign:speed_50`, `sign:wegweiser_blue:Thun|14 km`.
//
// The designs are simplified depictions in the spirit of the Swiss signs — colours and layout follow the
// norm, proportions and pictograms are approximations. Numbers (SSV articles) are intentionally not
// printed in ids: unverified references are worse than none.

export type PlateShape = 'disc' | 'triangle-up' | 'triangle-down' | 'octagon' | 'diamond' | 'rect';

export interface Ctx2D {
  fillStyle: unknown; strokeStyle: unknown; lineWidth: number; lineJoin: string; lineCap: string;
  font: string; textAlign: string; textBaseline: string;
  save(): void; restore(): void; translate(x: number, y: number): void; rotate(a: number): void;
  beginPath(): void; closePath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
  fill(): void; stroke(): void; fillRect(x: number, y: number, w: number, h: number): void;
  fillText(t: string, x: number, y: number, maxWidth?: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
}

export interface SignDef {
  id: string;
  label: string;
  shape: PlateShape;
  /** plate size in metres (bounding box) */
  width: number;
  height: number;
  /** colour of the sign when no canvas is available (headless) */
  baseColor: number;
  /** paints the face; the canvas is `size` × `size·height/width` */
  draw(g: Ctx2D, w: number, h: number, text?: string): void;
  /** fixed texts of the face are drawn from `text` (for label signs) */
  labelled?: boolean;
}

const RED = '#c8102e';
const WHITE = '#fafafa';
const BLACK = '#151515';
const BLUE = '#0b5fa5';
const YELLOW = '#f2c200';
const GREEN = '#0a7d3b';
const HIKE = '#f5c400';

function polygonPath(g: Ctx2D, pts: Array<[number, number]>): void {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
}

/** vertices of a plate shape in unit coordinates (x, y in [-0.5, 0.5], y up) — also used for the 3D plate */
export function plateOutline(shape: PlateShape, segments = 28): Array<[number, number]> {
  switch (shape) {
    case 'disc': return Array.from({ length: segments }, (_, i) => [0.5 * Math.cos((i / segments) * Math.PI * 2), 0.5 * Math.sin((i / segments) * Math.PI * 2)] as [number, number]);
    case 'triangle-up': return [[-0.5, -0.4], [0.5, -0.4], [0, 0.4]];
    case 'triangle-down': return [[-0.5, 0.4], [0, -0.4], [0.5, 0.4]];
    case 'octagon': return Array.from({ length: 8 }, (_, i) => [0.5 * Math.cos(((i + 0.5) / 8) * Math.PI * 2), 0.5 * Math.sin(((i + 0.5) / 8) * Math.PI * 2)] as [number, number]);
    case 'diamond': return [[0, -0.5], [0.5, 0], [0, 0.5], [-0.5, 0]];
    case 'rect': return [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  }
}

const outlinePx = (shape: PlateShape, w: number, h: number, inset = 0): Array<[number, number]> =>
  plateOutline(shape).map(([x, y]) => [w / 2 + x * (w - 2 * inset), h / 2 - y * (h - 2 * inset)]);

function bigText(g: Ctx2D, text: string, x: number, y: number, size: number, color: string, maxW?: number): void {
  g.fillStyle = color;
  g.font = `bold ${Math.round(size)}px Arial, Helvetica, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, x, y, maxW);
}

function speed(n: number): SignDef {
  return {
    id: `speed_${n}`, label: `Höchstgeschwindigkeit ${n}`, shape: 'disc', width: 0.75, height: 0.75, baseColor: 0xf4f4f4,
    draw(g, w, h) {
      g.fillStyle = RED; polygonPath(g, outlinePx('disc', w, h)); g.fill();
      g.fillStyle = WHITE; g.beginPath(); g.arc(w / 2, h / 2, w * 0.36, 0, Math.PI * 2); g.fill();
      bigText(g, String(n), w / 2, h / 2 + h * 0.01, w * (n >= 100 ? 0.3 : 0.4), BLACK, w * 0.6);
    },
  };
}

function personGlyph(g: Ctx2D, cx: number, cy: number, s: number): void {
  g.fillStyle = WHITE; g.strokeStyle = WHITE; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.arc(cx + 0.02 * s, cy - 0.33 * s, 0.075 * s, 0, Math.PI * 2); g.fill();
  g.lineWidth = 0.11 * s;
  g.beginPath(); g.moveTo(cx, cy - 0.2 * s); g.lineTo(cx - 0.02 * s, cy + 0.08 * s); g.stroke(); // torso
  g.beginPath(); g.moveTo(cx - 0.02 * s, cy + 0.08 * s); g.lineTo(cx - 0.12 * s, cy + 0.34 * s); g.stroke();
  g.beginPath(); g.moveTo(cx - 0.02 * s, cy + 0.08 * s); g.lineTo(cx + 0.12 * s, cy + 0.34 * s); g.stroke();
  g.beginPath(); g.moveTo(cx, cy - 0.16 * s); g.lineTo(cx + 0.15 * s, cy - 0.02 * s); g.stroke();
  g.beginPath(); g.moveTo(cx, cy - 0.16 * s); g.lineTo(cx - 0.15 * s, cy + 0.02 * s); g.stroke();
}

function bendArrow(g: Ctx2D, w: number, h: number, dir: 1 | -1): void {
  g.strokeStyle = BLACK; g.fillStyle = BLACK; g.lineWidth = w * 0.07; g.lineCap = 'butt'; g.lineJoin = 'miter';
  const x0 = w / 2 - dir * w * 0.05, yb = h * 0.68, yt = h * 0.42;
  g.beginPath(); g.moveTo(x0, yb); g.lineTo(x0, h * 0.56); g.lineTo(x0 + dir * w * 0.16, yt); g.stroke();
  const tx = x0 + dir * w * 0.16, ty = yt;
  polygonPath(g, [[tx + dir * w * 0.0, ty - h * 0.08], [tx + dir * w * 0.1, ty + h * 0.06], [tx - dir * w * 0.1, ty + h * 0.03]]); g.fill();
}

function warnTriangle(id: string, label: string, glyph: (g: Ctx2D, w: number, h: number) => void): SignDef {
  return {
    id, label, shape: 'triangle-up', width: 0.9, height: 0.9 * 0.8, baseColor: 0xf4f4f4,
    draw(g, w, h) {
      g.fillStyle = RED; polygonPath(g, outlinePx('triangle-up', w, h)); g.fill();
      g.fillStyle = WHITE; polygonPath(g, outlinePx('triangle-up', w, h, w * 0.085).map(([x, y]) => [w / 2 + (x - w / 2) * 0.99, y + h * 0.045])); g.fill();
      glyph(g, w, h);
    },
  };
}

function labelSign(id: string, label: string, bg: string, fg: string, base: number, width: number, height: number, border?: string): SignDef {
  return {
    id, label, shape: 'rect', width, height, baseColor: base, labelled: true,
    draw(g, w, h, text = '') {
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      if (border) {
        g.strokeStyle = border; g.lineWidth = Math.max(2, h * 0.05);
        g.beginPath(); g.moveTo(h * 0.04, h * 0.04); g.lineTo(w - h * 0.04, h * 0.04); g.lineTo(w - h * 0.04, h - h * 0.04); g.lineTo(h * 0.04, h - h * 0.04); g.closePath(); g.stroke();
      }
      const lines = text.split('|');
      const size = Math.min(h / (lines.length + 0.6), w / Math.max(4, Math.max(...lines.map((l) => l.length)) * 0.62));
      lines.forEach((l, i) => bigText(g, l, w / 2, h * ((i + 1) / (lines.length + 1)), size, fg, w * 0.92));
    },
  };
}

export const SIGN_CATALOG: Record<string, SignDef> = {};
const add = (d: SignDef): void => { SIGN_CATALOG[d.id] = d; };

for (const n of [20, 30, 40, 50, 60, 70, 80, 100, 120]) add(speed(n));

add({
  id: 'stop', label: 'Stop', shape: 'octagon', width: 0.9, height: 0.9, baseColor: 0xc8102e,
  draw(g, w, h) {
    g.fillStyle = WHITE; polygonPath(g, outlinePx('octagon', w, h)); g.fill();
    g.fillStyle = RED; polygonPath(g, outlinePx('octagon', w, h, w * 0.045)); g.fill();
    bigText(g, 'STOP', w / 2, h / 2, w * 0.27, WHITE, w * 0.78);
  },
});
add({
  id: 'kein_vortritt', label: 'Kein Vortritt', shape: 'triangle-down', width: 0.9, height: 0.9 * 0.8, baseColor: 0xf4f4f4,
  draw(g, w, h) {
    g.fillStyle = RED; polygonPath(g, outlinePx('triangle-down', w, h)); g.fill();
    g.fillStyle = WHITE; polygonPath(g, outlinePx('triangle-down', w, h, w * 0.085).map(([x, y]) => [w / 2 + (x - w / 2) * 0.99, y - h * 0.045])); g.fill();
  },
});
add({
  id: 'hauptstrasse', label: 'Hauptstrasse (Vortritt)', shape: 'diamond', width: 0.75, height: 0.75, baseColor: 0xf2c200,
  draw(g, w, h) {
    g.fillStyle = BLACK; polygonPath(g, outlinePx('diamond', w, h)); g.fill();
    g.fillStyle = WHITE; polygonPath(g, outlinePx('diamond', w, h, w * 0.035)); g.fill();
    g.fillStyle = YELLOW; polygonPath(g, outlinePx('diamond', w, h, w * 0.1)); g.fill();
  },
});
add({
  id: 'einfahrt_verboten', label: 'Einfahrt verboten', shape: 'disc', width: 0.75, height: 0.75, baseColor: 0xc8102e,
  draw(g, w, h) {
    g.fillStyle = RED; polygonPath(g, outlinePx('disc', w, h)); g.fill();
    g.fillStyle = WHITE; g.fillRect(w * 0.16, h * 0.43, w * 0.68, h * 0.14);
  },
});
add({
  id: 'fussgaengerstreifen', label: 'Fussgängerstreifen', shape: 'rect', width: 0.6, height: 0.6, baseColor: 0x0b5fa5,
  draw(g, w, h) {
    g.fillStyle = BLUE; g.fillRect(0, 0, w, h);
    g.fillStyle = WHITE; polygonPath(g, [[w * 0.1, h * 0.9], [w * 0.5, h * 0.12], [w * 0.9, h * 0.9]]); g.fill();
    g.fillStyle = BLUE; polygonPath(g, [[w * 0.2, h * 0.84], [w * 0.5, h * 0.27], [w * 0.8, h * 0.84]]); g.fill();
    personGlyph(g, w / 2, h * 0.62, w * 0.62);
  },
});
add({
  id: 'autobahn', label: 'Autobahn', shape: 'rect', width: 0.9, height: 0.9, baseColor: 0x0a7d3b,
  draw(g, w, h) {
    g.fillStyle = WHITE; g.fillRect(0, 0, w, h);
    g.fillStyle = GREEN; g.fillRect(w * 0.04, h * 0.04, w * 0.92, h * 0.92);
    g.strokeStyle = WHITE; g.lineWidth = w * 0.07; g.lineCap = 'butt';
    g.beginPath(); g.arc(w / 2, h * 0.86, w * 0.4, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
    g.beginPath(); g.moveTo(w * 0.22, h * 0.42); g.lineTo(w * 0.22, h * 0.78); g.stroke();
    g.beginPath(); g.moveTo(w * 0.78, h * 0.42); g.lineTo(w * 0.78, h * 0.78); g.stroke();
    g.lineWidth = w * 0.03;
    g.beginPath(); g.moveTo(w * 0.22, h * 0.6); g.lineTo(w * 0.78, h * 0.6); g.stroke();
  },
});
add(warnTriangle('kurve_rechts', 'Kurve rechts', (g, w, h) => bendArrow(g, w, h, 1)));
add(warnTriangle('kurve_links', 'Kurve links', (g, w, h) => bendArrow(g, w, h, -1)));
add(warnTriangle('gefahr', 'Gefahrenstelle', (g, w, h) => bigText(g, '!', w / 2, h * 0.62, w * 0.42, BLACK)));
add(labelSign('wegweiser_blue', 'Wegweiser (Hauptstrasse)', BLUE, WHITE, 0x0b5fa5, 1.4, 0.45, WHITE));
add(labelSign('wegweiser_green', 'Wegweiser (Autobahn)', GREEN, WHITE, 0x0a7d3b, 1.8, 0.7, WHITE));
add(labelSign('wanderweg', 'Wanderweg-Wegweiser', HIKE, BLACK, 0xf5c400, 0.7, 0.22));
add(labelSign('ortstafel', 'Ortstafel', WHITE, BLACK, 0xf4f4f4, 0.9, 0.5, BLACK));

export interface ParsedSign {
  id: string;
  text?: string;
  def: SignDef;
}

/** `sign:<id>[:<text>]` → catalogue entry; null for other asset names or unknown ids */
export function parseSignAsset(asset: string): ParsedSign | null {
  if (!asset.startsWith('sign:')) return null;
  const rest = asset.slice(5);
  const cut = rest.indexOf(':');
  const id = cut < 0 ? rest : rest.slice(0, cut);
  const def = SIGN_CATALOG[id];
  if (!def) return null;
  return { id, text: cut < 0 ? undefined : rest.slice(cut + 1), def };
}

export type CanvasLike = { getContext(kind: '2d'): Ctx2D | null; width: number; height: number };

function defaultCanvasFactory(w: number, h: number): CanvasLike | null {
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h) as unknown as CanvasLike;
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c as unknown as CanvasLike;
    }
  } catch { /* fall through */ }
  return null;
}

export type CanvasFactory = (w: number, h: number) => CanvasLike | null;

/** Draws a sign face; null without canvas support (headless) — callers fall back to `baseColor`. */
export function drawSign(def: SignDef, text: string | undefined, px = 256, factory: CanvasFactory = defaultCanvasFactory): CanvasLike | null {
  const aspect = def.height / def.width;
  const cw = aspect > 1 ? Math.round(px / aspect) : px;
  const ch = Math.round(cw * aspect);
  const canvas = factory(cw, ch);
  const g = canvas?.getContext('2d');
  if (!canvas || !g) return null;
  g.clearRect(0, 0, cw, ch);
  def.draw(g, cw, ch, text);
  return canvas;
}
