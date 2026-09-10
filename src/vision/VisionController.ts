import type { InputSample, SceneId, SourceKind } from "../core/types";
import type { Delegate, WorkerRequest, WorkerResponse } from "./protocol";

export interface VisionStatus {
  state: "idle" | "loading" | "ready" | "error";
  message: string;
  delegate?: Delegate;
  inferenceMs?: number;
  fps?: number;
}
const aborted = () => new DOMException("Input was stopped.", "AbortError");
const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Owns live capture and model inference. The studio compositor also reads the local source video. */
export class VisionController {
  private worker?: Worker;
  private stream?: MediaStream;
  private video?: HTMLVideoElement;
  private objectUrl?: string;
  private videoFrameId?: number;
  private animationFrameId?: number;
  private initializingCancel?: () => void;
  private frameTimeout?: ReturnType<typeof setTimeout>;
  private handlers: Array<() => void> = [];
  private session = 0;
  private epoch = 0;
  private busy = false;
  private ready = false;
  private disposed = false;
  private scene: SceneId = "ribbon";
  private source: SourceKind = "camera";
  private delegate: Delegate = "GPU";
  private startedAt = 0;
  private lastModelTimestamp = 0;
  private lastSourceTime = -1;
  private sample?: InputSample;
  private measuredAt = 0;
  private measuredFrames = 0;
  private reportedAt = 0;
  private gpuFrames = 0;
  private slowGpuFrames = 0;

  constructor(
    private onSample: (sample: InputSample) => void,
    private onStatus: (status: VisionStatus) => void,
  ) {}

  /** performance.now() clock origin used by camera InputSample.t, in seconds. */
  get clockOriginSeconds(): number {
    return this.startedAt / 1000;
  }

