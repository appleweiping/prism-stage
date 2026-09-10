# Architecture

Prism Stage is a static React/TypeScript application with three creative stages. MediaPipe runs in a browser worker, Three.js renders a single canvas, and the runtime turns observations into editable takes. There is no application server, account system, upload endpoint, or paid inference API.

## Data flow and ownership

```mermaid
flowchart LR
    C[Camera or local video] --> V[VisionController]
    V -->|One transferable ImageBitmap| W[Vision worker]
    W -->|Hands or quantized mask| R[StudioRuntime]
    D[Labelled procedural demo] --> R
    P[Imported project] --> R
    R -->|Fixed-step InputSample| S[ScenePlugin]
    S --> T[Three.js canvas]
    R --> K[Editable take]
    K --> Z[ZIP / IndexedDB]
    T --> E[PNG / MediaRecorder video]
```

| Component | Responsibility |
| --- | --- |
| `App` | Bilingual studio controls, parameter presets, source selection, library, and status presentation. |
| `StudioRuntime` | Live/recording/replay/export states, the fixed-step clock, undo counts, trim, seeking, and orchestration. |
| `VisionController` | Device permission, local video decoding, frame scheduling, worker lifecycle, GPU/CPU recovery, and input cleanup. |
| `vision.worker` | One scene-relevant model, model inference, hand stabilization, copied/quantized masks, and transferable result delivery. |
| `StageEngine` | One Three.js WebGL renderer, orthographic camera, shared atmosphere, scene switching, rendering resolution, and disposal. |
| `ScenePlugin` | `update`, `setParams`, `reset`, optional `undo`, and `dispose`; receives observations and never accesses the camera. |
| Storage/export modules | Validated editable ZIP files, explicit IndexedDB saves, flattened artwork downloads, and recorder cleanup. |

The public contracts are [types.ts](../src/core/types.ts). File format details are in [PROJECT_FORMAT.md](PROJECT_FORMAT.md).

