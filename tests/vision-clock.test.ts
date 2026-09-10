import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VisionController } from "../src/vision/VisionController";
import type { WorkerRequest, WorkerResponse } from "../src/vision/protocol";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: WorkerRequest[] = [];
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: WorkerRequest) { this.messages.push(message); }
  respond(data: WorkerResponse) { this.onmessage?.({ data } as MessageEvent<WorkerResponse>); }
}
class FakeVideo extends EventTarget {
  srcObject: unknown; muted = false; playsInline = false; readyState = 2;
  videoWidth = 640; videoHeight = 360; seeking = false; currentTime = 0;
  callback?: VideoFrameRequestCallback;
  play = vi.fn(async () => {}); pause = vi.fn(); removeAttribute = vi.fn(); load = vi.fn();
  requestVideoFrameCallback(callback: VideoFrameRequestCallback) { this.callback = callback; return 1; }
  cancelVideoFrameCallback = vi.fn();
  frame(mediaTime: number) { this.currentTime = mediaTime; this.callback?.(now, { mediaTime } as VideoFrameCallbackMetadata); }
}
let now = 1000;
let controller: VisionController;
let video: FakeVideo;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => {
  now = 1000; FakeWorker.instances = []; video = new FakeVideo();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track], getVideoTracks: () => [track] })) } });
  vi.stubGlobal("location", { href: "http://localhost/" });
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
  controller = new VisionController(vi.fn(), vi.fn());
});
afterEach(() => { controller.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps camera observation clock origin before a slow model initialization", async () => {
  const opening = controller.startCamera("ribbon", video as unknown as HTMLVideoElement);
  await flush(); expect(controller.clockOriginSeconds).toBe(1);
  now = 7000; const worker = FakeWorker.instances[0]; worker.respond({ type: "ready", delegate: "GPU" });
  await opening; await flush();
  expect(controller.clockOriginSeconds).toBe(1);
  const frame = worker.messages.find(message => message.type === "frame");
  expect(frame).toMatchObject({ source: "camera", sourceT: 6 });
  // Starting a take at 7s subtracts exactly 6s from this unchanged camera clock.
  expect(frame?.type === "frame" ? frame.sourceT - (7 - controller.clockOriginSeconds) : NaN).toBe(0);
});

it("preserves the same source clock after GPU failure and CPU recovery", async () => {
  const opening = controller.startCamera("ribbon", video as unknown as HTMLVideoElement);
  await flush(); now = 5000;
  const gpu = FakeWorker.instances[0]; gpu.respond({ type: "ready", delegate: "GPU" }); await opening; await flush();
  gpu.onerror?.({ message: "GPU lost" } as ErrorEvent); await flush();
  now = 9000; const cpu = FakeWorker.instances[1]; cpu.respond({ type: "ready", delegate: "CPU" }); await flush();
  video.frame(3); await flush();
  expect(controller.clockOriginSeconds).toBe(1);
  expect(cpu.messages.find(message => message.type === "frame")).toMatchObject({ source: "camera", sourceT: 8 });
});

it("ignores a cold GPU frame, but falls back after sustained slow inference without resetting the camera clock", async () => {
  const opening = controller.startCamera("ribbon", video as unknown as HTMLVideoElement);
  await flush();
  const gpu = FakeWorker.instances[0];
  gpu.respond({ type: "ready", delegate: "GPU" });
  await opening; await flush();
  for (const [index, latency] of [9000, 500, 30, 450, 500].entries()) {
    if (index) { video.frame(index); await flush(); }
    const request = gpu.messages.filter(message => message.type === "frame").at(-1)!;
    now += latency;
    gpu.respond({ type: "result", epoch: request.epoch, inferenceMs: latency,
      sample: { source: "camera", t: request.sourceT, hands: [] } });
    await flush();
    expect(FakeWorker.instances).toHaveLength(index === 4 ? 2 : 1);
  }
  expect(gpu.terminate).toHaveBeenCalled();
  expect(FakeWorker.instances[1].messages[0]).toMatchObject({ type: "init", delegate: "CPU" });
  expect(controller.clockOriginSeconds).toBe(1);
});

it("calibrates the CPU replacement even if no more decoded callbacks arrive", async () => {
  const opening = controller.startCamera("ribbon", video as unknown as HTMLVideoElement);
  await flush();
  const gpu = FakeWorker.instances[0]; gpu.respond({ type: "ready", delegate: "GPU" });
  await opening; await flush();
  const request = gpu.messages.filter(message => message.type === "frame").at(-1)!;
  now = 7000;
  gpu.respond({ type: "result", epoch: request.epoch, inferenceMs: 6000,
    sample: { source: "camera", t: request.sourceT, hands: [] } });
  await flush();
  expect(FakeWorker.instances).toHaveLength(1);
  for (const time of [1, 2]) {
    video.frame(time); await flush();
    const current = gpu.messages.filter(message => message.type === "frame").at(-1)!;
    gpu.respond({ type: "result", epoch: current.epoch, inferenceMs: 800,
      sample: { source: "camera", t: current.sourceT, hands: [] } });
    await flush();
  }
  const cpu = FakeWorker.instances[1]; cpu.respond({ type: "ready", delegate: "CPU" });
  await flush();
  expect(cpu.messages.find(message => message.type === "frame")).toMatchObject({ source: "camera", sourceT: 6 });
  expect(controller.clockOriginSeconds).toBe(1);
});
