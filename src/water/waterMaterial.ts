// The water shader: ONE material family for rivers, lakes and waterfalls (a define picks the variant). It is built for what
// a flying player sees: depth-coloured, see-through shallows, ripples and streaks that run with the current, foam along the shores,
// on rapids, around and behind everything that sticks out of the water, and white streaked sheets for waterfalls.
//
// Vertex data (see riverMesh.ts): aLat = metres across (from the centre line), aV = metres along the flow (absolute arc length),
// aDepth = water depth under the vertex (from the real terrain), aTurb = 0..1 churn, aSpeed = surface speed m/s, aHalf = half width,
// aDir = flow direction in x/z. Everything else is computed per pixel — no textures.

import * as THREE from 'three';
import type { WaterStyle } from './style';

export const MAX_OBSTACLES = 24;

export type WaterShaderKind = 'river' | 'lake' | 'fall';

export interface WaterShared {
  time: { value: number };
  sun: { value: THREE.Vector3 };
  sky: { value: THREE.Color };
}

export function makeWaterShared(): WaterShared {
  return { time: { value: 0 }, sun: { value: new THREE.Vector3(-0.5, 0.82, 0.27).normalize() }, sky: { value: new THREE.Color(0xbcd6ea) } };
}

const NOISE = /* glsl */ `
float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0)), c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return v;
}
`;