The video exporter copies only the final WebGL artwork into a same-size, opaque
2D composition canvas. This gives capture a stable surface independently of the
WebGL renderer's backing store. It uses a zero-rate canvas stream and explicit
[`requestFrame()`](https://developer.mozilla.org/en-US/docs/Web/API/CanvasCaptureMediaStreamTrack/requestFrame)
after rendered frames, throttled toward 30 fps. A browser without manual
frame support receives a fresh automatic 30 fps stream instead. The final renderer
remains the only pixel source; controls and calibration video are outside it.

WebM/VP8 is preferred when advertised. Format support is a capability hint,
not a guarantee that a particular capture will produce encoded frames. Completed
exports are checked for nonempty data, and validation decodes the resulting media.

## Vision pipeline

Camera capture requests video only, ideally 1280×720 at 30 fps. Local files use a browser object URL and the browser's decoder; files larger than 512 MiB are rejected. A decoded frame is resized to fit 640×360 before transfer. Original video is shown only in the input preview and does not become a scene texture or a project asset.

`VisionController` uses `requestVideoFrameCallback` when available and a `requestAnimationFrame` fallback. At most one frame is in flight. Busy periods skip incoming frames rather than queuing an increasing delay. Each bitmap is transferred to the worker and closed after processing. Session IDs invalidate replaced inputs; a separate epoch invalidates results after video seeking. Model timestamps remain monotonically increasing even when source media time jumps backward.

Ribbons and gravity instantiate **Hand Landmarker** with two hands. Portal instantiates only **Image Segmenter** with the landscape selfie model. Models and the MediaPipe module-WASM files are requested from the application origin. Initialization first attempts GPU; initialization or runtime GPU failure triggers a fresh CPU worker. Initialization and frame timeouts produce recoverable errors. Stopping an input terminates its worker, cancels frame callbacks, stops camera tracks, clears the video, and revokes its object URL.

The MediaPipe 1.0.1 SDK was observed attempting periodic telemetry requests to `odml.pa.googleapis.com/v1/log`. Prism Stage does **not** assume the upstream SDK is network-silent: the worker installs `makeLocalFetch` before model initialization, rejecting cross-origin fetches before they reach the network. Same-origin model/WASM requests remain allowed. The production content security policy provides an additional connection restriction. This gate is covered by tests; inspect network traffic during real inference when changing SDK versions. Original pixels are still needed locally for inference, but neither those frames nor their source video are uploaded.

### Hand observations become controls

The hand tracker applies a small, inspectable state machine:

1. Reject nonfinite or incomplete landmarks and consider at most two hands.
2. Associate the two possible tracks by wrist distance to a velocity-predicted location. MediaPipe handedness is a soft cost, not an absolute identity rule. Association history expires after 600 ms without a new observation; backward timestamps reset stale history. An explicit no-hand result immediately releases interaction, independent of that association window.
3. Compute the thumb-tip/index-tip separation divided by the index-MCP/pinky-MCP palm width. Distances account for image aspect ratio.
4. Close below a ratio of 0.34; remain closed until the ratio reaches 0.56. A transition requires at least two observations and 40 ms.
5. Smooth the midpoint using `alpha = 1 - exp(-dt / 0.045)`, mirror x once, and clamp the output. Derive artistic depth from apparent palm size and clamp it to ±0.35.
6. Omit missing hands from the output. Scenes then end strokes or release grabs; no disconnected hand is allowed to hold an object indefinitely.

These are application-level heuristics, not a newly trained gesture recognizer. Identity can still be ambiguous during full overlap or occlusion. Bright, even lighting and prominent, unobstructed hands help the upstream model. The UI's pinch strength comes from geometry rather than handedness confidence.

### Person masks

The worker copies a person confidence tensor while the MediaPipe callback owns it, mirrors it once, and quantizes `[0, 1]` to unsigned bytes. The current output is at most 256×144. Only this mask reaches the portal renderer. This is a low-resolution segmentation effect, not fine-grained video matting; thin fingers, hair, blur, occlusion, and distant subjects can produce imperfect edges. See the linked model cards in [Third-party notices](../THIRD_PARTY_NOTICES.md).

## Rendering the stages

The simulation world is 12×6.75 units. A fixed-height orthographic camera changes its horizontal crop for portrait output; hand mapping, forces, and object positions remain unchanged. The renderer uses an opaque background, sRGB output, ACES tone mapping, and a preserved drawing buffer for artwork export. One renderer survives stage switches. Scene geometry, shader materials, textures, and Rapier worlds have explicit owners and disposal paths.

| Stage | Implementation |
| --- | --- |
| **Ribbon Atelier** | Each active pinching hand extends a volumetric ribbon built from flattened ten-vertex rings along a path. Tangents, twist, surface normals, and a tapered start give it thickness. Original shaders implement silk, glass, and neon looks; point birth times control trail fading. Width changes rebuild geometry from the stored path. The scene bounds memory to 32 strokes of at most 720 points each, continues long strokes in a new segment, and evicts the oldest stroke when full. Undo removes the latest stroke. |
| **Gravity Garden** | Rapier simulates twelve seeded rigid spheres in a bounded volume at 1/60 second steps. A weak central force, damping, and restitution maintain a drifting garden. Pinch near a sphere acquires an exclusive kinematic grab, preserving the initial offset. Release returns it to a dynamic body with smoothed, capped hand-derived velocity. Missing hands release immediately. The ball meshes, halos, and trails follow the bodies; appearance parameters do not alter their colliders or physical constants. |
| **Silhouette Portal** | A reusable single-channel `DataTexture` holds the latest mask. The shader samples neighboring probabilities, softens the threshold, estimates an edge glow, and clips a seeded procedural interior of noise, bands, filaments, and stars. The artwork uses the silhouette as a window. It does not reconstruct unseen scenery or require a colored cloth. |

Automatic quality changes canvas resolution only, leaving the input and physics timestep intact. It starts at full resolution and can step down to 0.82 or 0.65 after sustained slow rendering. Balanced and low select these scales directly. Exports temporarily render at full requested dimensions. GPU capability, thermal throttling, and the browser's encoder still determine achievable frame rate; the quality mechanism is not a hardware-independent FPS guarantee.

## Record, reinterpret, export

The runtime advances a fixed `1 / 60` simulation clock inside `requestAnimationFrame`. Hand scenes record the processed input at each simulation step. Portal records distinct received masks, with timestamps; replay holds each sample until the next one. A take stops at 60 seconds. The default procedural demonstration has explicit demo provenance and runs independently of inference; starting real input never substitutes demo observations for failed recognition.

Seeking resets the active scene to its seed and simulates forward using recorded samples. Cumulative undo counts apply each recorded undo exactly once. Project settings preserve engine version and fixed timestep. The current v1 physical constants are not user-editable, so changing a palette or material during replay cannot silently change gravity's physical setup. A trimmed export simulates the preceding portion to arrive at the correct start state.

The recorder captures the final canvas at a requested 30 fps, without microphone audio. It probes VP8 WebM, VP9 WebM, generic WebM, then MP4 and uses the actual supported MIME/container extension. Export is performed in real time in the foreground. Hiding the tab, cancelling, encoder failure, empty output, or failure to finish rejects the export and releases capture tracks. Browser encoding can make output duration and cadence approximate; verify decoded media when publishing a benchmark or demo.

Each rendered artwork frame is copied to a dedicated opaque 2D canvas with fixed export dimensions. Its capture track uses explicit frame requests where available, with automatic 30 fps capture as the fallback. Before advancing the take, a disposable recorder repeatedly captures the artwork's initial frame until it produces substantive output, bounded by a 15-second timeout. Its chunks are discarded; a new recorder uses the same prepared stream for the actual take. This separates cold encoder initialization from the motion timeline without including a warm-up sequence in the result. Cancellation also releases preparation timers and settles the waiting export.

## Offline assets and build boundary

`npm run assets` obtains two version-1 Google model files, copies the exact MediaPipe 1.0.1 WASM distribution, and writes asset byte counts and SHA-256 hashes into `public/models/manifest.json`. Existing model hashes are checked on subsequent setup runs. Fonts come from the pinned local Inter package. Vite bundles application code and worker modules; production deployment must include models, WASM, fonts, and sample projects under the same base URL.

Offline support uses a production service worker. The UI asks it to prepare required assets and displays readiness only after the cache reports completion. Development mode deliberately reports offline support as unavailable. First-use networking for assets is distinct from inference: camera pixels and locally imported footage are not sent to a service. Cache storage and the explicitly saved IndexedDB project library are separate and can both be removed by browser site-data controls.

## Verification boundaries

Algorithm tests cover gesture thresholds, association, missing input, and mask mirroring. Archive tests verify hand/mask roundtrips, engine compatibility, corruption, resource bounds, and failure-safe local saves. Recorder unit tests cover format selection and lifecycle failures; they do not prove a real hardware encoder produces playable media.

Before publishing a release, run the full typecheck and tests, exercise real video through the actual worker/model, decode exported clips, inspect all three stages, and test denied permission, model failure, offline reopen, and repeated scene changes. Report measured device/browser details separately from targets. No result from the synthetic demo should be reported as a model-accuracy test.
