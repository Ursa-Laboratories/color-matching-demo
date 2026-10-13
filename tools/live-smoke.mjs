// Hardware-free browser integration test against the real local queue and worker.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const root = path.resolve(new URL('..', import.meta.url).pathname);
const data = await mkdtemp(path.join(tmpdir(), 'ursa-live-smoke-'));
const screenshots = path.join(root, '.live-data', 'qa');
await mkdir(screenshots, { recursive: true });
const remote = !!process.env.LIVE_TEST_URL;
const baseUrl = process.env.LIVE_TEST_URL?.replace(/\/$/, '') ?? 'http://127.0.0.1:8789';
const credentials = remote ? {} : { LIVE_ADMIN_TOKEN: randomBytes(32).toString('hex'),
  LIVE_WORKER_TOKEN: randomBytes(32).toString('hex'), LIVE_SESSION_SECRET: randomBytes(32).toString('hex') };
const env = { ...process.env, ...credentials,
  LIVE_PORT: '8789', LIVE_DATA_DIR: data, LIVE_EVENT_ID: 'browser-rehearsal' };
assert(env.LIVE_ADMIN_TOKEN?.length >= 32 && env.LIVE_WORKER_TOKEN?.length >= 32, 'Load the rehearsal host/worker keys before running a hosted check.');
const children = [];
function start(command, args) {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', bytes => process.stdout.write(bytes));
  child.stderr.on('data', bytes => process.stderr.write(bytes));
  return child;
}
let browser;
try {
  if (!remote) {
    const server = start(process.execPath, ['tools/live-server.mjs']);
    await new Promise((resolve, reject) => {
      server.stdout.once('data', resolve);
      server.once('error', reject);
      server.once('exit', code => reject(new Error(`Local server exited: ${code}`)));
    });
  }
  const proxy = remote && (process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'],
    ...(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {}) });
  const participant = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const initial = await participant.request.get(`${baseUrl}/api/live/state`);
  assert(initial.ok(), `Queue is unavailable (HTTP ${initial.status()})`);
  const initialState = await initial.json();
  assert.equal(initialState.mode, 'simulation', 'This test refuses to run against a hardware event.');
  assert.equal(initialState.jobs.length, 0, 'Use a fresh rehearsal event for this test.');
  const page = await participant.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${baseUrl}/?view=live`);
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
  await page.getByLabel('Your name').fill('Alex');
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
  assert.equal(await page.evaluate(() => document.querySelector('.live-demo').scrollWidth > innerWidth), false);
  const proportions = page.getByRole('region', { name: 'Recipe proportions', exact: true }).first();
  const firstProportions = await proportions.textContent();
  await page.getByRole('slider', { name: 'Red', exact: true }).fill('8');
  await expect.poll(() => proportions.textContent()).not.toBe(firstProportions);
  await expect(page.getByText('Made by CUB', { exact: true })).toHaveCount(0);
  for (const color of ['Red', 'Yellow', 'Blue']) await page.getByRole('slider', { name: color, exact: true }).fill('0');
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
  await expect(page.getByText('Add a little color first.')).toBeVisible();
  for (const [color, value] of [['Red', '8'], ['Yellow', '3'], ['Blue', '1']]) await page.getByRole('slider', { name: color, exact: true }).fill(value);
  await page.getByRole('slider', { name: 'Blue', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('slider', { name: 'Blue', exact: true })).toHaveValue('2');
  await page.screenshot({ path: path.join(screenshots, 'participant.png'), fullPage: true });
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await desktop.goto(`${baseUrl}/?view=live`);
  await desktop.screenshot({ path: path.join(screenshots, 'participant-desktop.png'), fullPage: true });
  await desktop.close();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Queued', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Queued', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Your submission' }).getByRole('heading', { name: 'Alex.' })).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, 'receipt.png'), fullPage: true });

  const host = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  const operator = await host.newPage();
  await operator.goto(`${baseUrl}/?view=operator`);
  await operator.getByLabel('Operator key').fill(env.LIVE_ADMIN_TOKEN);
  await operator.getByRole('button', { name: 'Unlock controls' }).click();
  await expect(operator.getByRole('button', { name: 'Run 1 queued recipe' })).toBeDisabled();
  start(path.join(root, '.venv/bin/python'), ['-m', 'ursa_learning.live_worker', '--url', baseUrl, '--simulate', '--journal', path.join(data, 'worker.json')]);
  await expect(operator.getByRole('button', { name: 'Run 1 queued recipe' })).toBeEnabled({ timeout: 15_000 });
  await operator.getByRole('button', { name: 'Run 1 queued recipe' }).click();

  const lateContext = await browser.newContext();
  const late = await lateContext.newPage();
  await late.goto(`${baseUrl}/?view=live`);
  await late.getByLabel('Your name').fill('Zoë');
  await late.getByRole('button', { name: 'Submit', exact: true }).click();
  const screen = await host.newPage();
  await screen.goto(`${baseUrl}/?view=screen`);
  await expect(screen.getByRole('img', { name: 'QR code to submit a mixture' })).toBeVisible();
  await expect(screen.getByRole('heading', { name: 'Mixing · Alex' })).toBeVisible({ timeout: 15_000 });
  await screen.screenshot({ path: path.join(screenshots, 'talk-screen.png'), fullPage: true });
  await expect.poll(async () => (await (await participant.request.get(`${baseUrl}/api/live/state`)).json()).jobs[0].status,
    { timeout: 20_000 }).toBe('completed');
  await page.bringToFront();
  await expect(page.getByRole('heading', { name: 'Complete', exact: true })).toBeVisible({ timeout: 40_000 });
  await expect(late.getByRole('heading', { name: 'Queued', exact: true })).toBeVisible();
  await expect(operator.getByRole('button', { name: 'Run 1 queued recipe' })).toBeEnabled();
  const state = await (await participant.request.get(`${baseUrl}/api/live/state`)).json();
  assert.equal(state.jobs.length, 2);
  assert.equal(state.jobs[0].status, 'completed');
  assert.equal(state.jobs[1].status, 'queued');
  assert.equal(state.jobs[0].recipe.totalVolumeUl, 150);
  assert.equal(state.jobs[0].name, 'Alex');
  assert.equal(state.jobs[1].name, 'Zoë');
  await expect(screen.getByRole('heading', { name: 'Zoë', exact: true })).toBeVisible();
  assert(state.jobs[0].well);

  // Photograph two completed simulated wells with one explicitly synthetic
  // fixture. This exercises real browser decoding, normalization, upload and
  // image delivery without connecting to CubOS or touching the live event.
  await operator.getByRole('button', { name: 'Run 1 queued recipe' }).click();
  await expect.poll(async () => (await (await participant.request.get(`${baseUrl}/api/live/state`)).json()).jobs[1].status,
    { timeout: 20_000 }).toBe('completed');
  await late.bringToFront();
  await expect(late.getByRole('heading', { name: 'Complete', exact: true })).toBeVisible({ timeout: 40_000 });
  await expect(page.getByText('Photo not added yet', { exact: true }).first()).toBeVisible();
  const syntheticPhoto = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="white"/><text x="35" y="60" font-family="sans-serif" font-size="30" fill="#222">SIMULATION PHOTO · TEST WELLS</text><circle cx="240" cy="260" r="100" fill="#a74c40"/><circle cx="560" cy="260" r="100" fill="#40897a"/><text x="175" y="425" font-family="sans-serif" font-size="24" fill="#222">demo.1</text><text x="495" y="425" font-family="sans-serif" font-size="24" fill="#222">demo.2</text></svg>')).jpeg().toBuffer();
  await operator.bringToFront();
  await expect(operator.getByRole('button', { name: 'Add photo', exact: true })).toHaveCount(2, { timeout: 10_000 });
  await operator.getByRole('button', { name: 'Add result photo', exact: true }).click();
  await operator.getByRole('checkbox', { name: /well demo\.1,/ }).check();
  await operator.getByRole('checkbox', { name: /well demo\.2,/ }).check();
  await operator.getByLabel('Choose photo', { exact: true }).setInputFiles({ name: 'simulation-photo.jpg', mimeType: 'image/jpeg', buffer: syntheticPhoto });
  await expect(operator.getByRole('img', { name: 'Preview of the photo to add' })).toBeVisible();
  await expect(operator.getByRole('button', { name: 'Save result photo', exact: true })).toBeEnabled();
  await operator.screenshot({ path: path.join(screenshots, 'photo-upload.png'), fullPage: true });
  await operator.getByRole('button', { name: 'Save result photo', exact: true }).click();
  await expect.poll(async () => {
    const result = await (await participant.request.get(`${baseUrl}/api/live/state`)).json();
    return result.jobs.filter(job => job.resultPhoto).length;
  }, { timeout: 30_000 }).toBe(2);
  const photographed = await (await participant.request.get(`${baseUrl}/api/live/state`)).json();
  assert.equal(photographed.jobs[0].resultPhoto.id, photographed.jobs[1].resultPhoto.id);
  assert.deepEqual(photographed.jobs[0].resultPhoto.wellLabels, photographed.jobs.map(job => job.well));
  const photoUrl = photographed.jobs[0].resultPhoto.url;
  const photoResponse = await participant.request.get(new URL(photoUrl, baseUrl).href);
  assert.equal(photoResponse.status(), 200);
  assert.match(photoResponse.headers()['content-type'], /^image\/jpeg/);
  assert.deepEqual([...((await photoResponse.body()).subarray(0, 2))], [255, 216]);
  await page.bringToFront();
  await expect(page.getByRole('img', { name: `Result photo for well ${photographed.jobs[0].well}`, exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await late.bringToFront();
  await expect(late.getByRole('img', { name: `Result photo for well ${photographed.jobs[1].well}`, exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await screen.bringToFront();
  await expect(screen.getByRole('img', { name: `Result photo for well ${photographed.jobs[1].well}`, exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: path.join(screenshots, 'result-photo-phone.png'), fullPage: true });
  await screen.screenshot({ path: path.join(screenshots, 'result-photo-screen.png'), fullPage: true });

  // A second intentional recipe from the same phone must be a new job. Polling
  // and reloads must not replace its editor with the previous receipt.
  await page.getByRole('button', { name: 'Submit another mixture', exact: true }).click();
  await expect(page.getByLabel('Your name')).toHaveValue('Alex');
  await page.getByRole('slider', { name: 'Red', exact: true }).fill('2');
  await page.reload();
  await expect(page.getByRole('slider', { name: 'Red', exact: true })).toHaveValue('2');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Queued', exact: true })).toBeVisible();
  const repeated = await (await participant.request.get(`${baseUrl}/api/live/state`)).json();
  assert.equal(repeated.jobs.length, 3);
  assert.notEqual(repeated.ownJob.id, state.jobs[0].id);
  assert.equal(repeated.ownJob.recipe.parts.red, 2);
  await page.screenshot({ path: path.join(screenshots, 'repeat-submission.png'), fullPage: true });

  await expect(operator.getByRole('button', { name: 'Reset queue', exact: true })).toBeEnabled();
  await operator.getByRole('button', { name: 'Reset queue', exact: true }).click();
  await expect(operator.getByRole('button', { name: 'Confirm reset', exact: true })).toBeVisible();
  await operator.screenshot({ path: path.join(screenshots, 'reset-confirmation.png'), fullPage: true });
  await operator.getByRole('button', { name: 'Keep queue', exact: true }).click();
  assert.equal((await (await participant.request.get(`${baseUrl}/api/live/state`)).json()).jobs.length, 3);
  await operator.getByRole('button', { name: 'Reset queue', exact: true }).click();
  await operator.getByRole('button', { name: 'Confirm reset', exact: true }).click();
  await expect.poll(async () => (await (await participant.request.get(`${baseUrl}/api/live/state`)).json()).jobs.length).toBe(0);
  const resetState = await (await participant.request.get(`${baseUrl}/api/live/state`)).json();
  assert.equal(resetState.queueRevision, 1);
  assert.equal(resetState.draining, false);
  assert.equal(resetState.activeId, null);
  assert.equal((await participant.request.get(new URL(photoUrl, baseUrl).href)).status(), 404, 'Reset must hide archived photos.');
  await page.bringToFront();
  await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeVisible({ timeout: 10_000 });
  await late.bringToFront();
  await expect(late.getByRole('button', { name: 'Submit', exact: true })).toBeVisible({ timeout: 10_000 });

  await page.getByLabel('Your name').fill('Alex');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Queued', exact: true })).toBeVisible();
  await expect(operator.getByRole('button', { name: 'Run 1 queued recipe' })).toBeEnabled();
  await operator.getByRole('button', { name: 'Run 1 queued recipe' }).click();
  await expect(page.getByRole('heading', { name: 'Complete', exact: true })).toBeVisible({ timeout: 40_000 });
  const afterReset = await (await participant.request.get(`${baseUrl}/api/live/state`)).json();
  assert.equal(afterReset.jobs.length, 1);
  assert.equal(afterReset.jobs[0].status, 'completed');
  assert.equal(afterReset.jobs[0].number, 4);
  assert.notEqual(afterReset.jobs[0].well, state.jobs[0].well, 'Reset must preserve the worker well allocation journal.');
  assert.deepEqual(errors, []);
  console.log('PASS: ratios, receipts, manual run, QR, simulation, repeat submissions, completed batch photo upload and display, reset and archived-photo access, and fresh-well allocation after reset.');
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  children.forEach(child => child.kill('SIGTERM'));
}
