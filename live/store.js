import { initialState, QueueError } from './queue.js';

export class SupabaseStore {
  constructor(env = process.env, fetcher = fetch) {
    this.url = env.SUPABASE_URL?.trim().replace(/\/$/, '');
    this.token = (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
    this.eventId = env.LIVE_EVENT_ID;
    this.mode = env.LIVE_EXECUTION_MODE;
    this.fetcher = fetcher;
    if (!this.url?.startsWith('https://') || !this.token || !/^[a-zA-Z0-9_-]{1,80}$/.test(this.eventId ?? '')
      || !['hardware', 'simulation'].includes(this.mode))
      throw new QueueError('Live demo storage is not configured.', 503);
    this.key = `mixtures-v2:${this.eventId}`;
  }
  async request(path, body) {
    const response = await this.fetcher(`${this.url}/rest/v1/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { apikey: this.token, 'Content-Type': 'application/json',
        // New Supabase secret keys are not JWTs; the gateway handles apikey auth.
        ...(!this.token.startsWith('sb_secret_') ? { Authorization: `Bearer ${this.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      const details = await response.json().catch(() => null);
      let code = 'QUEUE_STORAGE_UNAVAILABLE';
      if (['PGRST205', 'PGRST202', '42P01', '42883'].includes(details?.code)) code = 'QUEUE_SCHEMA_MISSING';
      else if (details?.code === '42501' || response.status === 403) code = 'QUEUE_ACCESS_DENIED';
      else if (response.status === 401) code = 'QUEUE_AUTH_FAILED';
      // Never echo or log the upstream body: it can contain private details.
      console.error('Queue storage request failed', { status: response.status, code });
      throw new QueueError('Queue storage is temporarily unavailable.', 503, code);
    }
    return response.json();
  }
  async record() {
    const query = new URLSearchParams({ id: `eq.${this.key}`, select: 'revision,state', limit: '1' });
    const rows = await this.request(`ursa_live_events?${query}`);
    if (!Array.isArray(rows)) throw new QueueError('Queue storage returned an invalid response.', 503);
    return rows[0] ?? null;
  }
  decode(record) {
    const state = record?.state ?? initialState(this.eventId, this.mode);
    if (state.version !== 2 || state.eventId !== this.eventId || state.mode !== this.mode)
      throw new QueueError('Use a new event ID when changing execution mode.', 503);
    return state;
  }
  async read() { return this.decode(await this.record()); }
  async mutate(update) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const record = await this.record();
      const state = this.decode(record);
      const result = update(state);
      const committed = await this.request('rpc/ursa_live_compare_and_set', {
        event_key: this.key, expected_revision: record?.revision ?? 0, next_state: state,
      });
      if (committed === true) return { state, result };
      if (committed !== false) throw new QueueError('Queue storage returned an invalid response.', 503);
    }
    throw new QueueError('The queue is busy. Please retry.', 503);
  }
}
