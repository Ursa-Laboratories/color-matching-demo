import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FluidStateSummary } from "../../types";
import { overnightApi } from "./api";
import type { OvernightJob, OvernightQueuePrepare, OvernightQueueRecord } from "./types";
import "./OvernightQueuePanel.css";

const terminalStates = new Set(["completed", "failed", "cancelled", "interrupted", "blocked"]);
const targetDefaults = ["#e63946", "#f4a261", "#e9c46a", "#2a9d8f", "#457b9d"];

type Props = {
  gantryFile: string | null;
  deckFile: string | null;
  protocolFile: string | null;
  fluidStates: FluidStateSummary[];
};

type TargetDraft = { name: string; hex: string; wells: string };
type SavedColorDraft = {
  redSource?: string; yellowSource?: string; blueSource?: string; diluentEnabled?: boolean;
  diluentSource?: string; cameraInstrument?: string; roiFraction?: number; captureImageHeight?: string;
};

function words(value?: string | null): string {
  return value ? value.replaceAll("_", " ") : "-";
}

function outcome(job: OvernightJob): string {
  if (job.state !== "completed") return words(job.error || job.stop_reason || job.state);
  const reason = words(job.stop_reason);
  if (/target reached/i.test(reason)) return "Target reached";
  if (/budget|trials|max/i.test(reason)) return "Budget exhausted";
  return reason === "-" ? "Completed" : reason;
}

function defaultCandidateWells(): string[] {
  const wells: string[] = [];
  for (const row of "ABCDEFGH") {
    for (let column = 1; column <= 12; column += 1) {
      const well = `plate.${row}${column}`;
      if (!["plate.A1", "plate.A2", "plate.A3"].includes(well)) wells.push(well);
    }
  }
  return wells.slice(0, 40);
}

function initialTargets(): TargetDraft[] {
  const wells = defaultCandidateWells();
  return targetDefaults.map((hex, index) => ({
    name: `Target ${index + 1}`,
    hex,
    wells: wells.slice(index * 8, index * 8 + 8).join(", "),
  }));
}

function rgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16)) as [number, number, number];
}

function savedColorDraft(): SavedColorDraft {
  try {
    const value = localStorage.getItem("cubos.active-learning.preset-workspace");
    return value ? JSON.parse(value) as SavedColorDraft : {};
  } catch {
    return {};
  }
}

