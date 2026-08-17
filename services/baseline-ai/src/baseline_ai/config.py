from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


BASELINE_BACKENDS = {
    "poke_env.random",
    "poke_env.max_base_power",
    "poke_env.simple_heuristics",
}
ALL_BACKENDS = BASELINE_BACKENDS | {"foul_play"}


@dataclass(frozen=True)
class OpponentConfig:
    id: str
    label: str
    username: str
    backend: str
    description: str = ""
    options: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AgentsConfig:
    format: str
    source_url: str
    opponents: tuple[OpponentConfig, ...]

    @property
    def baseline_opponents(self) -> tuple[OpponentConfig, ...]:
        return tuple(o for o in self.opponents if o.backend in BASELINE_BACKENDS)

    @property
    def expert(self) -> OpponentConfig:
        experts = [o for o in self.opponents if o.backend == "foul_play"]
        if len(experts) != 1:
            raise ValueError("Configuration must contain exactly one foul_play opponent")
        return experts[0]


def load_agents_config(path: str | Path) -> AgentsConfig:
    config_path = Path(path)
    raw = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("Agent configuration must be a YAML mapping")

    battle_format = str(raw.get("format", "")).strip()
    if battle_format != "gen9randombattle":
        raise ValueError("First release only supports gen9randombattle")

    source_url = str(raw.get("source_url", "")).strip()
    if not source_url:
        raise ValueError("source_url is required")

    entries = raw.get("opponents")
    if not isinstance(entries, list) or not entries:
        raise ValueError("opponents must be a non-empty list")

    opponents: list[OpponentConfig] = []
    ids: set[str] = set()
    usernames: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("Each opponent must be a mapping")
        opponent = OpponentConfig(
            id=str(entry.get("id", "")).strip(),
            label=str(entry.get("label", "")).strip(),
            username=str(entry.get("username", "")).strip(),
            backend=str(entry.get("backend", "")).strip(),
            description=str(entry.get("description", "")).strip(),
            options=dict(entry.get("options") or {}),
        )
        if not opponent.id or not opponent.label or not opponent.username:
            raise ValueError("Opponent id, label, and username are required")
        if opponent.backend not in ALL_BACKENDS:
            raise ValueError(f"Unsupported backend: {opponent.backend}")
        folded_username = "".join(ch for ch in opponent.username.lower() if ch.isalnum())
        if opponent.id in ids:
            raise ValueError(f"Duplicate opponent id: {opponent.id}")
        if folded_username in usernames:
            raise ValueError(f"Duplicate opponent username: {opponent.username}")
        ids.add(opponent.id)
        usernames.add(folded_username)
        opponents.append(opponent)

    config = AgentsConfig(battle_format, source_url, tuple(opponents))
    if len(config.baseline_opponents) != 3:
        raise ValueError("First release requires exactly three poke-env opponents")
    _ = config.expert
    return config
