import { strFromU8, strToU8, unzipSync, zip, type Zippable } from "fflate";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import {
  ENGINE_VERSION,
  FIXED_DT,
  MAX_DURATION,
  type PrismProject,
  type ProjectManifest,
  type SavedProjectSummary,
} from "../core/types";

const MiB = 1024 * 1024;
export const PROJECT_LIMITS = Object.freeze({
  archiveBytes: 128 * MiB,
  expandedBytes: 256 * MiB,
  samples: 7201,
  maskSide: 512,
  thumbnailBytes: MiB,
  videoBytes: 96 * MiB,
  videoSide: 8192,
  videoDuration: 24 * 60 * 60,
  videoNoticeBytes: 64 * 1024,
});
const scenes = ["ribbon", "gravity", "portal"];
const sources = ["demo", "camera", "video", "replay", "pointer"];
const palettes = ["aurora", "ember", "glacier", "orchid"];
function fail(message: string): never {
  throw new Error(`Invalid Prism Stage project: ${message}`);
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const bounded = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max;
const member = (value: unknown, values: readonly string[]) =>
  typeof value === "string" && values.includes(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  bounded(value, min, max) && Number.isInteger(value);
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    fail("unexpected properties are not allowed.");
}

function validateManifest(value: unknown): asserts value is ProjectManifest {
  if (!object(value)) fail("manifest is missing.");
  if (
    value.format !== "prism-stage" ||
    ![1, 2].includes(value.version as number)
  )
    fail("unsupported format version. Please use a version 1 or 2 project.");
  keys(value, [
    "format",
    "version",
    "engineVersion",
    "id",
    "name",
    "scene",
    "createdAt",
    "seed",
    "fixedDt",
    "duration",
    "params",
    "trim",
    "aspect",
    "source",
    ...(value.version === 2 ? ["composition", "video"] : []),
  ]);
  if (value.engineVersion !== ENGINE_VERSION)
    fail(
      `engine version must be ${ENGINE_VERSION}; other versions may replay differently.`,
    );
  if (typeof value.id !== "string" || !/^[a-zA-Z0-9_-]{1,96}$/.test(value.id))
    fail("project ID is invalid.");
  if (
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 128 ||
    /[\u0000-\u001f]/.test(value.name)
  )
    fail("name must contain 1–128 visible characters.");
  if (!member(value.scene, scenes) || !member(value.source, sources))
    fail("scene or input source is unknown.");
  if (
    typeof value.createdAt !== "string" ||
    value.createdAt.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    fail("creation time is invalid.");
  if (!integer(value.seed, 0, 0xffffffff))
    fail("seed must be an unsigned 32-bit integer.");
  if (value.fixedDt !== FIXED_DT)
    fail("only the deterministic 1/60 second simulation step is supported.");
  if (!bounded(value.duration, 0, MAX_DURATION))
    fail("recordings must be at most 60 seconds.");
  if (
    !object(value.trim) ||
    !bounded(value.trim.start, 0, value.duration) ||
    !bounded(value.trim.end, value.trim.start, value.duration)
  )
    fail("trim must remain within the recording.");
  keys(value.trim, ["start", "end"]);
  if (!member(value.aspect, ["landscape", "portrait"]))
    fail("aspect ratio is unknown.");
  if (value.version === 2) {
    if (!member(value.composition, ["video", "abstract"]))
      fail("version 2 composition must be video or abstract.");
    if (value.video === undefined) {
      if (value.composition !== "abstract")
        fail("video composition requires retained source video metadata.");
    } else {
      const video = value.video;
      if (!object(video)) fail("source video metadata is invalid.");
      keys(video, ["mimeType", "width", "height", "duration", "offset"]);
      if (!member(video.mimeType, ["video/mp4", "video/webm"]))
        fail("source video must use the MP4 or WebM container.");
      if (
        !integer(video.width, 1, PROJECT_LIMITS.videoSide) ||
        !integer(video.height, 1, PROJECT_LIMITS.videoSide)
      )
        fail("source video dimensions must be integers from 1 to 8192.");
      if (
        !bounded(
          video.duration,
          Number.MIN_VALUE,
          PROJECT_LIMITS.videoDuration,
        ) ||
        !bounded(video.offset, 0, video.duration) ||
        video.offset + value.duration > video.duration + 1e-6
      )
        fail(
          "source video timing must contain the complete take and be at most 24 hours.",
        );
    }
  }
  const p = value.params;
  if (
    !object(p) ||
    !member(p.palette, palettes) ||
    !member(p.material, ["silk", "glass", "neon"]) ||
    !member(p.quality, ["auto", "high", "balanced", "low"])
  )
    fail("visual preset is invalid.");
  keys(p, [
    "palette",
    "intensity",
    "width",
    "trail",
    "speed",
    "feather",
    "material",
    "quality",
    ...(value.version === 2 ? ["drawingMode"] : []),
  ]);
  if (p.drawingMode !== undefined && !member(p.drawingMode, ["pinch", "follow"]))
    fail("drawing mode must be pinch or follow.");
  for (const key of ["intensity", "width", "speed"])
    if (!bounded(p[key], 0, 4))
      fail(`${key} must be a finite number from 0 to 4.`);
  for (const key of ["trail", "feather"])
    if (!bounded(p[key], 0, 1))
      fail(`${key} must be a finite number from 0 to 1.`);
}

function validateProject(value: unknown): asserts value is PrismProject {
  if (!object(value)) fail("project is missing.");
  keys(value, ["manifest", "samples", "thumbnail", "video", "videoNotice"]);
  validateManifest(value.manifest);
  const metadata = value.manifest.video;
  if (metadata !== undefined) {
    if (
      !(value.video instanceof Blob) ||
      !value.video.size ||
      value.video.size > PROJECT_LIMITS.videoBytes
    )
      fail(
        "retained source video must be a nonempty Blob no larger than 96 MiB.",
      );
    const mimeType = value.video.type.split(";")[0].trim().toLowerCase();
    if (mimeType && mimeType !== metadata.mimeType)
      fail("source video MIME type does not match its metadata.");
  } else if (value.video !== undefined) {
    fail("retained source video requires version 2 video metadata.");
  }
  if (value.videoNotice !== undefined) {
    if (!metadata || !(value.video instanceof Blob))
      fail("a source video notice requires retained source video.");
    videoNoticeBytes(value.videoNotice);
  }
  if (
    !Array.isArray(value.samples) ||
    !value.samples.length ||
    value.samples.length > PROJECT_LIMITS.samples
  )
    fail("recording must contain 1–7,201 samples.");
  let previous = -1;
  let previousUndo = 0;
  let maskSize = "";
  let maskBytes = 0;
  for (const sample of value.samples) {
    if (
      !object(sample) ||
      !bounded(sample.t, 0, value.manifest.duration) ||
      sample.t < previous ||
      !member(sample.source, sources)
    )
      fail("sample timestamps or sources are invalid.");
    keys(sample, ["t", "hands", "mask", "source", "undoCount"]);
    previous = sample.t;
    if (sample.undoCount !== undefined) {
      if (!integer(sample.undoCount, previousUndo, PROJECT_LIMITS.samples))
        fail("undo count must be a nondecreasing integer.");
      previousUndo = sample.undoCount;
    }
    if (!Array.isArray(sample.hands) || sample.hands.length > 2)
      fail("a sample supports at most two hands.");
    const ids = new Set<string>();
    for (const hand of sample.hands) {
      if (
        !object(hand) ||
        !member(hand.id, ["left", "right"]) ||
        ids.has(hand.id as string)
      )
        fail("hand identity is invalid or duplicated.");
      keys(hand, ["id", "x", "y", "z", "pinch", "strength"]);
      if (
        !bounded(hand.x, 0, 1) ||
        !bounded(hand.y, 0, 1) ||
        !bounded(hand.z, -4, 4) ||
        !bounded(hand.strength, 0, 1) ||
        typeof hand.pinch !== "boolean"
      )
        fail("hand coordinates or pinch are invalid.");
      ids.add(hand.id as string);
    }
    if (sample.mask !== undefined) {
      const mask = sample.mask;
      if (
        !object(mask) ||
        !integer(mask.width, 1, PROJECT_LIMITS.maskSide) ||
        !integer(mask.height, 1, PROJECT_LIMITS.maskSide) ||
        !(mask.data instanceof Uint8Array) ||
        mask.data.byteLength !== mask.width * mask.height
      )
        fail("mask dimensions must match its bytes, up to 512×512.");
      keys(mask, ["width", "height", "data"]);
      const size = `${mask.width}x${mask.height}`;
      if (maskSize && maskSize !== size)
        fail("mask dimensions must stay constant throughout a recording.");
      maskSize = size;
      maskBytes += mask.data.byteLength;
      if (
        maskBytes + (value.video instanceof Blob ? value.video.size : 0) >
        PROJECT_LIMITS.expandedBytes - 8 * MiB
      )
        fail("recorded mask and source video data is too large.");
    }
  }
  if (value.thumbnail !== undefined) thumbnailBytes(value.thumbnail);
}

function videoPath(metadata: NonNullable<ProjectManifest["video"]>): string {
  return metadata.mimeType === "video/mp4" ? "source.mp4" : "source.webm";
}

function videoNoticeBytes(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > PROJECT_LIMITS.videoNoticeBytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    fail(
      "source video notice must be nonempty UTF-8 text no larger than 64 KiB.",
    );
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff)
      fail("source video notice contains invalid Unicode.");
  }
  const bytes = strToU8(value);
  if (bytes.byteLength > PROJECT_LIMITS.videoNoticeBytes)
    fail("source video notice exceeds 64 KiB of UTF-8 text.");
  return bytes;
}

