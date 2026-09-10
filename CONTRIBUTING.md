# Contributing

Use Node.js 22.12+, run `npm ci`, and start `npm run dev`. Before proposing a change, run `npm run check` and `npm run build`.

Keep input, appearance, and stage simulation separate. New stages implement `ScenePlugin` and must dispose their textures, geometries, workers, and physics resources. A recorded take must reconstruct the same simulation when seeking; visual parameters must not silently alter its physical trajectory.

Use licensed fixtures for real-model testing and record their source/commit/hash. Label synthetic motion as synthetic. Never commit private camera footage, API keys, or browser data. Runtime dependencies and models must be self-hosted, versioned, and covered by third-party notices.

Changes to project data need an explicit format/engine compatibility decision and meaningful roundtrip/rejection tests. Do not loosen ZIP import limits merely to make an untrusted archive pass.

Bug reports are most useful with browser/version, OS/GPU, input mode, scene, quality, reproduction steps, and a shareable project file when the motion data can be shared. Please avoid attaching private original footage.
