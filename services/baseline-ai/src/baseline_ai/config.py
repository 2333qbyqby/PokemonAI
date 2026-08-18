from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


BASELINE_BACKENDS = {
    "poke_env.random",
    "poke_env.max_base_power",
    "poke_env.simple_heuristics",
    "pokemonai.vgc",
}
EXPERT_BACKENDS = {"foul_play"}
ALL_BACKENDS = BASELINE_BACKENDS | EXPERT_BACKENDS
VALID_GAME_TYPES = {"singles", "doubles"}


@dataclass(frozen=True)
class FormatConfig:
    id: str
    label: str
    showdown_format: str
    game_type: str
    team_preview: str = "none"
    open_team_sheets: bool = False
    team_pool: str | None = None
    enabled: bool = True
    description: str = ""

    @property
    def requires_team(self) -> bool:
        return self.team_preview != "none" or "random" not in self.showdown_format.lower()


@dataclass(frozen=True)
class OpponentConfig:
    id: str
    label: str
    username: str
    backend: str
    format_id: str
    description: str = ""
    difficulty: int = 1
    style: str = "balanced"
    options: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AgentsConfig:
    default_format: str
    source_url: str
    formats: tuple[FormatConfig, ...]
    opponents: tuple[OpponentConfig, ...]
    team_sources_path: str = "config/team-sources.yaml"
    team_library_path: str = "data/team-library/index.json"

    @property
    def format(self) -> str:
        """Backward-compatible default Showdown format string."""
        return self.format_by_id(self.default_format).showdown_format

    @property
    def baseline_opponents(self) -> tuple[OpponentConfig, ...]:
        return tuple(o for o in self.opponents if o.backend in BASELINE_BACKENDS)

    @property
    def experts(self) -> tuple[OpponentConfig, ...]:
        return tuple(o for o in self.opponents if o.backend in EXPERT_BACKENDS)

    @property
    def expert(self) -> OpponentConfig:
        """Backward-compatible access for deployments with one Foul Play bot."""
        experts = self.experts
        if len(experts) != 1:
            raise ValueError("Configuration must contain exactly one foul_play opponent")
        return experts[0]

    def format_by_id(self, format_id: str) -> FormatConfig:
        for format_config in self.formats:
            if format_config.id == format_id:
                return format_config
        raise KeyError(f"Unknown format id: {format_id}")

    def opponents_for_format(self, format_id: str) -> tuple[OpponentConfig, ...]:
        return tuple(o for o in self.opponents if o.format_id == format_id)

    def format_for_opponent(self, opponent: OpponentConfig) -> FormatConfig:
        return self.format_by_id(opponent.format_id)


def _parse_formats(raw: dict[str, Any]) -> tuple[FormatConfig, ...]:
    entries = raw.get("formats")
    if entries is None:
        # Backward compatibility for the original single-format configuration.
        legacy_format = str(raw.get("format", "")).strip()
        if not legacy_format:
            raise ValueError("formats or format is required")
        entries = [
            {
                "id": "default",
                "label": legacy_format,
                "showdown_format": legacy_format,
                "game_type": "doubles" if "vgc" in legacy_format.lower() else "singles",
                "team_preview": "bring6_pick4" if "vgc" in legacy_format.lower() else "none",
                "open_team_sheets": "vgc" in legacy_format.lower(),
            }
        ]
    if not isinstance(entries, list) or not entries:
        raise ValueError("formats must be a non-empty list")

    formats: list[FormatConfig] = []
    seen_ids: set[str] = set()
    seen_showdown: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("Each format must be a mapping")
        item = FormatConfig(
            id=str(entry.get("id", "")).strip(),
            label=str(entry.get("label", "")).strip(),
            showdown_format=str(entry.get("showdown_format", entry.get("format", ""))).strip(),
            game_type=str(entry.get("game_type", "")).strip().lower(),
            team_preview=str(entry.get("team_preview", "none")).strip(),
            open_team_sheets=bool(entry.get("open_team_sheets", False)),
            team_pool=(str(entry.get("team_pool")).strip() if entry.get("team_pool") else None),
            enabled=bool(entry.get("enabled", True)),
            description=str(entry.get("description", "")).strip(),
        )
        if not item.id or not item.label or not item.showdown_format:
            raise ValueError("Format id, label, and showdown_format are required")
        if item.game_type not in VALID_GAME_TYPES:
            raise ValueError(f"Unsupported game_type for {item.id}: {item.game_type}")
        if item.id in seen_ids:
            raise ValueError(f"Duplicate format id: {item.id}")
        if item.showdown_format in seen_showdown:
            raise ValueError(f"Duplicate Showdown format: {item.showdown_format}")
        if item.game_type == "doubles" and item.team_preview == "none":
            raise ValueError(f"Doubles format {item.id} must define team_preview")
        seen_ids.add(item.id)
        seen_showdown.add(item.showdown_format)
        formats.append(item)
    return tuple(formats)


