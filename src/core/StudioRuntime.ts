import { createStage } from "../engine/StageEngine";
import {
  VisionController,
  type VisionStatus,
} from "../vision/VisionController";
import { CanvasRecorder } from "../export/recorder";
import { demoSample } from "./demo";
import { DEFAULT_PARAMS, PRESETS } from "./presets";
import {
  DEFAULT_SEED,
  FIXED_DT,
  MAX_DURATION,
  type InputSample,
  type PrismProject,
  type SceneId,
  type SourceKind,
  type StageEngine,
  type VisualParams,
} from "./types";

export interface RuntimeState {
  ready: boolean;
  scene: SceneId;
  source: SourceKind;
  mode: "live" | "recording" | "replay" | "exporting";
  playing: boolean;
  time: number;
  duration: number;
  fps: number;
  inferenceMs: number;
  visionFps: number;
  status: VisionStatus;
  params: VisualParams;
  samples: number;
  error: string;
  aspect: "landscape" | "portrait";
  trimStart: number;
  trimEnd: number;
  delegate: string;
  quality: string;
}
export class StudioRuntime {
  private stage!: StageEngine;
  private vision: VisionController;
  private raf = 0;
  private disposed = false;
  private lastWall = 0;
  private accumulator = 0;
  private lastNotify = 0;
  private frameCount = 0;
  private fpsWall = 0;
  private latest: InputSample = { t: 0, hands: [], source: "demo" };
  private take: InputSample[] = [];
  private lastMask: InputSample["mask"];
  private playbackIndex = 0;
  private undoCount = 0;
  private seed = DEFAULT_SEED;
  private file: File | undefined;
  private recording: CanvasRecorder | undefined;
  private exportResolve:
    ((value: { blob: Blob; extension: string }) => void) | undefined;
  private exportReject: ((reason: Error) => void) | undefined;
  private exportEnding = false;
  private generation = 0;
  private pendingScene: SceneId | undefined;
  private reducedMotion = false;
  private dirty = true;
  private frameNumber = 0;
  private videoEnded = () => {
    if (this.state.mode === "recording") this.stopTake();
  };
  private projectId: string = crypto.randomUUID();
  private projectName = "Untitled study";
  readonly state: RuntimeState = {
    ready: false,
    scene: "ribbon",
    source: "demo",
    mode: "live",
    playing: true,
    time: 0,
    duration: 0,
    fps: 0,
    inferenceMs: 0,
    visionFps: 0,
    status: { state: "idle", message: "Demo motion" },
    params: { ...DEFAULT_PARAMS },
    samples: 0,
    error: "",
    aspect: "landscape",
    trimStart: 0,
    trimEnd: 0,
    delegate: "",
    quality: "auto",
  };
  constructor(
    private canvas: HTMLCanvasElement,
    private video: HTMLVideoElement,
    private onChange: (s: RuntimeState) => void,
  ) {
    this.video.addEventListener("ended", this.videoEnded);
    this.vision = new VisionController(
      (sample) => {
        this.latest = sample;
      },
      (status) => {
        this.state.status = status;
        if (status.inferenceMs !== undefined)
          this.state.inferenceMs = status.inferenceMs;
        if (status.fps !== undefined) this.state.visionFps = status.fps;
        if (status.delegate) this.state.delegate = status.delegate;
        if (status.state === "error") {
          this.state.error = status.message;
          this.latest = { t: 0, hands: [], source: this.state.source };
          if (this.state.mode === "recording") this.stopTake();
        }
        this.notify();
      },
    );
  }
  async init() {
    try {
      this.stage = await createStage(this.canvas);
      if (this.disposed) {
        this.stage.dispose();
        return;
      }
      await this.stage.switchScene(
        this.state.scene,
        this.seed,
        this.state.params,
      );
      this.stage.resize(1280, 720);
      this.state.ready = true;
      this.prewarm();
      this.notify();
      this.raf = requestAnimationFrame(this.frame);
    } catch (error) {
      this.fail(error);
    }
  }
  private notify() {
    if (!this.disposed)
      this.onChange({ ...this.state, params: { ...this.state.params } });
  }
  private fail(error: unknown) {
    this.state.error = error instanceof Error ? error.message : String(error);
    this.notify();
  }
  clearError() {
    this.state.error = "";
    this.notify();
  }
  private prewarm() {
    for (let i = 0; i < 360; i++) {
      const t = i * FIXED_DT;
      this.stage.step(FIXED_DT, t, demoSample(this.state.scene, t));
    }
    this.frameNumber = 360;
    this.state.time = 6;
    this.stage.render();
  }
  private frame = (wall: number) => {
    if (this.disposed) return;
    const elapsed = this.lastWall
      ? Math.min((wall - this.lastWall) / 1000, 0.15)
      : 0;
    this.lastWall = wall;
    this.accumulator += this.state.playing ? elapsed : 0;
    try {
      let count = 0;
      while (
        this.accumulator >= FIXED_DT &&
        this.state.playing &&
        count++ < 9
      ) {
        this.tick();
        this.accumulator -= FIXED_DT;
      }
      if (this.stage && (this.state.playing || this.dirty)) {
        this.stage.render();
        if (this.state.mode === "exporting") this.recording?.captureFrame();
        this.frameCount++;
        this.dirty = false;
      }
      if (wall - this.fpsWall > 1000) {
        this.state.fps = Math.round(
          (this.frameCount * 1000) / (wall - this.fpsWall),
        );
        this.frameCount = 0;
        this.fpsWall = wall;
        this.state.quality = this.stage?.getStats().quality ?? "auto";
      }
      if (wall - this.lastNotify > 120) {
        this.lastNotify = wall;
        this.notify();
      }
    } catch (error) {
      this.state.playing = false;
      this.fail(error);
      if (this.recording)
        this.abortExport("Rendering stopped. Please retry at a lower quality.");
    }
    this.raf = requestAnimationFrame(this.frame);
  };
  private tick() {
    const t = this.frameNumber * FIXED_DT;
    let input: InputSample;
    if (this.state.mode === "replay" || this.state.mode === "exporting") {
      while (
        this.playbackIndex + 1 < this.take.length &&
        this.take[this.playbackIndex + 1].t <= t + 1e-7
      )
        this.playbackIndex++;
      input = this.take[this.playbackIndex] ?? {
        t,
        hands: [],
        source: "replay",
      };
    } else {
      input =
        this.state.source === "demo"
          ? demoSample(this.state.scene, t)
          : this.latest;
      input = {
        ...input,
        t,
        source: this.state.source,
        undoCount: this.undoCount,
      };
      if (this.state.mode === "recording") {
        // Keep every hand step and only distinct mask frames; reuse immutable masks during playback.
        if (
          this.state.scene !== "portal" ||
          input.mask !== this.lastMask ||
          !this.take.length
        ) {
          this.take.push({
            ...input,
            hands: input.hands.map((h) => ({ ...h })),
          });
          this.lastMask = input.mask;
        }
        this.state.samples = this.take.length;
      }
    }
    this.stage.step(FIXED_DT, t, input);
    this.dirty = true;
    this.frameNumber++;
    this.state.time = this.frameNumber * FIXED_DT;
    if (this.state.mode === "recording" && this.state.time >= MAX_DURATION)
      this.stopTake();
    if (
      (this.state.mode === "replay" || this.state.mode === "exporting") &&
      this.state.time >= this.state.trimEnd
    ) {
      this.state.time = this.state.trimEnd;
      this.state.playing = false;
      if (this.state.mode === "exporting") void this.finishExport();
    }
  }
  async setScene(scene: SceneId) {
    if (!this.state.ready || this.state.mode === "exporting") return;
    const generation = ++this.generation;
    const params: VisualParams = {
      ...DEFAULT_PARAMS,
      ...PRESETS[scene][0].params,
      palette: PRESETS[scene][0].palette,
    };
    this.pendingScene = scene;
    this.vision.stop();
    this.state.playing = false;
    this.state.ready = false;
    this.notify();
    try {
      await this.stage.switchScene(scene, this.seed, params);
      if (this.disposed || generation !== this.generation) return;
      this.state.scene = scene;
      this.state.params = params;
      this.pendingScene = undefined;
      this.state.error = "";
      this.resetTake();
      this.state.source = "demo";
      this.state.mode = "live";
      this.state.playing = !this.reducedMotion;
      this.state.ready = true;
      this.state.status = { state: "idle", message: "Demo motion" };
      this.prewarm();
      this.notify();
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.state.ready = true;
      this.fail(error);
    }
  }
  setParams(params: Partial<VisualParams>) {
    this.state.params = { ...this.state.params, ...params };
    this.stage?.setParams(this.state.params);
    this.dirty = true;
    this.notify();
  }
  setAspect(aspect: "landscape" | "portrait") {
    if (this.state.mode === "exporting") return;
    this.state.aspect = aspect;
    this.stage.resize(
      aspect === "landscape" ? 1280 : 720,
      aspect === "landscape" ? 720 : 1280,
    );
    this.stage.render();
    this.notify();
  }
  setReducedMotion(reduced: boolean) {
    this.reducedMotion = reduced;
    if (reduced && this.state.source === "demo" && this.state.mode === "live") {
      this.state.playing = false;
      this.notify();
    }
  }
  private resetTake() {
    this.take = [];
    this.lastMask = undefined;
    this.playbackIndex = 0;
    this.undoCount = 0;
    this.frameNumber = 0;
    this.state.time = 0;
    this.state.duration = 0;
    this.state.samples = 0;
    this.state.trimStart = 0;
    this.state.trimEnd = 0;
    this.projectId = crypto.randomUUID();
    this.projectName = "Untitled study";
    this.accumulator = 0;
    this.stage.reset(this.seed);
    this.dirty = true;
  }
  async setSource(source: "demo" | "camera" | "video", file?: File) {
    if (!this.state.ready || this.state.mode === "exporting") return;
    this.vision.stop();
    this.resetTake();
    this.state.source = source;
    this.state.mode = "live";
    this.state.playing = source !== "demo" || !this.reducedMotion;
    this.state.error = "";
    this.latest = { t: 0, hands: [], source };
    this.state.delegate = "";
    this.state.inferenceMs = 0;
    this.state.visionFps = 0;
    this.file = file;
    this.notify();
    try {
      if (source === "demo") {
        this.state.status = { state: "idle", message: "Demo motion" };
        this.prewarm();
      } else if (source === "camera")
        await this.vision.startCamera(this.state.scene, this.video);
      else if (file)
        await this.vision.startVideo(this.state.scene, this.video, file);
    } catch (error) {
      this.fail(error);
    }
    this.notify();
  }
  async retrySource() {
    if (this.pendingScene) {
      await this.setScene(this.pendingScene);
      return;
    }
    if (!this.state.ready) {
      this.stage?.dispose();
      await this.init();
      return;
    }
    await this.setSource(
      this.state.source === "video"
        ? "video"
        : this.state.source === "camera"
          ? "camera"
          : "demo",
      this.file,
    );
  }
  async startTake() {
    if (!this.state.ready || this.state.mode === "exporting") return;
    if (
      this.state.mode === "replay" &&
      this.state.source === "video" &&
      !this.file
    )
      throw new Error(
        "Choose a local video or Demo before starting a new take. Original video is not stored in a project.",
      );
    if (this.state.mode === "replay" && this.state.source !== "demo")
      await this.setSource(
        this.state.source === "camera" ? "camera" : "video",
        this.file,
      );
    if (this.state.source !== "demo" && this.state.status.state !== "ready")
      throw new Error(
        "Wait for the vision model to be ready before recording.",
      );
    this.resetTake();
    this.latest = { t: 0, hands: [], source: this.state.source };
    this.state.mode = "recording";
    this.state.playing = true;
    if (this.state.source === "video") {
      this.video.currentTime = 0;
      void this.video.play();
    }
    this.notify();
  }
  stopTake() {
    if (this.state.mode !== "recording") return;
    this.state.duration = Math.min(MAX_DURATION, this.state.time);
    this.state.trimStart = 0;
    this.state.trimEnd = this.state.duration;
    this.state.mode = "replay";
    this.state.playing = false;
    this.vision.stop();
    this.notify();
  }
  togglePlay() {
    if (this.state.mode === "recording") {
      this.stopTake();
      return;
    }
    if (this.state.mode === "exporting") return;
    if (
      this.state.mode === "replay" &&
      this.state.time >= this.state.trimEnd - 0.02
    )
      this.seek(this.state.trimStart);
    this.state.playing = !this.state.playing;
    this.accumulator = 0;
    this.notify();
  }
  replay() {
    if (!this.take.length) return;
    this.state.mode = "replay";
    this.seek(this.state.trimStart);
    this.state.playing = true;
    this.notify();
  }
  seek(target: number) {
    if (!this.take.length) return;
    const targetFrame = Math.round(
      Math.max(0, Math.min(this.state.duration, target)) / FIXED_DT,
    );
    const t = targetFrame * FIXED_DT;
    this.stage.reset(this.seed);
    this.playbackIndex = 0;
    this.state.time = 0;
    for (let step = 0; step < targetFrame; step++) {
      const time = step * FIXED_DT;
      while (
        this.playbackIndex + 1 < this.take.length &&
        this.take[this.playbackIndex + 1].t <= time + 1e-7
      )
        this.playbackIndex++;
      this.stage.step(FIXED_DT, time, this.take[this.playbackIndex]);
    }
    this.frameNumber = targetFrame;
    this.state.time = t;
    this.accumulator = 0;
    this.stage.render();
    this.notify();
  }
  setTrim(start: number, end: number) {
    this.state.trimStart = Math.max(
      0,
      Math.min(start, this.state.duration - 0.1),
    );
    this.state.trimEnd = Math.min(
      this.state.duration,
      Math.max(end, this.state.trimStart + 0.1),
    );
    this.notify();
  }
  undo() {
    if (
      this.state.scene === "ribbon" &&
      this.state.mode !== "replay" &&
      this.state.mode !== "exporting"
    ) {
      this.undoCount++;
      this.notify();
    }
  }
  clear() {
    if (this.state.mode === "exporting") return;
    if (this.state.mode === "replay" && this.state.source !== "demo") {
      void (this.state.source === "video" && !this.file
        ? this.setSource("demo")
        : this.retrySource());
      return;
    }
    this.resetTake();
    this.state.mode = "live";
    this.state.playing = this.state.source !== "demo" || !this.reducedMotion;
    this.notify();
  }
  snapshot(name?: string): PrismProject {
    if (!this.take.length || this.state.duration < 0.1)
      throw new Error("Record a take first to save an editable project.");
    if (name?.trim()) this.projectName = name.trim();
    return {
      manifest: {
        format: "prism-stage",
        version: 1,
        engineVersion: "1.0.0",
        id: this.projectId,
        name: this.projectName,
        scene: this.state.scene,
        createdAt: new Date().toISOString(),
        seed: this.seed,
        fixedDt: FIXED_DT,
        duration: this.state.duration,
        params: { ...this.state.params },
        trim: { start: this.state.trimStart, end: this.state.trimEnd },
        aspect: this.state.aspect,
        source: this.state.source,
      },
      samples: this.take,
      thumbnail: this.thumbnail(),
    };
  }
  private thumbnail() {
    const small = document.createElement("canvas");
    small.width = 320;
    small.height = 180;
    small.getContext("2d")!.drawImage(this.canvas, 0, 0, 320, 180);
    return small.toDataURL("image/png");
  }
  async load(project: PrismProject) {
    const generation = ++this.generation;
    this.vision.stop();
    this.state.playing = false;
    this.state.ready = false;
    this.notify();
    try {
      const m = project.manifest;
      await this.stage.switchScene(m.scene, m.seed, m.params);
      if (this.disposed || generation !== this.generation) return;
      this.pendingScene = undefined;
      this.state.scene = m.scene;
      this.seed = m.seed;
      this.state.params = { ...m.params };
      this.file = undefined;
      this.take = project.samples;
      this.projectId = m.id;
      this.projectName = m.name;
      Object.assign(this.state, {
        source: m.source,
        mode: "replay",
        duration: m.duration,
        samples: this.take.length,
        trimStart: m.trim.start,
        trimEnd: m.trim.end,
        ready: true,
        status: { state: "idle", message: "Recorded input" },
        error: "",
      });
      this.setAspect(m.aspect);
      this.seek(
        Math.min(
          m.trim.end,
          m.trim.start + Math.min(5, (m.trim.end - m.trim.start) / 2),
        ),
      );
      this.state.playing = false;
      this.notify();
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.state.ready = true;
      this.fail(error);
      throw error;
    }
  }
  exportVideo(): Promise<{ blob: Blob; extension: string }> {
    if (!this.take.length || this.state.duration < 0.1)
      return Promise.reject(
        new Error("Record or open a take before exporting video."),
      );
    if (this.recording)
      return Promise.reject(new Error("An export is already running."));
    this.vision.stop();
    this.state.mode = "exporting";
    this.state.playing = false;
    this.stage.setParams({ ...this.state.params, quality: "high" });
    this.seek(this.state.trimStart);
    this.stage.render();
    return new Promise((resolve, reject) => {
      this.exportResolve = resolve;
      this.exportReject = reject;
      this.exportEnding = false;
      const begin = async () => {
        let recorder: CanvasRecorder | undefined;
        try {
          recorder = new CanvasRecorder(this.canvas);
          this.recording = recorder;
          await recorder.start((message) => this.abortExport(message));
          if (this.disposed || this.recording !== recorder) return;
          this.stage.render();
          this.recording.captureFrame(true);
          this.state.playing = true;
          this.accumulator = 0;
          this.lastWall = 0;
          this.notify();
        } catch (error) {
          if (recorder && this.recording !== recorder) return;
          this.abortExport(
            error instanceof Error ? error.message : String(error),
          );
        }
      };
      void begin();
    });
  }
  private async finishExport() {
    if (!this.recording || this.exportEnding) return;
    this.exportEnding = true;
    const recorder = this.recording;
    const resolve = this.exportResolve;
    const reject = this.exportReject;
    try {
      this.stage.render();
      recorder.captureFrame(true);
      const blob = await recorder.stop();
      if (this.recording !== recorder) return;
      resolve?.({ blob, extension: recorder.extension });
    } catch (error) {
      if (this.recording !== recorder) return;
      reject?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (this.recording !== recorder) return;
      this.recording = undefined;
      this.exportResolve = undefined;
      this.exportReject = undefined;
      this.stage.setParams(this.state.params);
      this.dirty = true;
      this.stage.render();
      this.state.mode = "replay";
      this.state.playing = false;
      this.notify();
    }
  }
  abortExport(message = "Export canceled.") {
    if (!this.recording && this.state.mode !== "exporting") return;
    this.recording?.cancel();
    this.recording = undefined;
    this.exportReject?.(new Error(message));
    this.exportResolve = undefined;
    this.exportReject = undefined;
    this.stage.setParams(this.state.params);
    this.dirty = true;
    this.stage.render();
    this.state.mode = "replay";
    this.state.playing = false;
    this.notify();
  }
  async capturePng(): Promise<Blob> {
    this.stage.setParams({ ...this.state.params, quality: "high" });
    this.stage.render();
    try {
      return await new Promise<Blob>((resolve, reject) =>
        this.canvas.toBlob(
          (blob) =>
            blob ? resolve(blob) : reject(new Error("PNG encoding failed.")),
          "image/png",
        ),
      );
    } finally {
      this.stage.setParams(this.state.params);
      this.dirty = true;
      this.stage.render();
    }
  }
  getCanvas() {
    return this.canvas;
  }
  getStats() {
    return this.stage?.getStats();
  }
  dispose() {
    if (this.recording)
      this.abortExport("The studio was closed during video export.");
    this.disposed = true;
    this.generation++;
    cancelAnimationFrame(this.raf);
    this.video.removeEventListener("ended", this.videoEnded);
    this.vision.dispose();
    this.recording?.cancel();
    this.stage?.dispose();
  }
}
