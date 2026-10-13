import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createHandler } from '../live/http.js';
import { initialState, transition } from '../live/queue.js';
import { LocalPhotoStore, normalizePhoto, PHOTO_BUCKET, PHOTO_MAX_BYTES, SupabasePhotoStore } from '../live/photos.js';

const env = { LIVE_ADMIN_TOKEN: 'admin'.repeat(8), LIVE_WORKER_TOKEN: 'worker'.repeat(8), LIVE_SESSION_SECRET: 'session'.repeat(8) };
const jsonHeaders = { 'content-type': 'application/json', origin: 'https://demo.test' };
const auth = { authorization: `Bearer ${env.LIVE_ADMIN_TOKEN}`, ...jsonHeaders };
const workerAuth = { authorization: `Bearer ${env.LIVE_WORKER_TOKEN}`, ...jsonHeaders };
async function jpeg(width = 32, height = 24) {
  return sharp({ create: { width, height, channels: 3, background: { r: 40, g: 125, b: 210 } } }).jpeg().toBuffer();
}
const dataUrl = bytes => `data:image/jpeg;base64,${bytes.toString('base64')}`;
function completedState(count = 2, queueRevision = 7) {
  const state = initialState('photo-event', 'simulation');
  state.queueRevision = queueRevision;
  state.jobs = Array.from({ length: count }, (_, index) => ({ id: randomUUID(), number: index + 1,
    participantId: `p${index}`, name: `Guest ${index + 1}`, recipe: {}, status: 'completed', createdAt: 1,
    completedAt: 2, well: `plate.A${index + 1}`, runId: `run-${index + 1}` }));
  return state;
}
function photoFixture({ state = completedState(), photoStore = { async put() {}, async get() { throw new Error('unexpected photo read'); } }, now = () => 100_000 } = {}) {
  let current = structuredClone(state);
  const store = {
    read: async () => structuredClone(current),
    mutate: async update => {
      const next = structuredClone(current), result = update(next); current = next; return { state: current, result };
    },
  };
  const handler = createHandler({ env, storeFactory: () => store, photoStoreFactory: () => photoStore, now });
  const call = async (url, { method = 'GET', headers = {}, body } = {}) => {
    const responseHeaders = {};
    const res = { setHeader(key, value) { responseHeaders[key] = value; }, end(value) { this.raw = value; } };
    await handler({ url: `/api/live/${url}`, method, headers: { host: 'demo.test', ...headers }, body }, res);
    const contentType = responseHeaders['Content-Type'];
    const resultBody = contentType === 'image/jpeg' ? res.raw : JSON.parse(res.raw);
    return { status: res.statusCode, body: resultBody, headers: responseHeaders };
  };
  return { call, readState: () => structuredClone(current), store, handler };
}

test('normalization rejects non-JPEG and malformed input, strips metadata, and bounds output dimensions', async () => {
  const good = await jpeg(1800, 900);
  const normalized = await normalizePhoto(dataUrl(good), 'photo-event');
  const metadata = await sharp(normalized.bytes).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, 1600);
  assert.equal(metadata.height, 800);
  assert.equal(metadata.exif, undefined);
  await assert.rejects(normalizePhoto('data:image/png;base64,AAAA', 'photo-event'), error => error.status === 400);
  await assert.rejects(normalizePhoto(dataUrl(Buffer.from('not a jpeg')), 'photo-event'), error => error.status === 400);
  await assert.rejects(normalizePhoto(dataUrl(Buffer.alloc(PHOTO_MAX_BYTES + 1)), 'photo-event'), error => error.status === 413);
});

