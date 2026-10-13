import { useEffect, useMemo, useRef, useState } from 'react';
import { prepareResultPhoto } from './photo';
import type { PreparedPhoto } from './photo';

export type PhotoJob = {
  id: string;
  number: number;
  name?: string;
  well: string | null;
  status: string;
  resultPhoto?: { id: string; url: string; width: number; height: number; uploadedAt: string; wellLabels: string[] } | null;
};

type PhotoUploadProps = {
  open: boolean;
  presetJobId: string | null;
  jobs: PhotoJob[];
  queueRevision: number;
  pending: boolean;
  onClose: () => void;
  onUpload: (body: { jobIds: string[]; queueRevision: number; image: string }) => Promise<void>;
};

export default function PhotoUpload({ open, presetJobId, jobs, queueRevision, pending, onClose, onUpload }: PhotoUploadProps) {
  const eligibleJobs = useMemo(() => jobs.filter(job => job.status === 'completed' && job.well), [jobs]);
  const eligibleIds = useMemo(() => new Set(eligibleJobs.map(job => job.id)), [eligibleJobs]);
  const eligibleJobsRef = useRef(eligibleJobs);
  eligibleJobsRef.current = eligibleJobs;
  const queueRevisionRef = useRef(queueRevision);
  queueRevisionRef.current = queueRevision;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [prepared, setPrepared] = useState<PreparedPhoto | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [intentRevision, setIntentRevision] = useState(queueRevision);
  const [error, setError] = useState('');
  const sequence = useRef(0);

  useEffect(() => {
    if (!open) return;
    const currentJobs = eligibleJobsRef.current;
    const initial = presetJobId && currentJobs.some(job => job.id === presetJobId)
      ? [presetJobId]
      : currentJobs.filter(job => !job.resultPhoto).map(job => job.id).slice(0, 96);
    setSelectedIds(initial);
    setPrepared(null);
    setError('');
    setIntentRevision(queueRevisionRef.current);
  }, [open, presetJobId]);

  useEffect(() => {
    if (!open) return;
    setSelectedIds(current => current.filter(id => eligibleIds.has(id)));
  }, [open, eligibleIds]);

  useEffect(() => {
    if (!open || intentRevision === queueRevision) return;
    sequence.current++;
    setPreparing(false);
    setPrepared(null);
    setSelectedIds([]);
    setError('The queue changed. Close this panel and review the completed mixes again.');
  }, [open, intentRevision, queueRevision]);

  useEffect(() => {
    if (open) return;
    sequence.current++;
    setPreparing(false);
    setPrepared(null);
    setError('');
  }, [open]);

  useEffect(() => {
    if (!prepared) {
      setPreviewUrl('');
      return;
    }
    try {
      const url = URL.createObjectURL(prepared.blob);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    } catch {
      setPreviewUrl(prepared.dataUrl);
    }
  }, [prepared]);

  if (!open) return null;

  const toggleJob = (jobId: string) => {
    setSelectedIds(current => current.includes(jobId)
      ? current.filter(id => id !== jobId)
      : current.length < 96 ? [...current, jobId] : current);
  };

  const selectFile = async (file?: File) => {
    const current = ++sequence.current;
    setPrepared(null);
    setError('');
    if (!file) { setPreparing(false); return; }
    setPreparing(true);
    try {
      const result = await prepareResultPhoto(file);
      if (current === sequence.current) setPrepared(result);
    } catch (cause) {
      if (current === sequence.current) setError(cause instanceof Error ? cause.message : 'This photo could not be prepared. Try another image.');
    } finally {
      if (current === sequence.current) setPreparing(false);
    }
  };

  const save = async () => {
    if (!prepared || !selectedIds.length) return;
    setError('');
    try {
      await onUpload({ jobIds: selectedIds, queueRevision: intentRevision, image: prepared.dataUrl });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The photo could not be saved. Try again.');
    }
  };

  return <section className="live-photo-upload" aria-labelledby="live-photo-title">
    <div className="live-photo-upload-heading"><div><span className="live-kicker">RESULT PHOTO</span><h2 id="live-photo-title">Add one photo to completed mixes.</h2></div>
      <button type="button" className="live-photo-close" onClick={onClose}>Close</button></div>
    <p className="live-photo-help">The same photo will appear on participant phones and the talk screen for each selected mix. Well labels keep each result clear.</p>
    <fieldset className="live-photo-jobs">
      <legend>Choose completed mixes</legend>
      {eligibleJobs.length ? eligibleJobs.map(job => <label key={job.id}>
        <input type="checkbox" aria-label={`${job.name || `Mix #${String(job.number).padStart(3, '0')}`}, well ${job.well}, ${job.resultPhoto ? 'replace photo' : 'photo not added yet'}`}
          checked={selectedIds.includes(job.id)} onChange={() => toggleJob(job.id)} disabled={!selectedIds.includes(job.id) && selectedIds.length >= 96} />
        <span><strong>{job.name || `Mix #${String(job.number).padStart(3, '0')}`}</strong><small>{job.well}{job.resultPhoto ? ' · Replace photo' : ' · Photo not added yet'}</small></span>
      </label>) : <p>No completed mixes with a well are ready for a photo.</p>}
    </fieldset>
    <div className="live-photo-picker">
      <label className="live-secondary">Take photo
        <input id="live-photo-camera" className="live-file-input" aria-label="Take photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={pending || intentRevision !== queueRevision} onChange={event => { void selectFile(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
      </label>
      <label className="live-secondary">Choose photo
        <input id="live-photo-file" className="live-file-input" aria-label="Choose photo" type="file" accept="image/jpeg,image/png,image/webp" disabled={pending || intentRevision !== queueRevision} onChange={event => { void selectFile(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
      </label>
    </div>
    {preparing && <p className="live-photo-status" role="status">Preparing a smaller photo…</p>}
    {error && <p className="live-photo-error" role="alert">{error}</p>}
    {prepared && <div className="live-photo-preview"><img src={previewUrl} alt="Preview of the photo to add" />
      <p>Your photo will be shown as the result.</p>
    </div>}
    <div className="live-photo-actions">
      <button className="live-primary" type="button" disabled={pending || preparing || !prepared || !selectedIds.length || intentRevision !== queueRevision} onClick={() => { void save(); }}>Save result photo</button>
      <button type="button" className="live-photo-cancel" disabled={pending} onClick={onClose}>Cancel</button>
    </div>
  </section>;
}
