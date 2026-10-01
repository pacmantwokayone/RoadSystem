import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  MockStreamTerrain, RoadSystem, RoadDebugLayer, RoadMeshLayer, ProfileLibrary, MaterialRegistry,
  type RoadDef,
} from 'roadsystem';

// Renderer set up like the game: logarithmic depth buffer, exponential fog.
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9db8d0);
scene.fog = new THREE.FogExp2(0x9db8d0, 0.00016);
scene.add(new THREE.HemisphereLight(0xdfeaff, 0x4a4a3a, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.7);
sun.position.set(-1500, 2500, 800);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.3, 40000);
const controls = new OrbitControls(camera, renderer.domElement);

// Sim-space world, three-space meshes (z mirrored) — same as the game.
const qp = new URLSearchParams(location.search);
const terrain = new MockStreamTerrain({ buildMeshes: true, loadLatencyFrames: Number(qp.get('lat') ?? 25) });
scene.add(terrain.group);

const library = new ProfileLibrary();
const materials = new MaterialRegistry();
const system = new RoadSystem(terrain, (d) => library.resolve(d.profile, d.params));
const meshLayer = new RoadMeshLayer(system, materials);
scene.add(meshLayer.group);
const debug = new RoadDebugLayer(system, terrain);
debug.group.visible = false;
scene.add(debug.group);

// ---- data (demo persistence: localStorage; the game will use a RoadStore) ----
const STORE_KEY = 'roadsystem-demo/v2';
const mk = (id: string, name: string, profile: string, pts: Array<[number, number, number]>): RoadDef => ({
  id, name, profile, points: pts.map(([x, y, z]) => ({ x, y, z })),
});
const sampleRoads: RoadDef[] = [
  mk('a', 'Landstrasse', 'hauptstrasse', [[2700, 0, 3100], [2900, 0, 3150], [3100, 0, 3050], [3300, 0, 3000], [3500, 0, 3100], [3700, 0, 3250], [3900, 0, 3200]]),
  mk('b', 'Feldweg', 'flurstrasse', [[3300, 0, 3000], [3330, 0, 2900], [3250, 0, 2820], [3340, 0, 2740], [3260, 0, 2660], [3350, 0, 2580], [3300, 0, 2450]]),
  mk('c', 'Wanderweg', 'wanderweg', [[3500, 0, 3100], [3560, 0, 3010], [3640, 0, 2990], [3700, 0, 2900], [3790, 0, 2880]]),
];
function loadRoads(): RoadDef[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return (JSON.parse(raw) as { roads: RoadDef[] }).roads;
  } catch { /* no storage / corrupt: fall through */ }
  return sampleRoads;
}
function saveRoads(): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ roads })); } catch { /* ignore */ }
}
const roads: RoadDef[] = loadRoads();
system.setRoads(roads);

// ---- camera ----
const params = new URLSearchParams(location.search);
const cam = params.get('cam')?.split(',').map(Number);
const start = new THREE.Vector3(3200, 700, -3000);
if (cam && cam.length === 6) {
  camera.position.set(cam[0], cam[1], cam[2]);
  controls.target.set(cam[3], cam[4], cam[5]);
} else {
  camera.position.set(start.x - 380, start.y + 260, start.z + 560);
  controls.target.copy(start);
}
controls.update();

// ---- drawing tool ----
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const profileSel = $<HTMLSelectElement>('profile');
for (const n of library.names()) profileSel.add(new Option(n, n));
profileSel.value = 'hauptstrasse';
const msg = $('msg');
const drawBtn = $('draw');

let drawing: RoadDef | null = null;
const markers = new THREE.Group();
scene.add(markers);
const markerGeo = new THREE.SphereGeometry(1.4, 12, 8);
const markerMat = new THREE.MeshBasicMaterial({ color: 0xffd34d, depthTest: false });

function refreshMarkers(): void {
  markers.clear();
  if (!drawing) return;
  for (const p of drawing.points) {
    const m = new THREE.Mesh(markerGeo, markerMat);
    m.position.set(p.x, p.y + 2, -p.z);
    m.renderOrder = 10;
    markers.add(m);
  }
}

function setDrawing(on: boolean): void {
  drawBtn.classList.toggle('on', on);
  renderer.domElement.style.cursor = on ? 'crosshair' : '';
  if (on) {
    const id = `road-${Date.now().toString(36)}`;
    drawing = { id, name: `Strasse ${roads.length + 1}`, profile: profileSel.value, points: [] };
    msg.textContent = 'Klick setzt Punkte · Enter = fertig · ⌫ = letzter Punkt zurück · Esc = abbrechen';
  } else {
    drawing = null;
    msg.textContent = 'Zeichnen: Klick aufs Gelände setzt Punkte. Ziehen = Kamera drehen.';
  }
  refreshMarkers();
}

function finishDrawing(): void {
  if (!drawing) return;
  if (drawing.points.length >= 2) { roads.push(drawing); saveRoads(); setDrawing(false); }
  else cancelDrawing();
}
function cancelDrawing(): void {
  if (drawing) system.removeRoad(drawing.id);
  setDrawing(false);
}
function updateDraft(): void {
  if (!drawing) return;
  if (drawing.points.length >= 2) system.upsertRoad(drawing);
  else system.removeRoad(drawing.id);
  refreshMarkers();
}

