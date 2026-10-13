import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PhotoUpload from './PhotoUpload';
import type { PhotoJob } from './PhotoUpload';
import type { PreparedPhoto } from './photo';

vi.mock('./photo', () => ({ prepareResultPhoto: vi.fn() }));
import { prepareResultPhoto } from './photo';

const prepared: PreparedPhoto = {
  blob: new Blob(['small jpeg'], { type: 'image/jpeg' }),
  dataUrl: 'data:image/jpeg;base64,c21hbGw=', width: 1200, height: 800,
};
const jobs: PhotoJob[] = [
  { id: 'mix-1', number: 1, name: 'Mina', well: 'A1', status: 'completed', resultPhoto: null },
  { id: 'mix-2', number: 2, name: 'Joe', well: 'B2', status: 'completed', resultPhoto: null },
  { id: 'mix-3', number: 3, name: 'Lee', well: 'C3', status: 'completed', resultPhoto: { id: 'photo-old', url: '/api/live/photos/abc', width: 100, height: 80, uploadedAt: '', wellLabels: ['C3'] } },
  { id: 'mix-4', number: 4, name: 'Next', well: null, status: 'queued' },
  { id: 'mix-5', number: 5, name: 'Hold', well: 'D4', status: 'blocked' },
];

function renderPanel(props: Partial<Parameters<typeof PhotoUpload>[0]> = {}) {
  const onUpload = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const view = render(<PhotoUpload open presetJobId={null} jobs={jobs} queueRevision={8} pending={false} onUpload={onUpload} onClose={onClose} {...props} />);
  return { ...view, onUpload, onClose };
}

beforeEach(() => {
  vi.mocked(prepareResultPhoto).mockResolvedValue(prepared);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:photo-preview');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

async function choosePhoto() {
  fireEvent.change(screen.getByLabelText('Choose photo'), { target: { files: [new File(['photo'], 'result.png', { type: 'image/png' })] } });
  await screen.findByRole('img', { name: 'Preview of the photo to add' });
}

describe('PhotoUpload', () => {
  it('defaults to completed mixes without photos and submits one selected photo for both wells on save', async () => {
    const { onUpload, onClose } = renderPanel();
    await waitFor(() => expect(screen.getByLabelText(/Mina, well A1/i)).toBeChecked());
    expect(screen.getByLabelText(/Joe, well B2/i)).toBeChecked();
    expect(screen.getByLabelText(/Lee, well C3/i)).not.toBeChecked();
    expect(screen.queryByLabelText(/Next/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Hold/)).not.toBeInTheDocument();
    await choosePhoto();
    expect(onUpload).not.toHaveBeenCalled();
    expect(screen.getByText(/participant phones and the talk screen/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save result photo' }));
    await waitFor(() => expect(onUpload).toHaveBeenCalledWith({
      jobIds: ['mix-1', 'mix-2'], queueRevision: 8, image: prepared.dataUrl,
    }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps a prepared photo and explicit selection when polling adds an unrelated queued mix', async () => {
    const onUpload = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const view = render(<PhotoUpload open presetJobId={null} jobs={jobs} queueRevision={8} pending={false} onUpload={onUpload} onClose={onClose} />);
    await waitFor(() => expect(screen.getByLabelText(/Joe, well B2/i)).toBeChecked());
    fireEvent.click(screen.getByLabelText(/Joe, well B2/i));
    await choosePhoto();
    view.rerender(<PhotoUpload open presetJobId={null} jobs={[...jobs, { id: 'mix-6', number: 6, name: 'New', well: null, status: 'queued' }]} queueRevision={8} pending={false} onUpload={onUpload} onClose={onClose} />);
    expect(await screen.findByRole('img', { name: 'Preview of the photo to add' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Mina, well A1/i)).toBeChecked();
    expect(screen.getByLabelText(/Joe, well B2/i)).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save result photo' }));
    await waitFor(() => expect(onUpload).toHaveBeenCalledWith({ jobIds: ['mix-1'], queueRevision: 8, image: prepared.dataUrl }));
  });

  it('preselects a completed mix for replacement and reports API errors without closing', async () => {
    const onUpload = vi.fn().mockRejectedValue(new Error('Queue changed. Review and try again.'));
    const { onClose } = renderPanel({ presetJobId: 'mix-3', onUpload });
    await waitFor(() => expect(screen.getByLabelText(/Lee, well C3/i)).toBeChecked());
    expect(screen.getByText(/Replace photo/)).toBeInTheDocument();
    await choosePhoto();
    fireEvent.click(screen.getByRole('button', { name: 'Save result photo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Queue changed. Review and try again.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('invalidates the selected photo when its captured queue revision becomes stale', async () => {
    const { rerender, onUpload } = renderPanel();
    await choosePhoto();
    rerender(<PhotoUpload open presetJobId={null} jobs={jobs} queueRevision={9} pending={false} onUpload={onUpload} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/queue changed/i);
    expect(screen.getByRole('button', { name: 'Save result photo' })).toBeDisabled();
    expect(onUpload).not.toHaveBeenCalled();
  });
});
