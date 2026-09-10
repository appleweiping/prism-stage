/**
 * Real-source composition acceptance. Run only after build + preview are ready.
 * Uses public UI controls and licensed local video through actual MediaPipe.
 * PRISM_TEST_URL, CHROME_PATH and PRISM_COMPOSITE_SCENES may be overridden.
 * No synthetic model output, private app APIs, or physical camera is used.
 */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8, strToU8, zipSync } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.PRISM_TEST_URL || 'http://127.0.0.1:4173/';
const scenes = (process.env.PRISM_COMPOSITE_SCENES || 'ribbon,gravity,portal').split(',');
if (scenes.some(scene => !['ribbon', 'gravity', 'portal'].includes(scene)))
  throw new Error('PRISM_COMPOSITE_SCENES must contain ribbon, gravity, and/or portal.');
const paths = {
  scratch: path.join(root, '.local/composite-tests'),
  images: path.join(root, 'docs/images'),
  examples: path.join(root, 'public/examples'),
  films: path.join(root, 'public/showcase'),
};
for (const directory of Object.values(paths)) await mkdir(directory, { recursive: true });
const relative = file => path.relative(root, file).replaceAll('\\', '/');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const reportFile = path.join(root, process.env.PRISM_COMPOSITE_REPORT || 'docs/composite-validation.json');
const provenance = JSON.parse(await readFile(path.join(root, 'docs/validation-assets.json'), 'utf8'));
const fixture = provenance.assets.find(asset => asset.name === 'gestures');
assert(fixture, 'The official gesture-video provenance record is missing.');
const fixturePath = path.join(root, fixture.localPath);
const fixtureBytes = await readFile(fixturePath);
assert(sha256(fixtureBytes) === fixture.sha256, 'The licensed source fixture checksum changed.');
const report = {
  startedAt: new Date().toISOString(), base,
  requestedScenes: scenes,
  method: 'Fresh isolated Chrome context against the production application. Imported licensed original video drives actual MediaPipe inference. Record, seek, restyle, PNG, project save/reopen, and film export use the public UI. Reference pixels are separately decoded from the same original fixture solely for comparison.',
  source: { source: fixture.source, sourcePage: fixture.sourcePage, repositoryCommit: fixture.repositoryCommit, license: fixture.license, sha256: fixture.sha256, bytes: fixtureBytes.length },
  checks: [], pageErrors: [], consoleErrors: [], requests: [],
  limitations: ['These retained-source examples contain a real person against a dark curtain, not a furnished-room scene.', 'This run exercises local-file input. Physical camera permission and webcam capture are not simulated or claimed here.', 'Pixel checks cover selected paused frames. They do not constitute a general tracking-accuracy or occlusion benchmark.'],
};

