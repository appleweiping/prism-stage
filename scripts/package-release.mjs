import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
if (status.status !== 0 || status.stdout.trim())
  throw new Error('Commit the final source, documentation and showcase files before packaging a release.');
const out = join(root, '.local/release');
await mkdir(out, { recursive: true });
const names = [];
async function archive(directory, kind) {
  const entries = {};
  async function walk(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, item.name);
      if (item.isDirectory()) await walk(file);
      else entries[relative(directory, file).replaceAll('\\', '/')] = new Uint8Array(await readFile(file));
    }
  }
  await walk(directory);
  if (kind === 'examples') {
    entries['LICENSE'] = new Uint8Array(await readFile(join(root, 'LICENSE')));
    entries['README.txt'] = new TextEncoder().encode(
      'Prism Stage — editable examples\n\nOpen https://appleweiping.github.io/prism-stage/ and use My collection → Import project to import a .prismstage file.\nEach example contains synthetic demonstration motion, not camera recordings. Replay, restyle, trim and export your own variation.\n\n打开上述在线工作室，使用“我的作品 → 导入工程”导入 .prismstage 文件。示例包含明确标注的合成演示动作，可回放、换色、截取并导出。\n\nOriginal examples: MIT, see LICENSE.\n',
    );
  }
  const name = `prism-stage-v${version}-${kind}.zip`;
  await writeFile(join(out, name), zipSync(entries, { level: 6 }));
  names.push(name);
}
const source = `prism-stage-v${version}-source.zip`;
const git = spawnSync('git', ['archive', '--format=zip', '--prefix=prism-stage/', '-o', resolve(out, source), 'HEAD'], { cwd: root, encoding: 'utf8' });
if (git.status !== 0) throw new Error(git.stderr || 'git archive failed');
names.push(source);
await archive(join(root, 'dist'), 'static');
await archive(join(root, 'public/examples'), 'examples');
const sums = [];
for (const name of names) {
  const bytes = await readFile(join(out, name));
  sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  console.log(`${name}: ${(bytes.length / 1024 / 1024).toFixed(2)} MiB`);
}
await writeFile(join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
