import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../live/http.js';
import { initialState } from '../live/queue.js';
import { SupabaseStore } from '../live/store.js';
import workerEntrypoint, { createHandler as createWorkerHandler } from '../api/live/worker/[action].js';
import adminEntrypoint, { createHandler as createAdminHandler } from '../api/live/admin/[action].js';

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
  const body = { red: 6, yellow: 3, blue: 1, name: 'Alex' };
  const submitted = await call('jobs', { method: 'POST', headers, body });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.ownJob.name, 'Alex');
  assert.equal((await call('jobs', { method: 'POST', headers, body })).body.jobs.length, 1);
  assert.equal((await call('state', { headers: { cookie } })).body.ownJob.id, submitted.body.ownJob.id);
  assert.equal((await call('state', { headers: { cookie: cookie.replace(/.$/, 'x') } })).body.ownJob, null);
});
test('a participant can submit distinct IDs and public responses never expose submission IDs', async () => {
  const call = fixture();
  const firstState = await call('state');
  const cookie = firstState.headers['Set-Cookie'].split(';')[0];
  const headers = { cookie, 'content-type': 'application/json', origin: 'https://demo.test' };
  const base = { red: 6, yellow: 3, blue: 1, name: 'Alex' };
  const first = await call('jobs', { method: 'POST', headers, body: { ...base, submissionId: 'phone-submit-0001' } });
  const retry = await call('jobs', { method: 'POST', headers, body: { ...base, submissionId: 'phone-submit-0001' } });
  const second = await call('jobs', { method: 'POST', headers, body: { ...base, submissionId: 'phone-submit-0002' } });
  assert.equal(first.body.jobs.length, 1);
  assert.equal(retry.body.jobs.length, 1);
  assert.equal(second.body.jobs.length, 2);
  assert.notEqual(first.body.ownJob.id, second.body.ownJob.id);
  assert.equal(second.body.ownJob.id, second.body.jobs[1].id);
  assert.equal(second.body.jobs.some(job => Object.hasOwn(job, 'submissionId')), false);
  assert.equal(Object.hasOwn(second.body.ownJob, 'submissionId'), false);
  assert.equal((await call('jobs', { method: 'POST', headers, body: { ...base, submissionId: 'invalid id' } })).status, 400);
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
  assert.equal((await call('admin/reset', { method: 'POST', headers: { ...json, authorization: `Bearer ${env.LIVE_WORKER_TOKEN}` }, body: { confirmed: true } })).status, 401);
  assert.equal((await call('admin/reset', { method: 'POST', headers: json, body: { confirmed: true } })).status, 401);
});
test('authorized admin reset requires confirmation and hides archived jobs from both views', async () => {
  const call = fixture();
  const participant = await call('state');
  const cookie = participant.headers['Set-Cookie'].split(';')[0];
  const post = { method: 'POST', headers: { cookie, origin: 'https://demo.test', 'content-type': 'application/json' },
    body: { red: 6, yellow: 3, blue: 1, name: 'Alex', submissionId: 'phone-submit-0001' } };
  await call('jobs', post);
  const adminHeaders = { authorization: `Bearer ${env.LIVE_ADMIN_TOKEN}`, 'content-type': 'application/json' };
  assert.equal((await call('admin/reset', { method: 'POST', headers: adminHeaders, body: {} })).status, 409);
  const reset = await call('admin/reset', { method: 'POST', headers: adminHeaders, body: { confirmed: true, queueRevision: 0 } });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.queueRevision, 1);
  assert.deepEqual(reset.body.jobs, []);
  assert.equal((await call('state', { headers: { cookie } })).body.ownJob, null);
});
test('replayed reset after a lost response cannot archive jobs submitted under the new revision', async () => {
  const call = fixture();
  const participant = await call('state');
  const cookie = participant.headers['Set-Cookie'].split(';')[0];
  const participantHeaders = { cookie, origin: 'https://demo.test', 'content-type': 'application/json' };
  const submit = submissionId => call('jobs', { method: 'POST', headers: participantHeaders,
    body: { red: 6, yellow: 3, blue: 1, name: 'Alex', submissionId } });
  await submit('phone-submit-0001');
  const adminHeaders = { authorization: `Bearer ${env.LIVE_ADMIN_TOKEN}`, 'content-type': 'application/json' };
  const replayedRequest = { method: 'POST', headers: adminHeaders, body: { confirmed: true, queueRevision: 0 } };
  assert.equal((await call('admin/reset', replayedRequest)).status, 200);
  const later = await submit('phone-submit-0002');
  assert.equal(later.body.queueRevision, 1);
  const replay = await call('admin/reset', replayedRequest);
  assert.equal(replay.status, 409);
  assert.match(replay.body.error, /queue changed/i);
  const current = await call('state', { headers: { cookie } });
  assert.equal(current.body.queueRevision, 1);
  assert.equal(current.body.jobs.length, 1);
  assert.equal(current.body.jobs[0].id, later.body.ownJob.id);
});
test('nested Vercel function entrypoints reach the shared admin and worker routes', async () => {
  let state = initialState('talk', 'simulation');
  const store = { read: async () => state, mutate: async fn => {
    const next = structuredClone(state), result = fn(next); state = next; return { state, result };
  } };
  const makeCall = handler => async (path, { method = 'GET', headers = {}, body } = {}) => {
    const responseHeaders = {};
    const res = { setHeader: (key, value) => { responseHeaders[key] = value; },
      end(value) { this.body = JSON.parse(value); } };
    await handler({ url: path, method, headers: { host: 'demo.test', ...headers }, body }, res);
    return { status: res.statusCode, body: res.body, headers: responseHeaders };
  };
  assert.equal(typeof workerEntrypoint, 'function');
  assert.equal(typeof adminEntrypoint, 'function');
  const adminCall = makeCall(createAdminHandler({ env, storeFactory: () => store }));
  const workerCall = makeCall(createWorkerHandler({ env, storeFactory: () => store }));
  const admin = await adminCall('/api/live/admin/state', {
    headers: { authorization: `Bearer ${env.LIVE_ADMIN_TOKEN}` },
  });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.eventId, 'talk');
  const heartbeat = await workerCall('/api/live/worker/heartbeat', { method: 'POST',
    headers: { authorization: `Bearer ${env.LIVE_WORKER_TOKEN}`, 'content-type': 'application/json' },
    body: { workerId: 'worker_1234567890123456', mode: 'simulation' },
  });
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.body.eventId, 'talk');
});
test('storage failures return actionable codes without exposing upstream details or credentials', async t => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const privateDetail = 'do-not-expose-this-database-detail';
  const settings = { ...env, SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: '  sb_secret_private-test-key\n',
    LIVE_EVENT_ID: 'talk', LIVE_EXECUTION_MODE: 'simulation' };
  for (const [status, sourceCode, expected] of [[401, null, 'QUEUE_AUTH_FAILED'], [403, '42501', 'QUEUE_ACCESS_DENIED'],
    [404, 'PGRST205', 'QUEUE_SCHEMA_MISSING'], [500, null, 'QUEUE_STORAGE_UNAVAILABLE']]) {
    const store = new SupabaseStore(settings, async (_url, options) => {
      assert.equal(options.headers.apikey, settings.SUPABASE_SECRET_KEY.trim());
      return Response.json({ code: sourceCode, message: privateDetail }, { status });
    });
    const handler = createHandler({ env: settings, storeFactory: () => store });
    const res = { setHeader() {}, end(value) { this.body = value; } };
    await handler({ url: '/api/live/state', method: 'GET', headers: { host: 'demo.test' } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).code, expected);
    assert(!res.body.includes(privateDetail));
    assert(!res.body.includes('sb_secret_'));
  }
  assert(!JSON.stringify(logs).includes(privateDetail));
  assert(!JSON.stringify(logs).includes('sb_secret_'));
});