const ray = new THREE.Raycaster();
function pick(ev: PointerEvent): THREE.Vector3 | null {
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
  const visible = terrain.group.children.filter((c) => c.visible);
  return ray.intersectObjects(visible, false)[0]?.point ?? null;
}

let down: { x: number; y: number; t: number } | null = null;
renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
renderer.domElement.addEventListener('pointerup', (e) => {
  const d = down; down = null;
  if (!d || !drawing || e.button !== 0) return;
  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || performance.now() - d.t > 500) return; // a drag, not a click
  const hit = pick(e);
  if (!hit) return;
  drawing.points.push({ x: hit.x, y: hit.y, z: -hit.z }); // three → sim space
  updateDraft();
});

drawBtn.onclick = () => (drawing ? cancelDrawing() : setDrawing(true));
$('finish').onclick = finishDrawing;
$('cancel').onclick = cancelDrawing;
$('undo').onclick = () => { drawing?.points.pop(); updateDraft(); };
$('clear').onclick = () => { roads.length = 0; saveRoads(); setDrawing(false); system.setRoads([]); };
$<HTMLInputElement>('debug').onchange = (e) => { debug.group.visible = (e.target as HTMLInputElement).checked; };
profileSel.onchange = () => { if (drawing) { drawing.profile = profileSel.value; updateDraft(); } };
addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'SELECT') return;
  if (e.key === 'd' || e.key === 'D') drawing ? cancelDrawing() : setDrawing(true);
  else if (e.key === 'Enter') finishDrawing();
  else if (e.key === 'Escape') cancelDrawing();
  else if (e.key === 'Backspace') { drawing?.points.pop(); updateDraft(); }
});

// ---- loop ----
const hud = $('hud');
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

let frame = 0;
renderer.setAnimationLoop(() => {
  controls.update();
  // the "player" is the orbit target; the terrain streams around it (sim z = -three z)
  terrain.update(controls.target.x, -controls.target.z);
  system.resync();
  if (debug.group.visible) debug.update();
  renderer.render(scene, camera);
  if (++frame % 10 === 0) {
    const st = system.stats();
    const ts = terrain.loadStats();
    hud.textContent =
      `RoadSystem – Phase 2 (Profile + Extrusion)\n` +
      `Straßen: ${roads.length}   Chunks: ${st.ready}/${st.chunks} gebaut   Meshes: ${meshLayer.meshCount}\n` +
      `Terrain-Kacheln: ${ts.ready} geladen / ${ts.known} bekannt`;
  }
});

(window as unknown as Record<string, unknown>).__demo = {
  stats: () => ({ roads: system.stats(), tiles: terrain.loadStats(), meshes: meshLayer.meshCount, drawing: drawing?.points.length ?? 0 }),
  /** screen position (px) of a sim-space ground point, for scripted clicks */
  project(x: number, z: number): { x: number; y: number } {
    const h = terrain.heightAt(x, z) ?? 0;
    const v = new THREE.Vector3(x, h, -z).project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  },
  roads: () => roads,
  height: (x: number, z: number) => terrain.heightFn(x, z),
  /** how far the VISIBLE terrain mesh rises above the road surface (centre + carriageway edges) */
  burial(): { samples: number; buried: number; worst: number; worstAt: number[]; byVisibleLevel: Record<string, number>; worstL0: number; worstL0At: number[] } {
    const rc = new THREE.Raycaster();
    const meshes = terrain.group.children.filter((c) => c.visible);
    let samples = 0, buried = 0, worst = -Infinity, worstAt: number[] = [];
    const byVisibleLevel: Record<string, number> = {};
    let worstL0 = -Infinity, worstL0At: number[] = [];
    for (const rt of system.runtimes) {
      for (let i = 0; i < rt.samples.length; i += 2) {
        const y = rt.designY[i];
        if (Number.isNaN(y)) continue;
        const s = rt.samples[i];
        const f = rt.designFrame(i);
        const c = rt.profile.coreHalfWidth * s.widthScale;
        for (const off of [-c, 0, c]) {
          const px = s.pos.x + f.right.x * off, pz = s.pos.z + f.right.z * off;
          rc.set(new THREE.Vector3(px, y + 400, pz), new THREE.Vector3(0, -1, 0));
          const hit = rc.intersectObjects(meshes, false)[0];
          if (!hit) continue;
          const d = hit.point.y - (y + f.right.y * off - 0.05 * Math.abs(off) / Math.max(c, 1e-6));
          samples++;
          if (d > 0.1) {
            buried++;
            const vis = terrain.tilesAt(px, -pz).filter((t) => t.visible).map((t) => `L${t.level}`).join('+') || 'none';
            byVisibleLevel[vis] = (byVisibleLevel[vis] ?? 0) + 1;
          }
          if (d > worst) { worst = d; worstAt = [Math.round(px), Math.round(-pz)]; }
          const only0 = terrain.tilesAt(px, -pz).filter((t) => t.visible).map((t) => t.level).join() === '0';
          if (only0 && d > worstL0) { worstL0 = d; worstL0At = [Math.round(px), Math.round(-pz), Math.round(off * 10) / 10]; }
        }
      }
    }
    return { samples, buried, worst: +worst.toFixed(2), worstAt, byVisibleLevel, worstL0: +worstL0.toFixed(2), worstL0At };
  },
};
