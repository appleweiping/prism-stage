import * as THREE from "three";
import type { InputSample, ScenePlugin, VisualParams } from "../core/types";
import {
  disposeObject,
  handPosition,
  paletteColors,
  shaderOutput,
} from "./common";

const RING_SIZE = 10;
const MAX_POINTS = 720;
const MAX_STROKES = 32;
interface RibbonPoint {
  position: THREE.Vector3;
  time: number;
  distance: number;
}
interface Stroke {
  hand: string;
  points: RibbonPoint[];
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  times: Float32Array;
}

export class RibbonScene implements ScenePlugin {
  readonly id = "ribbon" as const;
  readonly root = new THREE.Group();
  private params: VisualParams;
  private strokes: Stroke[] = [];
  private active = new Map<string, Stroke>();
  private lastUndoCount = 0;
  private seed = 0;
  private time = 0;
  private material: THREE.ShaderMaterial;
  private cursors: THREE.Mesh[] = [];
  private cursorMaterials: THREE.ShaderMaterial[] = [];
  private up = new THREE.Vector3(0, 0, 1);

  constructor(scene: THREE.Scene, seed: number, params: VisualParams) {
    this.params = { ...params };
    const colors = paletteColors(params);
    this.material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: params.intensity },
        uTrail: { value: params.trail },
        uMaterial: { value: 0 },
        uSpeed: { value: params.speed },
        uColors: { value: colors },
      },
      vertexShader: `
        varying vec2 vUv; varying vec3 vNormal; varying vec3 vPosition; varying float vBirth;
        attribute float birth;
        void main(){vUv=uv;vBirth=birth;vNormal=normalize(normalMatrix*normal);vec4 p=modelViewMatrix*vec4(position,1.);vPosition=p.xyz;gl_Position=projectionMatrix*p;}
      `,
      fragmentShader: `
        varying vec2 vUv; varying vec3 vNormal; varying vec3 vPosition; varying float vBirth;
        uniform vec3 uColors[4]; uniform float uTime,uIntensity,uTrail,uMaterial,uSpeed;
        void main(){
          vec3 n=normalize(vNormal); if(!gl_FrontFacing)n=-n;
          float phase=vUv.x*.31+vUv.y*.22;
          float cycle=mod(phase,4.);
          vec3 color=cycle<1.?mix(uColors[0],uColors[1],smoothstep(0.,1.,cycle)):
            cycle<2.?mix(uColors[1],uColors[2],smoothstep(1.,2.,cycle)):
            cycle<3.?mix(uColors[2],uColors[3],smoothstep(2.,3.,cycle)):
            mix(uColors[3],uColors[0],smoothstep(3.,4.,cycle));
          float facing=abs(n.z);
          float rim=pow(1.-facing,2.1);
          float key=pow(max(0.,dot(n,normalize(vec3(-.35,.8,1.)))),4.);
          float sharp=pow(max(0.,dot(n,normalize(vec3(.25,.3,1.)))),36.);
          float folds=pow(.5+.5*cos(vUv.y*6.283*3.+vUv.x*.7),18.);
          float pulse=.97+.03*sin(vUv.x*1.5-uTime*uSpeed);
          vec3 silk=color*(.24+key*1.08)+vec3(.8,.95,1.)*sharp*.82+color*rim*.42;
          vec3 glass=color*(.08+rim*.65)+vec3(.94,1.,.95)*(sharp*.9+folds*.14)+color*key*.5;
          vec3 neon=color*(.35+rim*.9)+color*key*.3+vec3(.85,1.,.95)*sharp*.6;
          vec3 c=uMaterial<.5?silk:(uMaterial<1.5?glass:neon);
          float age=max(0.,uTime-vBirth);
          float retain=mix(.16,1.,exp(-age/(2.+uTrail*uTrail*150.)));
          c*=uIntensity*pulse*retain;
          gl_FragColor=vec4(c,1.);
          ${shaderOutput}
        }
      `,
    });
    const cursorGeometry = new THREE.PlaneGeometry(0.35, 0.35);
    for (let i = 0; i < 2; i++) {
      const material = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uColor: { value: colors[i] }, uPinch: { value: 0 } },
        vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
        fragmentShader: `varying vec2 vUv;uniform vec3 uColor;uniform float uPinch;void main(){float d=length(vUv-.5);float ring=smoothstep(.03,0.,abs(d-.24));float glow=exp(-d*d*35.);float a=ring*.35+glow*(.3+uPinch*.5);gl_FragColor=vec4(uColor,a);${shaderOutput}}`,
      });
      const mesh = new THREE.Mesh(cursorGeometry, material);
      mesh.visible = false;
      mesh.renderOrder = 3;
      this.cursors.push(mesh);
      this.cursorMaterials.push(material);
      this.root.add(mesh);
    }
    scene.add(this.root);
    this.reset(seed);
    this.setParams(params);
  }

  private newStroke(hand: string): Stroke {
    if (this.strokes.length >= MAX_STROKES) {
      const removed = this.strokes.shift()!;
      if (this.active.get(removed.hand) === removed)
        this.active.delete(removed.hand);
      removed.mesh.removeFromParent();
      removed.mesh.geometry.dispose();
    }
    const vertices = MAX_POINTS * RING_SIZE;
    const positions = new Float32Array(vertices * 3);
    const normals = new Float32Array(vertices * 3);
    const uvs = new Float32Array(vertices * 2);
    const times = new Float32Array(vertices);
    const indices = new Uint16Array((MAX_POINTS - 1) * RING_SIZE * 6);
    for (let i = 0; i < MAX_POINTS - 1; i++)
      for (let j = 0; j < RING_SIZE; j++) {
        const a = i * RING_SIZE + j;
        const b = i * RING_SIZE + ((j + 1) % RING_SIZE);
        const offset = (i * RING_SIZE + j) * 6;
        indices.set(
          [a, b, a + RING_SIZE, b, b + RING_SIZE, a + RING_SIZE],
          offset,
        );
      }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
      "uv",
      new THREE.BufferAttribute(uvs, 2).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
      "birth",
      new THREE.BufferAttribute(times, 1).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.frustumCulled = false;
    this.root.add(mesh);
    const stroke = { hand, points: [], mesh, positions, normals, uvs, times };
    this.strokes.push(stroke);
    this.active.set(hand, stroke);
    return stroke;
  }

  private rebuild(stroke: Stroke, start = 0): void {
    const tangent = new THREE.Vector3();
    const side = new THREE.Vector3();
    const face = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const count = stroke.points.length;
    for (let i = Math.max(0, start); i < count; i++) {
      const point = stroke.points[i];
      const prev = stroke.points[Math.max(0, i - 1)].position;
      const next = stroke.points[Math.min(count - 1, i + 1)].position;
      tangent.subVectors(next, prev).normalize();
      if (tangent.lengthSq() < 0.001) tangent.set(1, 0, 0);
      side.crossVectors(tangent, this.up).normalize();
      if (side.lengthSq() < 0.001) side.set(1, 0, 0);
      face.crossVectors(side, tangent).normalize();
      const twist =
        Math.sin(point.distance * 0.67 + this.seed * 0.001) * 0.95 +
        point.distance * 0.1;
      const taper = Math.min(1, 0.18 + (count - 1 - i) * 0.45);
      const width =
        (0.07 + this.params.width * 0.43) *
        Math.min(1, 0.15 + point.distance * 3) *
        taper;
      for (let j = 0; j < RING_SIZE; j++) {
        const angle = (j / RING_SIZE) * Math.PI * 2;
        const x = Math.cos(angle) * width;
        const y = Math.sin(angle) * width * 0.14;
        const rx = x * Math.cos(twist) - y * Math.sin(twist);
        const ry = x * Math.sin(twist) + y * Math.cos(twist);
        const vertex = i * RING_SIZE + j;
        stroke.positions[vertex * 3] =
          point.position.x + side.x * rx + face.x * ry;
        stroke.positions[vertex * 3 + 1] =
          point.position.y + side.y * rx + face.y * ry;
        stroke.positions[vertex * 3 + 2] =
          point.position.z + side.z * rx + face.z * ry;
        const nx = Math.cos(angle) * 0.14;
        const ny = Math.sin(angle);
        normal
          .copy(side)
          .multiplyScalar(nx * Math.cos(twist) - ny * Math.sin(twist))
          .addScaledVector(face, nx * Math.sin(twist) + ny * Math.cos(twist))
          .normalize();
        normal.toArray(stroke.normals, vertex * 3);
        stroke.uvs[vertex * 2] = point.distance;
        stroke.uvs[vertex * 2 + 1] = j / RING_SIZE;
        stroke.times[vertex] = point.time;
      }
    }
    for (const name of ["position", "normal", "uv", "birth"])
      stroke.mesh.geometry.getAttribute(name).needsUpdate = true;
    stroke.mesh.geometry.setDrawRange(
      0,
      Math.max(0, count - 1) * RING_SIZE * 6,
    );
  }

  update(_dt: number, t: number, input: InputSample): void {
    this.time = t;
    this.material.uniforms.uTime.value = t;
    const undoCount = input.undoCount ?? 0;
    while (this.lastUndoCount < undoCount) {
      this.undo();
      this.lastUndoCount++;
    }
    this.cursors.forEach((cursor) => {
      cursor.visible = false;
    });
    const present = new Set<string>();
    input.hands.forEach((hand, i) => {
      present.add(hand.id);
      const point = handPosition(hand);
      const drawing = this.params.drawingMode === "follow" || hand.pinch;
      if (i < this.cursors.length) {
        this.cursors[i].visible =
          input.source !== "demo" && input.source !== "replay";
        this.cursors[i].position.copy(point);
        this.cursors[i].position.z += 0.1;
        this.cursorMaterials[i].uniforms.uPinch.value = drawing ? 1 : 0;
      }
      if (!drawing) {
        this.active.delete(hand.id);
        return;
      }
      let stroke = this.active.get(hand.id);
      if (!stroke) stroke = this.newStroke(hand.id);
      let prev: RibbonPoint | undefined =
        stroke.points[stroke.points.length - 1];
      if (prev && point.distanceTo(prev.position) < 0.025) return;
      // Discontinuities (reacquisition or a video seek) are separate strokes.
      if (prev && point.distanceTo(prev.position) > 1.8) {
        stroke = this.newStroke(hand.id);
        prev = undefined;
      }
      if (stroke.points.length >= MAX_POINTS) {
        const last = stroke.points[stroke.points.length - 1];
        stroke = this.newStroke(hand.id);
        stroke.points.push({
          position: last.position.clone(),
          time: t,
          distance: 0,
        });
        prev = stroke.points[0];
      }
      const distance = prev
        ? prev.distance + point.distanceTo(prev.position)
        : 0;
      stroke.points.push({ position: point, time: t, distance });
      this.rebuild(stroke, stroke.points.length - 3);
    });
    for (const id of this.active.keys())
      if (!present.has(id)) this.active.delete(id);
  }

  setParams(params: VisualParams): void {
    const widthChanged = params.width !== this.params.width;
    this.params = { ...params };
    this.material.uniforms.uColors.value = paletteColors(params);
    this.material.uniforms.uIntensity.value = params.intensity;
    this.material.uniforms.uTrail.value = params.trail;
    this.material.uniforms.uSpeed.value = params.speed;
    this.material.uniforms.uMaterial.value =
      params.material === "silk" ? 0 : params.material === "glass" ? 1 : 2;
    if (widthChanged) this.strokes.forEach((stroke) => this.rebuild(stroke));
  }

  undo(): void {
    const stroke = this.strokes.pop();
    if (!stroke) return;
    if (this.active.get(stroke.hand) === stroke)
      this.active.delete(stroke.hand);
    stroke.mesh.removeFromParent();
    stroke.mesh.geometry.dispose();
  }

  reset(seed: number): void {
    this.seed = seed;
    for (const stroke of this.strokes) {
      stroke.mesh.removeFromParent();
      stroke.mesh.geometry.dispose();
    }
    this.strokes = [];
    this.active.clear();
    this.lastUndoCount = 0;
    this.time = 0;
    this.material.uniforms.uTime.value = 0;
    this.cursors.forEach((cursor) => {
      cursor.visible = false;
    });
  }

  dispose(): void {
    this.reset(this.seed);
    this.material.dispose();
    disposeObject(this.root);
  }
}
