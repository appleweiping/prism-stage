# Prism Stage v1.1.0 — Bring the effects into your video

Keep the original person and surroundings in the frame. Draw ribbons from your
hands, move luminous spheres, or reveal a procedural world inside your silhouette.
Camera and local-video input now default to a single composited canvas, which is
also the image and film export source.

- Switch between **You + effects** and **Artwork only** while retaining the same
  motion and physical world. Portrait output changes the view crop.
- **Follow hands** grows ribbons from ordinary tracked hand movement and is the
  default for imported Ribbon videos. **Pinch to draw** remains the camera default.
  The control choice is explicit and leaves actual pinch observations unchanged.
- Record a silent local camera clip, or keep an imported MP4/WebM file unchanged.
  Replay, seek, recolor, save, reopen, and export with matching original footage.
- Portable v2 `.prismstage` projects can retain original video up to 96 MiB,
  timed observations, appearance, and optional source attribution. Existing v1
  projects still open.
- Use **Real footage demo** for an attributed example with actual MediaPipe
  observations. The three authored synthetic studies remain separately labeled.
- Video operations handle pending seeks, cold encoders, clock alignment, source
  cancellation, and camera or model failures. Everything runs on your device.
- Invalid video projects are rejected before replacing the current unsaved take.
- Slow GPU inference automatically recovers through local CPU mode; decoded video
  textures follow the source frame cadence instead of redundant render uploads.

[Try real footage + effects](https://appleweiping.github.io/prism-stage/?example=real-gravity) ·
[English README](https://github.com/appleweiping/prism-stage/blob/main/README.md) ·
[中文说明](https://github.com/appleweiping/prism-stage/blob/main/README.zh-CN.md)

The release contains `prism-stage-v1.1.0-source.zip`,
`prism-stage-v1.1.0-static.zip`, `prism-stage-v1.1.0-examples.zip`, and
`SHA256SUMS.txt`. Serve the static archive on localhost or HTTPS; opening it via
`file://` is unsupported. No account, API key, or backend is required.

Validation includes 171 automated regression tests, three actual-model local-video
creation/export workflows, a native fake-camera capture/save/reopen/export
workflow, and **17 passed Chrome local release checks**. All three composite
films fully decode as silent 1280 × 720 video. Exact builds, trim durations, and
limitations are recorded in the
[composition validation](https://github.com/appleweiping/prism-stage/blob/main/docs/COMPOSITE_VALIDATION.md).
The Ribbon example uses Follow hands with zero confirmed pinches; these examples
do not establish pinch drawing or grab/throw recognition. Physical camera
hardware is not exercised by the licensed native fake-camera fixture.

An editable video project includes its original footage. Imported files are
retained in full, including any original audio; exported films are silent.
Switching to Artwork only does not remove the original footage from the project.
The compositor uses a mirrored video plane and bounded virtual depth. It does
not reconstruct the room or model real-object occlusion. Recognition quality
depends on lighting, hand visibility, and inference speed.

Original code is MIT. The real examples contain a Google MediaPipe sample video
under Apache-2.0, with full provenance and license inside each example project.
