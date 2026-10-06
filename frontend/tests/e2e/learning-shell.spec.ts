import { expect, test } from "@playwright/test";

test("navigates the three learning workspaces against a mocked API", async ({ page }) => {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/gantry/configs") return route.fulfill({ json: ["gantry.yaml"] });
    if (path === "/api/v1/deck/configs") return route.fulfill({ json: ["deck.yaml"] });
    if (path === "/api/v1/protocol/configs") return route.fulfill({ json: ["protocol.yaml"] });
    if (path === "/api/v1/gantry/gantry.yaml") return route.fulfill({ json: { filename: "gantry.yaml", config: { gantry_type: "cub", serial_port: "", cnc: { y_axis_motion: "head" }, working_volume: { x_min: 0, x_max: 300, y_min: 0, y_max: 200, z_min: 0, z_max: 80 }, instruments: {} } } });
    if (path === "/api/v1/deck/deck.yaml") return route.fulfill({ json: { filename: "deck.yaml", labware: [] } });
    if (path === "/api/v1/protocol/protocol.yaml") return route.fulfill({ json: { filename: "protocol.yaml", positions: {}, steps: [{ command: "mix", args: { cycles: 3, volume_ul: 50 } }] } });
    if (path === "/api/v1/gantry/position") return route.fulfill({ json: { x: 0, y: 0, z: 0, work_x: 0, work_y: 0, work_z: 0, status: "Disconnected", connected: false, calibration_active: false } });
    if (path === "/api/v1/protocol/run-status") return route.fulfill({ json: { active: false, protocol_file: null } });
    if (path === "/api/v1/station/reservation") return route.fulfill({ json: { reserved: false, owner: null } });
    if (path === "/api/v1/learning/settings") return route.fulfill({ json: { cubos_operator_url: "http://127.0.0.1:18742" } });
    return route.fulfill({ json: [] });
  });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Ursa Learning" })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Learning workspace" });
  await expect(nav.getByRole("button")).toHaveCount(3);
  await expect(page.getByText("Parameters, optimizer, and budget")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open CubOS operator" })).toHaveAttribute("href", "http://127.0.0.1:18742");
  await expect(page.getByText(/Movement, calibration, and configuration editing remain in CubOS/)).toBeVisible();

  await nav.getByRole("button", { name: "Color Matching" }).click();
  await expect(page.getByRole("heading", { name: "Choose target" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Presentation" })).toBeVisible();

  await nav.getByRole("button", { name: "Overnight Runs" }).click();
  await expect(page.getByRole("heading", { name: "Overnight runs" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare queue" })).toBeVisible();
});
