import type { InputSample, SceneId, SourceKind } from "../core/types";
export type Delegate = "GPU" | "CPU";
export type WorkerRequest =
  | { type: "init"; scene: SceneId; base: string; delegate: Delegate }
  | { type: "reset"; epoch: number }
  | {
      type: "frame";
      bitmap: ImageBitmap;
      timestampMs: number;
      sourceT: number;
      source: SourceKind;
      epoch: number;
    };
export type WorkerResponse =
  | { type: "ready"; delegate: Delegate }
  | { type: "result"; sample: InputSample; inferenceMs: number; epoch: number }
  | { type: "error"; message: string };
