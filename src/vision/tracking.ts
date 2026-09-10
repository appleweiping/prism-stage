import type { MaskFrame, TrackedHand } from "../core/types";

export interface Landmark {
  x: number;
  y: number;
  z?: number;
}
export interface RawHand {
  landmarks: Landmark[];
  handedness?: string;
  handednessScore?: number;
}
type HandId = TrackedHand["id"];
interface Track {
  id: HandId;
  wrist: Landmark;
  vx: number;
  vy: number;
  seen: number;
  output: TrackedHand;
  candidate: boolean | null;
  candidateSince: number;
  candidateFrames: number;
}
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const ids: HandId[] = ["left", "right"];

/** Palm-relative, aspect-correct distance; unlike handedness, this measures a gesture. */
export function pinchRatio(landmarks: Landmark[], aspect = 16 / 9): number {
  const distance = (a: Landmark, b: Landmark) =>
    Math.hypot(a.x - b.x, (a.y - b.y) / aspect);
  return (
    distance(landmarks[4], landmarks[8]) /
    Math.max(0.015, distance(landmarks[5], landmarks[17]))
  );
}

/** Small global association (two hands) with velocity prediction and handedness as a soft hint. */
export class HandTracker {
  private tracks = new Map<HandId, Track>();
  reset(): void {
    this.tracks.clear();
  }

  update(raw: RawHand[], timestampMs: number, aspect = 16 / 9): TrackedHand[] {
    const hands = raw
      .filter(
        (h) =>
          h.landmarks.length >= 21 &&
          h.landmarks.every(
            (p) =>
              Number.isFinite(p.x) &&
              Number.isFinite(p.y) &&
              (p.z === undefined || Number.isFinite(p.z)),
          ),
      )
      .slice(0, 2);
    for (const [id, track] of this.tracks) {
      // Frame skipping under load is not evidence of a missing hand. Explicit empty
      // detections release immediately below; retain association across slow inference.
      if (timestampMs < track.seen || timestampMs - track.seen > 600)
        this.tracks.delete(id);
    }
    const cost = (hand: RawHand, id: HandId): number => {
      const track = this.tracks.get(id);
      const label = hand.handedness?.toLowerCase();
      // Classification confidence is ONLY an association hint, never landmark confidence.
      const labelCost =
        label && label !== id ? 0.12 * (hand.handednessScore ?? 0.5) : 0;
      if (!track)
        return (
          labelCost +
          Math.abs(hand.landmarks[0].x - (id === "left" ? 0.7 : 0.3)) * 0.025
        );
      const dt = Math.min(0.08, Math.max(0, (timestampMs - track.seen) / 1000));
      return (
        Math.hypot(
          hand.landmarks[0].x - track.wrist.x - track.vx * dt,
          (hand.landmarks[0].y - track.wrist.y - track.vy * dt) / aspect,
        ) + labelCost
      );
    };
    let assignment: HandId[] = [];
    if (hands.length === 1)
      assignment = [
        cost(hands[0], "left") <= cost(hands[0], "right") ? "left" : "right",
      ];
    if (hands.length === 2)
      assignment =
        cost(hands[0], "left") + cost(hands[1], "right") <=
        cost(hands[0], "right") + cost(hands[1], "left")
          ? ["left", "right"]
          : ["right", "left"];
    for (const id of ids) {
      if (!assignment.includes(id)) {
        const absent = this.tracks.get(id);
        if (absent) {
          absent.output.pinch = false;
          absent.candidate = null;
          absent.candidateFrames = 0;
        }
      }
    }
    return hands.map((hand, index) => {
      const id = assignment[index];
      const lm = hand.landmarks;
      const ratio = pinchRatio(lm, aspect);
      const palm = Math.hypot(
        lm[5].x - lm[17].x,
        (lm[5].y - lm[17].y) / aspect,
      );
      const point = {
        x: clamp(1 - (lm[4].x + lm[8].x) / 2),
        y: clamp((lm[4].y + lm[8].y) / 2),
        z: clamp((0.13 - palm) * 3, -0.35, 0.35),
      };
      let track = this.tracks.get(id);
      if (!track) {
        track = {
          id,
          wrist: { ...lm[0] },
          vx: 0,
          vy: 0,
          seen: timestampMs,
          output: { id, ...point, pinch: false, strength: 0 },
          candidate: null,
          candidateSince: timestampMs,
          candidateFrames: 0,
        };
        this.tracks.set(id, track);
      }
      const dt = Math.max(
        1 / 120,
        Math.min(0.15, (timestampMs - track.seen) / 1000),
      );
      // Open/close thresholds deliberately differ; two frames and 40 ms confirm an edge.
      const desired = track.output.pinch ? ratio < 0.56 : ratio < 0.34;
      if (desired !== track.output.pinch) {
        if (track.candidate !== desired) {
          track.candidate = desired;
          track.candidateSince = timestampMs;
          track.candidateFrames = 1;
        } else track.candidateFrames++;
        if (
          timestampMs - track.candidateSince >= 40 &&
          track.candidateFrames >= 2
        ) {
          track.output.pinch = desired;
          track.candidate = null;
          track.candidateFrames = 0;
        }
      } else {
        track.candidate = null;
        track.candidateFrames = 0;
      }
      const alpha = 1 - Math.exp(-dt / 0.045);
      for (const axis of ["x", "y", "z"] as const)
        track.output[axis] += (point[axis] - track.output[axis]) * alpha;
      track.output.strength = clamp(1 - ratio / 0.75);
      track.vx =
        track.vx * 0.4 + clamp((lm[0].x - track.wrist.x) / dt, -3, 3) * 0.6;
      track.vy =
        track.vy * 0.4 + clamp((lm[0].y - track.wrist.y) / dt, -3, 3) * 0.6;
      track.wrist = { ...lm[0] };
      track.seen = timestampMs;
      return { ...track.output };
    });
  }
}

/** Copy before MediaPipe's callback ends, quantize probabilities, mirror exactly once. */
export function quantizeMirroredMask(
  source: Float32Array,
  width: number,
  height: number,
): MaskFrame {
  const outWidth = Math.min(256, width);
  const outHeight = Math.min(
    144,
    Math.max(1, Math.round((height * outWidth) / width)),
  );
  const data = new Uint8Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    const sy = Math.min(
      height - 1,
      Math.floor(((y + 0.5) * height) / outHeight),
    );
    for (let x = 0; x < outWidth; x++) {
      const sx =
        width -
        1 -
        Math.min(width - 1, Math.floor(((x + 0.5) * width) / outWidth));
      data[y * outWidth + x] = Math.round(clamp(source[sy * width + sx]) * 255);
    }
  }
  return { width: outWidth, height: outHeight, data };
}
