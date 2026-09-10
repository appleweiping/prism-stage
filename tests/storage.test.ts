import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { DEFAULT_PARAMS } from "../src/core/presets";
import { FIXED_DT, type PrismProject } from "../src/core/types";
import {
  decodeProject,
  deleteProject,
  encodeProject,
  listProjects,
  loadProject,
  PROJECT_LIMITS,
  saveProject,
} from "../src/storage/projects";

function project(id = "test-take"): PrismProject {
  return {
    manifest: {
      format: "prism-stage",
      version: 1,
      engineVersion: "1.0.0",
      id,
      name: "A saved performance",
      scene: "ribbon",
      createdAt: "2026-09-10T12:00:00.000Z",
      seed: 20260910,
      fixedDt: FIXED_DT,
      duration: 2,
      params: { ...DEFAULT_PARAMS },
      trim: { start: 0.25, end: 1.75 },
      aspect: "landscape",
      source: "video",
    },
    samples: [
      {
        t: 0,
        source: "video",
        hands: [
          { id: "left", x: 0.3, y: 0.7, z: -0.1, pinch: true, strength: 0.95 },
          { id: "right", x: 0.7, y: 0.3, z: 0.1, pinch: false, strength: 0.1 },
        ],
        undoCount: 0,
      },
      { t: 1, source: "video", hands: [], undoCount: 1 },
      { t: 2, source: "video", hands: [], undoCount: 1 },
    ],
  };
}
async function editArchive(
  blob: Blob,
  edit: (files: Record<string, Uint8Array>) => void,
): Promise<Blob> {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  edit(files);
  return new Blob([zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>]);
}
async function editManifest(edit: (m: Record<string, unknown>) => void) {
  return editArchive(await encodeProject(project()), (files) => {
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    edit(manifest);
    files["manifest.json"] = strToU8(JSON.stringify(manifest));
  });
}
afterEach(() => vi.restoreAllMocks());

