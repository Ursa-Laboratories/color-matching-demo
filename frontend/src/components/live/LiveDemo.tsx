import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { COMPONENTS, makeRecipe, MAX_PARTS, TOTAL_VOLUME_UL } from '../../../../shared/recipe.js';
import type { Component, Parts, Recipe } from '../../../../shared/recipe.js';
import PhotoUpload from './PhotoUpload';
import type { PhotoJob } from './PhotoUpload';
import './LiveDemo.css';

type Job = PhotoJob & {
  recipe: Recipe;
  status: 'queued' | 'ready' | 'running' | 'completed' | 'blocked' | 'cancelled';
  runId: string | null; message?: string;
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

function RecipeProportions({ recipe, title }: { recipe: Recipe; title?: string }) {
  const totalParts = COMPONENTS.reduce((sum, color) => sum + recipe.parts[color], 0);
  return <section className="live-recipe" aria-label="Recipe proportions">
    {title && <h2>{title}</h2>}
    <div className="live-recipe-bar" role="img" aria-label={COMPONENTS.map(color => `${color} ${recipe.parts[color]} parts`).join(', ')}>
      {COMPONENTS.map(color => recipe.parts[color] > 0 && <span key={color} style={{ backgroundColor: COLORS[color], flexGrow: recipe.parts[color] / totalParts }} />)}
    </div>
    <dl className="live-recipe-values">{COMPONENTS.map(color => <div key={color}>
      <dt><i style={{ backgroundColor: COLORS[color] }} />{color}</dt>
      <dd>{recipe.parts[color]} parts <span>·</span> {recipe.volumes[color]} µL</dd>
    </div>)}</dl>
    <p className="live-recipe-total">Total · {TOTAL_VOLUME_UL} µL</p>
  </section>;
}

function JobVisual({ job }: { job: Job }) {
  const isComplete = job.status === 'completed';
  return <section className="live-job-visual" aria-label={`${job.well ? `Well ${job.well}` : numberLabel(job)} result`}>
    <div className="live-job-visual-heading"><span className="live-kicker">{job.well ? `WELL ${job.well}` : 'YOUR RECIPE'}</span><span>{numberLabel(job)}</span></div>
    {isComplete ? job.resultPhoto ? <a className="live-result-photo-link" href={job.resultPhoto.url} target="_blank" rel="noreferrer" aria-label={`Open result photo for well ${job.well}`}>
      <img className="live-result-photo" src={job.resultPhoto.url} alt={`Result photo for well ${job.well}`} />
      <span>{job.resultPhoto.wellLabels.length > 1 ? `Plate photo · your well ${job.well}` : 'Open photo'}</span>
    </a> : <div className="live-photo-placeholder">Photo not added yet</div>
      : <RecipeProportions recipe={job.recipe} title={job.name || 'Recipe proportions'} />}
    {isComplete && <RecipeProportions recipe={job.recipe} title={job.name || 'Recipe proportions'} />}
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

function Queue({ jobs, currentId, operator, pending, stale, onRemove, onPhoto }: {
  jobs: Job[]; currentId?: string | null; operator: boolean; pending: boolean; stale: boolean;
  onRemove: (id: string) => void; onPhoto: (id: string) => void;
}) {
  return <section className="live-queue" id="queue" aria-label="Live queue">
    <div className="live-queue-heading"><h2>In the lab <span>{jobs.length}</span></h2><span>One mix. One well.</span></div>
    {jobs.length ? <div className="live-queue-grid" aria-label="Submitted recipes">{jobs.map(job => {
      return <article className={`live-job ${job.id === currentId ? 'is-active' : ''}`} key={job.id}>
        <div className="live-job-swatch">
          <span>{numberLabel(job)}</span>
          {job.status === 'completed' && job.resultPhoto ? <a href={job.resultPhoto.url} target="_blank" rel="noreferrer" aria-label={`Open result photo for well ${job.well}`}>
            <img src={job.resultPhoto.url} alt={`Result photo for well ${job.well}`} />
          </a> : <div className="live-queue-recipe-bar" aria-label="Recipe proportions">
            {COMPONENTS.map(color => job.recipe.parts[color] > 0 && <i key={color} style={{ backgroundColor: COLORS[color], flexGrow: job.recipe.parts[color] }} />)}
          </div>}
          {operator && ['queued', 'ready'].includes(job.status) && <button disabled={pending || stale} aria-label={`Remove recipe ${job.number}`} onClick={() => onRemove(job.id)}>×</button>}
        </div>
        <div className="live-job-caption"><h3>{job.name || `Mix ${numberLabel(job)}`}</h3><span className={`live-job-status ${job.status}`}>{statusLabel[job.status]}</span></div>
        {job.well && <p className="live-job-well">{job.well}</p>}
        <p className="live-queue-volumes">{COMPONENTS.map(color => `${color[0].toUpperCase()} ${job.recipe.volumes[color]} µL`).join(' · ')}</p>
        {operator && job.status === 'completed' && job.well && <button className="live-job-photo-action" disabled={pending || stale} onClick={() => onPhoto(job.id)}>
          {job.resultPhoto ? 'Replace photo' : 'Add photo'}
        </button>}
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
  const [photoPanelOpen, setPhotoPanelOpen] = useState(false);
  const [photoPresetJobId, setPhotoPresetJobId] = useState<string | null>(null);
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
  const completedPhotoJobs = data?.jobs.filter(job => job.status === 'completed' && job.well) ?? [];
  const uploadPhoto = async (body: { jobIds: string[]; queueRevision: number; image: string }) => {
    await mutation.mutateAsync({ action: 'admin/photos', body });
  };
  const resetDisabled = pending || stale || !!data?.activeId || !data?.jobs.length;
  const resetIntentStale = resetRevision !== null && resetRevision !== queueRevision;
  useEffect(() => { if (resetIntentStale) setResetRevision(null); }, [resetIntentStale]);
  const error = mutation.error ?? query.error;
  const canResolve = current?.status === 'blocked' || (current?.status === 'running' && !data?.workerOnline);
  const latestCompleted = [...(data?.jobs ?? [])].reverse().find(job => job.status === 'completed');
  const featured = screen || operator ? current ?? latestCompleted : phone.mode === 'receipt' ? data?.ownJob : undefined;
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
        <button disabled={pending || stale || !completedPhotoJobs.length} onClick={() => { setPhotoPresetJobId(null); setPhotoPanelOpen(true); }}>Add result photo</button>
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
      {operator && <PhotoUpload open={photoPanelOpen} presetJobId={photoPresetJobId} jobs={data?.jobs ?? []}
        queueRevision={queueRevision} pending={pending} onClose={() => setPhotoPanelOpen(false)} onUpload={uploadPhoto} />}
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
          {screen || operator ? <div className="live-bench-status" role="status"><i className={current?.status ?? latestCompleted?.status ?? ''} />
            <h2>{current ? `${statusLabel[current.status]} · ${current.name || numberLabel(current)}` : latestCompleted ? `${statusLabel[latestCompleted.status]} · ${latestCompleted.name || numberLabel(latestCompleted)}` : data?.draining ? 'Next mix, coming up.' : 'Ready to mix.'}</h2>
          </div> : null}
          {featured ? <JobVisual job={featured} /> : recipe ? <RecipeProportions recipe={recipe} title="Your recipe" /> : <p className="live-empty-recipe">A mix will appear here.</p>}
        </div>
      </div>
      <Queue jobs={data?.jobs ?? []} currentId={data?.activeId} operator={operator} pending={pending} stale={stale}
        onRemove={id => send('admin/cancel', { jobId: id })} onPhoto={id => { setPhotoPresetJobId(id); setPhotoPanelOpen(true); }} />
    </>}
    <footer className="live-footer"><span>Ursa Laboratories</span>{!hasAccess && <span>Host access</span>}</footer>
  </div></main>;
}
