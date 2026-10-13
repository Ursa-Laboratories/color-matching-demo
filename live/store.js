import { initialState, QueueError } from './queue.js';

const CAS = `local current = redis.call('GET', KEYS[1]) or ''
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;

export class RedisStore {
  constructor(env = process.env) {
    this.url = env.UPSTASH_REDIS_REST_URL;
    this.token = env.UPSTASH_REDIS_REST_TOKEN;
    this.eventId = env.LIVE_EVENT_ID;
    this.mode = env.LIVE_EXECUTION_MODE;
    if (!this.url || !this.token || !/^[a-zA-Z0-9_-]{1,80}$/.test(this.eventId ?? '')
      || !['hardware', 'simulation'].includes(this.mode))
      throw new QueueError('Live demo storage is not configured.', 503);
    this.key = `ursa:live:mixtures:v2:${this.eventId}`;
  }
  async command(command) {
    const response = await fetch(this.url, { method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new QueueError('Queue storage is temporarily unavailable.', 503);
    const result = await response.json();
    if (result.error) throw new QueueError('Queue storage rejected the request.', 503);
    return result.result;
  }
  decode(raw) {
    const state = raw ? JSON.parse(raw) : initialState(this.eventId, this.mode);
    if (state.version !== 2 || state.mode !== this.mode) throw new QueueError('Use a new event ID when changing execution mode.', 503);
    return state;
  }
  async read() { return this.decode(await this.command(['GET', this.key])); }
  async mutate(update) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const raw = await this.command(['GET', this.key]);
      const state = this.decode(raw);
      const result = update(state);
      if (await this.command(['EVAL', CAS, '1', this.key, raw ?? '', JSON.stringify(state)]))
        return { state, result };
    }
    throw new QueueError('The queue is busy. Please retry.', 503);
  }
}
