export interface VideoType {
  mimeType: string;
  extension: string;
}
const VIDEO_TYPES: VideoType[] = [
  // Codec support is only a capability hint; actual encoder output is checked
  // when recording finishes, including for short takes and cold starts.
  { mimeType: "video/webm;codecs=vp8", extension: "webm" },
  { mimeType: "video/webm;codecs=vp9", extension: "webm" },
  { mimeType: "video/webm", extension: "webm" },
  { mimeType: "video/mp4;codecs=avc1.42E01E", extension: "mp4" },
  { mimeType: "video/mp4", extension: "mp4" },
];

export function supportedVideoType(): VideoType | null {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  )
    return null;
  return (
    VIDEO_TYPES.find((type) => MediaRecorder.isTypeSupported(type.mimeType)) ??
    null
  );
}

/** Records the supplied canvas. Captured tracks never include microphone audio. */
export class CanvasRecorder {
  private recorder: MediaRecorder | null = null;
  private probe: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private compositionCanvas: HTMLCanvasElement | null = null;
  private compositionContext: CanvasRenderingContext2D | null = null;
  private captureTrack: CanvasCaptureMediaStreamTrack | null = null;
  private nextCaptureAt = 0;
  private chunks: Blob[] = [];
  private result: Promise<Blob> | null = null;
  private resolve: ((blob: Blob) => void) | null = null;
  private reject: ((error: Error) => void) | null = null;
  private failure: Error | null = null;
  private errorCallback?: (message: string) => void;
  private chosen: VideoType;
  private finished = false;
  private stopTimeout: ReturnType<typeof setTimeout> | undefined;
  private prepareTimeout: ReturnType<typeof setTimeout> | undefined;
  private prepareInterval: ReturnType<typeof setInterval> | undefined;
  private prepareReject: ((error: Error) => void) | null = null;
  private visibility = () => {
    if (document.visibilityState === "hidden")
      this.abort(
        new Error(
          "Video export stopped because the tab was hidden. Keep this tab in the foreground and export again.",
        ),
      );
  };

  constructor(private readonly canvas: HTMLCanvasElement) {
    const type = supportedVideoType();
    if (!type)
      throw new Error(
        "This browser cannot export canvas video. Use desktop Chrome or Edge, or export a PNG.",
      );
    this.chosen = type;
  }
  get mimeType() {
    return this.chosen.mimeType;
  }
  get extension() {
    return this.chosen.extension;
  }

