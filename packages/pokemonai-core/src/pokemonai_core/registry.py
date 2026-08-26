from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


@dataclass(frozen=True)
class BackendSpec:
    id: str
    entrypoint: str
    formats: tuple[str, ...] = ()
    devices: tuple[str, ...] = ("cpu",)
    commands: tuple[str, ...] = ("doctor", "serve")
    path: Path = field(default=Path())
    runtime: str = "python"

    def supports(self, target: str) -> bool:
        backend_id, _, profile = target.partition("/")
        return backend_id == self.id and bool(profile)


class BackendRegistry:
    def __init__(self, specs: tuple[BackendSpec, ...]) -> None:
        self.specs = specs
        self._by_id = {spec.id: spec for spec in specs}

    @classmethod
    def discover(cls, project_root: str | Path) -> "BackendRegistry":
        root = Path(project_root).resolve() / "backends"
        specs: list[BackendSpec] = []
        if not root.is_dir():
            return cls(())
        for manifest in sorted(root.glob("*/backend.yaml")):
            raw = yaml.safe_load(manifest.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise ValueError(f"Backend manifest must be a mapping: {manifest}")
            spec = BackendSpec(
                id=str(raw.get("id", "")).strip(),
                entrypoint=str(raw.get("entrypoint", "")).strip(),
                formats=tuple(str(value).strip() for value in raw.get("formats", ())),
                devices=tuple(str(value).strip() for value in raw.get("devices", ("cpu",))),
                commands=tuple(str(value).strip() for value in raw.get("commands", ("doctor", "serve"))),
                path=manifest.parent,
                runtime=str(raw.get("runtime", "python")).strip().lower(),
            )
            if not spec.id or not spec.entrypoint:
                raise ValueError(f"Backend id and entrypoint are required: {manifest}")
            if spec.runtime not in {"python", "node"}:
                raise ValueError(f"Unsupported backend runtime: {spec.runtime}")
            if spec.id in {item.id for item in specs}:
                raise ValueError(f"Duplicate backend id: {spec.id}")
            specs.append(spec)
        return cls(tuple(specs))

    def normalize(self, value: str) -> str:
        backend_id, separator, profile = value.partition("/")
        spec = self._by_id.get(backend_id)
        if not separator or not profile or spec is None or not spec.supports(value):
            raise ValueError(f"Unsupported backend: {value}")
        return value

    def get(self, backend_id: str) -> BackendSpec:
        try:
            return self._by_id[backend_id]
        except KeyError as error:
            raise KeyError(f"Unknown backend: {backend_id}") from error

    def for_target(self, target: str) -> BackendSpec:
        return self.get(target.partition("/")[0])

    def as_dicts(self) -> list[dict[str, Any]]:
        return [
            {
                "id": spec.id,
                "entrypoint": spec.entrypoint,
                "formats": list(spec.formats),
                "devices": list(spec.devices),
                "commands": list(spec.commands),
                "runtime": spec.runtime,
            }
            for spec in self.specs
        ]