/** Container-header checks only. Browser decoding separately verifies codec support. */
function validateVideoHeader(bytes: Uint8Array, mimeType: string) {
  if (mimeType === "video/mp4") {
    if (bytes.length < 16) fail("source video has a truncated MP4 header.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = view.getUint32(0);
    if (
      view.getUint32(4) !== 0x66747970 ||
      size < 16 ||
      size > bytes.length ||
      size % 4 !== 0
    )
      fail("source video does not have a valid MP4 ftyp header.");
    return;
  }
  if (
    bytes.length < 12 ||
    ![0x1a, 0x45, 0xdf, 0xa3].every((value, index) => bytes[index] === value)
  )
    fail("source video does not have a WebM EBML header.");
  const vint = (at: number, identifier = false) => {
    if (at >= bytes.length || bytes[at] === 0)
      fail("source video EBML header is truncated.");
    let length = 1,
      marker = 0x80;
    while (!(bytes[at] & marker)) {
      marker >>= 1;
      length++;
    }
    if (length > (identifier ? 4 : 8) || at + length > bytes.length)
      fail("source video EBML field is invalid.");
    let value = identifier ? bytes[at] : bytes[at] & (marker - 1);
    for (let index = 1; index < length; index++)
      value = value * 256 + bytes[at + index];
    if (!Number.isSafeInteger(value))
      fail("source video EBML field is too large.");
    return { value, length };
  };
  const header = vint(4);
  let cursor = 4 + header.length;
  const end = cursor + header.value;
  if (end + 4 > bytes.length) fail("source video EBML header is truncated.");
  let webm = false;
  while (cursor < end) {
    const id = vint(cursor, true);
    cursor += id.length;
    const size = vint(cursor);
    cursor += size.length;
    if (cursor + size.value > end)
      fail("source video EBML element exceeds its header.");
    if (id.value === 0x4282) {
      if (strFromU8(bytes.subarray(cursor, cursor + size.value)) !== "webm")
        fail("source video EBML document type must be WebM.");
      webm = true;
    }
    cursor += size.value;
  }
  if (
    !webm ||
    ![0x18, 0x53, 0x80, 0x67].every(
      (value, index) => bytes[end + index] === value,
    )
  )
    fail("source video WebM document type or segment is missing.");
}

function thumbnailBytes(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    !value.startsWith("data:image/png;base64,") ||
    value.length > PROJECT_LIMITS.thumbnailBytes * 1.34 + 32
  )
    fail("thumbnail must be a PNG smaller than 1 MiB.");
  let binary: string;
  try {
    binary = atob(value.slice(22));
  } catch {
    return fail("thumbnail encoding is invalid.");
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if (bytes.length > PROJECT_LIMITS.thumbnailBytes || !isPng(bytes))
    fail("thumbnail is not a valid PNG.");
  return bytes;
}

function isPng(bytes: Uint8Array) {
  if (
    bytes.length < 33 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
  )
    return false;
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Bound decoded image dimensions as well as compressed thumbnail bytes.
  return (
    header.getUint32(8) === 13 &&
    header.getUint32(12) === 0x49484452 &&
    bounded(header.getUint32(16), 1, 2048) &&
    bounded(header.getUint32(20), 1, 2048)
  );
}
function pngDataUrl(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}

export async function encodeProject(project: PrismProject): Promise<Blob> {
  validateProject(project);
  const entries: Zippable = Object.create(null);
  // Version 1 keeps observations only. Version 2 can explicitly retain the
  // original source video locally, including any tracks in the source file.
  const samples = project.samples.map((sample, index) => {
    if (!sample.mask) return { ...sample };
    const path = `masks/frame-${index}.bin`;
    entries[path] = sample.mask.data.slice();
    return {
      ...sample,
      mask: { width: sample.mask.width, height: sample.mask.height, path },
    };
  });
  entries["manifest.json"] = strToU8(JSON.stringify(project.manifest));
  entries["samples.json"] = strToU8(JSON.stringify(samples));
  if (project.thumbnail)
    entries["thumbnail.png"] = thumbnailBytes(project.thumbnail);
  if (project.manifest.video && project.video) {
    validateVideoHeader(
      new Uint8Array(await project.video.slice(0, 4096).arrayBuffer()),
      project.manifest.video.mimeType,
    );
    entries[videoPath(project.manifest.video)] = [
      new Uint8Array(await project.video.arrayBuffer()),
      { level: 0 },
    ];
    if (project.videoNotice !== undefined)
      entries["source-notice.txt"] = videoNoticeBytes(project.videoNotice);
  }
  const expanded = Object.values(entries).reduce(
    (total, entry) =>
      total +
      (Array.isArray(entry)
        ? (entry[0] as Uint8Array).byteLength
        : (entry as Uint8Array).byteLength),
    0,
  );
  if (expanded > PROJECT_LIMITS.expandedBytes)
    fail("expanded archive exceeds safe size limits.");
  const bytes = await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) =>
    zip(entries, { level: 3 }, (error, result) =>
      error ? reject(error) : resolve(result as Uint8Array<ArrayBuffer>),
    ),
  );
  if (bytes.byteLength > PROJECT_LIMITS.archiveBytes)
    fail("archive exceeds the 128 MiB size limit. Shorten the recording.");
  return new Blob([bytes], { type: "application/vnd.prismstage+zip" });
}

