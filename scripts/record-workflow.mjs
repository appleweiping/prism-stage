/**
 * Record a real studio workflow against npm run preview, in a fresh Chrome profile.
 * Optional: PRISM_TEST_URL, CHROME_PATH, PRISM_TAKE_SECONDS (default 7),
 * PRISM_REAL_FOOTAGE=1 (licensed actual video), PRISM_NO_SCREEN=1 (diagnostic only),
 * PRISM_TRACE_CAPTURE=1 (passive event logging).
 * No codec, capture, rendering, or application behavior is overridden by this script.
 */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.PRISM_TEST_URL || 'http://127.0.0.1:4173/';
const noScreen = process.env.PRISM_NO_SCREEN === '1';
const realFootage = process.env.PRISM_REAL_FOOTAGE === '1';
const takeSeconds = Number(process.env.PRISM_TAKE_SECONDS || 7);
if (!Number.isFinite(takeSeconds) || takeSeconds < 1 || takeSeconds > 60) throw new Error('PRISM_TAKE_SECONDS must be between 1 and 60.');
const dir = path.join(root, '.local/browser-recordings');
for (const directory of [dir, path.join(root, '.local/production-tests'), path.join(root, '.local/exports'), path.join(root, 'docs/images')]) await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }), headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 }, locale: 'en-US', reducedMotion: 'reduce',
  ...(noScreen ? {} : { recordVideo: { dir, size: { width: 1440, height: 960 } } }),
});
const page = await context.newPage();
const video = page.video(), started = Date.now(), markers = [];
if (process.env.PRISM_TRACE_CAPTURE === '1') await page.addInitScript(() => {
  window.__prismCaptureTrace = [];
  window.__prismCaptureCounts = { drawImage: 0, requestFrame: 0 };
  const log = (event, data = {}) => window.__prismCaptureTrace.push({ event, t: performance.now(), ...data });
  const trackState = track => {
    const { deviceId, ...settings } = track.getSettings();
    return { readyState: track.readyState, muted: track.muted, settings };
  };
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...args) {
    window.__prismCaptureCounts.drawImage++;
    return draw.apply(this, args);
  };
  const capture = HTMLCanvasElement.prototype.captureStream;
  HTMLCanvasElement.prototype.captureStream = function (...args) {
    const stream = capture.apply(this, args);
    log('captureStream', { args, width: this.width, height: this.height });
    for (const track of stream.getTracks()) {
      if (track.requestFrame) {
        const request = track.requestFrame;
        track.requestFrame = function () { window.__prismCaptureCounts.requestFrame++; return request.call(this); };
      }
      log('track', trackState(track));
      for (const event of ['mute', 'unmute', 'ended']) track.addEventListener(event, () => log('track:' + event, trackState(track)));
    }
    return stream;
  };
  const Recorder = window.MediaRecorder;
  window.MediaRecorder = class extends Recorder {
    constructor(stream, options) {
      super(stream, options);
      log('MediaRecorder', { options, mimeType: this.mimeType });
      for (const event of ['start', 'stop', 'error', 'dataavailable']) this.addEventListener(event, eventObject => log('recorder:' + event, {
        state: this.state, size: eventObject.data?.size, mimeType: eventObject.data?.type,
        error: eventObject.error?.message, tracks: stream.getTracks().map(trackState),
      }));
    }
  };
});
const mark = action => {
  const item = { action, seconds: (Date.now() - started) / 1000 };
  markers.push(item); console.log(JSON.stringify(item));
};
let complete = false, failure = null, film = null, expectedSeconds = null;
try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('[data-testid="record-button"]') && !document.querySelector('[data-testid="record-button"]').disabled);
  const pause = page.getByRole('button', { name: 'Pause', exact: true });
  if (await pause.count()) await pause.click();
  mark('Studio ready; authored demo is explicitly labelled');
  if (realFootage) {
    await page.getByLabel('Import local video', { exact: true }).setInputFiles(path.join(root, '.local/fixtures/gestures.mp4'));
    await page.getByRole('button', { name: 'A quick guide', exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector('.diagnostics')?.textContent?.match(/Vision\s+[\d.]+\s+fps\s*·\s*([\d.]+)\s+ms/)?.[1]) > 0, null, { timeout: 90000 });
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    mark('Import licensed real footage; actual MediaPipe inference ready');
  }
  await page.waitForTimeout(1000);
  await page.getByTestId('record-button').click(); mark('Record motion');
  await page.waitForTimeout(takeSeconds * 1000);
  await page.getByTestId('record-button').click(); mark('Finish take');
  await page.waitForFunction(() => document.querySelector('[data-testid="record-button"]')?.disabled === false);
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Palette glacier', exact: true }).click(); mark('Recolor the recorded motion');
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Replay take', exact: true }).click(); mark('Replay restyled motion');
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Afterlight — my first study');
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Save locally', exact: true }).click(); mark('Save editable project in local collection');
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Export creation', exact: true }).click();
  expectedSeconds = Number(await page.getByLabel('Trim end', { exact: true }).inputValue()) - Number(await page.getByLabel('Trim start', { exact: true }).inputValue());
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: /Motion film/ }).click(); mark('Export silent canvas film');
  const preview = page.getByLabel('Exported film preview', { exact: true });
  for (let attempt = 0; attempt < 120; attempt++) {
    try { await preview.waitFor({ state: 'attached', timeout: 1000 }); break; }
    catch {
      const notices = await page.getByRole('status').allTextContents();
      const exportProgress = await page.locator('.export-progress').allTextContents();
      console.log(JSON.stringify({ exportProgress, alerts: await page.getByRole('alert').allTextContents(), notices }));
      const failed = notices.find(text => /Video export produced|encoder failed|export stopped|did not finish|encoder.*timed out/i.test(text));
      if (failed && !exportProgress.length) throw new Error(failed);
    }
  }
  if (!await preview.count()) throw new Error('Export preview did not appear.');
  await page.waitForFunction(() => document.querySelector('video[aria-label="Exported film preview"]')?.readyState >= 1);
  if (!await preview.evaluate(v => Number.isFinite(v.duration))) {
    await preview.evaluate(v => { v.currentTime = 1e8; });
    await page.waitForFunction(() => Number.isFinite(document.querySelector('video[aria-label="Exported film preview"]').duration), null, { timeout: 15000 });
  }
  await preview.scrollIntoViewIfNeeded();
  await preview.evaluate(async v => { v.muted = true; v.currentTime = 0; await v.play(); }); mark('Play the completed export');
  await page.waitForTimeout(3000);
  const metadata = await preview.evaluate(v => ({ width: v.videoWidth, height: v.videoHeight, currentTime: v.currentTime, duration: v.duration }));
  if (metadata.width !== 1280 || metadata.height !== 720 || metadata.currentTime < 0.25) throw new Error('Fresh film failed dimension or playback validation.');
  if (!Number.isFinite(metadata.duration) || metadata.duration < expectedSeconds - 0.75 || metadata.duration > expectedSeconds + 1.25) throw new Error(`Fresh film duration ${metadata.duration}s differs from requested ${expectedSeconds}s.`);
  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: /Download film/ }).click();
  const download = await pendingDownload;
  const filmPath = path.join(root, `.local/exports/${realFootage ? 'composite' : 'fresh'}-workflow` + path.extname(download.suggestedFilename()));
  await download.saveAs(filmPath);
  film = { path: path.relative(root, filmPath), bytes: (await stat(filmPath)).size, expectedSeconds, ...metadata }; mark('Download the completed film');
  await page.screenshot({ path: path.join(root, `docs/images/${realFootage ? 'composite-' : ''}workflow-export.png`) });
  mark('End'); complete = true;
} catch (error) {
  failure = { error: String(error), visibleState: await page.locator('body').innerText() };
  await page.screenshot({ path: path.join(root, '.local/production-tests/workflow-failure.png') });
  console.error(JSON.stringify(failure)); throw error;
} finally {
  const captureDiagnostics = await page.evaluate(() => window.__prismCaptureTrace ? { events: window.__prismCaptureTrace, counts: window.__prismCaptureCounts } : null);
  if (captureDiagnostics) console.log(JSON.stringify({ captureDiagnostics }));
  await page.close(); await context.close(); await browser.close();
  const recording = video ? path.relative(root, await video.path()) : null;
  const reportPath = path.join(root, realFootage ? 'docs/composite-workflow-validation.json' : 'docs/production-validation.json');
  let report = {}; try { report = JSON.parse(await readFile(reportPath, 'utf8')); } catch { /* A clean checkout need not have a previous run. */ }
  report[noScreen ? 'workflowDiagnostic' : 'workflowDemonstration'] = {
    complete, failure, recording, film, captureDiagnostics, screenRecording: !noScreen,
    viewport: { width: 1440, height: 960 }, recordingSize: noScreen ? null : { width: 1440, height: 960 },
    source: realFootage ? 'Licensed Google MediaPipe gesture video, passed through actual local MediaPipe inference and composited with generated effects.' : 'Built-in authored demo, visibly labelled; actual model inference evidence is separate.', markers,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ complete, recording, film, markers }));
}
