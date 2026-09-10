# Validation

This page preserves **v1.0.0 abstract-output validation** after the current camera
check below. The historical checks and benchmark values do not establish v1.1
original-video composition or its performance. New composite examples and their
browser/decoder evidence are recorded separately.

## v1.1 camera recording and retained-video replay

[camera-composite-validation.json](camera-composite-validation.json) records a
complete native camera path on build `2506f2efd6969ea7`, using a fresh Chrome
152 context. Chrome's native fake-camera device plays the checksum-verified,
Apache-2.0 Google gesture video; no physical camera, microphone, model output
replacement, or additional screen encoder is involved.

- A 6.837-second recording produced 47 actual camera observations, 39 containing
  hands. All observation times fell inside the take; this capture contained no
  confirmed pinch and does not establish ribbon drawing or sphere grabbing.
- The v2 project retained the silent original WebM. Seeking to 1 and 4 seconds
  changed the image; after saving and reopening, the 4-second frame matched
  exactly at the 160 × 90 comparison resolution. Saving again preserved the
  original video bytes unchanged.
- FFmpeg fully decoded the retained original at 1280 × 720, 6.838 seconds,
  182 frames (180 unique), and the final composite at 1280 × 720, 6.747 seconds,
  203 frames (203 unique). Both had no audio stream. The browser's exported-film
  preview also advanced normally.
- All 17 observed HTTP requests were same-origin GETs. No console error or
  uncaught browser exception was observed. The 10,089 ms first GPU inference
  was a cold startup reading, not a steady-state performance benchmark.

The fixture shows a person against a curtain. This verifies local camera API,
inference, media capture, project replay and export behavior; it does not measure
physical-camera lighting variation, exact per-frame hand alignment, room
reconstruction, or real-world occlusion.

To repeat, install Chrome and FFmpeg, run `npm run test:fixtures`, build and start
the production preview on port 4173, then run:

```sh
node tests/camera-composite-browser.mjs
```

Set `PRISM_FFMPEG` when FFmpeg is outside `PATH`; `CHROME_PATH` and
`PRISM_TEST_URL` are optional overrides. `--prepare-only` converts the licensed
source to an ignored local Y4M without launching a browser. The test closes its
browser before decoding the recorded media and writes its evidence to the JSON
report above.

## Historical v1.0 scope

Prism Stage keeps three kinds of evidence separate: synthetic visual examples, real model inference, and application/format tests. The screenshots in `docs/images` are exported by the real stage renderer; the three bundled example inputs are explicitly synthetic.

## Environment

- Development machine: Windows, Intel Iris Xe graphics; Node.js22.21.1.
- Runtime: React19.2.0, Three.js0.180.0, Rapier0.19.3, MediaPipe Tasks Vision1.0.1.
- Browser targets: desktop Chrome and Edge. Tested browser/build/rendering details are in the machine-readable evidence below; a responsive screenshot does not establish mobile camera performance.

## Automated checks

`npm run check` runs strict TypeScript and Vitest. The suites cover:

The v1.0.0 build passes **80 automated tests** across five suites.

| Suite | Cases |
| --- | --- |
| Vision tracking | Palm-scaled hysteresis, confirmation, mirrored coordinates/masks, identity crossing, no-hand release, slow inference gaps, reset, invalid landmarks, external telemetry blocked before fetch |
| Engine | Seeded rigid-body state, replay after visual edits, bounded collisions, ribbon undo/release, geometry determinism, width vs centerline, mask handling |
| Project storage | Hand and mask roundtrip, corruption/CRC, version/schema/time limits, ZIP expansion safety, image restrictions, IndexedDB failure protection |
| Export | Supported MIME, manual frame cadence and fallback, encoder readiness before replay, capture lifecycle, cancellation, empty output, encoder failure, hidden-page abort, stream cleanup |
| Studio runtime | Fixed-frame seeking, continuous/reconstructed step equality,60-second recording cap, source restart/end/error, concurrent project loads, image/video export restoration, fresh take→recolor→save→frame submission, paused rendering |

