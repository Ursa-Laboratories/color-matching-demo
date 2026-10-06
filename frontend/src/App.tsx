import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import CampaignPanel from "./components/campaigns/CampaignPanel";
import { campaignApi } from "./components/campaigns/api";
import DemoPresentation from "./components/demo/DemoPresentation";
import OvernightQueuePanel from "./components/overnight/OvernightQueuePanel";
import AppLayout from "./components/layout/AppLayout";
import DeckVisualization from "./components/deck/DeckVisualization";
import { useDeck, useDeckConfigs } from "./hooks/useDeck";
import { useFluidStates } from "./hooks/useFluidState";
import { useGantry, useGantryConfigs, useGantryPosition } from "./hooks/useGantryPosition";
import { useProtocol, useProtocolConfigs, useRunStatus } from "./hooks/useProtocol";
import "./App.css";

type Workspace = "Active Learning" | "Color Matching" | "Overnight Runs";

const WORKSPACES: Workspace[] = ["Active Learning", "Color Matching", "Overnight Runs"];
const DEFAULT_CUBOS_OPERATOR_URL = "http://127.0.0.1:8742";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error((await response.text()) || `${response.status} request failed`);
  return response.json() as Promise<T>;
}

function LearningApp() {
  const [workspace, setWorkspace] = useState<Workspace>("Active Learning");
  const [stationOpen, setStationOpen] = useState(true);
  const [uiTheme, setUiTheme] = useState<"light" | "dark">(
    () => document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  const [gantrySelection, setGantryFile] = useState<string | null>(null);
  const [deckSelection, setDeckFile] = useState<string | null>(null);
  const [protocolSelection, setProtocolFile] = useState<string | null>(null);

  const gantryConfigs = useGantryConfigs();
  const deckConfigs = useDeckConfigs();
  const protocolConfigs = useProtocolConfigs();
  const gantryFile = gantrySelection ?? gantryConfigs.data?.[0] ?? null;
  const deckFile = deckSelection ?? deckConfigs.data?.[0] ?? null;
  const protocolFile = protocolSelection ?? protocolConfigs.data?.[0] ?? null;
  const gantry = useGantry(gantryFile);
  const deck = useDeck(deckFile);
  const protocol = useProtocol(protocolFile);
  const runStatus = useRunStatus();
  const position = useGantryPosition(stationOpen);
  const fluidStates = useFluidStates();
  const campaigns = useQuery({ queryKey: ["learning-campaigns-shell"], queryFn: campaignApi.list, refetchInterval: 3000 });
  const learningSettings = useQuery({
    queryKey: ["learning-settings"],
    queryFn: () => fetch("/api/v1/learning/settings").then((response) => readJson<{ cubos_operator_url: string }>(response)),
    staleTime: 30_000,
  });
  const cubosOperatorUrl = import.meta.env.VITE_CUBOS_OPERATOR_URL
    || learningSettings.data?.cubos_operator_url
    || DEFAULT_CUBOS_OPERATOR_URL;
  const reservation = useQuery({
    queryKey: ["station-reservation"],
    queryFn: () => fetch("/api/v1/station/reservation").then((response) => readJson<{ reserved: boolean; owner: string | null }>(response)),
    refetchInterval: 3000,
  });
  const releaseReservation = useMutation({
    mutationFn: async (owner: string) => {
      if (!window.confirm(`Release the stale station reservation owned by ${owner}? Only continue after confirming no experiment is active.`)) return false;
      await fetch("/api/v1/learning/reservation/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, confirmed: true }),
      }).then((response) => readJson<unknown>(response));
      return true;
    },
    onSuccess: (released) => { if (released) void reservation.refetch(); },
  });

  const setupErrors = [gantryConfigs.error, deckConfigs.error, protocolConfigs.error, fluidStates.error]
    .filter((error): error is Error => error instanceof Error);
  const ready = Boolean(gantryFile && deckFile && protocolFile && gantry.data && deck.data && protocol.data);
  const disabledReason = ready ? null : "Select a CubOS gantry, deck, and protocol before configuring a campaign.";
  const appCampaignActive = (campaigns.data ?? []).some((record) => !["completed", "stopped", "failed", "interrupted"].includes(record.state));
  const activeRun = Boolean(runStatus.data?.active || appCampaignActive);
  const workingVolume = gantry.data?.config.working_volume;
  const machineXRange = useMemo<[number, number]>(() => [
    workingVolume?.x_min ?? 0,
    workingVolume?.x_max ?? 300,
  ], [workingVolume]);
  const machineYRange = useMemo<[number, number]>(() => [
    workingVolume?.y_min ?? 0,
    workingVolume?.y_max ?? 200,
  ], [workingVolume]);

  const toggleTheme = () => {
    setUiTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("ursa-learning-theme", next);
      return next;
    });
  };

  const header = (
    <>
      <a className="learning-brand" href="/" aria-label="Ursa Learning home">
        <span className="learning-brand-mark" aria-hidden="true">UL</span>
        <span><h1>Ursa Learning</h1><small>Experiment optimization</small></span>
      </a>
      <nav className="learning-tabs" aria-label="Learning workspace">
        {WORKSPACES.map((item) => (
          <button key={item} type="button" aria-current={workspace === item ? "page" : undefined} onClick={() => setWorkspace(item)}>
            {item}
          </button>
        ))}
      </nav>
      <div className="learning-header-actions">
        {workspace === "Color Matching" && <a className="learning-cubos-link" href="?view=demo">Presentation</a>}
        <a className="learning-cubos-link" href={cubosOperatorUrl} target="_blank" rel="noreferrer">Open CubOS operator</a>
        <button className="learning-theme-toggle" type="button" onClick={toggleTheme} aria-label="Toggle theme">
          {uiTheme === "dark" ? "Light" : "Dark"}
        </button>
      </div>
    </>
  );

  const setupBar = (
    <section className="learning-setup" aria-label="CubOS experiment setup">
      <div><strong>Station setup</strong><span>Choose the station setup for this experiment.</span></div>
      <label>Gantry<select aria-label="Gantry configuration" value={gantryFile ?? ""} onChange={(event) => setGantryFile(event.target.value || null)}><option value="">Select gantry</option>{(gantryConfigs.data ?? []).map((name) => <option key={name}>{name}</option>)}</select></label>
      <label>Deck<select aria-label="Deck configuration" value={deckFile ?? ""} onChange={(event) => setDeckFile(event.target.value || null)}><option value="">Select deck</option>{(deckConfigs.data ?? []).map((name) => <option key={name}>{name}</option>)}</select></label>
      <label>Protocol<select aria-label="Protocol configuration" value={protocolFile ?? ""} onChange={(event) => setProtocolFile(event.target.value || null)}><option value="">Select protocol</option>{(protocolConfigs.data ?? []).map((name) => <option key={name}>{name}</option>)}</select></label>
    </section>
  );

  const campaignProps = {
    gantryFile,
    deckFile,
    protocolFile,
    protocolSteps: protocol.data?.steps ?? [],
    deck: deck.data ?? null,
    gantry: gantry.data ?? null,
    availableFluidStates: fluidStates.data ?? [],
    disabledReason,
  };

  const left = (
    <div className="learning-main">
      {setupBar}
      {setupErrors.length > 0 && <div className="learning-error" role="alert"><strong>CubOS setup could not be loaded.</strong>{setupErrors.map((error) => <span key={error.message}>{errorMessage(error)}</span>)}</div>}
      {workspace === "Active Learning" && <CampaignPanel key="generic" {...campaignProps} mode="generic" />}
      {workspace === "Color Matching" && <CampaignPanel key="color" {...campaignProps} mode="color" />}
      {workspace === "Overnight Runs" && <OvernightQueuePanel gantryFile={gantryFile} deckFile={deckFile} protocolFile={protocolFile} fluidStates={fluidStates.data ?? []} />}
    </div>
  );

  const topRight = (
    <div className="learning-deck-monitor">
      <div className="learning-station-heading"><span>Connected station</span><strong>Live deck</strong></div>
      <DeckVisualization deck={deck.data ?? null} instruments={gantry.data?.config.instruments ?? null} gantryPosition={position.data ?? null} machineXRange={machineXRange} machineYRange={machineYRange} yAxisMotion={gantry.data?.config.cnc?.y_axis_motion ?? "head"} />
    </div>
  );

  const bottomRight = (
    <div className="learning-telemetry" aria-label="Read-only CubOS station status">
      <div className="learning-station-heading"><span>CubOS telemetry</span><strong>{position.data?.connected ? "Connected" : "Offline"}</strong></div>
      <dl>
        <div><dt>Controller</dt><dd>{position.data?.status ?? "Unavailable"}</dd></div>
        <div><dt>Work X</dt><dd>{position.data?.work_x?.toFixed(3) ?? "-"} mm</dd></div>
        <div><dt>Work Y</dt><dd>{position.data?.work_y?.toFixed(3) ?? "-"} mm</dd></div>
        <div><dt>Work Z</dt><dd>{position.data?.work_z?.toFixed(3) ?? "-"} mm</dd></div>
      </dl>
      {reservation.data?.reserved && !activeRun && reservation.data.owner && <button type="button" className="learning-release-reservation" disabled={releaseReservation.isPending} onClick={() => releaseReservation.mutate(reservation.data!.owner!)}>{releaseReservation.isPending ? "Releasing" : "Release stale reservation"}</button>}
      {reservation.data?.reserved && activeRun && <p>A station reservation is active. It can be released after the current run reaches a terminal state.</p>}
      {releaseReservation.error && <div className="learning-reservation-error" role="alert">{errorMessage(releaseReservation.error)} <a href={cubosOperatorUrl} target="_blank" rel="noreferrer">Open CubOS operator</a></div>}
      <p>Movement, calibration, and configuration editing remain in CubOS.</p>
    </div>
  );

  return <AppLayout header={header} left={left} topRight={topRight} bottomRight={bottomRight} stationOpen={stationOpen} onStationOpenChange={setStationOpen} />;
}

export default function App() {
  return new URLSearchParams(window.location.search).get("view") === "demo" ? <DemoPresentation /> : <LearningApp />;
}
