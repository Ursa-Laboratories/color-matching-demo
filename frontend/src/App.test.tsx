import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function installApiMock() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/v1/gantry/configs") return json(["gantry.yaml"]);
    if (path === "/api/v1/deck/configs") return json(["deck.yaml"]);
    if (path === "/api/v1/protocol/configs") return json(["protocol.yaml"]);
    if (path === "/api/v1/gantry/gantry.yaml") return json({ filename: "gantry.yaml", config: { serial_port: "", gantry_type: "cub", cnc: { y_axis_motion: "head" }, working_volume: { x_min: 0, x_max: 300, y_min: 0, y_max: 200, z_min: 0, z_max: 80 }, instruments: {} } });
    if (path === "/api/v1/deck/deck.yaml") return json({ filename: "deck.yaml", labware: [] });
    if (path === "/api/v1/protocol/protocol.yaml") return json({ filename: "protocol.yaml", positions: {}, steps: [{ command: "mix", args: { volume_ul: 50, cycles: 3 } }] });
    if (path === "/api/v1/gantry/position") return json({ x: 0, y: 0, z: 0, work_x: 0, work_y: 0, work_z: 0, connected: false, status: "Disconnected", calibration_active: false });
    if (path === "/api/v1/protocol/run-status") return json({ active: false, protocol_file: null });
    if (path === "/api/v1/fluid-states") return json([]);
    if (path === "/api/v1/campaigns/presets") return json([]);
    if (path === "/api/v1/campaigns/overnight") return json([]);
    if (path === "/api/v1/campaigns") return json([]);
    if (path === "/api/v1/station/reservation") return json({ reserved: false, owner: null });
    if (path === "/api/v1/learning/settings") return json({ cubos_operator_url: "http://127.0.0.1:18742" });
    return json({});
  });
}

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  installApiMock();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Ursa Learning app shell", () => {
  it("shows exactly the three requested workspaces and a CubOS handoff", async () => {
    renderApp();
    const nav = screen.getByRole("navigation", { name: "Learning workspace" });
    expect(screen.getByRole("heading", { name: "Ursa Learning" })).toBeInTheDocument();
    expect(nav).toHaveTextContent("Active Learning");
    expect(nav).toHaveTextContent("Color Matching");
    expect(nav).toHaveTextContent("Overnight Runs");
    expect(nav.querySelectorAll("button")).toHaveLength(3);
    await waitFor(() => expect(screen.getByRole("link", { name: "Open CubOS operator" })).toHaveAttribute("href", "http://127.0.0.1:18742"));
  });

  it("keeps generic optimization separate from color setup", async () => {
    const user = userEvent.setup();
    renderApp();
    expect(await screen.findByText("Parameters, optimizer, and budget")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Choose target" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Color Matching" }));
    expect(await screen.findByRole("heading", { name: "Choose target" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Presentation" })).toBeInTheDocument();
  });

  it("opens an overnight preparation workflow from the third tab", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Overnight Runs" }));
    expect(await screen.findByRole("heading", { name: "Overnight runs" })).toBeInTheDocument();
    expect(screen.getByText("Prepare a new queue")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/Overnight target \d color/)).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Prepare queue" })).toBeInTheDocument();
  });
});
