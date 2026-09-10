import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createStage } from "../src/engine/StageEngine";
import { coverInput, videoCover, VideoBackground } from "../src/engine/VideoBackground";
import { handPosition } from "../src/engine/common";
import { DEFAULT_PARAMS } from "../src/core/presets";
import type { InputSample } from "../src/core/types";

const renderer = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("three", async () => {
  const actual = await vi.importActual<typeof import("three")>("three");
  return {
    ...actual,
    WebGLRenderer: class {
      render = renderer.render;
      setPixelRatio = vi.fn();
      setClearColor = vi.fn();
      setSize = vi.fn();
      dispose = vi.fn();
      renderLists = { dispose: vi.fn() };
      info = { render: { calls: 0 }, memory: { geometries: 0, textures: 0 } };
    },
  };
});

function videoFixture(width = 640, height = 480) {
  const pending = new Set<number>();
  let nextId = 0;
  const video = {
    videoWidth: width,
    videoHeight: height,
    readyState: 2,
    currentTime: 0,
    paused: true,
    requestVideoFrameCallback: vi.fn((_callback: () => void) => {
      pending.add(++nextId);
      return nextId;
    }),
    cancelVideoFrameCallback: vi.fn((id: number) => pending.delete(id)),
  };
  return { video: video as unknown as HTMLVideoElement, data: video, pending };
}

const sample: InputSample = {
  t: 0,
  source: "video",
  hands: [{ id: "left", x: 0.25, y: 0.25, z: 0, pinch: true, strength: 1 }],
};

function lastScene(): THREE.Scene {
  return renderer.render.mock.calls.at(-1)![0] as THREE.Scene;
}

function ribbonCenter(): number[] {
  let positions: THREE.BufferAttribute | undefined;
  lastScene().traverse((object) => {
    if (object instanceof THREE.Mesh && object.geometry.getAttribute("birth"))
      positions = object.geometry.getAttribute("position");
  });
  return [0, 1, 2].map((axis) =>
    Array.from({ length: 10 }, (_, index) => positions!.array[index * 3 + axis])
      .reduce((sum, value) => sum + value, 0) / 10,
  );
}

