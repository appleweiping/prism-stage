import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const packageDir = path.join(root, "node_modules/@mediapipe/tasks-vision");
const pkg = JSON.parse(
  await readFile(path.join(packageDir, "package.json"), "utf8"),
);
if (pkg.version !== "1.0.1")
  throw new Error(
    `Expected @mediapipe/tasks-vision 1.0.1; found ${pkg.version}. Update asset locks deliberately.`,
  );
await mkdir(path.join(publicDir, "models"), { recursive: true });
await mkdir(path.join(publicDir, "wasm"), { recursive: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifestPath = path.join(publicDir, "models/manifest.json");
let previous;
try {
  previous = JSON.parse(await readFile(manifestPath, "utf8"));
} catch {
  /* Initial setup. */
}
const models = [
  {
    path: "models/hand_landmarker.task",
    name: "MediaPipe Hand Landmarker (full, float16, version 1)",
    source:
      "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    modelCard:
      "https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf",
    license: "Apache-2.0",
  },
  {
    path: "models/selfie_segmenter_landscape.tflite",
    name: "MediaPipe Selfie Segmenter (landscape, float16, version 1)",
    source:
      "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/1/selfie_segmenter_landscape.tflite",
    modelCard:
      "https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf",
    license: "Apache-2.0",
  },
];
const assets = [];
for (const model of models) {
  const target = path.join(publicDir, model.path);
  const locked = previous?.assets?.find((asset) => asset.path === model.path);
  let bytes;
  try {
    bytes = await readFile(target);
  } catch {
    /* Download the versioned official model below. */
  }
  if (!bytes || (locked && sha256(bytes) !== locked.sha256)) {
    const response = await fetch(model.source, {
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok)
      throw new Error(
        `Model download failed: ${response.status} ${model.source}`,
      );
    bytes = Buffer.from(await response.arrayBuffer());
    if (locked && sha256(bytes) !== locked.sha256)
      throw new Error(
        `Model checksum changed: ${model.path}. Refusing to replace the locked asset.`,
      );
    await writeFile(target, bytes);
  }
  assets.push({ ...model, bytes: bytes.length, sha256: sha256(bytes) });
  process.stdout.write(
    `Verified ${model.path} (${(bytes.length / 1048576).toFixed(2)} MiB)\n`,
  );
}
for (const file of (await readdir(path.join(packageDir, "wasm"))).sort()) {
  if (!/\.(js|wasm)$/.test(file)) continue;
  const bytes = await readFile(path.join(packageDir, "wasm", file));
  await writeFile(path.join(publicDir, "wasm", file), bytes);
  assets.push({
    path: `wasm/${file}`,
    name: `MediaPipe Tasks Vision 1.0.1 ${file}`,
    license: "Apache-2.0",
    source: `https://www.npmjs.com/package/@mediapipe/tasks-vision/v/1.0.1`,
    bytes: bytes.length,
    sha256: sha256(bytes),
  });
}
const licensePath = path.join(publicDir, "models/LICENSE-APACHE-2.0.txt");
let license;
try {
  license = await readFile(licensePath, "utf8");
} catch {
  const response = await fetch(
    "https://www.apache.org/licenses/LICENSE-2.0.txt",
    { signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok)
    throw new Error("Could not download the Apache-2.0 license.");
  license = await response.text();
  await writeFile(licensePath, license);
}
await writeFile(
  manifestPath,
  JSON.stringify(
    {
      format: 1,
      runtime: "@mediapipe/tasks-vision@1.0.1",
      notes:
        "Model URLs pin version 1. SHA-256 locks are checked on subsequent installs. Models and WASM are served from the application origin; no inference requests leave the device.",
      licenseFile: "models/LICENSE-APACHE-2.0.txt",
      assets,
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(`Prepared ${assets.length} pinned local vision assets.\n`);