async function idle(page) {
  await page.waitForFunction(() => {
    const record = document.querySelector('[data-testid="record-button"]');
    return record && !record.disabled;
  }, null, { timeout: 60000 });
  const errors = await page.getByRole('alert').allTextContents();
  assert(!errors.length, 'Application error: ' + errors.join(' '));
}
async function closeDialog(page) {
  const close = page.getByRole('button', { name: 'Close dialog', exact: true });
  if (await close.count()) await close.click();
}
async function pause(page) {
  const button = page.getByRole('button', { name: 'Pause', exact: true });
  if (await button.count()) await button.click();
}
async function settleFrame(page) {
  await idle(page);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function waitForActualInference(page, scene) {
  const began = Date.now();
  let previewReplays = 0;
  const observedDiagnostics = [];
  while (Date.now() - began < 90000) {
    const state = await page.evaluate(() => {
      const video = document.querySelector('video[aria-label="Camera calibration preview"]');
      const record = document.querySelector('[data-testid="record-button"]');
      return { diagnostics: document.querySelector('.diagnostics')?.innerText || '', ended: !!video?.ended,
        ready: !!record && !record.disabled,
        error: document.querySelector('[role="alert"]')?.textContent || '' };
    });
    assert(!state.error, 'Application error: ' + state.error);
    const match = state.diagnostics.match(/Vision\s+([\d.]+)\s+fps\s*·\s*([\d.]+)\s+ms/);
    if (state.diagnostics !== observedDiagnostics.at(-1)) observedDiagnostics.push(state.diagnostics);
    const inferenceMs = Number(match?.[2]);
    if (state.ready && inferenceMs > 0 && (scene !== 'ribbon' || /\bCPU\b/.test(state.diagnostics) || inferenceMs <= 400))
      return { previewReplays, observedDiagnostics };
    // A cold model can outlive this finite source. Replay its actual preview
    // using public transport controls so backend recovery can finish warming.
    if (state.ended && previewReplays < 3) {
      await closeDialog(page); await pause(page);
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await page.getByRole('button', { name: 'A quick guide', exact: true }).click();
      previewReplays++;
    }
    await page.waitForTimeout(300);
  }
  throw new Error('Actual inference did not become responsive after three public preview replays: ' + observedDiagnostics.at(-1));
}
async function seek(page, seconds) {
  await page.getByLabel('Playback position', { exact: true }).evaluate((element, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, String(value));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);
  await settleFrame(page);
  return Number(await page.getByLabel('Playback position', { exact: true }).inputValue());
}
async function pixels(page) {
  return page.getByTestId('artwork-canvas').evaluate(canvas => {
    const small = document.createElement('canvas');
    small.width = 160; small.height = 90;
    const context = small.getContext('2d');
    context.drawImage(canvas, 0, 0, 160, 90);
    return Array.from(context.getImageData(0, 0, 160, 90).data);
  });
}
function comparePixels(first, second) {
  let sum = 0, changed = 0, close = 0;
  for (let index = 0; index < first.length; index += 4) {
    const difference = (Math.abs(first[index] - second[index]) + Math.abs(first[index + 1] - second[index + 1]) + Math.abs(first[index + 2] - second[index + 2])) / 3;
    sum += difference;
    if (difference > 4) changed++;
    if (difference <= 12) close++;
  }
  const count = first.length / 4;
  return { meanAbsoluteRgbDifference: sum / count, changedPixelFraction: changed / count, closePixelFraction: close / count };
}
async function referenceFrame(page, seconds) {
  return page.evaluate(async ({ base64, seconds }) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
    const video = document.createElement('video');
    video.muted = true; video.preload = 'auto'; video.src = url;
    const wait = (event, isReady) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Reference video decode timed out.')); }, 15000);
      const cleanup = () => { clearTimeout(timer); video.removeEventListener(event, check); video.removeEventListener('error', error); };
      const check = () => { if (isReady()) { cleanup(); resolve(); } };
      const error = () => { cleanup(); reject(new Error('Reference video failed to decode.')); };
      video.addEventListener(event, check); video.addEventListener('error', error); check();
    });
    try {
      await wait('loadeddata', () => video.readyState >= 2);
      video.currentTime = seconds;
      await wait('seeked', () => !video.seeking && Math.abs(video.currentTime - seconds) < 0.1);
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const context = canvas.getContext('2d');
      const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
      const width = video.videoWidth * scale, height = video.videoHeight * scale;
      context.translate(1280, 0); context.scale(-1, 1);
      context.drawImage(video, (1280 - width) / 2, (720 - height) / 2, width, height);
      const small = document.createElement('canvas'); small.width = 160; small.height = 90;
      const smallContext = small.getContext('2d'); smallContext.drawImage(canvas, 0, 0, 160, 90);
      return { pixels: Array.from(smallContext.getImageData(0, 0, 160, 90).data), png: canvas.toDataURL('image/png'), sourceTime: video.currentTime };
    } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
  }, { base64: fixtureBytes.toString('base64'), seconds });
}

async function capturePng(page, scene) {
  await page.getByRole('button', { name: 'Export creation', exact: true }).click();
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await page.getByRole('button', { name: /Still image/ }).click();
  const download = await downloadPromise;
  const target = path.join(paths.images, `composite-${scene}.png`);
  await download.saveAs(target); await closeDialog(page);
  const bytes = await readFile(target);
  assert(bytes.readUInt32BE(16) === 1280 && bytes.readUInt32BE(20) === 720, 'Composite PNG dimensions are wrong.');
  return { path: relative(target), width: 1280, height: 720, bytes: bytes.length, sha256: sha256(bytes) };
}

