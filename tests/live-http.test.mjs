import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../live/http.js';
import { initialState } from '../live/queue.js';

const env = { LIVE_ADMIN_TOKEN: 'admin'.repeat(8), LIVE_WORKER_TOKEN: 'worker'.repeat(8), LIVE_SESSION_SECRET: 'session'.repeat(8) };
function fixture() {
  let state = initialState('talk', 'simulation');
  const store = { read: async () => state, mutate: async fn => {
    const next = structuredClone(state), result = fn(next); state = next; return { state, result };
  } };
  const handler = createHandler({ env, storeFactory: () => store });
  return async (path, { method = 'GET', headers = {}, body } = {}) => {
    const responseHeaders = {};
    const res = { setHeader: (k, v) => { responseHeaders[k] = v; }, end: value => { res.body = JSON.parse(value); } };
    await handler({ url: `/api/live/${path}`, method, headers: { host: 'demo.test', ...headers }, body }, res);
    return { status: res.statusCode, body: res.body, headers: responseHeaders };
  };
}
test('signed participant cookie survives refresh and deduplicates retry', async () => {
  const call = fixture();
  const first = await call('state');
  const cookie = first.headers['Set-Cookie'].split(';')[0];
  const headers = { cookie, 'content-type': 'application/json', origin: 'https://demo.test' };
  const body = { red: 6, yellow: 3, blue: 1 };
  const submitted = await call('jobs', { method: 'POST', headers, body });
  assert.equal(submitted.status, 200);
  assert.equal((await call('jobs', { method: 'POST', headers, body })).body.jobs.length, 1);
  assert.equal((await call('state', { headers: { cookie } })).body.ownJob.id, submitted.body.ownJob.id);
  assert.equal((await call('state', { headers: { cookie: cookie.replace(/.$/, 'x') } })).body.ownJob, null);
});
test('admin and worker permissions are separate; public cannot execute; mutations reject cross-origin and malformed bodies', async () => {
  const call = fixture();
  const json = { 'content-type': 'application/json' };
  assert.equal((await call('admin/state')).status, 401);
  assert.equal((await call('admin/run', { method: 'POST', headers: { ...json, authorization: `Bearer ${env.LIVE_WORKER_TOKEN}` }, body: {} })).status, 401);
  assert.equal((await call('worker/claim', { method: 'POST', headers: { ...json, authorization: `Bearer ${env.LIVE_ADMIN_TOKEN}` }, body: {} })).status, 401);
  assert.equal((await call('jobs', { method: 'POST', headers: { ...json, origin: 'https://evil.test' }, body: {} })).status, 403);
  assert.equal((await call('jobs', { method: 'POST', headers: json, body: '{' })).status, 400);
  assert.equal((await call('jobs', { method: 'POST', headers: json, body: 'a'.repeat(5000) })).status, 413);
  assert.equal((await call('worker/claim', { headers: { authorization: `Bearer ${env.LIVE_WORKER_TOKEN}` } })).status, 404);
});