describe("versioned motion archives", () => {
  it("roundtrips real hand samples, undo events, trim, and deterministic initial-state contract", async () => {
    const original = project();
    const result = await decodeProject(await encodeProject(original));
    expect(result).toEqual(original);
    expect(result.manifest).toMatchObject({
      seed: 20260910,
      fixedDt: 1 / 60,
      engineVersion: "1.0.0",
    });
  });
  it("stores masks as binary resources and restores exact bytes without raw video", async () => {
    const original = project();
    original.manifest.scene = "portal";
    original.samples.forEach((s, i) => {
      s.hands = [];
      s.mask = {
        width: 3,
        height: 2,
        data: Uint8Array.of(0, 22, 66, 128, 255, i),
      };
    });
    const archive = await encodeProject(original);
    const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual([
      "manifest.json",
      "masks/frame-0.bin",
      "masks/frame-1.bin",
      "masks/frame-2.bin",
      "samples.json",
    ]);
    expect(strFromU8(files["samples.json"])).not.toContain('"data"');
    expect(await decodeProject(archive)).toEqual(original);
  });
  it("roundtrips a small PNG thumbnail", async () => {
    const original = project();
    original.thumbnail =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ9sAAAAASUVORK5CYII=";
    expect(await decodeProject(await encodeProject(original))).toEqual(
      original,
    );
  });
  it.each([
    [
      "format",
      (m: Record<string, unknown>) => {
        m.version = 3;
      },
    ],
    [
      "engine",
      (m: Record<string, unknown>) => {
        m.engineVersion = "2.0.0";
      },
    ],
    [
      "step",
      (m: Record<string, unknown>) => {
        m.fixedDt = 1 / 30;
      },
    ],
    [
      "duration",
      (m: Record<string, unknown>) => {
        m.duration = 61;
      },
    ],
    [
      "trim",
      (m: Record<string, unknown>) => {
        m.trim = { start: 0, end: 3 };
      },
    ],
    [
      "seed",
      (m: Record<string, unknown>) => {
        m.seed = -1;
      },
    ],
    [
      "ID",
      (m: Record<string, unknown>) => {
        m.id = "../bad";
      },
    ],
    [
      "scene",
      (m: Record<string, unknown>) => {
        m.scene = "unknown";
      },
    ],
    [
      "source",
      (m: Record<string, unknown>) => {
        m.source = "remote";
      },
    ],
    [
      "unknown field",
      (m: Record<string, unknown>) => {
        m.video = "data:video/webm;base64,";
      },
    ],
  ])(
    "rejects invalid %s without silently migrating it",
    async (_name, edit) => {
      await expect(decodeProject(await editManifest(edit))).rejects.toThrow(
        "Invalid Prism Stage project",
      );
    },
  );
  it("rejects corrupt ZIP bytes and CRC mismatches", async () => {
    await expect(decodeProject(new Blob(["not an archive"]))).rejects.toThrow(
      "Invalid Prism Stage project",
    );
    const archive = await editArchive(await encodeProject(project()), () => {});
    const data = new Uint8Array(await archive.arrayBuffer());
    const view = new DataView(data.buffer);
    const dataStart = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    data[dataStart + 5] ^= 1;
    await expect(decodeProject(new Blob([data]))).rejects.toThrow(
      "checksum mismatch",
    );
  });
  it("rejects zip bombs using declared sizes before inflating", async () => {
    const data = new Uint8Array(
      await (await encodeProject(project())).arrayBuffer(),
    );
    const view = new DataView(data.buffer);
    const end = data.length - 22;
    const directory = view.getUint32(end + 16, true);
    view.setUint32(directory + 24, PROJECT_LIMITS.expandedBytes + 1, true);
    await expect(decodeProject(new Blob([data]))).rejects.toThrow(
      "expanded archive",
    );
    const fakeLarge = new Blob(["small"]);
    Object.defineProperty(fakeLarge, "size", {
      value: PROJECT_LIMITS.archiveBytes + 1,
    });
    const read = vi.spyOn(fakeLarge, "arrayBuffer");
    await expect(decodeProject(fakeLarge)).rejects.toThrow("128 MiB");
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects path traversal, unreferenced masks, and missing resources", async () => {
    const original = project();
    original.samples[0].mask = { width: 2, height: 2, data: new Uint8Array(4) };
    const blob = await encodeProject(original);
    await expect(
      decodeProject(
        await editArchive(blob, (files) => {
          files["../bad"] = Uint8Array.of(1);
        }),
      ),
    ).rejects.toThrow("unexpected");
    await expect(
      decodeProject(
        await editArchive(blob, (files) => {
          files["masks/frame-20.bin"] = Uint8Array.of(1);
        }),
      ),
    ).rejects.toThrow("unreferenced");
    await expect(
      decodeProject(
        await editArchive(blob, (files) => {
          delete files["masks/frame-0.bin"];
        }),
      ),
    ).rejects.toThrow("required mask");
  });
  it.each([
    [
      "timestamps",
      (p: PrismProject) => {
        p.samples[2].t = 0.5;
      },
    ],
    [
      "sample bounds",
      (p: PrismProject) => {
        p.samples[2].t = 3;
      },
    ],
    [
      "coordinate",
      (p: PrismProject) => {
        p.samples[0].hands[0].x = NaN;
      },
    ],
    [
      "duplicate hand",
      (p: PrismProject) => {
        p.samples[0].hands[1].id = "left";
      },
    ],
    [
      "undo order",
      (p: PrismProject) => {
        p.samples[2].undoCount = 0;
      },
    ],
    [
      "mask bytes",
      (p: PrismProject) => {
        p.samples[0].mask = { width: 2, height: 2, data: new Uint8Array(3) };
      },
    ],
    [
      "mask dimensions",
      (p: PrismProject) => {
        p.samples[0].mask = {
          width: 513,
          height: 1,
          data: new Uint8Array(513),
        };
      },
    ],
    [
      "changing mask dimensions",
      (p: PrismProject) => {
        p.samples[0].mask = { width: 2, height: 2, data: new Uint8Array(4) };
        p.samples[1].mask = { width: 4, height: 1, data: new Uint8Array(4) };
      },
    ],
  ])("validates %s before encoding", async (_name, edit) => {
    const p = project();
    edit(p);
    await expect(encodeProject(p)).rejects.toThrow(
      "Invalid Prism Stage project",
    );
  });
});