def load_agents_config(path: str | Path) -> AgentsConfig:
    config_path = Path(path)
    raw = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("Agent configuration must be a YAML mapping")

    formats = _parse_formats(raw)
    format_ids = {item.id for item in formats}
    default_format = str(raw.get("default_format", formats[0].id)).strip()
    if default_format not in format_ids:
        raise ValueError(f"default_format does not exist: {default_format}")

    source_url = str(raw.get("source_url", "")).strip()
    if not source_url:
        raise ValueError("source_url is required")

    entries = raw.get("opponents")
    if not isinstance(entries, list) or not entries:
        raise ValueError("opponents must be a non-empty list")

    legacy_format_id = formats[0].id
    opponents: list[OpponentConfig] = []
    ids: set[str] = set()
    usernames: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("Each opponent must be a mapping")
        options = entry.get("options") or {}
        if not isinstance(options, dict):
            raise ValueError("Opponent options must be a mapping")
        opponent = OpponentConfig(
            id=str(entry.get("id", "")).strip(),
            label=str(entry.get("label", "")).strip(),
            username=str(entry.get("username", "")).strip(),
            backend=str(entry.get("backend", "")).strip(),
            format_id=str(entry.get("format_id", legacy_format_id)).strip(),
            description=str(entry.get("description", "")).strip(),
            difficulty=int(entry.get("difficulty", 1)),
            style=str(entry.get("style", "balanced")).strip().lower() or "balanced",
            options=dict(options),
        )
        if not opponent.id or not opponent.label or not opponent.username:
            raise ValueError("Opponent id, label, and username are required")
        if opponent.backend not in ALL_BACKENDS:
            raise ValueError(f"Unsupported backend: {opponent.backend}")
        if opponent.format_id not in format_ids:
            raise ValueError(
                f"Opponent {opponent.id} references unknown format: {opponent.format_id}"
            )
        if not 1 <= opponent.difficulty <= 10:
            raise ValueError(f"Opponent difficulty must be 1..10: {opponent.id}")
        format_config = next(f for f in formats if f.id == opponent.format_id)
        if opponent.backend == "pokemonai.vgc" and format_config.game_type != "doubles":
            raise ValueError("pokemonai.vgc backend requires a doubles format")
        if opponent.backend == "foul_play" and format_config.game_type != "singles":
            raise ValueError("foul_play backend is restricted to singles")
        folded_username = "".join(ch for ch in opponent.username.lower() if ch.isalnum())
        if opponent.id in ids:
            raise ValueError(f"Duplicate opponent id: {opponent.id}")
        if folded_username in usernames:
            raise ValueError(f"Duplicate opponent username: {opponent.username}")
        ids.add(opponent.id)
        usernames.add(folded_username)
        opponents.append(opponent)

    config = AgentsConfig(
        default_format=default_format,
        source_url=source_url,
        formats=formats,
        opponents=tuple(opponents),
        team_sources_path=str(raw.get("team_sources_path", "config/team-sources.yaml")),
        team_library_path=str(raw.get("team_library_path", "data/team-library/index.json")),
    )
    if not config.baseline_opponents:
        raise ValueError("At least one baseline opponent is required")
    return config
