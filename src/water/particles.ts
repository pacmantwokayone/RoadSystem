// Particles that go with the water: droplets thrown up where water drops and crashes, and mist that rises from the foot of waterfalls.
// (The flow direction itself is drawn by the water shader — streaks and foam that travel with the current — not by particles.)
//
// Everything is CPU-driven, drawn as two Points clouds, and only exists near the camera: emitters far away are not simulated.

import * as THREE from 'three';
import { hash01 } from '../props/rules';

export interface ParticleOptions {
  maxSpray: number;
  maxMist: number;
  /** droplets are only made this close to the camera, metres */
  sprayRange: number;
  mistRange: number;
}

export const DEFAULT_PARTICLE_OPTIONS: ParticleOptions = { maxSpray: 2200, maxMist: 700, sprayRange: 220, mistRange: 900 };

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
  gl_PointSize = clamp(aSize * uScale / max(-mvPosition.z, 0.1), 0.0, 220.0);
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
  float a = pow(1.0 - d, uSoft) * vAlpha;
  if (a < 0.003) discard;
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

  constructor(readonly count: number, color: number, soft: number, order: number) {
    this.pos = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7); // positions change every frame
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 800 }, uColor: { value: new THREE.Color(color) }, uSoft: { value: soft } },
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = order;
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

export interface Emitter {
  /** where it sits (THREE space) and the horizontal direction the water runs there */
  x: number; y: number; z: number;
  dx: number; dz: number;
  /** spread across / around it, metres */
  radius: number;
  kind: 'pool' | 'drop';
  /** 0..1 how much water crashes here */
  power: number;
  /** pools: the fall's height, metres (taller falls make taller mist) */
  height: number;
}

interface P {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number; life: number;
  size: number; grow: number; alpha: number;
  alive: boolean;
}

const mkP = (): P => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, size: 0.1, grow: 0, alpha: 0.5, alive: false });
const smooth = (a: number, b: number, v: number): number => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

export class WaterParticles {
  readonly group = new THREE.Group();
  private readonly sprayCloud: Cloud;
  private readonly mistCloud: Cloud;
  private readonly spray: P[];
  private readonly mist: P[];
  private emitters: Emitter[] = [];
  private near: Emitter[] = [];
  private nearMist: Emitter[] = [];
  private nearTimer = 0;
  private seq = 1;
  private sprayDebt = 0;
  private mistDebt = 0;

  constructor(private readonly opts: ParticleOptions = DEFAULT_PARTICLE_OPTIONS) {
    this.sprayCloud = new Cloud(opts.maxSpray, 0xffffff, 0.45, 6);
    this.mistCloud = new Cloud(opts.maxMist, 0xeef4f7, 1.2, 5);
    this.group.add(this.mistCloud.points, this.sprayCloud.points);
    this.group.name = 'water-particles';
    this.spray = Array.from({ length: opts.maxSpray }, mkP);
    this.mist = Array.from({ length: opts.maxMist }, mkP);
  }

  setEmitters(list: readonly Emitter[]): void {
    this.emitters = list.slice();
    this.nearTimer = 0;
  }

  private rnd(): number {
    return hash01(this.seq++, 5, 11);
  }

  private spawnSpray(p: P, e: Emitter): void {
    const a = this.rnd() * Math.PI * 2;
    if (e.kind === 'pool') {
      // thrown up and outwards where the sheet lands
      const r = e.radius * (0.15 + 0.5 * Math.sqrt(this.rnd()));
      p.x = e.x + Math.cos(a) * r; p.z = e.z + Math.sin(a) * r; p.y = e.y + 0.1;
      const out = (1.5 + 3.5 * this.rnd()) * (0.5 + e.power);
      p.vx = Math.cos(a) * out; p.vz = Math.sin(a) * out;
      p.vy = (3 + 8 * this.rnd()) * (0.5 + 0.5 * e.power) + Math.min(10, e.height * 0.04);
      p.life = 0.9 + 1.4 * this.rnd();
      p.size = 0.05 + 0.1 * this.rnd();
      p.alpha = 0.55 + 0.35 * this.rnd();
    } else {
      // at a drop in the rapids: a small fan of droplets thrown up and downstream
      const lat = (this.rnd() * 2 - 1) * e.radius;
      p.x = e.x - e.dz * lat; p.z = e.z + e.dx * lat; p.y = e.y + 0.05;
      const v = (0.8 + 2.2 * this.rnd()) * (0.5 + e.power);
      p.vx = e.dx * v + (this.rnd() - 0.5) * 0.8; p.vz = e.dz * v + (this.rnd() - 0.5) * 0.8;
      p.vy = (1.2 + 2.6 * this.rnd()) * (0.5 + e.power);
      p.life = 0.35 + 0.55 * this.rnd();
      p.size = 0.03 + 0.06 * this.rnd();
      p.alpha = 0.5 + 0.4 * this.rnd();
    }
    p.age = 0; p.grow = 0; p.alive = true;
  }

