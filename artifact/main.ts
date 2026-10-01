// Wasser-Testfeld: the road module's water system on a mock terrain, with the real editor. Bundled into one HTML page.
//
// Scene: a plateau lake high in the mountains → mountain stream with rapids → ~400 m waterfall into a plunge pool → valley river with a small
// fall, a bridge and a side stream → a lower lake. Everything can be edited: draw rivers (R) and lakes (L), make a segment a rapids or a fall.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { registerPrecompiled } from '../src/core/codeEval';
import { MockStreamTerrain } from '../src/terrain/mockStreamTerrain';
import { RoadSystem } from '../src/runtime/roadSystem';
import { RoadMeshLayer } from '../src/mesh/roadMeshLayer';
import { PropLayer } from '../src/props/propLayer';
import { IslandLayer } from '../src/props/islandLayer';
import { SignalLayer } from '../src/props/signalLayer';
import { BridgeLayer } from '../src/structures/bridgeLayer';
import { BridgeLibrary } from '../src/structures/library';
import { ProfileLibrary } from '../src/profile/library';
import { MaterialRegistry } from '../src/surface/materials';
import { MaterialLibrary } from '../src/surface/materialLibrary';
import { StorageStore } from '../src/store/storageStore';
import { MemoryStore } from '../src/store/memoryStore';
import type { RoadStore } from '../src/store/types';
import { WaterLibrary } from '../src/water/styleLibrary';
import { WaterSystem } from '../src/water/system';
import { WaterLayer } from '../src/water/waterLayer';
import { bridgePierObstacles } from '../src/water/bridgeObstacles';
import { waterDemoHeight, waterDemoNetwork, waterDemoWaters, WATER_DEMO_VIEWS } from '../src/water/demoScene';
import { RoadEditor } from '../src/editor/roadEditor';
import { mountEditorPanels } from '../src/editor/panels';
import { PRECOMPILED } from './precompiled.gen';

registerPrecompiled(PRECOMPILED as never);

// The page's viewer never shows confirm() / prompt() dialogs (they return false / null at once), which would silently disable the editor's
// delete and copy buttons. Everything destructive here is one undo step (Strg+Z), so confirm automatically and take the suggested name.
window.confirm = () => true;
window.prompt = (_message?: string, suggestion?: string) => suggestion ?? null;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const stage = $('stage');

// ---- renderer, scene, light ------------------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.domElement.style.touchAction = 'none';
stage.appendChild(renderer.domElement);

const SKY = 0x9db8d0;
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.FogExp2(SKY, 0.00018);
const hemi = new THREE.HemisphereLight(0xdfeaff, 0x4a4a3a, 1.0);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.7);
scene.add(sun);
const sunDir = new THREE.Vector3();
function setSun(elevDeg: number): void {
  const e = (elevDeg * Math.PI) / 180, az = 2.6;
  sunDir.set(Math.cos(e) * Math.cos(az), Math.sin(e), Math.cos(e) * Math.sin(az));
  sun.position.copy(sunDir).multiplyScalar(4000);
  sun.intensity = 0.35 + 1.5 * Math.min(1, Math.sin(e) * 1.4);
  hemi.intensity = 0.55 + 0.6 * Math.min(1, Math.sin(e) * 1.6);
  const warm = Math.max(0, 1 - elevDeg / 30);
  sun.color.setRGB(1, 1 - 0.28 * warm, 1 - 0.55 * warm);
  waterLayer?.setLight(sunDir);
}

