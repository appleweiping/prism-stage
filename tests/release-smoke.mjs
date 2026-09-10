/** Small cross-browser/deployed-origin check, separate from the full acceptance suite. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const base = process.env.PRISM_TEST_URL || 'http://127.0.0.1:4173/';
const channel = process.env.PRISM_BROWSER || 'msedge';
const report = { startedAt: new Date().toISOString(), base, channel, checks: [], requests: [] };
const browser = await chromium.launch({ channel, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
const page = await context.newPage();
report.consoleErrors = [];
page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
report.browserInternalRequestCount = 0;
context.on('request', r => {
  // Edge exposes its own download hub in context events. These local browser
  // resources are not requests from the studio and may contain temporary paths.
  if (/^(edge|chrome|devtools):/.test(r.url())) { report.browserInternalRequestCount++; return; }
  report.requests.push({ method: r.method(), url: r.url() });
});
const assert = (ok, message) => { if (!ok) throw Error(message); };
async function ready() { await page.waitForFunction(() => document.querySelector('[data-testid="record-button"]')?.disabled === false); }
async function close() { await page.getByRole('button', { name: 'Close dialog', exact: true }).click(); }
try {
  report.browserVersion = browser.version();
  await page.goto(base, { waitUntil: 'networkidle' }); await ready();
  report.title = await page.title();
  for (const scene of ['ribbon', 'gravity', 'portal']) {
    await page.getByTestId(`scene-${scene}`).click(); await ready();
    const result = await page.getByTestId('artwork-canvas').evaluate(canvas => {
      const gl = canvas.getContext('webgl2');
      const values = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, values);
      let colored = 0;
      for (let i = 0; i < values.length; i += 4) if (Math.max(values[i], values[i+1], values[i+2]) > 45) colored++;
      return { width: canvas.width, height: canvas.height, coloredFraction: colored / (values.length / 4), glError: gl.getError() };
    });
    assert(result.coloredFraction > 0.001 && result.glError === 0, `${scene} did not render`);
    report.checks.push({ scene, kind: 'render', ok: true, ...result });
  }
  for (const scene of ['ribbon', 'portal']) {
    await page.getByTestId(`scene-${scene}`).click(); await ready();
    await page.getByLabel('Import local video', { exact: true }).setInputFiles(path.join(root, '.local/fixtures/gestures.mp4'));
    await page.locator('.model-loading').waitFor({ state: 'hidden', timeout: 60000 });
    await page.getByRole('button', { name: 'A quick guide', exact: true }).click();
    await page.waitForFunction(() => /Vision\s+[\d.]*[1-9][\d.]*\s+fps/.test(document.querySelector('.diagnostics')?.innerText || ''), null, { timeout: 60000 });
    const diagnostics = await page.locator('.diagnostics').innerText();
    assert(!await page.getByRole('alert').count(), `${scene} model showed an error`);
    await close();
    report.checks.push({ scene, kind: 'actual local video inference', ok: true, diagnostics });
  }
  await page.getByTestId('scene-ribbon').click(); await ready();
  await page.getByRole('button', { name: 'My collection', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Ribbon Atelier', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' }); await ready();
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.evaluate(() => {
    window.__prismOriginalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'projects') throw new DOMException('Injected quota failure', 'QuotaExceededError');
      return window.__prismOriginalPut.apply(this, args);
    };
  });
  await page.getByRole('button', { name: 'Save locally', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Your browser storage is full' }).waitFor({ state: 'visible' });
  const projectDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project', exact: true }).click();
  const savedProject = await projectDownload;
  assert(savedProject.suggestedFilename().endsWith('.prismstage'), 'Quota recovery project download is unavailable');
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.__prismOriginalPut; delete window.__prismOriginalPut; });
  await close();
  report.checks.push({ kind: 'injected storage quota failure offers project download recovery', ok: true });
  await page.getByRole('button', { name: 'Toggle aspect ratio', exact: true }).click();
  await page.getByRole('button', { name: 'Export creation', exact: true }).click();
  await page.getByLabel('Trim start', { exact: true }).fill('0');
  await page.getByLabel('Trim end', { exact: true }).fill('3');
  await page.getByRole('button', { name: /Motion film/ }).click();
  const preview = page.getByLabel('Exported film preview', { exact: true });
  await preview.waitFor({ state: 'attached', timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('video[aria-label="Exported film preview"]')?.readyState >= 1);
  const film = await preview.evaluate(video => ({ width: video.videoWidth, height: video.videoHeight }));
  assert(film.width === 720 && film.height === 1280, 'Portrait film dimensions are wrong');
  const downloading = page.waitForEvent('download');
  await page.getByRole('link', { name: /Download film/ }).click();
  const download = await downloading;
  await mkdir(path.join(root, '.local/exports'), { recursive: true });
  await download.saveAs(path.join(root, '.local/exports', `portrait-${channel}${path.extname(download.suggestedFilename())}`));
  report.checks.push({ kind: 'portrait canvas film', ok: true, ...film });
  const previousFilmUrl = await preview.getAttribute('src');
  await page.getByLabel('Trim end', { exact: true }).fill('0.1');
  await page.getByRole('button', { name: /Motion film/ }).click();
  await preview.waitFor({ state: 'attached', timeout: 60000 });
  await page.waitForFunction(previous => {
    const video = document.querySelector('video[aria-label="Exported film preview"]');
    return video?.readyState >= 2 && video.getAttribute('src') !== previous;
  }, previousFilmUrl);
  const shortFilm = await preview.evaluate(video => ({ width: video.videoWidth, height: video.videoHeight }));
  assert(shortFilm.width === 720 && shortFilm.height === 1280, 'Minimum-duration film did not decode');
  const shortDownloading = page.waitForEvent('download');
  await page.getByRole('link', { name: /Download film/ }).click();
  const shortDownload = await shortDownloading;
  await shortDownload.saveAs(path.join(root, '.local/exports', `minimum-${channel}${path.extname(shortDownload.suggestedFilename())}`));
  report.checks.push({ kind: '0.1 second minimum trim decodes', ok: true, ...shortFilm });
  const external = report.requests.filter(r => !r.url.startsWith('blob:') && new URL(r.url).origin !== new URL(base).origin);
  assert(external.length === 0, 'Observed third-party requests');
  assert(report.requests.every(r => r.method === 'GET'), 'Observed upload/write request');
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = error.stack || String(error);
  report.visibleState = await page.locator('body').innerText();
  await page.screenshot({ path: path.join(root, '.local', `smoke-${channel}-failure.png`) });
}
finally {
  await context.close(); await browser.close();
  report.finishedAt = new Date().toISOString();
  const name = process.env.PRISM_SMOKE_REPORT || `smoke-${channel}.json`;
  await writeFile(path.join(root, 'docs', name), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: name, ok: report.ok, error: report.error, checks: report.checks }));
  process.exitCode = report.ok ? 0 : 1;
}
