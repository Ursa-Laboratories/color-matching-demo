import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, publicState, transition } from '../live/queue.js';
import { makeRecipe } from '../shared/recipe.js';
import { SupabaseStore } from '../live/store.js';

const recipe = { red: 6, yellow: 3, blue: 1 };
const worker = { workerId: 'a'.repeat(32), mode: 'hardware' };
function fixture() {
  let now = 100_000;
  const state = initialState('talk', 'hardware');
  const act = (action, body = {}, participantId = 'p1') => transition(state, action, body, { now, participantId, ipHash: 'venue' });
  return { state, act, advance: n => { now += n; } };
}
function running() {
  const f = fixture(), job = f.act('submit', recipe);
  f.act('heartbeat', worker); f.act('run'); f.act('claim', worker);
  return { ...f, job };
}
const completion = job => ({ ...worker, jobId: job.id, status: 'completed', well: 'plate.A1', runId: 'live-' + job.id });

test('all slider combinations produce exactly 150 uL in 5 uL increments', () => {
  for (let red = 0; red <= 10; red++) for (let yellow = 0; yellow <= 10; yellow++) for (let blue = 0; blue <= 10; blue++) {
    if (red + yellow + blue === 0) continue;
    const result = makeRecipe({ red, yellow, blue });
    assert.equal(Object.values(result.volumes).reduce((a, b) => a + b, 0), 150);
    for (const [name, value] of Object.entries(result.volumes)) {
      assert.equal(value % 5, 0); assert(value >= 0);
      if (!result.parts[name]) assert.equal(value, 0);
    }
  }
  assert.deepEqual(makeRecipe(recipe).volumes, { red: 90, yellow: 45, blue: 15 });
});
test('invalid/empty recipes and noninteger parts are rejected server-side', () => {
  const { act } = fixture();
  for (const bad of [{ red: 0, yellow: 0, blue: 0 }, { ...recipe, red: 11 }, { ...recipe, red: '6' }, { ...recipe, red: NaN }, { ...recipe, blue: 1.5 }])
    assert.throws(() => act('submit', bad));
});
test('retries return the same saved recipe even after submissions close', () => {
  const { act, state } = fixture(), job = act('submit', recipe);
  act('accepting', { accepting: false });
  assert.equal(act('submit', { red: 1, yellow: 1, blue: 1 }).id, job.id);
  assert.equal(state.jobs.length, 1); assert.throws(() => act('submit', recipe, 'p2'));
});
test('Run snapshots only waiting jobs; new arrivals wait for the next Run', () => {
  const { act, state } = fixture(), first = act('submit', recipe);
  assert.equal(act('claim', worker), null);
  act('run'); const later = act('submit', recipe, 'p2');
  assert.equal(act('claim', worker).id, first.id);
  act('progress', completion(first));
  assert.equal(act('claim', worker), null);
  assert.equal(later.status, 'queued'); assert.equal(state.draining, false);
});
test('stale claims never transfer to another worker or start a second job', () => {
  const { act, advance, job } = running(); advance(90_000);
  assert.throws(() => act('claim', { ...worker, workerId: 'b'.repeat(32) }));
  assert.equal(act('claim', worker).id, job.id);
});
test('Pause holds later jobs while the current well finishes', () => {
  const { act, state } = fixture();
  act('submit', recipe); act('submit', recipe, 'p2'); act('heartbeat', worker); act('run'); act('claim', worker); act('pause');
  assert.deepEqual(state.jobs.map(j => j.status), ['running', 'queued']); assert.throws(() => act('run'));
});
test('completed reports require the same well/run, are idempotent, and cannot be overwritten', () => {
  const { act, job } = running();
  assert.throws(() => act('progress', { ...worker, jobId: job.id, status: 'completed' }));
  const done = completion(job);
  act('progress', { ...done, status: 'running' });
  assert.throws(() => act('progress', { ...done, well: 'plate.B1' }));
  act('progress', done); act('progress', done);
  assert.throws(() => act('progress', { ...done, status: 'running' }));
});
test('blocked jobs require physical review; public data hides identity and diagnostic details', () => {
  const { act, state, job } = running();
  act('progress', { ...worker, jobId: job.id, status: 'blocked', message: 'local detail' });
  assert.throws(() => act('claim', worker)); assert.throws(() => act('run'));
  const view = publicState(state, 'p1', 100_000);
  assert.equal(view.ownJob.id, job.id);
  assert.equal(view.jobs[0].participantId, undefined); assert.equal(view.jobs[0].message, undefined);
  assert.throws(() => act('resolve', {})); act('resolve', { confirmed: true }); assert.equal(state.activeId, null);
});
test('wrong execution mode and concurrent workers cannot take ownership', () => {
  const { act } = fixture(); act('heartbeat', worker);
  assert.throws(() => act('claim', { ...worker, mode: 'simulation' }));
  assert.throws(() => act('claim', { ...worker, workerId: 'b'.repeat(32) }));
});
test('offline active job retirement needs explicit review', () => {
  const { act, advance, state } = running();
  assert.throws(() => act('resolve', { confirmed: true })); advance(31_000);
  assert.throws(() => act('resolve', {})); act('resolve', { confirmed: true }); assert.equal(state.activeId, null);
});
test('a delayed worker report after retirement is acknowledged without reviving the job', () => {
  const { act, advance, state, job } = running();
  const next = act('submit', recipe, 'p2');
  advance(31_000); act('resolve', { confirmed: true });
  for (const status of ['running', 'completed', 'blocked']) {
    assert.equal(act('progress', { ...completion(job), status }).status, 'cancelled');
    assert.equal(state.activeId, null);
  }
  assert.throws(() => act('progress', { ...completion(job), workerId: 'b'.repeat(32) }));
  act('heartbeat', worker); act('run');
  assert.equal(act('claim', worker).id, next.id);
});
test('Supabase compare-and-set preserves concurrent submissions across independent instances', async () => {
  let record = null;
  const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test', LIVE_EVENT_ID: 'talk', LIVE_EXECUTION_MODE: 'hardware' };
  const fetcher = async (url, options) => {
    assert.equal(options.headers.apikey, env.SUPABASE_SECRET_KEY);
    assert.equal(options.headers.Authorization, undefined);
    if (options.method === 'GET') {
      assert.equal(new URL(url).searchParams.get('id'), 'eq.mixtures-v2:talk');
      return Response.json(record ? [record] : []);
    }
    assert.equal(new URL(url).pathname, '/rest/v1/rpc/ursa_live_compare_and_set');
    const body = JSON.parse(options.body);
    if (body.expected_revision !== (record?.revision ?? 0)) return Response.json(false);
    record = { revision: (record?.revision ?? 0) + 1, state: body.next_state };
    return Response.json(true);
  };
  const stores = Array.from({ length: 10 }, () => new SupabaseStore(env, fetcher));
  await Promise.all(stores.map((store, i) => store.mutate(state => transition(state, 'submit', recipe, { now: 1, participantId: `p${i}`, ipHash: 'venue' }))));
  const state = await stores[0].read(); assert.equal(state.jobs.length, 10); assert.equal(new Set(state.jobs.map(j => j.number)).size, 10);
});
test('legacy service-role keys use JWT authentication and storage errors fail closed', async () => {
  const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'legacy.jwt.test', LIVE_EVENT_ID: 'talk', LIVE_EXECUTION_MODE: 'hardware' };
  const store = new SupabaseStore(env, async (_url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
    return Response.json({ error: 'database credential detail' }, { status: 401 });
  });
  await assert.rejects(store.read(), /Queue storage is temporarily unavailable/);
  assert.throws(() => new SupabaseStore({}), /not configured/);
});