test('authorized upload normalizes once and attaches one private photo to several completed jobs', async () => {
  const state = completedState();
  const saved = new Map();
  const photoStore = { async put(eventId, id, bytes) { saved.set(`${eventId}/${id}`, Buffer.from(bytes)); },
    async get(eventId, id) { return saved.get(`${eventId}/${id}`); } };
  let clock = 100_000;
  const { call } = photoFixture({ state, photoStore, now: () => clock });
  const source = await jpeg(80, 60);
  const uploaded = await call('admin/photos', { method: 'POST', headers: auth,
    body: { jobIds: state.jobs.map(job => job.id), queueRevision: 7, image: dataUrl(source) } });
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.jobs.length, 2);
  const first = uploaded.body.jobs[0].resultPhoto, second = uploaded.body.jobs[1].resultPhoto;
  assert.equal(first.id, second.id);
  assert.match(first.url, /^\/api\/live\/photos\/[a-f0-9]{64}$/);
  assert.deepEqual(first.wellLabels, ['plate.A1', 'plate.A2']);
  assert.equal(Object.hasOwn(first, 'storagePath'), false);
  assert.equal(JSON.stringify(uploaded.body).includes('base64,'), false);
  assert.equal(saved.size, 1);
  clock += 10_000;
  const retry = await call('admin/photos', { method: 'POST', headers: auth,
    body: { jobIds: state.jobs.map(job => job.id), queueRevision: 7, image: dataUrl(source) } });
  assert.deepEqual(retry.body.jobs.map(job => job.resultPhoto), uploaded.body.jobs.map(job => job.resultPhoto));
  const served = await call(`photos/${first.id}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers['Content-Type'], 'image/jpeg');
  assert.equal(served.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(served.headers['Cache-Control'], 'no-store');
  assert.deepEqual(served.body, saved.get(`photo-event/${first.id}`));
});

test('admin authorization precedes photo JSON parsing and worker/public uploads are rejected', async () => {
  const { call } = photoFixture();
  assert.equal((await call('admin/photos', { method: 'POST', headers: jsonHeaders, body: '{' })).status, 401);
  assert.equal((await call('admin/photos', { method: 'POST', headers: workerAuth, body: '{' })).status, 401);
  assert.equal((await call('admin/photos', { method: 'POST', headers: auth, body: '{' })).status, 400);
});

test('upload rejects stale revisions, invalid selections, noncompleted jobs, and oversized JSON without storage writes', async () => {
  const state = completedState(1);
  state.jobs.push({ id: randomUUID(), number: 2, participantId: 'p2', name: 'Waiting', recipe: {}, status: 'running', well: null });
  let puts = 0;
  const { call } = photoFixture({ state, photoStore: { async put() { puts++; }, async get() {} } });
  const image = dataUrl(await jpeg());
  const base = { jobIds: [state.jobs[0].id], queueRevision: 7, image };
  assert.equal((await call('admin/photos', { method: 'POST', headers: auth, body: { ...base, queueRevision: 6 } })).status, 409);
  assert.equal((await call('admin/photos', { method: 'POST', headers: auth, body: { ...base, jobIds: [state.jobs[1].id] } })).status, 409);
  assert.equal((await call('admin/photos', { method: 'POST', headers: auth, body: { ...base, jobIds: [state.jobs[0].id, state.jobs[0].id] } })).status, 400);
  const huge = { ...base, image: dataUrl(Buffer.alloc(1_130_000)) };
  assert.equal((await call('admin/photos', { method: 'POST', headers: auth, body: huge })).status, 413);
  assert.equal(puts, 0);
});

test('storage failure and reset race leave no visible photo attachment', async () => {
  const state = completedState(1);
  const failing = photoFixture({ state, photoStore: { async put() { throw new Error('storage down'); }, async get() {} } });
  const body = { jobIds: [state.jobs[0].id], queueRevision: 7, image: dataUrl(await jpeg()) };
  assert.equal((await failing.call('admin/photos', { method: 'POST', headers: auth, body })).status, 503);
  assert.equal(failing.readState().jobs[0].resultPhoto, undefined);

  let raced;
  const photoStore = { async put() {
    await raced.store.mutate(next => transition(next, 'reset', { confirmed: true, queueRevision: 7 }, { now: 200_000 }));
  }, async get() {} };
  raced = photoFixture({ state, photoStore });
  assert.equal((await raced.call('admin/photos', { method: 'POST', headers: auth, body })).status, 409);
  assert.equal(raced.readState().queueRevision, 8);
  assert.equal(raced.readState().jobs[0].resultPhoto, undefined);
});

test('photo retrieval requires a visible completed-job reference and archival hides the bytes', async () => {
  const state = completedState(1);
  const bytes = await jpeg();
  const stored = new Map();
  const photoStore = { async put(eventId, id, data) { stored.set(`${eventId}/${id}`, Buffer.from(data)); },
    async get(eventId, id) { const photo = stored.get(`${eventId}/${id}`); if (!photo) { const error = new Error(); error.status = 404; throw error; } return photo; } };
  const { call, store } = photoFixture({ state, photoStore });
  const upload = await call('admin/photos', { method: 'POST', headers: auth,
    body: { jobIds: [state.jobs[0].id], queueRevision: 7, image: dataUrl(bytes) } });
  const id = upload.body.jobs[0].resultPhoto.id;
  assert.equal((await call('photos/%2e%2e%2fadmin')).status, 404);
  assert.equal((await call(`photos/${'a'.repeat(64)}`)).status, 404);
  assert.equal((await call(`photos/${id}`)).status, 200);
  await store.mutate(next => transition(next, 'reset', { confirmed: true, queueRevision: 7 }, { now: 200_000 }));
  assert.equal((await call(`photos/${id}`)).status, 404);
});

test('empty incoming streams work for state and binary photo GET requests', async () => {
  const state = completedState(1);
  const id = 'b'.repeat(64), bytes = await jpeg();
  state.jobs[0].resultPhoto = { id, width: 32, height: 24, uploadedAt: new Date(100_000).toISOString(), wellLabels: [state.jobs[0].well] };
  const { handler } = photoFixture({ state, photoStore: { async put() {}, async get() { return bytes; } } });
  const request = async url => {
    const responseHeaders = {};
    const res = { setHeader(key, value) { responseHeaders[key] = value; }, end(value) { this.raw = value; } };
    const req = { url: `/api/live/${url}`, method: 'GET', headers: { host: 'demo.test' }, async *[Symbol.asyncIterator]() {} };
    await handler(req, res);
    return { status: res.statusCode, body: responseHeaders['Content-Type'] === 'image/jpeg' ? res.raw : JSON.parse(res.raw), headers: responseHeaders };
  };
  const stateResponse = await request('state');
  assert.equal(stateResponse.status, 200);
  assert.equal(stateResponse.body.jobs.length, 1);
  const photoResponse = await request(`photos/${id}`);
  assert.equal(photoResponse.status, 200);
  assert.deepEqual(photoResponse.body, bytes);
});

test('local photo storage persists private event-scoped files with restrictive permissions', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ursa-photo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const photos = new LocalPhotoStore(dir);
  const bytes = await jpeg();
  const { id } = await normalizePhoto(dataUrl(bytes), 'photo-event');
  const normalized = await normalizePhoto(dataUrl(bytes), 'photo-event');
  await photos.put('photo-event', id, normalized.bytes);
  await photos.put('photo-event', id, normalized.bytes);
  const target = path.join(dir, 'photos', 'photo-event', `${id}.jpg`);
  assert.deepEqual(await photos.get('photo-event', id), normalized.bytes);
  assert.deepEqual(await readFile(target), normalized.bytes);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(target))).mode & 0o777, 0o700);
});

test('Supabase photo storage creates a private restricted bucket lazily, deduplicates objects, and uses legacy bearer auth', async () => {
  let requests = 0, uploads = 0, created, bucketRecord;
  const token = 'legacy.service.role.jwt';
  const store = new SupabasePhotoStore({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: token }, async (url, options) => {
    requests++;
    assert.equal(options.headers.apikey, token);
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    if (url.endsWith(`/bucket/${PHOTO_BUCKET}`) && options.method === 'GET')
      return bucketRecord ? Response.json(bucketRecord) : new Response('{}', { status: 404 });
    if (url.endsWith('/bucket') && options.method === 'POST') {
      created = JSON.parse(options.body);
      bucketRecord = { ...created };
      return Response.json({ name: PHOTO_BUCKET });
    }
    assert.match(url, new RegExp(`/object/${PHOTO_BUCKET}/photo-event/[a-f0-9]{64}\\.jpg$`));
    assert.equal(options.headers['Content-Type'], 'image/jpeg');
    uploads++;
    if (uploads > 1) return Response.json({ statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }, { status: 400 });
    return Response.json({ Key: 'private/path' });
  });
  const id = 'f'.repeat(64);
  assert.equal(requests, 0);
  await store.put('photo-event', id, await jpeg());
  assert.deepEqual(created, { id: PHOTO_BUCKET, name: PHOTO_BUCKET, public: false,
    allowed_mime_types: ['image/jpeg'], file_size_limit: PHOTO_MAX_BYTES });
  await store.put('photo-event', id, await jpeg());
  assert.equal(uploads, 2);
});

test('Supabase photo storage fails closed for an existing public bucket', async () => {
  let uploads = 0;
  const store = new SupabasePhotoStore({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_private-test-key' }, async url => {
    if (url.endsWith(`/bucket/${PHOTO_BUCKET}`)) return Response.json({ id: PHOTO_BUCKET, public: true });
    uploads++;
    return Response.json({});
  });
  await assert.rejects(store.put('photo-event', 'a'.repeat(64), await jpeg()), error => error.status === 503);
  assert.equal(uploads, 0);
});

test('Supabase photo storage treats only explicit not-found bucket errors as absent', async () => {
  const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_private-test-key' };
  let calls = 0, created = false;
  const missing = new SupabasePhotoStore(env, async url => {
    calls++;
    if (url.endsWith(`/bucket/${PHOTO_BUCKET}`)) return created ? Response.json({ public: false }) : Response.json({ code: 'NotFound' }, { status: 400 });
    if (url.endsWith('/bucket')) { created = true; return Response.json({ name: PHOTO_BUCKET }); }
    return Response.json({});
  });
  await missing.put('photo-event', 'c'.repeat(64), await jpeg());
  assert.equal(calls, 4);

  const genericBadRequest = new SupabasePhotoStore(env, async () => Response.json({ code: 'InvalidRequest' }, { status: 400 }));
  await assert.rejects(genericBadRequest.put('photo-event', 'd'.repeat(64), await jpeg()), error => error.status === 503);
});
