// Materials for props, by NAME (same idea as the road MaterialRegistry): assets reference names, what a
// name looks like can be replaced (`set`). Sign faces are created on demand: `sign:<id>[:<text>]`.

import * as THREE from 'three';
import { drawSign, parseSignAsset, type CanvasFactory } from './signs';

type Maker = () => THREE.Material;

const lambert = (color: number, extra: THREE.MeshLambertMaterialParameters = {}): Maker => () => new THREE.MeshLambertMaterial({ color, ...extra });

export const DEFAULT_PROP_MATERIALS: Record<string, Maker> = {
  steel: lambert(0xaab0b4, { side: THREE.DoubleSide }),
  steel_dark: lambert(0x4a4e52),
  concrete_barrier: lambert(0xa9a7a1),
  wood: lambert(0x8b6a45),
  plastic_white: lambert(0xf0f0ec),
  plastic_black: lambert(0x1c1c1e),
  reflector: () => new THREE.MeshLambertMaterial({ color: 0xffb000, emissive: 0x553300 }),
  lamp_glow: () => new THREE.MeshBasicMaterial({ color: 0xfff1c4 }),
  stone: lambert(0xa6a49e),
  bark: lambert(0x5a4631),
  foliage: lambert(0x436e33, { flatShading: true }),
  foliage_light: lambert(0x5d8a3d, { flatShading: true }),
  sign_back: lambert(0x9a9da0),
  marker: lambert(0xff00ff),
};

export class PropMaterials {
  private readonly cache = new Map<string, THREE.Material>();
  private readonly overrides = new Map<string, Maker>();

  constructor(private readonly canvasFactory?: CanvasFactory) {}

  /** Replace what a name looks like (e.g. a textured material). Existing meshes keep the old material until rebuilt. */
  set(name: string, material: THREE.Material | Maker): void {
    this.cache.get(name)?.dispose();
    this.cache.delete(name);
    this.overrides.set(name, typeof material === 'function' ? material : () => material);
  }

  /** true for names this registry knows how to make (built-ins, overrides and sign faces) */
  has(name: string): boolean {
    return name in DEFAULT_PROP_MATERIALS || this.overrides.has(name) || name.startsWith('sign:');
  }

  get(name: string): THREE.Material {
    let m = this.cache.get(name);
    if (m) return m;
    m = this.make(name);
    this.cache.set(name, m);
    return m;
  }

  private make(name: string): THREE.Material {
    const o = this.overrides.get(name);
    if (o) return o();
    const sign = parseSignAsset(name);
    if (sign) {
      const canvas = drawSign(sign.def, sign.text, 256, this.canvasFactory);
      if (!canvas) return new THREE.MeshLambertMaterial({ color: sign.def.baseColor });
      const tex = new THREE.CanvasTexture(canvas as unknown as HTMLCanvasElement);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      // retro-reflective look: the sign lights itself a little, in its own colours
      return new THREE.MeshLambertMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.55, alphaTest: 0.5 });
    }
    const maker = DEFAULT_PROP_MATERIALS[name] ?? DEFAULT_PROP_MATERIALS.marker;
    return maker();
  }

  dispose(): void {
    for (const m of this.cache.values()) {
      (m as THREE.MeshLambertMaterial).map?.dispose();
      m.dispose();
    }
    this.cache.clear();
  }
}
