import type { InputSample, MaskFrame, SceneId } from "./types";
let cachedTick = -1;
let cachedMask: MaskFrame | undefined;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
function capsule(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: number,
) {
  const dx = bx - ax,
    dy = by - ay,
    p = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(x - ax - dx * p, y - ay - dy * p) - r;
}
/** Authored synthetic motion. Never presented as a real camera or a model prediction. */
export function demoSample(scene: SceneId, t: number): InputSample {
  if (scene === "portal") {
    const tick = Math.floor(t * 15);
    if (tick !== cachedTick || !cachedMask) {
      const w = 160,
        h = 90,
        data = new Uint8Array(w * h),
        time = tick / 15;
      const sway = Math.sin(time * 0.45) * 0.025,
        shoulder = 0.4;
      const leftY = 0.32 + Math.sin(time * 0.7) * 0.1,
        rightY = 0.31 + Math.cos(time * 0.6) * 0.12;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const u = x / w - sway,
            v = y / h;
          const head =
            (Math.hypot((u - 0.5) / 0.063, (v - 0.235) / 0.097) - 1) * 0.06;
          const body =
            (Math.hypot(
              (u - 0.5) / (0.115 - (v - 0.45) * 0.045),
              (v - 0.55) / 0.225,
            ) -
              1) *
            0.1;
          const neck = capsule(u, v, 0.5, 0.29, 0.5, 0.41, 0.04);
          const larm = Math.min(
            capsule(u, v, 0.411, shoulder, 0.32, 0.49, 0.033),
            capsule(u, v, 0.32, 0.49, 0.25, leftY, 0.028),
          );
          const rarm = Math.min(
            capsule(u, v, 0.589, shoulder, 0.68, 0.47, 0.033),
            capsule(u, v, 0.68, 0.47, 0.75, rightY, 0.028),
          );
          const legs = Math.min(
            capsule(u, v, 0.455, 0.7, 0.43, 1.03, 0.045),
            capsule(u, v, 0.545, 0.7, 0.575, 1.03, 0.045),
          );
          data[y * w + x] = Math.round(
            clamp(0.5 - Math.min(head, body, neck, larm, rarm, legs) / 0.012) *
              255,
          );
        }
      cachedTick = tick;
      cachedMask = { width: w, height: h, data };
    }
    return { t, hands: [], mask: cachedMask, source: "demo" };
  }
  if (scene === "gravity") {
    return {
      t,
      source: "demo",
      hands: [
        {
          id: "right",
          x: 0.5 + 0.29 * Math.sin(t * 0.72),
          y: 0.4 + 0.25 * Math.cos(t * 0.9),
          z: 0,
          pinch: t % 5 < 3.3,
          strength: 0.95,
        },
        {
          id: "left",
          x: 0.5 + 0.25 * Math.cos(t * 0.6),
          y: 0.48 + 0.26 * Math.sin(t * 0.7),
          z: 0,
          pinch: t % 7 < 3.9,
          strength: 0.92,
        },
      ],
    };
  }
  return {
    t,
    source: "demo",
    hands: [
      {
        id: "right",
        x: 0.5 + 0.27 * Math.sin(t * 0.75),
        y: 0.46 + 0.24 * Math.sin(t * 1.5 + 0.4),
        z: 0.22 * Math.cos(t * 0.7),
        pinch: t % 8 < 7.4,
        strength: 0.96,
      },
      {
        id: "left",
        x: 0.5 + 0.26 * Math.sin(t * 0.75 + Math.PI),
        y: 0.49 + 0.2 * Math.sin(t * 1.5 + 2.0),
        z: -0.22 * Math.cos(t * 0.7),
        pinch: t % 8 < 7.3,
        strength: 0.94,
      },
    ],
  };
}
