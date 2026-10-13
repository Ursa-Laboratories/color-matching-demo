import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { QueueError, publicJob, publicState, transition } from './queue.js';
import { SupabaseStore } from './store.js';
import { normalizePhoto, PHOTO_MAX_JSON_BYTES, SupabasePhotoStore, validatePhotoRequest, visibleCompletedJobs } from './photos.js';

function equal(a, b) {
  const left = Buffer.from(a ?? ''), right = Buffer.from(b ?? '');
  return left.length === right.length && timingSafeEqual(left, right);
}
function secret(env, key) {
  if (!env[key] || env[key].length < 32) throw new QueueError('Live demo authentication is not configured.', 503);
  return env[key];
}
function authorize(req, env, role) {
  const expected = secret(env, role === 'admin' ? 'LIVE_ADMIN_TOKEN' : 'LIVE_WORKER_TOKEN');
  if (!equal(req.headers.authorization, `Bearer ${expected}`)) throw new QueueError('Access denied.', 401);
}
function session(req, res, env) {
  const key = secret(env, 'LIVE_SESSION_SECRET');
  const sign = id => createHmac('sha256', key).update(id).digest('hex');
  const cookie = (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith('ursa_participant='));
  const [id, signature] = (cookie?.slice(17) ?? '').split('.');
  if (id && /^[a-f0-9-]{36}$/.test(id) && equal(signature, sign(id))) return id;
  const next = randomUUID();
  res.setHeader('Set-Cookie', `ursa_participant=${next}.${sign(next)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${env.VERCEL ? '; Secure' : ''}`);
  return next;
}

async function requestBody(req, limit) {
  if (req.body !== undefined) {
    if (req.body === '' || (Buffer.isBuffer(req.body) && req.body.length === 0)) return {};
    return req.body;
  }
  if (!req[Symbol.asyncIterator]) return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new QueueError('Request too large.', 413);
    chunks.push(Buffer.from(chunk));
  }
  return size ? Buffer.concat(chunks).toString('utf8') : {};
}

export function createHandler({ env = process.env, storeFactory = () => new SupabaseStore(env),
  photoStoreFactory = () => new SupabasePhotoStore(env), now = Date.now } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const path = new URL(req.url, 'http://localhost').pathname.replace(/^\/api\/live\//, '').replace(/\/$/, '');
      const isPost = req.method === 'POST';
      const photoUpload = path === 'admin/photos';
      const photoId = /^photos\/([a-f0-9]{64})$/.exec(path)?.[1];
      if (req.method !== 'GET' && !isPost) throw new QueueError('Method not allowed.', 405);
      if (isPost) {
        const origin = req.headers.origin;
        if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && new URL(origin).host !== req.headers.host))
          throw new QueueError('Cross-origin request blocked.', 403);
        if (!req.headers['content-type']?.startsWith('application/json')) throw new QueueError('JSON required.', 415);
      }
      const role = path.startsWith('admin/') ? 'admin' : path.startsWith('worker/') ? 'worker' : null;
      if (role) authorize(req, env, role);
      const participantId = role ? null : session(req, res, env);
      const store = storeFactory();
      const bodyLimit = photoUpload ? PHOTO_MAX_JSON_BYTES : 4096;
      let body = await requestBody(req, bodyLimit);
      body ??= {};
      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        const raw = Buffer.isBuffer(body) ? body.toString('utf8') : body;
        if (Buffer.byteLength(raw) > bodyLimit) throw new QueueError('Request too large.', 413);
        body = raw;
        try { body = JSON.parse(body); } catch { throw new QueueError('Invalid JSON.', 400); }
      }
      if (Buffer.byteLength(JSON.stringify(body)) > bodyLimit) throw new QueueError('Request too large.', 413);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new QueueError('Expected an object.', 400);
      let result;
      if (req.method === 'GET' && path.startsWith('photos/')) {
        if (!photoId) throw new QueueError('Photo not found.', 404);
        const state = await store.read();
        const referenced = state.jobs.some(job => job.archivedAt == null && job.status === 'completed'
          && typeof job.well === 'string' && job.resultPhoto?.id === photoId);
        if (!referenced) throw new QueueError('Photo not found.', 404);
        const bytes = await photoStoreFactory().get(state.eventId, photoId);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Length', String(bytes.length));
        res.statusCode = 200; res.end(bytes); return;
      } else if (photoUpload && isPost) {
        validatePhotoRequest(body);
        const before = await store.read();
        if ((before.queueRevision ?? 0) !== body.queueRevision)
          throw new QueueError('The queue changed since it was displayed. Refresh before uploading.', 409);
        visibleCompletedJobs(before, body.jobIds);
        const photo = await normalizePhoto(body.image, before.eventId);
        await photoStoreFactory().put(before.eventId, photo.id, photo.bytes);
        const uploadedAt = new Date(now()).toISOString();
        const changed = await store.mutate(state => {
          if ((state.queueRevision ?? 0) !== body.queueRevision)
            throw new QueueError('The queue changed during photo upload. Refresh before attaching it.', 409);
          const jobs = visibleCompletedJobs(state, body.jobIds);
          const wellLabels = [...new Set(jobs.map(job => job.well))];
          for (const job of jobs) {
            const previous = job.resultPhoto;
            const photoRecord = { id: photo.id, width: photo.width, height: photo.height,
              uploadedAt: previous?.id === photo.id ? previous.uploadedAt : uploadedAt, wellLabels };
            if (!previous || previous.id !== photoRecord.id || previous.width !== photoRecord.width
              || previous.height !== photoRecord.height || previous.uploadedAt !== photoRecord.uploadedAt
              || JSON.stringify(previous.wellLabels) !== JSON.stringify(wellLabels)) job.resultPhoto = photoRecord;
          }
          return jobs;
        });
        result = publicState(changed.state, participantId, now(), true);
      } else if (!isPost && ['state', 'admin/state'].includes(path)) {
        result = publicState(await store.read(), participantId, now(), role === 'admin');
      } else {
        const action = path === 'jobs' ? 'submit' : path.split('/')[1];
        const allowed = path === 'jobs' || (role === 'admin' && ['run', 'pause', 'accepting', 'cancel', 'resolve', 'reset'].includes(action))
          || (role === 'worker' && ['heartbeat', 'claim', 'progress'].includes(action));
        if (!isPost || !allowed) throw new QueueError('Not found.', 404);
        // Only the platform-supplied Vercel header is trusted for client-IP rate limiting.
        const ip = env.VERCEL ? req.headers['x-vercel-forwarded-for'] ?? 'unknown' : req.socket?.remoteAddress ?? 'local';
        const ipHash = createHmac('sha256', secret(env, 'LIVE_SESSION_SECRET')).update(String(ip)).digest('hex');
        const changed = await store.mutate(state => transition(state, action, body, { now: now(), participantId, ipHash }));
        result = role === 'worker' ? { eventId: changed.state.eventId, job: publicJob(changed.result) }
          : publicState(changed.state, participantId, now(), role === 'admin');
      }
      res.statusCode = 200; res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = error instanceof QueueError ? error.status : 503;
      res.end(JSON.stringify({ error: error instanceof QueueError ? error.message : 'The queue is temporarily unavailable. Please retry.',
        ...(error instanceof QueueError && error.code ? { code: error.code } : {}) }));
    }
  };
}