interface Entry {
  size: number;
  crc: number;
}

/** Check declared central-directory sizes BEFORE fflate allocates output buffers. */
function inspectArchive(bytes: Uint8Array): Map<string, Entry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  if (bytes.length < 22) fail("archive is truncated.");
  let end = bytes.length - 22;
  const min = Math.max(0, end - 65535);
  while (
    end >= min &&
    !(u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length)
  )
    end--;
  if (end < min) fail("ZIP directory is missing.");
  const count = u16(end + 10),
    offset = u32(end + 16),
    directorySize = u32(end + 12);
  if (
    u16(end + 4) ||
    u16(end + 6) ||
    count !== u16(end + 8) ||
    count === 65535 ||
    offset === 0xffffffff
  )
    fail("multipart and ZIP64 archives are unsupported.");
  if (
    count < 2 ||
    count > PROJECT_LIMITS.samples + 5 ||
    offset + directorySize !== end
  )
    fail("ZIP directory is invalid.");
  const entries = new Map<string, Entry>();
  const ranges: [number, number][] = [];
  let cursor = offset,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50)
      fail("ZIP entry is truncated.");
    const flags = u16(cursor + 8),
      method = u16(cursor + 10),
      crc = u32(cursor + 16);
    const compressed = u32(cursor + 20),
      size = u32(cursor + 24),
      nameSize = u16(cursor + 28);
    const local = u32(cursor + 42);
    const next = cursor + 46 + nameSize + u16(cursor + 30) + u16(cursor + 32);
    if (
      next > end ||
      !nameSize ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      u16(cursor + 34)
    )
      fail("encrypted or malformed ZIP entry.");
    const name = strFromU8(bytes.subarray(cursor + 46, cursor + 46 + nameSize));
    if (
      !/^(manifest\.json|samples\.json|thumbnail\.png|source-notice\.txt|source\.(mp4|webm)|masks\/frame-\d{1,4}\.bin)$/.test(
        name,
      ) ||
      entries.has(name)
    )
      fail("archive contains an unexpected or duplicate path.");
    const cap =
      name === "manifest.json"
        ? 64 * 1024
        : name === "samples.json"
          ? 4 * MiB
          : name === "thumbnail.png"
            ? MiB
            : name === "source.mp4" || name === "source.webm"
              ? PROJECT_LIMITS.videoBytes
              : name === "source-notice.txt"
                ? PROJECT_LIMITS.videoNoticeBytes
                : PROJECT_LIMITS.maskSide ** 2;
    total += size;
    if (size > cap || total > PROJECT_LIMITS.expandedBytes)
      fail("expanded archive exceeds safe size limits.");
    if (
      local + 30 > offset ||
      u32(local) !== 0x04034b50 ||
      u16(local + 8) !== method ||
      u16(local + 6) !== flags
    )
      fail("local ZIP header is invalid.");
    const localNameSize = u16(local + 26),
      dataStart = local + 30 + localNameSize + u16(local + 28);
    if (
      dataStart + compressed > offset ||
      strFromU8(bytes.subarray(local + 30, local + 30 + localNameSize)) !== name
    )
      fail("ZIP entry data is invalid.");
    if (
      !(flags & 8) &&
      (u32(local + 18) !== compressed ||
        u32(local + 22) !== size ||
        u32(local + 14) !== crc)
    )
      fail("ZIP header sizes or checksums disagree.");
    if (method === 0 && compressed !== size)
      fail("stored ZIP entry has inconsistent size.");
    ranges.push([local, dataStart + compressed]);
    entries.set(name, { size, crc });
    cursor = next;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, i) => i > 0 && range[0] < ranges[i - 1][1]))
    fail("ZIP entries overlap.");
  if (
    cursor !== end ||
    !entries.has("manifest.json") ||
    !entries.has("samples.json")
  )
    fail("manifest or recording is missing.");
  return entries;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let c = value;
  for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  return c;
});
function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function decodeProject(file: Blob): Promise<PrismProject> {
  if (file.size > PROJECT_LIMITS.archiveBytes)
    fail("archive exceeds the 128 MiB size limit.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let entries: Map<string, Entry>, files: Record<string, Uint8Array>;
  try {
    entries = inspectArchive(bytes);
    files = unzipSync(bytes);
    for (const [name, entry] of entries)
      if (
        !files[name] ||
        files[name].byteLength !== entry.size ||
        crc32(files[name]) !== entry.crc
      )
        fail(`checksum mismatch in ${name}.`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Invalid Prism Stage")
    )
      throw error;
    return fail("ZIP data is corrupt or incomplete.");
  }
  let manifest: unknown, samples: unknown;
  try {
    manifest = JSON.parse(strFromU8(files["manifest.json"]));
    samples = JSON.parse(strFromU8(files["samples.json"]));
  } catch {
    return fail("manifest or recording JSON is corrupt.");
  }
  validateManifest(manifest);
  if (!Array.isArray(samples) || samples.length > PROJECT_LIMITS.samples)
    fail("sample count is invalid.");
  const used = new Set(["manifest.json", "samples.json"]);
  const restored = samples.map((sample: unknown, index) => {
    if (!object(sample)) return fail("sample is invalid.");
    if (sample.mask === undefined) return sample;
    const mask = sample.mask;
    if (
      !object(mask) ||
      mask.path !== `masks/frame-${index}.bin` ||
      !files[mask.path as string]
    )
      fail("a required mask resource is missing.");
    keys(mask, ["width", "height", "path"]);
    used.add(mask.path as string);
    return {
      ...sample,
      mask: {
        width: mask.width,
        height: mask.height,
        data: files[mask.path as string],
      },
    };
  });
  let thumbnail: string | undefined;
  if (files["thumbnail.png"]) {
    if (!isPng(files["thumbnail.png"])) fail("thumbnail is not a PNG.");
    thumbnail = pngDataUrl(files["thumbnail.png"]);
    used.add("thumbnail.png");
  }
  let video: Blob | undefined;
  let videoNotice: string | undefined;
  if (manifest.video) {
    const path = videoPath(manifest.video);
    const bytes = files[path];
    if (!bytes?.length) fail("a required source video resource is missing.");
    validateVideoHeader(bytes.subarray(0, 4096), manifest.video.mimeType);
    video = new Blob([bytes as Uint8Array<ArrayBuffer>], {
      type: manifest.video.mimeType,
    });
    used.add(path);
  }
  if (files["source-notice.txt"]) {
    if (!video) fail("a source video notice requires retained source video.");
    try {
      videoNotice = new TextDecoder("utf-8", { fatal: true }).decode(
        files["source-notice.txt"],
      );
    } catch {
      fail("source video notice contains invalid UTF-8.");
    }
    videoNoticeBytes(videoNotice);
    used.add("source-notice.txt");
  }
  if (used.size !== entries.size)
    fail("archive contains unreferenced resources.");
  const project: unknown = {
    manifest,
    samples: restored,
    ...(thumbnail ? { thumbnail } : {}),
    ...(video ? { video } : {}),
    ...(videoNotice !== undefined ? { videoNotice } : {}),
  };
  validateProject(project);
  return project;
}

interface StoredProject {
  id: string;
  summary: SavedProjectSummary;
  archive: Blob;
}
interface ProjectDatabase extends DBSchema {
  projects: { key: string; value: StoredProject };
}
let database: Promise<IDBPDatabase<ProjectDatabase>> | undefined;
function getDatabase() {
  if (!globalThis.indexedDB)
    throw new Error(
      "Local storage is unavailable in this browser. Download the project file to keep your work.",
    );
  database ??= openDB<ProjectDatabase>("prism-stage", 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("projects"))
        db.createObjectStore("projects", { keyPath: "id" });
    },
    terminated() {
      database = undefined;
    },
  }).catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
}

