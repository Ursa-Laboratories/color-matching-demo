import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, publicState, transition } from '../live/queue.js';
import { makeRecipe } from '../shared/recipe.js';
import { SupabaseStore } from '../live/store.js';

const recipe = { red: 6, yellow: 3, blue: 1, name: 'Alex' };
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
  for (const bad of [{ ...recipe, red: 0, yellow: 0, blue: 0 }, { ...recipe, red: 11 }, { ...recipe, red: '6' }, { ...recipe, red: NaN }, { ...recipe, blue: 1.5 }])
    assert.throws(() => act('submit', bad));
});
test('retries return the same saved recipe even after submissions close', () => {
  const { act, state } = fixture(), job = act('submit', recipe);
  act('accepting', { accepting: false });
  assert.equal(act('submit', { red: 1, yellow: 1, blue: 1 }).id, job.id);
  assert.equal(state.jobs.length, 1); assert.throws(() => act('submit', recipe, 'p2'));
});
test('submission IDs allow multiple jobs per cookie and deduplicate only matching retries', () => {
  const { act, state } = fixture();
  const firstId = 'event_submission_0001';
  const secondId = 'event_submission_0002';
  const first = act('submit', { ...recipe, submissionId: firstId });
  assert.equal(act('submit', { ...recipe, name: 'Changed', submissionId: firstId }).id, first.id);
  const second = act('submit', { ...recipe, submissionId: secondId });
  assert.notEqual(second.id, first.id);
  assert.equal(state.jobs.length, 2);
  assert.equal(publicState(state, 'p1', 100_000).ownJob.id, second.id);
  assert.throws(() => act('submit', { ...recipe, submissionId: 'bad id' }), error => error.status === 400);
});
test('names are required, bounded, normalized and preserved through public receipts and worker claims', () => {
  const { act, state } = fixture();
  for (const name of [undefined, null, 12, {}, '', '   ', 'a'.repeat(41), 'bad\u0000name', 'bad\u202ename'])
    assert.throws(() => act('submit', { ...recipe, name }), error => error.status === 400);
  const job = act('submit', { ...recipe, name: '  Zoe\u0308   Chen  ' });
  assert.equal(job.name, 'Zoë Chen');
  assert.equal(publicState(state, 'p1', 100_000).ownJob.name, 'Zoë Chen');
  assert.equal(publicState(state, 'p2', 100_000).jobs[0].name, 'Zoë Chen');
  assert.equal(act('submit', { ...recipe, name: 'Changed' }).name, 'Zoë Chen');
  act('heartbeat', worker); act('run');
  assert.equal(act('claim', worker).name, 'Zoë Chen');
  assert.equal(state.jobs.length, 1);
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
test('reset requires confirmation, refuses active claims, archives queue display and ignores owned late reports', () => {
  const { act, state, job } = running();
  assert.throws(() => act('reset', { confirmed: true, queueRevision: 0 }), /active job/);
  act('progress', { ...completion(job), status: 'blocked' });
  assert.throws(() => act('reset', {}), /Confirm/);
  act('resolve', { confirmed: true });
  const next = act('submit', { ...recipe, submissionId: 'event_submission_0003' }, 'p2');
  act('reset', { confirmed: true, queueRevision: 0 });
  assert.equal(state.queueRevision, 1);
  assert.equal(state.draining, false);
  assert.deepEqual(state.jobs.map(item => item.status), ['cancelled', 'cancelled']);
  assert(state.jobs.every(item => item.archivedAt === 100_000));
  assert.deepEqual(publicState(state, 'p1', 100_000).jobs, []);
  assert.equal(publicState(state, 'p1', 100_000).ownJob, null);
  assert.equal(act('progress', { ...completion(job), status: 'completed' }).status, 'cancelled');
  assert.throws(() => act('progress', { ...completion(job), workerId: 'b'.repeat(32) }));
  assert.equal(state.jobs.find(item => item.id === next.id).status, 'cancelled');
});
test('older persisted state defaults queue revision and treats unmarked jobs as visible', () => {
  const state = initialState('talk', 'hardware');
  delete state.queueRevision;
  state.jobs.push({ id: 'legacy', number: 1, participantId: 'p1', name: 'Alex', status: 'completed',
    createdAt: 1, well: 'plate.A1', runId: 'old-run' });
  assert.equal(publicState(state, 'p1', 100_000).queueRevision, 0);
  assert.equal(publicState(state, 'p1', 100_000).ownJob.id, 'legacy');
  transition(state, 'reset', { confirmed: true, queueRevision: 0 }, { now: 2, participantId: null, ipHash: 'venue' });
  assert.equal(state.queueRevision, 1);
  assert.equal(state.jobs[0].runId, 'old-run');
  assert.deepEqual(publicState(state, 'p1', 100_000).jobs, []);
});
test('reset and worker claim races resolve through compare-and-set without claiming archived work', async () => {
  let record = { revision: 1, state: initialState('talk', 'hardware') };
  const seed = record.state;
  seed.worker = { id: worker.workerId, mode: worker.mode, lastSeen: 100_000 };
  seed.jobs.push({ id: 'queued', number: 1, participantId: 'p1', name: 'Alex', recipe: {}, status: 'ready',
    createdAt: 1, well: null, runId: null });
  seed.draining = true;
  let initialReads = 0, releaseReads;
  const readsReady = new Promise(resolve => { releaseReads = resolve; });
  const fetcher = async (url, options) => {
    if (options.method === 'GET') {
      const snapshot = structuredClone(record);
      if (initialReads < 2) { initialReads++; if (initialReads === 2) releaseReads(); await readsReady; }
      return Response.json([snapshot]);
    }
    const input = JSON.parse(options.body);
    if (input.expected_revision !== record.revision) return Response.json(false);
    record = { revision: record.revision + 1, state: input.next_state };
    return Response.json(true);
  };
  const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test', LIVE_EVENT_ID: 'talk', LIVE_EXECUTION_MODE: 'hardware' };
  const stores = [new SupabaseStore(env, fetcher), new SupabaseStore(env, fetcher)];
  const results = await Promise.allSettled([
    stores[0].mutate(state => transition(state, 'claim', worker, { now: 100_000, participantId: null, ipHash: 'venue' })),
    stores[1].mutate(state => transition(state, 'reset', { confirmed: true, queueRevision: 0 }, { now: 100_000, participantId: null, ipHash: 'venue' })),
  ]);
  const current = await stores[0].read();
  if (current.activeId) {
    assert(results.some(result => result.status === 'rejected'));
  } else {
    assert.equal(current.queueRevision, 1);
    assert.equal(current.jobs[0].archivedAt, 100_000);
  }
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