These tests assert output behavior and failure recovery; they do not replace a real-model or browser check.

A [fresh independent checkout](fresh-checkout-validation.json) also passed
`npm ci`, all 80 tests, and the production build. All 35 generated files matched
the tested build byte for byte; the complete dependency audit reported no known
vulnerabilities at validation time.

## Actual model inference

Provenance and SHA-256 of the official Google sample videos are in [validation-assets.json](validation-assets.json). The v1.0 tests downloaded originals into the ignored `.local/fixtures` directory. In v1.1, the licensed gesture video's original bytes are explicitly included in the separately attributed `real-*.prismstage` composite examples; this changes sample distribution, not what the historical tests measured.

The real-video harness uses the production `VisionController` and actual MediaPipe models, then downloads observations and importable project files. Results include:

- [vision-video-results.json](vision-video-results.json): the official hand video produced hands on71 of72 observations in the ribbon test. The portal produced211 masks with209 successive changes and33.25–39.66% foreground coverage.
- [vision-gesture-results.json](vision-gesture-results.json): the gesture video produced69 observations,61 with a hand, up to two hands, and6 pinched observations for the ribbon capture. The portal produced235 actual masks,232 of which changed.
- Those initial captures ran with multiple rendering/model tabs active. Their inference medians are **contention measurements**, not a clean device benchmark. Blank-frame warmup timings are not substituted for real-person inference timings.

The plain hand video contained no pinch. Its detection success is not evidence of drawing/grabbing success. The separate gesture fixture supplied genuine pinch observations. Missing observations were not filled with invented hand positions.

The exact model-observation projects used by the export test are committed in
[`tests/fixtures`](../tests/fixtures/README.md). The separately captured gravity
fixture contains no confirmed pinch, so that real-video result does not establish
grab/throw recognition; engine tests and the synthetic example cover physical
grab/throw behavior. To repeat input inference, run `npm run test:fixtures`, start
`npm run dev`, and open `/tests/vision-video.html`.

## Browser and export evidence

[production-validation.json](production-validation.json) records the production UI checks and actual environment. [Export media checks](export-validation.json) record decoded output sizes, durations and frame changes. Browser checks use an isolated test context; no personal camera footage or browser storage is accessed.

During interactive review, all three stages rendered without shader errors and20 consecutive stage switches completed successfully. Three actual high-quality canvas exports were saved at1280×720:

- [Ribbon](images/ribbon.png): synthetic example around6seconds.
- [Gravity](images/gravity.png): synthetic example around8seconds.
- [Portal](images/portal.png): synthetic example at5seconds.

The production workflow includes project import/replay, appearance editing, saving, and final canvas export. The completed video is a foreground real-time capture, not a promise of a constant encoded frame count on every device.

The v1.0 production suite passed **19 browser checks** against offline build
`7068c13e94d07cf8`. Ordinary studio rendering was sampled with the diagnostics
dialog closed; it was opened briefly every third sample for inference readings.
No extra screen-recording encoder ran during these checks. On Windows / Chrome 152 / Intel Iris Xe / WebGL2,
1280 × 720 with GPU inference and High/Auto rendering:

| Stage | Median render rate | Median inference time | Median inference rate |
| --- | ---: | ---: | ---: |
| Ribbon Atelier | 56.5 fps | 110 ms | 7.30 fps |
| Gravity Garden | 59 fps | 141 ms | 7.45 fps |
| Silhouette Portal | 59.5 fps | 27 ms | 23.85 fps |

These are 12 scheduled one-second samples, spanning 13.246 / 13.134 / 12.786
seconds including UI reads, on this machine. They are not universal device
guarantees. The first reported inference durations were 1.804 / 2.002 / 3.571
seconds respectively. The separate model-failure recovery check reported an
8.397-second first inference. These cold measurements are excluded from the warm
median columns. Medians average the two middle values for even-sized samples.
Decoder frame drops are recorded separately; inference-scheduler skip counts are
not exposed in this version. Render rate, inference rate and encoded video cadence
measure different parts of the application.

