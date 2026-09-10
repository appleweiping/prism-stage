#!/usr/bin/env node
/** Full video decode verification. Run after creating exports; requires an external FFmpeg installation. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ffmpeg = process.env.PRISM_FFMPEG || 'ffmpeg';
const requireAll = process.argv.includes('--require-all');
const outputPath = 'docs/export-validation.json';
const scenes = ['ribbon', 'gravity', 'portal'];
const targets = [
  ...scenes.map(scene => ({ scene, kind: 'real-model-input', path: `.local/exports/${scene}-real.webm`, project: `tests/fixtures/${scene}-gestures.prismstage` })),
  ...scenes.map(scene => ({ scene, kind: 'authored-demo', path: `public/showcase/${scene}.webm`, project: `public/examples/${scene}.prismstage` })),
];

function execute(args, timeoutMs = 120_000) {
  return new Promise(resolve => {
    const child = spawn(ffmpeg, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '', failure = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > 32 * 1024 * 1024) { failure = 'FFmpeg output exceeded the validation buffer limit.'; child.kill(); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-128 * 1024); });
    child.on('error', error => { failure = error.code === 'ENOENT' ? 'FFmpeg was not found. Install it on PATH or set PRISM_FFMPEG to the executable.' : error.message; });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, error: timedOut ? 'FFmpeg decode timed out.' : failure }); });
  });
}

async function fileStat(relative) { try { return await stat(path.join(root, relative)); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }
async function sha256(relative) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join(root, relative))) hash.update(chunk);
  return hash.digest('hex');
}

function parseFrameHashes(text) {
  let numerator, denominator, width, height;
  const frames = [];
  for (const line of text.split(/\r?\n/)) {
    let match = /^#tb\s+0:\s+(\d+)\/(\d+)/.exec(line);
    if (match) { numerator = Number(match[1]); denominator = Number(match[2]); continue; }
    match = /^#dimensions\s+0:\s+(\d+)x(\d+)/.exec(line);
    if (match) { width = Number(match[1]); height = Number(match[2]); continue; }
    if (line.startsWith('#') || !line.trim()) continue;
    const parts = line.split(',').map(value => value.trim());
    if (parts.length !== 6 || parts[0] !== '0' || !/^[a-f0-9]{32}$/i.test(parts[5])) continue;
    const pts = Number(parts[2]), duration = Number(parts[3]);
    if (Number.isFinite(pts) && Number.isFinite(duration) && duration >= 0) frames.push({ pts, duration, md5: parts[5] });
  }
  if (!numerator || !denominator || !width || !height || !frames.length) throw new Error('FFmpeg did not return readable video frames, dimensions, and timestamps.');
  const unit = numerator / denominator;
  const firstPts = frames[0].pts;
  const lastEnd = Math.max(...frames.map(frame => frame.pts + frame.duration));
  const durationSeconds = (lastEnd - firstPts) * unit;
  const uniqueFrames = new Set(frames.map(frame => frame.md5)).size;
  const consecutiveChanges = frames.reduce((total, frame, index) => total + Number(index > 0 && frame.md5 !== frames[index - 1].md5), 0);
  return {
    width, height,
    durationSeconds: +durationSeconds.toFixed(6),
    durationMethod: 'Last decoded frame PTS plus its duration minus first decoded PTS; not the optional WebM container duration field.',
    timeBase: `${numerator}/${denominator}`,
    decodedFrames: frames.length,
    uniqueDecodedFrameHashes: uniqueFrames,
    consecutiveFrameChanges: consecutiveChanges,
    changingFrameFraction: frames.length > 1 ? +(consecutiveChanges / (frames.length - 1)).toFixed(6) : 0,
    decodedFramesPerSecond: +(frames.length / Math.max(durationSeconds, 0.000001)).toFixed(3),
    timestampsNondecreasing: frames.every((frame, index) => !index || frame.pts >= frames[index - 1].pts),
    firstFrameMd5: frames[0].md5,
    lastFrameMd5: frames.at(-1).md5,
  };
}

async function provenance(target) {
  const info = await fileStat(target.project);
  if (!info) return { status: 'pending', projectPath: target.project, reason: 'Associated editable take has not been created.' };
  const files = unzipSync(new Uint8Array(await readFile(path.join(root, target.project))), { filter: file => ['manifest.json', 'samples.json'].includes(file.name) });
  if (!files['manifest.json'] || !files['samples.json']) throw new Error('Associated take has no manifest or sample recording.');
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  const samples = JSON.parse(strFromU8(files['samples.json']));
  if (!Array.isArray(samples)) throw new Error('Associated take has invalid samples.');
  const sources = [...new Set(samples.map(sample => sample.source))];
  const expectedSource = target.kind === 'authored-demo' ? 'demo' : 'video';
  const matches = manifest.scene === target.scene && manifest.source === expectedSource && sources.every(source => source === expectedSource);
  return {
    status: matches ? 'verified-manifest' : 'mismatch',
    projectPath: target.project,
    projectSha256: await sha256(target.project),
    projectId: manifest.id,
    scene: manifest.scene,
    source: manifest.source,
    sampleSources: sources,
    durationSeconds: manifest.duration,
    engineVersion: manifest.engineVersion,
    samples: samples.length,
    handSamples: samples.filter(sample => sample.hands?.length).length,
    pinchingSamples: samples.filter(sample => sample.hands?.some(hand => hand.pinch)).length,
    maskSamples: samples.filter(sample => sample.mask).length,
    inputEvidence: target.kind === 'authored-demo' ? 'scripts/make-examples.ts' : 'docs/vision-gesture-results.json',
    assetLicenseEvidence: target.kind === 'authored-demo' ? 'THIRD_PARTY_NOTICES.md' : 'docs/validation-assets.json',
    association: 'Capture workflow associates this filename with the editable take above. Decoding verifies media integrity and motion, not model accuracy or a cryptographic linkage between input and output.',
  };
}

const versionProbe = await execute(['-hide_banner', '-version'], 15_000);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  method: 'Decode the entire first video stream using FFmpeg -xerror with timestamp passthrough and framemd5. No mock encoder, re-encoding, resizing, or frame interpolation is used.',
  commandTemplate: 'ffmpeg -hide_banner -nostdin -nostats -v info -xerror -i INPUT -map 0:v:0 -an -sn -dn -fps_mode passthrough -f framemd5 pipe:1',
  invocation: 'node scripts/validate-media.mjs --require-all (set PRISM_FFMPEG when FFmpeg is not on PATH)',
  ffmpeg: { executableName: path.basename(ffmpeg), version: versionProbe.stdout.split(/\r?\n/)[0] || null, available: versionProbe.code === 0 && !versionProbe.error },
  requirements: { width: 1280, height: 720, minimumDurationSeconds: 10, minimumUniqueFrames: 2, fullDecodeExitCode: 0, noAudioStream: true },
  notes: [
    'Real-model-input clips come from saved observations produced by the production vision worker on licensed real-person test footage; no physical camera was used for these checks.',
    'Authored-demo clips use procedural example takes. Their visual quality and successful encoding are separate from real-model inference validation.',
    'Decoded frame hashes establish changing pixel content, not tracking correctness. Effective frame cadence is measured rather than assumed to be 30 fps.',
    'Original input videos and real-input exports in .local are not distributed with the app. Processed model observations are committed in tests/fixtures, with project hashes and upstream input provenance in the validation records.',
    'Missing files are pending; --require-all exits nonzero for pending results. Existing invalid files always make this script exit nonzero.',
  ],
  results: [],
};

for (const target of targets) {
  const result = { scene: target.scene, kind: target.kind, path: target.path, status: 'pending' };
  try {
    const before = await fileStat(target.path);
    if (!before?.isFile() || !before.size) { result.reason = 'Export has not been created or is still empty.'; report.results.push(result); console.log(`PENDING ${target.path}`); continue; }
    result.bytes = before.size;
    result.sha256 = await sha256(target.path);
    result.provenance = await provenance(target);
    if (!report.ffmpeg.available) { result.reason = versionProbe.error || 'FFmpeg is unavailable.'; report.results.push(result); console.log(`PENDING ${target.path}: FFmpeg unavailable`); continue; }
    const decoded = await execute(['-hide_banner', '-nostdin', '-nostats', '-v', 'info', '-xerror', '-i', target.path, '-map', '0:v:0', '-an', '-sn', '-dn', '-fps_mode', 'passthrough', '-f', 'framemd5', 'pipe:1']);
    result.fullDecode = { exitCode: decoded.code, signal: decoded.signal, ok: decoded.code === 0 && !decoded.error };
    const after = await fileStat(target.path);
    if (!after || before.size !== after.size || before.mtimeMs !== after.mtimeMs) { result.reason = 'File changed during validation. Re-run after export finishes.'; report.results.push(result); console.log(`PENDING ${target.path}: file still changing`); continue; }
    if (!result.fullDecode.ok) throw new Error(decoded.error || decoded.stderr.trim().slice(-4000) || 'FFmpeg could not fully decode the video.');
    result.decoded = parseFrameHashes(decoded.stdout);
    result.decoded.hasAudioStream = /Stream #0:\d+[^\r\n]*Audio:/.test(decoded.stderr);
    result.checks = {
      dimensions: result.decoded.width === 1280 && result.decoded.height === 720,
      duration: result.decoded.durationSeconds >= 10,
      changingFrames: result.decoded.uniqueDecodedFrameHashes >= 2 && result.decoded.consecutiveFrameChanges > 0,
      fullDecode: result.fullDecode.ok,
      timestamps: result.decoded.timestampsNondecreasing,
      noAudio: !result.decoded.hasAudioStream,
      sceneAndProvenance: result.provenance.status === 'verified-manifest',
    };
    result.status = Object.values(result.checks).every(Boolean) ? 'passed' : result.provenance.status === 'pending' && Object.entries(result.checks).every(([key, ok]) => key === 'sceneAndProvenance' || ok) ? 'pending' : 'failed';
    if (result.status !== 'passed') result.reason = `Unsatisfied checks: ${Object.entries(result.checks).filter(([, ok]) => !ok).map(([key]) => key).join(', ')}.`;
    console.log(`${result.status.toUpperCase()} ${target.path}: ${result.decoded.width}×${result.decoded.height}, ${result.decoded.durationSeconds}s, ${result.decoded.decodedFrames} frames, ${result.decoded.uniqueDecodedFrameHashes} unique`);
  } catch (error) {
    result.status = 'failed';
    result.reason = (error instanceof Error ? error.message : String(error)).replaceAll(root, '<project>');
    console.log(`FAILED ${target.path}: ${result.reason}`);
  }
  report.results.push(result);
}

report.summary = { total: report.results.length, passed: report.results.filter(result => result.status === 'passed').length, pending: report.results.filter(result => result.status === 'pending').length, failed: report.results.filter(result => result.status === 'failed').length };
report.status = report.summary.failed ? 'failed' : report.summary.pending ? 'pending' : 'passed';
await mkdir(path.join(root, 'docs'), { recursive: true });
await writeFile(path.join(root, outputPath), JSON.stringify(report, null, 2) + '\n');
console.log(`${report.status.toUpperCase()}: ${report.summary.passed} passed, ${report.summary.pending} pending, ${report.summary.failed} failed. Wrote ${outputPath}.`);
if (report.summary.failed || (requireAll && report.summary.pending)) process.exitCode = 1;
