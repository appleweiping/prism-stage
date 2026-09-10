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
        m.version = 2;
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