  async start(onError?: (message: string) => void): Promise<void> {
    if (this.result || this.finished)
      throw new Error(
        "This recorder has already been used. Create a new recorder for another export.",
      );
    if (document.visibilityState === "hidden")
      throw new Error("Keep this tab in the foreground to export video.");
    if (!this.canvas.width || !this.canvas.height)
      throw new Error("The artwork canvas cannot be captured in this browser.");
    this.errorCallback = onError;
    try {
      // Capture a stable 2D composition instead of a renderer-owned WebGL
      // backing store. The caller supplies either the final composition or the
      // original-camera capture canvas; application controls are never copied.
      const composition = document.createElement("canvas");
      composition.width = this.canvas.width;
      composition.height = this.canvas.height;
      this.compositionCanvas = composition;
      this.compositionContext = composition.getContext("2d", { alpha: false });
      if (
        !this.compositionContext ||
        typeof composition.captureStream !== "function"
      )
        throw new Error(
          "The artwork canvas cannot be captured in this browser.",
        );
      this.stream = composition.captureStream(0);
      const track = this.stream.getVideoTracks()[0] as
        CanvasCaptureMediaStreamTrack | undefined;
      if (!track)
        throw new Error("Canvas capture did not provide a video track.");
      if (typeof track.requestFrame === "function") {
        this.captureTrack = track;
      } else {
        // A zero-rate stream cannot advance without requestFrame. Release the
        // probe stream before obtaining a browser-driven fallback stream.
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
        this.stream = composition.captureStream(30);
        if (!this.stream.getVideoTracks().length)
          throw new Error("Canvas capture did not provide a video track.");
      }
      this.result = new Promise<Blob>((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
      });
      // Consumers often await stop later. Mark early encoder errors handled without swallowing stop's rejection.
      void this.result.catch(() => undefined);
      document.addEventListener("visibilitychange", this.visibility);
      // A fresh browser can need several seconds to initialize an encoder.
      // Discard a readiness recording of the initial artwork before starting
      // the take, so startup neither loses motion nor adds a frozen preroll.
      await this.prepareEncoder();
      if (this.finished)
        throw this.failure ?? new Error("Video export was cancelled.");
      this.recorder = this.createRecorder();
      this.recorder.ondataavailable = (event) => {
        if (!this.failure && event.data.size) this.chunks.push(event.data);
      };
      this.recorder.onerror = () =>
        this.abort(
          new Error(
            "The browser video encoder failed. Your project is still available; try exporting again.",
          ),
        );
      this.recorder.onstop = () => {
        if (this.finished) return;
        this.finished = true;
        const blob = new Blob(this.chunks, { type: this.mimeType });
        this.chunks = [];
        this.cleanup();
        if (this.failure) this.reject?.(this.failure);
        else if (!blob.size)
          this.reject?.(
            new Error(
              "Video export produced no frames. Play the take before stopping.",
            ),
          );
        else this.resolve?.(blob);
      };
      this.recorder.start(250);
      this.captureFrame(true);
    } catch (error) {
      const failure =
        error instanceof Error
          ? error
          : new Error("Could not start video export.");
      this.abort(failure, false);
      throw failure;
    }
  }

  private createRecorder(): MediaRecorder {
    if (!this.stream)
      throw new Error("The canvas capture stream is unavailable.");
    const recorder = new MediaRecorder(this.stream, {
      mimeType: this.chosen.mimeType,
      videoBitsPerSecond: 6_000_000,
    });
    const actual = recorder.mimeType;
    if (actual) {
      if (!actual.startsWith("video/webm") && !actual.startsWith("video/mp4"))
        throw new Error("The browser chose an unsupported video container.");
      this.chosen = {
        mimeType: actual,
        extension: actual.startsWith("video/mp4") ? "mp4" : "webm",
      };
    }
    return recorder;
  }

  private prepareEncoder(): Promise<void> {
    const probe = this.createRecorder();
    this.probe = probe;
    return new Promise((resolve, reject) => {
      this.prepareReject = reject;
      let hasOutput = false;
      probe.ondataavailable = (event) => {
        // Chromium may first emit a one-byte container prefix. Wait for
        // substantive output before treating the encoder as ready.
        if (this.finished || hasOutput || event.data.size <= 1) return;
        hasOutput = true;
        try {
          probe.stop();
        } catch (error) {
          this.abort(
            error instanceof Error
              ? error
              : new Error("Encoder preparation failed."),
          );
        }
      };
      probe.onerror = () =>
        this.abort(
          new Error(
            "The browser video encoder failed during preparation. Please export again.",
          ),
        );
      probe.onstop = () => {
        if (this.finished) return;
        if (!hasOutput) {
          this.abort(
            new Error(
              "The browser video encoder stopped before producing frames. Please export again.",
            ),
          );
          return;
        }
        this.clearPreparation();
        probe.ondataavailable = probe.onerror = probe.onstop = null;
        this.probe = null;
        this.prepareReject = null;
        resolve();
      };
      this.prepareTimeout = setTimeout(
        () =>
          this.abort(
            new Error(
              "The browser video encoder did not become ready within 15 seconds. Your project is still available; please export again.",
            ),
          ),
        15_000,
      );
      this.prepareInterval = setInterval(() => {
        try {
          this.captureFrame();
        } catch {
          // captureFrame already aborts and rejects preparation on failure.
        }
      }, 1000 / 30);
      probe.start(100);
      this.captureFrame(true);
    });
  }

