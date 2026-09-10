import * as THREE from "three";
import type { RigidBody, World } from "@dimforge/rapier3d-compat";
import type { InputSample, ScenePlugin, VisualParams } from "../core/types";
import {
  disposeObject,
  handPosition,
  paletteColors,
  seededRandom,
  shaderOutput,
} from "./common";

type Rapier = typeof import("@dimforge/rapier3d-compat");
let rapierPromise: Promise<Rapier> | undefined;
async function loadRapier(): Promise<Rapier> {
  rapierPromise ??= import("@dimforge/rapier3d-compat")
    .then(async (module) => {
      await module.init();
      return module;
    })
    .catch((error: unknown) => {
      rapierPromise = undefined;
      throw error;
    });
  return rapierPromise;
}

const BALL_COUNT = 12;
const TRAIL_POINTS = 120;
interface Ball {
  body: RigidBody;
  radius: number;
  mesh: THREE.Mesh;
  halo: THREE.Mesh;
  trail: THREE.Line;
  history: THREE.Vector3[];
}
interface Grab {
  ball: Ball;
  last: THREE.Vector3;
  velocity: THREE.Vector3;
  offset: THREE.Vector3;
}

export class GravityScene implements ScenePlugin {
  readonly id = "gravity" as const;
  readonly root = new THREE.Group();
  private readonly contents = new THREE.Group();
  private world!: World;
  private balls: Ball[] = [];
  private grabs = new Map<string, Grab>();
  private previouslyPinching = new Set<string>();
  private params: VisualParams;
  private time = 0;
  private materials: THREE.ShaderMaterial[] = [];
  private seed: number;

  static async create(
    scene: THREE.Scene,
    seed: number,
    params: VisualParams,
  ): Promise<GravityScene> {
    const rapier = await loadRapier();
    return new GravityScene(scene, seed, params, rapier);
  }

  private constructor(
    scene: THREE.Scene,
    seed: number,
    params: VisualParams,
    private readonly rapier: Rapier,
  ) {
    this.params = { ...params };
    this.seed = seed;
    this.root.add(this.contents);
    scene.add(this.root);
    this.reset(seed);
  }

