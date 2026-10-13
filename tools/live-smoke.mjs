// Hardware-free browser integration test against the real local queue and worker.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';

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
  const firstColor = await page.locator('.live-color-disc').evaluate(el => getComputedStyle(el).backgroundColor);
  await page.getByRole('slider', { name: 'Red', exact: true }).fill('8');
  await expect.poll(() => page.locator('.live-color-disc').evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(firstColor);
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
  assert.deepEqual(errors, []);
  console.log('PASS: mobile picker, durable receipt, manual run, QR, simulated worker, one-well completion, and later-arrival hold.');
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  children.forEach(child => child.kill('SIGTERM'));
}
