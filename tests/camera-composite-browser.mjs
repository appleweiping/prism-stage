/**
 * Isolated native fake-camera acceptance using the licensed MediaPipe video.
 * No physical camera is accessed. Requires npm run test:fixtures, FFmpeg, build + preview.
 * Optional PRISM_TEST_URL / CHROME_PATH / PRISM_FFMPEG; --prepare-only converts Y4M without launching a browser.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.PRISM_TEST_URL || 'http://127.0.0.1:4173/';
const ffmpeg = process.env.PRISM_FFMPEG || 'ffmpeg';
const folder = path.join(root, '.local/camera-composite');
await mkdir(folder, { recursive: true });
const relative = value => path.relative(root, value).replaceAll('\\', '/');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const hash = async file => { const value = createHash('sha256'); for await (const chunk of createReadStream(file)) value.update(chunk); return value.digest('hex'); };
function execute(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('FFmpeg timed out.')); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 32 * 1024 * 1024) { child.kill(); reject(new Error('FFmpeg output exceeded its bound.')); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-128000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
const provenance = JSON.parse(await readFile(path.join(root, 'docs/validation-assets.json'), 'utf8'));
const fixture = provenance.assets.find(asset => asset.name === 'gestures');
const fixturePath = path.join(root, fixture.localPath);
assert(await hash(fixturePath) === fixture.sha256, 'The licensed fixture checksum changed.');
const y4m = path.join(folder, 'licensed-gestures.y4m');
const conversion = {
  sourceSha256: fixture.sha256,
  arguments: ['-hide_banner', '-nostdin', '-y', '-i', relative(fixturePath), '-an', '-vf', 'fps=30', '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', relative(y4m)],
};
const conversionFile = path.join(folder, 'conversion.json');
let previous;
try { previous = JSON.parse(await readFile(conversionFile, 'utf8')); } catch { /* First run. */ }
let prepared = previous?.sourceSha256 === fixture.sha256;
if (prepared) { try { prepared = (await stat(y4m)).size === previous.bytes && await hash(y4m) === previous.sha256; } catch { prepared = false; } }
if (!prepared) {
  const result = await execute(conversion.arguments);
  assert(result.code === 0, 'FFmpeg could not prepare the licensed fake-camera Y4M: ' + result.stderr);
  Object.assign(conversion, { bytes: (await stat(y4m)).size, sha256: await hash(y4m) });
  await writeFile(conversionFile, JSON.stringify(conversion, null, 2) + '\n');
} else Object.assign(conversion, { bytes: previous.bytes, sha256: previous.sha256 });
if (process.argv.includes('--prepare-only')) {
  console.log(JSON.stringify({ prepared: relative(y4m), ...conversion }));
  process.exit(0);
}