export async function saveProject(project: PrismProject): Promise<void> {
  // Validation and compression finish before opening a write transaction; failures preserve the existing entry.
  const { id, name, scene, createdAt, duration } = project.manifest;
  const summary: SavedProjectSummary = {
    id,
    name,
    scene,
    createdAt,
    duration,
    ...(project.thumbnail ? { thumbnail: project.thumbnail } : {}),
  };
  const archive = await encodeProject(project);
  try {
    const db = await getDatabase();
    await db.put("projects", { id, summary, archive });
  } catch (error) {
    if (error instanceof DOMException && error.name === "QuotaExceededError")
      throw new Error(
        "Your browser storage is full. Download a project file or remove a saved work and try again. The previous save is intact.",
      );
    throw new Error(
      `Could not save locally. Download a project file to keep your work. ${error instanceof Error ? error.message : ""}`,
    );
  }
}
export async function listProjects(): Promise<SavedProjectSummary[]> {
  const db = await getDatabase();
  return (await db.getAll("projects"))
    .map((row) => row.summary)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function loadProject(
  id: string,
): Promise<PrismProject | undefined> {
  const db = await getDatabase();
  const row = await db.get("projects", id);
  return row ? decodeProject(row.archive) : undefined;
}
export async function deleteProject(id: string): Promise<void> {
  const db = await getDatabase();
  await db.delete("projects", id);
}