describe("source video composition and input anchoring", () => {
  it("uses centered cover rather than stretching portrait or ultrawide inputs", () => {
    expect(videoCover(1920, 1080)).toEqual({ uSpan: 1, vSpan: 1 });
    expect(videoCover(640, 480)).toEqual({ uSpan: 1, vSpan: 0.75 });
    expect(videoCover(0, 0)).toEqual({ uSpan: 1, vSpan: 1 });
    expect(videoCover(1080, 1920).vSpan).toBeCloseTo(81 / 256, 12);
    expect(videoCover(2520, 1080).uSpan).toBeCloseTo(16 / 21, 12);

    const mask = { width: 1, height: 1, data: new Uint8Array([255]) };
    const original = { ...sample, mask };
    const transformed = coverInput(original, videoCover(640, 480));
    expect(transformed.hands[0].y).toBeCloseTo(1 / 6, 12);
    expect(transformed.hands[0].x).toBe(0.25);
    expect(original.hands[0].y).toBe(0.25);
    expect(transformed.mask).toBe(mask);
    handPosition(transformed.hands[0]).toArray().forEach((coordinate, axis) =>
      expect(coordinate).toBeCloseTo([-3, 2.25, 0][axis], 12),
    );
  });

  it("projects an already-mirrored hand onto the same cropped source pixel", () => {
    const fixture = videoFixture(2520, 1080);
    const background = new VideoBackground(fixture.video);
    const texture = background.mesh.material.map!;
    const moved = coverInput(sample, background.cover).hands[0];
    // Quad UV y is bottom-up; transformUv includes the upload's flip into source rows.
    const rawSourceUv = texture.transformUv(new THREE.Vector2(moved.x, 1 - moved.y));
    expect(rawSourceUv.x).toBeCloseTo(1 - sample.hands[0].x, 12);
    expect(rawSourceUv.y).toBeCloseTo(sample.hands[0].y, 12);
    expect(background.mesh.material.toneMapped).toBe(false);
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(background.mesh.material.depthWrite).toBe(false);
    background.dispose();
    expect(fixture.pending.size).toBe(0);
  });

  it("replaces changing video dimensions and releases every texture callback", () => {
    const fixture = videoFixture();
    const background = new VideoBackground(fixture.video);
    const original = background.mesh.material.map!;
    const disposed = vi.fn();
    original.addEventListener("dispose", disposed);
    fixture.data.videoWidth = 1920;
    fixture.data.videoHeight = 1080;
    background.update();
    expect(disposed).toHaveBeenCalledOnce();
    expect(background.mesh.material.map).not.toBe(original);
    expect(background.cover).toEqual({ uSpan: 1, vSpan: 1 });
    expect(fixture.pending.size).toBe(1);
    background.dispose();
    expect(fixture.pending.size).toBe(0);
  });

  it("holds the last decoded background while a paused video seek is pending", () => {
    const fixture = videoFixture();
    const background = new VideoBackground(fixture.video);
    const texture = background.mesh.material.map!;
    const uploadedVersion = texture.version;
    fixture.data.readyState = 1;
    fixture.data.currentTime = 3;
    background.update();
    expect(background.mesh.visible).toBe(true);
    expect(texture.version).toBe(uploadedVersion);
    fixture.data.readyState = 2;
    background.update();
    expect(texture.version).toBeGreaterThan(uploadedVersion);
    background.dispose();
  });

  it("uses native decoded-frame cadence while playing and manually refreshes a paused seek", () => {
    const fixture = videoFixture();
    fixture.data.paused = false;
    const background = new VideoBackground(fixture.video);
    const texture = background.mesh.material.map!;
    const firstVersion = texture.version;
    expect(firstVersion).toBeGreaterThan(0);
    fixture.data.currentTime = 0.01;
    background.update();
    fixture.data.currentTime = 0.02;
    background.update();
    expect(texture.version).toBe(firstVersion);
    const nativeFrame = fixture.data.requestVideoFrameCallback.mock.calls[0][0];
    nativeFrame();
    expect(texture.version).toBe(firstVersion + 1);
    fixture.data.paused = true;
    fixture.data.currentTime = 2;
    background.update();
    expect(texture.version).toBe(firstVersion + 2);
    background.update();
    expect(texture.version).toBe(firstVersion + 2);
    background.dispose();
  });

  it("refreshes changed playing frames when native video callbacks are unavailable", () => {
    const fixture = videoFixture();
    fixture.data.paused = false;
    Reflect.deleteProperty(fixture.video, "requestVideoFrameCallback");
    const background = new VideoBackground(fixture.video);
    const texture = background.mesh.material.map!;
    const firstVersion = texture.version;
    fixture.data.currentTime = 0.04;
    background.update();
    expect(texture.version).toBe(firstVersion + 1);
    background.dispose();
  });

  it("keeps input geometry unchanged when hiding source footage or cropping output to portrait", async () => {
    const stage = await createStage({ clientWidth: 1280, clientHeight: 720 } as HTMLCanvasElement);
    await stage.switchScene("ribbon", 42, DEFAULT_PARAMS);
    const fixture = videoFixture();
    stage.setInputSourceSize!(640, 480);
    stage.setVideoBackground!(fixture.video);
    stage.step(1 / 60, 0, sample);
    stage.render();
    const videoCenter = ribbonCenter();
    expect(videoCenter[1]).toBeCloseTo(2.25, 6);
    stage.setVideoBackground!(null);
    stage.resize(720, 1280);
    stage.reset(42);
    stage.step(1 / 60, 0, sample);
    stage.render();
    expect(ribbonCenter()).toEqual(videoCenter);
    const camera = renderer.render.mock.calls.at(-1)![1] as THREE.OrthographicCamera;
    expect(camera.top - camera.bottom).toBe(6.75);
    expect(camera.right - camera.left).toBeCloseTo(6.75 * 9 / 16, 12);
    stage.setInputSourceSize!(0, 0);
    stage.reset(42);
    stage.step(1 / 60, 0, sample);
    stage.render();
    expect(ribbonCenter()[1]).toBeCloseTo(1.6875, 6);
    stage.dispose();
  });

  it("retains one video surface across repeated scene switches and shares its crop with the mask", async () => {
    const stage = await createStage({ clientWidth: 1280, clientHeight: 720 } as HTMLCanvasElement);
    const fixture = videoFixture();
    stage.setVideoBackground!(fixture.video);
    for (let index = 0; index < 20; index++) {
      await stage.switchScene(index % 2 ? "portal" : "ribbon", 42, DEFAULT_PARAMS);
      const scene = lastScene();
      const videos = scene.children.filter((object) =>
        object instanceof THREE.Mesh && object.material instanceof THREE.MeshBasicMaterial && object.material.map instanceof THREE.VideoTexture,
      );
      expect(videos).toHaveLength(1);
      expect(fixture.pending.size).toBe(1);
      expect(scene.children.filter((object) => object instanceof THREE.Group && !object.visible)).toHaveLength(1);
    }
    let crop: THREE.Vector2 | undefined;
    lastScene().traverse((object) => {
      if (object instanceof THREE.Mesh && object.material instanceof THREE.ShaderMaterial && object.material.uniforms.uSourceCrop)
        crop = object.material.uniforms.uSourceCrop.value;
    });
    expect(crop?.toArray()).toEqual([1, 0.75]);
    stage.setVideoBackground!(null);
    expect(crop?.toArray()).toEqual([1, 0.75]);
    expect(fixture.pending.size).toBe(0);
    stage.setInputSourceSize!(0, 0);
    expect(crop?.toArray()).toEqual([1, 1]);
    stage.dispose();
  });
});
