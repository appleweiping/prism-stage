import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TakeVideo, takeVideoDimensions } from "../src/media/TakeVideo";

const recorders = vi.hoisted(() => ({ instances: [] as Array<{
  canvas: HTMLCanvasElement; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>; captureFrame: ReturnType<typeof vi.fn>;
  ready: () => void; reject: (error: Error) => void; notify?: (message: string) => void;
}> }));
vi.mock("../src/export/recorder", () => ({
  CanvasRecorder: class {
    start; stop = vi.fn(async () => new Blob(["original frames"], { type: "video/webm" }));
    captureFrame = vi.fn(); cancel; ready!: () => void; reject!: (error: Error) => void;
    notify?: (message: string) => void;
    constructor(readonly canvas: HTMLCanvasElement) {
      const promise = new Promise<void>((resolve, reject) => { this.ready = resolve; this.reject = reject; });
      this.start = vi.fn((notify?: (message: string) => void) => { this.notify = notify; return promise; });
      this.cancel = vi.fn(() => this.reject(new DOMException("cancelled", "AbortError")));
      recorders.instances.push(this);
    }
  },
}));

class Video extends EventTarget {
  src = ""; readyState = 0; videoWidth = 0; videoHeight = 0; duration = 20;
  muted = false; defaultMuted = false; playsInline = false; preload = "none";
  seeking = false; error: { message: string } | null = null;
  private time = 0;
  get currentTime() { return this.time; }
  set currentTime(value: number) { this.time = value; this.seeking = true; }
  pause = vi.fn(); play = vi.fn(async () => {});
  load = vi.fn(() => { if (!this.src) { this.readyState = 0; this.videoWidth = this.videoHeight = 0; this.time = 0; this.seeking = false; } });
  removeAttribute = vi.fn((name: string) => { if (name === "src") this.src = ""; });
  decoded(width = 1920, height = 1080) { this.readyState = 2; this.videoWidth = width; this.videoHeight = height; this.dispatchEvent(new Event("loadeddata")); }
  seeked() { this.seeking = false; this.dispatchEvent(new Event("seeked")); }
}
let video: Video;
let createObjectURL: ReturnType<typeof vi.fn>, revokeObjectURL: ReturnType<typeof vi.fn>;
let drawImage: ReturnType<typeof vi.fn>;
let raf: Map<number, FrameRequestCallback>, nextRaf: number;
const helpers: TakeVideo[] = [];
const make = (callback?: (message: string) => void) => { const helper = new TakeVideo(callback); helpers.push(helper); return helper; };
const decodedAttachment = async (helper: TakeVideo) => { const pending = helper.attach(new Blob(["video"])); video.decoded(); await pending; };
const source = () => { const value = new Video(); value.decoded(); return value; };
const frame = (now: number) => { const callbacks = [...raf.values()]; raf.clear(); for (const callback of callbacks) callback(now); };
beforeEach(() => {
  vi.useFakeTimers(); recorders.instances = []; video = new Video(); raf = new Map(); nextRaf = 0;
  createObjectURL = vi.fn(() => `blob:local-${createObjectURL.mock.calls.length}`); revokeObjectURL = vi.fn(); drawImage = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  vi.stubGlobal("document", { createElement: vi.fn((tag: string) => tag === "video" ? video : { width: 0, height: 0, getContext: () => ({ drawImage }) }) });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { raf.set(++nextRaf, callback); return nextRaf; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => raf.delete(id));
});
afterEach(() => { helpers.splice(0).forEach(helper => helper.dispose()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("local original take video", () => {
  it("fits original dimensions inside 720p without upscaling", () => {
    expect(takeVideoDimensions(1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(takeVideoDimensions(1080, 1920)).toEqual({ width: 405, height: 720 });
    expect(takeVideoDimensions(640, 480)).toEqual({ width: 640, height: 480 });
    expect(() => takeVideoDimensions(0, 720)).toThrow("dimensions");
  });
  it("owns a muted independent replay element and releases its URL", async () => {
    const helper = make(); await decodedAttachment(helper);
    expect(helper.element).toBe(video); expect(helper.video).toBe(video);
    expect(video).toMatchObject({ muted: true, defaultMuted: true, playsInline: true, preload: "auto" });
    await helper.play(); expect(video.play).toHaveBeenCalledOnce();
    helper.clear(); expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:local-1");
    expect(video.src).toBe(""); expect(vi.getTimerCount()).toBe(0);
  });
  it("replacing a pending attachment rejects it without clearing the new URL", async () => {
    const helper = make(); const first = helper.attach(new Blob(["first"]));
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = helper.attach(new Blob(["second"])); video.decoded();
    await rejected; await second;
    expect(video.src).toBe("blob:local-2"); expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:local-1");
  });
  it("times out undecodable input and revokes the failed attachment", async () => {
    const helper = make(); const pending = helper.attach(new Blob(["bad"]));
    const rejected = expect(pending).rejects.toThrow("20 seconds");
    await vi.advanceTimersByTimeAsync(20_000); await rejected;
    expect(video.src).toBe(""); expect(revokeObjectURL).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("discovers recorded WebM duration and restores its first decoded frame", async () => {
    const helper = make(); video.duration = Infinity;
    const pending = helper.attach(new Blob(["webm"])); video.decoded(); await Promise.resolve();
    expect(video.currentTime).toBe(1e8);
    video.duration = 7.12; video.currentTime = 7.12; video.seeked(); await Promise.resolve();
    expect(video.currentTime).toBe(0); video.seeked(); await pending;
    expect(helper.duration).toBe(7.12); expect(helper.currentTime).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("superseding seeks cancel pending promises and resolve only after decode", async () => {
    const helper = make(); await decodedAttachment(helper);
    const first = helper.seek(3); const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = helper.seek(5); await rejected;
    let done = false; void second.then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
    video.seeked(); await second; expect(helper.currentTime).toBe(5); expect(vi.getTimerCount()).toBe(0);
  });
  it("replaces an in-flight seek while the decoder has only metadata", async () => {
    const helper = make(); await decodedAttachment(helper);
    const first = helper.seek(3); const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    video.readyState = 1;
    const second = helper.seek(5); await rejected;
    let done = false; void second.then(() => { done = true; });
    video.seeked(); await Promise.resolve(); expect(done).toBe(false);
    video.readyState = 2; video.seeked(); await second;
    expect(helper.currentTime).toBe(5); expect(vi.getTimerCount()).toBe(0);
  });
  it("clamps seek endpoints and clears pending seek/load work on disposal", async () => {
    const helper = make(); await decodedAttachment(helper);
    const end = helper.seek(200); expect(video.currentTime).toBe(20); video.seeked(); await end;
    const pending = helper.seek(1); const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    helper.dispose(); await rejected; expect(vi.getTimerCount()).toBe(0);
    await expect(helper.attach(new Blob(["late"]))).rejects.toThrow("disposed");
  });
  it("rejects a stalled seek after ten seconds", async () => {
    const helper = make(); await decodedAttachment(helper);
    const pending = helper.seek(9); const rejected = expect(pending).rejects.toThrow("seeking timed out");
    await vi.advanceTimersByTimeAsync(10_000); await rejected; expect(vi.getTimerCount()).toBe(0);
  });
  it("refreshes unmirrored original pixels while preparing and begins only at encoder readiness", async () => {
    const helper = make(), input = source(); const pending = helper.startCapture(input as unknown as HTMLVideoElement);
    await Promise.resolve(); const recorder = recorders.instances[0];
    expect(helper.captureState).toBe("preparing"); expect(recorder.canvas.width).toBe(1280); expect(recorder.canvas.height).toBe(720);
    frame(34); frame(50); frame(68);
    expect(drawImage).toHaveBeenLastCalledWith(input, 0, 0, 1280, 720);
    expect(recorder.captureFrame).toHaveBeenCalledTimes(2);
    recorder.ready(); await pending; expect(helper.captureState).toBe("recording");
    const stopped = helper.stopCapture(); expect(helper.stopCapture()).toBe(stopped);
    const blob = await stopped; expect(await blob.text()).toBe("original frames");
    expect(blob.type).toBe("video/webm"); expect(helper.captureState).toBe("idle");
    expect(input.pause).not.toHaveBeenCalled(); expect(input.removeAttribute).not.toHaveBeenCalled();
    expect(raf.size).toBe(0); expect(recorder.canvas.width).toBe(0); expect(recorder.cancel).not.toHaveBeenCalled();
  });
  it("cancels capture before source decode without creating an encoder", async () => {
    const helper = make(); const input = new Video();
    const pending = helper.startCapture(input as unknown as HTMLVideoElement);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    helper.cancelCapture(); await rejected;
    expect(recorders.instances).toHaveLength(0); expect(vi.getTimerCount()).toBe(0); expect(helper.captureState).toBe("idle");
  });
  it("cancels encoder preparation and releases RAF without touching the input stream", async () => {
    const helper = make(), input = source(); const pending = helper.startCapture(input as unknown as HTMLVideoElement);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve(); const recorder = recorders.instances[0]; helper.cancelCapture(); await rejected;
    expect(recorder.cancel).toHaveBeenCalled(); expect(raf.size).toBe(0); expect(input.pause).not.toHaveBeenCalled();
  });
  it("reports active encoder failure and stops submitting frames", async () => {
    const notify = vi.fn(), helper = make(notify), input = source();
    const pending = helper.startCapture(input as unknown as HTMLVideoElement); await Promise.resolve();
    const recorder = recorders.instances[0]; recorder.ready(); await pending;
    recorder.notify?.("encoder failed"); expect(notify).toHaveBeenCalledExactlyOnceWith("encoder failed");
    expect(helper.captureState).toBe("idle"); expect(raf.size).toBe(0);
    await expect(helper.stopCapture()).rejects.toThrow("has not started");
  });
});
