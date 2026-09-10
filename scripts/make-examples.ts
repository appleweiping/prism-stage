import { mkdir, writeFile } from "node:fs/promises";
import { demoSample } from "../src/core/demo";
import { DEFAULT_PARAMS, PRESETS } from "../src/core/presets";
import {
  DEFAULT_SEED,
  FIXED_DT,
  type InputSample,
  type PrismProject,
  type SceneId,
} from "../src/core/types";
import { encodeProject } from "../src/storage/projects";
await mkdir("public/examples", { recursive: true });
for (const [index, scene] of (
  ["ribbon", "gravity", "portal"] as SceneId[]
).entries()) {
  const samples: InputSample[] = [];
  const fps = scene === "portal" ? 15 : 60;
  for (let i = 0; i < 12 * fps; i++) samples.push(demoSample(scene, i / fps));
  const names = [
    "Aurora — a study in motion",
    "Celestial — a little gravity",
    "Inner cosmos — a living portal",
  ];
  const preset = PRESETS[scene][0];
  const project: PrismProject = {
    manifest: {
      format: "prism-stage",
      version: 1,
      engineVersion: "1.0.0",
      id: `a61b000${index}-1234-4567-8900-202609100001`,
      name: names[index],
      scene,
      createdAt: "2026-09-10T12:00:00.000Z",
      seed: DEFAULT_SEED,
      fixedDt: FIXED_DT,
      duration: 12,
      params: { ...DEFAULT_PARAMS, ...preset.params, palette: preset.palette },
      trim: { start: 0, end: 12 },
      aspect: "landscape",
      source: "demo",
    },
    samples,
  };
  const blob = await encodeProject(project);
  await writeFile(
    `public/examples/${scene}.prismstage`,
    Buffer.from(await blob.arrayBuffer()),
  );
  process.stdout.write(
    `${scene}: ${samples.length} authored input samples, ${blob.size} bytes\n`,
  );
}
