import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InputSample,
  PrismProject,
  StageEngine,
  VisualParams,
} from "../src/core/types";
import { DEFAULT_PARAMS } from "../src/core/presets";
import { StudioRuntime } from "../src/core/StudioRuntime";

type MediaMock = {
  element: FakeVideo;
  blob?: Blob;
  attach: ReturnType<typeof vi.fn>;
  seek: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  startCapture: ReturnType<typeof vi.fn>;
  stopCapture: ReturnType<typeof vi.fn>;
  cancelCapture: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  fail: (message: string) => void;
};
const mocks = vi.hoisted(() => ({
  stage: undefined as unknown as StageEngine,
  preparation: undefined as Promise<void> | undefined,
  media: undefined as unknown as MediaMock,
  mediaInstances: [] as MediaMock[],
  mediaSetup: undefined as ((media: MediaMock) => void) | undefined,
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
      this.startCamera = vi.fn(async () => {
        await video.play();
        status({ state: "ready", message: "Camera ready" });
      });
      this.startVideo = vi.fn(async () => {
        await video.play();
        status({ state: "ready", message: "Video ready" });
      });
      this.stop = vi.fn(() => {
        video.pause();
        status({ state: "idle", message: "Input stopped" });
      });
      this.dispose = vi.fn();
      mocks.vision = this;
    }
  },
}));
vi.mock("../src/media/TakeVideo", () => ({
  TakeVideo: class {
    element = new FakeVideo();
    blob?: Blob;
    get currentTime() {
      return this.element.currentTime;
    }
    get duration() {
      return this.element.duration;
    }
    attach = vi.fn(async (blob: Blob) => {
      this.blob = blob;
      this.element.pause();
      this.element.currentTime = 0;
    });
    seek = vi.fn(async (time: number) => {
      this.element.currentTime = time;
    });
    play = vi.fn(async () => {
      await this.element.play();
    });
    pause = vi.fn(() => this.element.pause());
    startCapture = vi.fn(async (_source: HTMLVideoElement) => undefined);
    stopCapture = vi.fn(
      async () => new Blob(["camera source fixture"], { type: "video/webm" }),
    );
    cancelCapture = vi.fn();
    clear = vi.fn(() => {
      this.cancelCapture();
      this.element.pause();
      this.element.currentTime = 0;
      this.blob = undefined;
    });
    dispose = vi.fn(() => this.clear());
    constructor(public fail: (message: string) => void) {
      mocks.media = this;
      mocks.mediaInstances.push(this);
      mocks.mediaSetup?.(this);
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
  duration = 10;
  videoWidth = 1280;
  videoHeight = 720;
  readyState = 4;
  paused = true;
  get ended() { return this.currentTime >= this.duration; }
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
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
  for (const element of [video, ...mocks.mediaInstances.map(media => media.element)])
    if (element && !element.paused)
      element.currentTime = Math.min(
        element.duration,
        element.currentTime + elapsed / 1000,
      );
  const pending = [...callbacks.values()];
  callbacks.clear();
  for (const callback of pending) callback(wall);
}
function advance(seconds: number) {
  for (let i = 0; i < Math.ceil(seconds * 100); i++) frame(10);
}
async function settle() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
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
function compositeProject(id = "composite-project"): PrismProject {
  const original = project(id);
  original.manifest.version = 2;
  original.manifest.composition = "video";
  original.manifest.video = {
    mimeType: "video/webm",
    width: 1280,
    height: 720,
    duration: 8,
    offset: 2,
  };
  original.video = new Blob(["retained original footage fixture"], {
    type: "video/webm",
  });
  return original;
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
  mocks.mediaInstances = [];
  mocks.mediaSetup = undefined;
  callbacks = new Map();
  rafId = 0;
  wall = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => wall);
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
    setVideoBackground: vi.fn(),
    setInputSourceSize: vi.fn(),
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
  vi.restoreAllMocks();
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
    await runtime.stopTake();
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
    await runtime.stopTake();
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

describe("retained source video and media time", () => {
  it("loads and snapshots a v2 source Blob and clears it when opening a legacy take", async () => {
    const original = compositeProject();
    original.videoNotice = "Copyright Google LLC\nApache License 2.0\nSource: https://example.org/fixture.webm";
    await runtime.load(original);
    await settle();
    expect(mocks.media.attach).toHaveBeenCalledWith(original.video);
    expect(runtime.state.hasVideo).toBe(true);
    expect(runtime.state.composition).toBe("video");
    expect(mocks.stage.setVideoBackground).toHaveBeenLastCalledWith(
      mocks.media.element,
    );
    expect(mocks.stage.setInputSourceSize).toHaveBeenLastCalledWith(1280, 720);
    const restored = runtime.snapshot();
    expect(restored.video).toBe(original.video);
    expect(restored.videoNotice).toBe(original.videoNotice);
    expect(restored.manifest.version).toBe(2);
    expect(restored.manifest.video).toEqual(original.manifest.video);
    expect(restored.samples).toEqual(original.samples);
    await runtime.load(project());
    expect(runtime.state.hasVideo).toBe(false);
    expect(runtime.state.composition).toBe("abstract");
    expect(mocks.stage.setVideoBackground).toHaveBeenLastCalledWith(null);
    expect(runtime.snapshot().video).toBeUndefined();
    expect(runtime.snapshot().videoNotice).toBeUndefined();
    expect(runtime.snapshot().manifest.version).toBe(1);
  });

  it("changes composition without changing input coordinates, take bytes, or simulation state", async () => {
    const original = compositeProject();
    await runtime.load(original);
    await settle();
    vi.mocked(mocks.stage.reset).mockClear();
    vi.mocked(mocks.stage.step).mockClear();
    const time = runtime.state.time;
    runtime.setComposition("abstract");
    expect(mocks.stage.setVideoBackground).toHaveBeenLastCalledWith(null);
    expect(runtime.snapshot().video).toBe(original.video);
    expect(runtime.snapshot().manifest.composition).toBe("abstract");
    runtime.setComposition("video");
    expect(mocks.stage.setVideoBackground).toHaveBeenLastCalledWith(
      mocks.media.element,
    );
    expect(runtime.snapshot().samples).toEqual(original.samples);
    expect(runtime.state.time).toBe(time);
    expect(mocks.stage.step).not.toHaveBeenCalled();
    expect(mocks.stage.reset).not.toHaveBeenCalled();
  });

  it("keeps a retained source notice for another take of the same file and clears it for a replacement file", async () => {
    const original = compositeProject();
    original.videoNotice = "Copyright Google LLC\nApache License 2.0\nSource: https://example.org/fixture.webm";
    await runtime.load(original);
    await settle();
    await runtime.startTake();
    advance(0.3);
    mocks.vision.emit(sample(0.1));
    await runtime.stopTake();
    expect(runtime.snapshot().videoNotice).toBe(original.videoNotice);
    const retained = runtime.snapshot().video;
    expect(retained).toBeInstanceOf(File);
    expect(await retained!.text()).toBe(await original.video!.text());

    const replacement = new File(["different source fixture"], "replacement.webm", { type: "video/webm" });
    await runtime.setSource("video", replacement);
    await runtime.startTake();
    advance(0.3);
    mocks.vision.emit(sample(0.1));
    await runtime.stopTake();
    expect(runtime.snapshot().video).toBe(replacement);
    expect(runtime.snapshot().videoNotice).toBeUndefined();
  });

  it("seeks original video using its offset and advances replay only when media time advances", async () => {
    await runtime.load(compositeProject());
    await settle();
    runtime.seek(0.3);
    await settle();
    expect(mocks.media.seek).toHaveBeenLastCalledWith(2.3);
    expect(runtime.state.time).toBeCloseTo(0.3);
    runtime.togglePlay();
    await settle();
    expect(mocks.media.play).toHaveBeenCalled();
    // A decoded video may stall while RAF continues; simulation must also hold.
    mocks.media.element.paused = true;
    vi.mocked(mocks.stage.step).mockClear();
    advance(0.5);
    expect(runtime.state.time).toBeCloseTo(0.3);
    expect(mocks.stage.step).not.toHaveBeenCalled();
    mocks.media.element.currentTime = 2.4;
    frame(0);
    expect(runtime.state.time).toBeCloseTo(0.4);
    expect(mocks.stage.step).toHaveBeenCalledTimes(6);
  });

  it("preserves sparse observation timestamps instead of shifting them to callback arrival time", async () => {
    const file = new File(["original fixture"], "source.webm", {
      type: "video/webm",
    });
    await runtime.setSource("video", file);
    await runtime.startTake();
    advance(0.5);
    mocks.vision.emit(sample(0.3));
    mocks.vision.emit(sample(0.1));
    await runtime.stopTake();
    const take = runtime.snapshot();
    expect(take.samples.map((input) => input.t)).toEqual([0, 0.1, 0.3]);
    expect(take.samples[0].hands).toEqual([]);
    expect(take.video).toBe(file);
    expect(take.manifest.video?.offset).toBe(0);
    expect(take.manifest.version).toBe(2);
  });

  it("uses camera input offset after capture preparation and waits for source bytes before stopping vision", async () => {
    await runtime.setSource("camera");
    advance(2);
    const captureReady = deferred<void>();
    mocks.media.startCapture.mockReturnValueOnce(captureReady.promise);
    const starting = runtime.startTake();
    advance(2);
    expect(runtime.state.mediaBusy).toBe(true);
    expect(runtime.state.mode).toBe("live");
    captureReady.resolve();
    await starting;
    advance(0.3);
    mocks.vision.emit({ ...sample(4.1), source: "camera" });
    const original = new Blob(["camera frames"], { type: "video/webm" });
    const sourceBytes = deferred<Blob>();
    mocks.media.stopCapture.mockReturnValueOnce(sourceBytes.promise);
    mocks.vision.stop.mockClear();
    const stopping = runtime.stopTake();
    expect(runtime.state.mediaBusy).toBe(true);
    expect(mocks.vision.stop).not.toHaveBeenCalled();
    expect(() => runtime.snapshot()).toThrow("finish saving");
    sourceBytes.resolve(original);
    await stopping;
    expect(mocks.vision.stop).toHaveBeenCalledTimes(1);
    expect(mocks.media.attach).toHaveBeenCalledWith(original);
    expect(runtime.state.mediaBusy).toBe(false);
    const take = runtime.snapshot();
    expect(take.video).toBe(original);
    expect(take.samples.at(-1)!.t).toBeCloseTo(0.1);
  });

  it("rejects stale source capture completion after switching sources", async () => {
    await runtime.setSource("camera");
    await runtime.startTake();
    advance(0.3);
    const captured = deferred<Blob>();
    mocks.media.stopCapture.mockReturnValueOnce(captured.promise);
    const stopping = runtime.stopTake();
    await runtime.setSource("demo");
    const newTime = runtime.state.time;
    mocks.vision.stop.mockClear();
    captured.resolve(new Blob(["old camera"], { type: "video/webm" }));
    await stopping;
    expect(runtime.state.source).toBe("demo");
    expect(runtime.state.time).toBe(newTime);
    expect(runtime.state.hasVideo).toBe(false);
    expect(mocks.media.attach).not.toHaveBeenCalled();
    expect(mocks.vision.stop).not.toHaveBeenCalled();
  });

  it("keeps abstract input usable after original-video capture fails and can retry the camera", async () => {
    await runtime.setSource("camera");
    await runtime.startTake();
    advance(0.3);
    mocks.vision.emit({ ...sample(0.1), source: "camera" });
    mocks.media.stopCapture.mockRejectedValueOnce(
      new Error("Original encoder failed"),
    );
    await runtime.stopTake();
    expect(runtime.state.error).toContain("Original encoder failed");
    expect(runtime.state.mediaBusy).toBe(false);
    expect(runtime.state.composition).toBe("abstract");
    expect(runtime.snapshot().samples.length).toBeGreaterThan(1);
    expect(runtime.snapshot().video).toBeUndefined();
    await runtime.startTake();
    expect(mocks.vision.startCamera).toHaveBeenCalledTimes(2);
    expect(runtime.state.mode).toBe("recording");
  });

  it("waits for source seek and encoder readiness before starting export playback", async () => {
    await runtime.load(compositeProject());
    await settle();
    runtime.setTrim(0.2, 0.5);
    const seek = deferred<void>();
    const preparation = deferred<void>();
    mocks.media.seek.mockImplementationOnce(async (time: number) => {
      await seek.promise;
      mocks.media.element.currentTime = time;
    });
    mocks.preparation = preparation.promise;
    mocks.media.play.mockClear();
    const output = runtime.exportVideo();
    expect(mocks.media.seek).toHaveBeenLastCalledWith(2.2);
    expect(mocks.recorder.start).not.toHaveBeenCalled();
    advance(2);
    expect(runtime.state.time).toBeCloseTo(0.2);
    seek.resolve();
    await settle();
    expect(mocks.recorder.start).toHaveBeenCalledTimes(1);
    expect(mocks.media.play).not.toHaveBeenCalled();
    preparation.resolve();
    await settle();
    expect(mocks.media.play).toHaveBeenCalledTimes(1);
    expect(
      mocks.recorder.captureFrame.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.media.play.mock.invocationCallOrder[0]);
    expect(runtime.state.playing).toBe(true);
    advance(0.5);
    await output;
    expect(runtime.state.time).toBeCloseTo(0.5);
    expect(mocks.media.element.paused).toBe(true);
  });

  it("keeps public media readiness pending until the newest decoded seek completes", async () => {
    await runtime.load(compositeProject());
    await settle();
    const first = deferred<void>(), second = deferred<void>();
    mocks.media.seek.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    runtime.seek(0.2);
    expect(runtime.state.mediaBusy).toBe(true);
    await expect(runtime.exportVideo()).rejects.toThrow("finish saving");
    runtime.seek(0.7);
    first.resolve(); await settle();
    expect(runtime.state.mediaBusy).toBe(true);
    expect(runtime.state.time).toBeCloseTo(0.7);
    second.resolve(); await settle();
    expect(runtime.state.mediaBusy).toBe(false);
    expect(runtime.snapshot().manifest.duration).toBe(1);
  });

  it("does not start an encoder when an export is canceled during its source seek", async () => {
    await runtime.load(compositeProject());
    await settle();
    const seek = deferred<void>();
    mocks.media.seek.mockReturnValueOnce(seek.promise);
    const output = runtime.exportVideo();
    const rejection = expect(output).rejects.toThrow("Export canceled");
    runtime.abortExport();
    await rejection;
    seek.resolve();
    await settle();
    expect(mocks.recorder.start).not.toHaveBeenCalled();
    expect(runtime.state.mode).toBe("replay");
    expect(runtime.state.playing).toBe(false);
    expect(mocks.media.element.paused).toBe(true);
  });

  it("preserves retained footage when a requested stage fails to initialize", async () => {
    const original = compositeProject("retained-after-stage-error");
    await runtime.load(original);
    await settle();
    mocks.stage.switchScene = vi.fn(async () => {
      throw new Error("Stage unavailable");
    });
    await runtime.setScene("gravity");
    expect(runtime.state.scene).toBe("ribbon");
    expect(runtime.snapshot().manifest.id).toBe(original.manifest.id);
    expect(runtime.snapshot().video).toBe(original.video);
    expect(runtime.state.hasVideo).toBe(true);
  });

  it("ignores final source seek completion from a take abandoned while saving", async () => {
    await runtime.setSource("camera");
    await runtime.startTake();
    advance(0.3);
    const finalSeek = deferred<void>();
    mocks.media.seek.mockReturnValueOnce(finalSeek.promise);
    const stopping = runtime.stopTake();
    await settle();
    expect(mocks.media.seek).toHaveBeenCalled();
    await runtime.setSource("demo");
    const newTime = runtime.state.time;
    finalSeek.resolve();
    await stopping;
    expect(runtime.state.source).toBe("demo");
    expect(runtime.state.time).toBe(newTime);
    expect(runtime.state.duration).toBe(0);
  });

  it("drops invalid retained bytes when source-container validation fails", async () => {
    await runtime.setSource("camera");
    await runtime.startTake();
    advance(0.3);
    mocks.media.stopCapture.mockResolvedValueOnce(
      new Blob(["unknown container"], { type: "video/unsupported" }),
    );
    await runtime.stopTake();
    expect(runtime.state.error).toContain("MP4 or WebM");
    expect(runtime.state.hasVideo).toBe(false);
    expect(runtime.snapshot().manifest.version).toBe(1);
    expect(runtime.snapshot().video).toBeUndefined();
  });

  it("does not apply an obsolete source error to a newly selected demo", async () => {
    const loading = deferred<void>();
    mocks.vision.startCamera.mockReturnValueOnce(loading.promise);
    const old = runtime.setSource("camera");
    await runtime.setSource("demo");
    loading.reject(new Error("Old camera permission error"));
    await old;
    expect(runtime.state.source).toBe("demo");
    expect(runtime.state.error).toBe("");
    expect(runtime.state.composition).toBe("abstract");
  });

  it("finishes every fixed simulation step when media reaches the end after a long render stall", async () => {
    await runtime.load(compositeProject());
    await settle();
    runtime.seek(0);
    await settle();
    runtime.togglePlay();
    await settle();
    vi.mocked(mocks.stage.step).mockClear();
    mocks.media.element.currentTime = 3;
    mocks.media.element.paused = true;
    frame(1000);
    advance(0.5);
    expect(runtime.state.playing).toBe(false);
    expect(runtime.state.time).toBe(1);
    expect(mocks.stage.step).toHaveBeenCalledTimes(60);
    expect(vi.mocked(mocks.stage.step).mock.calls.at(-1)?.[1]).toBeCloseTo(59 / 60);
  });

  it("finishes a fractional media trim at the same deterministic state as seeking its endpoint", async () => {
    await runtime.load(compositeProject());
    await settle();
    runtime.setTrim(0, 0.73);
    runtime.seek(0);
    await settle();
    runtime.togglePlay();
    await settle();
    vi.mocked(mocks.stage.step).mockClear();
    mocks.media.element.currentTime = 2.73;
    mocks.media.element.paused = true;
    frame(1000);
    advance(0.5);
    expect(runtime.state.playing).toBe(false);
    expect(runtime.state.time).toBe(0.73);
    const completedInput = vi.mocked(mocks.stage.step).mock.calls.at(-1);
    expect(completedInput?.[1]).toBeCloseTo(43 / 60);
    vi.mocked(mocks.stage.step).mockClear();
    runtime.seek(0.73);
    expect(mocks.stage.step).toHaveBeenCalledTimes(44);
    expect(vi.mocked(mocks.stage.step).mock.calls.at(-1)).toEqual(completedInput);
  });

  it("preserves an undo action even when no new vision observation arrives before recording stops", async () => {
    await runtime.setSource("video", new File(["source"], "source.webm", { type: "video/webm" }));
    await runtime.startTake();
    advance(0.2);
    mocks.vision.emit(sample(0.1));
    runtime.undo();
    advance(0.1);
    await runtime.stopTake();
    const take = runtime.snapshot();
    expect(take.samples.at(-1)?.undoCount).toBe(1);
    expect(take.samples.every((input, index) => !index || (input.undoCount ?? 0) >= (take.samples[index - 1].undoCount ?? 0))).toBe(true);
  });

  it("keeps the current editable take when a newly selected source is rejected by the size limit", async () => {
    const original = compositeProject("keep-after-invalid-file");
    await runtime.load(original);
    await settle();
    const oversized = new File(["small fixture"], "too-large.webm", { type: "video/webm" });
    Object.defineProperty(oversized, "size", { value: 96 * 1024 * 1024 + 1 });
    await runtime.setSource("video", oversized);
    expect(runtime.state.error).toContain("96 MB");
    expect(runtime.snapshot().manifest.id).toBe(original.manifest.id);
    expect(runtime.snapshot().video).toBe(original.video);
  });
});

describe("provisional project loading preserves unsaved work", () => {
  async function currentStudy() {
    const original = compositeProject("unsaved-current-project");
    original.videoNotice = "An original source notice";
    await runtime.load(original);
    runtime.setParams({ palette: "ember", width: 0.72 });
    runtime.setTrim(0.1, 0.9);
    runtime.seek(0.7);
    await settle();
    vi.mocked(mocks.stage.switchScene).mockClear();
    const currentMedia = mocks.media;
    currentMedia.clear.mockClear();
    currentMedia.dispose.mockClear();
    return { snapshot: runtime.snapshot(), time: runtime.state.time, currentMedia };
  }
  function expectPreserved(previous: Awaited<ReturnType<typeof currentStudy>>) {
    const actual = runtime.snapshot();
    // Each snapshot stamps its save time; all persistent creative state must match.
    expect({ ...actual.manifest, createdAt: previous.snapshot.manifest.createdAt }).toEqual(previous.snapshot.manifest);
    expect(actual.samples).toEqual(previous.snapshot.samples);
    expect(actual.video).toBe(previous.snapshot.video);
    expect(actual.videoNotice).toBe(previous.snapshot.videoNotice);
    expect(runtime.state.time).toBe(previous.time);
    expect(runtime.state.hasVideo).toBe(true);
    expect(runtime.state.composition).toBe("video");
    expect(runtime.state.ready).toBe(true);
    expect(runtime.state.playing).toBe(false);
    expect(previous.currentMedia.clear).not.toHaveBeenCalled();
    expect(previous.currentMedia.dispose).not.toHaveBeenCalled();
    expect(mocks.stage.setVideoBackground).toHaveBeenLastCalledWith(previous.currentMedia.element);
  }
  it("preserves an unsaved source, attribution, edits and playhead after native decoding fails", async () => {
    const previous = await currentStudy();
    mocks.mediaSetup = media => media.attach.mockRejectedValueOnce(new Error("Native decoder rejected this video"));
    await expect(runtime.load(compositeProject("invalid-decoder"))).rejects.toThrow("Native decoder rejected");
    expectPreserved(previous);
    expect(runtime.state.error).toContain("Native decoder rejected");
    expect(mocks.stage.switchScene).not.toHaveBeenCalled();
    expect(mocks.media.dispose).toHaveBeenCalledTimes(1);
    mocks.media.fail("A late provisional error");
    expect(runtime.state.error).toContain("Native decoder rejected");
  });
  it.each([
    ["width", (media: MediaMock) => { media.element.videoWidth = 1920; }],
    ["height", (media: MediaMock) => { media.element.videoHeight = 1080; }],
    ["unknown duration", (media: MediaMock) => { media.element.duration = Number.NaN; }],
    ["short duration", (media: MediaMock) => { media.element.duration = 2.5; }],
  ] as const)("preserves the current project after decoded %s disagrees with its manifest", async (_name, configure) => {
    const previous = await currentStudy();
    mocks.mediaSetup = configure;
    await expect(runtime.load(compositeProject("invalid-metadata"))).rejects.toThrow("does not match");
    expectPreserved(previous);
    expect(mocks.stage.switchScene).not.toHaveBeenCalled();
    expect(mocks.media.dispose).toHaveBeenCalledTimes(1);
  });
  it("preserves the current project when the imported video's initial frame cannot be decoded", async () => {
    const previous = await currentStudy();
    mocks.mediaSetup = media => media.seek.mockRejectedValueOnce(new Error("Native target frame failed"));
    await expect(runtime.load(compositeProject("invalid-target-frame"))).rejects.toThrow("Native target frame failed");
    expectPreserved(previous);
    expect(mocks.media.attach).toHaveBeenCalledTimes(1);
    expect(mocks.media.seek).toHaveBeenCalledWith(2.5);
    expect(mocks.media.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.stage.switchScene).not.toHaveBeenCalled();
  });
  it("retains the previous project when stage initialization rejects an otherwise decoded import", async () => {
    const previous = await currentStudy();
    vi.mocked(mocks.stage.switchScene).mockRejectedValueOnce(new Error("Imported stage could not initialize"));
    await expect(runtime.load(compositeProject("invalid-stage"))).rejects.toThrow("Imported stage could not initialize");
    expectPreserved(previous);
    expect(mocks.media.attach).toHaveBeenCalledTimes(1);
    expect(mocks.media.seek).toHaveBeenCalledTimes(1);
    expect(mocks.media.dispose).toHaveBeenCalledTimes(1);
  });
  it("transfers the prepared owner only after native seeking succeeds and then releases the old owner", async () => {
    const previous = await currentStudy();
    const targetReady = deferred<void>();
    mocks.mediaSetup = media => media.seek.mockReturnValueOnce(targetReady.promise);
    const replacement = compositeProject("new-validated-project");
    const loading = runtime.load(replacement);
    const incoming = mocks.media;
    await settle();
    expect(runtime.state.ready).toBe(false);
    expect(runtime.snapshot().manifest.id).toBe(previous.snapshot.manifest.id);
    expect(previous.currentMedia.clear).not.toHaveBeenCalled();
    expect(mocks.stage.switchScene).not.toHaveBeenCalled();
    targetReady.resolve();
    await loading;
    expect(runtime.snapshot().manifest.id).toBe(replacement.manifest.id);
    expect(runtime.snapshot().video).toBe(replacement.video);
    expect(previous.currentMedia.dispose).toHaveBeenCalledTimes(1);
    expect(incoming.dispose).not.toHaveBeenCalled();
    expect(mocks.stage.setVideoBackground).toHaveBeenLastCalledWith(incoming.element);
    expect(runtime.state.mediaBusy).toBe(false);
    runtime.dispose();
    expect(incoming.dispose).toHaveBeenCalledTimes(1);
  });
  it("disposes superseded provisional owners without clearing a newer successful import", async () => {
    const previous = await currentStudy();
    const firstDecode = deferred<void>();
    mocks.mediaSetup = media => media.attach.mockReturnValueOnce(firstDecode.promise);
    const firstLoad = runtime.load(compositeProject("superseded-import"));
    const superseded = mocks.media;
    mocks.mediaSetup = undefined;
    const newest = compositeProject("newest-import");
    await runtime.load(newest);
    const active = mocks.media;
    expect(superseded.dispose).toHaveBeenCalledTimes(1);
    expect(previous.currentMedia.dispose).toHaveBeenCalledTimes(1);
    firstDecode.resolve();
    await firstLoad;
    superseded.fail("Stale owner callback");
    previous.currentMedia.fail("Disposed old owner callback");
    expect(runtime.snapshot().manifest.id).toBe(newest.manifest.id);
    expect(runtime.snapshot().video).toBe(newest.video);
    expect(mocks.stage.setVideoBackground).toHaveBeenLastCalledWith(active.element);
    expect(runtime.state.error).toBe("");
    expect(active.dispose).not.toHaveBeenCalled();
    expect(superseded.dispose).toHaveBeenCalledTimes(1);
  });
  it("disposes current and provisional videos when the studio closes during import", async () => {
    const previous = await currentStudy();
    const decoding = deferred<void>();
    mocks.mediaSetup = media => media.attach.mockReturnValueOnce(decoding.promise);
    const loading = runtime.load(compositeProject("closed-import"));
    const pending = mocks.media;
    runtime.dispose();
    expect(previous.currentMedia.dispose).toHaveBeenCalledTimes(1);
    expect(pending.dispose).toHaveBeenCalledTimes(1);
    decoding.resolve();
    await loading;
    expect(mocks.stage.switchScene).not.toHaveBeenCalled();
    expect(pending.dispose).toHaveBeenCalledTimes(1);
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
    await runtime.stopTake();
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
