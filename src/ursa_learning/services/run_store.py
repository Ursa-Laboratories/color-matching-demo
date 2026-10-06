"""Local annotations and immutable evidence, never physical station state."""
from __future__ import annotations
from contextlib import contextmanager
import hashlib
import json
import re
import threading
from pathlib import Path
from urllib.parse import quote
from ursa_learning.models.runs import RunRecord


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)


class RunStore:
    def __init__(self, base_dir: Path, station=None):
        self.base_dir = Path(base_dir).expanduser().resolve()
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.station = station
        self._analysis_lock = threading.RLock()

    def run_dir(self, run_id: str) -> Path:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", run_id):
            raise ValueError("Invalid run ID")
        return self.base_dir / run_id

    def annotations(self, run_id: str) -> dict:
        path = self.run_dir(run_id) / "annotations.json"
        return json.loads(path.read_text()) if path.is_file() else {}

    def annotate(self, run_id: str, metadata: dict) -> None:
        with self._analysis_lock:
            values = {**self.annotations(run_id), **metadata}
            _atomic_write(self.run_dir(run_id) / "annotations.json", json.dumps(values, indent=2))

    def artifact_path(self, run_id: str, name: str) -> Path | None:
        from ursa_learning.services.yaml_io import safe_filename
        try:
            safe_filename(name)
        except ValueError:
            return None
        directory = self.run_dir(run_id)
        path = directory / name
        if path.is_symlink():
            raise ValueError("Evidence must be a regular file")
        if path.is_file():
            return path
        if self.station is None:
            return None
        from ursa_learning.services.station import StationHTTPError
        try:
            response = self.station.request("GET", f"/api/v1/runs/{run_id}/artifacts/{quote(name, safe='')}")
        except StationHTTPError as exc:
            if exc.status_code == 404:
                return None
            raise
        if len(response.content) > 64 * 1024 * 1024:
            raise ValueError("Evidence artifact exceeds the 64 MiB download limit")
        directory.mkdir(parents=True, exist_ok=True)
        temporary = directory / (name + ".download")
        temporary.write_bytes(response.content)
        temporary.replace(path)
        return path

    @contextmanager
    def color_target_analysis_transaction(self):
        with self._analysis_lock:
            yield

    def append_color_target_analysis(self, record: RunRecord, *, artifact: dict, annotated_preview: Path):
        with self._analysis_lock:
            metadata = {**record.metadata, **self.annotations(record.run_id)}
            revisions = list(metadata.get("color_target_reanalyses", []))
            revision = max([0, *(item["revision"] for item in revisions)]) + 1
            name = f"color-target-analysis-{revision}"
            directory = self.run_dir(record.run_id)
            preview = directory / (name + ".png")
            if preview.exists() or (directory / (name + ".json")).exists():
                raise FileExistsError("Analysis revision already exists")
            preview.write_bytes(annotated_preview.read_bytes())
            analysis = dict(artifact["analysis"])
            analysis["annotated_preview_path"] = str(preview)
            complete = {**artifact, "revision": revision, "analysis": analysis, "image_artifact": name + ".png"}
            _atomic_write(directory / (name + ".json"), json.dumps(complete, indent=2))
            revisions.append({**complete, "json_artifact": name + ".json"})
            self.annotate(record.run_id, {"color_target_reanalyses": revisions})
            record.metadata["color_target_reanalyses"] = revisions
            return record, complete