  private createVisuals(): void {
    const colors = paletteColors(this.params);
    const random = seededRandom(this.seed);
    const sphereGeometry = new THREE.SphereGeometry(1, 32, 20);
    const haloGeometry = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < BALL_COUNT; i++) {
      const radius = 0.17 + random() * 0.23;
      const angle = (i / BALL_COUNT) * Math.PI * 2 + random() * 0.4;
      const distance = 1.1 + random() * 2.15;
      const x = Math.cos(angle) * distance;
      const y = Math.sin(angle) * distance * 0.58;
      const z = (random() - 0.5) * 1.3;
      const body = this.world.createRigidBody(
        this.rapier.RigidBodyDesc.dynamic()
          .setTranslation(x, y, z)
          .setLinearDamping(0.16)
          .setAngularDamping(0.35)
          .setCcdEnabled(true)
          .setCanSleep(false)
          .setLinvel(
            -Math.sin(angle) * 0.48,
            Math.cos(angle) * 0.35,
            (random() - 0.5) * 0.17,
          ),
      );
      this.world.createCollider(
        this.rapier.ColliderDesc.ball(radius)
          .setRestitution(0.88)
          .setFriction(0.08)
          .setDensity(1),
        body,
      );
      const color = colors[i % colors.length];
      const second = colors[(i + 1) % colors.length];
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: color.clone() },
          uSecond: { value: second.clone() },
          uIntensity: { value: this.params.intensity },
          uTime: { value: 0 },
          uMaterial: { value: 1 },
          uSpeed: { value: this.params.speed },
          uPhase: { value: random() * 6 },
        },
        vertexShader: `varying vec3 vNormal;varying vec3 vPosition;void main(){vNormal=normalize(normalMatrix*normal);vPosition=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
        fragmentShader: `
          varying vec3 vNormal,vPosition;uniform vec3 uColor,uSecond;uniform float uIntensity,uTime,uMaterial,uSpeed,uPhase;
          void main(){
            vec3 n=normalize(vNormal);float facing=max(0.,n.z);float rim=pow(1.-facing,2.5);
            float key=pow(max(0.,dot(n,normalize(vec3(-.5,.65,1.)))),5.);
            float spec=pow(max(0.,dot(n,normalize(vec3(-.38,.62,1.)))),55.);
            float reflection=exp(-pow((n.y-.48+n.x*.23)*13.,2.))*.3;
            float ripple=pow(.5+.5*sin((vPosition.y+vPosition.x*.16)*18.+uTime*uSpeed*.7+uPhase),6.);
            vec3 tint=mix(uColor,uSecond,smoothstep(-.7,.7,vPosition.y));
            vec3 silk=tint*(.14+key*.7)+spec*vec3(1.)*.8+tint*rim*.7;
            vec3 glass=tint*(.07+key*.18+rim*1.2)+vec3(.9,1.,1.)*(spec*.85+reflection)+tint*ripple*.075;
            vec3 neon=tint*(.16+key*.4+rim*1.3)+vec3(.9,1.,.95)*spec*.8+tint*ripple*.2;
            vec3 c=uMaterial<.5?silk:uMaterial<1.5?glass:neon;
            gl_FragColor=vec4(c*uIntensity,1.);${shaderOutput}
          }`,
      });
      this.materials.push(material);
      const mesh = new THREE.Mesh(sphereGeometry, material);
      mesh.scale.setScalar(radius);
      mesh.position.set(x, y, z);
      const glow = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uColor: { value: color.clone() },
          uIntensity: { value: this.params.intensity },
        },
        vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
        fragmentShader: `varying vec2 vUv;uniform vec3 uColor;uniform float uIntensity;void main(){float d=length(vUv-.5);float a=exp(-d*d*32.)*.14*smoothstep(.5,.38,d);gl_FragColor=vec4(uColor,a*uIntensity);${shaderOutput}}`,
      });
      this.materials.push(glow);
      const halo = new THREE.Mesh(haloGeometry, glow);
      halo.scale.setScalar(radius * (5 + this.params.width * 3));
      halo.position.copy(mesh.position);
      halo.position.z -= 0.05;
      const trailGeometry = new THREE.BufferGeometry();
      trailGeometry.setAttribute(
        "position",
        new THREE.BufferAttribute(
          new Float32Array(TRAIL_POINTS * 3),
          3,
        ).setUsage(THREE.DynamicDrawUsage),
      );
      const age = new Float32Array(TRAIL_POINTS);
      for (let j = 0; j < TRAIL_POINTS; j++) age[j] = j / (TRAIL_POINTS - 1);
      trailGeometry.setAttribute("age", new THREE.BufferAttribute(age, 1));
      trailGeometry.setDrawRange(0, 0);
      const trailMaterial = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uColor: { value: color.clone() },
          uIntensity: { value: this.params.intensity },
          uTrail: { value: this.params.trail },
        },
        vertexShader: `attribute float age;varying float vAge;void main(){vAge=age;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
        fragmentShader: `uniform vec3 uColor;uniform float uIntensity,uTrail;varying float vAge;void main(){float a=pow(max(0.,1.-vAge),2.)*uTrail*.65;gl_FragColor=vec4(uColor*uIntensity,a);${shaderOutput}}`,
      });
      this.materials.push(trailMaterial);
      const trail = new THREE.Line(trailGeometry, trailMaterial);
      trail.frustumCulled = false;
      this.contents.add(mesh, halo, trail);
      this.balls.push({ body, radius, mesh, halo, trail, history: [] });
    }
    const orbitMaterial = new THREE.LineBasicMaterial({
      color: colors[1],
      transparent: true,
      opacity: 0.07,
      depthWrite: false,
    });
    for (let i = 0; i < 3; i++) {
      const points: THREE.Vector3[] = [];
      for (let j = 0; j <= 160; j++) {
        const a = (j / 160) * Math.PI * 2;
        points.push(
          new THREE.Vector3(
            Math.cos(a) * (3.3 + i * 0.4),
            Math.sin(a) * (0.7 + i * 0.28),
            -2,
          ),
        );
      }
      const orbit = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        orbitMaterial,
      );
      orbit.rotation.z = -0.28 + i * 0.27;
      this.contents.add(orbit);
    }
    this.setParams(this.params);
  }

  private release(id: string): void {
    const grab = this.grabs.get(id);
    if (!grab) return;
    grab.ball.body.setBodyType(this.rapier.RigidBodyType.Dynamic, true);
    grab.ball.body.setLinvel(grab.velocity.clone().clampLength(0, 8), true);
    this.grabs.delete(id);
  }

  update(dt: number, t: number, input: InputSample): void {
    this.time = t;
    const pinching = new Set<string>();
    for (const hand of input.hands) {
      if (!hand.pinch) {
        this.release(hand.id);
        continue;
      }
      pinching.add(hand.id);
      const position = handPosition(hand);
      // Grab in the camera plane: depth estimation need not be physically exact.
      let grab = this.grabs.get(hand.id);
      if (!grab) {
        let nearest: Ball | undefined;
        let nearestDistance = Infinity;
        for (const ball of this.balls) {
          if ([...this.grabs.values()].some((held) => held.ball === ball))
            continue;
          const p = ball.body.translation();
          const distance = Math.hypot(p.x - position.x, p.y - position.y);
          if (distance < ball.radius + 0.4 && distance < nearestDistance) {
            nearest = ball;
            nearestDistance = distance;
          }
        }
        if (nearest) {
          const p = nearest.body.translation();
          const target = new THREE.Vector3(p.x, p.y, p.z);
          grab = {
            ball: nearest,
            last: target.clone(),
            velocity: new THREE.Vector3(),
            offset: target.sub(position),
          };
          nearest.body.setBodyType(
            this.rapier.RigidBodyType.KinematicPositionBased,
            true,
          );
          this.grabs.set(hand.id, grab);
        }
      }
      if (grab) {
        position.add(grab.offset);
        position.x = THREE.MathUtils.clamp(
          position.x,
          -5.55 + grab.ball.radius,
          5.55 - grab.ball.radius,
        );
        position.y = THREE.MathUtils.clamp(
          position.y,
          -2.98 + grab.ball.radius,
          2.98 - grab.ball.radius,
        );
        position.z = THREE.MathUtils.clamp(position.z, -1.3, 1.3);
        const velocity = position
          .clone()
          .sub(grab.last)
          .divideScalar(Math.max(dt, 0.001))
          .clampLength(0, 8);
        grab.velocity.lerp(velocity, 0.35);
        grab.last.copy(position);
        grab.ball.body.setNextKinematicTranslation(position);
      }
    }
    for (const id of this.grabs.keys()) if (!pinching.has(id)) this.release(id);
    this.previouslyPinching = pinching;
    this.world.timestep = dt;
    for (const ball of this.balls) {
      if (ball.body.isDynamic()) {
        const p = ball.body.translation();
        // A weak central force forms a bounded zero-gravity garden. Collision response
        // and every hand transfer of momentum are solved by Rapier at fixed dt.
        const mass = ball.body.mass();
        ball.body.resetForces(false);
        ball.body.addForce(
          {
            x: -p.x * 0.18 * mass,
            y: -p.y * 0.18 * mass,
            z: -p.z * 0.24 * mass,
          },
          true,
        );
      }
    }
    this.world.step();
    for (const material of this.materials)
      if (material.uniforms.uTime) material.uniforms.uTime.value = t;
    for (const ball of this.balls) {
      const p = ball.body.translation();
      ball.mesh.position.set(p.x, p.y, p.z);
      const q = ball.body.rotation();
      ball.mesh.quaternion.set(q.x, q.y, q.z, q.w);
      ball.halo.position.copy(ball.mesh.position);
      ball.halo.position.z -= 0.05;
      const maxTrail = Math.floor(8 + this.params.trail * 112);
      ball.history.unshift(new THREE.Vector3(p.x, p.y, p.z));
      if (ball.history.length > TRAIL_POINTS) ball.history.pop();
      const positions = ball.trail.geometry.getAttribute(
        "position",
      ) as THREE.BufferAttribute;
      const count = Math.min(maxTrail, ball.history.length);
      for (let i = 0; i < count; i++)
        positions.setXYZ(
          i,
          ball.history[i].x,
          ball.history[i].y,
          ball.history[i].z,
        );
      positions.needsUpdate = true;
      ball.trail.geometry.setDrawRange(0, count);
    }
  }

  setParams(params: VisualParams): void {
    this.params = { ...params };
    const colors = paletteColors(params);
    this.materials.forEach((material, i) => {
      const color = colors[Math.floor(i / 3) % 4];
      if (material.uniforms.uColor) material.uniforms.uColor.value.copy(color);
      if (material.uniforms.uSecond)
        material.uniforms.uSecond.value.copy(
          colors[(Math.floor(i / 3) + 1) % 4],
        );
      if (material.uniforms.uIntensity)
        material.uniforms.uIntensity.value = params.intensity;
      if (material.uniforms.uTrail)
        material.uniforms.uTrail.value = params.trail;
      if (material.uniforms.uSpeed)
        material.uniforms.uSpeed.value = params.speed;
      if (material.uniforms.uMaterial)
        material.uniforms.uMaterial.value =
          params.material === "silk" ? 0 : params.material === "glass" ? 1 : 2;
    });
    this.balls.forEach((ball) =>
      ball.halo.scale.setScalar(ball.radius * (5 + params.width * 3)),
    );
  }

  reset(seed: number): void {
    this.seed = seed;
    this.world?.free();
    disposeObject(this.contents);
    this.root.add(this.contents);
    this.balls = [];
    this.materials = [];
    this.grabs.clear();
    this.previouslyPinching.clear();
    this.time = 0;
    this.world = new this.rapier.World({ x: 0, y: 0, z: 0 });
    this.world.timestep = 1 / 60;
    const boundaries = [
      { p: [0, -3.18, 0], s: [6, 0.2, 2] },
      { p: [0, 3.18, 0], s: [6, 0.2, 2] },
      { p: [-5.85, 0, 0], s: [0.2, 3.4, 2] },
      { p: [5.85, 0, 0], s: [0.2, 3.4, 2] },
      { p: [0, 0, -1.8], s: [6, 3.4, 0.2] },
      { p: [0, 0, 1.8], s: [6, 3.4, 0.2] },
    ];
    for (const { p, s } of boundaries)
      this.world.createCollider(
        this.rapier.ColliderDesc.cuboid(s[0], s[1], s[2])
          .setTranslation(p[0], p[1], p[2])
          .setRestitution(0.8),
      );
    this.createVisuals();
  }

  dispose(): void {
    this.world.free();
    this.grabs.clear();
    this.balls = [];
    this.materials = [];
    disposeObject(this.root);
  }
}
