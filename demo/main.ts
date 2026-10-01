import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  MockStreamTerrain, RoadSystem, RoadDebugLayer, RoadMeshLayer, ProfileLibrary, MaterialRegistry,
  StorageStore, MemoryStore, type RoadDef, type RoadStore,
} from 'roadsystem';
import { RoadEditor, mountEditorPanels } from 'roadsystem/editor';

const qp = new URLSearchParams(location.search);

// Renderer set up like the game: logarithmic depth buffer, exponential fog.
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.domElement.classList.add('scene');
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

// ---- persistence: localStorage here, the game's PHP backend later (HttpRoadStore) ----
let store: RoadStore;
try {
  localStorage.setItem('roadsystem-probe', '1');
  store = new StorageStore(localStorage, qp.get('store') ?? 'roadsystem-demo');
} catch {
  store = new MemoryStore();
}
const LOCATION = 'demo';
// authored y = ground height, like the editor writes it (y is only a fallback for drape points)
const mk = (id: string, name: string, profile: string, pts: Array<[number, number, number]>): RoadDef => ({
  id, name, profile, points: pts.map(([x, , z]) => ({ x, y: terrain.heightFn(x, z), z })),
});
const sampleRoads: RoadDef[] = [
  mk('a', 'Landstrasse', 'hauptstrasse', [[2700, 0, 3100], [2900, 0, 3150], [3100, 0, 3050], [3300, 0, 3000], [3500, 0, 3100], [3700, 0, 3250], [3900, 0, 3200]]),
  mk('b', 'Feldweg', 'flurstrasse', [[3300, 0, 3000], [3330, 0, 2900], [3250, 0, 2820], [3340, 0, 2740], [3260, 0, 2660], [3350, 0, 2580], [3300, 0, 2450]]),
  mk('c', 'Wanderweg', 'wanderweg', [[3500, 0, 3100], [3560, 0, 3010], [3640, 0, 2990], [3700, 0, 2900], [3790, 0, 2880]]),
];

// ---- editor host ----
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
  system, library, materials, store, location: LOCATION, roadGroup: meshLayer.group,
});
mountEditorPanels(editor, document.body, { library, materials });
void (async () => {
  await editor.load();
  if (!editor.model.list.length && !(await store.loadRoads(LOCATION))) {
    editor.model.load({ version: 1, roads: sampleRoads });
    editor.setStatus('Beispielstraßen geladen – noch nicht gespeichert', 'info');
  }
})();

// ---- camera ----
const cam = qp.get('cam')?.split(',').map(Number);
const start = new THREE.Vector3(3200, 700, -3000);
if (cam && cam.length === 6) {
  camera.position.set(cam[0], cam[1], cam[2]);
  controls.target.set(cam[3], cam[4], cam[5]);
} else {
  camera.position.set(start.x - 380, start.y + 260, start.z + 560);
  controls.target.copy(start);
}
controls.update();

(document.getElementById('debug') as HTMLInputElement).onchange = (e) => { debug.group.visible = (e.target as HTMLInputElement).checked; };

// ---- loop ----
const hud = document.getElementById('hud')!;
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
  editor.update(); // resyncs the road system with an editing-sized budget
  if (debug.group.visible) debug.update();
  renderer.render(scene, camera);
  if (++frame % 10 === 0) {
    const st = system.stats();
    const ts = terrain.loadStats();
    hud.textContent =
      `RoadSystem – Phase 3 (Editor)\n` +
      `Straßen: ${editor.model.list.length}   Chunks: ${st.ready}/${st.chunks}   Meshes: ${meshLayer.meshCount}\n` +
      `Terrain-Kacheln: ${ts.ready} geladen / ${ts.known} bekannt`;
  }
});

(window as unknown as Record<string, unknown>).__demo = {
  editor, library,
  stats: () => ({ roads: system.stats(), tiles: terrain.loadStats(), meshes: meshLayer.meshCount, count: editor.model.list.length, dirty: editor.isDirty }),
  /** screen position (px) of a sim-space ground point, for scripted clicks */
  project(x: number, z: number): { x: number; y: number } {
    const h = terrain.heightAt(x, z) ?? 0;
    const v = new THREE.Vector3(x, h, -z).project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  },
  /** screen position of a THREE-space world point */
  projectWorld(x: number, y: number, z: number): { x: number; y: number } {
    const v = new THREE.Vector3(x, y, z).project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  },
  height: (x: number, z: number) => terrain.heightFn(x, z),
  roads: () => editor.model.list,
};
