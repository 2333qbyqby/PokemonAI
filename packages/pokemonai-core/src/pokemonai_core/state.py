from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil

from .runtime import atomic_json, utc_now


MIGRATIONS = {
    "data/agents": "var/logs/agents",
    "data/battles": "var/logs/battles",
    "data/process-logs": "var/logs/processes",
    "data/test-results": "var/evaluations/legacy-tests",
    "data/team-library": "var/generated/team-library",
    "data/team-sources/cache": "var/cache/team-sources",
    "data/team-sources/builtin": "resources/teams/builtin",
}


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def migrate_state(project_root: str | Path, *, prune_legacy: bool = False) -> dict[str, int]:
    root = Path(project_root).resolve()
    copied = 0
    verified = 0
    sources_to_prune: list[Path] = []
    for source_name, destination_name in MIGRATIONS.items():
        source = (root / source_name).resolve()
        destination = (root / destination_name).resolve()
        if root not in source.parents or root not in destination.parents:
            raise ValueError("State migration path escaped the project root")
        if not source.is_dir():
            continue
        for old in source.rglob("*"):
            if not old.is_file():
                continue
            relative = old.relative_to(source)
            new = destination / relative
            new.parent.mkdir(parents=True, exist_ok=True)
            if not new.exists():
                shutil.copy2(old, new)
                copied += 1
            if old.stat().st_size != new.stat().st_size or _digest(old) != _digest(new):
                raise RuntimeError(f"State migration verification failed: {old}")
            verified += 1
        sources_to_prune.append(source)
    record = {"completedAt": utc_now(), "copied": copied, "verified": verified}
    atomic_json(root / "var" / "run" / "state-migration.json", record)
    if prune_legacy:
        for source in sources_to_prune:
            shutil.rmtree(source)
    return record