async function saveRealProject(page, scene) {
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill(`Real motion — ${scene}`);
  const downloadPromise = page.waitForEvent('download', { timeout: 45000 });
  await page.getByRole('button', { name: 'Download project', exact: true }).click();
  const download = await downloadPromise;
  const target = path.join(paths.scratch, `real-${scene}.prismstage`);
  await download.saveAs(target); await closeDialog(page);
  const archive = await readFile(target);
  const entries = unzipSync(archive);
  const manifest = JSON.parse(strFromU8(entries['manifest.json']));
  const samples = JSON.parse(strFromU8(entries['samples.json']));
  const videoFiles = Object.keys(entries).filter(name => /\.(mp4|webm)$/.test(name));
  assert(manifest.version === 2 && manifest.scene === scene && manifest.source === 'video', 'Expected a version2 real-video project.');
  assert(manifest.composition === 'video', 'The example must reopen with its original person visible.');
  assert(videoFiles.length === 1, 'The project must retain exactly one original video.');
  assert(sha256(entries[videoFiles[0]]) === fixture.sha256, 'Retained source bytes differ from the licensed original.');
  assert(samples.every(sample => sample.source === 'video'), 'The take contains observations that are not from actual local-video input.');
  const pinchSamples = samples.filter(sample => sample.hands.some(hand => hand.pinch)).length;
  const handSamples = samples.filter(sample => sample.hands.length).length;
  assert(samples.length >= (scene === 'ribbon' ? 6 : 21), `Insufficient actual observations: ${samples.length} samples, ${handSamples} hand samples, ${pinchSamples} pinches in ${manifest.duration.toFixed(2)} seconds.`);
  const masks = Object.keys(entries).filter(name => name.startsWith('masks/'));
  const distinctMasks = new Set(masks.map(name => sha256(entries[name]))).size;
  if (scene === 'portal') assert(distinctMasks > 10, 'The portal did not retain changing actual segmentation masks.');
  else assert(handSamples >= (scene === 'ribbon' ? 3 : 11), 'The hand model did not produce enough actual hand observations.');
  const pinchTimes = samples.filter(sample => sample.hands.some(hand => hand.pinch)).map(sample => sample.t);
  const releaseAfterLastPinch = samples.find(sample => sample.t > (pinchTimes.at(-1) ?? Infinity) && sample.hands.every(hand => !hand.pinch));
  return { target, path: relative(target), bytes: archive.length, sha256: sha256(archive), manifest, sampleCount: samples.length, handSamples, pinchSamples, pinchTimes, releaseTimeAfterLastPinch: releaseAfterLastPinch?.t ?? null, pinchGestureObserved: pinchSamples >= 2, maskFrames: masks.length, distinctMasks, retainedVideoPath: videoFiles[0], retainedVideoSha256: sha256(entries[videoFiles[0]]) };
}

async function publishProject(project, scene) {
  const entries = unzipSync(await readFile(project.target));
  const notice = await readFile(path.join(root, 'docs/VIDEO_EXAMPLE_NOTICE.txt'), 'utf8');
  entries['source-notice.txt'] = strToU8(notice);
  const archive = zipSync(entries, { level: 3 });
  const target = path.join(paths.examples, `real-${scene}.prismstage`);
  await writeFile(target, archive);
  const { target: originalTarget, ...info } = project;
  return { ...info, path: relative(target), bytes: archive.length, sha256: sha256(archive), rawUiDownloadSha256: project.sha256,
    packaging: 'Added portable Apache-2.0 attribution/source-notice.txt; recorded input, manifest, thumbnail, and retained original video bytes are unchanged.' };
}

