/**
 * Public-UI acceptance for the retained-video release and deployed Pages build.
 * Run against a completed production build, with other GPU tests stopped.
 * PRISM_TEST_URL defaults to http://127.0.0.1:4173/.
 * PRISM_BROWSER accepts chrome (default) or msedge. CHROME_PATH is optional.
 * Uses packaged actual-model examples; never opens a camera or private app API.
 */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8, strToU8, zipSync } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = process.env.PRISM_TEST_URL || 'http://127.0.0.1:4173/';
const channel = process.env.PRISM_BROWSER || 'chrome';
if (!['chrome', 'msedge'].includes(channel)) throw new Error('PRISM_BROWSER must be chrome or msedge.');
const location = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(base).hostname) ? 'local' : 'pages';
const label = `${channel}-${location}`;
const scratch = path.join(root, '.local/composite-smoke', label);
const reportPath = path.join(root, 'docs', `composite-smoke-${label}.json`);
await mkdir(scratch, { recursive: true });
const relative = value => path.relative(root, value).replaceAll('\\', '/');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const report = {
  startedAt: new Date().toISOString(), base, channel, location,
  method: 'An isolated native browser uses the public studio controls to open packaged real-model examples, replay, switch composition, export PNG and portrait film, download editable projects, save/reopen IndexedDB, and reopen all three examples with networking disabled after complete caching.',
  checks: [], consoleErrors: [], pageErrors: [], requests: [], browserInternalRequestCount: 0,
  limitations: [
    'Packaged examples replay observations from genuine prior MediaPipe inference; this smoke test does not run a fresh model or open a physical camera.',
    'Native film playback verifies decoding, dimensions and changing frames. Independent FFmpeg reports provide full-stream media inspection.',
    'Twenty stage changes check visible failures and WebGL errors, not exact GPU allocation accounting.',
    'Offline networking is disabled in the browser context after the UI reports complete caching.',
  ],
};
const launch = channel === 'chrome' && process.env.CHROME_PATH
  ? { executablePath: process.env.CHROME_PATH, headless: true }
  : { channel, headless: true };