  private spawnMist(p: P, e: Emitter): void {
    const a = this.rnd() * Math.PI * 2;
    const r = e.radius * Math.sqrt(this.rnd()) * 1.1;
    p.x = e.x + Math.cos(a) * r; p.z = e.z + Math.sin(a) * r; p.y = e.y + 0.5 + this.rnd() * 1.5;
    const rise = 1.6 + 2.4 * this.rnd() + Math.min(5, e.height * 0.02);
    p.vx = Math.cos(a) * 0.6 + e.dx * 2.2; p.vz = Math.sin(a) * 0.6 + e.dz * 2.2; p.vy = rise;
    p.life = 5 + 6 * this.rnd() + Math.min(6, e.height * 0.02);
    // a 10 m step makes a little haze, a 400 m fall a cloud
    const hs = Math.min(1.3, Math.max(0.1, Math.sqrt(e.height) / 14));
    p.size = (4 + 8 * this.rnd()) * hs;
    p.grow = (2 + 3 * this.rnd()) * hs;
    p.vy *= 0.35 + 0.65 * Math.min(1, hs);
    p.alpha = (0.13 + 0.14 * this.rnd()) * (0.5 + 0.5 * e.power) * (0.35 + 0.65 * Math.min(1, hs));
    p.age = 0; p.alive = true;
  }

  /** a plume that appears the moment you arrive looks wrong: when particles first become relevant, run a few seconds ahead */
  private warm = false;

  update(dt: number, camera: THREE.Vector3): void {
    this.step(dt, camera);
    if (!this.warm && (this.nearMist.length || this.near.length)) {
      this.warm = true;
      for (let i = 0; i < 60; i++) this.step(0.1, camera);
    } else if (this.warm && !this.nearMist.length && !this.near.length) this.warm = false;
  }

  private step(dt: number, camera: THREE.Vector3): void {
    dt = Math.min(dt, 0.1);
    // which emitters are close enough to matter (refreshed a few times a second)
    this.nearTimer -= dt;
    if (this.nearTimer <= 0) {
      this.nearTimer = 0.4;
      const rs = this.opts.sprayRange * this.opts.sprayRange, rm = this.opts.mistRange * this.opts.mistRange;
      this.near = []; this.nearMist = [];
      for (const e of this.emitters) {
        const d2 = (e.x - camera.x) ** 2 + (e.z - camera.z) ** 2;
        if (d2 < rs) this.near.push(e);
        if (e.kind === 'pool' && d2 < rm) this.nearMist.push(e);
      }
    }
    // spawn
    if (this.near.length) {
      this.sprayDebt += Math.min(900, 160 + 40 * this.near.length) * dt;
      for (const p of this.spray) {
        if (this.sprayDebt < 1) break;
        if (p.alive) continue;
        this.spawnSpray(p, this.near[Math.floor(this.rnd() * this.near.length)]);
        this.sprayDebt -= 1;
      }
      this.sprayDebt = Math.min(this.sprayDebt, 20);
    }
    if (this.nearMist.length) {
      this.mistDebt += Math.min(120, 70 * this.nearMist.length) * dt;
      for (const p of this.mist) {
        if (this.mistDebt < 1) break;
        if (p.alive) continue;
        this.spawnMist(p, this.nearMist[Math.floor(this.rnd() * this.nearMist.length)]);
        this.mistDebt -= 1;
      }
      this.mistDebt = Math.min(this.mistDebt, 10);
    }
    // move
    const S = this.sprayCloud;
    this.spray.forEach((p, i) => {
      if (!p.alive) { S.alpha[i] = 0; S.size[i] = 0; return; }
      p.age += dt;
      if (p.age > p.life) { p.alive = false; S.alpha[i] = 0; S.size[i] = 0; return; }
      p.vy -= 9.81 * dt; p.vx *= 1 - 0.8 * dt; p.vz *= 1 - 0.8 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      S.pos[i * 3] = p.x; S.pos[i * 3 + 1] = p.y; S.pos[i * 3 + 2] = p.z;
      S.size[i] = p.size;
      S.alpha[i] = p.alpha * smooth(0, 0.08, p.age) * (1 - smooth(0.6, 1, p.age / p.life));
    });
    S.flush();
    const M = this.mistCloud;
    this.mist.forEach((p, i) => {
      if (!p.alive) { M.alpha[i] = 0; M.size[i] = 0; return; }
      p.age += dt;
      if (p.age > p.life) { p.alive = false; M.alpha[i] = 0; M.size[i] = 0; return; }
      p.vy *= 1 - 0.18 * dt; p.vx *= 1 - 0.1 * dt; p.vz *= 1 - 0.1 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.size += p.grow * dt;
      const k = p.age / p.life;
      M.pos[i * 3] = p.x; M.pos[i * 3 + 1] = p.y; M.pos[i * 3 + 2] = p.z;
      M.size[i] = p.size;
      M.alpha[i] = p.alpha * smooth(0, 0.18, k) * (1 - smooth(0.5, 1, k));
    });
    M.flush();
  }

  dispose(): void {
    for (const c of [this.sprayCloud, this.mistCloud]) { c.geometry.dispose(); c.material.dispose(); }
    this.group.clear();
  }
}
