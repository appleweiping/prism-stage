import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InputSample,
  PrismProject,
  StageEngine,
  VisualParams,
} from "../src/core/types";
import { DEFAULT_PARAMS } from "../src/core/presets";
import { StudioRuntime } from "../src/core/StudioRuntime";

const mocks = vi.hoisted(() => ({
  stage: undefined as unknown as StageEngine,
  preparation: undefined as Promise<void> | undefined,
  vision: undefined as unknown as {
    startCamera: ReturnType<typeof vi.fn>;
    startVideo: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    emit: (sample: InputSample) => void;
    status: (status: { state: string; message: string }) => void;
  },
  recorder: undefined as unknown as {
    start: ReturnType<typeof vi.fn>;
    captureFrame: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    onError?: (message: string) => void;
  },
}));

vi.mock("../src/engine/StageEngine", () => ({
  createStage: vi.fn(async () => mocks.stage),
}));
vi.mock("../src/vision/VisionController", () => ({
  VisionController: class {
    startCamera: ReturnType<typeof vi.fn>;
    startVideo: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    constructor(
      public emit: (sample: InputSample) => void,
      public status: (status: { state: string; message: string }) => void,
    ) {
      this.startCamera = vi.fn(async () =>
        status({ state: "ready", message: "Camera ready" }),
      );
      this.startVideo = vi.fn(async () =>
        status({ state: "ready", message: "Video ready" }),
      );
      this.stop = vi.fn(() =>
        status({ state: "idle", message: "Input stopped" }),
      );
      this.dispose = vi.fn();
      mocks.vision = this;
    }
  },
}));
vi.mock("../src/export/recorder", () => ({
  CanvasRecorder: class {
    extension = "webm";
    onError?: (message: string) => void;
    start = vi.fn(async (onError?: (message: string) => void) => {
      this.onError = onError;
      await mocks.preparation;
    });
    captureFrame = vi.fn();
    stop = vi.fn(
      async () => new Blob(["encoder fixture"], { type: "video/webm" }),
    );
    cancel = vi.fn();
    constructor() {
      mocks.recorder = this;
    }
  },
}));
vi.mock("../src/core/demo", () => ({
  demoSample: (_scene: string, t: number): InputSample => ({
    t,
    source: "demo",
    hands: [
      {
        id: "left",
        x: 0.5 + Math.sin(t) * 0.2,
        y: 0.5,
        z: 0,
        pinch: true,
        strength: 1,
      },
    ],
  }),
}));

class FakeVideo extends EventTarget {
  currentTime = 0;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
}
let runtime: StudioRuntime;
let video: FakeVideo;
let canvas: HTMLCanvasElement;
let rafId: number;
let callbacks: Map<number, FrameRequestCallback>;
let wall: number;
let events: string[];

function frame(elapsed = 1000 / 60) {
  wall += elapsed;
  const pending = [...callbacks.values()];
  callbacks.clear();
  for (const callback of pending) callback(wall);
}
function advance(seconds: number) {
  for (let i = 0; i < Math.ceil(seconds * 100); i++) frame(10);
}
function sample(t = 0, pinch = true): InputSample {
  return {
    t,
    source: "video",
    hands: [
      { id: "left", x: 0.5, y: 0.5, z: 0, pinch, strength: pinch ? 1 : 0 },
    ],
  };
}
function project(
  id = "runtime-project",
  scene: "ribbon" | "gravity" | "portal" = "ribbon",
): PrismProject {
  return {
    manifest: {
      format: "prism-stage",
      version: 1,
      engineVersion: "1.0.0",
      id,
      name: id,
      scene,
      createdAt: "2026-09-10T12:00:00.000Z",
      seed: 1234,
      fixedDt: 1 / 60,
      duration: 1,
      params: { ...DEFAULT_PARAMS },
      trim: { start: 0, end: 1 },
      aspect: "landscape",
      source: "video",
    },
    samples: Array.from({ length: 60 }, (_, index) =>
      sample(index / 60, index < 30),
    ),
  };
}
function normalizedSteps() {
  return vi.mocked(mocks.stage.step).mock.calls.map(([dt, t, input]) => ({
    dt,
    t: +t.toFixed(8),
    inputT: +input.t.toFixed(8),
    hands: input.hands.map((hand) => ({ ...hand, x: +hand.x.toFixed(8) })),
    undoCount: input.undoCount ?? 0,
  }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  mocks.preparation = undefined;
  callbacks = new Map();
  rafId = 0;
  wall = 1000;
  events = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++rafId, callback);
    return rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toDataURL: () => "data:image/png;base64,thumbnail-fixture",
    }),
  });
  mocks.stage = {
    switchScene: vi.fn(async () => undefined),
    step: vi.fn(),
    render: vi.fn(() => events.push("render")),
    resize: vi.fn(),
    reset: vi.fn(),
    undo: vi.fn(),
    setParams: vi.fn((params: VisualParams) =>
      events.push(`quality:${params.quality}`),
    ),
    getStats: vi.fn(() => ({
      objects: 0,
      quality: "High",
      drawCalls: 1,
      geometries: 1,
      textures: 0,
    })),
    dispose: vi.fn(),
  };
  video = new FakeVideo();
  canvas = {
    width: 1280,
    height: 720,
    toBlob: vi.fn((callback: BlobCallback) => {
      events.push("encode");
      queueMicrotask(() =>
        callback(new Blob(["png fixture"], { type: "image/png" })),
      );
    }),
  } as unknown as HTMLCanvasElement;
  runtime = new StudioRuntime(
    canvas,
    video as unknown as HTMLVideoElement,
    vi.fn(),
  );
  await runtime.init();
  frame(0); // Establish the RAF clock before each behavior under test.
  vi.clearAllMocks();
  events = [];
});
afterEach(() => {
  runtime.dispose();
  vi.unstubAllGlobals();
});

