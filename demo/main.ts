import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  MockStreamTerrain, RoadSystem, RoadDebugLayer, RoadMeshLayer, PropLayer, SignalLayer, BridgeLayer, BridgeLibrary, IslandLayer, TunnelLayer, TunnelSystem, GeometryBatch, placementMatrix, SIGN_CATALOG, ProfileLibrary, MaterialRegistry, MaterialLibrary,
  StorageStore, MemoryStore, type RoadDef, type RoadStore,
  WaterLibrary, WaterSystem, WaterLayer, bridgePierObstacles, waterDemoHeight, waterDemoWaters, waterDemoNetwork, WATER_DEMO_VIEWS,
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
// ?flat=1 → flat ground (clean look at profiles / markings)
// ?cliff=1 → flat ground with ravines beside rows of roads at sim z = 3000, 2800, 2600, 2400 (guardrail test scene)
const RAVINE_START: Record<number, number> = { 3000: 8, 2800: 6, 2600: 14, 2400: 8 };
const ravine = (x: number, z: number): number => {
  if (x < 3100 || x > 3320 || z < 2300 || z > 3300) return 800;
  const zc = 3000 - 200 * Math.round((3000 - z) / 200);
  const m = z - zc; // distance past the row's road line
  const a = RAVINE_START[zc] ?? 8;
  const edge = (e0: number, e1: number, v: number): number => Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return 800 - 28 * edge(a, a + 3, m) * (1 - edge(110, 114, m));
};
// ?bridges=1 → six gorges, one per bridge type (rows at sim z = 2400, 2500, …); the bridges cross at x = 3300
const BRIDGE_ROWS: Array<{ profile: string; bridge: string; depth: number; sigma: number }> = [
  { profile: 'wanderweg', bridge: 'holzsteg', depth: 5, sigma: 10 },
  { profile: 'gemeindestrasse', bridge: 'plattenbruecke', depth: 9, sigma: 14 },
  { profile: 'kantonsstrasse', bridge: 'balkenbruecke', depth: 22, sigma: 30 },
  { profile: 'autobahn', bridge: 'viadukt', depth: 38, sigma: 60 },
  { profile: 'hauptstrasse', bridge: 'bogenbruecke', depth: 26, sigma: 34 },
  { profile: 'hauptstrasse', bridge: 'fachwerkbruecke', depth: 16, sigma: 28 },
];
const gorge = (x: number, z: number): number => {
  let h = 800;
  BRIDGE_ROWS.forEach((r, i) => { h -= r.depth * Math.exp(-(((x - 3300) / r.sigma) ** 2)) * Math.exp(-(((z - (2400 + 100 * i)) / 38) ** 2)); });
  return h;
};
// ?rivers=1 → a winding river with a shallow valley; roads that cross it can get a bridge proposed (Brücke tab)
const RIVER_X = (z: number): number => 3300 + 45 * Math.sin(z / 140);
const demoRivers = qp.get('rivers') ? [{ id: 'aare', name: 'Aare', width: 14, points: Array.from({ length: 41 }, (_, i) => { const z = 2700 + i * 15; return { x: RIVER_X(z), z }; }) }] : [];
const riverbed = (x: number, z: number): number => 800 - 7 * Math.exp(-(((x - RIVER_X(z)) / 28) ** 2));
const terrain = new MockStreamTerrain({
  buildMeshes: true, loadLatencyFrames: Number(qp.get('lat') ?? 25),
  ...(qp.get('water') ? { heightFn: waterDemoHeight } : qp.get('rivers') ? { heightFn: riverbed } : qp.get('bridges') ? { heightFn: gorge } : qp.get('cliff') ? { heightFn: ravine } : qp.get('flat') ? { heightFn: () => 800 } : {}),
});
scene.add(terrain.group);