async function exportFilm(page, scene, duration) {
  await page.getByRole('button', { name: 'Export creation', exact: true }).click();
  const trimStart = 0.3, trimEnd = Math.max(0.5, duration - 0.2);
  await page.getByLabel('Trim start', { exact: true }).fill(String(trimStart));
  await page.getByLabel('Trim end', { exact: true }).fill(String(trimEnd));
  const began = Date.now();
  await page.getByRole('button', { name: /Motion film/ }).click();
  const preview = page.getByLabel('Exported film preview', { exact: true });
  await preview.waitFor({ state: 'attached', timeout: 120000 });
  const decoded = await preview.evaluate(async video => {
    const wait = predicate => new Promise((resolve, reject) => {
      const began = performance.now();
      const id = setInterval(() => { if (predicate()) { clearInterval(id); resolve(); } else if (performance.now() - began > 15000) { clearInterval(id); reject(new Error('Exported video did not decode.')); } }, 40);
    });
    await wait(() => video.readyState >= 1);
    if (!Number.isFinite(video.duration)) { video.currentTime = 1e8; await wait(() => Number.isFinite(video.duration)); }
    video.muted = true; video.currentTime = 0; await video.play();
    await wait(() => video.currentTime >= 0.4); video.pause();
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 160, 90);
    const pixels = context.getImageData(0, 0, 160, 90).data;
    let rgbSum = 0; for (let index = 0; index < pixels.length; index += 4) rgbSum += pixels[index] + pixels[index + 1] + pixels[index + 2];
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, sampledTime: video.currentTime, rgbSum };
  });
  assert(decoded.width === 1280 && decoded.height === 720 && decoded.rgbSum > 10000, 'Composite film is empty or has incorrect dimensions.');
  assert(Math.abs(decoded.duration - (trimEnd - trimStart)) <= 0.6, 'Composite film timing differs from its selected passage.');
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
  await page.getByRole('link', { name: /Download film/ }).click();
  const download = await downloadPromise;
  const extension = path.extname(download.suggestedFilename());
  const target = path.join(paths.films, `real-${scene}${extension}`);
  await download.saveAs(target); await closeDialog(page);
  return { path: relative(target), bytes: (await stat(target)).size, exportWallSeconds: (Date.now() - began) / 1000, trimStart, trimEnd, ...decoded };
}

