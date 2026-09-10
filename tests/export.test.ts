import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasRecorder, supportedVideoType } from "../src/export/recorder";

class FakeDocument extends EventTarget {
  visibilityState = "visible";
  createElement = vi.fn(() => composition);
}
class FakeRecorder {
  static supported = ["video/webm;codecs=vp8"];
  static last: FakeRecorder;
  static instances: FakeRecorder[] = [];
  static autoPrepare = true;
  static failStart = false;
  static empty = false;
  static isTypeSupported(type: string) {
    return this.supported.includes(type);
  }
  mimeType: string;
  state = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;
  readonly index: number;
  constructor(
    readonly stream: unknown,
    options: { mimeType: string },
  ) {
    this.mimeType = options.mimeType;
    FakeRecorder.last = this;
    this.index = FakeRecorder.instances.push(this) - 1;
  }
  start() {
    if (FakeRecorder.failStart) throw new Error("start failed");
    this.state = "recording";
    if (this.index === 0 && FakeRecorder.autoPrepare)
      queueMicrotask(() =>
        this.ondataavailable?.({
          data: new Blob(["discarded preparation frames"]),
        }),
      );
  }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      if (this.index === 0 || !FakeRecorder.empty)
        this.ondataavailable?.({
          data: new Blob([
            this.index === 0
              ? "discarded probe trailer"
              : "actual encoder output",
          ]),
        });
      this.onstop?.();
    });
  }
}
let documentMock: FakeDocument;
let track: {
  stop: ReturnType<typeof vi.fn>;
  requestFrame: ReturnType<typeof vi.fn>;
};
let canvas: HTMLCanvasElement;
let composition: HTMLCanvasElement;
let drawImage: ReturnType<typeof vi.fn>;
beforeEach(() => {
  FakeRecorder.supported = ["video/webm;codecs=vp8"];
  FakeRecorder.failStart = false;
  FakeRecorder.empty = false;
  FakeRecorder.instances = [];
  FakeRecorder.autoPrepare = true;
  documentMock = new FakeDocument();
  track = { stop: vi.fn(), requestFrame: vi.fn() };
  canvas = {
    width: 1280,
    height: 720,
    captureStream: vi.fn(() => {
      throw new Error("The source WebGL stream must not be captured directly.");
    }),
  } as unknown as HTMLCanvasElement;
  drawImage = vi.fn();
  composition = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage })),
    captureStream: vi.fn(() => ({
      getVideoTracks: () => [track],
      getTracks: () => [track],
    })),
  } as unknown as HTMLCanvasElement;
  vi.stubGlobal("document", documentMock);
  vi.stubGlobal("MediaRecorder", FakeRecorder);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("canvas video export", () => {
  it("selects only a supported encoding and correct file extension", () => {
    FakeRecorder.supported = ["video/webm;codecs=vp9", "video/webm;codecs=vp8"];
    expect(supportedVideoType()).toEqual({
      mimeType: "video/webm;codecs=vp8",
      extension: "webm",
    });
    FakeRecorder.supported = ["video/mp4"];
    expect(supportedVideoType()).toEqual({
      mimeType: "video/mp4",
      extension: "mp4",
    });
    FakeRecorder.supported = [];
    expect(supportedVideoType()).toBeNull();
    expect(() => new CanvasRecorder(canvas)).toThrow("cannot export");
  });
  it("starts explicit canvas capture after the encoder starts and stops every track", async () => {
    const recorder = new CanvasRecorder(canvas);
    track.requestFrame.mockImplementation(() => {
      expect(FakeRecorder.last.state).toBe("recording");
      expect(drawImage).toHaveBeenLastCalledWith(canvas, 0, 0, 1280, 720);
    });
    recorder.captureFrame(true);
    expect(track.requestFrame).not.toHaveBeenCalled();
    await recorder.start();
    expect(composition.captureStream).toHaveBeenCalledExactlyOnceWith(0);
    expect(canvas.captureStream).not.toHaveBeenCalled();
    expect(composition.width).toBe(1280);
    expect(composition.height).toBe(720);
    expect(track.requestFrame).toHaveBeenCalledTimes(2);
    const result = await recorder.stop();
    expect(result.type).toBe("video/webm;codecs=vp8");
    expect(await result.text()).toBe("actual encoder output");
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(composition.width).toBe(0);
    expect(composition.height).toBe(0);
    recorder.captureFrame(true);
    expect(track.requestFrame).toHaveBeenCalledTimes(2);
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(recorder.extension).toBe("webm");
    expect(await recorder.stop()).toBe(result);
    await expect(recorder.start()).rejects.toThrow("already been used");
  });
  it("throttles explicit frames at 30 Hz, permits forced endpoints, and avoids catch-up bursts", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const recorder = new CanvasRecorder(canvas);
    await recorder.start();
    expect(track.requestFrame).toHaveBeenCalledTimes(2);
    expect(drawImage).toHaveBeenCalledTimes(2);
    now = 16;
    recorder.captureFrame();
    now = 32;
    recorder.captureFrame();
    expect(track.requestFrame).toHaveBeenCalledTimes(2);
    now = 34;
    recorder.captureFrame();
    expect(track.requestFrame).toHaveBeenCalledTimes(3);
    now = 40;
    recorder.captureFrame(true);
    expect(track.requestFrame).toHaveBeenCalledTimes(4);
    now = 60;
    recorder.captureFrame();
    expect(track.requestFrame).toHaveBeenCalledTimes(4);
    now = 1000;
    recorder.captureFrame();
    recorder.captureFrame();
    expect(track.requestFrame).toHaveBeenCalledTimes(5);
    expect(drawImage).toHaveBeenCalledTimes(5);
    await recorder.stop();
  });
  it("releases a zero-rate probe and obtains a 30 fps stream when requestFrame is unavailable", async () => {
    const probe = { stop: vi.fn() };
    const automatic = { stop: vi.fn() };
    vi.mocked(composition.captureStream)
      .mockReturnValueOnce({
        getVideoTracks: () => [probe],
        getTracks: () => [probe],
      } as unknown as MediaStream)
      .mockReturnValueOnce({
        getVideoTracks: () => [automatic],
        getTracks: () => [automatic],
      } as unknown as MediaStream);
    const recorder = new CanvasRecorder(canvas);
    await recorder.start();
    expect(composition.captureStream).toHaveBeenNthCalledWith(1, 0);
    expect(composition.captureStream).toHaveBeenNthCalledWith(2, 30);
    expect(probe.stop).toHaveBeenCalledTimes(1);
    recorder.captureFrame(true);
    expect(drawImage).toHaveBeenCalledTimes(3);
    expect(drawImage).toHaveBeenLastCalledWith(canvas, 0, 0, 1280, 720);
    await recorder.stop();
    expect(automatic.stop).toHaveBeenCalledTimes(1);
    expect(probe.stop).toHaveBeenCalledTimes(1);
    expect(track.requestFrame).not.toHaveBeenCalled();
    expect(canvas.captureStream).not.toHaveBeenCalled();
  });
  it("aborts failed explicit capture and releases the manual track", async () => {
    const recorder = new CanvasRecorder(canvas);
    const onError = vi.fn();
    await recorder.start(onError);
    track.requestFrame.mockImplementationOnce(() => {
      throw new Error("capture unavailable");
    });
    expect(() => recorder.captureFrame(true)).toThrow(
      "Canvas frame capture failed",
    );
    await expect(recorder.stop()).rejects.toThrow("capture unavailable");
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    recorder.captureFrame(true);
    expect(track.requestFrame).toHaveBeenCalledTimes(3);
  });
  it("freezes export dimensions when the renderer changes its backing resolution", async () => {
    const recorder = new CanvasRecorder(canvas);
    await recorder.start();
    canvas.width = 832;
    canvas.height = 468;
    recorder.captureFrame(true);
    expect(composition.width).toBe(1280);
    expect(composition.height).toBe(720);
    expect(drawImage).toHaveBeenLastCalledWith(canvas, 0, 0, 1280, 720);
    track.stop.mockImplementation(() => {
      expect(composition.width).toBe(1280);
      expect(composition.height).toBe(720);
    });
    await recorder.stop();
    expect(composition.width).toBe(0);
    expect(composition.height).toBe(0);
  });
  it("aborts a failed artwork copy and never reads its source again after cleanup", async () => {
    const recorder = new CanvasRecorder(canvas);
    const onError = vi.fn();
    await recorder.start(onError);
    drawImage.mockImplementationOnce(() => {
      throw new Error("WebGL readback unavailable");
    });
    expect(() => recorder.captureFrame(true)).toThrow(
      "WebGL readback unavailable",
    );
    await expect(recorder.stop()).rejects.toThrow(
      "Canvas frame capture failed",
    );
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(track.requestFrame).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    const copiesAtFailure = drawImage.mock.calls.length;
    recorder.captureFrame(true);
    expect(drawImage).toHaveBeenCalledTimes(copiesAtFailure);
    expect(composition.width).toBe(0);
    expect(composition.height).toBe(0);
  });
  it("aborts a hidden-tab export and rejects instead of producing a partial success", async () => {
    const recorder = new CanvasRecorder(canvas);
    const onError = vi.fn();
    await recorder.start(onError);
    documentMock.visibilityState = "hidden";
    documentMock.dispatchEvent(new Event("visibilitychange"));
    await expect(recorder.stop()).rejects.toThrow("tab was hidden");
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("foreground"));
    expect(track.stop).toHaveBeenCalledTimes(1);
    recorder.captureFrame(true);
    expect(track.requestFrame).toHaveBeenCalledTimes(2);
  });
  it("reports encoder errors and releases tracks", async () => {
    const recorder = new CanvasRecorder(canvas);
    const onError = vi.fn();
    await recorder.start(onError);
    FakeRecorder.last.onerror?.();
    await expect(recorder.stop()).rejects.toThrow("encoder failed");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });
  it("cancels quietly, rejects later stop, and never fabricates a video", async () => {
    const recorder = new CanvasRecorder(canvas);
    const onError = vi.fn();
    await recorder.start(onError);
    recorder.cancel();
    await expect(recorder.stop()).rejects.toThrow("cancelled");
    expect(onError).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });
  it("rejects empty output", async () => {
    FakeRecorder.empty = true;
    const recorder = new CanvasRecorder(canvas);
    await recorder.start();
    await expect(recorder.stop()).rejects.toThrow("no frames");
    expect(track.stop).toHaveBeenCalledTimes(1);
  });
  it("releases capture tracks if the encoder cannot start", async () => {
    FakeRecorder.failStart = true;
    const recorder = new CanvasRecorder(canvas);
    await expect(recorder.start()).rejects.toThrow("start failed");
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("waits for substantive probe output, preserves its stream, and excludes all probe bytes", async () => {
    vi.useFakeTimers();
    FakeRecorder.autoPrepare = false;
    const recorder = new CanvasRecorder(canvas);
    let ready = false;
    const starting = recorder.start().then(() => {
      ready = true;
    });
    const probe = FakeRecorder.last;
    await vi.advanceTimersByTimeAsync(3000);
    expect(drawImage.mock.calls.length).toBeGreaterThan(60);
    expect(drawImage.mock.calls.every((args) => args[0] === canvas)).toBe(true);
    expect(ready).toBe(false);
    expect(FakeRecorder.instances).toHaveLength(1);
    probe.ondataavailable?.({ data: new Blob(["x"]) });
    await Promise.resolve();
    expect(ready).toBe(false);
    probe.ondataavailable?.({ data: new Blob(["real probe packet"]) });
    await starting;
    expect(ready).toBe(true);
    expect(FakeRecorder.instances).toHaveLength(2);
    expect(FakeRecorder.last.stream).toBe(probe.stream);
    expect(probe.state).toBe("inactive");
    expect(probe.ondataavailable).toBeNull();
    expect(track.stop).not.toHaveBeenCalled();
    const copiesAtReady = drawImage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(drawImage).toHaveBeenCalledTimes(copiesAtReady);
    const blob = await recorder.stop();
    expect(await blob.text()).toBe("actual encoder output");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds encoder preparation to 15 seconds and clears all timers and tracks", async () => {
    vi.useFakeTimers();
    FakeRecorder.autoPrepare = false;
    const recorder = new CanvasRecorder(canvas);
    const onError = vi.fn();
    const failure = expect(recorder.start(onError)).rejects.toThrow(
      "15 seconds",
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await failure;
    await expect(recorder.stop()).rejects.toThrow("15 seconds");
    expect(FakeRecorder.instances).toHaveLength(1);
    expect(FakeRecorder.last.state).toBe("inactive");
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancel", "hidden", "error"])(
    "cleans up %s during preparation without starting a final recorder",
    async (reason) => {
      vi.useFakeTimers();
      FakeRecorder.autoPrepare = false;
      const recorder = new CanvasRecorder(canvas);
      const onError = vi.fn();
      const starting = recorder.start(onError);
      const failed = expect(starting).rejects.toThrow(
        reason === "cancel"
          ? "cancelled"
          : reason === "hidden"
            ? "tab was hidden"
            : "encoder failed",
      );
      const probe = FakeRecorder.last;
      if (reason === "cancel") recorder.cancel();
      else if (reason === "hidden") {
        documentMock.visibilityState = "hidden";
        documentMock.dispatchEvent(new Event("visibilitychange"));
      } else probe.onerror?.();
      await failed;
      expect(FakeRecorder.instances).toHaveLength(1);
      expect(probe.state).toBe("inactive");
      expect(probe.ondataavailable).toBeNull();
      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      const copies = drawImage.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      recorder.captureFrame(true);
      expect(drawImage).toHaveBeenCalledTimes(copies);
      expect(onError).toHaveBeenCalledTimes(reason === "cancel" ? 0 : 1);
    },
  );
});
