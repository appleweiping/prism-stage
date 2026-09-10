# Recorded model observations

These three editable projects contain actual MediaPipe observations collected by
[`vision-video.html`](../vision-video.html) through the production `VisionController`.
They are test evidence, separate from the authored synthetic examples in `public/examples`.

The source is Google's official gesture-recognizer Android test video at the pinned
commit and SHA-256 in [`docs/validation-assets.json`](../../docs/validation-assets.json),
under Apache-2.0. The source is looped to collect approximately 12 seconds per stage.
The archives contain hand observations or person masks, **no original RGB video**.
Provenance and licensing for the source observations remain Apache-2.0; see the
[license text](../../public/models/LICENSE-APACHE-2.0.txt) and
[notices](../../THIRD_PARTY_NOTICES.md). Prism Stage's container and application code are MIT.

The three captures were measured independently. The ribbon capture includes six
pinched observations. The gravity capture has moving hands but no confirmed pinch;
it verifies actual model input and physical animation, not successful real-video
grabbing. Synthetic examples and engine tests exercise grab/throw determinism.

See [the inference report](../../docs/vision-gesture-results.json) for counts and timing.
`npm run test:fixtures` fetches and checksum-verifies the original videos into the
ignored `.local/fixtures` directory. `tests/vision-video.html` can then be opened on
the Vite development server to repeat genuine inference and download new observations.