let browser, context, page;
try {
  browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }), headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US', reducedMotion: 'reduce', acceptDownloads: true });
  context.on('request', request => report.requests.push({ method: request.method(), url: request.url() }));
  page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  report.browser = { version: browser.version(), userAgent: await page.evaluate(() => navigator.userAgent) };
  await page.goto(base, { waitUntil: 'networkidle' });
  await idle(page);
  report.browser.renderer = await page.getByTestId('artwork-canvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'Unavailable';
  });
  report.offlineVersion = await page.evaluate(async () => (await (await fetch(new URL('offline-manifest.json', document.baseURI))).json()).version);
  for (const scene of scenes) {
    const result = { scene, ok: false };
    report.checks.push(result);
    const phase = value => { result.phase = value; console.log(JSON.stringify({ scene, phase: value })); };
    phase('actual model input');
    try {
      await page.getByTestId(`scene-${scene}`).click(); await idle(page);
      await page.getByLabel('Render quality', { exact: true }).selectOption('high');
      if (scene === 'ribbon') {
        await page.getByTestId('drawing-follow').click();
        result.drawingMode = 'follow';
      }
      await page.getByLabel('Import local video', { exact: true }).setInputFiles(fixturePath);
      await page.getByRole('button', { name: 'A quick guide', exact: true }).click();
      result.inferenceWarmup = await waitForActualInference(page, scene);
      result.inferenceDiagnostics = await page.locator('.diagnostics').innerText();
      await closeDialog(page); await idle(page);
      assert(await page.getByTestId('composition-video').getAttribute('aria-pressed') === 'true', 'Real input did not automatically retain its original video.');
      phase('record actual input and retain original source');
      await page.getByTestId('record-button').click();
      await page.getByRole('button', { name: 'Finish take', exact: true }).waitFor({ state: 'visible' });
      await page.waitForTimeout(scene === 'ribbon' ? 7650 : 6200);
      const finish = page.getByRole('button', { name: 'Finish take', exact: true });
      if (await finish.count()) await finish.click();
      await idle(page);
      await page.getByRole('button', { name: 'Save project', exact: true }).waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('button[aria-label="Save project"]')?.disabled);
      await pause(page);
      const duration = Number(await page.getByLabel('Playback position', { exact: true }).getAttribute('max'));
      assert(duration >= 5.5, 'The real-input take ended prematurely.');
      let measuredTake;
      if (scene === 'ribbon') {
        measuredTake = await saveRealProject(page, scene);
        result.recordedInput = { sampleCount: measuredTake.sampleCount, handSamples: measuredTake.handSamples, pinchTimes: measuredTake.pinchTimes };
        assert(measuredTake.manifest.params.drawingMode === 'follow', 'The ordinary-video example must explicitly retain Follow hand mode.');
        result.gestureScope = 'Follow hand mode draws from actual tracked movement. Original pinch observations remain unchanged; this does not demonstrate pinch interaction.';
      }
      phase('seek, restyle, and compare original pixels');
      const chosenTime = Math.min(4.2, duration - 0.4);
      const at = await seek(page, chosenTime);
      const originalLook = await pixels(page);
      await page.getByRole('button', { name: 'Palette glacier', exact: true }).click(); await settleFrame(page);
      const newLook = await pixels(page);
      const paletteChange = comparePixels(originalLook, newLook);
      assert(paletteChange.changedPixelFraction > 0.0005, 'Changing the appearance did not change the generated graphics.');
      const reference = await referenceFrame(page, at);
      const sourceComparison = comparePixels(newLook, reference.pixels);
      assert(sourceComparison.closePixelFraction > 0.35, 'Original source pixels were not preserved outside the effects.');
      await page.getByTestId('composition-abstract').click(); await settleFrame(page);
      const abstractLook = await pixels(page);
      const compositionChange = comparePixels(abstractLook, newLook);
      assert(compositionChange.changedPixelFraction > 0.12, 'Hiding original footage did not materially change the composition.');
      await page.getByTestId('composition-video').click(); await settleFrame(page);
      const restoredComposition = comparePixels(await pixels(page), newLook);
      assert(restoredComposition.meanAbsoluteRgbDifference < 0.5, 'Composition toggle moved the recorded effect or source frame.');
      result.pixelChecks = { frameTime: at, paletteChange, sourceComparison, compositionChange, restoredComposition };
      const sourcePng = path.join(paths.images, `composite-${scene}-source.png`);
      await writeFile(sourcePng, Buffer.from(reference.png.split(',')[1], 'base64'));
      result.sourceFrame = { path: relative(sourcePng), sourceTime: reference.sourceTime, note: 'Separately decoded and mirrored original source frame, not an application-generated stand-in.' };
      phase('capture PNG and save editable project');
      result.png = await capturePng(page, scene);
      const screenshot = path.join(paths.images, `composite-${scene}-studio.png`);
      await page.screenshot({ path: screenshot, fullPage: true }); result.studioScreenshot = relative(screenshot);
      const project = await saveRealProject(page, scene);
      phase('reopen retained-source project and replay');
      const beforeRestore = await pixels(page);
      await page.getByLabel('Import project file', { exact: true }).setInputFiles(project.target);
      await page.getByRole('status').filter({ hasText: 'Project opened.' }).waitFor({ state: 'visible', timeout: 45000 });
      await idle(page); await seek(page, at);
      const roundtrip = comparePixels(beforeRestore, await pixels(page));
      assert(roundtrip.meanAbsoluteRgbDifference < 0.5, 'Saving and reopening the project changed the paused composite.');
      await page.getByRole('button', { name: 'Replay take', exact: true }).click();
      await page.waitForTimeout(1000); await pause(page); await idle(page);
      const replayTime = Number(await page.getByLabel('Playback position', { exact: true }).inputValue());
      assert(replayTime > 0.4, 'Retained original video and effects did not replay.');
      phase('export final composite film');
      result.film = await exportFilm(page, scene, project.manifest.duration);
      result.project = await publishProject(project, scene);
      result.roundtrip = roundtrip; result.replayTime = replayTime; result.ok = true;
      console.log(JSON.stringify({ scene, ok: true, handSamples: project.handSamples, pinchSamples: project.pinchSamples, distinctMasks: project.distinctMasks, film: result.film.path }));
    } catch (error) {
      result.error = error.message;
      result.visibleState = (await page.locator('body').innerText()).slice(-3500);
      const screenshot = path.join(paths.scratch, `failure-${scene}.png`);
      await page.screenshot({ path: screenshot }).catch(() => {}); result.failureScreenshot = relative(screenshot);
      console.log(JSON.stringify({ scene, ok: false, error: error.message }));
      await closeDialog(page).catch(() => {});
      if (scene !== scenes.at(-1)) { await page.reload({ waitUntil: 'networkidle' }); await idle(page); }
    }
  }
  const externalWrites = report.requests.filter(request => !['GET', 'HEAD', 'OPTIONS'].includes(request.method));
  report.network = { uploadRequests: externalWrites, allRequestsSameOrigin: report.requests.every(request => request.url.startsWith(new URL(base).origin) || /^(blob:|data:)/.test(request.url)) };
  report.ok = report.checks.every(check => check.ok) && !report.pageErrors.length && !externalWrites.length && report.network.allRequestsSameOrigin;
} finally {
  await page?.close().catch(() => {}); await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ report: relative(reportFile), ok: report.ok }));
if (!report.ok) process.exitCode = 1;
