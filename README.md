# Ursa Learning

Active learning for lab experiments, with dedicated color matching and overnight workflows. Ursa Learning chooses experiment parameters and scores results. A separate CubOS API server validates and executes the protocols, controls hardware, and owns inventory.

The three workspaces are **Active Learning**, **Color Matching**, and **Overnight Runs**. The interface keeps CubOS's familiar operator layout with its own identity. Open the linked CubOS operator interface for calibration and station administration.

## Run locally

Requires Python 3.11 or newer and Node.js 20.19 or newer.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
cd frontend
npm ci
npm run build
cd ..
URSA_LEARNING_CUBOS_URL=http://127.0.0.1:8742 .venv/bin/python -m ursa_learning
```

Open [Ursa Learning](http://127.0.0.1:8750). CubOS runs separately on port 8742. Its API must include the external-orchestration contracts described in [the migration guide](docs/migration.md). Existing `feat/color-demo-layer` stations must be upgraded deliberately before connecting the extracted app.

For development, run the backend and `cd frontend && npm run dev` in separate terminals. Configure a CubOS API token on the backend when the station requires native-client authentication; never put station credentials in the browser.

## Generic experiments

Select the station's gantry, deck, and source protocol. Bind each numeric search parameter to one or more protocol arguments. Choose a numeric result path and minimize/maximize direction, or supply manual observations. Configure seed trials, EI/LCB/random suggestions, Matérn/RBF kernels, mixture sum constraints, trial/time/patience budgets, and fresh-well/tip sequences. Validate the campaign before starting it.

The experiment may optimize any scalar target reported by its protocol: for example strength, absorbance, yield, or time. Parameter bounds and protocol arguments are declared by the user. CubOS validates every compiled protocol before execution.

## Color and overnight workflows

Color Matching retains camera and selected RGB targets, reviewed image centers, frozen target analysis, dye/diluent constraints, batching, saved presets, and refill recovery. Accepted measurements retain their capture and processing profile evidence. Explicit photometric recovery keeps rejected samples unscored; identity, geometry, and profile errors stop the campaign.

Overnight Runs freezes each queued job's inputs and budgets the available tips and stock volumes before starting. Restarted or failed workflows require operator review; the app does not replay hardware commands automatically.

## Validation

```sh
.venv/bin/python -m pytest -q
cd frontend
npm run lint
npm test
npm run build
```

No hardware has been exercised during extraction. Follow [the operator validation procedure](docs/migration.md) before using this version on a physical station.

## Origin

Extracted from [CubOS's color demo branch](https://github.com/Ursa-Laboratories/CubOS/tree/feat/color-demo-layer), commit `6eb70575`. MIT licensed; existing protocol, optimization, and color measurement behavior is retained where practical. CubOS run and image evidence remains referenced by run ID and digest.
