// Particles that make the water move: flecks of foam and bubbles that drift with the current (so you SEE which way a river flows),
// droplets that race down a waterfall, spray where water crashes, and mist that billows at the foot of a fall.
//
// Everything is CPU-driven from the river's own samples (position, flow speed, width) and drawn as two soft Points clouds.
// Particles only live near the camera; they are spawned everywhere in range and fade in and out, so the cost does not depend
// on how long the rivers are.

import * as THREE from 'three';
import { hash01 } from '../props/rules';
import type { RiverRuntime } from './system';
import type { RiverSample } from './hydro';

export interface ParticleOptions {
  maxFlecks: number;
  maxSpray: number;
  /** particles are only simulated this close to the camera, metres */
  range: number;
}

export const DEFAULT_PARTICLE_OPTIONS: ParticleOptions = { maxFlecks: 3500, maxSpray: 2600, range: 260 };

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
uniform float uScale;
varying float vAlpha;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vAlpha = aAlpha;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = max(aSize * uScale / max(-mvPosition.z, 0.1), 1.6);
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uSoft;
varying float vAlpha;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  float a = (1.0 - smoothstep(1.0 - uSoft, 1.0, d)) * vAlpha;
  gl_FragColor = vec4(uColor, a);
}
`;

class Cloud {
  readonly points: THREE.Points;
  readonly pos: Float32Array;
  readonly size: Float32Array;
  readonly alpha: Float32Array;
  readonly geometry = new THREE.BufferGeometry();
  readonly material: THREE.ShaderMaterial;

  constructor(readonly count: number, color: number, additive: boolean, soft: number) {
    this.pos = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7); // positions change every frame
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 800 }, uColor: { value: new THREE.Color(color) }, uSoft: { value: soft } },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.onBeforeRender = (renderer, _scene, camera): void => {
      const h = renderer.getDrawingBufferSize(new THREE.Vector2()).y;
      const fov = (camera as THREE.PerspectiveCamera).fov ?? 60;
      this.material.uniforms.uScale.value = (h * 0.5) / Math.tan((fov * Math.PI) / 360);
    };
  }

  flush(): void {
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('aSize').needsUpdate = true;
    this.geometry.getAttribute('aAlpha').needsUpdate = true;
  }
}

interface Fleck {
  river: number;
  s: number;
  u: number;
  speedMul: number;
  age: number;
  life: number;
  size: number;
  /** a droplet on a waterfall: larger and brighter */
  alive: boolean;
}

interface Spray {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number; life: number;
  size: number; grow: number;
  alpha: number;
  mist: boolean;
  alive: boolean;
}

export interface FallEmitter {
  river: number;
  x: number; y: number; z: number;
  /** horizontal flow direction at the foot */
  dx: number; dz: number;
  radius: number;
  strength: number;
  mist: number;
  spray: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (a: number, b: number, v: number): number => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

export class WaterParticles {
  readonly group = new THREE.Group();
  private readonly flecksCloud: Cloud;
  private readonly sprayCloud: Cloud;
  private readonly mistCloud: Cloud;
  private rivers: RiverRuntime[] = [];
  private emitters: FallEmitter[] = [];
  private readonly flecks: Fleck[];
  private readonly spray: Spray[];
  private readonly mist: Spray[];
  private t = 0;
  private seq = 1;

  constructor(private readonly opts: ParticleOptions = DEFAULT_PARTICLE_OPTIONS) {
    this.flecksCloud = new Cloud(opts.maxFlecks, 0xffffff, false, 0.5);
    this.sprayCloud = new Cloud(Math.floor(opts.maxSpray * 0.6), 0xf2f8ff, true, 0.7);
    this.mistCloud = new Cloud(Math.floor(opts.maxSpray * 0.4), 0xe6f0f8, false, 1.0);
    this.group.add(this.flecksCloud.points, this.sprayCloud.points, this.mistCloud.points);
    this.group.name = 'water-particles';
    this.flecks = Array.from({ length: opts.maxFlecks }, () => ({ river: -1, s: 0, u: 0, speedMul: 1, age: 0, life: 1, size: 0.1, alive: false }));
    const mk = (): Spray => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, size: 0.2, grow: 0, alpha: 0.5, mist: false, alive: false });
    this.spray = Array.from({ length: this.sprayCloud.count }, mk);
    this.mist = Array.from({ length: this.mistCloud.count }, mk);
  }

  /** the rivers whose water particles may move on; call when chunks become ready / are removed */
  setRivers(rivers: readonly RiverRuntime[], emitters: readonly FallEmitter[]): void {
    this.rivers = rivers.slice();
    this.emitters = emitters.slice();
  }

  private rnd(a = 0): number {
    return hash01(this.seq++, a, 7);
  }

  private sampleAt(rt: RiverRuntime, s: number): { a: RiverSample; b: RiverSample; f: number } {
    const S = rt.hydro.samples;
    let lo = 0, hi = S.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid].s <= s) lo = mid; else hi = mid; }
    const a = S[lo], b = S[hi];
    return { a, b, f: b.s > a.s ? Math.min(1, Math.max(0, (s - a.s) / (b.s - a.s))) : 0 };
  }

  private spawnFleck(f: Fleck, cam: THREE.Vector3): void {
    f.alive = false;
    if (!this.rivers.length) return;
    // pick a river that has water near the camera: try a few random places
    for (let tries = 0; tries < 6; tries++) {
      const ri = Math.floor(this.rnd(1) * this.rivers.length);
      const rt = this.rivers[ri];
      if (!rt.hydro.samples.length || rt.style.particles.flecks <= 0) continue;
      const s = this.rnd(2) * rt.hydro.length;
      const { a, b, f: t } = this.sampleAt(rt, s);
      const x = lerp(a.pos.x, b.pos.x, t), z = lerp(a.pos.z, b.pos.z, t);
      if (Math.hypot(x - cam.x, z - cam.z) > this.opts.range) continue;
      // thin out by the style's density (flecks per 100 m² of water)
      if (this.rnd(3) > Math.min(1, rt.style.particles.flecks / 3)) continue;
      f.river = ri; f.s = s; f.u = (this.rnd(4) * 2 - 1) * 0.92; f.speedMul = 0.75 + this.rnd(5) * 0.5;
      f.age = 0; f.life = 3 + this.rnd(6) * 7; f.size = rt.style.particles.size * (0.6 + this.rnd(7) * 1.1); f.alive = true;
      return;
    }
  }

  private spawnSpray(list: Spray[], i: number, mist: boolean): void {
    const p = list[i];
    p.alive = false;
    if (!this.emitters.length) return;
    const e = this.emitters[Math.floor(this.rnd(11) * this.emitters.length)];
    if (this.rnd(12) > Math.min(1, (mist ? e.mist : e.spray) * 1.2)) return;
    const a = this.rnd(13) * Math.PI * 2, r = Math.sqrt(this.rnd(14)) * e.radius * (mist ? 0.95 : 0.7);
    p.x = e.x + Math.cos(a) * r; p.z = e.z + Math.sin(a) * r; p.y = e.y + 0.2;
    const out = (mist ? 1 : 2.5) * (0.4 + this.rnd(15));
    const up = (mist ? 2.2 : 7 + e.strength * 10) * (0.4 + this.rnd(16));
    p.vx = e.dx * out + (this.rnd(17) - 0.5) * 2; p.vz = e.dz * out + (this.rnd(18) - 0.5) * 2; p.vy = up;
    p.age = 0; p.life = mist ? 3 + this.rnd(19) * 4 : 1 + this.rnd(19) * 1.6;
    p.size = mist ? 2 + this.rnd(20) * 5 : 0.1 + this.rnd(20) * 0.35;
    p.grow = mist ? 2.2 + this.rnd(21) * 2 : 0.05;
    p.alpha = mist ? 0.10 + this.rnd(22) * 0.12 : 0.5 + this.rnd(22) * 0.4;
    p.mist = mist; p.alive = true;
  }

  update(dt: number, camera: THREE.Vector3): void {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    const F = this.flecksCloud;
    for (let i = 0; i < this.flecks.length; i++) {
      const f = this.flecks[i];
      if (!f.alive) { if (this.rnd(30) < 0.12) this.spawnFleck(f, camera); }
      if (!f.alive) { F.alpha[i] = 0; F.size[i] = 0; continue; }
      const rt = this.rivers[f.river];
      if (!rt) { f.alive = false; F.alpha[i] = 0; continue; }
      const { a, b, f: t } = this.sampleAt(rt, f.s);
      const speed = lerp(a.speed, b.speed, t) * f.speedMul;
      f.s += speed * dt;
      f.age += dt;
      if (f.age > f.life || f.s >= rt.hydro.length) { f.alive = false; F.alpha[i] = 0; continue; }
      const { a: a2, b: b2, f: t2 } = this.sampleAt(rt, f.s);
      const half = lerp(a2.width, b2.width, t2) / 2;
      const x = lerp(a2.pos.x, b2.pos.x, t2) + lerp(a2.right.x, b2.right.x, t2) * f.u * half;
      const z = lerp(a2.pos.z, b2.pos.z, t2) + lerp(a2.right.z, b2.right.z, t2) * f.u * half;
      const fall = a2.kind === 'fall';
      const y = lerp(a2.pos.y, b2.pos.y, t2) + (fall ? 0.3 : 0.05 + 0.03 * Math.sin(this.t * 3 + i));
      F.pos[i * 3] = x; F.pos[i * 3 + 1] = y; F.pos[i * 3 + 2] = z;
      if (Math.hypot(x - camera.x, z - camera.z) > this.opts.range) { f.alive = false; F.alpha[i] = 0; continue; }
      const fade = smooth(0, 0.6, f.age) * smooth(f.life, f.life - 1.2, f.age) * smooth(this.opts.range, this.opts.range * 0.7, Math.hypot(x - camera.x, z - camera.z));
      const turb = lerp(a2.turbulence, b2.turbulence, t2);
      F.alpha[i] = fade * (fall ? 0.9 : 0.35 + 0.45 * turb);
      F.size[i] = f.size * (fall ? 2.6 : 1);
    }
    F.flush();
    this.stepSpray(this.spray, this.sprayCloud, dt, camera, false);
    this.stepSpray(this.mist, this.mistCloud, dt, camera, true);
  }

  private stepSpray(list: Spray[], cloud: Cloud, dt: number, camera: THREE.Vector3, mist: boolean): void {
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p.alive) { if (this.rnd(40) < (mist ? 0.05 : 0.18)) this.spawnSpray(list, i, mist); }
      if (!p.alive) { cloud.alpha[i] = 0; cloud.size[i] = 0; continue; }
      p.age += dt;
      if (p.age > p.life) { p.alive = false; cloud.alpha[i] = 0; continue; }
      if (mist) { p.vy *= 1 - 0.35 * dt; p.vx *= 1 - 0.2 * dt; p.vz *= 1 - 0.2 * dt; } else p.vy -= 9.81 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.size += p.grow * dt;
      const d = Math.hypot(p.x - camera.x, p.z - camera.z);
      cloud.pos[i * 3] = p.x; cloud.pos[i * 3 + 1] = p.y; cloud.pos[i * 3 + 2] = p.z;
      cloud.size[i] = p.size;
      cloud.alpha[i] = p.alpha * smooth(0, 0.25, p.age) * smooth(p.life, p.life * 0.55, p.age) * smooth(this.opts.range * 3, this.opts.range * 2, d);
    }
    cloud.flush();
  }

  dispose(): void {
    for (const c of [this.flecksCloud, this.sprayCloud, this.mistCloud]) { c.geometry.dispose(); c.material.dispose(); }
    this.group.clear();
  }
}