const report = {
  startedAt: new Date().toISOString(), base, ok: false,
  method: 'Fresh isolated Chrome with native fake-camera flags and a checksum-verified licensed Y4M source. Actual getUserMedia and MediaPipe execute normally. All recording, replay, save/import and export operations use public UI; no application or model outputs are replaced.',
  source: { license: fixture.license, source: fixture.source, sourceSha256: fixture.sha256, conversion },
  physicalCameraUsed: false, microphoneUsed: false, scene: 'ribbon', checks: [], pageErrors: [], consoleErrors: [], requests: [],
  limitations: ['The native fake camera exercises the camera API and actual recognition, not physical camera hardware or lighting variation.', 'The licensed fixture shows a person against a curtain. This does not validate scene reconstruction, room occlusion, or gesture accuracy.', 'Decoder frame changes and timestamp bounds establish media integrity, not exact joint-to-pixel alignment on every frame.'],
};
let browser, context, page, project, rawPath, filmPath;
const step = (name, detail = {}) => { report.checks.push({ name, ok: true, ...detail }); console.log(JSON.stringify({ name, ...detail })); };
const phase = name => { report.phase = name; console.log(JSON.stringify({ phase: name })); };
async function idle() {
  await page.waitForFunction(() => document.querySelector('[data-testid="record-button"]')?.disabled === false, null, { timeout: 60000 });
  const errors = await page.getByRole('alert').allTextContents(); assert(!errors.length, errors.join(' '));
}
async function closeDialog() { const close = page.getByRole('button', { name: 'Close dialog', exact: true }); if (await close.count()) await close.click(); }
async function pause() { const button = page.getByRole('button', { name: 'Pause', exact: true }); if (await button.count()) await button.click(); }
async function seek(seconds) {
  await page.getByLabel('Playback position', { exact: true }).evaluate((element, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, String(value));
    element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);
  await idle(); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function canvasFrame() {
  const pixels = await page.getByTestId('artwork-canvas').evaluate(canvas => {
    const small = document.createElement('canvas'); small.width = 160; small.height = 90;
    const context = small.getContext('2d'); context.drawImage(canvas, 0, 0, 160, 90);
    return Array.from(context.getImageData(0, 0, 160, 90).data);
  });
  return { pixels, sha256: createHash('sha256').update(Uint8Array.from(pixels)).digest('hex') };
}
async function saveCanvas(name) {
  const png = await page.getByTestId('artwork-canvas').evaluate(canvas => canvas.toDataURL('image/png'));
  const file = path.join(folder, name + '.png'); await writeFile(file, Buffer.from(png.split(',')[1], 'base64'));
  return relative(file);
}
async function downloadProject(name) {
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill(name);
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download project', exact: true }).click();
  const download = await pending; const target = path.join(folder, name + '.prismstage'); await download.saveAs(target); await closeDialog();
  return target;
}
try {
  phase('launch isolated native fake-camera browser');
  browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }), headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + y4m, '--use-fake-ui-for-media-stream'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US', reducedMotion: 'reduce', acceptDownloads: true });
  context.on('request', request => { if (/^https?:/.test(request.url())) report.requests.push({ method: request.method(), url: request.url() }); });
  page = await context.newPage();
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  report.browser = { version: browser.version(), nativeFakeCamera: true, screenRecording: false };
  phase('load production studio');
  await page.goto(base, { waitUntil: 'domcontentloaded' }); await idle(); await pause();
  report.build = await page.evaluate(async () => (await (await fetch(new URL('offline-manifest.json', document.baseURI))).json()).version);
  await page.getByTestId('scene-ribbon').click(); await idle();
  phase('open native fake camera and actual vision model');
  await page.getByTestId('camera-button').click();
  await page.locator('.model-loading').waitFor({ state: 'hidden', timeout: 60000 });
  await page.getByRole('button', { name: 'A quick guide', exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector('.diagnostics')?.innerText.match(/Vision\s+([\d.]+)\s+fps/)?.[1]) > 0 || !!document.querySelector('[role="alert"]'), null, { timeout: 90000 });
  const diagnostics = await page.locator('.diagnostics').innerText(); await closeDialog(); await idle();
  const sourceTracks = await page.getByLabel('Camera calibration preview', { exact: true }).evaluate(video => {
    const stream = video.srcObject; const videoTrack = stream?.getVideoTracks()[0]; const settings = videoTrack?.getSettings();
    return { videoTracks: stream?.getVideoTracks().length, audioTracks: stream?.getAudioTracks().length, width: settings?.width, height: settings?.height, frameRate: settings?.frameRate, readyState: videoTrack?.readyState };
  });
  assert(sourceTracks.videoTracks === 1 && sourceTracks.audioTracks === 0 && sourceTracks.readyState === 'live', 'Expected one live fake-camera video track and no audio.');
  assert(await page.getByTestId('composition-video').getAttribute('aria-pressed') === 'true', 'Camera did not default to original-video composition.');
  step('actual camera API and MediaPipe are ready', { diagnostics, sourceTracks });
  const preparationBegan = Date.now(); await page.getByTestId('record-button').click();
  phase('prepare original-video encoder');
  await page.getByRole('button', { name: 'Finish take', exact: true }).waitFor({ state: 'visible', timeout: 45000 });
  const encoderPreparationSeconds = (Date.now() - preparationBegan) / 1000;
  phase('record original video and actual camera observations');
  await page.waitForTimeout(6800);
  await page.getByRole('button', { name: 'Finish take', exact: true }).click(); await idle(); await pause();
  const duration = Number(await page.getByLabel('Playback position', { exact: true }).getAttribute('max'));
  assert(duration >= 6, 'The camera take was shorter than six seconds.');
  project = await downloadProject('camera-ribbon');
  const entries = unzipSync(await readFile(project));
  const manifest = JSON.parse(strFromU8(entries['manifest.json'])); const samples = JSON.parse(strFromU8(entries['samples.json']));
  report.expectedDuration = manifest.duration;
  assert(manifest.version === 2 && manifest.source === 'camera' && manifest.composition === 'video', 'Expected a camera-sourced v2 composite project.');
  assert(entries['source.webm'] && manifest.video?.mimeType === 'video/webm', 'The camera project did not preserve its silent original WebM.');
  assert(samples.some(sample => sample.hands.length > 0) && samples.every(sample => sample.source === 'camera'), 'Actual camera hand observations are missing.');
  assert(samples.every(sample => sample.t >= 0 && sample.t <= manifest.duration), 'Camera observations fall outside the take clock.');
  rawPath = path.join(folder, 'camera-original.webm'); await writeFile(rawPath, entries['source.webm']);
  step('recorded camera project retains original video and real observations', { encoderPreparationSeconds, manifest, project: relative(project), raw: relative(rawPath), sampleCount: samples.length, handSamples: samples.filter(sample => sample.hands.length).length, pinchSamples: samples.filter(sample => sample.hands.some(hand => hand.pinch)).length, firstHandTime: samples.find(sample => sample.hands.length)?.t, lastHandTime: samples.findLast(sample => sample.hands.length)?.t });
  phase('seek and replay retained camera video');
  await seek(1); const firstFrame = await canvasFrame(); await seek(4); const laterFrame = await canvasFrame();
  const beforeReopenImage = await saveCanvas('camera-before-reopen');
  assert(firstFrame.sha256 !== laterFrame.sha256, 'Camera composite seeking did not change the decoded frame.');
  await page.getByRole('button', { name: 'Replay take', exact: true }).click(); await page.waitForTimeout(1200); await pause();
  await page.getByLabel('Import project file', { exact: true }).setInputFiles(project);
  await page.getByRole('status').filter({ hasText: 'Project opened.' }).waitFor({ state: 'visible', timeout: 60000 });
  await idle(); await pause(); await seek(4);
  const reopenedFrame = await canvasFrame();
  const reopenMeanAbsoluteDifference = reopenedFrame.pixels.reduce((sum, value, index) => sum + (index % 4 < 3 ? Math.abs(value - laterFrame.pixels[index]) : 0), 0) / (160 * 90 * 3);
  report.reopenComparison = { reopenMeanAbsoluteDifference, before: beforeReopenImage, after: await saveCanvas('camera-after-reopen'), beforeSha256: laterFrame.sha256, afterSha256: reopenedFrame.sha256 };
  console.log(JSON.stringify({ reopenComparison: report.reopenComparison }));
  assert(reopenMeanAbsoluteDifference < 0.5, 'Reopened camera project changed its paused source frame or artwork.');
  const roundtrip = await downloadProject('camera-ribbon-roundtrip');
  const reopened = unzipSync(await readFile(roundtrip));
  assert(createHash('sha256').update(reopened['source.webm']).digest('hex') === await hash(rawPath), 'Re-saving changed the retained original camera bytes.');
  step('camera seek, replay and project reopen preserve the take', { seekSeconds: [1, 4], frameHashes: [firstFrame.sha256, laterFrame.sha256], reopenMeanAbsoluteDifference, roundtrip: relative(roundtrip), retainedBytesUnchanged: true });
  await page.getByRole('button', { name: 'Export creation', exact: true }).click();
  await page.getByLabel('Trim start', { exact: true }).fill('0'); await page.getByLabel('Trim end', { exact: true }).fill(String(manifest.duration));
  await page.getByRole('button', { name: /Motion film/ }).click();
  const preview = page.getByLabel('Exported film preview', { exact: true }); await preview.waitFor({ state: 'attached', timeout: 120000 });
  await page.waitForFunction(() => document.querySelector('video[aria-label="Exported film preview"]')?.readyState >= 1);
  await preview.evaluate(async video => { video.muted = true; await video.play(); });
  await page.waitForFunction(() => document.querySelector('video[aria-label="Exported film preview"]').currentTime > 0.25);
  const pending = page.waitForEvent('download'); await page.getByRole('link', { name: /Download film/ }).click();
  const download = await pending; filmPath = path.join(folder, 'camera-composite' + path.extname(download.suggestedFilename())); await download.saveAs(filmPath);
  await page.screenshot({ path: path.join(folder, 'camera-composite-export.png') });
  step('camera composite exported and browser preview advances', { film: relative(filmPath), expectedSeconds: manifest.duration });
  assert(!report.pageErrors.length, 'Uncaught browser exception.');
  assert(report.requests.every(request => request.method === 'GET' && new URL(request.url).origin === new URL(base).origin), 'Observed outbound upload or third-party request.');
  report.expectedDuration = manifest.duration; report.browserWorkflowPassed = true;
} catch (error) {
  report.error = String(error); report.browserWorkflowPassed = false;
  console.error(JSON.stringify({ phase: report.phase, error: report.error }));
  if (page && !page.isClosed()) { report.visibleState = await page.locator('body').innerText(); await page.screenshot({ path: path.join(folder, 'camera-failure.png') }); }
} finally {
  // Persist failure evidence before native browser teardown, which can be slow.
  report.browserChecksFinishedAt = new Date().toISOString();
  await writeFile(path.join(root, 'docs/camera-composite-validation.json'), JSON.stringify(report, null, 2) + '\n');
  phase('close isolated browser before full media decoding');
  await context?.close(); await browser?.close();
}