// ?water=1 → hand-drawn waters: lakes, a stream with rapids and a 400 m waterfall, a river, a side stream (see water/demoScene.ts)
const waterLibrary = new WaterLibrary();
const waterSystem = new WaterSystem(terrain, waterLibrary);
const library = new ProfileLibrary();
const materials = new MaterialRegistry();
const materialLibrary = new MaterialLibrary(); // materials as editable code; the editor binds the registry to it
materials.setWeather({ wet: Number(qp.get('wet') ?? 0), snow: Number(qp.get('snow') ?? 0), age: Number(qp.get('age') ?? 0.3) });
const bridgeLibrary = new BridgeLibrary();
const system = new RoadSystem(terrain, (d) => library.resolve(d.profile, d.params), undefined, (d, p) => bridgeLibrary.forRoad(d, p));
const meshLayer = new RoadMeshLayer(system, materials);
scene.add(meshLayer.group);
// ?props=0 → no props (lamps, signs, guardrails …)
const propLayer = new PropLayer(system, { drawDistance: Number(qp.get('propDist') ?? 900) });
propLayer.group.visible = qp.get('props') !== '0';
scene.add(propLayer.group);
const islandLayer = new IslandLayer(system, terrain, propLayer.assets, propLayer.materials);
scene.add(islandLayer.group);
const tunnelLayer = new TunnelLayer(system, propLayer.materials);
scene.add(tunnelLayer.group);
const tunnelSystem = new TunnelSystem(system, terrain);
const bridgeLayer = new BridgeLayer(system, materials, { drawDistance: Number(qp.get('propDist') ?? 1500) });
scene.add(bridgeLayer.group);
// traffic lights follow wall-clock time (?t=12 freezes them at 12 s, ?sigspeed=5 runs them faster)
const signalLayer = new SignalLayer(system, { drawDistance: Number(qp.get('propDist') ?? 900) });
signalLayer.group.visible = qp.get('props') !== '0';
scene.add(signalLayer.group);
const frozenT = qp.get('t') !== null ? Number(qp.get('t')) : null;
const sigSpeed = Number(qp.get('sigspeed') ?? 1);
const waterLayer = new WaterLayer(waterSystem, terrain, materials, { externalObstacles: bridgePierObstacles(system, waterSystem), particles: qp.get('particles') !== '0', drawDistance: Number(qp.get('waterDist') ?? 2600) });
waterLayer.setLight(sun.position);
scene.add(waterLayer.group);
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
  mk('a', 'Landstrasse', 'hauptstrasse', [[2700, 0, 3100], [2900, 0, 3150], [3100, 0, 3050], [3300, 0, 3000]]),
  mk('a2', 'Landstrasse (2)', 'hauptstrasse', [[3300, 0, 3000], [3500, 0, 3100]]),
  mk('a3', 'Landstrasse (3)', 'hauptstrasse', [[3500, 0, 3100], [3700, 0, 3250], [3900, 0, 3200]]),
  mk('b', 'Feldweg', 'flurstrasse', [[3300, 0, 3000], [3330, 0, 2900], [3250, 0, 2820], [3340, 0, 2740], [3260, 0, 2660], [3350, 0, 2580], [3300, 0, 2450]]),
  mk('c', 'Wanderweg', 'wanderweg', [[3500, 0, 3100], [3560, 0, 3010], [3640, 0, 2990], [3700, 0, 2900], [3790, 0, 2880]]),
].map((r): RoadDef => {
  const link: Record<string, Partial<RoadDef>> = {
    a: { endNode: 'N1' }, a2: { startNode: 'N1', endNode: 'N2' }, a3: { startNode: 'N2' }, b: { startNode: 'N1' }, c: { startNode: 'N2' },
  };
  return { ...r, ...link[r.id] };
});
const sampleNodes = [
  { id: 'N1', x: 3300, y: terrain.heightFn(3300, 3000), z: 3000 },
  { id: 'N2', x: 3500, y: terrain.heightFn(3500, 3100), z: 3100 },
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
  system, library, materials, materialLibrary, bridgeLibrary, terrain, rivers: demoRivers, water: { system: waterSystem, library: waterLibrary, terrain }, store, location: LOCATION, roadGroup: meshLayer.group,
});
mountEditorPanels(editor, document.body, { library, materials });
void (async () => {
  await editor.load();
  if (qp.get('water') && !editor.model.riverList.length && !editor.model.lakeList.length) {
    const w = waterDemoWaters();
  const net = waterDemoNetwork();
    editor.model.load({ version: 1, roads: net.roads, nodes: net.nodes, rivers: w.rivers, lakes: w.lakes });
    editor.setStatus('Beispiel-Gewässer geladen – noch nicht gespeichert', 'info');
  } else if (!qp.get('water') && !editor.model.list.length && !(await store.loadRoads(LOCATION))) {
    editor.model.load({ version: 1, roads: sampleRoads, nodes: sampleNodes });
    editor.setStatus('Beispielstraßen geladen – noch nicht gespeichert', 'info');
  }
})();