// These fixtures validate container sniffing and byte preservation only. They
// deliberately contain no encoded frames and are not browser-decode fixtures.
function sourceVideo(mimeType: "video/mp4" | "video/webm") {
  return new Blob(
    [
      mimeType === "video/mp4"
        ? Uint8Array.of(
            0,
            0,
            0,
            24,
            0x66,
            0x74,
            0x79,
            0x70,
            0x69,
            0x73,
            0x6f,
            0x6d,
            0,
            0,
            0,
            0,
            0x69,
            0x73,
            0x6f,
            0x6d,
            0x6d,
            0x70,
            0x34,
            0x32,
          )
        : Uint8Array.of(
            0x1a,
            0x45,
            0xdf,
            0xa3,
            0x87,
            0x42,
            0x82,
            0x84,
            0x77,
            0x65,
            0x62,
            0x6d,
            0x18,
            0x53,
            0x80,
            0x67,
            0xff,
          ),
    ],
    { type: mimeType },
  );
}
function compositeProject(
  mimeType: "video/mp4" | "video/webm" = "video/webm",
): PrismProject {
  const value = project("video-composite");
  value.manifest.version = 2;
  value.manifest.composition = "video";
  value.manifest.video = {
    mimeType,
    width: 1280,
    height: 720,
    duration: 10,
    offset: 1,
  };
  value.video = sourceVideo(mimeType);
  return value;
}
function centralEntry(data: Uint8Array, name: string) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let cursor = view.getUint32(data.length - 22 + 16, true);
  while (view.getUint32(cursor, true) === 0x02014b50) {
    const length = view.getUint16(cursor + 28, true);
    if (strFromU8(data.subarray(cursor + 46, cursor + 46 + length)) === name)
      return { cursor, view };
    cursor +=
      46 +
      length +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true);
  }
  throw new Error(`Missing fixture entry ${name}`);
}

