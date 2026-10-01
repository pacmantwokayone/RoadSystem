// CodeMirror 6 wrapper for profile source code, with completion for the `R` / builder API
// and for material names inside string literals.

import { basicSetup, EditorView } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';

const METHODS: Completion[] = [
  { label: 'profile', type: 'function', detail: "R.profile(name)", info: 'Start a profile builder' },
  { label: 'thickness', type: 'method', detail: '(m)', info: 'Minimum depth of the road body below the surface' },
  { label: 'bodyMaterial', type: 'method', detail: '(name)', info: 'Material of side walls and underside' },
  { label: 'smooth', type: 'method', detail: '(radiusM)', info: 'Terrain-following smoothing radius' },
  { label: 'center', type: 'method', detail: '(width, material, {kind})', info: 'Strip centred on the axis' },
  { label: 'both', type: 'method', detail: '(h => …)', info: 'Same half profile on both sides (mirrored)' },
  { label: 'right', type: 'method', detail: '(h => …)', info: 'Right half profile only' },
  { label: 'left', type: 'method', detail: '(h => …)', info: 'Left half profile only' },
  { label: 'vary', type: 'method', detail: '({s}) => ({widthMul, offsetX})', info: 'Variation along the road' },
  { label: 'surface', type: 'method', detail: '(width, material, {slope, kind, id, core})', info: 'Flat or sloped strip; slope = rise/run outward' },
  { label: 'slope', type: 'method', detail: '(width, dy, material)', info: 'Strip that rises/falls by dy over width' },
  { label: 'step', type: 'method', detail: '(dy, material)', info: 'Vertical face (kerb); dy > 0 steps up outward' },
  { label: 'ditch', type: 'method', detail: '(width, depth, material)', info: 'V-shaped ditch' },
  { label: 'rank', type: 'method', detail: '(n)', info: 'Importance at junctions: lower ranks give way (Kein Vortritt), equal ranks = Rechtsvortritt' },
  { label: 'scatter', type: 'method', detail: "(asset, {side, offset, spacing, at, face, jitterAlong, scale, stagger, when})", info: "Props along the road. asset: 'lamp', 'delineator', 'bench', 'tree_linden', 'sign:speed_50' …; offset = metres outward from the carriageway edge" },
  { label: 'lamps', type: 'method', detail: "({asset, spacing, side, offset})", info: 'Street lamps (lamp / lamp_small)' },
  { label: 'guardrail', type: 'method', detail: "(side, {variant, offset, minDrop, when})", info: "Guardrail: variant 'steel' | 'concrete' | 'wood' | 'cable'; automatic where the terrain drops away (minDrop) or outside tight bends; `when(ctx)` overrides" },
  { label: 'noise1', type: 'function', detail: '(x) → -1..1', info: 'Smooth deterministic 1-D noise' },
  { label: 'clamp', type: 'function', detail: '(v, lo, hi)' },
  { label: 'lerp', type: 'function', detail: '(a, b, t)' },
];

const MATERIAL_METHODS: Completion[] = [
  ...['asphalt', 'gravel', 'dirt', 'grass', 'cobble', 'concrete', 'wood', 'stone', 'paint', 'flat'].map((k): Completion => ({ label: k, type: 'function', detail: '({ … })', info: `Surface kind '${k}'` })),
  { label: 'mix', type: 'function', detail: '(a, b, t)', info: 'Blend two colours' },
  { label: 'shade', type: 'function', detail: '(hex, factor)', info: 'Brighten / darken a colour' },
  { label: 'rgb', type: 'function', detail: '(r, g, b)', info: 'Colour from 0–255 components' },
  { label: 'texture', type: 'function', detail: '(url)', info: 'Use a real texture instead of the procedural base' },
];

export interface CodeEditorOptions {
  /** which API to complete: profile code (`R`/builder) or material code (`M`) */
  api?: 'profile' | 'material';
  doc: string;
  materialNames: () => string[];
  onChange: (source: string) => void;
  debounceMs?: number;
}

export interface CodeEditorHandle {
  getValue(): string;
  /** replace the document without firing onChange */
  setValue(source: string): void;
  focused(): boolean;
  destroy(): void;
}

export function createCodeEditor(parent: HTMLElement, opts: CodeEditorOptions): CodeEditorHandle {
  let silent = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const source = (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 80), ctx.pos);
    const str = /(['"])([\w]*)$/.exec(before);
    if (str) {
      return { from: ctx.pos - str[2].length, options: opts.materialNames().map((label) => ({ label, type: 'constant' })), validFor: /^\w*$/ };
    }
    const dot = /\.(\w*)$/.exec(before);
    if (dot) return { from: ctx.pos - dot[1].length, options: opts.api === 'material' ? MATERIAL_METHODS : METHODS, validFor: /^\w*$/ };
    return null;
  };

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        basicSetup,
        javascript(),
        oneDark,
        autocompletion({ override: [source] }),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged || silent) return;
          clearTimeout(timer);
          timer = setTimeout(() => opts.onChange(view.state.doc.toString()), opts.debounceMs ?? 250);
        }),
      ],
    }),
  });

  // debug/automation handle: lets tools reach the EditorView from the DOM node
  Object.assign(parent, { cmView: view });

  return {
    getValue: () => view.state.doc.toString(),
    setValue(src: string): void {
      if (src === view.state.doc.toString()) return;
      silent = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: src } });
      silent = false;
    },
    focused: () => view.hasFocus,
    destroy(): void { clearTimeout(timer); view.destroy(); },
  };
}
