# Prism Stage v1.0.0

A browser-local studio that turns a motion performance into editable visual art.

- Three complete stages: volumetric ribbon drawing, Rapier light-body physics,
  and a segmented silhouette revealing a procedural world.
- Real camera/local-video inference through same-origin MediaPipe workers;
  three clearly labeled synthetic example projects for an immediate demo.
- Record up to 60 seconds, replay with a different appearance, trim a passage,
  save an editable project or local collection, and export PNG or silent video.
- English/Chinese studio, landscape/portrait crop, fullscreen, keyboard controls,
  reduced motion, recovery messages, and a complete offline cache.
- Detailed bilingual README, architecture/format guides, nine-project research
  comparison, actual application screenshots, a workflow video and test evidence.

[Open the studio](https://appleweiping.github.io/prism-stage/) ·
[Validation evidence](https://github.com/appleweiping/prism-stage/blob/main/docs/VALIDATION.md)

The release attachments have these names:

| Archive | Contents |
| --- | --- |
| `prism-stage-v1.0.0-source.zip` | Source checkout, documentation, pinned local models, and test fixtures. Run `npm ci` before development. |
| `prism-stage-v1.0.0-static.zip` | Built static app. Extract and serve its contents from an HTTP server on localhost or HTTPS. |
| `prism-stage-v1.0.0-examples.zip` | Three editable `.prismstage` studies. Import them through **My collection → Import project**. |

Verify the archives against `SHA256SUMS.txt`. The static app cannot run through
`file://`. No account, API key or backend is required.

Desktop Chrome/Edge are the support targets. Exports are foreground real-time
captures; encoding speed and frame delivery depend on the device. Model recognition
can degrade in poor lighting or with occlusion. Synthetic display examples are
identified separately from real inference evidence. Original code is MIT;
dependencies, models and test observations retain their own licenses.