describe("version 2 source video archives", () => {
  it.each(["pinch", "follow"] as const)(
    "roundtrips v2 %s drawing mode with or without retained video, preserving actual gestures",
    async drawingMode => {
      for (const withVideo of [true, false]) {
        const original = withVideo ? compositeProject() : project();
        original.manifest.version = 2;
        original.manifest.composition = withVideo ? "video" : "abstract";
        Object.assign(original.manifest.params, { drawingMode });
        for (const sample of original.samples)
          for (const hand of sample.hands) hand.pinch = false;
        const restored = await decodeProject(await encodeProject(original));
        expect(restored.manifest.params).toEqual(original.manifest.params);
        expect(restored.samples).toEqual(original.samples);
        expect(restored.samples.flatMap(sample => sample.hands).every(hand => !hand.pinch)).toBe(true);
      }
    },
  );
  it("rejects unknown drawing modes on encoding and import", async () => {
    const original = compositeProject();
    Object.assign(original.manifest.params, { drawingMode: "automatic" });
    await expect(encodeProject(original)).rejects.toThrow("drawing mode");
    const archive = await encodeProject(compositeProject());
    const malformed = await editArchive(archive, files => {
      const manifest = JSON.parse(strFromU8(files["manifest.json"]));
      manifest.params.drawingMode = "automatic";
      files["manifest.json"] = strToU8(JSON.stringify(manifest));
    });
    await expect(decodeProject(malformed)).rejects.toThrow("drawing mode");
  });
  it("requires version 2 for either explicit drawing mode while leaving legacy parameters unchanged", async () => {
    for (const drawingMode of ["pinch", "follow"]) {
      const original = project();
      Object.assign(original.manifest.params, { drawingMode });
      await expect(encodeProject(original)).rejects.toThrow("unexpected properties");
      const malformed = await editManifest(manifest => {
        (manifest.params as Record<string, unknown>).drawingMode = drawingMode;
      });
      await expect(decodeProject(malformed)).rejects.toThrow("unexpected properties");
    }
    const legacy = project();
    expect((await decodeProject(await encodeProject(legacy))).manifest.params).toEqual(legacy.manifest.params);
  });
  it("roundtrips a portable video source attribution and license notice", async () => {
    const original = compositeProject();
    original.videoNotice =
      "Source: https://example.org/source.webm\nCopyright Google LLC\nApache License 2.0\n说明：本地保留的来源视频。\n";
    const archive = await encodeProject(original);
    const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    expect(strFromU8(files["source-notice.txt"])).toBe(original.videoNotice);
    expect((await decodeProject(archive)).videoNotice).toBe(
      original.videoNotice,
    );
    original.manifest.id = "library-with-notice";
    await saveProject(original);
    expect((await loadProject(original.manifest.id))?.videoNotice).toBe(
      original.videoNotice,
    );
    await deleteProject(original.manifest.id);
  });
  it("requires video for notices and rejects oversized, invalid, or corrupt text", async () => {
    const noVideo = project();
    noVideo.videoNotice = "No source exists";
    await expect(encodeProject(noVideo)).rejects.toThrow(
      "requires retained source video",
    );
    for (const invalid of [
      "",
      " \n",
      "bad\u0000text",
      "\ud800",
      "字".repeat(22000),
    ]) {
      const value = compositeProject();
      value.videoNotice = invalid;
      await expect(encodeProject(value)).rejects.toThrow("source video notice");
    }
    const archive = await encodeProject(compositeProject());
    await expect(
      decodeProject(
        await editArchive(archive, (files) => {
          files["source-notice.txt"] = Uint8Array.of(0xff, 0xfe);
        }),
      ),
    ).rejects.toThrow("invalid UTF-8");
    await expect(
      decodeProject(
        await editArchive(await encodeProject(project()), (files) => {
          files["source-notice.txt"] = strToU8("A detached license");
        }),
      ),
    ).rejects.toThrow("requires retained source video");
  });
  it("checks declared notice byte size before inflation", async () => {
    const value = compositeProject();
    value.videoNotice = "An attribution";
    const bytes = new Uint8Array(
      await (await encodeProject(value)).arrayBuffer(),
    );
    const { cursor, view } = centralEntry(bytes, "source-notice.txt");
    view.setUint32(cursor + 24, PROJECT_LIMITS.videoNoticeBytes + 1, true);
    await expect(decodeProject(new Blob([bytes]))).rejects.toThrow(
      "expanded archive",
    );
  });
  it.each(["video/mp4", "video/webm"] as const)(
    "roundtrips %s source bytes as one uncompressed, controlled asset",
    async (mimeType) => {
      const original = compositeProject(mimeType);
      const archive = await encodeProject(original);
      const bytes = new Uint8Array(await archive.arrayBuffer());
      const path = mimeType === "video/mp4" ? "source.mp4" : "source.webm";
      const entry = centralEntry(bytes, path);
      expect(entry.view.getUint16(entry.cursor + 10, true)).toBe(0);
      expect(Object.keys(unzipSync(bytes)).sort()).toEqual([
        "manifest.json",
        "samples.json",
        path,
      ]);
      const decoded = await decodeProject(archive);
      expect(decoded.manifest).toEqual(original.manifest);
      expect(decoded.samples).toEqual(original.samples);
      expect(decoded.video?.type).toBe(mimeType);
      expect(await decoded.video!.arrayBuffer()).toEqual(
        await original.video!.arrayBuffer(),
      );
    },
  );
  it("allows an abstract v2 project with no video and retains optional video while restyled abstract", async () => {
    const abstract = project();
    abstract.manifest.version = 2;
    abstract.manifest.composition = "abstract";
    expect(await decodeProject(await encodeProject(abstract))).toEqual(
      abstract,
    );
    const retained = compositeProject();
    retained.manifest.composition = "abstract";
    const restored = await decodeProject(await encodeProject(retained));
    expect(restored.manifest.composition).toBe("abstract");
    expect(await restored.video!.arrayBuffer()).toEqual(
      await retained.video!.arrayBuffer(),
    );
  });
  it("rejects new media fields in v1 rather than silently discarding original footage", async () => {
    const invalid = compositeProject();
    invalid.manifest.version = 1;
    await expect(encodeProject(invalid)).rejects.toThrow(
      "unexpected properties",
    );
    delete invalid.manifest.video;
    delete invalid.manifest.composition;
    await expect(encodeProject(invalid)).rejects.toThrow(
      "version 2 video metadata",
    );
  });
  it.each([
    [
      "missing bytes",
      (p: PrismProject) => {
        delete p.video;
      },
    ],
    [
      "missing metadata",
      (p: PrismProject) => {
        delete p.manifest.video;
      },
    ],
    [
      "unknown composition",
      (p: PrismProject) => {
        (p.manifest as unknown as Record<string, unknown>).composition =
          "green-screen";
      },
    ],
    [
      "nonfinite duration",
      (p: PrismProject) => {
        p.manifest.video!.duration = Infinity;
      },
    ],
    [
      "negative offset",
      (p: PrismProject) => {
        p.manifest.video!.offset = -1;
      },
    ],
    [
      "take beyond media",
      (p: PrismProject) => {
        p.manifest.video!.offset = 9;
      },
    ],
    [
      "zero source duration",
      (p: PrismProject) => {
        p.manifest.video!.duration = 0;
      },
    ],
    [
      "huge dimensions",
      (p: PrismProject) => {
        p.manifest.video!.width = 8193;
      },
    ],
    [
      "fractional dimensions",
      (p: PrismProject) => {
        p.manifest.video!.height = 720.5;
      },
    ],
    [
      "mime mismatch",
      (p: PrismProject) => {
        p.video = sourceVideo("video/mp4");
      },
    ],
    [
      "wrong container bytes",
      (p: PrismProject) => {
        p.video = new Blob(["not a WebM"], { type: "video/webm" });
      },
    ],
  ] as const)("rejects %s before encoding", async (_name, edit) => {
    const value = compositeProject();
    edit(value);
    await expect(encodeProject(value)).rejects.toThrow(
      "Invalid Prism Stage project",
    );
  });
  it("accepts codec-qualified camera Blob MIME and a take ending exactly at the source boundary", async () => {
    const original = compositeProject();
    original.manifest.video!.duration = 2;
    original.manifest.video!.offset = 0;
    original.video = new Blob([original.video!], {
      type: "video/webm;codecs=vp8",
    });
    const restored = await decodeProject(await encodeProject(original));
    expect(restored.video!.type).toBe("video/webm");
    expect(restored.manifest.video).toEqual(original.manifest.video);
  });
  it("rejects oversized source video before reading or allocating its bytes", async () => {
    const original = compositeProject();
    Object.defineProperty(original.video, "size", {
      value: PROJECT_LIMITS.videoBytes + 1,
    });
    const read = vi.spyOn(original.video!, "arrayBuffer");
    const slice = vi.spyOn(original.video!, "slice");
    await expect(encodeProject(original)).rejects.toThrow("96 MiB");
    expect(read).not.toHaveBeenCalled();
    expect(slice).not.toHaveBeenCalled();
  });
  it("enforces the declared video size before ZIP inflation", async () => {
    const bytes = new Uint8Array(
      await (await encodeProject(compositeProject())).arrayBuffer(),
    );
    const { cursor, view } = centralEntry(bytes, "source.webm");
    view.setUint32(cursor + 24, PROJECT_LIMITS.videoBytes + 1, true);
    await expect(decodeProject(new Blob([bytes]))).rejects.toThrow(
      "expanded archive",
    );
  });
  it("rejects missing, extra, incorrectly named, or corrupted video resources", async () => {
    const archive = await encodeProject(compositeProject());
    await expect(
      decodeProject(
        await editArchive(archive, (files) => {
          delete files["source.webm"];
        }),
      ),
    ).rejects.toThrow("required source video");
    await expect(
      decodeProject(
        await editArchive(archive, (files) => {
          files["source.mp4"] = Uint8Array.of(1);
        }),
      ),
    ).rejects.toThrow("unreferenced");
    await expect(
      decodeProject(
        await editArchive(archive, (files) => {
          files["../source.webm"] = files["source.webm"];
        }),
      ),
    ).rejects.toThrow("unexpected");
    const bytes = new Uint8Array(await archive.arrayBuffer());
    const { cursor, view } = centralEntry(bytes, "source.webm");
    const local = view.getUint32(cursor + 42, true);
    const payload =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    bytes[payload + 5] ^= 1;
    await expect(decodeProject(new Blob([bytes]))).rejects.toThrow(
      "checksum mismatch in source.webm",
    );
  });
  it("rejects EBML that is not WebM and malformed MP4 box declarations", async () => {
    const webm = compositeProject();
    const badHeader = new Uint8Array(await webm.video!.arrayBuffer());
    badHeader[8] = 0x78;
    webm.video = new Blob([badHeader], { type: "video/webm" });
    await expect(encodeProject(webm)).rejects.toThrow(
      "document type must be WebM",
    );
    const mp4 = compositeProject("video/mp4");
    const badMp4 = new Uint8Array(await mp4.video!.arrayBuffer());
    badMp4[3] = 255;
    mp4.video = new Blob([badMp4], { type: "video/mp4" });
    await expect(encodeProject(mp4)).rejects.toThrow("ftyp header");
  });
  it("keeps source video through IndexedDB save, replacement, quota failure, and load", async () => {
    const original = compositeProject();
    original.manifest.id = "library-video";
    await saveProject(original);
    const restored = await loadProject(original.manifest.id);
    expect(await restored!.video!.arrayBuffer()).toEqual(
      await original.video!.arrayBuffer(),
    );
    original.manifest.composition = "abstract";
    await saveProject(original);
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    original.manifest.name = "Failed update";
    await expect(saveProject(original)).rejects.toThrow("storage is full");
    const retained = await loadProject(original.manifest.id);
    expect(retained!.manifest.name).not.toBe("Failed update");
    expect(retained!.manifest.composition).toBe("abstract");
    expect(await retained!.video!.arrayBuffer()).toEqual(
      await original.video!.arrayBuffer(),
    );
    await deleteProject(original.manifest.id);
  });
});

