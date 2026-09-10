import { readdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
async function walk(dir, prefix = "") {
  const result = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix + item.name;
    if (item.isDirectory())
      result.push(...(await walk(join(dir, item.name), relative + "/")));
    else if (
      !["sw.js", "offline-manifest.json"].includes(relative) &&
      !relative.startsWith("showcase/")
    )
      result.push(relative);
  }
  return result.sort();
}
const notices = (await readFile("THIRD_PARTY_NOTICES.md", "utf8"))
  .replaceAll("](public/", "](")
  .replaceAll("](docs/", "](https://github.com/appleweiping/prism-stage/blob/main/docs/")
  .replaceAll("](tests/", "](https://github.com/appleweiping/prism-stage/blob/main/tests/");
await writeFile("dist/THIRD_PARTY_NOTICES.md", notices);
await copyFile("LICENSE", "dist/LICENSE");
const files = await walk("dist");
const hash = createHash("sha256");
const source = await readFile("public/sw.js", "utf8");
hash.update(source);
let totalBytes = 0;
for (const file of files) {
  const bytes = await readFile(join("dist", file));
  hash.update(file);
  hash.update(bytes);
  totalBytes += bytes.length;
}
const version = hash.digest("hex").slice(0, 16);
await writeFile(
  "dist/offline-manifest.json",
  JSON.stringify({ version, totalBytes, files }, null, 2),
);
await writeFile("dist/sw.js", source.replaceAll("__BUILD_VERSION__", version));
console.log(
  `Offline bundle: ${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB, version ${version}`,
);