describe("runtime recording and fixed-step replay", () => {
  it("snaps a rounded frame timestamp to one simulation step rather than two", async () => {
    await runtime.load(project());
    vi.mocked(mocks.stage.step).mockClear();
    runtime.seek(0.016667);
    expect(mocks.stage.step).toHaveBeenCalledTimes(1);
    expect(runtime.state.time).toBeCloseTo(1 / 60, 10);
    expect(mocks.stage.step).toHaveBeenCalledWith(
      1 / 60,
      0,
      expect.objectContaining({ t: 0 }),
    );
  });
  it("reconstructs the same fixed steps from zero and from a rounded seek followed by replay", async () => {
    await runtime.load(project());
    vi.mocked(mocks.stage.step).mockClear();
    runtime.seek(1);
    const direct = normalizedSteps();
    expect(direct).toHaveLength(60);
    vi.mocked(mocks.stage.step).mockClear();
    runtime.seek(0.016667);
    runtime.togglePlay();
    advance(1.1);
    expect(runtime.state.playing).toBe(false);
    expect(normalizedSteps()).toEqual(direct);
  });
  it("records monotonic fixed-step observations and stops automatically at 60 seconds", async () => {
    await runtime.startTake();
    advance(60.2);
    expect(runtime.state.mode).toBe("replay");
    expect(runtime.state.playing).toBe(false);
    expect(runtime.state.duration).toBe(60);
    const take = runtime.snapshot("A full take");
    expect(take.samples.length).toBeGreaterThanOrEqual(3599);
    expect(take.samples.length).toBeLessThanOrEqual(3601);
    expect(take.samples[0].t).toBe(0);
    expect(
      take.samples.every(
        (s, i) => s.t >= 0 && s.t <= 60 && (!i || s.t > take.samples[i - 1].t),
      ),
    ).toBe(true);
    for (let i = 1; i < take.samples.length; i++)
      expect(take.samples[i].t - take.samples[i - 1].t).toBeCloseTo(1 / 60, 10);
    expect(mocks.vision.stop).toHaveBeenCalled();
  });
  it("restarts the camera after stopping one take and beginning another", async () => {
    await runtime.setSource("camera");
    mocks.vision.emit({ ...sample(), source: "camera" });
    await runtime.startTake();
    advance(0.25);
    runtime.stopTake();
    expect(runtime.state.status.state).toBe("idle");
    expect(mocks.vision.startCamera).toHaveBeenCalledTimes(1);
    await runtime.startTake();
    expect(mocks.vision.startCamera).toHaveBeenCalledTimes(2);
    expect(runtime.state.mode).toBe("recording");
    expect(runtime.state.status.state).toBe("ready");
    expect(runtime.state.time).toBe(0);
  });
  it("ends a recording when its source video ends", async () => {
    await runtime.setSource(
      "video",
      new File(["fixture"], "source.webm", { type: "video/webm" }),
    );
    mocks.vision.emit(sample());
    await runtime.startTake();
    advance(0.25);
    video.dispatchEvent(new Event("ended"));
    expect(runtime.state.mode).toBe("replay");
    expect(runtime.state.duration).toBeGreaterThan(0);
    expect(runtime.state.playing).toBe(false);
  });
  it("ends a take on vision failure instead of recording indefinitely with stale input", async () => {
    await runtime.setSource("camera");
    await runtime.startTake();
    advance(0.2);
    mocks.vision.status({ state: "error", message: "Model stopped" });
    expect(runtime.state.mode).toBe("replay");
    expect(runtime.state.playing).toBe(false);
    expect(runtime.state.error).toBe("Model stopped");
  });
  it("keeps the latest project when asynchronous loads finish out of order", async () => {
    const firstSwitch = deferred<void>();
    const secondSwitch = deferred<void>();
    vi.mocked(mocks.stage.switchScene)
      .mockImplementationOnce(() => firstSwitch.promise)
      .mockImplementationOnce(() => secondSwitch.promise);
    const first = runtime.load(project("older", "ribbon"));
    const second = runtime.load(project("newer", "gravity"));
    secondSwitch.resolve();
    await second;
    firstSwitch.resolve();
    await first;
    expect(runtime.snapshot().manifest.id).toBe("newer");
    expect(runtime.state.scene).toBe("gravity");
    expect(runtime.state.ready).toBe(true);
  });
  it("preserves the current take after stage initialization fails and retries the requested stage", async () => {
    await runtime.load(project("retained-study", "ribbon"));
    runtime.setParams({ palette: "ember", width: 0.8 });
    const previousParams = { ...runtime.state.params };
    vi.mocked(mocks.stage.switchScene).mockClear();
    vi.mocked(mocks.stage.switchScene).mockRejectedValueOnce(
      new Error("Physics module unavailable"),
    );
    await runtime.setScene("gravity");
    expect(runtime.state.scene).toBe("ribbon");
    expect(runtime.state.params).toEqual(previousParams);
    expect(runtime.snapshot().manifest.id).toBe("retained-study");
    expect(runtime.state.ready).toBe(true);
    expect(runtime.state.error).toBe("Physics module unavailable");
    await runtime.retrySource();
    expect(mocks.stage.switchScene).toHaveBeenCalledTimes(2);
    expect(mocks.stage.switchScene).toHaveBeenLastCalledWith(
      "gravity",
      1234,
      expect.objectContaining({ material: "glass" }),
    );
    expect(runtime.state.scene).toBe("gravity");
    expect(runtime.state.source).toBe("demo");
    expect(runtime.state.error).toBe("");
    expect(runtime.state.duration).toBe(0);
  });
  it("ignores a stale stage failure and clears its retry target when a newer project opens", async () => {
    const failedSwitch = deferred<void>();
    vi.mocked(mocks.stage.switchScene).mockImplementationOnce(
      () => failedSwitch.promise,
    );
    const pending = runtime.setScene("gravity");
    const replacement = project("replacement", "portal");
    replacement.manifest.source = "demo";
    await runtime.load(replacement);
    failedSwitch.reject(new Error("Old gravity request failed"));
    await pending;
    expect(runtime.state.scene).toBe("portal");
    expect(runtime.state.error).toBe("");
    expect(runtime.snapshot().manifest.id).toBe("replacement");
    vi.mocked(mocks.stage.switchScene).mockClear();
    await runtime.retrySource();
    expect(mocks.stage.switchScene).not.toHaveBeenCalled();
    expect(runtime.state.scene).toBe("portal");
  });
  it("keeps reduced-motion demo autoplay paused across source changes, retries, and stage changes", async () => {
    runtime.setReducedMotion(true);
    expect(runtime.state.playing).toBe(false);
    await runtime.setScene("gravity");
    expect(runtime.state.source).toBe("demo");
    expect(runtime.state.playing).toBe(false);
    const stillTime = runtime.state.time;
    vi.mocked(mocks.stage.step).mockClear();
    advance(0.2);
    expect(runtime.state.time).toBe(stillTime);
    expect(mocks.stage.step).not.toHaveBeenCalled();

    await runtime.setSource("camera");
    expect(runtime.state.playing).toBe(true);
    await runtime.setSource("demo");
    expect(runtime.state.playing).toBe(false);
    await runtime.retrySource();
    expect(runtime.state.playing).toBe(false);
    runtime.clear();
    expect(runtime.state.playing).toBe(false);
    await runtime.setScene("portal");
    expect(runtime.state.playing).toBe(false);

    runtime.setReducedMotion(false);
    await runtime.setSource("demo");
    expect(runtime.state.playing).toBe(true);
  });
  it("allows explicit demo recording and replay without losing the reduced-motion preference", async () => {
    runtime.setReducedMotion(true);
    await runtime.startTake();
    expect(runtime.state.mode).toBe("recording");
    expect(runtime.state.playing).toBe(true);
    runtime.setReducedMotion(true);
    advance(0.3);
    runtime.stopTake();
    expect(runtime.state.duration).toBeGreaterThan(0.2);
    expect(runtime.snapshot().samples.length).toBeGreaterThan(10);

    runtime.replay();
    runtime.setReducedMotion(true);
    expect(runtime.state.playing).toBe(true);
    advance(0.1);
    expect(runtime.state.time).toBeGreaterThan(0);
    runtime.clear();
    expect(runtime.state.mode).toBe("live");
    expect(runtime.state.playing).toBe(false);
    runtime.togglePlay();
    expect(runtime.state.playing).toBe(true);
    await runtime.setScene("gravity");
    expect(runtime.state.playing).toBe(false);
  });
});

