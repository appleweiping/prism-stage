import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { DEFAULT_PARAMS } from "../src/core/presets";
import type { InputSample } from "../src/core/types";
import { RibbonScene } from "../src/engine/RibbonScene";
import { GravityScene } from "../src/engine/GravityScene";
import { PortalScene } from "../src/engine/PortalScene";
import { handPosition, seededRandom } from "../src/engine/common";

const input = (frame: number, pinch = true, x = 0.4): InputSample => ({
  t: frame / 60,
  source: "replay",
  hands: [{ id: "left", x, y: 0.5, z: 0, pinch, strength: 1 }],
});

function ribbonGeometry(plugin: RibbonScene): THREE.BufferGeometry[] {
  return plugin.root.children
    .filter(
      (child) =>
        child instanceof THREE.Mesh && child.geometry.getAttribute("birth"),
    )
    .map((child) => (child as THREE.Mesh).geometry);
}

describe("stage input and deterministic replay", () => {
  it("uses mirrored image coordinates once and keeps depth bounded", () => {
    const point = handPosition({
      id: "left",
      x: 0,
      y: 0,
      z: 50,
      pinch: false,
      strength: 0,
    });
    expect(point.toArray()).toEqual([-6, 3.375, -1.15]);
    const a = seededRandom(42),
      b = seededRandom(42);
    expect(Array.from({ length: 20 }, a)).toEqual(
      Array.from({ length: 20 }, b),
    );
  });

  it("replays ribbons identically, ends strokes on lost hands, and applies undo once", () => {
    const scene = new THREE.Scene();
    const ribbon = new RibbonScene(scene, 42, DEFAULT_PARAMS);
    const samples = Array.from({ length: 40 }, (_, frame) =>
      input(frame, true, 0.3 + frame * 0.005),
    );
    for (const sample of samples) ribbon.update(1 / 60, sample.t, sample);
    const first = Array.from(
      ribbonGeometry(ribbon)[0].getAttribute("position").array,
    );
    ribbon.reset(42);
    for (const sample of samples) ribbon.update(1 / 60, sample.t, sample);
    expect(
      Array.from(ribbonGeometry(ribbon)[0].getAttribute("position").array),
    ).toEqual(first);
    ribbon.update(1 / 60, 1, { t: 1, source: "replay", hands: [] });
    ribbon.update(1 / 60, 1.1, input(66, true, 0.7));
    ribbon.update(1 / 60, 1.2, input(72, true, 0.72));
    expect(ribbonGeometry(ribbon)).toHaveLength(2);
    const undo: InputSample = {
      t: 1.3,
      source: "replay",
      hands: [],
      undoCount: 1,
    };
    ribbon.update(1 / 60, 1.3, undo);
    ribbon.update(1 / 60, 1.4, undo);
    expect(ribbonGeometry(ribbon)).toHaveLength(1);
    ribbon.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it("changes ribbon appearance without changing recorded centerline", () => {
    const ribbon = new RibbonScene(new THREE.Scene(), 42, DEFAULT_PARAMS);
    for (let frame = 0; frame < 40; frame++)
      ribbon.update(
        1 / 60,
        frame / 60,
        input(frame, true, 0.3 + frame * 0.005),
      );
    const geometry = ribbonGeometry(ribbon)[0];
    const before = Array.from(geometry.getAttribute("position").array);
    ribbon.setParams({ ...DEFAULT_PARAMS, width: 1 });
    const after = Array.from(geometry.getAttribute("position").array);
    expect(after).not.toEqual(before);
    const centroid = (data: number[]) =>
      [0, 1, 2].map(
        (axis) =>
          Array.from(
            { length: 10 },
            (_, j) => data[(10 + j) * 3 + axis],
          ).reduce((a, b) => a + b, 0) / 10,
      );
    centroid(after).forEach((coordinate, axis) =>
      expect(coordinate).toBeCloseTo(centroid(before)[axis], 6),
    );
    ribbon.dispose();
  });

  it("has identical Rapier state after reset and after appearance changes during replay", async () => {
    const scene = new THREE.Scene();
    const gravity = await GravityScene.create(scene, 1234, DEFAULT_PARAMS);
    const snapshot = () =>
      gravity.root.children[0].children
        .filter(
          (child) =>
            child instanceof THREE.Mesh &&
            child.geometry instanceof THREE.SphereGeometry,
        )
        .map((child) => child.position.toArray());
    const initial = snapshot();
    const target = initial[0];
    const samples: InputSample[] = Array.from({ length: 180 }, (_, frame) => ({
      t: frame / 60,
      source: "replay",
      hands:
        frame < 50
          ? [
              {
                id: "left",
                x: 0.5 + (target[0] + frame * 0.016) / 12,
                y: 0.5 - target[1] / 6.75,
                z: 0,
                pinch: true,
                strength: 1,
              },
            ]
          : [],
    }));
    for (const sample of samples) gravity.update(1 / 60, sample.t, sample);
    const first = snapshot();
    expect(first).not.toEqual(initial);
    gravity.reset(1234);
    expect(snapshot()).toEqual(initial);
    for (const sample of samples) {
      if (sample.t > 1)
        gravity.setParams({
          ...DEFAULT_PARAMS,
          width: 1,
          palette: "ember",
          speed: 1.2,
          material: "neon",
        });
      gravity.update(1 / 60, sample.t, sample);
    }
    expect(snapshot()).toEqual(first);
    expect(
      first.every(
        ([x, y, z]) =>
          Math.abs(x) < 5.7 && Math.abs(y) < 3.1 && Math.abs(z) < 1.7,
      ),
    ).toBe(true);
    gravity.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it("owns its mask copy and clears missing masks without flipping stored rows", () => {
    const scene = new THREE.Scene();
    const portal = new PortalScene(scene, 3, DEFAULT_PARAMS);
    const material = (
      portal.root.children[0] as THREE.Mesh<
        THREE.BufferGeometry,
        THREE.ShaderMaterial
      >
    ).material;
    const mask = {
      width: 2,
      height: 2,
      data: new Uint8Array([10, 20, 30, 255]),
    };
    portal.update(1 / 60, 1, { t: 1, source: "replay", hands: [], mask });
    const texture = material.uniforms.uMask.value as THREE.DataTexture;
    expect(Array.from(texture.image.data)).toEqual([10, 20, 30, 255]);
    mask.data.fill(0);
    expect(Array.from(texture.image.data)).toEqual([10, 20, 30, 255]);
    portal.update(1 / 60, 2, { t: 2, source: "replay", hands: [] });
    expect(Array.from(texture.image.data)).toEqual([0, 0, 0, 0]);
    portal.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