let browser, context, page;
function attach(target) {
  target.setDefaultTimeout(30000);
  target.on('console', message => {
    if (message.type() === 'error') report.consoleErrors.push(message.text());
  });
  target.on('pageerror', error => report.pageErrors.push(error.message));
}
async function check(name, action) {
  const began = Date.now();
  try {
    const detail = await action();
    report.checks.push({ name, ok: true, elapsedMs: Date.now() - began, ...detail });
    console.log(`PASS ${name}`);
    return detail;
  } catch (error) {
    report.checks.push({ name, ok: false, elapsedMs: Date.now() - began, error: error.stack || String(error) });
    throw error;
  }
}
async function ready() {
  await page.waitForFunction(() => {
    const record = document.querySelector('[data-testid="record-button"]');
    const example = document.querySelector('[data-testid="real-example"]');
    return record && !record.disabled && example && !example.disabled;
  }, null, { timeout: 60000 });
  const errors = await page.getByRole('alert').allTextContents();
  assert(errors.length === 0, `Application error: ${errors.join(' ')}`);
}
async function closeDialog() {
  const button = page.getByRole('button', { name: 'Close dialog', exact: true });
  if (await button.count()) await button.click();
}
async function pause() {
  const button = page.getByRole('button', { name: 'Pause', exact: true });
  if (await button.count()) await button.click();
}
async function frame() {
  await ready();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function openExample(scene) {
  await page.getByTestId(`scene-${scene}`).click();
  await ready();
  await page.getByTestId('real-example').click();
  await ready();
  await page.waitForFunction(id => {
    const source = document.querySelector('[data-testid="composition-video"]');
    const timeline = document.querySelector('input[aria-label="Playback position"]');
    return document.querySelector(`[data-testid="scene-${id}"]`)?.getAttribute('aria-pressed') === 'true'
      && source?.getAttribute('aria-pressed') === 'true' && !source.disabled && Number(timeline?.max) > 0.1;
  }, scene, { timeout: 60000 });
  await pause();
  await frame();
  return { scene, duration: Number(await page.getByLabel('Playback position', { exact: true }).getAttribute('max')) };
}
async function seek(seconds) {
  await page.getByLabel('Playback position', { exact: true }).evaluate((input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);
  await frame();
}
async function pixels() {
  return page.getByTestId('artwork-canvas').evaluate(canvas => {
    const small = document.createElement('canvas'); small.width = 160; small.height = 90;
    const ctx = small.getContext('2d'); ctx.drawImage(canvas, 0, 0, 160, 90);
    return Array.from(ctx.getImageData(0, 0, 160, 90).data);
  });
}
function pixelDifference(first, second) {
  let total = 0, changed = 0;
  for (let i = 0; i < first.length; i += 4) {
    const difference = (Math.abs(first[i] - second[i]) + Math.abs(first[i + 1] - second[i + 1]) + Math.abs(first[i + 2] - second[i + 2])) / 3;
    total += difference; if (difference > 4) changed++;
  }
  return { meanAbsoluteRgbDifference: total / (first.length / 4), changedPixelFraction: changed / (first.length / 4) };
}
async function downloadProject(name) {
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill(name);
  const waiting = page.waitForEvent('download', { timeout: 60000 });
  await page.getByRole('button', { name: 'Download project', exact: true }).click();
  const download = await waiting;
  assert(download.suggestedFilename().endsWith('.prismstage'), 'Wrong editable-project extension.');
  const target = path.join(scratch, `${name}.prismstage`);
  await download.saveAs(target);
  await ready();
  await closeDialog();
  const bytes = await readFile(target), files = unzipSync(bytes);
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  const samples = JSON.parse(strFromU8(files['samples.json']));
  const sourcePath = manifest.video?.mimeType === 'video/mp4' ? 'source.mp4' : 'source.webm';
  const notice = files['source-notice.txt'] && strFromU8(files['source-notice.txt']);
  assert(manifest.version === 2 && manifest.source === 'video' && manifest.composition === 'video', 'Downloaded example lost its video composition.');
  assert(files[sourcePath]?.length > 1000 && samples.length > 10, 'Source footage or recorded observations are missing.');
  assert(/Apache License/i.test(notice || '') && /Google/i.test(notice || '') && /https:\/\//.test(notice || ''), 'Portable source attribution/license is missing.');
  return { path: relative(target), bytes: bytes.length, sha256: sha256(bytes), scene: manifest.scene, duration: manifest.duration,
    sourceSha256: sha256(files[sourcePath]), samplesSha256: sha256(files['samples.json']), noticeSha256: sha256(files['source-notice.txt']), sourceBytes: files[sourcePath].length };
}
async function saveLocally(name) {
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Save locally', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 60000 });
  await ready();
}
async function reopenLocal(name) {
  await page.getByRole('button', { name: 'My collection', exact: true }).click();
  await page.locator('.saved-project > button:not(.delete-project)').filter({ hasText: name }).first().click();
  await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 60000 });
  await frame();
}
async function capturePng(name) {
  await page.getByRole('button', { name: 'Export creation', exact: true }).click();
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: /Still image/ }).click();
  const download = await waiting, target = path.join(scratch, `${name}.png`);
  await download.saveAs(target); await closeDialog();
  const bytes = await readFile(target);
  assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'PNG signature is invalid.');
  assert(bytes.readUInt32BE(16) === 1280 && bytes.readUInt32BE(20) === 720, 'PNG is not 1280×720.');
  return { path: relative(target), bytes: bytes.length, sha256: sha256(bytes), width: 1280, height: 720 };
}
async function portraitFilm(name) {
  // The public aspect button changes only framing, retaining the original take.
  const dimensions = await page.getByTestId('artwork-canvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
  if (dimensions.width > dimensions.height) await page.getByRole('button', { name: 'Toggle aspect ratio', exact: true }).click();
  await page.getByRole('button', { name: 'Export creation', exact: true }).click();
  await page.getByLabel('Trim start', { exact: true }).fill('0.3');
  await page.getByLabel('Trim end', { exact: true }).fill('3.3');
  const previousPreview = page.getByLabel('Exported film preview', { exact: true });
  const previous = await previousPreview.count() ? await previousPreview.getAttribute('src') : null;
  await page.getByRole('button', { name: /Motion film/ }).click();
  await page.waitForFunction(previous => {
    const video = document.querySelector('video[aria-label="Exported film preview"]');
    return video?.readyState >= 2 && video.getAttribute('src') !== previous;
  }, previous, { timeout: 90000 });
  const decoded = await page.getByLabel('Exported film preview', { exact: true }).evaluate(async video => {
    const until = predicate => new Promise((resolve, reject) => {
      const began = performance.now();
      const timer = setInterval(() => {
        if (predicate()) { clearInterval(timer); resolve(); }
        else if (performance.now() - began > 15000) { clearInterval(timer); reject(new Error('Native exported-film decode timed out.')); }
      }, 20);
    });
    if (!Number.isFinite(video.duration)) { video.currentTime = 1e6; await until(() => Number.isFinite(video.duration)); }
    video.currentTime = 0; await until(() => !video.seeking);
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 140;
    const ctx = canvas.getContext('2d');
    const fingerprint = () => {
      ctx.drawImage(video, 0, 0, 80, 140);
      const rgba = ctx.getImageData(0, 0, 80, 140).data;
      let hash = 2166136261;
      for (let i = 0; i < rgba.length; i++) hash = Math.imul(hash ^ rgba[i], 16777619);
      return hash >>> 0;
    };
    const fingerprints = [fingerprint()];
    video.muted = true; await video.play();
    while (!video.ended) { await new Promise(resolve => setTimeout(resolve, 150)); fingerprints.push(fingerprint()); if (fingerprints.length > 100) throw new Error('Exported-film playback did not finish.'); }
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames,
      sampledFrames: fingerprints.length, distinctFrameFingerprints: new Set(fingerprints).size, mediaError: video.error?.message ?? null };
  });
  assert(decoded.width === 720 && decoded.height === 1280, 'Portrait film has wrong dimensions.');
  assert(decoded.duration >= 2.4 && decoded.duration <= 4.5, 'Portrait film duration differs materially from its three-second trim.');
  assert(decoded.decodedFrames > 5 && decoded.distinctFrameFingerprints > 2 && !decoded.mediaError, 'Portrait film is frozen or undecodable.');
  const waiting = page.waitForEvent('download');
  await page.getByRole('link', { name: /Download film/ }).click();
  const download = await waiting, target = path.join(scratch, `${name}${path.extname(download.suggestedFilename())}`);
  await download.saveAs(target); await closeDialog();
  const bytes = await readFile(target);
  return { ...decoded, requestedSeconds: 3, path: relative(target), bytes: bytes.length, sha256: sha256(bytes) };
}