// ?net=1 → a hand-made test network (T, X, bend, width change) to look at junction geometry
if (qp.get('net')) {
  const y = (x: number, z: number): number => terrain.heightFn(x, z);
  const P = (id: string, profile: string, pts: Array<[number, number]>, extra: object = {}): RoadDef =>
    ({ id, name: id, profile, points: pts.map(([x, z]) => ({ x, y: y(x, z), z })), ...extra });
  const nodes = [
    { id: 'T', x: 3300, y: y(3300, 3000), z: 3000 },
    { id: 'X', x: 3000, y: y(3000, 3300), z: 3300, radius: 8 },
    { id: 'B', x: 3600, y: y(3600, 3300), z: 3300 },
    { id: 'W', x: 3300, y: y(3300, 3500), z: 3500 },
  ];
  const roads: RoadDef[] = [
    P('t-w', 'hauptstrasse', [[3000, 3000], [3150, 3020], [3300, 3000]], { endNode: 'T' }),
    P('t-e', 'hauptstrasse', [[3300, 3000], [3450, 2980], [3600, 3000]], { startNode: 'T' }),
    P('t-s', 'flurstrasse', [[3300, 2750], [3290, 2880], [3300, 3000]], { endNode: 'T' }),
    P('x-w', 'hauptstrasse', [[2800, 3300], [2900, 3290], [3000, 3300]], { endNode: 'X' }),
    P('x-e', 'hauptstrasse', [[3000, 3300], [3100, 3310], [3200, 3300]], { startNode: 'X' }),
    P('x-n', 'hauptstrasse', [[3000, 3300], [3010, 3400], [3000, 3500]], { startNode: 'X' }),
    P('x-s', 'flurstrasse', [[3000, 3100], [3010, 3200], [3000, 3300]], { endNode: 'X' }),
    P('b-a', 'hauptstrasse', [[3400, 3300], [3500, 3310], [3600, 3300]], { endNode: 'B' }),
    P('b-b', 'hauptstrasse', [[3600, 3300], [3610, 3400], [3600, 3500]], { startNode: 'B' }),
    P('w-a', 'flurstrasse', [[3250, 3500], [3280, 3500], [3300, 3500]], { endNode: 'W' }),
    P('w-b', 'hauptstrasse', [[3300, 3500], [3400, 3495], [3500, 3500]], { startNode: 'W' }),
  ];
  setTimeout(() => editor.model.load({ version: 1, roads, nodes }), 800);
}

// ?rivers=1 → two roads across the river, no bridges yet
if (qp.get('rivers')) {
  const mkRoad = (id: string, profile: string, z: number): RoadDef => ({ id, name: id, profile, points: [3050, 3180, 3420, 3560].map((x) => ({ x, y: 800, z: z + (x - 3300) * 0.04 })) });
  const roads = [mkRoad('Landstrasse', 'hauptstrasse', 3000), mkRoad('Dorfstrasse', 'gemeindestrasse', 3180), mkRoad('Wanderweg', 'wanderweg', 2860)];
  setTimeout(() => editor.model.load({ version: 1, roads }), 800);
}

