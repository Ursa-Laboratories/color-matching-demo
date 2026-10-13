# Cloud lab mixture demo

Participants scan a QR code, set red/yellow/blue proportions, and submit a recipe.
The host presses **Run**. CUB makes each queued recipe in one fresh well, then
reports completion. Each recipe totals **150 µL**, rounded to **5 µL increments**.
There is no camera measurement or optimization in this live flow.

```text
Phone ──HTTPS──→ Vercel page + Supabase queue
                           ↑
                     HTTPS polling
                           ↓
                Laptop worker ──local Wi-Fi──→ CUB / CubOS
```

Only the laptop needs to reach CUB's Wi-Fi address. Participants can use venue
Wi-Fi or cellular data. The QR opens the web page; it does not join a Wi-Fi
network. Keep CUB private: no port forwarding, public hardware API, or tunnel is
needed. The laptop runs one worker process, with no separate Learning server.

## Hosted setup

Import this repository into Vercel with the repository root as **Root Directory**.
The tracked `vercel.json` builds the frontend and `/api/live/*` Node functions.
Create a **Free Supabase project** directly at https://supabase.com/dashboard;
there is no need to buy a Vercel Marketplace database. In its SQL Editor, run
`supabase/live-demo.sql` once to create the private queue table and atomic update
function. This migration only creates resources named `ursa_live_*`.

In Vercel's project settings, set these server-only variables:

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | Project URL, e.g. `https://PROJECT.supabase.co` |
| `SUPABASE_SECRET_KEY` | Backend secret key from Supabase's API Keys settings |
| `LIVE_ADMIN_TOKEN` | Independent random host key, at least 32 characters |
| `LIVE_WORKER_TOKEN` | Independent random laptop key, at least 32 characters |
| `LIVE_SESSION_SECRET` | Independent random signing secret, at least 32 characters |
| `LIVE_EVENT_ID` | Unique session name, e.g. `damp-mixtures-rehearsal-01` |
| `LIVE_EXECUTION_MODE` | `simulation` for rehearsal; `hardware` for CUB |

Use a password manager to generate the three secrets. Never use `VITE_` prefixes
for secrets or include them in the QR link. Missing configuration fails closed.
For an older Supabase project, `SUPABASE_SERVICE_ROLE_KEY` can hold its legacy
`service_role` JWT instead. Do not use the public publishable/anon key. The table
has RLS enabled with no browser policies; only the backend can read or change it.
Check that a Free project is active before the talk, as inactive projects may
pause. No Supabase login or account is required for audience members.
Keep preview and production event IDs distinct. `VITE_LIVE_DEMO=1` is set by the
Vercel build; ordinary local Learning builds retain the original operator app.

After deploying, use:

- `/` or `/?view=live`: participant sliders and receipt.
- `/?view=operator`: enter the host key, Run/Pause, close submissions, remove waiting jobs.
- `/?view=screen`: QR and live queue for the projector; download the QR PNG here.

Make production publicly accessible without Vercel login protection. Download
the QR from the final production URL and test it on a phone using cellular data.

## Laptop setup and rehearsal

Requires Python 3.11+, Linux/macOS (or a suitable Linux VM), and internet access.
Use the repo's install instructions, then securely set `LIVE_WORKER_TOKEN` to
match the hosted project. Run a simulation first:

```sh
.venv/bin/python -m ursa_learning.live_worker \
  --url https://YOUR-PROJECT.vercel.app \
  --simulate --journal .live-worker/rehearsal.json
```

The website prominently labels simulation. Submit a recipe and press Run from
the host page. Confirm Queued → Running → Complete. Submit another recipe after
Run; it must wait for the next Run. Reload the participant page to check its
saved receipt. Simulation never contacts CubOS.

For a fully local rehearsal, build the frontend and place the three secrets in
an ignored `.env.live` file:

```sh
npm --prefix frontend ci
npm --prefix frontend run build
node --env-file=.env.live tools/live-server.mjs
# Second terminal, with LIVE_WORKER_TOKEN set:
.venv/bin/python -m ursa_learning.live_worker \
  --url http://127.0.0.1:8787 --simulate
```

Open `http://127.0.0.1:8787/?view=live`. The local server is simulation-only,
binds to loopback, and persists to `.live-data/queue.json`. Its QR is not reachable
from a phone. This file store is never used in Vercel.

## Connect CUB

1. On CUB, install an **operator-reviewed** three-stock mixing protocol based on
   `examples/live-mixture-protocol.yaml`. The sequence must be red transfer,
   yellow transfer, blue transfer, one final mix, and tip drops. The example's
   heights and positions are illustrative and must be calibrated for your setup.
   No camera or other steps are silently stripped from a template.
2. Copy `examples/live-talk-worker.json` outside Git. Set the actual gantry/deck/
   source-protocol filenames, current CubOS fluid-state ID, and fresh candidate
   wells in desired order. The protocol determines stock, waste, and instrument
   settings; participants can only select proportions. Confirm the pipette and
   stocks support the 5–150 µL transfer range and the template's mix volume.