try {
  browser = await chromium.launch(launch);
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
  context.on('request', request => {
    if (/^(edge|chrome|devtools):/.test(request.url())) { report.browserInternalRequestCount++; return; }
    report.requests.push({ method: request.method(), url: request.url() });
  });
  page = await context.newPage(); attach(page);
  report.browserVersion = browser.version();
  await page.goto(base, { waitUntil: 'domcontentloaded' }); await ready();
  report.title = await page.title();
  await check('real-gravity deep link opens its original video and recorded effects', async () => {
    const deepLink = new URL(base);
    deepLink.searchParams.set('example', 'real-gravity');
    await page.goto(deepLink.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const composition = document.querySelector('[data-testid="composition-video"]');
      const timeline = document.querySelector('input[aria-label="Playback position"]');
      return document.querySelector('[data-testid="scene-gravity"]')?.getAttribute('aria-pressed') === 'true'
        && composition?.getAttribute('aria-pressed') === 'true' && !composition.disabled
        && timeline && !timeline.disabled && Number(timeline.max) > 0.1;
    }, null, { timeout: 60000 });
    await ready();
    await pause();
    await frame();
    return { url: deepLink.href, scene: 'gravity', originalVideoAndEffects: true,
      oneClickExampleReady: await page.getByTestId('real-example').isEnabled(),
      duration: Number(await page.getByLabel('Playback position', { exact: true }).getAttribute('max')) };
  });
  for (const scene of ['ribbon', 'gravity', 'portal']) {
    await check(`one-click ${scene} example, replay and composition`, async () => {
      const opened = await openExample(scene);
      await seek(0.5);
      const before = await pixels();
      const start = Number(await page.getByLabel('Playback position', { exact: true }).inputValue());
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await page.waitForFunction(start => Number(document.querySelector('input[aria-label="Playback position"]')?.value) > start + 0.6, start);
      await pause(); await frame();
      const after = await pixels(), motion = pixelDifference(before, after);
      assert(motion.changedPixelFraction > 0.002, 'The real example does not visibly advance.');
      const time = Number(await page.getByLabel('Playback position', { exact: true }).inputValue());
      await page.getByTestId('composition-abstract').click(); await frame();
      const abstract = await pixels(), composition = pixelDifference(after, abstract);
      assert(composition.changedPixelFraction > 0.05, 'Switching off original video does not visibly change the composition.');
      await page.getByTestId('composition-video').click(); await frame();
      assert(Number(await page.getByLabel('Playback position', { exact: true }).inputValue()) === time, 'Composition toggle moved the take clock.');
      return { ...opened, motion, composition, toggleRetainsTime: true };
    });
    await check(`${scene} full-resolution PNG`, () => capturePng(scene));
    await check(`${scene} portable original, notice and IndexedDB reopen`, async () => {
      const original = await downloadProject(`portable-${scene}`);
      const name = `Smoke ${scene} ${label}`;
      await saveLocally(name);
      await page.getByTestId(`scene-${scene === 'ribbon' ? 'gravity' : 'ribbon'}`).click(); await ready();
      await reopenLocal(name);
      const reopened = await downloadProject(`reopened-${scene}`);
      for (const key of ['scene', 'sourceSha256', 'samplesSha256', 'noticeSha256']) assert(original[key] === reopened[key], `Local reopen changed ${key}.`);
      return { original, reopened, retainedSourceObservationsAndNotice: true };
    });
  }
  await check('native video metadata rejection preserves the current editable take', async () => {
    await pause(); await seek(1.75);
    const original = await downloadProject('before-invalid-metadata');
    const originalFiles = unzipSync(await readFile(path.join(root, original.path)));
    const originalManifest = JSON.parse(strFromU8(originalFiles['manifest.json']));
    assert(originalManifest.video.width < 8192, 'Fixture width cannot be increased within the valid archive schema.');
    const invalidManifest = { ...originalManifest,
      video: { ...originalManifest.video, width: originalManifest.video.width + 1 } };
    const invalidFiles = { ...originalFiles, 'manifest.json': strToU8(JSON.stringify(invalidManifest)) };
    for (const entry of Object.keys(originalFiles).filter(entry => entry !== 'manifest.json'))
      assert(sha256(invalidFiles[entry]) === sha256(originalFiles[entry]), `The rejection fixture unexpectedly changed ${entry}.`);
    const invalidArchive = zipSync(invalidFiles, { level: 3 });
    const invalidPath = path.join(scratch, 'invalid-video-width.prismstage');
    await writeFile(invalidPath, invalidArchive);
    await frame();
    const beforeTime = Number(await page.getByLabel('Playback position', { exact: true }).inputValue());
    const beforePixels = await pixels();

    await page.getByLabel('Import project file', { exact: true }).setInputFiles(invalidPath);
    const error = page.getByRole('alert').filter({ hasText: /dimensions/i });
    await error.waitFor({ state: 'visible', timeout: 60000 });
    const rejection = await error.innerText();
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await frame();
    const afterTime = Number(await page.getByLabel('Playback position', { exact: true }).inputValue());
    const pausedPixels = pixelDifference(beforePixels, await pixels());
    assert(afterTime === beforeTime, 'Rejected video metadata moved the preserved take clock.');
    assert(pausedPixels.meanAbsoluteRgbDifference < 0.5, 'Rejected video metadata changed the preserved source frame or artwork.');
    assert(await page.getByTestId(`scene-${original.scene}`).getAttribute('aria-pressed') === 'true', 'Rejected video metadata changed the current scene.');
    const retained = await downloadProject('after-invalid-metadata');
    for (const key of ['scene', 'duration', 'sourceSha256', 'samplesSha256', 'noticeSha256'])
      assert(original[key] === retained[key], `Rejected video metadata changed the current project's ${key}.`);
    const retainedFiles = unzipSync(await readFile(path.join(root, retained.path)));
    const retainedManifest = JSON.parse(strFromU8(retainedFiles['manifest.json']));
    const comparedManifestFields = ['id', 'scene', 'duration', 'source', 'composition', 'video', 'params', 'seed', 'fixedDt', 'trim', 'aspect'];
    for (const key of comparedManifestFields)
      assert(JSON.stringify(originalManifest[key]) === JSON.stringify(retainedManifest[key]), `Rejected video metadata changed the preserved manifest's ${key}.`);
    return { original, retained, rejection, invalidArchive: relative(invalidPath), invalidArchiveSha256: sha256(invalidArchive),
      mutation: { field: 'manifest.video.width', original: originalManifest.video.width, rejected: invalidManifest.video.width },
      otherArchiveEntriesUnchanged: true, beforeTime, afterTime, pausedPixels,
      comparedManifestFields, snapshotFieldsExcluded: ['name', 'createdAt'],
      controlsReadyAfterDismissal: true, retainedSourceObservationsNoticeAndProjectState: true };
  });
  await check('portrait real-video film and native playback', () => portraitFilm('portrait'));
  await check('twenty stage switches with no visible or WebGL errors', async () => {
    const switches = [];
    for (let index = 0; index < 20; index++) {
      const scene = ['ribbon', 'gravity', 'portal'][index % 3];
      await page.getByTestId(`scene-${scene}`).click(); await frame();
      const glError = await page.getByTestId('artwork-canvas').evaluate(canvas => canvas.getContext('webgl2').getError());
      assert(glError === 0, `WebGL error ${glError} on switch ${index + 1}.`);
      switches.push({ scene, glError });
    }
    return { switches };
  });
  await check('narrow layout retains accessible example and composition controls', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openExample('ribbon');
    const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert(overflow.scrollWidth <= overflow.viewport + 1, 'The narrow layout overflows horizontally.');
    await page.getByTestId('composition-abstract').scrollIntoViewIfNeeded();
    await page.getByTestId('composition-abstract').click();
    await page.getByTestId('composition-video').click();
    const screenshot = path.join(scratch, 'narrow.png'); await page.screenshot({ path: screenshot, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    return { ...overflow, screenshot: relative(screenshot) };
  });
  await check('complete offline cache includes all three retained-video examples', async () => {
    const readyButton = page.getByRole('button', { name: 'Available offline', exact: true });
    if (!await readyButton.count()) await page.getByRole('button', { name: 'Make available offline', exact: true }).click();
    await readyButton.waitFor({ state: 'visible', timeout: 180000 });
    const cache = await page.evaluate(async () => {
      const response = await fetch(new URL('offline-manifest.json', location.href));
      const manifest = await response.json();
      const name = (await caches.keys()).find(name => name === `prism-stage-${manifest.version}`);
      if (!name) throw new Error('Current offline cache is missing.');
      const stored = await caches.open(name), missing = [];
      for (const file of manifest.files) if (!await stored.match(new URL(file, location.href))) missing.push(file);
      return { version: manifest.version, totalBytes: manifest.totalBytes, files: manifest.files.length, missing,
        realExamples: manifest.files.filter(file => /^examples\/real-.*\.prismstage$/.test(file)) };
    });
    assert(cache.missing.length === 0 && cache.realExamples.length === 3, 'The complete offline bundle lacks real examples.');
    report.buildVersion = cache.version;
    return cache;
  });
  await page.close(); await context.setOffline(true);
  page = await context.newPage(); attach(page);
  await check('fresh offline page reopens all three real examples', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded' }); await ready();
    const probe = await page.evaluate(async () => {
      try { await fetch(`uncached-smoke-${Date.now()}`, { cache: 'no-store' }); return false; } catch { return true; }
    });
    assert(probe, 'An uncached network request unexpectedly succeeded while offline.');
    const examples = [];
    for (const scene of ['ribbon', 'gravity', 'portal']) {
      const opened = await openExample(scene);
      await seek(1);
      examples.push({ ...opened, pixelSha256: sha256(Buffer.from(await pixels())) });
    }
    assert(new Set(examples.map(example => example.pixelSha256)).size === 3, 'Offline real examples have identical output.');
    return { navigatorOnline: await page.evaluate(() => navigator.onLine), uncachedNetworkRejected: probe, examples };
  });
  await check('offline local save/reopen and portrait film', async () => {
    const name = `Offline composite ${label}`;
    await saveLocally(name);
    await reopenLocal(name);
    const project = await downloadProject('offline-project');
    const film = await portraitFilm('offline-portrait');
    return { project, film };
  });
  await check('no external HTTP requests, uploads or uncaught render errors', async () => {
    const http = report.requests.filter(request => /^https?:/.test(request.url));
    const external = http.filter(request => new URL(request.url).origin !== new URL(base).origin);
    const writes = http.filter(request => !['GET', 'HEAD', 'OPTIONS'].includes(request.method));
    const renderErrors = report.consoleErrors.filter(message => /webgl.*(error|lost)|context.*lost|content.security.policy|violat.*directive|refused to (load|connect|execute|evaluate)/i.test(message));
    assert(external.length === 0 && writes.length === 0, 'An external HTTP request or upload occurred.');
    assert(report.pageErrors.length === 0 && renderErrors.length === 0, 'Uncaught or rendering errors occurred.');
    return { observedHttpRequests: http.length, external, writes, renderErrors };
  });
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = error.stack || String(error);
  if (page && !page.isClosed()) {
    report.visibleState = await page.locator('body').innerText().catch(() => 'Unavailable');
    await page.screenshot({ path: path.join(scratch, 'failure.png'), fullPage: true }).catch(() => {});
  }
} finally {
  await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  report.consoleErrorContext = 'A failed uncached fetch is expected during the offline proof. Browser-owned download resources are counted separately; outbound HTTP writes and external origins are explicitly rejected.';
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: relative(reportPath), ok: report.ok, passed: report.checks.filter(check => check.ok).length, error: report.error }));
  process.exitCode = report.ok ? 0 : 1;
}
