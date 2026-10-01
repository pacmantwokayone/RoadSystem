// The editor's DOM panels: toolbar, road list + inspector (auto-generated parameter controls),
// and the profile tab (live code editor + 2-D cross-section preview).

import type { ProfileLibrary } from '../profile/library';
import type { MaterialRegistry } from '../surface/materials';
import type { ParamDef } from '../profile/types';
import type { RoadPoint } from '../network/types';
import { createCodeEditor, type CodeEditorHandle } from './codeEditor';
import { h, injectEditorCss } from './dom';
import { drawProfile } from './profilePreview';
import type { RoadEditor } from './roadEditor';

export interface PanelDeps {
  library: ProfileLibrary;
  materials: MaterialRegistry;
}

type Control = { sync: () => void };

export function mountEditorPanels(editor: RoadEditor, root: HTMLElement, deps: PanelDeps): () => void {
  injectEditorCss();
  const { library, materials } = deps;
  const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
  const colorOf = (m: string): string => hex(materials.getDef(m).color);

  // ---- toolbar ----
  const btn = (label: string, title: string, onClick: () => void, cls = ''): HTMLButtonElement =>
    h('button', { class: cls, title, on: { click: onClick } }, label);
  const bSelect = btn('Wählen', 'Straßen und Punkte wählen/verschieben', () => editor.setTool('select'));
  const bDraw = btn('Zeichnen (D)', 'Klicks aufs Gelände setzen Punkte · Enter fertig', () => editor.setTool(editor.state.tool === 'draw' ? 'select' : 'draw'));
  const bUndo = btn('↶', 'Rückgängig (Strg+Z)', () => editor.undo());
  const bRedo = btn('↷', 'Wiederholen (Strg+Y)', () => editor.redo());
  const bSave = btn('Speichern', 'Auf dem Server speichern (Strg+S)', () => void editor.save(), 'primary');
  const bReload = btn('Neu laden', 'Vom Server neu laden', () => void editor.reload());
  const status = h('div', { class: 'rse-status' });
  const bar = h('div', { class: 'rse-bar' }, bSelect, bDraw, h('span', { class: 'rse-sep' }), bUndo, bRedo, h('span', { class: 'rse-sep' }), bSave, bReload, status);

  // ---- tabs ----
  const tabRoads = h('button', { class: 'on' }, 'Straßen');
  const tabProfile = h('button', {}, 'Profil (Code)');
  const tabMaterial = h('button', {}, 'Material');
  const tabBridge = h('button', {}, 'Brücke');
  const roadsBody = h('div', { class: 'rse-body' });
  const profileBody = h('div', { class: 'rse-body profile', style: { display: 'none' } });
  const materialBody = h('div', { class: 'rse-body profile', style: { display: 'none' } });
  const bridgeBody = h('div', { class: 'rse-body profile', style: { display: 'none' } });
  type Tab = 'roads' | 'profile' | 'material' | 'bridge';
  let activeTab: Tab = 'roads';
  const showTab = (t: Tab): void => {
    activeTab = t;
    tabRoads.classList.toggle('on', t === 'roads');
    tabProfile.classList.toggle('on', t === 'profile');
    tabMaterial.classList.toggle('on', t === 'material');
    tabBridge.classList.toggle('on', t === 'bridge');
    roadsBody.style.display = t === 'roads' ? '' : 'none';
    profileBody.style.display = t === 'profile' ? '' : 'none';
    materialBody.style.display = t === 'material' ? '' : 'none';
    bridgeBody.style.display = t === 'bridge' ? '' : 'none';
    if (t === 'profile') { followSelection(); requestAnimationFrame(redrawPreview); } // preview needs layout, the editor doesn't
    if (t === 'material') renderMaterial(true);
    if (t === 'bridge') renderBridge(true);
  };
  tabRoads.onclick = () => showTab('roads');
  tabProfile.onclick = () => showTab('profile');
  tabMaterial.onclick = () => showTab('material');
  tabBridge.onclick = () => showTab('bridge');

  const dock = h('div', { class: 'rse' }, bar, h('div', { class: 'rse-tabs' }, tabRoads, tabProfile, ...(editor.materialLibrary ? [tabMaterial] : []), ...(editor.bridgeLibrary ? [tabBridge] : [])), roadsBody, profileBody, materialBody, bridgeBody);
  root.append(dock);

  // ================= roads tab =================
  const listEl = h('div', { class: 'rse-list' });
  const nodeListEl = h('div', { class: 'rse-list' });
  const inspector = h('div');
  const activeProfileSel = h('select', { on: { change: () => { editor.state.activeProfile = activeProfileSel.value; } } });
  roadsBody.append(
    h('div', { class: 'rse-row two' }, h('span', {}, 'Neue Straßen'), activeProfileSel),
    h('div', { class: 'rse-h' }, 'Straßen'), listEl, nodeListEl, inspector,
  );

  let listKey = '';
  let nodeListKey = '';
  let inspKey = '';
  let controls: Control[] = [];

  const row = (label: string, input: HTMLElement, value?: HTMLElement): HTMLElement =>
    h('div', { class: value ? 'rse-row' : 'rse-row two' }, h('span', {}, label), input, value);

  function numberRow(label: string, get: () => number, set: (v: number) => void, opts: { min?: number; max?: number; step?: number; slider?: boolean; fmt?: (v: number) => string } = {}): HTMLElement {
    const fmt = opts.fmt ?? ((v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')));
    const val = h('span', { class: 'rse-val' }, fmt(get()));
    const show = (v: number): string => String(Number(v.toFixed(3))); // no 857.516192058547 in the UI
    const input = h('input', {
      type: opts.slider ? 'range' : 'number', min: opts.min, max: opts.max, step: opts.step ?? 'any',
      value: show(get()),
      on: { input: () => { const v = Number((input as HTMLInputElement).value); if (Number.isFinite(v)) { set(v); val.textContent = fmt(v); } }, change: () => editor.model.breakCoalesce() },
    }) as HTMLInputElement;
    controls.push({ sync: () => { if (document.activeElement !== input) input.value = show(get()); val.textContent = fmt(get()); } });
    return opts.slider ? row(label, input, val) : row(label, input);
  }

  function selectRow<T extends string>(label: string, options: Array<[T, string]>, get: () => T, set: (v: T) => void): HTMLElement {
    const sel = h('select', {}, ...options.map(([v, text]) => h('option', { value: v }, text))) as HTMLSelectElement;
    sel.value = get();
    sel.onchange = () => set(sel.value as T);
    controls.push({ sync: () => { if (document.activeElement !== sel) sel.value = get(); } });
    return row(label, sel);
  }

  function paramRow(key: string, def: ParamDef, scope: 'profile' | 'bridge' = 'profile'): HTMLElement {
    const road = (): Record<string, number | boolean | string> => (scope === 'bridge' ? editor.selectedRoad?.bridgeParams : editor.selectedRoad?.params) ?? {};
    const cur = (): number | boolean | string => road()[key] ?? def.default;
    const setValue = (v: number | boolean | string): void => (scope === 'bridge' ? editor.setBridgeParam(key, v) : editor.setParam(key, v));
    const label = def.label ?? key;
    if (def.type === 'bool') {
      const cb = h('input', { type: 'checkbox', checked: Boolean(cur()), on: { change: () => setValue(cb.checked) } }) as HTMLInputElement;
      controls.push({ sync: () => { cb.checked = Boolean(cur()); } });
      return row(label, cb);
    }
    if (def.type === 'enum') return selectRow(label, (def.options ?? []).map((o) => [o, o] as [string, string]), () => String(cur()), (v) => setValue(v));
    return numberRow(label, () => Number(cur()), (v) => setValue(v), { min: def.min, max: def.max, step: def.step ?? (def.type === 'int' ? 1 : 'any' as unknown as number), slider: def.min !== undefined && def.max !== undefined });
  }

  function pointSection(road: NonNullable<typeof editor.selectedRoad>, idx: number): HTMLElement {
    const pt = (): RoadPoint => editor.selectedRoad?.points[idx] ?? road.points[idx];
    const box = h('div', {}, h('div', { class: 'rse-h' }, `Punkt ${idx + 1} / ${road.points.length}`));
    box.append(
      row('Position x / z', h('span', { class: 'rse-val', style: { textAlign: 'left' } }, ''), undefined),
    );
    const posEl = box.lastElementChild!.lastElementChild as HTMLElement;
    controls.push({ sync: () => { const p = pt(); posEl.textContent = `${p.x.toFixed(1)} / ${p.z.toFixed(1)}`; } });
    box.append(
      numberRow('Höhe y (m)', () => pt().y, (v) => editor.setPointAttr(idx, { y: v }), { step: 0.1, fmt: (v) => v.toFixed(1) }),
      selectRow('Typ', [['road', 'Straße'], ['bridge', 'Brücke'], ['tunnel', 'Tunnel'], ['gallery', 'Galerie']], () => pt().mode ?? 'road', (v) => editor.setPointAttr(idx, { mode: v })),
      selectRow('Höhe folgt', [['drape', 'Terrain'], ['fixed', 'fest (y)']], () => pt().elev ?? 'drape', (v) => editor.setPointAttr(idx, { elev: v })),
      numberRow('Breite ×', () => pt().widthScale ?? 1, (v) => editor.setPointAttr(idx, { widthScale: v }), { min: 0.5, max: 3, step: 0.05, slider: true, fmt: (v) => v.toFixed(2) }),
      numberRow('Querneigung °', () => ((pt().banking ?? 0) * 180) / Math.PI, (v) => editor.setPointAttr(idx, { banking: (v * Math.PI) / 180 }), { min: -15, max: 15, step: 0.5, slider: true, fmt: (v) => v.toFixed(1) }),
      h('div', { class: 'rse-actions' }, h('button', { class: 'danger', on: { click: () => editor.deleteSelectedPoint() } }, 'Punkt löschen (Entf)')),
    );
    return box;
  }

  function renderRoads(): void {
    const names = library.names();
    if (activeProfileSel.options.length !== names.length || Array.from(activeProfileSel.options).some((o, i) => o.value !== names[i])) {
      activeProfileSel.replaceChildren(...names.map((n) => h('option', { value: n }, n)));
    }
    activeProfileSel.value = editor.state.activeProfile;

    const sel = editor.state.roadId;
    const nsel = editor.state.nodeId;
    const nodes = editor.model.nodeList;
    const nodeKey = nodes.map((n) => `${n.id}:${n.radius ?? ''}:${n.control ?? ''}:${editor.nodeArms(n.id).length}`).join('|') + `#${nsel}`;
    if (nodeKey !== nodeListKey) {
      nodeListKey = nodeKey;
      nodeListEl.replaceChildren(
        ...(nodes.length ? [h('div', { class: 'rse-h', style: 'margin:2px 0' }, 'Kreuzungen')] : []),
        ...nodes.map((n, i) => h('div', { class: `rse-item${n.id === nsel ? ' sel' : ''}`, on: { click: () => editor.selectNode(n.id) } },
          h('span', {}, `Kreuzung ${i + 1}`), h('small', {}, `${editor.nodeArms(n.id).length} Arme · R ${(n.radius ?? 6).toFixed(1)} m${n.control === 'signals' ? ' · Ampel' : ''}`))),
      );
    }
    const nk = editor.model.list.map((r) => `${r.id}:${r.name}:${r.profile}`).join('|') + `#${sel}`;
    if (nk !== listKey) {
      listKey = nk;
      listEl.replaceChildren(...editor.model.list.map((r) =>
        h('div', { class: `rse-item${r.id === sel ? ' sel' : ''}`, on: { click: () => editor.selectRoad(r.id) } }, h('span', {}, r.name), h('small', {}, `${r.profile} · ${r.points.length} Pkt`))));
      if (!editor.model.list.length) listEl.append(h('div', { class: 'rse-hint' }, 'Noch keine Straßen. „Zeichnen“ wählen und aufs Gelände klicken.'));
    }

    const road = editor.selectedRoad;
    const node = editor.selectedNode;
    const ik = node
      ? `node|${node.id}|${node.control ?? ''}|${editor.nodeArms(node.id).map((a) => a.roadId + a.end).join(',')}`
      : road ? `${road.id}|${road.profile}|${editor.state.pointIndex}|${road.points.length}|${library.names().join(',')}|${road.bridge ?? ''}|${road.points.some((p) => p.mode === 'bridge')}|${editor.bridgeLibrary?.names().join(',') ?? ''}` : 'none';
    if (ik !== inspKey) {
      inspKey = ik;
      controls = [];
      inspector.replaceChildren();
      if (node) {
        inspector.append(
          h('div', { class: 'rse-h' }, 'Kreuzung'),
          numberRow('Kurvenradius (m)', () => editor.selectedNode?.radius ?? 6, (v) => editor.setNodeRadius(v), { min: 1, max: 25, step: 0.5, slider: true, fmt: (v) => v.toFixed(1) }),
          selectRow('Vortritt', [['auto', 'automatisch (Rang)'], ['none', 'keine (Rechtsvortritt)'], ['stop', 'Stop'], ['yield', 'Kein Vortritt'], ['signals', 'Ampel']],
            () => editor.selectedNode?.control ?? 'auto', (v) => { editor.setNodeSettings({ control: v }); inspKey = ''; }),
          selectRow('Fussgängerstreifen', [['auto', 'automatisch'], ['none', 'keine'], ['all', 'überall']], () => editor.selectedNode?.crosswalks ?? 'auto', (v) => editor.setNodeSettings({ crosswalks: v })),
          ...(node.control === 'signals' ? [
            selectRow('Ampelmodus', [['fixed', 'Festzeit'], ['flashing', 'gelb blinkend'], ['off', 'aus']], () => editor.selectedNode?.signalMode ?? 'fixed', (v) => editor.setNodeSettings({ signalMode: v })),
            numberRow('Grünzeit (s)', () => editor.selectedNode?.greenS ?? 20, (v) => editor.setNodeSettings({ greenS: v }), { min: 5, max: 60, step: 1, slider: true, fmt: (v) => v.toFixed(0) }),
          ] : []),
          h('div', { class: 'rse-h' }, 'Arme'),
          ...editor.nodeArms(node.id).map((a) => h('div', { class: 'rse-item', on: { click: () => editor.selectRoad(a.roadId) } }, h('span', {}, a.name), h('small', {}, a.end === 'start' ? 'Anfang' : 'Ende'))),
          h('div', { class: 'rse-hint', style: 'margin-top:6px' }, 'Marker ziehen verschiebt die Kreuzung samt aller Straßen. Ein freies Straßenende auf die Marker, ein anderes Ende oder eine andere Straße ziehen verbindet sie.'),
          h('div', { class: 'rse-actions' }, h('button', { class: 'danger', on: { click: () => editor.dissolveSelectedNode() } }, 'Kreuzung auflösen (Entf)')),
        );
      } else if (!road) {
        inspector.append(h('div', { class: 'rse-hint' }, 'Straße anklicken, um sie zu bearbeiten. Punkte lassen sich ziehen; Umschalt+Klick (oder Doppelklick) auf die Straße fügt einen Punkt ein.'));
      } else {
        const nameInput = h('input', { type: 'text', value: road.name, on: { input: () => editor.rename(nameInput.value), change: () => editor.model.breakCoalesce() } }) as HTMLInputElement;
        controls.push({ sync: () => { if (document.activeElement !== nameInput) nameInput.value = editor.selectedRoad?.name ?? ''; } });
        const info = h('div', { class: 'rse-hint' });
        controls.push({ sync: () => { const i = editor.roadInfo(road.id); info.textContent = i ? `${i.length.toFixed(0)} m · Chunks ${i.ready}/${i.chunks}` : ''; } });
        inspector.append(
          h('div', { class: 'rse-h' }, 'Straße'),
          row('Name', nameInput),
          selectRow('Profil', library.names().map((n) => [n, n] as [string, string]), () => editor.selectedRoad?.profile ?? road.profile, (v) => editor.setProfile(v)),
        );
        const schema = library.getSchema(road.profile);
        for (const [k, def] of Object.entries(schema)) inspector.append(paramRow(k, def));
        const bl = editor.bridgeLibrary;
        if (bl && road.points.some((p) => p.mode === 'bridge')) {
          const auto = editor.effectiveBridgeName({ ...road, bridge: undefined });
          inspector.append(
            h('div', { class: 'rse-h' }, 'Brücke'),
            selectRow('Typ', [['', `automatisch (${auto})`], ...bl.names().map((n) => [n, n] as [string, string])], () => editor.selectedRoad?.bridge ?? '', (v) => editor.setRoadBridge(v === '' ? undefined : v)),
          );
          for (const [k, def] of Object.entries(bl.getSchema(editor.effectiveBridgeName(road)))) inspector.append(paramRow(k, def, 'bridge'));
          inspector.append(h('div', { class: 'rse-hint' }, 'Brücke = Punkte mit Typ „Brücke“; Anfang und Ende stehen genau auf diesen Punkten. Bauwerk-Code im Tab „Brücke“.'));
        }
        inspector.append(info, h('div', { class: 'rse-actions' }, h('button', { class: 'danger', on: { click: () => { if (confirm(`Straße „${road.name}“ löschen?`)) editor.deleteSelectedRoad(); } } }, 'Straße löschen')));
        if (editor.state.pointIndex !== undefined && editor.state.pointIndex < road.points.length) inspector.append(pointSection(road, editor.state.pointIndex));
        else inspector.append(h('div', { class: 'rse-hint', style: 'margin-top:8px' }, 'Punkt-Handle anklicken, um Typ, Höhe, Breite und Querneigung zu bearbeiten.'));
      }
    }
    for (const c of controls) c.sync();
  }

  // ================= profile tab =================
  let profileName = editor.state.activeProfile;
  const profSel = h('select', { on: { change: () => { profileName = profSel.value; loadProfileIntoEditor(); } } });
  const canvas = h('canvas', {}) as HTMLCanvasElement;
  const errEl = h('div', { class: 'rse-err' });
  const codeHost = h('div', { class: 'rse-code' });
  const actions = h('div', { class: 'rse-actions', style: 'margin:0' },
    h('button', { title: 'Kopie unter neuem Namen anlegen', on: { click: () => {
      const n = prompt('Name des neuen Profils (z. B. „kantonsstrasse“):', `${profileName}_2`);
      if (!n) return;
      const r = editor.duplicateProfile(profileName, n.trim());
      if (!r.ok) { errEl.textContent = r.error ?? ''; return; }
      profileName = n.trim(); renderProfile(true);
    } } }, 'Kopie …'),
    h('button', { title: 'Standard-Code wiederherstellen', on: { click: () => { if (editor.resetProfileToPreset(profileName)) loadProfileIntoEditor(); } } }, 'Preset zurücksetzen'),
    h('button', { class: 'danger', on: { click: () => {
      if (!confirm(`Profil „${profileName}“ löschen?`)) return;
      if (!editor.deleteProfile(profileName)) { errEl.textContent = 'Profil wird noch von Straßen benutzt (oder ist das Standardprofil).'; return; }
      profileName = library.fallback; renderProfile(true);
    } } }, 'Löschen'),
  );
  profileBody.append(
    h('div', { class: 'rse-row two', style: 'margin:0' }, h('span', {}, 'Profil'), profSel),
    canvas, actions, codeHost, errEl,
    h('div', { class: 'rse-hint' }, 'Änderungen wirken sofort an allen Straßen mit diesem Profil. „Speichern“ sichert sie auf dem Server.'),
  );

  let code: CodeEditorHandle | null = null;
  let lastError: string | undefined;

  function redrawPreview(): void {
    if (activeTab !== 'profile') return;
    const w = canvas.clientWidth, hgt = canvas.clientHeight;
    if (!w || !hgt) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr); }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const road = editor.selectedRoad;
    const params = road && road.profile === profileName ? road.params : undefined;
    try {
      drawProfile(ctx, library.resolve(profileName, params), w, hgt, colorOf, lastError);
    } catch (e) {
      errEl.textContent = String(e);
    }
  }

  function loadProfileIntoEditor(): void {
    lastError = undefined;
    errEl.textContent = '';
    const src = library.getSource(profileName) ?? '';
    if (!code) {
      code = createCodeEditor(codeHost, {
        doc: src, materialNames: () => materials.names(),
        onChange: (s) => {
          const r = editor.applyProfileSource(profileName, s);
          lastError = r.ok ? undefined : r.error;
          errEl.textContent = r.ok ? '' : r.error ?? '';
          redrawPreview();
        },
      });
    } else code.setValue(src);
    redrawPreview();
  }

  function renderProfile(force = false): void {
    const names = library.names();
    if (force || profSel.options.length !== names.length || Array.from(profSel.options).some((o, i) => o.value !== names[i])) {
      profSel.replaceChildren(...names.map((n) => h('option', { value: n }, n)));
    }
    if (!names.includes(profileName)) profileName = library.fallback;
    profSel.value = profileName;
    if (force || !code) loadProfileIntoEditor();
    else if (!code.focused()) { const src = library.getSource(profileName) ?? ''; if (src !== code.getValue() && !lastError) code.setValue(src); }
    redrawPreview();
  }

  let lastFollowed: string | undefined;
  function followSelection(): void {
    const r = editor.selectedRoad;
    const key = r ? `${r.id}:${r.profile}` : undefined;
    if (key !== lastFollowed) {
      lastFollowed = key;
      if (r && library.has(r.profile)) profileName = r.profile;
    }
    renderProfile(!code);
  }

  // ================= material tab =================
  const matLib = editor.materialLibrary;
  let materialName = 'asphalt';
  const matSel = h('select', { on: { change: () => { materialName = matSel.value; renderMaterial(true); } } });
  const matSwatch = h('div', { class: 'rse-swatch' });
  const matErr = h('div', { class: 'rse-err' });
  const matCodeHost = h('div', { class: 'rse-code' });
  let matCode: CodeEditorHandle | null = null;
  const weatherRow = (label: string, key: 'wet' | 'snow' | 'age'): HTMLElement => {
    const val = h('span', { class: 'rse-val' }, materials.weather[key].toFixed(2));
    const input = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: String(materials.weather[key]),
      on: { input: () => { const v = Number((input as HTMLInputElement).value); materials.setWeather({ [key]: v }); val.textContent = v.toFixed(2); } } }) as HTMLInputElement;
    return h('div', { class: 'rse-row' }, h('span', {}, label), input, val);
  };
  const matActions = h('div', { class: 'rse-actions', style: 'margin:0' },
    h('button', { title: 'Kopie unter neuem Namen anlegen', on: { click: () => {
      const n = prompt('Name des neuen Materials:', `${materialName}_2`);
      if (!n) return;
      const r = editor.duplicateMaterial(materialName, n.trim());
      if (!r.ok) { matErr.textContent = r.error ?? ''; return; }
      materialName = n.trim(); renderMaterial(true);
    } } }, 'Kopie …'),
    h('button', { title: 'Standard-Code wiederherstellen', on: { click: () => { if (editor.resetMaterialToDefault(materialName)) renderMaterial(true); } } }, 'Standard zurücksetzen'),
  );
  materialBody.append(
    h('div', { class: 'rse-row two', style: 'margin:0' }, h('span', {}, 'Material'), matSel),
    matSwatch, matActions, matCodeHost, matErr,
    h('div', { class: 'rse-h', style: 'margin:4px 0 0' }, 'Wetter (alle Straßen)'),
    weatherRow('Nass', 'wet'), weatherRow('Schnee', 'snow'), weatherRow('Alter / Verschleiss', 'age'),
    h('div', { class: 'rse-hint' }, 'Änderungen wirken sofort an allen Strassen, die dieses Material benutzen.'),
  );

  function renderMaterial(force = false): void {
    if (!matLib || activeTab !== 'material') return;
    const names = matLib.names();
    if (force || matSel.options.length !== names.length) matSel.replaceChildren(...names.map((n) => h('option', { value: n }, n)));
    if (!names.includes(materialName)) materialName = names[0];
    matSel.value = materialName;
    const def = matLib.getDef(materialName);
    if (def) matSwatch.textContent = `${def.kind} · ${hex(def.color)} · Kachel ${def.tileM} m`;
    if (def) matSwatch.style.borderLeftColor = hex(def.color);
    const src = matLib.getSource(materialName) ?? '';
    if (!matCode) {
      matCode = createCodeEditor(matCodeHost, {
        api: 'material', doc: src, materialNames: () => [],
        onChange: (s) => {
          const r = editor.applyMaterialSource(materialName, s);
          matErr.textContent = r.ok ? '' : r.error ?? '';
        },
      });
    } else if (force || (!matCode.focused() && src !== matCode.getValue() && !matErr.textContent)) {
      matCode.setValue(src);
      if (force) matErr.textContent = '';
    }
  }

  // ================= bridge tab =================
  const bridgeLib = editor.bridgeLibrary;
  let bridgeName = 'balkenbruecke';
  const brSel = h('select', { on: { change: () => { bridgeName = brSel.value; renderBridge(true); } } });
  const brInfo = h('div', { class: 'rse-swatch' });
  const brErr = h('div', { class: 'rse-err' });
  const brCodeHost = h('div', { class: 'rse-code' });
  let brCode: CodeEditorHandle | null = null;
  const brActions = h('div', { class: 'rse-actions', style: 'margin:0' },
    h('button', { title: 'Kopie unter neuem Namen anlegen', on: { click: () => {
      const n = prompt('Name der neuen Brücke:', `${bridgeName}_2`);
      if (!n) return;
      const r = editor.duplicateBridge(bridgeName, n.trim());
      if (!r.ok) { brErr.textContent = r.error ?? ''; return; }
      bridgeName = n.trim(); renderBridge(true);
    } } }, 'Kopie …'),
    h('button', { title: 'Standard-Code wiederherstellen', on: { click: () => { if (editor.resetBridgeToPreset(bridgeName)) renderBridge(true); } } }, 'Standard zurücksetzen'),
  );
  const proposalsEl = h('div');
  bridgeBody.append(
    h('div', { class: 'rse-row two', style: 'margin:0' }, h('span', {}, 'Brückentyp'), brSel),
    brInfo, brActions, brCodeHost, brErr,
    h('div', { class: 'rse-hint' }, 'Eine Brücke ist ein Abschnitt einer Straße (Punkte mit Typ „Brücke“). Pfeiler wachsen bis zum Terrain, Spannweiten teilen den Abschnitt gleichmässig.'),
    proposalsEl,
  );

  function renderProposals(): void {
    proposalsEl.replaceChildren();
    if (!editor.hasRivers) return;
    const list = editor.bridgeProposals();
    proposalsEl.append(h('div', { class: 'rse-h' }, `Flusskreuzungen (${list.length})`));
    if (!list.length) proposalsEl.append(h('div', { class: 'rse-hint' }, 'Keine Straße kreuzt einen Fluss ohne Brücke.'));
    for (const p of list) {
      const road = editor.model.get(p.roadId);
      proposalsEl.append(h('div', { class: 'rse-item', on: { click: () => editor.selectRoad(p.roadId) } },
        h('span', {}, `${road?.name ?? p.roadId} × ${p.riverName ?? p.riverId}`), h('small', {}, `${(p.s1 - p.s0).toFixed(0)} m`),
        h('button', { on: { click: (e: Event) => { e.stopPropagation(); editor.applyBridgeProposal(p); renderProposals(); } } }, 'Brücke setzen')));
    }
  }

  function renderBridge(force = false): void {
    if (!bridgeLib || activeTab !== 'bridge') return;
    const names = bridgeLib.names();
    if (force || brSel.options.length !== names.length) brSel.replaceChildren(...names.map((n) => h('option', { value: n }, n)));
    if (!names.includes(bridgeName)) bridgeName = names[0];
    brSel.value = bridgeName;
    const b = bridgeLib.resolve(bridgeName);
    const parts = [`Deck ${b.deck.thickness} m`, b.girders && `${b.girders.count} Träger`, b.piers && `Pfeiler ≤ ${b.piers.maxSpan} m (${b.piers.shape})`, b.arch && 'Bogen', b.truss && 'Fachwerk', `Geländer: ${b.railing.type}`].filter(Boolean);
    brInfo.textContent = parts.join(' · ');
    const src = bridgeLib.getSource(bridgeName) ?? '';
    if (!brCode) {
      brCode = createCodeEditor(brCodeHost, {
        api: 'bridge', doc: src, materialNames: () => materials.names(),
        onChange: (s) => {
          const r = editor.applyBridgeSource(bridgeName, s);
          brErr.textContent = r.ok ? '' : r.error ?? '';
        },
      });
    } else if (force || (!brCode.focused() && src !== brCode.getValue() && !brErr.textContent)) {
      brCode.setValue(src);
      if (force) brErr.textContent = '';
    }
    if (force) renderProposals();
  }

  // ================= glue =================
  function renderBar(): void {
    bSelect.classList.toggle('on', editor.state.tool === 'select');
    bDraw.classList.toggle('on', editor.state.tool === 'draw');
    bUndo.disabled = !editor.model.canUndo;
    bRedo.disabled = !editor.model.canRedo;
    bUndo.title = `Rückgängig${editor.model.undoLabel ? `: ${editor.model.undoLabel}` : ''} (Strg+Z)`;
    bRedo.title = `Wiederholen${editor.model.redoLabel ? `: ${editor.model.redoLabel}` : ''} (Strg+Y)`;
    bSave.textContent = editor.isDirty ? 'Speichern ●' : 'Speichern';
    status.textContent = editor.state.status.text || (editor.state.tool === 'draw' ? 'Klick setzt Punkte · Enter = fertig · ⌫ = letzter Punkt · Esc = abbrechen' : '');
    status.className = `rse-status${editor.state.status.kind === 'error' ? ' err' : editor.state.status.kind === 'ok' ? ' ok' : ''}`;
  }

  const render = (): void => {
    renderBar();
    renderRoads();
    if (activeTab === 'profile') followSelection();
    if (activeTab === 'material') renderMaterial();
    if (activeTab === 'bridge') renderBridge();
  };
  const off = editor.onState(render);
  const offLib = library.onChange(() => { if (activeTab === 'profile') renderProfile(); });
  render();

  return () => {
    off(); offLib();
    code?.destroy();
    matCode?.destroy();
    brCode?.destroy();
    dock.remove();
  };
}