describe("runtime output lifecycle", () => {
  it("captures PNG at full quality and redraws the paused canvas after restoring quality", async () => {
    await runtime.load(project());
    runtime.setParams({ quality: "balanced" });
    events = [];
    const png = await runtime.capturePng();
    expect(png.type).toBe("image/png");
    expect(events).toEqual([
      "quality:high",
      "render",
      "encode",
      "quality:balanced",
      "render",
    ]);
    expect(runtime.state.playing).toBe(false);
    expect(runtime.state.params.quality).toBe("balanced");
  });
  it("restores and redraws the canvas even if PNG encoding fails", async () => {
    await runtime.load(project());
    runtime.setParams({ quality: "low" });
    vi.mocked(canvas.toBlob).mockImplementationOnce((callback) => {
      events.push("encode");
      callback(null);
    });
    events = [];
    await expect(runtime.capturePng()).rejects.toThrow("PNG encoding failed");
    expect(events).toEqual([
      "quality:high",
      "render",
      "encode",
      "quality:low",
      "render",
    ]);
  });
  it("exports a trimmed take, settles once, and returns to paused replay", async () => {
    await runtime.load(project());
    runtime.setTrim(0.2, 0.5);
    const output = runtime.exportVideo();
    expect(runtime.state.mode).toBe("exporting");
    expect(mocks.recorder.start).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    frame(0);
    advance(0.5);
    const result = await output;
    expect(result.extension).toBe("webm");
    expect(await result.blob.text()).toBe("encoder fixture");
    expect(mocks.recorder.stop).toHaveBeenCalledTimes(1);
    expect(runtime.state.mode).toBe("replay");
    expect(runtime.state.playing).toBe(false);
    expect(runtime.state.time).toBeCloseTo(0.5, 8);
    expect(mocks.stage.setParams).toHaveBeenLastCalledWith(
      runtime.state.params,
    );
  });
  it("submits initial, rendered, and final frames for a freshly recorded and restyled take", async () => {
    await runtime.startTake();
    advance(0.5);
    runtime.stopTake();
    runtime.setParams({ palette: "ember" });
    expect(runtime.snapshot("Fresh study").manifest.params.palette).toBe(
      "ember",
    );
    const output = runtime.exportVideo();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.recorder.captureFrame).toHaveBeenNthCalledWith(1, true);
    frame(0);
    advance(0.7);
    await output;
    const captureCalls = mocks.recorder.captureFrame.mock.calls;
    expect(captureCalls.some((args) => args.length === 0)).toBe(true);
    const forced = captureCalls.flatMap((args, index) =>
      args[0] === true ? [index] : [],
    );
    expect(forced).toHaveLength(2);
    const lastForcedOrder =
      mocks.recorder.captureFrame.mock.invocationCallOrder[forced[1]];
    expect(lastForcedOrder).toBeLessThan(
      mocks.recorder.stop.mock.invocationCallOrder[0],
    );
    const renderOrders = vi.mocked(mocks.stage.render).mock.invocationCallOrder;
    const captureOrders = mocks.recorder.captureFrame.mock.invocationCallOrder;
    for (let index = 0; index < captureOrders.length; index++) {
      const precedingRender = renderOrders
        .filter((order) => order < captureOrders[index])
        .at(-1);
      expect(precedingRender).toBeDefined();
      if (index > 0)
        expect(precedingRender).toBeGreaterThan(captureOrders[index - 1]);
    }
    expect(runtime.state.mode).toBe("replay");
  });
  it("rejects an encoder failure, cancels capture, and restores normal rendering settings", async () => {
    await runtime.load(project());
    const output = runtime.exportVideo();
    mocks.recorder.onError?.("The tab was hidden");
    await expect(output).rejects.toThrow("The tab was hidden");
    expect(mocks.recorder.cancel).toHaveBeenCalledTimes(1);
    expect(runtime.state.mode).toBe("replay");
    expect(runtime.state.playing).toBe(false);
    expect(mocks.stage.setParams).toHaveBeenLastCalledWith(
      runtime.state.params,
    );
  });
  it("does not continuously render a paused replay but redraws visual edits", async () => {
    await runtime.load(project());
    frame();
    vi.mocked(mocks.stage.render).mockClear();
    advance(0.2);
    expect(mocks.stage.render).not.toHaveBeenCalled();
    runtime.setParams({ intensity: 0.7 });
    frame();
    expect(mocks.stage.render).toHaveBeenCalledTimes(1);
  });

  it("holds the trimmed first frame during preparation and starts its clock only after readiness", async () => {
    await runtime.load(project());
    runtime.setTrim(0.2, 0.5);
    const preparation = deferred<void>();
    mocks.preparation = preparation.promise;
    const output = runtime.exportVideo();
    vi.mocked(mocks.stage.step).mockClear();
    advance(4);
    expect(runtime.state.mode).toBe("exporting");
    expect(runtime.state.playing).toBe(false);
    expect(runtime.state.time).toBeCloseTo(0.2);
    expect(mocks.stage.step).not.toHaveBeenCalled();
    expect(mocks.recorder.stop).not.toHaveBeenCalled();
    preparation.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.state.playing).toBe(true);
    frame(0);
    expect(runtime.state.time).toBeCloseTo(0.2);
    advance(0.5);
    await output;
    expect(runtime.state.time).toBeCloseTo(0.5);
    expect(mocks.stage.step).toHaveBeenCalledTimes(18);
  });

  it.each(["cancel", "dispose"])(
    "settles a pending export on %s and does not restart after delayed readiness",
    async (reason) => {
      await runtime.load(project());
      const preparation = deferred<void>();
      mocks.preparation = preparation.promise;
      const output = runtime.exportVideo();
      const rejected = expect(output).rejects.toThrow(
        reason === "cancel" ? "Export canceled" : "closed",
      );
      if (reason === "cancel") runtime.abortExport();
      else runtime.dispose();
      await rejected;
      expect(mocks.recorder.cancel).toHaveBeenCalledTimes(1);
      const capturesBefore = mocks.recorder.captureFrame.mock.calls.length;
      preparation.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(runtime.state.playing).toBe(false);
      expect(mocks.recorder.captureFrame).toHaveBeenCalledTimes(capturesBefore);
    },
  );

  it("rejects preparation failure and restores replay without starting its clock", async () => {
    await runtime.load(project());
    const preparation = deferred<void>();
    mocks.preparation = preparation.promise;
    const output = runtime.exportVideo();
    const rejected = expect(output).rejects.toThrow("Preparation timeout");
    preparation.reject(new Error("Preparation timeout"));
    await rejected;
    expect(runtime.state.mode).toBe("replay");
    expect(runtime.state.playing).toBe(false);
    expect(mocks.recorder.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.recorder.stop).not.toHaveBeenCalled();
    expect(mocks.stage.setParams).toHaveBeenLastCalledWith(
      runtime.state.params,
    );
  });

  it("does not let a cancelled encoder's delayed stop clear or reject a newer export", async () => {
    await runtime.load(project());
    const oldStop = deferred<Blob>();
    const oldOutput = runtime.exportVideo();
    mocks.recorder.stop.mockReturnValueOnce(oldStop.promise);
    await Promise.resolve();
    await Promise.resolve();
    frame(0);
    advance(1.2);
    expect(mocks.recorder.stop).toHaveBeenCalledTimes(1);
    const oldFailure = expect(oldOutput).rejects.toThrow("Export canceled");
    runtime.abortExport();
    await oldFailure;
    const newOutput = runtime.exportVideo();
    const newRecorder = mocks.recorder;
    await Promise.resolve();
    await Promise.resolve();
    oldStop.reject(new Error("Old encoder finished with an error"));
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.state.mode).toBe("exporting");
    expect(runtime.state.playing).toBe(true);
    expect(newRecorder.cancel).not.toHaveBeenCalled();
    frame(0);
    advance(1.2);
    expect((await newOutput).extension).toBe("webm");
    expect(newRecorder.stop).toHaveBeenCalledTimes(1);
  });
});