export default function OvernightQueuePanel({ gantryFile, deckFile, protocolFile, fluidStates }: Props) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [queueName, setQueueName] = useState("Overnight color run");
  const [fluidStateId, setFluidStateId] = useState<number | null>(fluidStates[0]?.id ?? null);
  const [targets, setTargets] = useState<TargetDraft[]>(initialTargets);
  const [formError, setFormError] = useState<string | null>(null);
  const startingRef = useRef(false);
  const cancellingRef = useRef(false);
  const queues = useQuery({ queryKey: ["overnight-queues"], queryFn: overnightApi.list, refetchInterval: 5000 });
  const effectiveFluidStateId = fluidStateId ?? fluidStates[0]?.id ?? null;
  const effectiveId = selectedId || queues.data?.[0]?.queue_id || "";
  const queue = useQuery({ queryKey: ["overnight-queue", effectiveId], queryFn: () => overnightApi.get(effectiveId), enabled: Boolean(effectiveId), refetchInterval: (query) => query.state.data && !terminalStates.has(query.state.data.state) ? 2000 : false });
  const update = (record: OvernightQueueRecord) => {
    setSelectedId(record.queue_id);
    queryClient.setQueryData(["overnight-queue", record.queue_id], record);
    void queryClient.invalidateQueries({ queryKey: ["overnight-queues"] });
  };
  const prepare = useMutation({ mutationFn: overnightApi.prepare, onSuccess: update });
  const start = useMutation({ mutationFn: overnightApi.start, onSuccess: update });
  const cancel = useMutation({ mutationFn: overnightApi.cancel, onSuccess: update });

  const updateTarget = (index: number, patch: Partial<TargetDraft>) => {
    setTargets((current) => current.map((target, itemIndex) => itemIndex === index ? { ...target, ...patch } : target));
  };
  const buildRequest = (): OvernightQueuePrepare => {
    if (!queueName.trim()) throw new Error("Enter a queue name.");
    if (!gantryFile || !deckFile || !protocolFile) throw new Error("Select the CubOS gantry, deck, and source protocol first.");
    if (!effectiveFluidStateId) throw new Error("Select the durable fluid state that matches the physical deck.");
    const draft = savedColorDraft();
    const wellGroups = targets.map((target) => target.wells.split(/[\n,]/).map((well) => well.trim()).filter(Boolean));
    if (wellGroups.some((wells) => wells.length !== 8)) throw new Error("Each target needs exactly eight candidate wells.");
    const allWells = wellGroups.flat();
    if (new Set(allWells).size !== 40) throw new Error("The five targets need 40 distinct candidate wells.");
    if (allWells.some((well) => ["plate.A1", "plate.A2", "plate.A3"].includes(well))) throw new Error("Candidate wells cannot include plate.A1 through plate.A3.");
    return {
      name: queueName.trim(),
      jobs: targets.map((target, index) => {
        const targetRgb = rgb(target.hex);
        return {
          name: target.name.trim() || `Target ${index + 1}`,
          target_rgb: targetRgb,
          optimizer_seed: 7 + index,
          color_setup: {
            gantry_file: gantryFile,
            deck_file: deckFile,
            source_protocol_file: protocolFile,
            batch_size: 3,
            target_mode: "rgb",
            target_rgb: targetRgb,
            target_well: "plate.A1",
            reference_origin: "user_selected_srgb",
            red_source: draft.redSource ?? "stocks.A1",
            yellow_source: draft.yellowSource ?? "stocks.A2",
            blue_source: draft.blueSource ?? "stocks.A3",
            diluent_source: draft.diluentEnabled ? draft.diluentSource ?? "stocks.A4" : null,
            component_min_ul: 25,
            component_max_ul: 100,
            total_volume_ul: 150,
            candidate_wells: wellGroups[index]!,
            camera_instrument: draft.cameraInstrument ?? "camera",
            roi_fraction: draft.roiFraction ?? 0.5,
            image_height: draft.captureImageHeight ? Number(draft.captureImageHeight) : null,
            photo_position: null,
            fluid_state_id: effectiveFluidStateId,
            mock_mode: false,
          },
        };
      }),
    };
  };
  const prepareQueue = () => {
    try {
      setFormError(null);
      prepare.mutate(buildRequest());
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };
  const startQueue = (queueId: string) => {
    if (startingRef.current) return;
    startingRef.current = true;
    start.mutate(queueId, { onSettled: () => { startingRef.current = false; } });
  };
  const cancelQueue = (queueId: string) => {
    if (cancellingRef.current) return;
    cancellingRef.current = true;
    cancel.mutate(queueId, { onSettled: () => { cancellingRef.current = false; } });
  };
  const record = queue.data;
  const error = formError ?? prepare.error ?? start.error ?? cancel.error ?? queue.error ?? queues.error;

  return (
    <section className="overnight-panel">
      <header className="overnight-header">
        <div><span>Persistent queue</span><h2>Overnight runs</h2><p>Prepare five color targets, review resource use, then hand the queue to the learning server.</p></div>
        <label>Saved queue<select aria-label="Prepared overnight queue" value={effectiveId} onChange={(event) => setSelectedId(event.target.value)}><option value="">Choose a prepared queue</option>{(queues.data ?? []).map((item) => <option key={item.queue_id} value={item.queue_id}>{item.name} / {words(item.state)}</option>)}</select></label>
      </header>

      <details className="overnight-prepare" open={!record}>
        <summary><span>Prepare a new queue</span><small>5 targets / 40 distinct wells / 150 µL per sample</small></summary>
        <div className="overnight-prepare-content">
          <div className="overnight-shared-fields">
            <label>Queue name<input aria-label="Overnight queue name" value={queueName} onChange={(event) => setQueueName(event.target.value)} /></label>
            <label>Fluid state<select aria-label="Overnight fluid state" value={effectiveFluidStateId ?? ""} onChange={(event) => setFluidStateId(event.target.value ? Number(event.target.value) : null)}><option value="">Select state</option>{fluidStates.map((state) => <option key={state.id} value={state.id}>#{state.id} {state.label || "Unlabelled state"}</option>)}</select></label>
            <div><span>Setup files</span><strong>{gantryFile ?? "No gantry"} / {deckFile ?? "No deck"} / {protocolFile ?? "No protocol"}</strong></div>
          </div>
          <div className="overnight-targets">
            {targets.map((target, index) => <fieldset key={index}><legend>Target {index + 1}</legend><label>Name<input aria-label={`Overnight target ${index + 1} name`} value={target.name} onChange={(event) => updateTarget(index, { name: event.target.value })} /></label><label>Color<span className="overnight-color-input"><input aria-label={`Overnight target ${index + 1} color`} type="color" value={target.hex} onChange={(event) => updateTarget(index, { hex: event.target.value })} /><code>{target.hex.toUpperCase()}</code></span></label><label>Eight candidate wells<textarea aria-label={`Overnight target ${index + 1} wells`} value={target.wells} onChange={(event) => updateTarget(index, { wells: event.target.value })} /></label></fieldset>)}
          </div>
          <div className="overnight-prepare-footer"><p>Preparation validates inventory and snapshots the selected CubOS setup. It does not start hardware.</p><button type="button" className="overnight-primary" disabled={prepare.isPending} onClick={prepareQueue}>{prepare.isPending ? "Preparing" : "Prepare queue"}</button></div>
        </div>
      </details>

      <div className="overnight-camera-note">Mac webcam recording needs this browser to stay open. Pi well captures and the overnight queue continue without it.</div>
      {error && <div className="overnight-banner overnight-error" role="alert">{error instanceof Error ? error.message : String(error)}</div>}
      {!effectiveId && !queues.isLoading && <div className="overnight-empty">No prepared queues yet. Complete the form above to create one.</div>}
      {queue.isLoading && <div className="overnight-empty">Loading prepared queue</div>}

      {record && <><div className="overnight-toolbar"><div><strong>{record.name}</strong><span className={`overnight-state overnight-state-${record.state}`}>{words(record.state)}</span></div><div>{record.state === "prepared" && <button type="button" className="overnight-primary" disabled={start.isPending} onClick={() => startQueue(record.queue_id)}>{start.isPending ? "Starting" : "Start overnight queue"}</button>}{record.state === "running" && <button type="button" disabled={cancel.isPending || record.cancel_requested} onClick={() => cancelQueue(record.queue_id)}>{cancel.isPending || record.cancel_requested ? "Cancel requested" : "Cancel queue"}</button>}</div></div>
        <div className="overnight-resources" aria-label="Queue resource plan"><div><strong>{record.resource_summary.campaign_count}</strong><span>targets</span></div><div><strong>{record.resource_summary.sample_count}</strong><span>samples</span></div><div><strong>{record.resource_summary.total_volume_ul.toLocaleString()} µL</strong><span>total volume</span></div><div><strong>{record.resource_summary.tip_count}</strong><span>tips</span></div><div><strong>{record.resource_summary.candidate_wells.length}</strong><span>wells</span></div></div>
        {(record.error || record.stop_reason || record.state === "blocked") && <div className={`overnight-banner ${record.state === "completed" ? "overnight-info" : "overnight-error"}`}><strong>{record.state === "blocked" ? "Queue stopped for inspection" : words(record.state)}</strong><span>{record.error || words(record.stop_reason)}</span></div>}
        <div className="overnight-table-wrap"><table className="overnight-table"><thead><tr><th>Target</th><th>Color</th><th>Status</th><th>Samples</th><th>Best delta E00</th><th>Outcome</th></tr></thead><tbody>{record.jobs.map((job) => <tr key={job.job_id} className={job.index === record.current_job_index ? "is-active" : ""}><td><strong>{job.index + 1}. {job.name}</strong></td><td><span className="overnight-swatch" style={{ background: `rgb(${job.target_rgb.join(",")})` }} />{job.target_rgb.join(", ")}</td><td>{words(job.state)}</td><td>{job.trials_completed ?? 0} / 8</td><td>{typeof job.best_objective === "number" ? job.best_objective.toFixed(2) : "-"}</td><td>{outcome(job)}</td></tr>)}</tbody></table></div>
        <footer className="overnight-footnote">150 µL per sample / 3 + 3 + 2 sample batches / {record.resource_summary.gantry_file} / {record.resource_summary.deck_file}</footer></>}
    </section>
  );
}