const VERTEX = /* glsl */ `
attribute float aLat;
attribute float aV;
attribute float aDepth;
attribute float aTurb;
attribute float aSpeed;
attribute float aHalf;
attribute vec2 aDir;
varying vec3 vWorld;
varying float vLat;
varying float vV;
varying float vDepth;
varying float vTurb;
varying float vSpeed;
varying float vHalf;
varying vec2 vDir;
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
void main() {
  vLat = aLat; vV = aV; vDepth = aDepth; vTurb = aTurb; vSpeed = aSpeed; vHalf = aHalf; vDir = aDir;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorld = worldPos.xyz;
  vec4 mvPosition = viewMatrix * worldPos;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uSun;
uniform vec3 uSky;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uFoamColor;
uniform float uClarity;
uniform float uRipple;
uniform float uStreaks;
uniform float uFoamEdge;
uniform float uFoamObs;
uniform float uFoamRapids;
uniform float uFoamFall;
uniform float uFallStreak;
uniform float uWaveHeight;
uniform float uWaveScale;
uniform float uWaveSpeed;
uniform vec4 uObs[${MAX_OBSTACLES}];
uniform int uObsCount;
varying vec3 vWorld;
varying float vLat;
varying float vV;
varying float vDepth;
varying float vTurb;
varying float vSpeed;
varying float vHalf;
varying vec2 vDir;
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
${NOISE}
void main() {
  #include <logdepthbuf_fragment>
  float t = uTime;
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 N = vec3(0.0, 1.0, 0.0);
  vec3 col;
  float alpha;
  float foam = 0.0;

  #if WATER_KIND == 2
    // ---- waterfall: a white, streaked sheet falling down -------------------------------------
    float u = vLat / max(vHalf, 0.01);
    float edge = 1.0 - smoothstep(0.70, 1.0, abs(u));
    float fall = vTurb;                                   // 0 at the lip … 1 at the foot
    float y = vV * 0.22 - t * (5.0 + vSpeed * 0.18);
    float s1 = fbm(vec2(vLat * 1.3, y));
    float s2 = fbm(vec2(vLat * 3.3 + 7.0, y * 2.4 + 3.0));
    float streak = smoothstep(0.34, 0.78, s1 * 0.62 + s2 * 0.5);
    float white = 0.42 + 0.5 * streak * uFallStreak + 0.12 * (1.0 - uFallStreak);
    white += uFoamFall * (0.75 * (1.0 - smoothstep(0.0, 0.05, fall)) + 0.9 * smoothstep(0.93, 1.0, fall));
    white = clamp(white, 0.0, 1.0);
    vec3 sheet = mix(uShallow * 0.9, uFoamColor, white);
    float fres = pow(1.0 - max(dot(normalize(vec3(vDir.x, 0.35, vDir.y)), V), 0.0), 2.0);
    col = mix(sheet, uSky, fres * 0.25);
    alpha = edge * mix(0.5, 0.97, white);
    foam = white;
  #else
    // ---- river / lake surface -------------------------------------------------------------------
    vec2 tan2 = normalize(vDir + vec2(1e-5));
    vec2 rgt2 = vec2(-tan2.y, tan2.x);
    float rip = uRipple + vTurb * 0.9;
    vec2 g = vec2(0.0);       // gradient of the little waves, in (across, along)
    #if WATER_KIND == 1
      vec2 q = vWorld.xz;
      vec2 p1 = q / uWaveScale + vec2(t * uWaveSpeed * 0.35, t * uWaveSpeed * 0.21);
      vec2 p2 = q / (uWaveScale * 0.43) - vec2(t * uWaveSpeed * 0.27, -t * uWaveSpeed * 0.40);
      float e = 0.06;
      float h0 = fbm(p1) + 0.6 * fbm(p2);
      g = vec2(fbm(p1 + vec2(e, 0.0)) + 0.6 * fbm(p2 + vec2(e, 0.0)) - h0, fbm(p1 + vec2(0.0, e)) + 0.6 * fbm(p2 + vec2(0.0, e)) - h0) / e;
      g *= uWaveHeight * 3.0 + rip * 0.15;
      vec2 flowq = q;
    #else
      vec2 q = vec2(vLat, vV - t * vSpeed);
      vec2 p1 = q * vec2(1.1, 0.62);
      vec2 p2 = q * vec2(2.6, 1.4) + vec2(5.0, 11.0);
      float e = 0.07;
      float h0 = fbm(p1) + 0.55 * fbm(p2);
      g = vec2(fbm(p1 + vec2(e, 0.0)) + 0.55 * fbm(p2 + vec2(e, 0.0)) - h0, fbm(p1 + vec2(0.0, e)) + 0.55 * fbm(p2 + vec2(0.0, e)) - h0) / e;
      g *= rip * 0.55;
      vec2 flowq = q;
    #endif
    N = normalize(vec3(-(rgt2.x * g.x + tan2.x * g.y), 1.0, -(rgt2.y * g.x + tan2.y * g.y)));
    #if WATER_KIND == 1
      N = normalize(vec3(-g.x, 1.0, -g.y));
    #endif

    // colour by depth; clear water shows the bed further out
    float deepAt = mix(0.6, 3.2, uClarity);
    float dm = smoothstep(0.0, deepAt, vDepth);
    vec3 water = mix(uShallow, uDeep, dm);
    float alphaDeep = 0.55 + (1.0 - uClarity) * 0.40;
    alpha = mix(0.10, alphaDeep, smoothstep(0.0, mix(0.35, 2.4, uClarity), vDepth));
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col = mix(water, uSky, 0.12 + fres * 0.55);

    // streaks that run with the current show the direction of the flow
    #if WATER_KIND == 0
      float st = fbm(vec2(vLat * 2.0, (vV - t * vSpeed) * 0.32));
      float lines = smoothstep(0.58, 0.78, st) * uStreaks;
      col += lines * 0.22 * (0.4 + vTurb);
      alpha = min(1.0, alpha + lines * 0.12);
    #endif

    // sun glints
    vec3 H = normalize(normalize(uSun) + V);
    float spec = pow(max(dot(N, H), 0.0), 140.0) * (0.55 + 0.45 * fres);
    col += vec3(1.0, 0.97, 0.9) * spec * 0.9;
    alpha = min(1.0, alpha + spec * 0.5);

    // foam: along the shore (where the water gets shallow) …
    float shore = uFoamEdge * (1.0 - smoothstep(0.02, 0.5, vDepth));
    float nz = fbm(flowq * vec2(3.0, 1.6) + vec2(0.0, 3.0));
    foam += shore * smoothstep(0.25, 0.75, nz + shore * 0.45);
    // … on rapids and wherever the water is churned …
    #if WATER_KIND == 0
      float churn = smoothstep(0.35, 1.0, vTurb);          // only really churned water goes white; a brisk stream just ripples
      float patches = smoothstep(0.55, 0.88, fbm(vec2(vLat * 1.8, (vV - t * vSpeed * 1.1) * 1.1)) + churn * 0.3);
      foam += churn * uFoamRapids * patches;
      foam += churn * 0.22 * smoothstep(0.62, 0.9, fbm(vec2(vLat * 5.0, (vV - t * vSpeed * 1.3) * 2.6)));
    #endif
    // … and around and behind everything that sticks out of the water (on a river the foam trails off downstream;
    // on a lake aLat / aV are the world x / z and only the ring is drawn)
    for (int i = 0; i < ${MAX_OBSTACLES}; i++) {
      if (i >= uObsCount) break;
      vec4 o = uObs[i];
      vec2 d = vec2(vLat - o.x, vV - o.y);
      float r = o.z;
      float ring = 1.0 - smoothstep(r * 1.0, r * 1.9, length(d));
      float wake = 0.0;
      #if WATER_KIND == 0
        float dv = d.y;
        float spread = r * 0.9 + max(dv, 0.0) * 0.12;
        wake = step(0.0, dv) * exp(-pow(d.x / spread, 2.0)) * (1.0 - smoothstep(r * 2.0, r * 8.0, dv));
      #endif
      float wob = 0.55 + 0.45 * fbm(vec2(vLat * 4.0 + float(i) * 3.7, (vV - t * vSpeed * 1.2) * 2.2));
      foam += o.w * uFoamObs * (ring * 0.95 + wake * 0.8) * wob;
    }
    foam = clamp(foam, 0.0, 1.0);
    float foamTex = foam * (0.55 + 0.45 * fbm(flowq * vec2(7.0, 3.5) + vec2(t * 0.15, 0.0)));
    foamTex = smoothstep(0.12, 0.7, foamTex) * clamp(foam * 1.6, 0.0, 1.0);
    col = mix(col, uFoamColor, foamTex);
    alpha = max(alpha, foamTex * 0.97);
    foam = foamTex;
  #endif

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface WaterMaterialOptions {
  kind: WaterShaderKind;
  style: WaterStyle;
  shared: WaterShared;
}

export function createWaterMaterial({ kind, style, shared }: WaterMaterialOptions): THREE.ShaderMaterial {
  const c = style.colors;
  const obs: THREE.Vector4[] = Array.from({ length: MAX_OBSTACLES }, () => new THREE.Vector4());
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uShallow: { value: new THREE.Color(c.shallow) },
      uDeep: { value: new THREE.Color(c.deep) },
      uFoamColor: { value: new THREE.Color(c.foam) },
      uClarity: { value: style.clarity },
      uRipple: { value: style.flow.ripple },
      uStreaks: { value: style.flow.streaks },
      uFoamEdge: { value: style.foam.edge },
      uFoamObs: { value: style.foam.obstacles },
      uFoamRapids: { value: style.foam.rapids },
      uFoamFall: { value: style.foam.fall },
      uFallStreak: { value: style.fall.streak },
      uWaveHeight: { value: style.waves.height },
      uWaveScale: { value: style.waves.scale },
      uWaveSpeed: { value: style.waves.speed },
      uObs: { value: obs },
      uObsCount: { value: 0 },
    },
  ]);
  uniforms.uTime = shared.time;
  uniforms.uSun = shared.sun;
  uniforms.uSky = shared.sky;
  const m = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    defines: { WATER_KIND: kind === 'river' ? 0 : kind === 'lake' ? 1 : 2 },
    transparent: true,
    depthWrite: false,
    fog: true,
    side: kind === 'fall' ? THREE.DoubleSide : THREE.FrontSide,
  });
  return m;
}

/** Writes up to MAX_OBSTACLES obstacles (lat, v, radius, strength) into a material's uniform array. */
export function setObstacles(m: THREE.ShaderMaterial, obstacles: ReadonlyArray<{ lat: number; v: number; r: number; strength: number }>): void {
  const arr = m.uniforms.uObs.value as THREE.Vector4[];
  const n = Math.min(MAX_OBSTACLES, obstacles.length);
  for (let i = 0; i < n; i++) arr[i].set(obstacles[i].lat, obstacles[i].v, obstacles[i].r, obstacles[i].strength);
  m.uniforms.uObsCount.value = n;
}
