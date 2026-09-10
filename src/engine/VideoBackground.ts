import * as THREE from "three";
import type { InputSample } from "../core/types";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./common";

/** Fractions of the source image visible in the fixed 16:9 world. */
export interface VideoCover {
  uSpan: number;
  vSpan: number;
}

export function videoCover(width: number, height: number): VideoCover {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    return { uSpan: 1, vSpan: 1 };
  const ratio = (width / height) / (WORLD_WIDTH / WORLD_HEIGHT);
  return ratio > 1
    ? { uSpan: 1 / ratio, vSpan: 1 }
    : { uSpan: 1, vSpan: ratio };
}

/** Stored observations are already mirrored. Cropping must not mirror them again. */
export function coverInput(input: InputSample, cover: VideoCover): InputSample {
  if (cover.uSpan === 1 && cover.vSpan === 1) return input;
  return {
    ...input,
    hands: input.hands.map((hand) => ({
      ...hand,
      x: 0.5 + (hand.x - 0.5) / cover.uSpan,
      y: 0.5 + (hand.y - 0.5) / cover.vSpan,
    })),
  };
}

/** Owns one source texture. Scene switches reparent its quad instead of duplicating it. */
export class VideoBackground {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  cover: VideoCover = { uSpan: 1, vSpan: 1 };
  private texture: THREE.VideoTexture;
  private width = 0;
  private height = 0;
  private lastTime = -1;
  private hasFrame = false;

  constructor(readonly video: HTMLVideoElement) {
    this.texture = this.createTexture();
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_WIDTH, WORLD_HEIGHT),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        toneMapped: false,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.mesh.position.z = -8;
    this.mesh.renderOrder = -100;
    this.mesh.frustumCulled = false;
    this.update();
  }

  private createTexture(): THREE.VideoTexture {
    const texture = new THREE.VideoTexture(this.video);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    return texture;
  }

  update(): void {
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (width > 0 && height > 0 && (width !== this.width || height !== this.height)) {
      // Three.js video textures must be recreated when decoded dimensions change.
      if (this.width && this.height) {
        this.texture.dispose();
        this.texture = this.createTexture();
        this.mesh.material.map = this.texture;
        this.hasFrame = false;
        this.lastTime = -1;
      }
      this.width = width;
      this.height = height;
      this.cover = videoCover(width, height);
      // Mirror the source once, with a centered crop. Video UV y is bottom-up.
      this.texture.repeat.set(-this.cover.uSpan, this.cover.vSpan);
      this.texture.offset.set((1 + this.cover.uSpan) / 2, (1 - this.cover.vSpan) / 2);
      this.texture.updateMatrix();
    }
    const decoded = width > 0 && height > 0 && this.video.readyState >= 2;
    const firstDecodedFrame = decoded && !this.hasFrame;
    if (decoded) this.hasFrame = true;
    // Seeking can briefly return HAVE_METADATA; keep the last decoded frame
    // visible until the replacement is ready instead of flashing the clear color.
    this.mesh.visible = width > 0 && height > 0 && this.hasFrame;
    const manualUpdate = this.video.paused ||
      typeof this.video.requestVideoFrameCallback !== "function";
    if (decoded && (firstDecodedFrame ||
      (manualUpdate && this.video.currentTime !== this.lastTime))) {
      // Native VideoTexture callbacks schedule playing frames at decoded cadence.
      // Only first frames, paused seeks, and legacy browsers need manual uploads.
      this.texture.needsUpdate = true;
    }
    if (decoded) this.lastTime = this.video.currentTime;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.texture.dispose();
    this.mesh.material.dispose();
    this.mesh.geometry.dispose();
  }
}
