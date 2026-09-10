import * as THREE from "three";
import type {
  InputSample,
  MaskFrame,
  ScenePlugin,
  VisualParams,
} from "../core/types";
import {
  disposeObject,
  paletteColors,
  shaderOutput,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "./common";

export class PortalScene implements ScenePlugin {
  readonly id = "portal" as const;
  readonly root = new THREE.Group();
  private material: THREE.ShaderMaterial;
  private texture: THREE.DataTexture;
  private lastMask?: MaskFrame;

  constructor(scene: THREE.Scene, seed: number, params: VisualParams) {
    this.texture = this.newTexture(1, 1, new Uint8Array([0]));
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uMask: { value: this.texture },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uSeed: { value: (seed % 10000) / 1000 },
        uColors: { value: paletteColors(params) },
        uIntensity: { value: params.intensity },
        uFeather: { value: params.feather },
        uSpeed: { value: params.speed },
        uWidth: { value: params.width },
        uTrail: { value: params.trail },
        uMaterial: { value: 0 },
      },
      vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `
        varying vec2 vUv;uniform sampler2D uMask;uniform vec2 uTexel;uniform vec3 uColors[4];
        uniform float uTime,uSeed,uIntensity,uFeather,uSpeed,uWidth,uTrail,uMaterial;
        float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
        float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
        float fbm(vec2 p){float n=0.;float a=.5;for(int i=0;i<4;i++){n+=noise(p)*a;p=mat2(.8,-.6,.6,.8)*p*2.03+3.7;a*=.5;}return n;}
        float mask(vec2 uv){return texture2D(uMask,clamp(uv,vec2(.001),vec2(.999))).r;}
        void main(){
          // Mask storage is top-to-bottom in mirrored image coordinates.
          vec2 maskUv=vec2(vUv.x,1.-vUv.y);
          vec2 texel=uTexel*(.35+uFeather*1.15);
          float center=mask(maskUv);
          float a=mask(maskUv+vec2(texel.x,0.));float b=mask(maskUv-vec2(texel.x,0.));
          float c=mask(maskUv+vec2(0.,texel.y));float d=mask(maskUv-vec2(0.,texel.y));
          float blurred=(center*4.+a+b+c+d)/8.;
          float silhouette=smoothstep(.42-uFeather*.22,.58+uFeather*.22,blurred);
          float edge=pow(max(0.,1.-abs(blurred-.5)*2.),3.);
          float outer=max(max(a,b),max(c,d))-center;
          if(silhouette+edge+outer<.002)discard;
          vec2 p=(vUv-.5)*vec2(1.77778,1.);
          float time=uTime*(.045+uSpeed*.15);
          vec2 warp=vec2(fbm(p*3.5+vec2(time,uSeed)),fbm(p*3.5-vec2(time*.7,uSeed)));
          vec2 q=p+warp*.35;
          float angle=atan(q.y,q.x);
          float radius=length(q*vec2(.85,1.1));
          float tide=radius*(23.+uWidth*24.)-angle*.65-time*3.8+fbm(q*5.)*4.;
          float band=.5+.5*sin(tide);
          float filaments=pow(band,14.);
          float ridges=pow(.5+.5*sin(tide*2.05+warp.x*2.),22.);
          float nebula=fbm(q*7.-time*.35);
          vec3 color=mix(uColors[2]*.13,uColors[1]*.55,smoothstep(.22,.82,nebula));
          color=mix(color,uColors[3]*.45,smoothstep(.4,.9,warp.y));
          color+=mix(uColors[0],uColors[1],band)*filaments*(.33+uTrail*.65);
          color+=uColors[3]*ridges*.16;
          vec2 cells=floor((p+warp*.006)*340.);
          float sparkle=step(.998,hash(cells))*pow(max(0.,1.-length(fract((p+warp*.006)*340.)-.5)*2.),4.);
          color+=vec3(.82,.95,1.)*sparkle*.65;
          color*=.6+.4*smoothstep(.7,0.,length(p));
          if(uMaterial>.5&&uMaterial<1.5)color=mix(color,color.bgr,.23)+filaments*.08;
          if(uMaterial>1.5)color*=1.3;
          color+=mix(uColors[0],uColors[1],vUv.y)*edge*(.45+uIntensity*.25);
          color+=uColors[1]*outer*.12;
          float alpha=clamp(silhouette+edge*.28+outer*.22,0.,1.);
          gl_FragColor=vec4(color*uIntensity,alpha);
          ${shaderOutput}
        }`,
    });
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_WIDTH, WORLD_HEIGHT),
      this.material,
    );
    this.root.add(mesh);
    scene.add(this.root);
    this.setParams(params);
  }

  private newTexture(
    width: number,
    height: number,
    data: Uint8Array,
  ): THREE.DataTexture {
    const texture = new THREE.DataTexture(
      data,
      width,
      height,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    return texture;
  }

  update(_dt: number, t: number, input: InputSample): void {
    this.material.uniforms.uTime.value = t;
    const mask = input.mask;
    if (
      mask &&
      mask !== this.lastMask &&
      mask.width * mask.height === mask.data.length
    ) {
      if (
        this.texture.image.width !== mask.width ||
        this.texture.image.height !== mask.height
      ) {
        this.texture.dispose();
        this.texture = this.newTexture(
          mask.width,
          mask.height,
          new Uint8Array(mask.data),
        );
        this.material.uniforms.uMask.value = this.texture;
        this.material.uniforms.uTexel.value.set(
          1 / mask.width,
          1 / mask.height,
        );
      } else {
        (this.texture.image.data as Uint8Array).set(mask.data);
        this.texture.needsUpdate = true;
      }
      this.lastMask = mask;
    } else if (!mask && this.lastMask) {
      (this.texture.image.data as Uint8Array).fill(0);
      this.texture.needsUpdate = true;
      this.lastMask = undefined;
    }
  }

  setParams(params: VisualParams): void {
    this.material.uniforms.uColors.value = paletteColors(params);
    this.material.uniforms.uIntensity.value = params.intensity;
    this.material.uniforms.uFeather.value = params.feather;
    this.material.uniforms.uSpeed.value = params.speed;
    this.material.uniforms.uWidth.value = params.width;
    this.material.uniforms.uTrail.value = params.trail;
    this.material.uniforms.uMaterial.value =
      params.material === "silk" ? 0 : params.material === "glass" ? 1 : 2;
  }

  reset(seed: number): void {
    (this.texture.image.data as Uint8Array).fill(0);
    this.texture.needsUpdate = true;
    this.lastMask = undefined;
    this.material.uniforms.uTime.value = 0;
    this.material.uniforms.uSeed.value = (seed % 10000) / 1000;
  }

  dispose(): void {
    disposeObject(this.root);
  }
}