  private clearPreparation() {
    if (this.prepareTimeout !== undefined) clearTimeout(this.prepareTimeout);
    if (this.prepareInterval !== undefined) clearInterval(this.prepareInterval);
    this.prepareTimeout = undefined;
    this.prepareInterval = undefined;
  }

  /** Copy and submit just-rendered artwork at the dimensions frozen when export started. */
  captureFrame(force = false): void {
    if (
      this.finished ||
      (this.probe ?? this.recorder)?.state !== "recording" ||
      !this.compositionCanvas ||
      !this.compositionContext
    )
      return;
    const now = performance.now();
    if (!force && now < this.nextCaptureAt) return;
    try {
      this.compositionContext.drawImage(
        this.canvas,
        0,
        0,
        this.compositionCanvas.width,
        this.compositionCanvas.height,
      );
      this.captureTrack?.requestFrame();
      const interval = 1000 / 30;
      // Keep a stable target cadence without attempting bursts after a stall.
      this.nextCaptureAt =
        force || now - this.nextCaptureAt >= interval
          ? now + interval
          : this.nextCaptureAt + interval;
    } catch (error) {
      const failure = new Error(
        `Canvas frame capture failed. Your project is still available. ${error instanceof Error ? error.message : "Please export again."}`,
      );
      this.abort(failure);
      throw failure;
    }
  }

  async stop(): Promise<Blob> {
    if (!this.result) throw new Error("Video recording has not started.");
    if (this.probe && !this.finished)
      throw new Error(
        "Wait for the video encoder to finish preparing before stopping.",
      );
    if (this.recorder && this.recorder.state !== "inactive") {
      this.stopTimeout = setTimeout(
        () =>
          this.abort(
            new Error(
              "The video encoder did not finish. Your project is still available; try exporting again.",
            ),
          ),
        10_000,
      );
      try {
        this.recorder.stop();
      } catch (error) {
        this.abort(
          error instanceof Error
            ? error
            : new Error("Could not finish video export."),
        );
      }
    }
    return this.result;
  }
  cancel(): void {
    this.abort(new Error("Video export was cancelled."), false);
  }

  private abort(error: Error, notify = true) {
    if (this.finished) return;
    this.failure = error;
    this.finished = true;
    this.chunks = [];
    this.prepareReject?.(error);
    this.prepareReject = null;
    if (this.probe && this.probe.state !== "inactive") {
      try {
        this.probe.stop();
      } catch {
        /* Cleanup below still releases capture tracks. */
      }
    }
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        /* Cleanup below still releases capture tracks. */
      }
    }
    this.cleanup();
    this.reject?.(error);
    if (notify) this.errorCallback?.(error.message);
  }
  private cleanup() {
    this.clearPreparation();
    if (this.probe)
      this.probe.ondataavailable =
        this.probe.onerror =
        this.probe.onstop =
          null;
    this.probe = null;
    if (this.stopTimeout !== undefined) {
      clearTimeout(this.stopTimeout);
      this.stopTimeout = undefined;
    }
    document.removeEventListener("visibilitychange", this.visibility);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.captureTrack = null;
    // Releasing tracks comes first so the encoder never observes this resize.
    if (this.compositionCanvas) {
      this.compositionCanvas.width = 0;
      this.compositionCanvas.height = 0;
    }
    this.compositionCanvas = null;
    this.compositionContext = null;
    this.nextCaptureAt = 0;
    if (this.recorder)
      this.recorder.ondataavailable =
        this.recorder.onerror =
        this.recorder.onstop =
          null;
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Give browsers time to acquire large files before releasing the object URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(
                new Error(
                  "Could not capture the artwork. Render a frame and try again.",
                ),
              ),
        "image/png",
      );
    } catch (error) {
      reject(error);
    }
  });
}
