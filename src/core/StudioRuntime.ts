import { createStage } from "../engine/StageEngine";
import {
  VisionController,
  type VisionStatus,
} from "../vision/VisionController";
import { CanvasRecorder } from "../export/recorder";
import { TakeVideo } from "../media/TakeVideo";
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
  composition: "abstract" | "video";
  hasVideo: boolean;
  mediaBusy: boolean;
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
  private fileNotice?: string;
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
  private media: TakeVideo;
  private pendingLoadMedia?: TakeVideo;
  private recordedVideo?: Blob;
  private videoNotice?: string;
  private videoInfo?: NonNullable<PrismProject["manifest"]["video"]>;
  private mediaGeneration = 0;
  private seekGeneration = 0;
  private inputStartedAt = 0;
  private recordStartedAt = 0;
  private recordingInputOffset = 0;
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
    composition: "abstract",
    hasVideo: false,
    mediaBusy: false,
  };
  constructor(
    private canvas: HTMLCanvasElement,
    private video: HTMLVideoElement,
    private onChange: (s: RuntimeState) => void,
  ) {
    this.media = this.createMedia();
    this.video.addEventListener("ended", this.videoEnded);
    this.vision = new VisionController(
      (sample) => {
        this.latest = sample;
        if (this.state.mode === "recording" && this.state.source !== "demo") {
          const t = sample.t - (this.state.source === "camera" ? this.recordingInputOffset : 0);
          const current = this.state.source === "video" ? this.video.currentTime : performance.now() / 1000 - this.recordStartedAt;
          if (t >= 0 && t <= Math.min(MAX_DURATION, current + 0.1)) {
            let undoCount = 0;
            for (let i = this.take.length - 1; i >= 0; i--) {
              if (this.take[i].t <= t) { undoCount = this.take[i].undoCount ?? 0; break; }
            }
            const recorded = { ...sample, t, undoCount,
              hands: sample.hands.map(hand => ({ ...hand })) };
            // Preserve observation time rather than shifting late inference to
            // arrival time. This keeps replayed hands aligned with source video.
            const index = this.take.findIndex(value => value.t > t);
            if (index < 0) this.take.push(recorded); else this.take.splice(index, 0, recorded);
            this.state.samples = this.take.length;
          }
        }
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
    const replayMedia = this.state.hasVideo && (this.state.mode === "replay" || this.state.mode === "exporting");
    if (this.state.playing && this.state.mode === "recording" && this.state.source !== "demo") {
      const target = this.state.source === "video" ? this.video.currentTime : performance.now() / 1000 - this.recordStartedAt;
      this.accumulator = Math.max(0, Math.min(MAX_DURATION, target) - this.state.time);
    } else if (this.state.playing && replayMedia) {
      this.accumulator = Math.max(0, Math.min(this.state.trimEnd, this.media.currentTime - (this.videoInfo?.offset ?? 0)) - this.state.time);
    } else this.accumulator += this.state.playing ? elapsed : 0;
    try {
      let count = 0;
      while (
        this.accumulator + 1e-9 >= FIXED_DT &&
        this.state.playing &&
        count++ < 9
      ) {
        this.tick();
        this.accumulator = Math.max(0, this.accumulator - FIXED_DT);
      }
      if (replayMedia && this.state.playing &&
          this.state.time > this.state.trimEnd - FIXED_DT + 1e-9 &&
          this.media.currentTime - (this.videoInfo?.offset ?? 0) >= this.state.trimEnd - 0.018) {
        if (this.frameNumber !== Math.round(this.state.trimEnd / FIXED_DT)) this.seek(this.state.trimEnd, false);
        this.state.time = this.state.trimEnd;
        this.state.playing = false;
        this.media.pause();
        if (this.state.mode === "exporting") void this.finishExport();
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
      if (this.state.mode === "recording" && this.state.source === "demo") {
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
      void this.stopTake();
    if (
      (this.state.mode === "replay" || this.state.mode === "exporting") &&
      this.state.time >= this.state.trimEnd
    ) {
      this.state.time = this.state.trimEnd;
      this.state.playing = false;
      this.media.pause();
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
    this.media.pause();
    this.state.playing = false;
    this.state.ready = false;
    this.notify();
    try {
      await this.stage.switchScene(scene, this.seed, params);
      if (this.disposed || generation !== this.generation) return;
      this.resetMedia();
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
    if (this.state.mode === "exporting" || (params.drawingMode !== undefined && this.state.mode === "recording")) return;
    const modeChanged = params.drawingMode !== undefined && params.drawingMode !== this.state.params.drawingMode;
    this.state.params = { ...this.state.params, ...params };
    if (params.drawingMode === "pinch") delete this.state.params.drawingMode;
    this.stage?.setParams(this.state.params);
    if (modeChanged && this.state.scene === "ribbon" && this.state.mode === "replay") this.seek(this.state.time, false);
    this.dirty = true;
    this.notify();
  }
  setComposition(composition: "abstract" | "video") {
    if (this.state.mode === "exporting" || this.state.mediaBusy) return;
    if (composition === "video" && !this.state.hasVideo) return;
    this.state.composition = composition;
    this.applyBackground();
    this.stage.render();
    this.notify();
  }
  private applyBackground() {
    const live = this.state.mode === "live" || this.state.mode === "recording";
    this.stage?.setVideoBackground?.(this.state.composition === "video" && this.state.hasVideo
      ? live ? this.video : this.media.element : null);
  }
  private createMedia(): TakeVideo {
    const media = new TakeVideo((message) => {
      // A provisional or disposed video cannot report errors into a newer take.
      if (this.disposed || this.media !== media) return;
      this.state.error = message;
      if (this.state.mode === "recording") void this.stopTake();
      this.notify();
    });
    return media;
  }
  private discardPendingLoadMedia() {
    this.pendingLoadMedia?.dispose();
    this.pendingLoadMedia = undefined;
  }
  private resetMedia() {
    this.mediaGeneration++;
    this.seekGeneration++;
    this.media.clear();
    this.recordedVideo = undefined;
    this.videoNotice = undefined;
    this.videoInfo = undefined;
    this.state.hasVideo = false;
    this.state.mediaBusy = false;
    this.state.composition = "abstract";
    this.stage?.setVideoBackground?.(null);
    this.stage?.setInputSourceSize?.(0, 0);
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
    if (file && file.size > 96 * 1024 * 1024) {
      this.fail(new Error("Choose a video smaller than 96 MB so it can be kept with your editable project."));
      return;
    }
    const fileNotice = file && file === this.file ? this.fileNotice : undefined;
    this.vision.stop();
    this.resetMedia();
    const generation = this.mediaGeneration;
    this.resetTake();
    this.state.source = source;
    this.state.mode = "live";
    if (this.state.scene === "ribbon") {
      const params = { ...this.state.params };
      if (source === "video") params.drawingMode = "follow";
      else delete params.drawingMode;
      this.state.params = params;
      this.stage.setParams(params);
    }
    this.state.playing = source !== "demo" || !this.reducedMotion;
    this.state.error = "";
    this.latest = { t: 0, hands: [], source };
    this.state.delegate = "";
    this.state.inferenceMs = 0;
    this.state.visionFps = 0;
    this.file = file;
    this.fileNotice = fileNotice;
    this.inputStartedAt = performance.now() / 1000;
    this.notify();
    try {
      if (source === "demo") {
        this.state.status = { state: "idle", message: "Demo motion" };
        this.prewarm();
      } else if (source === "camera")
        await this.vision.startCamera(this.state.scene, this.video);
      else if (file)
        await this.vision.startVideo(this.state.scene, this.video, file);
      if (generation !== this.mediaGeneration || this.disposed) return;
      if (source !== "demo") {
        if (source === "camera") this.inputStartedAt = this.vision.clockOriginSeconds ?? this.inputStartedAt;
        this.state.hasVideo = true;
        this.state.composition = "video";
        this.stage.setInputSourceSize?.(this.video.videoWidth, this.video.videoHeight);
        this.applyBackground();
      }
    } catch (error) {
      if (generation !== this.mediaGeneration || this.disposed) return;
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
    if (!this.state.ready || this.state.mode === "exporting" || this.state.mediaBusy) return;
    if (
      this.state.mode === "replay" &&
      this.state.source === "video" &&
      !this.file
    )
      throw new Error(
        "Choose a local video or camera before starting a new take.",
      );
    const drawingMode = this.state.params.drawingMode ?? "pinch";
    if (this.state.mode === "replay" && this.state.source !== "demo") {
      await this.setSource(
        this.state.source === "camera" ? "camera" : "video",
        this.file,
      );
      if (this.state.scene === "ribbon") this.setParams({ drawingMode });
    }
    if (this.state.source !== "demo" && this.state.status.state !== "ready")
      throw new Error(
        "Wait for the vision model to be ready before recording.",
      );
    this.media.pause();
    const generation = this.mediaGeneration;
    this.state.mediaBusy = true;
    this.state.playing = false;
    this.notify();
    try {
      if (this.state.source === "camera") await this.media.startCapture(this.video);
      if (generation !== this.mediaGeneration || this.disposed) return;
      this.resetTake();
      this.recordedVideo = undefined;
      this.videoNotice = undefined;
      this.videoInfo = undefined;
      this.latest = { t: 0, hands: [], source: this.state.source };
      this.recordStartedAt = performance.now() / 1000;
      this.recordingInputOffset = this.recordStartedAt - this.inputStartedAt;
      if (this.state.source !== "demo") this.take.push({ ...this.latest });
      this.state.mode = "recording";
      this.state.playing = true;
      this.accumulator = 0;
      this.lastWall = 0;
      if (this.state.source === "video") {
        this.video.currentTime = 0;
        await this.video.play();
      }
      this.applyBackground();
    } catch (error) {
      this.media.cancelCapture();
      throw error;
    } finally {
      if (generation === this.mediaGeneration) this.state.mediaBusy = false;
      this.notify();
    }
  }
  async stopTake() {
    if (this.state.mode !== "recording") return;
    const source = this.state.source;
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    const sourceDuration = this.video.duration;
    const generation = this.mediaGeneration;
    this.state.duration = Math.min(MAX_DURATION, this.state.time,
      source === "video" && Number.isFinite(sourceDuration) ? sourceDuration : MAX_DURATION);
    this.state.trimStart = 0;
    this.state.trimEnd = this.state.duration;
    this.state.mode = "replay";
    this.state.playing = false;
    this.state.mediaBusy = source !== "demo";
    this.notify();
    try {
      const blob = source === "camera" ? await this.media.stopCapture()
        : source === "video" ? this.file : undefined;
      if (generation !== this.mediaGeneration || this.disposed) return;
      this.vision.stop();
      if (blob) {
        await this.media.attach(blob);
        if (generation !== this.mediaGeneration || this.disposed) return;
        this.recordedVideo = blob;
        this.videoNotice = source === "video" ? this.fileNotice : undefined;
        const mimeType = blob.type.split(";")[0];
        if (mimeType !== "video/mp4" && mimeType !== "video/webm")
          throw new Error("Keep source footage as MP4 or WebM for editable video projects.");
        this.videoInfo = { mimeType,
          width: this.media.element.videoWidth || width,
          height: this.media.element.videoHeight || height,
          duration: Number.isFinite(this.media.duration) && this.media.duration > 0 ? this.media.duration : this.state.duration,
          offset: 0 };
        this.state.duration = Math.min(this.state.duration, this.videoInfo.duration);
        this.state.trimEnd = this.state.duration;
        this.state.hasVideo = true;
        this.stage.setInputSourceSize?.(this.videoInfo.width, this.videoInfo.height);
        this.applyBackground();
        await this.media.seek(Math.min(this.state.duration, this.videoInfo.duration));
        if (generation !== this.mediaGeneration || this.disposed) return;
      } else {
        this.state.hasVideo = false;
        this.state.composition = "abstract";
        this.applyBackground();
      }
      this.take = this.take.filter(sample => sample.t <= this.state.duration);
      this.state.samples = this.take.length;
      this.state.time = this.state.duration;
      this.stage.render();
    } catch (error) {
      if (generation === this.mediaGeneration) {
        this.vision.stop();
        this.recordedVideo = undefined;
        this.videoNotice = undefined;
        this.videoInfo = undefined;
        this.state.hasVideo = false;
        this.state.composition = "abstract";
        this.applyBackground();
        this.fail(error);
      }
    } finally {
      if (generation === this.mediaGeneration) this.state.mediaBusy = false;
      this.notify();
    }
  }
  togglePlay() {
    if (this.state.mode === "recording") {
      this.stopTake();
      return;
    }
    if (this.state.mode === "exporting" || this.state.mediaBusy) return;
    if (
      this.state.mode === "replay" &&
      this.state.time >= this.state.trimEnd - 0.02
    )
      this.seek(this.state.trimStart, false);
    this.state.playing = !this.state.playing;
    if (this.state.hasVideo && this.state.mode === "replay") {
      if (this.state.playing) void this.playMedia(); else this.media.pause();
    } else if (this.state.source === "video" && this.state.mode === "live") {
      if (this.state.playing) void this.video.play(); else this.video.pause();
    }
    this.accumulator = 0;
    this.notify();
  }
  replay() {
    if (!this.take.length || this.state.mediaBusy) return;
    this.state.mode = "replay";
    this.seek(this.state.trimStart, false);
    this.state.playing = true;
    if (this.state.hasVideo) void this.playMedia();
    this.notify();
  }
  seek(target: number, syncVideo = true) {
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
    if (syncVideo && this.state.hasVideo) void this.syncMedia(t);
    this.notify();
  }
  private async syncMedia(time: number) {
    const generation = ++this.seekGeneration;
    this.state.mediaBusy = true;
    this.notify();
    try {
      this.media.pause();
      await this.media.seek((this.videoInfo?.offset ?? 0) + time);
      if (generation !== this.seekGeneration || this.disposed) return;
      this.stage.render();
      if (this.state.playing) await this.media.play();
    } catch (error) {
      if (generation === this.seekGeneration && (error as Error)?.name !== "AbortError") {
        this.state.playing = false;
        this.fail(error);
      }
    } finally {
      if (generation === this.seekGeneration && !this.disposed) {
        this.state.mediaBusy = false;
        this.notify();
      }
    }
  }
  private async playMedia() {
    await this.syncMedia(this.state.time);
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
      if (this.state.mode === "recording" && this.state.source !== "demo") {
        const time = this.state.source === "video" ? this.video.currentTime : performance.now() / 1000 - this.recordStartedAt;
        this.take.push({ ...this.latest, t: Math.min(MAX_DURATION, Math.max(0, time)), undoCount: this.undoCount,
          hands: this.latest.hands.map(hand => ({ ...hand })) });
        this.state.samples = this.take.length;
      }
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
    if (this.state.mediaBusy) throw new Error("Wait for the source video to finish saving.");
    if (!this.take.length || this.state.duration < 0.1)
      throw new Error("Record a take first to save an editable project.");
    if (name?.trim()) this.projectName = name.trim();
    const version = this.recordedVideo && this.videoInfo || this.state.params.drawingMode !== undefined ? 2 : 1;
    return {
      manifest: {
        format: "prism-stage",
        version,
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
        ...(version === 2 ? { composition: this.state.composition } : {}),
        ...(this.recordedVideo && this.videoInfo ? {
          composition: this.state.composition, video: { ...this.videoInfo },
        } : {}),
      },
      samples: this.take,
      thumbnail: this.thumbnail(),
      ...(this.recordedVideo ? { video: this.recordedVideo } : {}),
      ...(this.recordedVideo && this.videoNotice ? { videoNotice: this.videoNotice } : {}),
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
    this.discardPendingLoadMedia();
    this.mediaGeneration++;
    this.seekGeneration++;
    this.vision.stop();
    this.media.pause();
    this.state.playing = false;
    this.state.ready = false;
    this.state.mediaBusy = false;
    this.notify();
    let prepared: TakeVideo | undefined;
    try {
      const m = project.manifest;
      const previewTime = Math.min(
        m.trim.end,
        m.trim.start + Math.min(5, (m.trim.end - m.trim.start) / 2),
      );
      if (project.video && m.video) {
        prepared = this.createMedia();
        this.pendingLoadMedia = prepared;
        await prepared.attach(project.video);
        if (this.disposed || generation !== this.generation) return;
        if (prepared.element.videoWidth !== m.video.width || prepared.element.videoHeight !== m.video.height ||
            !Number.isFinite(prepared.duration) || prepared.duration + 0.1 < m.video.offset + m.duration)
          throw new Error("The saved source video does not match its dimensions or recording duration.");
        // Decode the exact frame used by fixed-step reconstruction before replacing
        // the current session. A native seek failure must not discard unsaved work.
        await prepared.seek(m.video.offset + Math.round(previewTime / FIXED_DT) * FIXED_DT);
        if (this.disposed || generation !== this.generation) return;
      }
      await this.stage.switchScene(m.scene, m.seed, m.params);
      if (this.disposed || generation !== this.generation) return;
      // Everything that can reject during native video preparation or stage
      // initialization has completed. Transfer ownership only at this commit.
      const previousMedia = this.media;
      this.resetMedia();
      if (prepared) {
        this.media = prepared;
        this.pendingLoadMedia = undefined;
        previousMedia.dispose();
      }
      this.pendingScene = undefined;
      this.state.scene = m.scene;
      this.seed = m.seed;
      this.state.params = { ...m.params };
      this.file = undefined;
      this.fileNotice = undefined;
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
        status: { state: "idle", message: "Recorded input" },
        error: "",
      });
      if (prepared && project.video && m.video) {
        this.recordedVideo = project.video;
        this.videoNotice = project.videoNotice;
        this.videoInfo = { ...m.video };
        this.state.hasVideo = true;
        this.state.composition = m.composition ?? "video";
        if (m.source === "video") {
          this.file = new File([project.video], `source.${m.video.mimeType === "video/mp4" ? "mp4" : "webm"}`, { type: m.video.mimeType });
          this.fileNotice = project.videoNotice;
        }
        this.stage.setInputSourceSize?.(m.video.width, m.video.height);
      }
      this.state.ready = true;
      this.applyBackground();
      this.setAspect(m.aspect);
      this.seek(previewTime, false);
      this.state.playing = false;
      this.notify();
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.state.ready = true;
      this.fail(error);
      throw error;
    } finally {
      if (prepared && this.pendingLoadMedia === prepared)
        this.discardPendingLoadMedia();
    }
  }
  exportVideo(): Promise<{ blob: Blob; extension: string }> {
    if (this.state.mediaBusy) return Promise.reject(new Error("Wait for the source video to finish saving."));
    if (!this.take.length || this.state.duration < 0.1)
      return Promise.reject(
        new Error("Record or open a take before exporting video."),
      );
    if (this.recording)
      return Promise.reject(new Error("An export is already running."));
    this.vision.stop();
    this.state.mode = "exporting";
    this.state.playing = false;
    this.media.pause();
    this.stage.setParams({ ...this.state.params, quality: "high" });
    this.seek(this.state.trimStart, false);
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
          if (this.state.hasVideo) {
            this.seekGeneration++;
            await this.media.seek((this.videoInfo?.offset ?? 0) + this.state.trimStart);
            if (this.disposed || this.recording !== recorder) return;
            this.applyBackground();
            this.stage.render();
          }
          await recorder.start((message) => this.abortExport(message));
          if (this.disposed || this.recording !== recorder) return;
          this.stage.render();
          this.recording.captureFrame(true);
          if (this.state.hasVideo) await this.media.play();
          if (this.disposed || this.recording !== recorder) return;
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
      this.media.pause();
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
    this.media.pause();
    this.seekGeneration++;
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
    if (this.state.hasVideo && this.state.mode === "replay") {
      await this.media.seek((this.videoInfo?.offset ?? 0) + this.state.time);
    }
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
    this.mediaGeneration++;
    this.seekGeneration++;
    this.discardPendingLoadMedia();
    this.media.dispose();
    this.generation++;
    cancelAnimationFrame(this.raf);
    this.video.removeEventListener("ended", this.videoEnded);
    this.vision.dispose();
    this.recording?.cancel();
    this.stage?.dispose();
  }
}
