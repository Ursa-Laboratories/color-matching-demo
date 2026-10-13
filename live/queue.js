import { randomUUID } from 'node:crypto';
import { makeRecipe, TOTAL_VOLUME_UL, VOLUME_STEP_UL, MAX_PARTS } from '../shared/recipe.js';

export class QueueError extends Error {
  constructor(message, status = 409, code) { super(message); this.status = status; this.code = code; }
}
export function initialState(eventId, mode) {
  return { version: 2, eventId, mode, accepting: true, draining: false, activeId: null,
    jobs: [], worker: null, rates: {}, queueRevision: 0 };
}
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
const required = (condition, message) => { if (!condition) throw new QueueError(message); };

// Mutations run on a private copy and commit using a Postgres compare-and-set.
export function transition(state, action, body, context) {
  const { now, participantId, ipHash } = context;
  if (action === 'submit') {
    if (body.submissionId !== undefined && !identifier(body.submissionId))
      throw new QueueError('Invalid submission identity.', 400);
    const existing = state.jobs.find(job => job.participantId === participantId
      && (body.submissionId !== undefined ? job.submissionId === body.submissionId : !job.submissionId));
    if (existing) return existing;
    required(state.accepting, 'Submissions are closed for this session.');
    required(state.jobs.filter(job => job.archivedAt == null).length < 300, 'The session queue is full.');
    const name = typeof body.name === 'string' ? body.name.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';
    if (!name || name.length > 40 || /\p{Cc}|\p{Cf}/u.test(name))
      throw new QueueError('Enter a name or nickname of 1–40 characters.', 400);
    let recipe;
    try { recipe = makeRecipe(body); } catch (error) { throw new QueueError(error.message, 400); }
    state.rates = Object.fromEntries(Object.entries(state.rates).filter(([, r]) => r.until > now));
    const rate = state.rates[ipHash] ?? { count: 0, until: now + 60_000 };
    if (rate.count >= 120) throw new QueueError('A lot of recipes arrived at once. Try again in a minute.', 429);
    rate.count++; state.rates[ipHash] = rate;
    const job = { id: randomUUID(), number: state.jobs.reduce((max, item) => Math.max(max, item.number ?? 0), 0) + 1,
      participantId, ...(body.submissionId === undefined ? {} : { submissionId: body.submissionId }), name, recipe,
      status: 'queued', createdAt: now, well: null, runId: null };
    state.jobs.push(job); return job;
  }
  if (action === 'run') {
    required(!state.activeId && !state.draining, 'A run is active or needs review.');
    required(state.worker && now - state.worker.lastSeen < 30_000, 'Start the laptop worker before running the queue.');
    const queued = state.jobs.filter(j => j.status === 'queued');
    required(queued.length > 0, 'There are no queued recipes.');
    queued.forEach(j => { j.status = 'ready'; }); state.draining = true;
  } else if (action === 'pause') {
    state.draining = false;
    state.jobs.filter(j => j.status === 'ready').forEach(j => { j.status = 'queued'; });
  } else if (action === 'accepting') {
    if (typeof body.accepting !== 'boolean') throw new QueueError('Expected accepting boolean.', 400);
    state.accepting = body.accepting;
  } else if (action === 'cancel') {
    const job = state.jobs.find(j => j.id === body.jobId);
    required(job && ['queued', 'ready'].includes(job.status), 'Only waiting jobs can be removed.');
    job.status = 'cancelled';
    if (!state.activeId && !state.jobs.some(j => j.status === 'ready')) state.draining = false;
  } else if (action === 'resolve') {
    const job = state.jobs.find(j => j.id === state.activeId);
    const offline = !state.worker || now - state.worker.lastSeen >= 30_000;
    required(job && (job.status === 'blocked' || (job.status === 'running' && offline)) && body.confirmed === true,
      'Confirm the CubOS run is stopped and the physical station has been checked.');
    job.status = 'cancelled'; job.retiredAt = now; state.activeId = null; state.draining = false;
    state.jobs.filter(j => j.status === 'ready').forEach(j => { j.status = 'queued'; });
  } else if (action === 'reset') {
    required(body.confirmed === true, 'Confirm that the displayed queue should be reset.');
    required(Number.isInteger(body.queueRevision) && body.queueRevision === (state.queueRevision ?? 0),
      'The queue changed since it was displayed. Refresh before resetting.');
    required(!state.activeId, 'Retire the active job through physical review before resetting the queue.');
    state.queueRevision = (state.queueRevision ?? 0) + 1;
    state.draining = false;
    state.jobs.filter(job => job.archivedAt == null).forEach(job => {
      if (job.status === 'queued' || job.status === 'ready') job.status = 'cancelled';
      job.archivedAt = now;
    });
  } else if (action === 'heartbeat' || action === 'claim') {
    required(identifier(body.workerId), 'Invalid worker identity.');
    required(body.mode === state.mode, 'Worker mode does not match this event.');
    const active = state.jobs.find(j => j.id === state.activeId);
    if (active) required(active.workerId === body.workerId, 'Another worker owns the active job.');
    if (state.worker && now - state.worker.lastSeen < 30_000)
      required(state.worker.id === body.workerId, 'Another worker is online. Stop it before switching workers.');
    state.worker = { id: body.workerId, mode: body.mode, lastSeen: now };
    if (action === 'heartbeat') return null;
    if (active) {
      required(active.status !== 'blocked', 'The active job needs operator review.'); return active;
    }
    if (!state.draining) return null;
    const job = state.jobs.find(j => j.status === 'ready');
    if (!job) { state.draining = false; return null; }
    job.status = 'running'; job.startedAt = now; job.workerId = body.workerId;
    state.activeId = job.id; return job;
  } else if (action === 'progress') {
    const job = state.jobs.find(j => j.id === body.jobId);
    required(job && job.workerId === body.workerId, 'Job does not belong to this worker.');
    required(['running', 'completed', 'blocked'].includes(body.status), 'Invalid job status.');
    // Reset archives the display but retains worker-owned run identities. A late
    // report is acknowledged after ownership is checked and cannot revive history.
    if (job.archivedAt != null) return job;
    // Acknowledge an interrupted worker's saved report after manual retirement.
    // The operator's decision remains final; delayed reports never revive a job.
    if (job.status === 'cancelled' && job.retiredAt != null) return job;
    const well = body.well ?? null, runId = body.runId ?? null;
    required(well === null || (typeof well === 'string' && /^[a-zA-Z0-9_.-]{1,160}$/.test(well)), 'Invalid well.');
    required(runId === null || (typeof runId === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(runId)), 'Invalid run identity.');
    if (job.status !== 'running') {
      required(job.status === body.status && job.well === well && job.runId === runId, 'A completed job cannot be changed.');
      return job;
    }
    required(state.activeId === job.id, 'Job is not active.');
    required(!job.well || job.well === well, 'The allocated well cannot change.');
    required(!job.runId || job.runId === runId, 'The run identity cannot change.');
    if (body.status === 'completed') {
      required(well && (state.mode === 'simulation' || runId), 'Completion requires a well and a CubOS run.');
    }
    Object.assign(job, { status: body.status, well, runId, updatedAt: now,
      message: typeof body.message === 'string' ? body.message.slice(0, 300) : null });
    if (job.status === 'blocked') {
      state.draining = false;
      state.jobs.filter(j => j.status === 'ready').forEach(j => { j.status = 'queued'; });
    } else if (job.status === 'completed') {
      job.completedAt = now; state.activeId = null;
      if (!state.jobs.some(j => j.status === 'ready')) state.draining = false;
    }
    return job;
  } else throw new QueueError('Unknown action.', 404);
  return null;
}
export function publicJob(job) {
  if (!job) return null;
  const { participantId, workerId, message, submissionId, archivedAt, ...safe } = job;
  return safe;
}
export function publicState(state, participantId, now, operator = false) {
  const visibleJobs = state.jobs.filter(job => job.archivedAt == null);
  return { eventId: state.eventId, mode: state.mode, accepting: state.accepting,
    draining: state.draining, activeId: state.activeId,
    queueRevision: state.queueRevision ?? 0,
    totalVolumeUl: TOTAL_VOLUME_UL, volumeStepUl: VOLUME_STEP_UL, maxParts: MAX_PARTS,
    workerOnline: !!state.worker && now - state.worker.lastSeen < 30_000,
    workerLastSeen: state.worker?.lastSeen ?? null,
    ownJob: publicJob(visibleJobs.filter(j => j.participantId === participantId).at(-1)),
    jobs: visibleJobs.map(job => ({ ...publicJob(job), ...(operator ? { message: job.message } : {}) })) };
}
