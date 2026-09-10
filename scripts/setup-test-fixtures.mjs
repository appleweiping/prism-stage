import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, 'docs/validation-assets.json'), 'utf8'));
for (const asset of manifest.assets) {
  const target = resolve(root, asset.localPath);
  let bytes;
  try { bytes = await readFile(target); } catch { /* Download below. */ }
  const valid = (data) => data?.length === asset.bytes && createHash('sha256').update(data).digest('hex') === asset.sha256;
  if (!valid(bytes)) {
    const response = await fetch(asset.source);
    if (!response.ok) throw new Error(`${asset.name}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (!valid(bytes)) throw new Error(`${asset.name}: fixture checksum mismatch`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  console.log(`${asset.name}: SHA-256 verified (${asset.bytes} bytes)`);
}
