import {
  FilesetResolver,
  HandLandmarker,
  ImageSegmenter,
} from "@mediapipe/tasks-vision";
import { HandTracker, quantizeMirroredMask } from "./tracking";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import type { InputSample } from "../core/types";
import { makeLocalFetch } from "./localFetch";

// Tasks Vision 1.0.1 includes a periodic usage logger. Block it before task creation;
// neither video pixels nor usage telemetry may leave this local-only studio.
self.fetch = makeLocalFetch(self.location.origin, self.fetch.bind(self));

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void;
};
let hands: HandLandmarker | undefined;
let segmenter: ImageSegmenter | undefined;
let initializing = false;
const tracker = new HandTracker();
const send = (data: WorkerResponse, transfer: Transferable[] = []) =>
  scope.postMessage(data, transfer);

async function initialize(
  message: Extract<WorkerRequest, { type: "init" }>,
): Promise<void> {
  if (initializing) return;
  initializing = true;
  try {
    // The module fileset is required by MediaPipe 1.0.1 inside a Vite module Worker.
    const fileset = await FilesetResolver.forVisionTasks(
      // Resolver appends its own slash. Duplicate slashes bypass exact offline cache keys.
      new URL("wasm", message.base).href,
      true,
    );
    const canvas = new OffscreenCanvas(640, 360);
    if (message.scene === "portal") {
      segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: new URL(
            "models/selfie_segmenter_landscape.tflite",
            message.base,
          ).href,
          delegate: message.delegate,
        },
        canvas,
        runningMode: "VIDEO",
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
    } else {
      hands = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: new URL("models/hand_landmarker.task", message.base)
            .href,
          delegate: message.delegate,
        },
        canvas,
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.5,
      });
    }
    send({ type: "ready", delegate: message.delegate });
  } catch (error) {
    send({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    initializing = false;
  }
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "init") {
    void initialize(message);
    return;
  }
  if (message.type === "reset") {
    tracker.reset();
    return;
  }
  const started = performance.now();
  try {
    const sample: InputSample = {
      t: message.sourceT,
      hands: [],
      source: message.source,
    };
    if (hands) {
      const result = hands.detectForVideo(message.bitmap, message.timestampMs);
      sample.hands = tracker.update(
        result.landmarks.map((landmarks, index) => ({
          landmarks,
          handedness: result.handedness[index]?.[0]?.categoryName,
          handednessScore: result.handedness[index]?.[0]?.score,
        })),
        message.timestampMs,
        message.bitmap.width / message.bitmap.height,
      );
    } else if (segmenter) {
      segmenter.segmentForVideo(
        message.bitmap,
        message.timestampMs,
        (result) => {
          // The selfie model uses one person-probability tensor. Two-channel variants expose it at index 1.
          const mask =
            result.confidenceMasks?.[1] ?? result.confidenceMasks?.[0];
          if (!mask)
            throw new Error("The segmentation model returned no person mask.");
          sample.mask = quantizeMirroredMask(
            mask.getAsFloat32Array(),
            mask.width,
            mask.height,
          );
          // Callback-owned MediaPipe masks are released automatically on callback return.
        },
      );
    } else throw new Error("Vision model is not ready.");
    send(
      {
        type: "result",
        sample,
        inferenceMs: performance.now() - started,
        epoch: message.epoch,
      },
      sample.mask ? [sample.mask.data.buffer as ArrayBuffer] : [],
    );
  } catch (error) {
    send({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    message.bitmap.close();
  }
};
