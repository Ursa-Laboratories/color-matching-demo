import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { QueueError, publicJob, publicState, transition } from './queue.js';
import { SupabaseStore } from './store.js';

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

export function createHandler({ env = process.env, storeFactory = () => new SupabaseStore(env), now = Date.now } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const path = new URL(req.url, 'http://localhost').pathname.replace(/^\/api\/live\//, '').replace(/\/$/, '');
      const isPost = req.method === 'POST';
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
      let body = req.body ?? {};
      if (typeof body === 'string') {
        if (Buffer.byteLength(body) > 4096) throw new QueueError('Request too large.', 413);
        try { body = JSON.parse(body); } catch { throw new QueueError('Invalid JSON.', 400); }
      }
      if (Buffer.byteLength(JSON.stringify(body)) > 4096) throw new QueueError('Request too large.', 413);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new QueueError('Expected an object.', 400);
      let result;
      if (!isPost && ['state', 'admin/state'].includes(path)) {
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
