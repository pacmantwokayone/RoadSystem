import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MockStreamTerrain, RoadSystem, RoadDebugLayer, type RoadDef } from 'roadsystem';

// Renderer set up like the game: logarithmic depth buffer, exponential fog.
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9db8d0);
scene.fog = new THREE.FogExp2(0x9db8d0, 0.00018);
scene.add(new THREE.HemisphereLight(0xdfeaff, 0x4a4a3a, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-1500, 2500, 800);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 40000);
const controls = new OrbitControls(camera, renderer.domElement);

// Sim-space world, three-space meshes (z mirrored) — same as the game.
const terrain = new MockStreamTerrain({ buildMeshes: true, loadLatencyFrames: 25 });
scene.add(terrain.group);

const mk = (id: string, name: string, pts: Array<[number, number, number, object?]>): RoadDef => ({
  id, name, profile: 'demo',
  points: pts.map(([x, y, z, extra]) => ({ x, y, z, ...(extra ?? {}) })),
});
const roads: RoadDef[] = [
  mk('a', 'Landstrasse', [[2700, 0, 3100], [2900, 0, 3150], [3100, 0, 3050], [3300, 0, 3000], [3500, 0, 3100], [3700, 0, 3250], [3900, 0, 3200]]),
  mk('b', 'Serpentine', [[3300, 0, 3000], [3330, 0, 2900], [3250, 0, 2820], [3340, 0, 2740], [3260, 0, 2660], [3350, 0, 2580], [3300, 0, 2450]]),
  // hand-fixed bridge section: height is authored, not draped (hover over the middle of the road)
  mk('c', 'Bruecke', [[3500, 1000, 3100], [3600, 1000, 3000, { mode: 'bridge' }], [3750, 1000, 3000, { mode: 'bridge' }], [3850, 1000, 2900]]),
];

const system = new RoadSystem(terrain);
system.setRoads(roads);
const debug = new RoadDebugLayer(system, terrain);
scene.add(debug.group);

const start = new THREE.Vector3(3200, 700, -3000);
camera.position.set(start.x - 380, start.y + 260, start.z + 560);
controls.target.copy(start);
controls.update();

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
  system.resync();
  debug.update();
  renderer.render(scene, camera);
  if (++frame % 10 === 0) {
    const st = system.stats();
    const ts = terrain.loadStats();
    hud.textContent =
      `RoadSystem – Phase 1 (Core)\n` +
      `Chunks: ${st.ready}/${st.chunks} gebaut  (rot = wartet auf Terrain, grün = settled, blau = Brücke)\n` +
      `Terrain-Kacheln: ${ts.ready} geladen / ${ts.known} bekannt`;
  }
});
(window as unknown as { __ready: () => string }).__ready = () => JSON.stringify({ roads: system.stats(), tiles: terrain.loadStats() });
