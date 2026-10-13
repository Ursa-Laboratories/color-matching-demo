import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { COMPONENTS, makeRecipe, MAX_PARTS, TOTAL_VOLUME_UL } from '../../../../shared/recipe.js';
import type { Component, Parts, Recipe } from '../../../../shared/recipe.js';
import './LiveDemo.css';

type Job = {
  id: string; number: number; recipe: Recipe;
  status: 'queued' | 'ready' | 'running' | 'completed' | 'blocked' | 'cancelled';
  well: string | null; runId: string | null; message?: string;
};
type State = {
  eventId: string; mode: 'hardware' | 'simulation'; accepting: boolean; draining: boolean;
  activeId: string | null; workerOnline: boolean; jobs: Job[]; ownJob: Job | null;
};
const COLORS: Record<Component, string> = { red: '#d95742', yellow: '#e4bb38', blue: '#527fab' };
const statusLabel: Record<Job['status'], string> = {
  queued: 'Waiting for the host', ready: 'Up next', running: 'Making your mixture',
  completed: 'Mixture complete', blocked: 'Host is checking', cancelled: 'Removed from queue',
};
async function request<T>(path: string, token = '', body?: unknown): Promise<T> {
  const response = await fetch(`/api/live/${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => ({ error: 'The queue is unavailable. Try again shortly.' }));
  if (!response.ok) throw new Error(value.error || 'Request failed. Please retry.');
  return value;
}
function RecipeBar({ recipe, small = false }: { recipe: Recipe; small?: boolean }) {
  return <div className={`live-recipe-bar ${small ? 'small' : ''}`} aria-label={`Red ${recipe.volumes.red}, yellow ${recipe.volumes.yellow}, blue ${recipe.volumes.blue} microliters`}>
    {COMPONENTS.map(name => <span key={name} style={{ flex: recipe.volumes[name], background: COLORS[name] }} />)}
  </div>;
}
function RecipeDetails({ recipe }: { recipe: Recipe }) {
  return <dl className="live-recipe-details">{COMPONENTS.map(name => <div key={name}>
    <dt><i style={{ background: COLORS[name] }} />{name}</dt><dd>{recipe.volumes[name]} <small>µL</small></dd>
  </div>)}</dl>;
}
function Ticket({ job }: { job: Job }) {
  return <section className="live-ticket" aria-live="polite">
    <div className="live-eyebrow">YOUR JOB · #{String(job.number).padStart(3, '0')}</div>
    <div className="live-ticket-recipe"><RecipeBar recipe={job.recipe} /></div>
    <h2>{statusLabel[job.status]}</h2>
    <p>{job.status === 'queued' ? 'Your recipe is saved. Keep this page open to follow its journey from the cloud to the lab.'
      : job.status === 'ready' ? 'The host has released your recipe. CUB will make it when the current well is finished.'
      : job.status === 'completed' ? 'Your recipe is now a real mixture. One submission, one well.'
        : job.status === 'blocked' ? 'The host is checking the station before continuing.'
          : job.status === 'cancelled' ? 'The host removed this job from the session.'
            : 'CUB is following your recipe, dispensing the chosen amounts into a fresh well.'}</p>
    <RecipeDetails recipe={job.recipe} />
    <div className="live-ticket-bottom"><span>150 µL total</span><span>{job.well ? `Well ${job.well}` : 'One fresh well'}</span></div>
  </section>;
}
function JoinCode() {
  const url = `${window.location.origin}/?view=live`;
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(url, { width: 320, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#222a28', light: '#ffffff' } })
      .then(value => { if (active) setSrc(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [url]);
  return <section className="live-qr"><div className="live-eyebrow">SEND A JOB TO THE LAB</div><h2>Scan. Mix. Submit.</h2>
    {src && <img src={src} width="240" height="240" alt="QR code to submit a mixture" />}
    {failed && <p>Use the link below to join.</p>}<a href={url}>{url.replace(/^https?:\/\//, '')}</a>
    <p className="live-fine">Use venue Wi-Fi or cellular data.</p>
    {src && <a className="live-text-link" href={src} download="ursa-cloud-lab-qr.png">Download QR code ↗</a>}
  </section>;
}
export default function LiveDemo({ view = 'live' }: { view?: string }) {
  const operator = view === 'operator', screen = view === 'screen';
  const [tokenInput, setTokenInput] = useState('');
  const [token, setToken] = useState('');
  const [parts, setParts] = useState<Parts>({ red: 6, yellow: 3, blue: 1 });
  const [confirmed, setConfirmed] = useState(false);
  const client = useQueryClient();
  const key = ['live-demo', operator ? 'operator' : 'public', token];
  const query = useQuery({ queryKey: key, queryFn: () => request<State>(operator ? 'admin/state' : 'state', token),
    enabled: !operator || !!token, refetchInterval: 3000, retry: false });
  const mutation = useMutation({ mutationFn: ({ action, body }: { action: string; body: unknown }) => request<State>(action, token, body),
    onSuccess: data => client.setQueryData(key, data) });
  useEffect(() => { document.title = 'Cloud Lab / CUB — Ursa Laboratories'; }, []);
  const data = query.data, pending = mutation.isPending, stale = !!query.error;
  const waiting = data?.jobs.filter(j => ['queued', 'ready'].includes(j.status)) ?? [];
  const current = data?.jobs.find(j => j.id === data.activeId);
  const queued = data?.jobs.filter(j => j.status === 'queued').length ?? 0;
  const finished = data?.jobs.filter(j => j.status === 'completed').length ?? 0;
  const recipe = COMPONENTS.some(name => parts[name] > 0) ? makeRecipe(parts) : null;
  const send = (action: string, body: unknown = {}) => mutation.mutate({ action, body });
  const error = mutation.error ?? query.error;
  const canResolve = current?.status === 'blocked' || (current?.status === 'running' && !data?.workerOnline);
  return <main className={`live-demo ${screen ? 'live-screen' : ''}`}><div className="live-shell">
    <header className="live-header"><a className="live-brand" href="/?view=live"><span className="live-mark" aria-hidden="true">u.</span><span>URSA<span className="live-brand-sub">LABORATORIES</span></span></a>
      <div className="live-header-right"><span className="live-event-label">A LIVE CLOUD LAB DEMO</span><span className="live-badge"><i className={data?.workerOnline && !stale ? 'online' : ''} />{stale ? 'Reconnecting' : data?.workerOnline ? 'Laptop online' : 'Laptop offline'}</span></div></header>
    {data?.mode === 'simulation' && <div className="live-simulation">REHEARSAL MODE · Job execution is simulated. No hardware is running.</div>}
    <div className="live-topline"><span>CLOUD LAB / CUB</span><span>YOUR PHONE → THE CLOUD → THE LAB</span></div>
    <div className="live-intro"><div><p className="live-eyebrow">{operator ? 'HOST CONTROLS' : 'YOUR RECIPE, IN THE REAL WORLD'}</p>
      <h1>{operator ? <>The recipes.<br /><em>Your call.</em></> : <>Your recipe.<br /><em>Made by CUB.</em></>}</h1></div>
      <p>{operator ? 'Start the queue when the station is ready. CUB makes each submitted recipe in one fresh well.'
        : 'Choose your mix of red, yellow, and blue. Send it to the cloud. Watch a robot bring your recipe to life.'}</p></div>
    {error && <div role="alert" className="live-error">{error.message} <button onClick={() => { mutation.reset(); void query.refetch(); }}>Retry</button></div>}
    {operator && !token ? <form className="live-login" onSubmit={e => { e.preventDefault(); setToken(tokenInput); }}>
      <h2>Open host controls</h2><label htmlFor="operator-token">Operator key</label><input id="operator-token" type="password" value={tokenInput} onChange={e => setTokenInput(e.target.value)} required autoComplete="off" />
      <button className="live-primary" type="submit">Unlock controls ↗</button></form> : <>
      {operator && <section className="live-controls"><div>
        <button className="live-primary" disabled={pending || stale || !data?.workerOnline || !!data?.activeId || data?.draining || !queued} onClick={() => send('admin/run')}>Run {queued || ''} queued {queued === 1 ? 'recipe' : 'recipes'} ↗</button>
        <button disabled={pending || stale || !data?.draining} onClick={() => send('admin/pause')}>Pause after this well</button>
        <button disabled={pending || stale || !data} onClick={() => send('admin/accepting', { accepting: !data?.accepting })}>{data?.accepting ? 'Close submissions' : 'Open submissions'}</button>
        <a href="/?view=screen" target="_blank" rel="noreferrer">Open talk screen ↗</a>
        <button onClick={() => { setToken(''); setTokenInput(''); client.removeQueries({ queryKey: ['live-demo', 'operator'] }); }}>Lock</button></div>
        <p>Run releases the recipes waiting now. Later submissions wait for the next Run. Pause finishes the current well; use CubOS to stop an active run.</p>
        {canResolve && <div className="live-recovery"><p>{current?.message || 'Inspect the CubOS run before continuing.'}</p>
          <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I stopped the laptop worker and CubOS run, and checked the physical station.</label>
          <button disabled={!confirmed || pending} onClick={() => { send('admin/resolve', { confirmed: true }); setConfirmed(false); }}>Retire interrupted job</button></div>}
      </section>}
      <div className="live-grid">
        {screen || operator ? <JoinCode /> : data?.ownJob ? <Ticket job={data.ownJob} /> : <section className="live-picker">
          <div className="live-mixture-visual"><span>YOUR RECIPE</span><div className="live-vessel" aria-hidden="true">{COMPONENTS.map(name => <i key={name} style={{ flex: recipe?.volumes[name] ?? 0, background: COLORS[name] }} />)}</div><b>{TOTAL_VOLUME_UL}<small> µL</small></b></div>
          <form onSubmit={e => { e.preventDefault(); if (recipe) send('jobs', parts); }}>
            <div className="live-picker-title"><h2>Make a little chemistry</h2><span>One recipe. One well.</span></div>
            {COMPONENTS.map(name => <label className="live-slider mixture" key={name}>
              <span><span className="live-dye-label"><i style={{ background: COLORS[name] }} />{name}<small>{parts[name]} parts</small></span><output>{recipe?.volumes[name] ?? 0} µL</output></span>
              <input aria-label={name[0].toUpperCase() + name.slice(1)} type="range" min="0" max={MAX_PARTS} step="1" value={parts[name]}
                style={{ background: `linear-gradient(to right, ${COLORS[name]}40, ${COLORS[name]})` }} onChange={e => setParts({ ...parts, [name]: Number(e.target.value) })} /></label>)}
            <p className="live-recipe-note">Sliders set proportions. We make 150 µL total, rounded to 5 µL steps.</p>
            {!recipe && <p className="live-validation" role="status">Add at least one color to your mixture.</p>}
            <button className="live-primary" type="submit" disabled={!recipe || !data || stale || pending || !data.accepting}>{pending ? 'Sending your recipe…' : data && !data.accepting ? 'Submissions are closed' : 'Submit my recipe ↗'}</button>
            <p className="live-fine">One recipe per browser for this session. The host starts the jobs.</p>
          </form></section>}
        <section className="live-activity"><div className="live-section-title"><h2>The lab queue</h2><span>{String(data?.jobs.length ?? 0).padStart(2, '0')} RECIPES</span></div>
          <div className="live-stats"><div><strong>{waiting.length}</strong><span>Waiting</span></div><div><strong>{finished}</strong><span>Completed</span></div><div><strong>150<small> µL</small></strong><span>In every well</span></div></div>
          {current ? <div className="live-current"><div className="live-eyebrow">{current.status === 'blocked' ? 'ON HOLD' : 'ON THE BENCH'} · JOB #{String(current.number).padStart(3, '0')}</div>
            <h3>{statusLabel[current.status]}</h3><RecipeBar recipe={current.recipe} /><RecipeDetails recipe={current.recipe} />
            <p>{current.well ? `Well ${current.well}` : 'Allocating a fresh well'}<span>One recipe → one mixture</span></p></div>
            : <div className="live-idle"><span aria-hidden="true">◌</span><h3>{data?.draining ? 'Next recipe, coming up.' : 'Ready when the host is.'}</h3><p>{data?.draining ? 'The laptop is collecting the next job.' : 'Your ideas become instructions. CUB takes it from there.'}</p></div>}
          <div className="live-queue-list" aria-label="Submitted recipes">{(data?.jobs ?? []).filter(j => j.id !== current?.id).map(job => <div className="live-queue-row" key={job.id}>
            <RecipeBar recipe={job.recipe} small /><div><strong>Recipe #{String(job.number).padStart(3, '0')}</strong><small>{statusLabel[job.status]}</small></div>
            <span className="live-job-result">{job.well ?? `${job.recipe.volumes.red} / ${job.recipe.volumes.yellow} / ${job.recipe.volumes.blue} µL`}</span>
            {operator && ['queued', 'ready'].includes(job.status) && <button disabled={pending} aria-label={`Remove recipe ${job.number}`} onClick={() => send('admin/cancel', { jobId: job.id })}>×</button>}
          </div>)}{!data?.jobs.length && <p className="live-empty">{query.isPending ? 'Connecting to the session…' : 'The first recipe could be yours.'}</p>}</div>
          <div className="live-goal"><span className="live-goal-icon">↗</span><p><strong>A lab job, sent from your phone.</strong><br />Submit a recipe. Join the queue. See it happen in the real world.</p></div>
        </section>
      </div>
    </>}
    <footer className="live-footer"><span>URSA LABORATORIES <i>×</i> CURIOUS HUMANS</span><p>Colored bands show ingredient proportions. The physical mixture’s appearance depends on the dyes.</p><span>THE LAB IS CONNECTED.</span></footer>
  </div></main>;
}
