# Prism Stage project format — version 1

An editable take is a `.prismstage` ZIP archive. Its media type is `application/vnd.prismstage+zip`. The authoritative implementation is [projects.ts](../src/storage/projects.ts), with public TypeScript types in [types.ts](../src/core/types.ts).

The archive contains processed motion, rendering settings, and optional person masks. It does not contain original camera/video frames, audio, model weights, or serialized JavaScript. It can be replayed without the source video or vision model. PNG and video exports are flattened artwork and cannot replace an editable project.

## Archive layout

```text
my-study.prismstage
├── manifest.json
├── samples.json
├── masks/                  # optional; no directory entry is required
│   ├── frame-0.bin
│   └── frame-1.bin
└── thumbnail.png           # optional
```

The index in a mask filename is the **zero-based index in `samples.json`**, not a video frame number. A sample without a mask has no corresponding file. Mask filenames must match their owning sample exactly. Unknown paths, duplicated paths, and unreferenced resources are rejected.

### `manifest.json`

```json
{
  "format": "prism-stage",
  "version": 1,
  "engineVersion": "1.0.0",
  "id": "example-aurora",
  "name": "Aurora study",
  "scene": "ribbon",
  "createdAt": "2026-09-10T12:00:00.000Z",
  "seed": 20260910,
  "fixedDt": 0.016666666666666666,
  "duration": 12,
  "params": {
    "palette": "aurora",
    "intensity": 0.85,
    "width": 0.6,
    "trail": 0.72,
    "speed": 0.65,
    "feather": 0.5,
    "material": "silk",
    "quality": "auto"
  },
  "trim": { "start": 0, "end": 12 },
  "aspect": "landscape",
  "source": "demo"
}
```

| Field | Version 1 contract |
| --- | --- |
| `format`, `version`, `engineVersion` | Exactly `prism-stage`, `1`, and `1.0.0`. Other versions are rejected; no automatic migration. |
| `id` | 1–96 ASCII letters, digits, underscores, or hyphens. UUIDs are supported. |
| `name` | Nonblank, at most 128 JavaScript string code units; control characters U+0000–U+001F are rejected. |
| `scene` | `ribbon`, `gravity`, or `portal`. One stage per project. |
| `createdAt` | Parseable date string beginning with `YYYY-MM-DDT`, at most 40 characters; the application writes UTC ISO timestamps. |
| `seed` | Unsigned 32-bit integer, 0 through 4,294,967,295. |
| `fixedDt` | Exactly JavaScript `1 / 60`, as shown above. |
| `duration` | Finite seconds in `[0, 60]`. The UI requires a useful recorded take before saving or exporting. |
| `trim` | Finite `0 ≤ start ≤ end ≤ duration`; these select playback/export bounds without deleting observations. |
| `aspect` | `landscape` or `portrait`; selects the orthographic crop. |
| `source` | `demo`, `camera`, `video`, `replay`, or `pointer`. This is provenance, not a command to open a device. Some values are reserved for programmatic input; the UI offers demo, camera, and local video. |

Visual parameters are finite numbers. `intensity`, `width`, and `speed` accept `[0, 4]`; `trail` and `feather` accept `[0, 1]`. These are renderer controls, not calibrated physical units. Palettes are `aurora`, `ember`, `glacier`, and `orchid`; materials are `silk`, `glass`, and `neon`; quality is `auto`, `high`, `balanced`, or `low`. The UI may expose narrower useful ranges. Version 1 rejects unknown manifest, parameter, trim, sample, hand, and mask properties instead of silently dropping unsupported state.

### `samples.json`

The recording is an array of 1–7,201 samples. The following short array illustrates hand input; an actual take contains observations throughout its duration:

```json
[
  {
    "t": 0,
    "source": "video",
    "undoCount": 0,
    "hands": [
      { "id": "left", "x": 0.3, "y": 0.6, "z": -0.1, "pinch": true, "strength": 0.9 },
      { "id": "right", "x": 0.7, "y": 0.4, "z": 0.1, "pinch": false, "strength": 0.1 }
    ]
  },
  { "t": 0.016666666666666666, "source": "video", "undoCount": 0, "hands": [] }
]
```