3. Ensure CubOS records a bare pipette, fresh tips, empty destination wells, and
   sufficient usable stocks. One recipe uses **up to 3 tips** (one per nonzero
   dye); the final dispensing tip mixes that same well and is discarded. With
   all three dyes, **96 tips supports 32 recipes**, subject to wells and stocks.
4. Set `URSA_LEARNING_CUBOS_API_TOKEN` or `URSA_LEARNING_CUBOS_API_TOKEN_FILE` if
   CubOS requires a native API token. These remain on the laptop. The bridge
   uses the repo's existing `RemoteRunManager`/`StationClient` HTTP interface;
   the CubOS installation must support the external-orchestration contracts in
   `migration.md` (run validation, raw configs, inventory/state, stable run IDs).
5. Create a new hosted event ID in `hardware` mode and redeploy. Start the laptop:

   ```sh
   .venv/bin/python -m ursa_learning.live_worker \
     --url https://YOUR-PROJECT.vercel.app \
     --cub-url http://cub.local:8742 \
     --setup /absolute/path/to/reviewed-mixture-setup.json \
     --journal .live-worker/talk.json
   ```

   Replace `cub.local` with CUB's LAN IP if needed. Guest Wi-Fi client isolation
   may prevent the laptop reaching CUB; a travel router with both devices on its
   LAN is a practical alternative. The laptop still needs outbound internet.
6. Open host controls. **Laptop online** confirms the polling process, not
   physical readiness. CubOS readiness, fresh inventory, and compiled protocol
   validation are checked before each hardware submission.

### Operator validation before the talk

No automated test moves hardware. This worker can move the gantry, pick/drop
tips, transfer dye, and mix through existing CubOS protocols. Validate physically:

1. Check calibration, source/waste positions, source and mixing heights, fresh
   wells/tips, volumes, bare pipette, and reachable local stop controls.
2. Submit one recipe; verify no motion occurs before the host presses Run.
3. Run while watching the first pickup/transfer. Confirm the destination, exact
   recipe volumes, one final mix, and tip disposal. Check CubOS's saved run and
   inventory against the physical well.
4. Try a recipe with a zero component. It must skip that stock and its tip, still
   mix the well, and keep the 150 µL total.
5. Rehearse two jobs, Pause, and a later submission. Confirm one well per job,
   sequential execution, and later arrivals waiting for another Run.
6. Rehearse a supervised laptop disconnect/restart. The worker must read the
   same stable CubOS run ID and never dispense a recipe a second time.

## Controls and recovery

- Run releases the recipes currently waiting, in FIFO order. New submissions
  wait for the next Run. Pause lets the current well finish and holds later jobs.
- **Pause and laptop disconnection are not emergency stops.** Stop an active
  protocol in CubOS. Hardware controls remain local.
- A signed browser session allows one recipe per event and deduplicates retries.
  Clearing cookies can create another participant. A 300-job cap and generous
  shared-venue-IP burst limit provide basic abuse protection, not strong identity.
- The cloud queue is durable and uses Postgres compare-and-set across Vercel
  instances. Stale worker heartbeats do not expire active claims.
- The local journal reserves a fresh well and records the exact protocol bundle
  and stable run ID **before** one hardware POST. Lost responses are resolved
  by reading the ID. An unconfirmed or failed run blocks for inspection.
- CubOS inventory is authoritative. The worker checks available tips, an empty
  destination, usable stock above dead volume, and setup validity at use time.
  Failed preflight jobs conservatively consume their journal well allocation.
- On a blocked/offline active job: stop the laptop worker, inspect and stop the
  CubOS run, reconcile physical state, then check the host page's review box and
  retire the job. Restart the worker with the same journal. Delayed status reports
  are acknowledged without reviving the retired job. Retiring a cloud job does
  not stop hardware. The next jobs need another Run.
- Keep the journal across restarts. It refuses changed event/setup bindings.
  Use a new journal only after inspection and fresh well allocation. Never delete
  it to force a retry. For a refill/plate change, reconcile in CubOS and prepare
  a new reviewed setup/event after all active runs have stopped.

## Checks

```sh
npm test
.venv/bin/python -m pytest tests/test_live_worker.py -q
cd frontend
npm run lint
npm test
npm run build
cd ..
node tools/live-smoke.mjs
```

The browser smoke test uses system Chromium (`PLAYWRIGHT_CHROMIUM_PATH` overrides
its path), a temporary local queue, and a simulation worker. Python tests use
MockTransport against the real CubOS HTTP adapter. They cover exact volumes,
zero-component recipes, inventory rejection, restart recovery, and no duplicate
hardware submissions. Lighting calibration is not required for execution; use
simple consistent illumination if projecting a camera feed of the wells.

To run the browser rehearsal against the hosted site, use a fresh event in
`simulation` mode and load its host/worker keys from an ignored `.env.live`:

```sh
LIVE_TEST_URL=https://YOUR-PROJECT.vercel.app node --env-file=.env.live tools/live-smoke.mjs
```

This creates two test recipes and executes one in simulation. It refuses hardware
events and nonempty queues. If the execution environment uses a network allowlist,
allow the deployed hostname first; the test preserves its configured proxy.
