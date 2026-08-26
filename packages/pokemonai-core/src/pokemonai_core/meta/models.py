from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


FORMAT_IDS = (
    "champions-ranked-doubles",
    "champions-ranked-singles",
    "champions-ou",
)


@dataclass(frozen=True)
class FormatBinding:
    format_id: str
    source_format: str
    rating: str
    update_field: str


@dataclass(frozen=True)
class FormatProbe:
    format_id: str
    source_format: str
    rating: str
    source_updated_at: str
    pokemon_names: tuple[str, ...]
    landing: dict[str, Any] = field(repr=False)
    team_source_updated_at: str = ""


@dataclass(frozen=True)
class ImportResult:
    id: str
    state: str
    changed_formats: tuple[str, ...] = ()
    source_updated_at: dict[str, str] = field(default_factory=dict)
    counts: dict[str, int] = field(default_factory=dict)
    team_counts: dict[str, int] = field(default_factory=dict)
    playable_team_counts: dict[str, int] = field(default_factory=dict)
    progress: dict[str, Any] = field(default_factory=dict)
    warnings: tuple[str, ...] = ()
    error: str = ""
