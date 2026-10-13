import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { QueueError } from './queue.js';

export const PHOTO_BUCKET = 'ursa-live-photos';
export const PHOTO_MAX_BYTES = 1024 * 1024;
export const PHOTO_MAX_JSON_BYTES = 1536 * 1024;
const MAX_PIXELS = 40_000_000;
const validEventId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const authHeaders = token => ({ apikey: token,
  ...(!token.startsWith('sb_secret_') ? { Authorization: `Bearer ${token}` } : {}) });

export function validatePhotoRequest(body) {
  if (!Array.isArray(body.jobIds) || body.jobIds.length < 1 || body.jobIds.length > 96
    || body.jobIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))
    || new Set(body.jobIds).size !== body.jobIds.length)
    throw new QueueError('Select 1–96 unique completed recipes.', 400);
  if (!Number.isInteger(body.queueRevision) || body.queueRevision < 0)
    throw new QueueError('Expected the displayed queue revision.', 400);
  if (typeof body.image !== 'string' || !body.image.startsWith('data:image/jpeg;base64,'))
    throw new QueueError('Upload a JPEG image.', 400);
}

export function visibleCompletedJobs(state, jobIds) {
  const jobs = jobIds.map(id => state.jobs.find(job => job.id === id));
  if (jobs.some(job => !job || job.archivedAt != null || job.status !== 'completed' || typeof job.well !== 'string' || !job.well))
    throw new QueueError('Photos can only be attached to visible completed recipes with allocated wells.');
  return jobs;
}