const camera = new THREE.PerspectiveCamera(60, innerWidth / Math.max(1, innerHeight), 0.3, 40000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.maxDistance = 6000;
controls.minDistance = 4;

// ---- world --------------------------------------------------------------------------------------------------------------
const terrain = new MockStreamTerrain({ buildMeshes: true, heightFn: waterDemoHeight, loadLatencyFrames: 1, maxConcurrentLoads: 24 });
scene.add(terrain.group);
// the scene is ~2.5 km long: have its ground ready at full resolution before the first frame
terrain.loadRectSync(2350, 2400, 5050, 3700, 0);

const library = new ProfileLibrary();
const materials = new MaterialRegistry();
const materialLibrary = new MaterialLibrary();
materials.setWeather({ wet: 0.25, snow: 0, age: 0.3 });
const bridgeLibrary = new BridgeLibrary();
const waterLibrary = new WaterLibrary();
const roads = new RoadSystem(terrain, (d) => library.resolve(d.profile, d.params), undefined, (d, p) => bridgeLibrary.forRoad(d, p));
const meshLayer = new RoadMeshLayer(roads, materials);
scene.add(meshLayer.group);
const propLayer = new PropLayer(roads, { drawDistance: 600 });
scene.add(propLayer.group);
const islandLayer = new IslandLayer(roads, terrain, propLayer.assets, propLayer.materials);
scene.add(islandLayer.group);
const bridgeLayer = new BridgeLayer(roads, materials, { drawDistance: 1800 });
scene.add(bridgeLayer.group);
const signalLayer = new SignalLayer(roads, { drawDistance: 900 });
scene.add(signalLayer.group);

const waterSystem = new WaterSystem(terrain, waterLibrary);
const waterLayer: WaterLayer = new WaterLayer(waterSystem, terrain, materials, { drawDistance: 4200, externalObstacles: bridgePierObstacles(roads, waterSystem) });
scene.add(waterLayer.group);
setSun(48);

// ---- storage ------------------------------------------------------------------------------------------------------------
let store: RoadStore;
try {
  localStorage.setItem('wasser-testfeld-probe', '1');
  store = new StorageStore(localStorage, 'wasser-testfeld-v1');
} catch {
  store = new MemoryStore();
}

// ---- editor ---------------------------------------------------------------------------------------------------------------
const ray = new THREE.Raycaster();
const editor = new RoadEditor({
  host: {
    scene, camera, domElement: renderer.domElement, uiRoot: document.body,
    setCameraEnabled: (on) => { controls.enabled = on; },
    pickGround(ev) {
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
      return ray.intersectObjects(terrain.group.children.filter((c) => c.visible), false)[0]?.point ?? null;
    },
  },
  system: roads, library, materials, materialLibrary, bridgeLibrary, terrain, store, location: 'wasser-testfeld', roadGroup: meshLayer.group,
  water: { system: waterSystem, library: waterLibrary, terrain },
  confirm: () => true, // no blocking dialogs in the viewer: deleting is undoable (Strg+Z)
});
const dock = mountEditorPanels(editor, document.body, { library, materials });

function seedScene(): void {
  const w = waterDemoWaters();
  const net = waterDemoNetwork();
  editor.model.load({ version: 1, roads: net.roads, nodes: net.nodes, rivers: w.rivers, lakes: w.lakes });
  editor.setStatus('Beispielszene geladen', 'info');
}
void (async () => {
  try { await editor.load(); } catch { /* nothing stored */ }
  if (!editor.model.riverList.length && !editor.model.lakeList.length) seedScene();
})();

// ---- camera presets ---------------------------------------------------------------------------------------------------------
type Cam = [number, number, number, number, number, number];
let tween: { t: number; dur: number; from: Cam; to: Cam } | null = null;
function currentCam(): Cam {
  return [camera.position.x, camera.position.y, camera.position.z, controls.target.x, controls.target.y, controls.target.z];
}
/** on a portrait screen the horizontal field of view is narrow: stand further back */
function framed(c: Cam): Cam {
  const k = camera.aspect < 1 ? 1.4 : 1;
  return [c[3] + (c[0] - c[3]) * k, c[4] + (c[1] - c[4]) * k, c[5] + (c[2] - c[5]) * k, c[3], c[4], c[5]];
}
function flyTo(to: Cam, seconds = 1.6): void {
  tween = { t: 0, dur: seconds, from: currentCam(), to: framed(to) };
}
const startCam: Cam = framed(WATER_DEMO_VIEWS.overview.cam);
camera.position.set(startCam[0], startCam[1], startCam[2]);
controls.target.set(startCam[3], startCam[4], startCam[5]);
controls.update();

const viewsEl = $('views-list');
for (const [key, v] of Object.entries(WATER_DEMO_VIEWS)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = v.label;
  b.dataset.view = key;
  b.addEventListener('click', () => { flyTo(v.cam); document.querySelectorAll('#views-list button').forEach((x) => x.classList.toggle('on', x === b)); });
  viewsEl.appendChild(b);
}

// ---- controls in the page --------------------------------------------------------------------------------------------------
const sunInput = $<HTMLInputElement>('sun');
sunInput.addEventListener('input', () => setSun(Number(sunInput.value)));
const partInput = $<HTMLInputElement>('particles');
partInput.addEventListener('change', () => { if (waterLayer.particles) waterLayer.particles.group.visible = partInput.checked; });
$('reset').addEventListener('click', () => { seedScene(); toast('Beispielszene geladen – deine Änderungen sind verworfen'); });
const wireInput = $<HTMLInputElement>('wire');
wireInput.addEventListener('change', () => { terrain.group.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material & { wireframe?: boolean }; if ((o as THREE.Mesh).isMesh && m && 'wireframe' in m) m.wireframe = wireInput.checked; }); });
const sideEl = $('side');
const sideBtn = $('toggle-side');
const dockEl = document.querySelector('.rse') as HTMLElement;
const dockBtn = $('toggle-dock');
const narrowQuery = matchMedia('(max-width: 820px)');
function setPanel(which: 'side' | 'dock', open: boolean): void {
  const [el, btn, cls] = which === 'side' ? [sideEl, sideBtn, 'side-open'] as const : [dockEl, dockBtn, 'dock-open'] as const;
  el.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle(cls, open);
  // on a phone the two panels are sheets over the same spot: one at a time
  if (open && narrowQuery.matches) { const other = which === 'side' ? 'dock' : 'side'; if (!(other === 'side' ? sideEl : dockEl).hidden) setPanel(other, false); }
}
sideBtn.addEventListener('click', () => setPanel('side', sideEl.hidden));
dockBtn.addEventListener('click', () => setPanel('dock', dockEl.hidden));
setPanel('side', innerWidth >= 1500);
setPanel('dock', !narrowQuery.matches);

