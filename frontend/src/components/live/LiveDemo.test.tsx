import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { makeRecipe } from '../../../../shared/recipe.js';
import LiveDemo from './LiveDemo';

type DemoJob = {
  id: string; number: number; name: string; recipe: ReturnType<typeof makeRecipe>;
  status: 'queued' | 'blocked' | 'completed'; well: string | null; runId: string | null;
  resultPhoto?: { id: string; url: string; width: number; height: number; uploadedAt: string; wellLabels: string[] } | null;
};
const makeJob = (id: string, number: number, submission: { red: number; yellow: number; blue: number; name: string }): DemoJob => ({
  id, number, name: submission.name, recipe: makeRecipe(submission), status: 'queued', well: null, runId: null,
});

function state(overrides: Record<string, unknown> = {}) {
  return { eventId: 'event-one', queueRevision: 0, mode: 'simulation', accepting: true, draining: false,
    activeId: null, workerOnline: false, jobs: [], ownJob: null, ...overrides };
}

function renderDemo(view = 'live') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><LiveDemo view={view} /></QueryClientProvider>);
}

function reply(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/?view=live');
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('LiveDemo phone and operator queue flows', () => {
  it('submits a mix, shows its receipt, and submits another mix from the same browser', async () => {
    const jobs: DemoJob[] = [];
    let latest: DemoJob | null = null;
    const submissions: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/state')) return reply(state({ jobs, ownJob: latest }));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      submissions.push(body);
      latest = makeJob(`job-${submissions.length}`, submissions.length, body as never);
      jobs.push(latest);
      return reply(state({ jobs: [...jobs], ownJob: latest }));
    });
    const view = renderDemo();
    await screen.findByRole('button', { name: 'Submit' });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Alex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByRole('button', { name: 'Submit another mixture' });
    view.unmount();
    renderDemo();
    fireEvent.click(await screen.findByRole('button', { name: 'Submit another mixture' }));
    expect(screen.getByLabelText('Your name')).toHaveValue('Alex');
    expect(screen.getByLabelText('Red')).toHaveValue('6');
    fireEvent.change(screen.getByLabelText('Blue'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(submissions).toHaveLength(2));
    expect(submissions[0].submissionId).toBeTruthy();
    expect(submissions[1].submissionId).toBeTruthy();
    expect(submissions[1].submissionId).not.toBe(submissions[0].submissionId);
    expect(submissions[1]).toMatchObject({ name: 'Alex', red: 6, yellow: 3, blue: 4 });
  });

  it('retries the identical frozen payload after a lost response', async () => {
    const submissions: Array<Record<string, unknown>> = [];
    let nextPostFails = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/state')) return reply(state());
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      submissions.push(body);
      if (nextPostFails) { nextPostFails = false; return reply({ error: 'Try again' }, 503); }
      const job = makeJob('job-1', 1, body as never);
      return reply(state({ jobs: [job], ownJob: job }));
    });
    renderDemo();
    await screen.findByRole('button', { name: 'Submit' });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Sam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByRole('button', { name: 'Retry submission' });
    expect(screen.getByLabelText('Red')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry submission' }));
    await screen.findByRole('button', { name: 'Submit another mixture' });
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual(submissions[0]);
  });

  it('restores the phone draft after reload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(state()));
    const first = renderDemo();
    await screen.findByRole('button', { name: 'Submit' });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Mina' } });
    fireEvent.change(screen.getByLabelText('Yellow'), { target: { value: '8' } });
    await waitFor(() => expect(window.localStorage.getItem('ursa-live-phone-v1')).toContain('Mina'));
    first.unmount();
    renderDemo();
    expect(await screen.findByLabelText('Your name')).toHaveValue('Mina');
    expect(screen.getByLabelText('Yellow')).toHaveValue('8');
  });

  it('shows actual completed photos on participant receipts and the talk screen', async () => {
    const job = { ...makeJob('job-1', 1, { red: 6, yellow: 3, blue: 1, name: 'Mina' }), status: 'completed' as const,
      well: 'A1', resultPhoto: { id: 'photo-1', url: '/api/live/photos/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', width: 1200, height: 800, uploadedAt: '2026-10-13T12:00:00Z', wellLabels: ['A1'] } };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(state({ jobs: [job], ownJob: job })));
    window.localStorage.setItem('ursa-live-phone-v1', JSON.stringify({ schemaVersion: 1, eventId: 'event-one', queueRevision: 0,
      mode: 'receipt', parts: { red: 6, yellow: 3, blue: 1 }, name: 'Mina' }));
    const phone = renderDemo();
    const phoneImages = await screen.findAllByRole('img', { name: 'Result photo for well A1' });
    expect(phoneImages[0]).toHaveAttribute('src', job.resultPhoto.url);
    expect(await screen.findAllByRole('region', { name: 'Recipe proportions' })).toHaveLength(1);
    expect(screen.queryByText('Made by CUB')).not.toBeInTheDocument();
    expect(document.querySelector('.live-color-disc')).toBeNull();
    phone.unmount();

    renderDemo('screen');
    const screenImages = await screen.findAllByRole('img', { name: 'Result photo for well A1' });
    expect(screenImages[0]).toHaveAttribute('src', job.resultPhoto.url);
    expect(screen.getByText(/Complete · Mina/)).toBeInTheDocument();
  });

  it('uses an honest placeholder for a completed recipe without an actual photo', async () => {
    const job = { ...makeJob('job-1', 1, { red: 6, yellow: 3, blue: 1, name: 'Mina' }), status: 'completed' as const, well: 'A1' };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(state({ jobs: [job], ownJob: job })));
    window.localStorage.setItem('ursa-live-phone-v1', JSON.stringify({ schemaVersion: 1, eventId: 'event-one', queueRevision: 0,
      mode: 'receipt', parts: { red: 6, yellow: 3, blue: 1 }, name: 'Mina' }));
    renderDemo();
    expect(await screen.findByText('Photo not added yet')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Result photo/ })).not.toBeInTheDocument();
  });

  it('requires reset confirmation and sends the captured queue revision', async () => {
    const jobs = [makeJob('job-1', 1, { red: 6, yellow: 3, blue: 1, name: 'Alex' })];
    let queueRevision = 7;
    const activeId: string | null = null;
    const calls: Array<{ path: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith('/admin/state')) return reply(state({ jobs, queueRevision, activeId }));
      calls.push({ path, body: JSON.parse(String(init?.body)) });
      queueRevision += 1;
      return reply(state({ jobs: [], queueRevision, activeId: null }));
    });
    renderDemo('operator');
    fireEvent.change(await screen.findByLabelText('Operator key'), { target: { value: 'host-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock controls' }));
    const reset = await screen.findByRole('button', { name: 'Reset queue' });
    await waitFor(() => expect(reset).toBeEnabled());
    fireEvent.click(reset);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reset' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].path).toMatch(/\/admin\/reset$/);
    expect(calls[0].body).toEqual({ confirmed: true, queueRevision: 7 });
  });

  it('disables reset while a blocked job is active', async () => {
    const job = { ...makeJob('job-1', 1, { red: 6, yellow: 3, blue: 1, name: 'Alex' }), status: 'blocked' as const };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input).endsWith('/admin/state')
      ? reply(state({ jobs: [job], activeId: job.id })) : reply(state()));
    renderDemo('operator');
    fireEvent.change(await screen.findByLabelText('Operator key'), { target: { value: 'host-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock controls' }));
    await screen.findAllByText('Alex');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reset queue' })).toBeDisabled());
    expect(screen.getByText(/retire the blocked job after checking the physical station/i)).toBeInTheDocument();
  });
});