export async function normalizePhoto(dataUrl, eventId) {
  if (!validEventId(eventId)) throw new QueueError('Photo storage is not configured.', 503);
  const prefix = 'data:image/jpeg;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) throw new QueueError('Upload a JPEG image.', 400);
  const encoded = dataUrl.slice(prefix.length);
  if (!encoded || encoded.length > Math.ceil(PHOTO_MAX_BYTES / 3) * 4 + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new QueueError('The JPEG image is malformed or too large.', encoded.length > Math.ceil(PHOTO_MAX_BYTES / 3) * 4 + 4 ? 413 : 400);
  const input = Buffer.from(encoded, 'base64');
  if (input.length > PHOTO_MAX_BYTES) throw new QueueError('The JPEG image must be 1 MiB or smaller.', 413);
  if (input.toString('base64') !== encoded) throw new QueueError('The JPEG image is malformed.', 400);

  let source;
  try {
    source = sharp(input, { failOn: 'error', limitInputPixels: MAX_PIXELS, sequentialRead: true });
    const meta = await source.metadata();
    if (meta.format !== 'jpeg' || !meta.width || !meta.height || meta.width * meta.height > MAX_PIXELS)
      throw new QueueError('The uploaded file is not a supported JPEG image.', 400);
    for (const quality of [82, 74, 66, 58, 50, 42, 34]) {
      const { data, info } = await sharp(input, { failOn: 'error', limitInputPixels: MAX_PIXELS, sequentialRead: true })
        .rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      if (data.length <= PHOTO_MAX_BYTES) {
        const id = createHash('sha256').update(eventId).update('\0').update(data).digest('hex');
        return { id, bytes: data, width: info.width, height: info.height };
      }
    }
    throw new QueueError('The normalized photo is too large to store.', 413);
  } catch (error) {
    if (error instanceof QueueError) throw error;
    throw new QueueError('The uploaded file is not a supported JPEG image.', 400);
  }
}

export class SupabasePhotoStore {
  constructor(env = process.env, fetcher = fetch) {
    this.url = env.SUPABASE_URL?.trim().replace(/\/$/, '');
    this.token = (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
    this.fetcher = fetcher;
    this.bucketReady = false;
    if (!this.url?.startsWith('https://') || !this.token) throw new QueueError('Photo storage is not configured.', 503);
  }
  async #request(route, { method = 'GET', body, binary = false } = {}) {
    const response = await this.fetcher(`${this.url}/storage/v1${route}`, {
      method,
      headers: { ...authHeaders(this.token), ...(binary ? { 'Content-Type': 'image/jpeg', 'x-upsert': 'false' } : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(10_000),
    });
    return response;
  }
  async #bucketRecord() {
    const response = await this.#request(`/bucket/${PHOTO_BUCKET}`);
    if (response.status === 404) return null;
    if (response.status === 400) {
      const details = await response.json().catch(() => null);
      if (['NotFound', '404'].includes(String(details?.code ?? ''))
        || ['NotFound', '404'].includes(String(details?.statusCode ?? ''))) return null;
      throw new QueueError('Photo storage is temporarily unavailable.', 503);
    }
    if (!response.ok) throw new QueueError('Photo storage is temporarily unavailable.', 503);
    return response.json().catch(() => { throw new QueueError('Photo storage returned an invalid response.', 503); });
  }
  async #ensureBucket() {
    if (this.bucketReady) return;
    let bucket = await this.#bucketRecord();
    if (!bucket) {
      const response = await this.#request('/bucket', { method: 'POST', body: JSON.stringify({ id: PHOTO_BUCKET,
        name: PHOTO_BUCKET, public: false, allowed_mime_types: ['image/jpeg'], file_size_limit: PHOTO_MAX_BYTES }) });
      if (response.ok) {
        // Supabase returns only {name} from createBucket. Read the actual record
        // before trusting its visibility because the bucket may predate this call.
        await response.json().catch(() => null);
        bucket = await this.#bucketRecord();
      } else if (response.status === 409) bucket = await this.#bucketRecord();
      else if (response.status === 400) {
        const details = await response.json().catch(() => null);
        const duplicate = /already exists|duplicate/i.test(`${details?.message ?? ''} ${details?.error ?? ''} ${details?.code ?? ''}`);
        if (duplicate) bucket = await this.#bucketRecord();
        else throw new QueueError('Photo storage is temporarily unavailable.', 503);
      } else throw new QueueError('Photo storage is temporarily unavailable.', 503);
      if (!bucket) throw new QueueError('Photo storage is temporarily unavailable.', 503);
    }
    if (bucket.public !== false) throw new QueueError('Photo storage bucket must be private.', 503);
    this.bucketReady = true;
  }
  #objectPath(eventId, id) {
    if (!validEventId(eventId) || !/^[a-f0-9]{64}$/.test(id)) throw new QueueError('Invalid photo identity.', 400);
    return `${eventId}/${id}.jpg`;
  }
  async put(eventId, id, bytes) {
    await this.#ensureBucket();
    const response = await this.#request(`/object/${PHOTO_BUCKET}/${this.#objectPath(eventId, id)}`, { method: 'POST', body: bytes, binary: true });
    if (response.ok) return;
    const details = await response.json().catch(() => null);
    const duplicate = [400, 409].includes(response.status)
      && /already exists|duplicate|asset exists/i.test(`${details?.message ?? ''} ${details?.error ?? ''} ${details?.statusCode ?? ''}`);
    if (duplicate) return;
    console.error('Photo storage upload failed', { status: response.status });
    throw new QueueError('Photo storage is temporarily unavailable.', 503);
  }
  async get(eventId, id) {
    const response = await this.#request(`/object/authenticated/${PHOTO_BUCKET}/${this.#objectPath(eventId, id)}`);
    if (response.status === 404) throw new QueueError('Photo not found.', 404);
    if (!response.ok) throw new QueueError('Photo storage is temporarily unavailable.', 503);
    return Buffer.from(await response.arrayBuffer());
  }
}

export class LocalPhotoStore {
  constructor(dataDir = process.env.LIVE_DATA_DIR ?? '.live-data') {
    this.root = path.resolve(dataDir, 'photos');
  }
  #file(eventId, id) {
    if (!validEventId(eventId) || !/^[a-f0-9]{64}$/.test(id)) throw new QueueError('Invalid photo identity.', 400);
    return path.join(this.root, eventId, `${id}.jpg`);
  }
  async put(eventId, id, bytes) {
    const file = this.#file(eventId, id);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw new QueueError('Local photo storage is unavailable.', 503); }
  }
  async get(eventId, id) {
    try { return await readFile(this.#file(eventId, id)); }
    catch (error) {
      if (error.code === 'ENOENT') throw new QueueError('Photo not found.', 404);
      throw new QueueError('Local photo storage is unavailable.', 503);
    }
  }
}