let toastTimer = 0;
function toast(text: string): void {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, 3200);
}

// does this page run style code? (a strict CSP forbids eval; the built-in styles still work)
let evalOk = true;
try { new Function('return 1')(); } catch { evalOk = false; }
if (!evalOk) $('eval-note').hidden = false;

// ---- Längsprofil: the water level along a river, to scale ------------------------------------------------------------------
const profileEl = $('profile');
const profileTitle = $('profile-title');
let profileKey = '';
function renderProfile(): void {
  const sel = editor.water?.selection;
  let rt = sel?.kind === 'river' ? waterSystem.rivers.find((r) => r.def.id === sel.id) : undefined;
  if (!rt) rt = waterSystem.rivers.slice().sort((a, b) => (b.hydro.samples[0]?.level ?? 0) - (b.hydro.samples[b.hydro.samples.length - 1]?.level ?? 0) - ((a.hydro.samples[0]?.level ?? 0) - (a.hydro.samples[a.hydro.samples.length - 1]?.level ?? 0)))[0];
  const key = rt ? `${rt.def.id}:${rt.hydro.length.toFixed(1)}:${rt.hydro.samples.length}:${rt.hydro.samples[0]?.level.toFixed(2)}` : '';
  if (key === profileKey) return;
  profileKey = key;
  if (!rt || rt.hydro.samples.length < 2) { profileEl.replaceChildren(); profileTitle.textContent = 'Längsprofil'; return; }
  const S = rt.hydro.samples;
  const W = 280, H = 118, L = 38, R = 8, T = 10, B = 20;
  const len = rt.hydro.length;
  let lo = Infinity, hi = -Infinity;
  for (const p of S) { lo = Math.min(lo, p.level); hi = Math.max(hi, p.level); }
  if (hi - lo < 1) hi = lo + 1;
  const X = (v: number): number => L + (v / len) * (W - L - R);
  const Y = (v: number): number => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const step = Math.max(1, Math.floor(S.length / 220));
  const ns = 'http://www.w3.org/2000/svg';
  const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Längsprofil ${rt.def.name}` });
  // area under the whole path, then the line, with falls and rapids drawn on top in their own weights
  let area = `M ${X(0)} ${H - B}`;
  for (let i = 0; i < S.length; i += step) area += ` L ${X(S[i].s).toFixed(1)} ${Y(S[i].level).toFixed(1)}`;
  area += ` L ${X(S[S.length - 1].s).toFixed(1)} ${Y(S[S.length - 1].level).toFixed(1)} L ${X(len)} ${H - B} Z`;
  svg.append(el('path', { d: area, class: 'p-area' }));
  for (const f of [0.25, 0.5, 0.75]) svg.append(el('line', { x1: L, x2: W - R, y1: Y(lo + (hi - lo) * f).toFixed(1), y2: Y(lo + (hi - lo) * f).toFixed(1), class: 'p-grid' }));
  const run = (kind: string): string => {
    let d = '';
    let on = false;
    for (let i = 0; i < S.length; i++) {
      const hit = S[i].kind === kind;
      if (hit) { d += `${on ? ' L' : ' M'} ${X(S[i].s).toFixed(1)} ${Y(S[i].level).toFixed(1)}`; on = true; } else on = false;
    }
    return d;
  };
  let line = '';
  for (let i = 0; i < S.length; i += step) line += `${i ? ' L' : 'M'} ${X(S[i].s).toFixed(1)} ${Y(S[i].level).toFixed(1)}`;
  svg.append(el('path', { d: line, class: 'p-line' }));
  const rapids = run('rapids');
  if (rapids) svg.append(el('path', { d: rapids, class: 'p-rapids' }));
  const fall = run('fall');
  if (fall) svg.append(el('path', { d: fall, class: 'p-fall' }));
  const e = S[S.length - 1];
  svg.append(el('circle', { cx: X(e.s).toFixed(1), cy: Y(e.level).toFixed(1), r: 2.6, class: 'p-end' }));
  svg.append(el('text', { x: L - 5, y: Y(hi) + 3, class: 'p-txt', 'text-anchor': 'end' }, `${hi.toFixed(0)} m`));
  svg.append(el('text', { x: L - 5, y: Y(lo) + 3, class: 'p-txt', 'text-anchor': 'end' }, `${lo.toFixed(0)} m`));
  svg.append(el('text', { x: L, y: H - 5, class: 'p-txt' }, '0'));
  svg.append(el('text', { x: W - R, y: H - 5, class: 'p-txt', 'text-anchor': 'end' }, len >= 1000 ? `${(len / 1000).toFixed(2)} km` : `${len.toFixed(0)} m`));
  const big = rt.hydro.falls.slice().sort((a, b) => b.height - a.height)[0];
  if (big && big.height >= 5) {
    const fs = S.find((p) => p.kind === 'fall');
    if (fs) svg.append(el('text', { x: Math.min(W - R - 2, X(fs.s) + 6), y: Y(fs.level) + 14, class: 'p-lbl' }, `Wasserfall ${big.height.toFixed(0)} m`));
  }
  profileEl.replaceChildren(svg);
  profileTitle.textContent = `Längsprofil · ${rt.def.name}`;
}
setInterval(renderProfile, 400);

// ---- loop ---------------------------------------------------------------------------------------------------------------------
function resize(): void {
  const w = stage.clientWidth || innerWidth, h = stage.clientHeight || innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
addEventListener('resize', resize);
resize();

const hud = $('hud');
const boot = $('boot');
let frame = 0, last = performance.now(), fps = 0, booted = false;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fps = fps ? fps * 0.9 + (1 / Math.max(dt, 1e-3)) * 0.1 : 1 / Math.max(dt, 1e-3);
  if (tween) {
    tween.t += dt;
    const k = Math.min(1, tween.t / tween.dur), e = k * k * (3 - 2 * k);
    const c = tween.from.map((v, i) => v + (tween!.to[i] - v) * e) as Cam;
    camera.position.set(c[0], c[1], c[2]);
    controls.target.set(c[3], c[4], c[5]);
    if (k >= 1) tween = null;
  }
  controls.update();
  terrain.update(controls.target.x, -controls.target.z);
  editor.update();
  waterSystem.resync();
  waterLayer.update(dt, camera.position);
  propLayer.update(camera);
  islandLayer.update();
  bridgeLayer.update(camera);
  signalLayer.update(performance.now() / 1000, camera);
  renderer.render(scene, camera);
  if (++frame % 12 === 0) {
    const st = waterSystem.stats();
    hud.textContent = `${fps.toFixed(0)} fps · Wasser ${st.ready}/${st.chunks} Abschnitte · ${st.lakesReady}/${st.lakes} Seen`;
    if (!booted && waterSystem.settled && st.chunks > 0) { booted = true; boot.hidden = true; }
  }
});

(window as unknown as Record<string, unknown>).__water = { editor, waterSystem, waterLayer, terrain, roads, flyTo, setSun, dock, controls, camera };
