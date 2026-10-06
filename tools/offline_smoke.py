"""Verify the two-process HTTP boundary using the simulation-only example."""
import argparse
import json
import time
from pathlib import Path

import httpx

parser = argparse.ArgumentParser()
parser.add_argument('--app', default='http://127.0.0.1:18750')
parser.add_argument('--station', default='http://127.0.0.1:18742')
args = parser.parse_args()
app = httpx.Client(base_url=args.app, timeout=30)
station = httpx.Client(base_url=args.station, timeout=30)
root = Path(__file__).resolve().parents[1]
spec = json.loads((root / 'examples/campaign.json').read_text())
assert spec['mock_mode'] is True
raw = station.get('/api/v1/configs/gantry/bo_demo_gantry.yaml/raw')
raw.raise_for_status()
assert 'SIMULATION_ONLY' in raw.json()['content'], 'Use only the isolated simulation fixture server'
spec['stop']['max_trials'] = 3
spec['stop']['patience'] = 0
validation = app.post('/api/v1/campaigns/validate', json={'spec': spec})
validation.raise_for_status()
assert validation.json()['valid'], validation.json()
created = app.post('/api/v1/campaigns', json={'spec': spec})
created.raise_for_status()
campaign_id = created.json()['campaign_id']
for _ in range(150):
    response = app.get('/api/v1/campaigns/' + campaign_id)
    response.raise_for_status()
    record = response.json()
    if record['state'] in {'completed', 'failed', 'interrupted', 'stopped'}:
        break
    time.sleep(.1)
assert record['state'] == 'completed', record
assert len(record['trials']) == 3, record
assert all(trial['objective_status'] == 'accepted' for trial in record['trials']), record
reservation = station.get('/api/v1/station/reservation')
reservation.raise_for_status()
assert not reservation.json()['reserved'], reservation.json()
print(json.dumps({'state': record['state'], 'reason': record['stop_reason'], 'objectives': [trial['objective'] for trial in record['trials']], 'native_run_ids': [trial['run_id'] for trial in record['trials']], 'reservation_released': True}, indent=2))