- `t` is finite elapsed time in seconds, nondecreasing and inside `[0, duration]`. The runtime records processed hands at fixed simulation steps; it does not store every raw landmark.
- `hands` always exists and contains at most one `left` and one `right` track. An empty array releases active gestures. IDs identify short-lived interaction tracks, not people.
- `x` and `y` are mirrored image coordinates in `[0, 1]`: `(0, 0)` is the upper-left of the mirrored input. Mirror exactly once before storage.
- `z` is finite in `[-4, 4]` at the format boundary. Live tracking currently emits the narrower `[-0.35, 0.35]`; it is a palm-size-derived artistic depth, not meters.
- `pinch` is Boolean. `strength` is `[0, 1]`, derived from pinch geometry; it is not the model's detection confidence.
- `source` uses the manifest's source enum, but is stored per sample as well.
- Optional `undoCount` is a nondecreasing integer in `[0, 7201]`. It counts cumulative ribbon undo actions. A repeated count does not execute an undo twice. Writers should carry the current count forward on each subsequent sample.

### Binary masks

A portal sample references its own mask:

```json
{
  "t": 0.1,
  "source": "camera",
  "hands": [],
  "mask": { "width": 256, "height": 144, "path": "masks/frame-0.bin" }
}
```

For this illustration the sample must be at array index 0. `frame-0.bin` is exactly `256 × 144 = 36,864` bytes: one unsigned 8-bit probability per pixel, row-major, no header, no color channels. `0` is background and `255` is person. Intermediate values preserve soft confidence. Width and height stay constant across all masks in one take.

In memory, `mask.path` becomes `mask.data: Uint8Array`. The encoder makes the opposite transformation. The live worker currently outputs at most 256×144. It copies and quantizes the model output before the model callback releases its buffer. Portal recordings retain distinct received masks; replay holds a sample until the next timestamp, so model inference need not match the render frame rate.

## Replay and compatibility

The **initial state is derived**, not a separate opaque physics snapshot: scene + seed + engine version define the initial arrangement and fixed simulation constants. Gravity's body count, radii generation, forces, restitution, and boundaries belong to the pinned engine implementation. Version 1 has no editable physical-parameter fields.

Seeking resets the scene to that seed and advances at `fixedDt`, selecting the latest sample whose time is not after the current simulation time. The full take is retained even when its export is trimmed. Visual changes and aspect changes do not change the gravity simulation's initial conditions or timestep. Reopening a project does not rerun vision inference.

This is a reproducible simulation contract within the supported engine. It is not a promise of byte-identical video files or pixel-identical rendering across GPUs, browser versions, and encoders. Changing physics behavior requires an intentional engine/format compatibility decision.

## Import bounds and storage

| Resource | Limit |
| --- | --- |
| Compressed archive | 128 MiB, checked before reading its bytes |
| Total declared uncompressed bytes | 256 MiB |
| `manifest.json` | 64 KiB |
| `samples.json` | 4 MiB |
| Samples | 1–7,201 |
| Each mask | Width and height each 1–512; bytes must equal width × height |
| Total in-memory mask bytes | At most 248 MiB, reserving metadata headroom |
| Optional thumbnail | PNG, at most 1 MiB, IHDR dimensions at most 2048×2048 |
| ZIP entries | At most 7,204; stored or DEFLATE compression only |

The importer inspects central-directory lengths before decompression, checks local header consistency, rejects overlapping entry ranges, verifies each extracted CRC32, and validates required resources and data fields. Encrypted, multipart, ZIP64, malformed, and path-traversal archives are rejected. These bounds reduce memory abuse; they do not make corrupted files recoverable.

Explicit saves use IndexedDB database `prism-stage`, version 1, object store `projects`, key path `id`. Each row holds `{ id, summary, archive }`; `archive` is the validated ZIP `Blob`. Validation and compression complete before a write transaction. A failed validation or quota-limited save does not replace the previous saved row. Saving the same ID replaces that project's existing entry; deletion is explicit. Browser eviction or clearing site data can remove this library, so a downloaded `.prismstage` is the portable backup.
