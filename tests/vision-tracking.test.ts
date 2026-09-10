import { describe, expect, it } from "vitest";
import {
  HandTracker,
  pinchRatio,
  quantizeMirroredMask,
  type RawHand,
} from "../src/vision/tracking";
import { makeLocalFetch } from "../src/vision/localFetch";

function hand(x: number, ratio = 0.2, handedness = "Left", scale = 1): RawHand {
  const palm = 0.1 * scale;
  const landmarks = Array.from({ length: 21 }, () => ({ x, y: 0.5, z: 0 }));
  landmarks[5].x = x - palm / 2;
  landmarks[17].x = x + palm / 2;
  landmarks[4].x = x - (ratio * palm) / 2;
  landmarks[8].x = x + (ratio * palm) / 2;
  return { landmarks, handedness, handednessScore: 0.95 };
}

describe("stable hand interaction", () => {
  it("normalizes pinch distance by palm size", () => {
    expect(pinchRatio(hand(0.5, 0.3).landmarks)).toBeCloseTo(
      pinchRatio(hand(0.5, 0.3, "Left", 2).landmarks),
    );
  });
  it("confirms edges and keeps a closed pinch through threshold jitter", () => {
    const tracker = new HandTracker();
    expect(tracker.update([hand(0.5)], 0)[0].pinch).toBe(false);
    expect(tracker.update([hand(0.5)], 20)[0].pinch).toBe(false);
    expect(tracker.update([hand(0.5)], 45)[0].pinch).toBe(true);
    expect(tracker.update([hand(0.5, 0.43)], 65)[0].pinch).toBe(true);
    expect(tracker.update([hand(0.5, 0.6)], 85)[0].pinch).toBe(true);
    expect(tracker.update([hand(0.5, 0.6)], 130)[0].pinch).toBe(false);
  });
  it("requires a fresh pinch after no-hand detection instead of reconnecting a stroke", () => {
    const tracker = new HandTracker();
    tracker.update([hand(0.5)], 0);
    expect(tracker.update([hand(0.5)], 50)[0].pinch).toBe(true);
    expect(tracker.update([], 75)).toEqual([]);
    expect(tracker.update([hand(0.5)], 100)[0].pinch).toBe(false);
    expect(tracker.update([hand(0.5)], 150)[0].pinch).toBe(true);
  });
  it("does not confuse a slow inference gap with an explicit missing-hand result", () => {
    const tracker = new HandTracker();
    expect(tracker.update([hand(0.5)], 0)[0].pinch).toBe(false);
    expect(tracker.update([hand(0.5)], 300)[0].pinch).toBe(true);
    expect(tracker.update([], 320)).toEqual([]);
    expect(tracker.update([hand(0.5)], 350)[0].pinch).toBe(false);
  });
  it("confirms and holds a pinch across measured 650 ms inference intervals", () => {
    const tracker = new HandTracker();
    expect(tracker.update([hand(0.5)], 0, 16 / 9, 650)[0].pinch).toBe(false);
    expect(tracker.update([hand(0.5)], 650, 16 / 9, 650)[0].pinch).toBe(true);
    // A stable held pinch still uses its original opening threshold.
    expect(tracker.update([hand(0.5, 0.43)], 1300, 16 / 9, 650)[0].pinch).toBe(true);
  });
  it("releases on an explicit empty result even with a slow measured inference", () => {
    const tracker = new HandTracker();
    tracker.update([hand(0.5)], 0, 16 / 9, 650);
    expect(tracker.update([hand(0.5)], 650, 16 / 9, 650)[0].pinch).toBe(true);
    expect(tracker.update([], 1300, 16 / 9, 650)).toEqual([]);
    expect(tracker.update([hand(0.5)], 1950, 16 / 9, 650)[0].pinch).toBe(false);
    expect(tracker.update([hand(0.5)], 2600, 16 / 9, 650)[0].pinch).toBe(true);
  });
  it("resets an unexplained long observation gap when measured inference is fast", () => {
    const tracker = new HandTracker();
    tracker.update([hand(0.5)], 0, 16 / 9, 12);
    expect(tracker.update([hand(0.5)], 50, 16 / 9, 12)[0].pinch).toBe(true);
    expect(tracker.update([hand(0.5)], 700, 16 / 9, 12)[0].pinch).toBe(false);
  });
  it("caps slow-inference association at 1500 ms", () => {
    const tracker = new HandTracker();
    tracker.update([hand(0.5)], 0, 16 / 9, 4000);
    expect(tracker.update([hand(0.5)], 1500, 16 / 9, 4000)[0].pinch).toBe(true);
    expect(tracker.update([hand(0.5)], 3001, 16 / 9, 4000)[0].pinch).toBe(false);
  });
  it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "keeps the original 600 ms bound with absent or invalid measurement %s",
    inferenceMs => {
      const tracker = new HandTracker();
      tracker.update([hand(0.5)], 0, 16 / 9, inferenceMs);
      expect(tracker.update([hand(0.5)], 50, 16 / 9, inferenceMs)[0].pinch).toBe(true);
      expect(tracker.update([hand(0.5)], 651, 16 / 9, inferenceMs)[0].pinch).toBe(false);
    },
  );
  it("mirrors x exactly once and limits depth to an artistic range", () => {
    const tracked = new HandTracker().update([hand(0.2)], 0)[0];
    expect(tracked.x).toBeCloseTo(0.8);
    expect(tracked.y).toBeCloseTo(0.5);
    expect(tracked.z).toBeGreaterThanOrEqual(-0.35);
    expect(tracked.z).toBeLessThanOrEqual(0.35);
  });
  it("keeps identities as hands cross and detector result order changes", () => {
    const tracker = new HandTracker();
    tracker.update([hand(0.3, 0.7, "Left"), hand(0.7, 0.7, "Right")], 0);
    tracker.update([hand(0.42, 0.7, "Left"), hand(0.58, 0.7, "Right")], 50);
    const crossed = tracker.update(
      [hand(0.46, 0.7, "Right"), hand(0.54, 0.7, "Left")],
      100,
    );
    expect(crossed.map((result) => result.id)).toEqual(["right", "left"]);
  });
  it("uses handedness only as an identity hint and rejects malformed landmarks", () => {
    const tracker = new HandTracker();
    const detected = hand(0.5);
    detected.handednessScore = 0.01;
    expect(tracker.update([detected], 0)).toHaveLength(1);
    detected.landmarks[8].x = NaN;
    expect(tracker.update([detected], 50)).toEqual([]);
  });
  it("clears pinch and smoothing on explicit reset or source-time reversal", () => {
    const tracker = new HandTracker();
    tracker.update([hand(0.5)], 0);
    tracker.update([hand(0.5)], 50);
    tracker.reset();
    expect(tracker.update([hand(0.2)], 60)[0]).toMatchObject({
      pinch: false,
      x: 0.8,
    });
    tracker.update([hand(0.2)], 110);
    expect(tracker.update([hand(0.8)], 10)[0]).toMatchObject({ pinch: false });
  });
  it("quantizes person probabilities and mirrors mask rows without mutating the input", () => {
    const source = new Float32Array([1, 0, 0.5, 0.25]);
    const mask = quantizeMirroredMask(source, 2, 2);
    expect([...mask.data]).toEqual([0, 255, 64, 128]);
    expect(mask.width).toBe(2);
    expect([...source]).toEqual([1, 0, 0.5, 0.25]);
  });
});

describe("local-only vision requests", () => {
  it("loads own model assets but rejects SDK telemetry before invoking the network", async () => {
    const requested: string[] = [];
    const network = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response("local");
    }) as typeof fetch;
    const localFetch = makeLocalFetch(
      "https://appleweiping.github.io",
      network,
    );
    await localFetch(
      "https://appleweiping.github.io/prism-stage/models/hand_landmarker.task",
    );
    await expect(
      localFetch("https://odml.pa.googleapis.com/v1/log", {
        method: "POST",
        body: "telemetry",
      }),
    ).rejects.toThrow("same-origin");
    await expect(
      localFetch(new Request("https://other.example/model.task")),
    ).rejects.toThrow("same-origin");
    expect(requested).toEqual([
      "https://appleweiping.github.io/prism-stage/models/hand_landmarker.task",
    ]);
  });
});
