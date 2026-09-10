# Original-video composition validation

The v1.1 checks exercise a different output from the separately preserved
[v1.0 abstract-art validation](VALIDATION.md): the original person and surroundings
remain in the final canvas with generated effects. The completed workflows below
use isolated native Chrome profiles and public application controls. The release
smoke harness also supports Edge; its results are recorded separately.

## Evidence and scope

- [Real-source workflows](composite-validation.json): licensed original video is
  passed through actual MediaPipe, recorded, restyled, compared with its source,
  saved/reopened, and exported. Each example retains the source video without
  changing its bytes, together with portable Apache-2.0 attribution.
- [Camera workflow](camera-composite-validation.json): the native camera API uses
  a checksum-verified Y4M conversion of the licensed fixture. Actual MediaPipe,
  original-video capture, replay, project import/export, and the final encoder
  execute normally. No physical camera or microphone is opened.
- [Complete film decoding](composite-export-validation.json): FFmpeg decodes every
  exported frame with `-xerror`, verifies dimensions, timestamps, changing content,
  and the absence of an audio stream.
- [Chrome local release smoke](composite-smoke-chrome-local.json): **17 of 17
  checks passed** on build `f3fd1305674aa67c`, including packaged examples, PNG,
  source/notice preservation, IndexedDB, portrait film, 20 stage switches, narrow
  layout, complete caching, and offline save/reopen/export. This replays previously
  recorded real observations; it is separate from fresh model inference.
- [Edge Pages release smoke](composite-smoke-msedge-pages.json): **18 of 18
  checks passed** against the deployed build `a315cad3761f78e5`, including native
  rejection of mismatched video metadata while preserving the previous take,
  and fresh offline loading, saving, reopening, and film export.
- [Complete UI workflow](composite-workflow-validation.json): an actual licensed
  source video passes through local inference, recording, restyling, replay,
  project saving, and film export. The report records the completed screen-capture
  actions separately from the exported canvas film and from hardware benchmarks.
  [Full screen-recording decode](composite-workflow-media.json) verifies the
  complete 46.32-second, 1440 × 960 H.264 workflow film (1,158 frames), with
  no cuts, retiming, fabricated UI, or audio.

The original-source workflows were captured on explicitly recorded builds:
Ribbon Follow hands on `96c454adf1b11e0f`, Gravity and Portal on
`46f4f93309aa028d`, and the camera workflow on `2506f2efd6969ea7`. The merged
three-stage report does not imply that every fresh inference check ran on the
same latest build. Final deployment and browser smoke results have their own
scope and provenance.

| Export | Real recorded input | Trimmed decoded film | Decoded frames |
| --- | --- | --- | ---: |
| Ribbon | 72 observations, 62 with hands; Follow hands, zero pinches | 7.142 s, 1280 × 720, silent | 210 |
| Gravity | 45 observations, 36 with hands; zero pinches | 5.721 s, 1280 × 720, silent | 171 |
| Portal | 151 observations, including 150 distinct masks | 5.713 s, 1280 × 720, silent | 173 |

These finite-source v1.1 films use the selected trim ranges. Their durations are
distinct from the longer historical v1.0 abstract-output export checks, and
decoded frame counts are measurements rather than a promise of constant 30 fps.

The verified camera take lasts 6.837 seconds and contains 47 actual observations,
39 with hands. Its original WebM remains byte-identical after project
save/import/save. The paused 4-second composition matches exactly after reopening
at the 160 × 90 pixel-comparison resolution.
The raw stream fully decodes to 182 frames over 6.838 seconds, and the final
composition to 203 frames over 6.747 seconds; both are silent 1280 × 720 video.
These figures come from the camera report's tested build, not a hardware speed
guarantee.

The source gesture clip contains ordinary hand movements and thumbs-up gestures.
Ribbon's **Follow hands** control uses those actual tracked positions without
requiring or inventing pinches. Its mode is stored explicitly; the observed pinch
booleans remain unchanged. The gravity example demonstrates original-video
composition and physical light movement. It does not establish successful
pinch-to-grab or throw recognition on this fixture. The portal uses actual
changing segmentation masks.

Source-pixel comparisons, decoded-frame checks, and project roundtrips establish
working composition and replay. They do not measure pose accuracy, fine hair
matting, real-world depth, furniture occlusion, or general gesture accuracy.
The fixture shows a person against a dark curtain; broader room and lighting
conditions remain dependent on the supplied video and upstream model.

## Clean checkout

[Independent checkout verification](composite-fresh-checkout-validation.json)
ran `npm ci`, `npm run check`, and `npm run build` from a new clone at
`042614b5fb79d28c2dc9600d5964d530167ed2bf`. All 171 tests passed, all 42
production files matched the reference byte-for-byte (84,923,886 bytes), and the
32-file offline manifest matched version `a315cad3761f78e5`.

## Reproduce

Use Node.js 22.12+, installed desktop Chrome/Edge, and FFmpeg for independent
decoding. Set `PRISM_FFMPEG` to its executable when it is not on PATH.

```sh
npm ci
npm run test:fixtures
npm run check
npm run build
npm run preview
```

Keep the preview server running, then run browser jobs one at a time:

```sh
npm run test:composite
npm run test:camera
npm run test:composite:media
npm run test:composite:smoke
```

The camera harness prepares an ignored local Y4M fixture and uses native Chrome
fake-camera flags. It never substitutes model observations or encoder output.
The smoke harness accepts `PRISM_BROWSER=msedge` and a deployed `PRISM_TEST_URL`.
It covers real-example deep links, all three examples, PNG, portable source and
attribution, IndexedDB, portrait films, 20 scene switches, narrow layout, full
caching, a fresh offline page, offline save/reopen/export, and outbound requests.

Recording the complete UI workflow uses `PRISM_REAL_FOOTAGE=1` with
`node scripts/record-workflow.mjs`. Screen recording is documented separately
from canvas-film capture and can affect performance.

## Robustness changes

**171 automated tests across eight suites and TypeScript checking passed.**
The v1.1 suites cover source/observation clock alignment through model
initialization and recovery, overlapping native seeks, canceled async operations,
video-project bounds and provenance, fixed-step catch-up after a render stall,
fractional trim endpoints, replay reconstruction, and retained-video cleanup.
Project imports prepare and validate a separate native video before replacing
current work. Decode, metadata, preview-seek, and stage failures preserve the
existing take; stale provisional media is disposed. Ten regression cases cover
this ownership transfer and failure recovery.

Cold GPU compilation is excluded from the sustained latency check. Two subsequent
consecutive GPU observations over 400 ms trigger local CPU recovery, which is a compatibility
measure rather than a promise of faster inference. Measured inference time allows
a bounded 600–1500 ms association window; explicit empty detections release hands
immediately. A slow device still responds more slowly. Pixel/frame results and
backend observations are recorded separately from the historical v1.0 benchmarks.