// ?bridges=1 → one road per bridge type, each crossing its own gorge
if (qp.get('bridges')) {
  const roads: RoadDef[] = BRIDGE_ROWS.map((r, i) => {
    const z = 2400 + 100 * i;
    const x0 = 3300 - r.sigma * 2.3, x1 = 3300 + r.sigma * 2.3;
    const xs = [3000, 3150, x0, (x0 + x1) / 2, x1, 3450, 3600].filter((x, k, a) => k === 0 || x > a[k - 1]);
    return {
      id: `b-${r.bridge}`, name: r.bridge, profile: r.profile, bridge: r.bridge,
      points: xs.map((x) => ({ x, y: 800, z, ...(x >= x0 && x <= x1 ? { mode: 'bridge' as const } : {}) })),
    };
  });
  setTimeout(() => editor.model.load({ version: 1, roads }), 800);
}

// ?signals=1 → crossing with traffic lights: Kantonsstrasse × Dorfstrasse, pavements, zebra crossings, pedestrian lights
if (qp.get('signals')) {
  const pts = (l: Array<[number, number]>) => l.map(([x, z]) => ({ x, y: 800, z }));
  const roads: RoadDef[] = [
    { id: 'k1', name: 'Kantonsstrasse', profile: 'kantonsstrasse', points: pts([[2950, 3000], [3130, 3000], [3300, 3000]]), endNode: 'S' },
    { id: 'k2', name: 'Kantonsstrasse (2)', profile: 'kantonsstrasse', points: pts([[3300, 3000], [3470, 3000], [3650, 3000]]), startNode: 'S' },
    { id: 'd1', name: 'Dorfstrasse', profile: 'dorfstrasse', points: pts([[3300, 2750], [3300, 2880], [3300, 3000]]), endNode: 'S' },
    { id: 'd2', name: 'Dorfstrasse (2)', profile: 'dorfstrasse', points: pts([[3300, 3000], [3300, 3120], [3300, 3250]]), startNode: 'S' },
  ];
  setTimeout(() => editor.model.load({ version: 1, roads, nodes: [{ id: 'S', x: 3300, y: 800, z: 3000, control: 'signals', crosswalks: 'all' }] }), 800);
}

// ?village=1 → crossing: Kantonsstrasse with avenue (priority), Dorfstrasse + Quartierstrasse (give way), lamps and signs
if (qp.get('village')) {
  const pts = (l: Array<[number, number]>) => l.map(([x, z]) => ({ x, y: 800, z }));
  const roads: RoadDef[] = [
    { id: 'k1', name: 'Kantonsstrasse', profile: 'kantonsstrasse', params: { avenue: true }, points: pts([[2900, 3000], [3100, 3000], [3300, 3000]]), endNode: 'X' },
    { id: 'k2', name: 'Kantonsstrasse (2)', profile: 'kantonsstrasse', params: { avenue: true }, points: pts([[3300, 3000], [3500, 3000], [3700, 3000]]), startNode: 'X' },
    { id: 'd', name: 'Dorfstrasse', profile: 'dorfstrasse', points: pts([[3300, 2750], [3300, 2880], [3300, 3000]]), endNode: 'X' },
    { id: 'q', name: 'Quartierstrasse', profile: 'quartierstrasse', points: pts([[3300, 3000], [3300, 3120], [3300, 3250]]), startNode: 'X' },
  ];
  setTimeout(() => editor.model.load({ version: 1, roads, nodes: [{ id: 'X', x: 3300, y: 800, z: 3000 }] }), 800);
}

