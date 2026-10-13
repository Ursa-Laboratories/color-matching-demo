import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { COMPONENTS, makeRecipe, MAX_PARTS, TOTAL_VOLUME_UL } from '../../../../shared/recipe.js';
import type { Component, Parts, Recipe } from '../../../../shared/recipe.js';
import { previewPalette } from './palette';
import './LiveDemo.css';

type Job = {
  id: string; number: number; name?: string; recipe: Recipe;
  status: 'queued' | 'ready' | 'running' | 'completed' | 'blocked' | 'cancelled';
  well: string | null; runId: string | null; message?: string;
};
type State = {
  eventId: string; mode: 'hardware' | 'simulation'; accepting: boolean; draining: boolean;
  activeId: string | null; workerOnline: boolean; jobs: Job[]; ownJob: Job | null; queueRevision?: number;
};
type Submission = { red: number; yellow: number; blue: number; name: string; submissionId: string };
type PhoneState = { schemaVersion: 1; eventId: string; queueRevision: number; mode: 'mixer' | 'receipt'; parts: Parts; name: string; submission?: Submission };
const PHONE_STATE_KEY = 'ursa-live-phone-v1';
const COLORS: Record<Component, string> = { red: '#e96356', yellow: '#edc441', blue: '#5477dc' };
const statusLabel: Record<Job['status'], string> = {
  queued: 'Queued', ready: 'Up next', running: 'Mixing',
  completed: 'Complete', blocked: 'On hold', cancelled: 'Removed',
};
const numberLabel = (job: Job) => '#' + String(job.number).padStart(3, '0');

function readPhoneState(): PhoneState | null {
  try {
    const value = window.localStorage.getItem(PHONE_STATE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<PhoneState>;
    const validParts = parsed?.parts && ['red', 'yellow', 'blue'].every(color => {
      const part = parsed.parts?.[color as Component];
      return Number.isInteger(part) && Number(part) >= 0 && Number(part) <= MAX_PARTS;
    });
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.eventId !== 'string' || !validParts || typeof parsed.name !== 'string'
      || !['mixer', 'receipt'].includes(parsed.mode ?? '')) return null;
    const rawSubmission = parsed.submission as Partial<Submission> | undefined;
    const validSubmission = rawSubmission && typeof rawSubmission.submissionId === 'string' && rawSubmission.submissionId.length >= 16
      && typeof rawSubmission.name === 'string' && ['red', 'yellow', 'blue'].every(color => {
        const part = rawSubmission[color as Component];
        return Number.isInteger(part) && Number(part) >= 0 && Number(part) <= MAX_PARTS;
      });
    if (parsed.submission && !validSubmission) return { schemaVersion: 1, eventId: parsed.eventId,
      queueRevision: Number(parsed.queueRevision) || 0, mode: 'mixer', parts: parsed.parts as Parts, name: parsed.name };
    return { schemaVersion: 1, eventId: parsed.eventId, queueRevision: Number(parsed.queueRevision) || 0,
      mode: parsed.mode as PhoneState['mode'], parts: parsed.parts as Parts, name: parsed.name,
      submission: validSubmission ? rawSubmission as Submission : undefined };
  } catch { return null; }
}

function newSubmissionId(): string {
  try {
    if (typeof window.crypto?.randomUUID === 'function') return window.crypto.randomUUID();
  } catch { /* Use a local fallback when browser crypto is unavailable. */ }
  return `mix-${Date.now().toString(36)}-${Math.random().toString(36).slice(2).padEnd(16, '0')}`;
}

