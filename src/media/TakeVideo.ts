import { CanvasRecorder } from "../export/recorder";

type CaptureState = "idle" | "preparing" | "recording" | "stopping";
interface CaptureSession {
  controller: AbortController;
  source: HTMLVideoElement;
  canvas: HTMLCanvasElement | null;
  context: CanvasRenderingContext2D | null;
  recorder: CanvasRecorder | null;
  raf: number | null;
  nextFrameAt: number;
  state: Exclude<CaptureState, "idle">;
  ready: Promise<void>;
  stop: Promise<Blob> | null;
}

const aborted = () => new DOMException("Video operation was cancelled.", "AbortError");

/** Retain the source aspect ratio, without upscaling or exceeding 720p bounds. */
export function takeVideoDimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error("The input video has no usable dimensions.");
  const scale = Math.min(1, 1280 / width, 720 / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Wait on native media events; every cancellation/error removes its listeners. */
function mediaReady(video: HTMLVideoElement, event: "loadeddata" | "seeked", ready: () => boolean, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      video.removeEventListener(event, check);
      video.removeEventListener("error", failed);
      signal.removeEventListener("abort", cancelled);
    };
    const check = () => { if (ready()) { cleanup(); resolve(); } };
    const failed = () => { cleanup(); reject(new Error(video.error?.message || "The browser could not decode this local video.")); };
    const cancelled = () => { cleanup(); reject(signal.reason instanceof Error ? signal.reason : aborted()); };
    video.addEventListener(event, check);
    video.addEventListener("error", failed);
    signal.addEventListener("abort", cancelled, { once: true });
    timer = setTimeout(() => { cleanup(); reject(new Error(event === "seeked" ? "Video seeking timed out. Try another video." : "The local video did not become ready within 20 seconds.")); }, timeoutMs);
    if (signal.aborted) cancelled();
    else if (video.error) failed();
    else check();
  });
}

/** Local original-video ownership. Replay is independent from live vision input. */
export class TakeVideo {
  readonly element: HTMLVideoElement;
  private url: string | null = null;
  private loadController: AbortController | null = null;
  private seekController: AbortController | null = null;
  private capture: CaptureSession | null = null;
  private disposed = false;

  constructor(private readonly onCaptureError?: (message: string) => void) {
    this.element = document.createElement("video");
    this.element.muted = true;
    this.element.defaultMuted = true;
    this.element.playsInline = true;
    this.element.preload = "auto";
  }
  get video() { return this.element; }
  get currentTime() { return this.element.currentTime; }
  get duration() { return this.element.duration; }
  get captureState(): CaptureState { return this.capture?.state ?? "idle"; }

  private assertUsable() { if (this.disposed) throw new Error("This video has been disposed."); }

  async attach(blob: Blob): Promise<void> {
    this.assertUsable();
    if (!blob.size) throw new Error("The local video is empty.");
    this.clearReplay();
    const controller = new AbortController();
    this.loadController = controller;
    const url = URL.createObjectURL(blob);
    this.url = url;
    this.element.src = url;
    const pending = mediaReady(this.element, "loadeddata", () => this.element.readyState >= 2 && this.element.videoWidth > 0, controller.signal, 20_000);
    void pending.catch(() => undefined);
    try {
      this.element.load();
      await pending;
      if (controller.signal.aborted || this.url !== url) throw aborted();
      // MediaRecorder WebM can omit its duration header. Native seeking to the
      // buffered end discovers the duration without re-encoding local pixels.
      if (!Number.isFinite(this.element.duration)) {
        this.element.currentTime = 1e8;
        await mediaReady(this.element, "seeked", () => !this.element.seeking && Number.isFinite(this.element.duration) && this.element.readyState >= 2, controller.signal, 10_000);
        this.element.currentTime = 0;
        await mediaReady(this.element, "seeked", () => !this.element.seeking && this.element.currentTime < 0.05 && this.element.readyState >= 2, controller.signal, 10_000);
      }
      if (controller.signal.aborted || this.url !== url) throw aborted();
    } catch (error) {
      // A replaced attachment owns a different URL and must not be cleared here.
      if (this.url === url) this.clearReplay();
      throw error;
    } finally {
      if (this.loadController === controller) this.loadController = null;
    }
  }

  async seek(seconds: number): Promise<void> {
    this.assertUsable();
    // A valid video can fall back to HAVE_METADATA while a seek is decoding.
    // Permit its replacement; completion still requires a decoded target frame.
    if (!this.url || this.element.readyState < 1 || this.element.videoWidth <= 0) throw new Error("Attach a decoded video before seeking.");
    if (!Number.isFinite(seconds)) throw new Error("Video time must be finite.");
    this.seekController?.abort(aborted());
    const controller = new AbortController();
    this.seekController = controller;
    const duration = this.element.duration;
    const target = Math.max(0, Number.isFinite(duration) ? Math.min(seconds, duration) : seconds);
    try {
      if (!this.element.seeking && this.element.readyState >= 2 && Math.abs(this.element.currentTime - target) < 0.001) return;
      this.element.currentTime = target;
      await mediaReady(this.element, "seeked", () => !this.element.seeking && this.element.readyState >= 2 && Math.abs(this.element.currentTime - target) < 0.05, controller.signal, 10_000);
    } finally {
      if (this.seekController === controller) this.seekController = null;
    }
  }