### Fresh export startup regression

A fresh browser initially exposed an encoder startup problem: short takes could
finish before their first encoded frame. Export now prepares the real encoder
using the initial artwork, discards that preparation output, and starts the
motion timeline only after readiness. The saved film contains the actual replay.

The final suite tests **record → recolor → replay → save → export** as its first
encoder use, before loading a source video or requesting a camera. A requested
6.58-second take decoded to 6.499 seconds at 1280 × 720. Every export check now
requires a finite duration within −0.75 / +1.25 seconds of the selected trim,
in addition to playable, non-empty frames.

[Fresh-start frame validation](fresh-start-validation.json) independently fully
decoded a cold seven-second workflow film: 6.943 seconds, 179 decoded frames,
179 distinct frame hashes, and visible changes in the opening second. It checks
for a multi-second frozen preparation segment without claiming pixel-perfect
equivalence to every recorded action.

The separate clean workflow screen recording uses a matched 1440 × 960 viewport
and recording size. It completes recording, recoloring, replay, local save,
export preview, and download. Its exported film is 6.985 seconds for a requested
7.2-second take. Timing markers and recording provenance are retained in
`workflowDemonstration` in the production report. Its extra screen encoder is
excluded from the performance measurements above.

## Privacy and offline acceptance

The separate [Edge smoke check](smoke-msedge.json) passed on Edge 152.0.4191.66:
three rendered stages, actual hand and segmentation inference, an injected
storage-quota failure with a working project-download recovery, portrait video,
and a decodable 0.1-second trim. Its cold diagnostic readings are functional
checks, not an Edge performance benchmark. Edge's internal downloads hub appears
in browser-context events; those `edge://` resources are classified separately
from the studio's network requests. There were no external application requests
or upload/write requests.

The same eight functional checks also passed against the deployed HTTPS
[GitHub Pages site](https://appleweiping.github.io/prism-stage/), including real
model inference and portrait/minimum-trim export; see [Pages smoke evidence](smoke-pages.json).
Decoded Edge output is recorded in [edge-export-validation.json](edge-export-validation.json).
The complete 34.52-second UI walkthrough is separately decoded and attributed in
[workflow-validation.json](workflow-validation.json).

The pinned MediaPipe SDK has a periodic usage logger. The Worker installs a same-origin fetch guard before model creation, preventing its external request. The production page includes a restrictive CSP; test reports distinguish policy presence from observed violations.

Offline readiness means the complete app/model/font/WASM/example bundle has been cached. It is tested by reopening the application after the browser context goes offline, not merely leaving an already-loaded canvas running. Network records must contain no third-party inference/telemetry uploads. Local source files are selected from licensed fixtures.

The final run cached all 29 required resources (47,321,229 bytes), reopened all
three stages in a new offline page, and confirmed an uncached network request
was rejected. Real hand and person-segmentation inference, local project saving,
and a 12.808-second exported portal film worked offline. Among 128 observed
requests there were no third-party requests or outbound writes. No CSP violation
or uncaught page exception occurred. The log retains one generic network error
during the deliberate model-request and offline-network failure checks.

## Practical limitations

- A synthetic example is useful for testing rendering/replay, not proof of webcam recognition quality.
- The virtual hand depth is an expressive approximation; the portal mask is not a scene reconstruction.
- Strong occlusion, thin fingers, low light, and fast motion can degrade model output.
- Real-time exports can drop frames. The application aborts when moved to the background or when the encoder reports a failure.
- Desktop Chrome/Edge are the support target. Other browsers and mobile camera behavior need additional device testing.

No upstream model benchmark is presented as this application's end-to-end frame rate.