// ?assets=1 → every prop asset and sign design in a row (use with ?flat=1; look at sim (3000, 3000))
if (qp.get('assets')) {
  const batch = new GeometryBatch();
  const names = [...propLayer.assets.names().filter((n) => !n.startsWith('post_')), ...Object.keys(SIGN_CATALOG).map((id) => `sign:${id}${SIGN_CATALOG[id].labelled ? ':Thun|14 km' : ''}`)];
  names.forEach((name, i) => {
    const p = { asset: name, pos: new THREE.Vector3(3000 + (i % 12) * 3.2, 800, -(3000 + Math.floor(i / 12) * 6)), yaw: Math.PI, scale: 1, rule: -1, s: 0, side: 'right' as const };
    for (const part of propLayer.assets.parts(name)) batch.addGeometry(part.material, part.geometry, placementMatrix(p));
  });
  const built = batch.build();
  if (built) {
    const m = new THREE.Mesh(built.geometry, built.materials.map((n) => propLayer.materials.get(n)));
    scene.add(m);
  }
}

// ?cliff=1 → four roads, each with a ravine on one side
if (qp.get('cliff')) {
  const rows: Array<[string, number]> = [['hauptstrasse', 3000], ['alpstrasse', 2800], ['autobahn', 2600], ['nebenstrasse', 2400]];
  const roads: RoadDef[] = rows.map(([profile, z]) => ({
    id: `c-${profile}`, name: profile, profile,
    points: [3000, 3150, 3300, 3450, 3600].map((x) => ({ x, y: 800, z })),
  }));
  setTimeout(() => editor.model.load({ version: 1, roads }), 800);
}

// ?gallery=1 → one straight piece of road per profile, side by side (use with ?flat=1)
if (qp.get('gallery')) {
  const names = library.names();
  const roads: RoadDef[] = names.map((n, i) => ({
    id: `g-${n}`, name: n, profile: n,
    points: [0, 1, 2, 3].map((k) => ({ x: 3000 + k * 40, y: 800, z: 3000 + i * 26 })),
  }));
  setTimeout(() => editor.model.load({ version: 1, roads }), 800);
}

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
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  controls.update();
  propLayer.update(camera);
  islandLayer.update();
  tunnelSystem.update();
  tunnelLayer.update(camera);
  bridgeLayer.update(camera);
  signalLayer.update(frozenT ?? (performance.now() / 1000) * sigSpeed, camera);
  // the "player" is the orbit target; the terrain streams around it (sim z = -three z)
  terrain.update(controls.target.x, -controls.target.z);
  waterSystem.resync();
  waterLayer.update(Math.min(0.1, clock.getDelta()), camera.position);
  editor.update(); // resyncs the road system with an editing-sized budget
  if (debug.group.visible) debug.update();
  renderer.render(scene, camera);
  if (++frame % 10 === 0) {
    const st = system.stats();
    const ts = terrain.loadStats();
    hud.textContent =
      `RoadSystem – Phase 8 (Brücken)\n` +
      `Straßen: ${editor.model.list.length}   Kreuzungen: ${system.junctionStats().ready}/${system.junctionStats().total}   Chunks: ${st.ready}/${st.chunks}\n` +
      `Terrain-Kacheln: ${ts.ready} geladen / ${ts.known} bekannt` +
      (waterSystem.rivers.length || waterSystem.lakes.length ? `\nWasser: ${waterSystem.stats().ready}/${waterSystem.stats().chunks} Abschnitte, ${waterSystem.stats().lakesReady}/${waterSystem.stats().lakes} Seen` : '');
  }
});

(window as unknown as Record<string, unknown>).__demo = {
  renderer, scene, camera, waterSystem, waterLayer, waterLibrary, WATER_DEMO_VIEWS, editor, library, materials, materialLibrary, propLayer, signalLayer, bridgeLayer, bridgeLibrary,
  stats: () => ({ roads: system.stats(), tiles: terrain.loadStats(), meshes: meshLayer.meshCount, propMeshes: propLayer.meshCount, props: propLayer.allPlacements().length, count: editor.model.list.length, nodes: editor.model.nodeList.length, junctions: system.junctionStats(), dirty: editor.isDirty }),
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
  /** place the camera (THREE space) — for screenshots */
  setCam(px: number, py: number, pz: number, tx: number, ty: number, tz: number): void {
    camera.position.set(px, py, pz);
    controls.target.set(tx, ty, tz);
    controls.update();
  },
  roads: () => editor.model.list,
};
