import * as THREE from "three";
import { PALETTES } from "../core/presets";
import type { TrackedHand, VisualParams } from "../core/types";

export const WORLD_WIDTH = 12;
export const WORLD_HEIGHT = 6.75;
export const shaderOutput = `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let n = state;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

export function handPosition(
  hand: TrackedHand,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  return target.set(
    (hand.x - 0.5) * WORLD_WIDTH,
    (0.5 - hand.y) * WORLD_HEIGHT,
    THREE.MathUtils.clamp(-hand.z * 3, -1.15, 1.15),
  );
}

export function paletteColors(params: VisualParams): THREE.Color[] {
  return (PALETTES[params.palette] ?? PALETTES.aurora).map(
    (color) => new THREE.Color(color),
  );
}

/** Disposes shared resources once, including textures used by custom shader uniforms. */
export function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    const drawable = object as THREE.Mesh;
    if (drawable.geometry) geometries.add(drawable.geometry);
    if (drawable.material) {
      const list = Array.isArray(drawable.material)
        ? drawable.material
        : [drawable.material];
      list.forEach((material) => materials.add(material));
    }
  });
  for (const material of materials) {
    for (const value of Object.values(material))
      if (value instanceof THREE.Texture) textures.add(value);
    if (material instanceof THREE.ShaderMaterial) {
      for (const uniform of Object.values(material.uniforms))
        if (uniform.value instanceof THREE.Texture) textures.add(uniform.value);
    }
    material.dispose();
  }
  textures.forEach((texture) => texture.dispose());
  geometries.forEach((geometry) => geometry.dispose());
  root.removeFromParent();
  root.clear();
}

export class Atmosphere {
  readonly group = new THREE.Group();
  private readonly background: THREE.ShaderMaterial;
  private readonly dust: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene, seed: number, params: VisualParams) {
    const colors = paletteColors(params);
    this.background = new THREE.ShaderMaterial({
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: colors[1] },
        uIntensity: { value: params.intensity },
      },
      vertexShader: `varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `
        varying vec2 vUv; uniform float uTime; uniform vec3 uColor; uniform float uIntensity;
        float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
        void main(){
          vec2 p=(vUv-.5)*vec2(1.7778,1.);
          vec3 c=vec3(.0052,.0061,.008);
          float halo=exp(-5.0*length(p*vec2(.8,1.)));
          c+=uColor*halo*.014*uIntensity;
          float floorLight=exp(-pow((p.y+.38)*27.,2.))*exp(-p.x*p.x*8.);
          c+=uColor*floorLight*.008;
          c+=(hash(gl_FragCoord.xy)-.5)*.0014;
          gl_FragColor=vec4(c,1.);
          ${shaderOutput}
        }`,
    });
    const backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(32, 18),
      this.background,
    );
    backdrop.position.z = -7;
    this.group.add(backdrop);
    const random = seededRandom(seed ^ 0x97b21);
    const count = 200;
    const positions = new Float32Array(count * 3);
    const factors = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (random() - 0.5) * 15;
      positions[i * 3 + 1] = (random() - 0.5) * 8.5;
      positions[i * 3 + 2] = -3 - random() * 2;
      factors[i] = random();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("factor", new THREE.BufferAttribute(factors, 1));
    this.dust = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uColor: { value: colors[0] } },
      vertexShader: `attribute float factor;varying float vAlpha;uniform float uTime;void main(){vAlpha=.12+factor*.28;gl_PointSize=1.+factor*1.1;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `varying float vAlpha;uniform vec3 uColor;void main(){float d=length(gl_PointCoord-.5);gl_FragColor=vec4(uColor*.6,smoothstep(.5,.05,d)*vAlpha);${shaderOutput}}`,
    });
    this.group.add(new THREE.Points(geometry, this.dust));
    scene.add(this.group);
  }

  setParams(params: VisualParams): void {
    const colors = paletteColors(params);
    this.background.uniforms.uColor.value.copy(colors[1]);
    this.background.uniforms.uIntensity.value = params.intensity;
    this.dust.uniforms.uColor.value.copy(colors[0]);
  }

  update(t: number): void {
    this.background.uniforms.uTime.value = t;
    this.dust.uniforms.uTime.value = t;
  }

  dispose(): void {
    disposeObject(this.group);
  }
}