describe("explicit local saves", () => {
  it("saves, lists, loads, replaces, and deletes one project", async () => {
    const original = project("library-roundtrip");
    await saveProject(original);
    expect(await loadProject(original.manifest.id)).toEqual(original);
    expect(await listProjects()).toContainEqual(
      expect.objectContaining({
        id: original.manifest.id,
        name: original.manifest.name,
      }),
    );
    original.manifest.name = "A new title";
    await saveProject(original);
    expect((await loadProject(original.manifest.id))?.manifest.name).toBe(
      "A new title",
    );
    await deleteProject(original.manifest.id);
    expect(await loadProject(original.manifest.id)).toBeUndefined();
  });
  it("preserves the previous archive if validation or quota fails", async () => {
    const original = project("library-protected");
    await saveProject(original);
    const invalid = structuredClone(original);
    invalid.manifest.duration = 90;
    await expect(saveProject(invalid)).rejects.toThrow("60 seconds");
    expect(await loadProject(original.manifest.id)).toEqual(original);
    const modified = structuredClone(original);
    modified.manifest.name = "Must not replace";
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    await expect(saveProject(modified)).rejects.toThrow("storage is full");
    expect(await loadProject(original.manifest.id)).toEqual(original);
    await deleteProject(original.manifest.id);
  });
});