function Arrow() {
  return <svg className="live-arrow" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 15 15 5M5 5h10v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

async function request<T>(path: string, token = '', body?: unknown): Promise<T> {
  const response = await fetch(`/api/live/${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => ({ error: 'Couldn’t reach the queue. Try again.' }));
  if (!response.ok) throw new Error(value.error || 'Couldn’t send your mix. Try again.');
  return value;
}

function ColorPreview({ recipe, name, job }: { recipe: Recipe | null; name?: string; job?: Job }) {
  const palette = previewPalette(recipe);
  return <section className="live-preview" aria-label="Color preview" style={{ backgroundColor: palette.background }}>
    <div className="live-preview-top"><span>{job ? numberLabel(job) : 'Your mix'}</span><span>{TOTAL_VOLUME_UL} µL</span></div>
    <div className="live-color-disc" style={{ backgroundColor: palette.color }} aria-hidden="true" />
    <div className="live-preview-bottom">
      <div>{name?.trim() && <span className="live-preview-name">{name.trim()}</span>}
        <div className="live-color-ratio" aria-label="Ingredient volumes">{COMPONENTS.map(color => <span key={color}>
          <i style={{ backgroundColor: COLORS[color] }} />{recipe?.volumes[color] ?? 0}<small> µL</small>
        </span>)}</div>
      </div>
      <span className="live-preview-note">Approximate color</span>
    </div>
  </section>;
}

function Ticket({ job, onAnother }: { job: Job; onAnother?: () => void }) {
  return <section className="live-ticket" aria-label="Your submission">
    <span className="live-kicker">YOUR MIX · {numberLabel(job)}</span>
    <h1>{job.name ? <>{job.name}<span className="live-heading-dot">.</span></> : 'Your mix.'}</h1>
    <div className="live-ticket-status" role="status"><i className={job.status} /><h2>{statusLabel[job.status]}</h2></div>
    <p>{job.status === 'queued' ? 'The host will start your mix.'
      : job.status === 'ready' ? 'CUB will make your mix next.'
        : job.status === 'running' ? 'CUB is making your mix.'
          : job.status === 'completed' ? 'Your mix is ready.'
            : job.status === 'blocked' ? 'The host is checking the station.' : 'This mix was removed.'}</p>
    <dl className="live-receipt">{COMPONENTS.map(color => <div key={color}>
      <dt><i style={{ backgroundColor: COLORS[color] }} />{color}</dt><dd>{job.recipe.volumes[color]} µL</dd>
    </div>)}</dl>
    {job.well && <p className="live-well">Well <strong>{job.well}</strong></p>}
    {onAnother && <button className="live-primary live-another" type="button" onClick={onAnother}>Submit another mixture <Arrow /></button>}
  </section>;
}

function JoinCode() {
  const url = `${window.location.origin}/?view=live`;
  const [src, setSrc] = useState('');
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(url, { width: 400, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#272933', light: '#ffffff' } })
      .then(value => { if (active) setSrc(value); }).catch(() => { if (active) setSrc(''); });
    return () => { active = false; };
  }, [url]);
  return <section className="live-qr"><span className="live-kicker">YOUR PHONE → CUB</span><h1>Make a mix.</h1>
    {src && <img src={src} width="224" height="224" alt="QR code to submit a mixture" />}
    <a href={url}>{window.location.host}</a>
    {src && <a className="live-qr-download" href={src} download="ursa-cloud-lab-qr.png">Download QR</a>}
  </section>;
}

function Queue({ jobs, currentId, operator, pending, stale, onRemove }: {
  jobs: Job[]; currentId?: string | null; operator: boolean; pending: boolean; stale: boolean; onRemove: (id: string) => void;
}) {
  return <section className="live-queue" id="queue" aria-label="Live queue">
    <div className="live-queue-heading"><h2>In the lab <span>{jobs.length}</span></h2><span>One mix. One well.</span></div>
    {jobs.length ? <div className="live-queue-grid" aria-label="Submitted recipes">{jobs.map(job => {
      const palette = previewPalette(job.recipe);
      return <article className={`live-job ${job.id === currentId ? 'is-active' : ''}`} key={job.id}>
        <div className="live-job-swatch" style={{ backgroundColor: palette.background }}>
          <span>{numberLabel(job)}</span><i style={{ backgroundColor: palette.color }} />
          {operator && ['queued', 'ready'].includes(job.status) && <button disabled={pending || stale} aria-label={`Remove recipe ${job.number}`} onClick={() => onRemove(job.id)}>×</button>}
        </div>
        <div className="live-job-caption"><h3>{job.name || `Mix ${numberLabel(job)}`}</h3><span className={`live-job-status ${job.status}`}>{statusLabel[job.status]}</span></div>
        {job.well && <p className="live-job-well">{job.well}</p>}
      </article>;
    })}</div> : <p className="live-empty">Your mix could be the first.</p>}
  </section>;
}

export default function LiveDemo({ view = 'live' }: { view?: string }) {
  const operator = view === 'operator', screen = view === 'screen';
  const phoneView = !operator && !screen;
  const [tokenInput, setTokenInput] = useState('');
  const [token, setToken] = useState('');
  const [phone, setPhone] = useState<PhoneState>(() => (phoneView ? readPhoneState() : null) ?? {
    schemaVersion: 1, eventId: '', queueRevision: 0, mode: 'mixer', parts: { red: 6, yellow: 3, blue: 1 }, name: '',
  });
  const [resetRevision, setResetRevision] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const client = useQueryClient();
  const key = ['live-demo', operator ? 'operator' : 'public', token];
  const query = useQuery({ queryKey: key, queryFn: () => request<State>(operator ? 'admin/state' : 'state', token),
    enabled: !operator || !!token, refetchInterval: 3000, retry: false });
  const mutation = useMutation({ mutationFn: async ({ action, body }: { action: string; body: unknown }) => ({
    data: await request<State>(action, token, body), action,
  }),
    onSuccess: ({ data: result, action }) => {
      client.setQueryData(key, result);
      if (action === 'jobs' && !operator) setPhone(current => ({ ...current, mode: 'receipt' }));
      if (action === 'admin/reset') setResetRevision(null);
    } });
  useEffect(() => { document.title = 'Mix / CUB · Ursa'; }, []);
  const data = query.data, pending = mutation.isPending, stale = !!query.error;
  const parts = phone.parts, name = phone.name;
  useEffect(() => {
    if (!data || !phoneView) return;
    const revision = data.queueRevision ?? 0;
    if (phone.eventId !== data.eventId || phone.queueRevision !== revision) {
      setPhone(current => ({ ...current, schemaVersion: 1, eventId: data.eventId, queueRevision: revision,
        mode: 'mixer', submission: undefined }));
    }
  }, [data?.eventId, data?.queueRevision, phoneView, phone.eventId, phone.queueRevision, data]);
  useEffect(() => {
    if (!phoneView) return;
    try { window.localStorage.setItem(PHONE_STATE_KEY, JSON.stringify(phone)); } catch { /* Storage can be unavailable in private browsing. */ }
  }, [phoneView, phone]);
  const current = data?.jobs.find(j => j.id === data.activeId);
  const queued = data?.jobs.filter(j => j.status === 'queued').length ?? 0;
  const recipe = COMPONENTS.some(color => parts[color] > 0) ? makeRecipe(parts) : null;
  const send = (action: string, body: unknown = {}) => mutation.mutate({ action, body });
  const submit = (submission = phone.submission) => {
    if (!submission) {
      const payload: Submission = { ...phone.parts, name: phone.name.trim(), submissionId: newSubmissionId() };
      setPhone(current => ({ ...current, submission: payload }));
      mutation.mutate({ action: 'jobs', body: payload });
      return;
    }
    mutation.mutate({ action: 'jobs', body: submission });
  };
  const startAnother = () => setPhone(current => ({ ...current, mode: 'mixer', submission: undefined }));
  const queueRevision = data?.queueRevision ?? 0;
  const resetDisabled = pending || stale || !!data?.activeId || !data?.jobs.length;
  const resetIntentStale = resetRevision !== null && resetRevision !== queueRevision;
  useEffect(() => { if (resetIntentStale) setResetRevision(null); }, [resetIntentStale]);
  const error = mutation.error ?? query.error;
  const canResolve = current?.status === 'blocked' || (current?.status === 'running' && !data?.workerOnline);
  const featured = screen || operator ? current : phone.mode === 'receipt' ? data?.ownJob : undefined;
  const hasAccess = !operator || !!token;

  return <main className={`live-demo ${screen ? 'live-screen' : ''}`}><div className="live-shell">
    <header className="live-header">
      <a className="live-brand" href="/?view=live" aria-label="Mix by Ursa"><span className="live-logo" aria-hidden="true"><i /><i /><i /></span><strong>mix</strong><span>by Ursa</span></a>
      <nav aria-label="Demo navigation">
        {data?.mode === 'simulation' && <span className="live-mode" title="Rehearsal: no hardware runs">Simulation</span>}
        {operator && <span className="live-worker"><i className={data?.workerOnline && !stale ? 'online' : ''} />{stale ? 'Reconnecting' : data?.workerOnline ? 'Laptop online' : 'Laptop offline'}</span>}
        <a href="#queue">Queue <span>{data?.jobs.length ?? 0}</span></a>
      </nav>
    </header>
    {error && <div role="alert" className="live-error">{error.message} <button onClick={() => { mutation.reset(); void query.refetch(); }}>Retry</button></div>}
    {operator && !token ? <form className="live-login" onSubmit={e => { e.preventDefault(); setToken(tokenInput); }}>
      <h1>Host controls.</h1><label htmlFor="operator-token">Operator key</label><input id="operator-token" type="password" value={tokenInput} onChange={e => setTokenInput(e.target.value)} required autoComplete="off" />
      <button className="live-primary" type="submit">Unlock controls <Arrow /></button>
    </form> : <>
      {operator && <section className="live-controls"><div>
        <button className="live-primary" disabled={pending || stale || !data?.workerOnline || !!data?.activeId || data?.draining || !queued} onClick={() => send('admin/run')}>Run {queued || ''} queued {queued === 1 ? 'recipe' : 'recipes'} <Arrow /></button>
        <button disabled={pending || stale || !data?.draining} onClick={() => send('admin/pause')}>Pause after this well</button>
        <button disabled={pending || stale || !data} onClick={() => send('admin/accepting', { accepting: !data?.accepting })}>{data?.accepting ? 'Close submissions' : 'Open submissions'}</button>
        <a href="/?view=screen" target="_blank" rel="noreferrer">Talk screen</a>
        <button onClick={() => { setToken(''); setTokenInput(''); client.removeQueries({ queryKey: ['live-demo', 'operator'] }); }}>Lock</button>
        <button disabled={resetDisabled} onClick={() => setResetRevision(queueRevision)}>Reset queue</button>
      </div><p>Run starts the current queue. Later arrivals wait. To stop an active well, use CubOS.</p>
        {!!data?.activeId && <p className="live-reset-hint">Reset is unavailable while a job is active. Retire the blocked job after checking the physical station.</p>}
        {resetRevision !== null && !resetIntentStale && <div className="live-reset-confirm" role="alertdialog" aria-labelledby="live-reset-title" aria-describedby="live-reset-description">
          <h2 id="live-reset-title">Reset the displayed queue?</h2>
          <p id="live-reset-description">This clears displayed submissions and pauses the queue. Hardware and well usage stay unchanged.</p>
          <div><button disabled={pending || stale || !!data?.activeId || !data?.jobs.length || resetIntentStale} onClick={() => send('admin/reset', { confirmed: true, queueRevision: resetRevision })}>Confirm reset</button>
            <button disabled={pending} onClick={() => setResetRevision(null)}>Keep queue</button></div>
        </div>}
        {canResolve && <div className="live-recovery"><p>{current?.message || 'Inspect the CubOS run before continuing.'}</p>
          <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I stopped the laptop worker and CubOS run, and checked the physical station.</label>
          <button disabled={!confirmed || pending || stale} onClick={() => { send('admin/resolve', { confirmed: true }); setConfirmed(false); }}>Retire interrupted job</button>
        </div>}
      </section>}
      <div className={`live-workspace ${screen || operator ? 'live-host-workspace' : ''}`}>
        {screen || operator ? <JoinCode /> : phone.mode === 'receipt' ? data?.ownJob ? <Ticket job={data.ownJob} onAnother={startAnother} /> :
          <section className="live-ticket" aria-label="Your submission" aria-live="polite">
            <span className="live-kicker">YOUR MIX</span><p>{query.isLoading ? 'Loading your mix…' : 'Your mix is no longer in the visible queue.'}</p>
            {!query.isLoading && <button className="live-primary live-another" type="button" onClick={startAnother}>Submit another mixture <Arrow /></button>}
          </section> :
          <form className="live-mixer" onSubmit={e => { e.preventDefault(); if (recipe && name.trim()) submit(); }}>
            <div className="live-mixer-title"><span className="live-kicker">CLOUD LAB / CUB</span><h1>Make a mix.</h1></div>
            <div className="live-sliders">{COMPONENTS.map(color => <label className="live-slider" key={color} style={{ '--dye': COLORS[color], '--fill': `${parts[color] / MAX_PARTS * 100}%` } as CSSProperties}>
              <span><span className="live-dye-label"><i />{color}</span><output>{parts[color]}<small> / {MAX_PARTS}</small></output></span>
              <input aria-label={color[0].toUpperCase() + color.slice(1)} aria-valuetext={`${parts[color]} parts, ${recipe?.volumes[color] ?? 0} microliters`} type="range" min="0" max={MAX_PARTS} step="1" value={parts[color]} disabled={!!phone.submission}
                onChange={e => setPhone({ ...phone, parts: { ...parts, [color]: Number(e.target.value) } })} />
            </label>)}</div>
            <div className="live-name-field"><label htmlFor="mix-name">Your name</label>
              <input id="mix-name" name="name" type="text" value={name} onChange={e => setPhone({ ...phone, name: e.target.value })} placeholder="First name or nickname" required maxLength={40} autoComplete="given-name" aria-describedby="mix-name-hint" disabled={!!phone.submission} />
              <span id="mix-name-hint">Shown with your mix.</span>
            </div>
            {phone.submission && <p className="live-validation" role="status">Retry sends the same saved mix. Start a new mixture to change it.</p>}
            {!recipe && <p className="live-validation" role="status">Add a little color first.</p>}
            <button className="live-primary" type="submit" disabled={!recipe || !name.trim() || !data || stale || pending || (!data.accepting && !phone.submission)}>
              {pending ? 'Submitting…' : phone.submission ? 'Retry submission' : data && !data.accepting ? 'Submissions closed' : 'Submit'}<Arrow />
            </button>
            {phone.submission && <button className="live-secondary" type="button" disabled={pending} onClick={startAnother}>Start a new mixture</button>}
          </form>}
        <div className="live-canvas">
          {screen || operator ? <div className="live-bench-status" role="status"><i className={current?.status ?? ''} />
            <h2>{current ? `${statusLabel[current.status]} · ${current.name || numberLabel(current)}` : data?.draining ? 'Next mix, coming up.' : 'Ready to mix.'}</h2>
          </div> : null}
          <ColorPreview recipe={featured?.recipe ?? recipe} name={featured?.name ?? (screen || operator ? 'Made by CUB' : name)} job={featured ?? undefined} />
        </div>
      </div>
      <Queue jobs={data?.jobs ?? []} currentId={data?.activeId} operator={operator} pending={pending} stale={stale} onRemove={id => send('admin/cancel', { jobId: id })} />
    </>}
    <footer className="live-footer"><span>Ursa Laboratories</span>{!hasAccess && <span>Host access</span>}</footer>
  </div></main>;
}
