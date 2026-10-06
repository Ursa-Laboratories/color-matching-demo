# Move a color-demo station to Ursa Learning

The existing CubOS branch and station data are not modified by building this project. Test the extracted version against a separate offline station first. Upgrade a physical station only with an operator present.

## Ownership

Ursa Learning stores campaign and queue records, saved optimization presets, frozen setup inputs, target review revisions, and downloaded evidence. CubOS stores execution records, protocol results and original artifacts, calibrated station configuration, and authoritative fluid/tip/cap state. A station reservation excludes unrelated writes between trials; the server validates every submitted bundle against current state.

The frontend talks to Ursa Learning. Its backend makes authenticated HTTP calls to CubOS. Same-origin browser protections stay enabled. Station credentials remain on the backend.

## Prerequisite API

The CubOS `refactor/external-learning-api` branch exposes generic external orchestration contracts. Existing `/api/v1/runs` handles submit, status, cancel, events, plan and artifact downloads. Added contracts provide run validation, category-specific configuration reads, current state validation with dead volumes, station status/reservations, and immutable measurement evidence. These contracts contain no optimizer, color campaign, or overnight queue.

Do not point the new app at an old server lacking the reservation/validation contract. Do not bypass validation to make an older station work.

## Back up existing records

Before an appliance upgrade, copy its entire configured CubOS data directory to a dated backup. Preserve calibrated gantry/deck YAML, database, native runs, campaigns, overnight queues, saved presets, and camera images together. Read the station's settings to locate them; do not assume all stations use the same path. Do not regenerate live calibration or inventory from repository examples.

The extracted app uses a different data directory. Old campaign/queue histories remain readable on the previous CubOS version until deliberately imported or archived. Existing in-flight campaigns must finish or be cancelled by the operator before switching applications. Never run both orchestrators on the same station.

## Operator validation procedure

1. On an offline test CubOS server, verify the three tabs load, source configuration filenames come from that server, and generic validation rejects invalid protocol arguments. Run a mock scalar-objective campaign and confirm suggestions, manual observations, minimize/maximize and stopping budgets.
2. Reserve the offline station through Ursa Learning. In a separate CubOS browser, attempt setup edits and an unrelated run. Confirm conflict responses while owner protocol submission still succeeds. Release the campaign and confirm normal access returns.
3. Stop each server between trials. Restart it and confirm no protocol is replayed or automatically resumed. Review the last native run and release/reconcile the reservation explicitly before restarting a campaign.
4. Complete an offline RGB color campaign. Check batches, results and best-so-far. Prepare an overnight queue, check frozen inputs and stock/tip budget failures, start it and cancel it. Verify queue state survives reload.
5. Before physical work, back up the station and verify the gantry is disconnected. Inspect calibrated bounds, deck anchors, safe travel height, attached-tip state, stock volumes and candidate wells in CubOS. Load the preserved live configurations rather than repository examples.
6. With the operator at the emergency stop, connect the station in CubOS. Use the existing calibrated target protocol to acquire one reference image through Ursa Learning. Confirm camera position, accepted center, acquisition fingerprint and processing profile, then review/reanalyze the frozen image. Verify no motion occurs during reanalysis.
7. Run a small supervised color batch with disposable water/dye samples and enough tips. Observe pickup/drop, aspirate/dispense/mixing, collision-free travel, capture, quality gates, current inventory updates and the returned native run ID. Exercise pause and cancellation before authorizing a longer run.
8. Force a safe inventory shortage in the offline station first. Confirm awaiting-refill preserves the pending batch; after the operator reconciles the physical state, explicitly resume it and verify the exact batch is submitted once. Never simulate a hardware failure by obstructing live motion.
9. Validate the existing five-job overnight preset under supervision before an unattended run. The retained queue preset uses five distinct RGB targets, eight candidates per target, batch size three, 150 µL samples and 25–100 µL dye bounds. Inspect job outcomes, unscored photometric samples, immutable evidence ZIP and cancellation. Unattended operation remains pending until these physical checks pass.

## Validation status

Physical hardware tested during extraction: none. Potentially affected hardware: every instrument/gantry reached through the CubOS run API, especially pipette and camera sequences in the color workflow. Offline checks cover the HTTP boundary and retained application behavior. Physical movement, dispensing accuracy, camera alignment and unattended reliability require the procedure above.

## Explicit reservation recovery

When a server restart or network outage leaves an interrupted campaign, inspect its saved native run ID in CubOS first. Wait for any active run to finish or cancel it in CubOS, reconcile uncertain physical state, then use Ursa Learning’s reservation recovery control. This releases only the recorded owner and does not resume the campaign. If the application lost its local private token file, use CubOS’s operator release API with its normal authentication and an exact owner confirmation:

```sh
curl -X POST http://127.0.0.1:8742/api/v1/station/reservation/operator-release \
  -H "Content-Type: application/json" \
  -d '{"owner":"CAMPAIGN_ID","confirmation":"release CAMPAIGN_ID"}'
```

Replace both `CAMPAIGN_ID` values with the actual owner shown by station status. Add your configured CubOS bearer authentication for a native client. The endpoint refuses release during an active run.
