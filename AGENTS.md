# Ursa Learning agent guide

Ursa Learning owns optimization and experiment orchestration. CubOS owns hardware, protocol execution, setup validation, authoritative deck inventory, and camera acquisition.

- All station interaction uses the CubOS HTTP API through `services/run_manager.py` and `services/station.py`. Never import `cubos` or `cubos_api`, open the CubOS SQLite database, or read files on its host.
- Campaign/job configuration snapshots and downloaded evidence are app-owned immutable records. Always fetch current physical state from CubOS at use time.
- Preserve accepted camera quality/provenance gates; rejected geometry/identity/profile results cannot be scored or skipped as photometric failures.
- Never run hardware protocols or motion during automated work. Use MockTransport or a mock CubOS station.
- Use this repo's `.venv`. Backend: `.venv/bin/python -m pytest -q`. Frontend: `cd frontend && npm ci && npm run lint && npm test && npm run build`.
- Architecture and migration status is tracked in `../Ursa_Context/docs/plans/2026-10-06-active-learning-extraction.md`.