// Decode after closing Chrome so media inspection does not compete with capture.
if (rawPath || filmPath) {
  try {
    report.decoded = [];
    for (const [kind, file] of [['original', rawPath], ['composite', filmPath]].filter(([, file]) => file)) {
      const result = await execute(['-hide_banner', '-nostdin', '-nostats', '-v', 'info', '-xerror', '-i', file, '-map', '0:v:0', '-an', '-fps_mode', 'passthrough', '-f', 'framemd5', 'pipe:1']);
      assert(result.code === 0, 'FFmpeg could not completely decode ' + kind + ': ' + result.stderr);
      const dimensions = result.stdout.match(/#dimensions\s+0:\s+(\d+)x(\d+)/);
      const timebase = result.stdout.match(/#tb\s+0:\s+(\d+)\/(\d+)/);
      const frames = result.stdout.split(/\r?\n/).filter(line => /^0,/.test(line)).map(line => line.split(',').map(value => value.trim()));
      assert(dimensions && timebase && frames.length, 'No decoded frames or metadata.');
      const unit = Number(timebase[1]) / Number(timebase[2]);
      const seconds = (Math.max(...frames.map(values => Number(values[2]) + Number(values[3]))) - Number(frames[0][2])) * unit;
      const detail = { kind, path: relative(file), sha256: await hash(file), bytes: (await stat(file)).size, width: Number(dimensions[1]), height: Number(dimensions[2]), duration: seconds, frames: frames.length, uniqueFrames: new Set(frames.map(values => values[5])).size, audioStreams: /Stream #0:\d+[^\r\n]*Audio:/.test(result.stderr), fullDecodeExitCode: result.code };
      assert(!detail.audioStreams && detail.uniqueFrames > 1, 'Expected silent changing video.');
      assert(Math.abs(detail.duration - report.expectedDuration) <= 0.75 && detail.duration >= 6, 'Decoded camera clip duration differs from the take.');
      assert(kind === 'original' ? detail.width <= 1280 && detail.height <= 720 : detail.width === 1280 && detail.height === 720, 'Camera clip dimensions are incorrect.');
      report.decoded.push(detail);
    }
    step(report.browserWorkflowPassed ? 'original and composite fully decode with matching duration and no audio' : 'available partial camera media fully decodes; full workflow remains incomplete');
    report.ok = !!report.browserWorkflowPassed;
  } catch (error) { report.error = String(error); }
}
report.finishedAt = new Date().toISOString();
await writeFile(path.join(root, 'docs/camera-composite-validation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ok: report.ok, error: report.error, decoded: report.decoded }));
process.exitCode = report.ok ? 0 : 1;