  async startCamera(scene: SceneId, video: HTMLVideoElement): Promise<void> {
    const session = this.prepare(scene, video, "camera");
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error(
          "Camera needs HTTPS or localhost and a supported browser.",
        );
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
          facingMode: "user",
        },
      });
      if (this.session !== session) {
        stream.getTracks().forEach((track) => track.stop());
        throw aborted();
      }
      this.stream = stream;
      video.srcObject = stream;
      await video.play();
      if (this.session !== session) throw aborted();
      for (const track of stream.getVideoTracks()) {
        const ended = () =>
          this.fail(
            new Error(
              "Camera disconnected. Reconnect it and choose Start camera again.",
            ),
            session,
          );
        track.addEventListener("ended", ended);
        this.handlers.push(() => track.removeEventListener("ended", ended));
      }
      await this.startWorker(session, "GPU");
      this.beginFrames(session);
    } catch (error) {
      if (this.session === session) this.fail(error, session);
      throw error;
    }
  }

  async startVideo(
    scene: SceneId,
    video: HTMLVideoElement,
    file: File,
  ): Promise<void> {
    const session = this.prepare(scene, video, "video");
    try {
      if (file.size > 512 * 1024 * 1024)
        throw new Error("Choose a video smaller than 512 MB.");
      this.objectUrl = URL.createObjectURL(file);
      video.srcObject = null;
      video.src = this.objectUrl;
      video.loop = false;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            finish(
              new Error("Video could not be decoded. Try H.264 MP4 or WebM."),
            ),
          15000,
        );
        const loaded = () => finish();
        const failed = () =>
          finish(
            new Error(
              "This video format cannot be decoded by your browser. Try H.264 MP4 or WebM.",
            ),
          );
        const cancel = () => finish(aborted());
        const finish = (error?: Error) => {
          clearTimeout(timer);
          video.removeEventListener("loadedmetadata", loaded);
          video.removeEventListener("error", failed);
          this.handlers = this.handlers.filter((handler) => handler !== cancel);
          if (error) reject(error);
          else resolve();
        };
        video.addEventListener("loadedmetadata", loaded, { once: true });
        video.addEventListener("error", failed, { once: true });
        this.handlers.push(cancel);
        video.load();
      });
      if (this.session !== session) throw aborted();
      await this.startWorker(session, "GPU");
      if (this.session !== session) throw aborted();
      const reset = () => this.resetTracking();
      const release = () => this.releaseHands();
      video.addEventListener("seeking", reset);
      video.addEventListener("pause", release);
      video.addEventListener("ended", release);
      this.handlers.push(
        () => video.removeEventListener("seeking", reset),
        () => video.removeEventListener("pause", release),
        () => video.removeEventListener("ended", release),
      );
      await video.play();
      this.beginFrames(session);
    } catch (error) {
      if (this.session === session) this.fail(error, session);
      throw error;
    }
  }

  stop(): void {
    this.session++;
    this.epoch++;
    this.ready = false;
    this.initializingCancel?.();
    this.initializingCancel = undefined;
    this.clearWorker();
    if (this.videoFrameId !== undefined)
      this.video?.cancelVideoFrameCallback?.(this.videoFrameId);
    if (this.animationFrameId !== undefined)
      cancelAnimationFrame(this.animationFrameId);
    this.videoFrameId = undefined;
    this.animationFrameId = undefined;
    const handlers = this.handlers;
    this.handlers = [];
    handlers.forEach((remove) => remove());
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video.removeAttribute("src");
      this.video.load();
    }
    this.video = undefined;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
    this.busy = false;
    if (this.sample)
      this.onSample({ t: this.sample.t, hands: [], source: this.source });
    this.sample = undefined;
    if (!this.disposed)
      this.onStatus({
        state: "idle",
        message: "Camera and video input stopped.",
      });
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private prepare(
    scene: SceneId,
    video: HTMLVideoElement,
    source: SourceKind,
  ): number {
    if (this.disposed) throw new Error("Vision input has been disposed.");
    this.stop();
    this.scene = scene;
    this.source = source;
    this.video = video;
    video.muted = true;
    video.playsInline = true;
    this.startedAt = performance.now();
    this.lastSourceTime = -1;
    this.lastModelTimestamp = 0;
    this.measuredAt = performance.now();
    this.measuredFrames = 0;
    this.reportedAt = 0;
    this.onStatus({
      state: "loading",
      message: source === "camera" ? "Opening camera…" : "Opening local video…",
    });
    return this.session;
  }

  private clearWorker(): void {
    clearTimeout(this.frameTimeout);
    this.frameTimeout = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    this.busy = false;
  }

  private async startWorker(
    session: number,
    delegate: Delegate,
  ): Promise<void> {
    this.clearWorker();
    this.ready = false;
    this.delegate = delegate;
    this.gpuFrames = 0;
    this.slowGpuFrames = 0;
    this.onStatus({
      state: "loading",
      delegate,
      inferenceMs: 0,
      fps: 0,
      message:
        delegate === "GPU"
          ? "Loading local vision model…"
          : "Loading local CPU compatibility mode…",
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const worker = new Worker(
          new URL("./vision.worker.ts", import.meta.url),
          { type: "module" },
        );
        this.worker = worker;
        let loaded = false;
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                "Vision model initialization timed out. Check downloaded assets and retry.",
              ),
            ),
          45000,
        );
        const cancel = () => {
          clearTimeout(timer);
          reject(aborted());
        };
        this.initializingCancel = cancel;
        worker.onerror = (event) => {
          const error = new Error(event.message || "Vision worker failed.");
          if (!loaded) {
            clearTimeout(timer);
            reject(error);
          } else void this.recover(error, session);
        };
        worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
          if (session !== this.session || worker !== this.worker) return;
          const response = event.data;
          if (response.type === "ready") {
            loaded = true;
            clearTimeout(timer);
            this.initializingCancel = undefined;
            this.ready = true;
            this.onStatus({
              state: "ready",
              delegate,
              message: "Vision ready. All processing stays on this device.",
            });
            resolve();
          } else if (response.type === "error") {
            const error = new Error(response.message);
            if (!loaded) {
              clearTimeout(timer);
              reject(error);
            } else void this.recover(error, session);
          } else {
            this.busy = false;
            clearTimeout(this.frameTimeout);
            this.frameTimeout = undefined;
            if (response.epoch !== this.epoch) return;
            this.sample = response.sample;
            this.onSample(response.sample);
            if (delegate === "GPU") {
              // Exclude cold first-frame shader compilation. Sustained
              // sub-2.5-fps inference cannot resolve short pinch confirmations;
              // a local CPU fallback is preferable to an apparently live but
              // unresponsive interaction. Never oscillate back to the GPU.
              this.gpuFrames++;
              this.slowGpuFrames = this.gpuFrames > 1 && response.inferenceMs > 400
                ? this.slowGpuFrames + 1 : 0;
              if (this.slowGpuFrames >= 2) {
                void this.recover(new Error("GPU inference remained too slow. Switching to local CPU vision."), session);
                return;
              }
            }
            this.measuredFrames++;
            const now = performance.now();
            if (now - this.reportedAt >= 500) {
              const fps =
                (this.measuredFrames * 1000) /
                Math.max(1, now - this.measuredAt);
              this.onStatus({
                state: "ready",
                delegate,
                message: "Vision is running locally.",
                inferenceMs: response.inferenceMs,
                fps,
              });
              this.reportedAt = now;
              if (now - this.measuredAt > 3000) {
                this.measuredAt = now;
                this.measuredFrames = 0;
              }
            }
          }
        };
        const request: WorkerRequest = {
          type: "init",
          scene: this.scene,
          delegate,
          base: new URL(import.meta.env.BASE_URL, location.href).href,
        };
        worker.postMessage(request);
      });
    } catch (error) {
      if (session !== this.session) throw aborted();
      this.initializingCancel = undefined;
      if (delegate === "GPU") {
        await this.startWorker(session, "CPU");
        return;
      }
      throw error;
    }
  }

  private async recover(error: Error, session: number): Promise<void> {
    if (session !== this.session || !this.ready) return;
    this.ready = false;
    this.releaseHands();
    if (this.delegate === "GPU") {
      try {
        await this.startWorker(session, "CPU");
        // A finite imported clip may have ended during a slow GPU frame.
        // Calibrate the replacement model on its decoded frame even when no
        // further video-frame callback will arrive until the user presses Play.
        this.lastSourceTime = -1;
        if (this.video) await this.processFrame(session, this.video.currentTime);
      } catch (failure) {
        if (session === this.session) this.fail(failure, session);
      }
    } else this.fail(error, session);
  }

  private fail(error: unknown, session: number): void {
    if (session !== this.session) return;
    this.stop();
    const message =
      error instanceof DOMException && error.name === "NotAllowedError"
        ? "Camera permission was denied. Allow camera access in browser settings, then choose Start camera again."
        : reason(error);
    this.onStatus({ state: "error", message });
  }

  private releaseHands(): void {
    if (this.sample) {
      this.sample = {
        ...this.sample,
        hands: this.sample.hands.map((hand) => ({ ...hand, pinch: false })),
      };
      this.onSample(this.sample);
    }
  }

  private resetTracking(): void {
    this.epoch++;
    this.lastSourceTime = -1;
    this.releaseHands();
    const request: WorkerRequest = { type: "reset", epoch: this.epoch };
    this.worker?.postMessage(request);
  }

  private beginFrames(session: number): void {
    if (session !== this.session || !this.video) return;
    this.measuredAt = performance.now();
    const video = this.video;
    const schedule = () => {
      if (session !== this.session) return;
      if (typeof video.requestVideoFrameCallback === "function")
        this.videoFrameId = video.requestVideoFrameCallback(
          (_now, metadata) => {
            schedule();
            void this.processFrame(session, metadata.mediaTime);
          },
        );
      else
        this.animationFrameId = requestAnimationFrame(() => {
          schedule();
          void this.processFrame(session, video.currentTime);
        });
    };
    schedule();
    void this.processFrame(session, video.currentTime);
  }

  private async processFrame(
    session: number,
    mediaTime: number,
  ): Promise<void> {
    const video = this.video;
    const worker = this.worker;
    if (
      session !== this.session ||
      !this.ready ||
      !worker ||
      !video ||
      video.readyState < 2 ||
      video.seeking
    )
      return;
    if (mediaTime < this.lastSourceTime - 0.05) this.resetTracking();
    if (this.busy || mediaTime === this.lastSourceTime) return;
    this.busy = true;
    this.lastSourceTime = mediaTime;
    const epoch = this.epoch;
    const sourceT =
      this.source === "camera"
        ? (performance.now() - this.startedAt) / 1000
        : mediaTime;
    const scale = Math.min(1, 640 / video.videoWidth, 360 / video.videoHeight);
    try {
      const bitmap = await createImageBitmap(video, {
        resizeWidth: Math.max(1, Math.round(video.videoWidth * scale)),
        resizeHeight: Math.max(1, Math.round(video.videoHeight * scale)),
        resizeQuality: "low",
      });
      if (
        session !== this.session ||
        epoch !== this.epoch ||
        worker !== this.worker ||
        !this.ready
      ) {
        bitmap.close();
        if (session === this.session && worker === this.worker)
          this.busy = false;
        return;
      }
      this.lastModelTimestamp = Math.max(
        performance.now(),
        this.lastModelTimestamp + 0.001,
      );
      const request: WorkerRequest = {
        type: "frame",
        bitmap,
        timestampMs: this.lastModelTimestamp,
        sourceT: Math.max(0, sourceT),
        source: this.source,
        epoch,
      };
      worker.postMessage(request, [bitmap]);
      this.frameTimeout = setTimeout(
        () =>
          void this.recover(
            new Error("Vision frame timed out. Please restart the input."),
            session,
          ),
        15000,
      );
    } catch (error) {
      if (session === this.session && worker === this.worker) {
        this.busy = false;
        void this.recover(
          error instanceof Error ? error : new Error(String(error)),
          session,
        );
      }
    }
  }
}
