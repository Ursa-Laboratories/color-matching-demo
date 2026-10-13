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
const env = { ...process.env, LIVE_ADMIN_TOKEN: randomBytes(32).toString('hex'),
  LIVE_WORKER_TOKEN: randomBytes(32).toString('hex'), LIVE_SESSION_SECRET: randomBytes(32).toString('hex'),
  LIVE_PORT: '8789', LIVE_DATA_DIR: data, LIVE_EVENT_ID: 'browser-rehearsal' };
const children = [];
function start(command, args) {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stderr.on('data', bytes => process.stderr.write(bytes));
  return child;
}
let browser;
try {
  const server = start(process.execPath, ['tools/live-server.mjs']);
  await new Promise((resolve, reject) => {
    server.stdout.once('data', resolve);
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`Local server exited: ${code}`)));
  });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const participant = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await participant.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8789/?view=live');
  await expect(page.getByRole('button', { name: 'Submit my recipe' })).toBeEnabled();
  assert.equal(await page.evaluate(() => document.querySelector('.live-demo').scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(screenshots, 'participant.png'), fullPage: true });
  await page.getByRole('slider', { name: 'Red', exact: true }).fill('8');
  await page.getByRole('button', { name: 'Submit my recipe' }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for the host', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Waiting for the host', exact: true })).toBeVisible();

  const host = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  const operator = await host.newPage();
  await operator.goto('http://127.0.0.1:8789/?view=operator');
  await operator.getByLabel('Operator key').fill(env.LIVE_ADMIN_TOKEN);
  await operator.getByRole('button', { name: 'Unlock controls' }).click();
  await expect(operator.getByRole('button', { name: 'Run 1 queued recipe' })).toBeDisabled();
  start(path.join(root, '.venv/bin/python'), ['-m', 'ursa_learning.live_worker', '--url', 'http://127.0.0.1:8789', '--simulate', '--journal', path.join(data, 'worker.json')]);
  await expect(operator.getByRole('button', { name: 'Run 1 queued recipe' })).toBeEnabled({ timeout: 15_000 });
  await operator.getByRole('button', { name: 'Run 1 queued recipe' }).click();

  const lateContext = await browser.newContext();
  const late = await lateContext.newPage();
  await late.goto('http://127.0.0.1:8789/?view=live');
  await late.getByRole('button', { name: 'Submit my recipe' }).click();
  const screen = await host.newPage();
  await screen.goto('http://127.0.0.1:8789/?view=screen');
  await expect(screen.getByRole('img', { name: 'QR code to submit a mixture' })).toBeVisible();
  await expect(screen.getByRole('heading', { name: 'Making your mixture' })).toBeVisible({ timeout: 15_000 });
  await screen.screenshot({ path: path.join(screenshots, 'talk-screen.png'), fullPage: true });
  await expect(page.getByRole('heading', { name: 'Mixture complete' })).toBeVisible({ timeout: 40_000 });
  await expect(late.getByRole('heading', { name: 'Waiting for the host' })).toBeVisible();
  await expect(operator.getByRole('button', { name: 'Run 1 queued recipe' })).toBeEnabled();
  const state = await (await participant.request.get('http://127.0.0.1:8789/api/live/state')).json();
  assert.equal(state.jobs.length, 2);
  assert.equal(state.jobs[0].status, 'completed');
  assert.equal(state.jobs[1].status, 'queued');
  assert.equal(state.jobs[0].recipe.totalVolumeUl, 150);
  assert(state.jobs[0].well);
  assert.deepEqual(errors, []);
  console.log('PASS: mobile picker, durable receipt, manual run, QR, simulated worker, one-well completion, and later-arrival hold.');
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  children.forEach(child => child.kill('SIGTERM'));
}
