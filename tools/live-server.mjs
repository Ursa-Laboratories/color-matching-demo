import http from 'node:http';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHandler } from '../live/http.js';
import { initialState } from '../live/queue.js';
import { LocalPhotoStore, PHOTO_MAX_JSON_BYTES } from '../live/photos.js';

if (process.env.VERCEL) throw new Error('The file store is for a single local rehearsal process only.');
const dataDir = path.resolve(process.env.LIVE_DATA_DIR ?? '.live-data');
await mkdir(dataDir, { recursive: true });
const stateFile = path.join(dataDir, 'queue.json');
const eventId = process.env.LIVE_EVENT_ID ?? 'local-rehearsal';
let state;
try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; state = initialState(eventId, 'simulation'); }
if (state.version !== 2 || state.eventId !== eventId || state.mode !== 'simulation') throw new Error('Use a separate LIVE_DATA_DIR for a new rehearsal event.');
let tail = Promise.resolve();
const store = {
  read: async () => structuredClone(state),
  mutate(update) {
    const operation = tail.then(async () => {
      const next = structuredClone(state), result = update(next);
      await writeFile(stateFile + '.tmp', JSON.stringify(next), { mode: 0o600 });
      await rename(stateFile + '.tmp', stateFile);
      state = next;
      return { state: next, result };
    });
    tail = operation.catch(() => {});
    return operation;
  },
};
const handler = createHandler({ storeFactory: () => store, photoStoreFactory: () => new LocalPhotoStore(dataDir) });
const dist = path.resolve('frontend/dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/live/')) {
      const upload = new URL(req.url, 'http://localhost').pathname === '/api/live/admin/photos';
      const bodyLimit = upload ? PHOTO_MAX_JSON_BYTES : 4096;
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > bodyLimit) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Request too large.' })); return; }
        chunks.push(Buffer.from(chunk));
      }
      req.body = size ? Buffer.concat(chunks) : undefined;
      return handler(req, res);
    }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(dist + '/')) { res.writeHead(403); res.end(); return; }
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
});
const port = Number(process.env.LIVE_PORT ?? 8787);
server.listen(port, '127.0.0.1', () => console.log(`Local rehearsal: http://127.0.0.1:${port}/?view=live`));