  async play(): Promise<void> {
    this.assertUsable();
    if (!this.url) throw new Error("Attach a video before playback.");
    await this.element.play();
  }
  pause(): void { this.element.pause(); }

  startCapture(source: HTMLVideoElement): Promise<void> {
    this.assertUsable();
    if (this.capture) return Promise.reject(new Error("An original-video capture is already in progress."));
    const session: CaptureSession = {
      controller: new AbortController(), source, canvas: null, context: null, recorder: null,
      raf: null, nextFrameAt: 0, state: "preparing", ready: Promise.resolve(), stop: null,
    };
    this.capture = session;
    session.ready = this.prepareCapture(session);
    // Cancellation can happen before the caller attaches its await handler.
    void session.ready.catch(() => undefined);
    return session.ready;
  }

  private async prepareCapture(session: CaptureSession): Promise<void> {
    try {
      await mediaReady(session.source, "loadeddata", () => session.source.readyState >= 2 && session.source.videoWidth > 0, session.controller.signal, 20_000);
      if (this.capture !== session) throw aborted();
      const canvas = document.createElement("canvas");
      const size = takeVideoDimensions(session.source.videoWidth, session.source.videoHeight);
      canvas.width = size.width; canvas.height = size.height;
      session.canvas = canvas;
      session.context = canvas.getContext("2d", { alpha: false });
      if (!session.context) throw new Error("The browser cannot capture the original video.");
      // drawImage ignores CSS preview mirroring. Stored pixels keep camera orientation.
      session.context.drawImage(session.source, 0, 0, canvas.width, canvas.height);
      const recorder = new CanvasRecorder(canvas);
      session.recorder = recorder;
      const frame = (now: number) => {
        if (this.capture !== session || session.controller.signal.aborted) return;
        try {
          if (now >= session.nextFrameAt && session.source.readyState >= 2) {
            session.context!.drawImage(session.source, 0, 0, canvas.width, canvas.height);
            recorder.captureFrame();
            const interval = 1000 / 30;
            session.nextFrameAt = now - session.nextFrameAt >= interval ? now + interval : session.nextFrameAt + interval;
          }
          session.raf = requestAnimationFrame(frame);
        } catch (error) {
          this.failCapture(session, error instanceof Error ? error : new Error("Original-video frame capture failed."));
        }
      };
      session.raf = requestAnimationFrame(frame);
      await recorder.start(message => this.failCapture(session, new Error(message)));
      if (this.capture !== session || session.controller.signal.aborted) throw aborted();
      session.state = "recording";
    } catch (error) {
      this.releaseCapture(session, true);
      throw error;
    }
  }

  stopCapture(): Promise<Blob> {
    const session = this.capture;
    if (!session) return Promise.reject(new Error("Original-video capture has not started."));
    if (session.stop) return session.stop;
    session.stop = (async () => {
      try {
        await session.ready;
        if (this.capture !== session || session.controller.signal.aborted) throw aborted();
        session.state = "stopping";
        if (session.raf !== null) cancelAnimationFrame(session.raf);
        session.raf = null;
        if (session.source.readyState >= 2 && session.context && session.canvas) {
          session.context.drawImage(session.source, 0, 0, session.canvas.width, session.canvas.height);
          session.recorder!.captureFrame(true);
        }
        const blob = await session.recorder!.stop();
        if (this.capture !== session || session.controller.signal.aborted) throw aborted();
        this.releaseCapture(session, false);
        return blob;
      } catch (error) {
        this.releaseCapture(session, true);
        throw error;
      }
    })();
    void session.stop.catch(() => undefined);
    return session.stop;
  }

  cancelCapture(): void { if (this.capture) this.releaseCapture(this.capture, true); }

  private failCapture(session: CaptureSession, error: Error) {
    if (this.capture !== session) return;
    this.releaseCapture(session, true, error);
    this.onCaptureError?.(error.message);
  }

  private releaseCapture(session: CaptureSession, cancel: boolean, reason: Error = aborted()) {
    if (this.capture === session) this.capture = null;
    if (session.raf !== null) cancelAnimationFrame(session.raf);
    session.raf = null;
    session.controller.abort(reason);
    if (cancel) session.recorder?.cancel();
    if (session.canvas) { session.canvas.width = 0; session.canvas.height = 0; }
    session.canvas = null; session.context = null;
  }

  private clearReplay() {
    this.loadController?.abort(aborted()); this.loadController = null;
    this.seekController?.abort(aborted()); this.seekController = null;
    this.element.pause();
    this.element.removeAttribute("src");
    this.element.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
  clear(): void { this.cancelCapture(); this.clearReplay(); }
  dispose(): void { if (!this.disposed) { this.clear(); this.disposed = true; } }
}
