// Tiny DOM helpers + the editor stylesheet (injected once, no build step needed).

type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; style?: Partial<CSSStyleDeclaration> | string; on?: Record<string, EventListener> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style') { if (typeof v === 'string') el.setAttribute('style', v); else Object.assign(el.style, v); }
    else if (k === 'on') for (const [ev, fn] of Object.entries(v as Record<string, EventListener>)) el.addEventListener(ev, fn);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export const EDITOR_CSS = `
.rse { position: fixed; right: 0; top: 0; bottom: 0; width: 400px; display: flex; flex-direction: column;
  background: rgba(14,19,26,.94); border-left: 1px solid #2b3848; color: #dbe5ef; font: 13px/1.4 system-ui, sans-serif; z-index: 20; }
.rse * { box-sizing: border-box; }
.rse-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px; border-bottom: 1px solid #2b3848; }
.rse button, .rse select, .rse input[type=text], .rse input[type=number] { font: inherit; color: inherit; background: #1b2635; border: 1px solid #38485c; border-radius: 4px; padding: 3px 8px; }
.rse button { cursor: pointer; } .rse button:hover:not(:disabled) { background: #26354a; }
.rse button:disabled { opacity: .4; cursor: default; }
.rse button.on { background: #2f6f4a; border-color: #4fae78; }
.rse button.primary { background: #2a5d9a; border-color: #4a8bd0; }
.rse button.danger:hover:not(:disabled) { background: #6a2a2a; }
.rse-sep { width: 1px; align-self: stretch; background: #2b3848; margin: 0 2px; }
.rse-status { flex: 1 1 100%; font-size: 12px; color: #9fb3c8; min-height: 16px; }
.rse-status.err { color: #ff9b9b; } .rse-status.ok { color: #8fdca8; }
.rse-tabs { display: flex; border-bottom: 1px solid #2b3848; }
.rse-tabs button { flex: 1; border: 0; border-radius: 0; background: transparent; padding: 8px; border-bottom: 2px solid transparent; }
.rse-tabs button.on { background: #17212e; border-bottom-color: #4a8bd0; }
.rse-body { flex: 1; min-height: 0; overflow: auto; padding: 8px; }
.rse-body.profile { display: flex; flex-direction: column; gap: 6px; overflow: hidden; }
.rse-list { display: flex; flex-direction: column; gap: 2px; max-height: 190px; overflow: auto; margin-bottom: 8px; }
.rse-item { display: flex; justify-content: space-between; gap: 8px; padding: 4px 8px; border-radius: 4px; cursor: pointer; border: 1px solid transparent; }
.rse-item:hover { background: #1b2635; } .rse-item.sel { background: #1f3350; border-color: #3a6aa8; }
.rse-item small { color: #8aa0b6; }
.rse-h { margin: 10px 0 4px; font-weight: 600; color: #b9c9da; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.rse-row { display: grid; grid-template-columns: 110px 1fr 56px; gap: 6px; align-items: center; margin: 3px 0; }
.rse-row.two { grid-template-columns: 110px 1fr; }
.rse-row input[type=range] { width: 100%; }
.rse-row input[type=number], .rse-row input[type=text], .rse-row select { width: 100%; min-width: 0; }
.rse-val { color: #9fb3c8; font-variant-numeric: tabular-nums; text-align: right; }
.rse canvas { width: 100%; height: 150px; border: 1px solid #2b3848; border-radius: 4px; display: block; flex: none; }
.rse-code { flex: 1; min-height: 120px; border: 1px solid #2b3848; border-radius: 4px; overflow: hidden; }
.rse-code .cm-editor { height: 100%; font-size: 12px; } .rse-code .cm-scroller { overflow: auto; font-family: ui-monospace, Menlo, monospace; }
.rse-err { color: #ff9b9b; font-size: 12px; min-height: 16px; white-space: pre-wrap; flex: none; }
.rse-hint { color: #7f93a8; font-size: 12px; }
.rse-swatch { border-left: 14px solid #888; padding: 6px 10px; background: #17212e; border-radius: 4px; font-size: 12px; color: #b9c9da; flex: none; }
.rse-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
`;

let injected = false;
export function injectEditorCss(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const style = document.createElement('style');
  style.dataset.roadsystem = 'editor';
  style.textContent = EDITOR_CSS;
  document.head.append(style);
}
