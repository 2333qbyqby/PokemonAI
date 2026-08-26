from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import random
import shutil
import subprocess
import threading
from typing import Any
from uuid import uuid4

from .config import AgentsConfig
from .runtime import atomic_json


AI_TEAM_MODES = ("mirror", "counter", "popular-random", "generated-random", "fixed")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _timestamp(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _normalize_user(value: str) -> str:
    return "".join(character for character in value.casefold() if character.isascii() and character.isalnum())


class AITeamService:
    def __init__(self, project_root: str | Path, agents: AgentsConfig) -> None:
        self.root = Path(project_root).resolve()
        self.agents = agents
        self.pool_path = self.root / "var" / "generated" / "ai-team-pool" / "current.json"
        self.meta_path = self.root / "var" / "meta" / "current.json"
        self.team_index_path = self.root / agents.team_library_path
        self.tool_path = self.root / "scripts" / "ai-team-tool.mjs"
        self._pool: dict[str, Any] | None = None
        self._pool_lock = threading.Lock()
        self._preset_lock = threading.Lock()
        self._presets: dict[str, dict[str, Any]] = {}

    def refresh(self) -> dict[str, Any]:
        with self._pool_lock:
            self._pool = self._build_pool()
            atomic_json(self.pool_path, self._pool)
            return self._pool

    def capabilities(self) -> dict[str, Any]:
        pool = self._ensure_pool()
        formats: dict[str, Any] = {}
        for format_config in self.agents.formats:
            teams = list(pool["formats"].get(format_config.id, []))
            popular = [team for team in teams if team["sourceKind"] in {"observed", "inferred"}]
            formats[format_config.id] = {
                "teamCount": len(teams),
                "popularTeamCount": len(popular),
                "sourceUpdatedAt": pool.get("sourceUpdatedAt", {}).get(format_config.id),
                "modes": {
                    "mirror": True,
                    "counter": bool(teams),
                    "popular-random": bool(popular),
                    "generated-random": True,
                    "fixed": bool(teams),
                },
            }
        return {"schema": "pokemonai-ai-capabilities", "publishedAt": pool.get("publishedAt"), "formats": formats}

    def list_pool(
        self, format_id: str, *, query: str = "", cursor: int = 0, limit: int = 20
    ) -> dict[str, Any]:
        self.agents.format_by_id(format_id)
        if cursor < 0 or limit < 1 or limit > 60:
            raise ValueError("Invalid AI team pool pagination")
        pool = self._ensure_pool()
        teams = list(pool["formats"].get(format_id, []))
        normalized_query = query.strip().casefold()
        if normalized_query:
            teams = [
                team for team in teams
                if normalized_query in " ".join((team["name"], *team["roster"])).casefold()
            ]
        teams.sort(key=lambda team: team["name"].casefold())
        teams.sort(key=lambda team: (team.get("battles") or 0), reverse=True)
        total = len(teams)
        page = teams[cursor:cursor + limit]
        return {
            "schema": "pokemonai-ai-team-pool",
            "publishedAt": pool.get("publishedAt"),
            "total": total,
            "nextCursor": str(cursor + len(page)) if cursor + len(page) < total else None,
            "teams": [self._summary(team) for team in page],
        }

    def pool_detail(self, team_id: str) -> dict[str, Any] | None:
        for teams in self._ensure_pool()["formats"].values():
            for team in teams:
                if team["id"] == team_id:
                    return {**self._summary(team), "packedTeam": team["packedTeam"], "profile": deepcopy(team["profile"])}
        return None

    def create_preset(self, request: dict[str, Any]) -> dict[str, Any]:
        challenger = str(request.get("challenger") or "").strip()
        opponent_id = str(request.get("opponentId") or "").strip()
        format_id = str(request.get("formatId") or "").strip()
        player_team = str(request.get("playerTeamPacked") or "").strip()
        mode = str(request.get("mode") or "popular-random").strip()
        fixed_team_id = str(request.get("fixedTeamId") or "").strip()
        if not _normalize_user(challenger):
            raise ValueError("A named challenger is required")
        opponent = next((item for item in self.agents.opponents if item.id == opponent_id), None)
        if opponent is None or opponent.format_id != format_id:
            raise ValueError("Opponent and format do not match")
        if mode not in AI_TEAM_MODES:
            raise ValueError("Unsupported AI team mode")
        validation = self._run_tool({"operation": "validate", "formatId": format_id, "packedTeam": player_team})
        if not validation.get("valid"):
            raise ValueError("Player team is not legal for this format")

        seed = int(request.get("seed") or random.SystemRandom().randrange(1, 2**31))
        resolved = self._select_team(format_id, mode, player_team, fixed_team_id, seed)
        preset_id = uuid4().hex
        now = _utc_now()
        preset = {
            "id": preset_id,
            "challengerId": _normalize_user(challenger),
            "opponentId": opponent_id,
            "formatId": format_id,
            "mode": mode,
            "resolvedAITeam": resolved,
            "seed": seed,
            "sourceUpdatedAt": resolved.get("sourceUpdatedAt"),
            "createdAt": _timestamp(now),
            "expiresAt": _timestamp(now + timedelta(seconds=90)),
            "state": "ready",
        }
        with self._preset_lock:
            self._expire_presets(now)
            for existing_id, existing in tuple(self._presets.items()):
                if (
                    existing["challengerId"] == preset["challengerId"]
                    and existing["opponentId"] == opponent_id
                    and existing["state"] == "ready"
                ):
                    del self._presets[existing_id]
            self._presets[preset_id] = preset
        return {
            "id": preset_id,
            "mode": mode,
            "teamId": resolved["id"],
            "teamName": resolved["name"] if mode in {"mirror", "fixed"} else None,
            "sourceKind": resolved["sourceKind"],
            "sourceUpdatedAt": resolved.get("sourceUpdatedAt"),
            "expiresAt": preset["expiresAt"],
        }

    def cancel_preset(self, preset_id: str) -> bool:
        with self._preset_lock:
            return self._presets.pop(preset_id, None) is not None

    def claim_preset(self, request: dict[str, Any]) -> dict[str, Any] | None:
        challenger = _normalize_user(str(request.get("challenger") or ""))
        opponent_id = str(request.get("opponentId") or "").strip()
        format_id = str(request.get("formatId") or "").strip()
        now = _utc_now()
        with self._preset_lock:
            self._expire_presets(now)
            preset = next((
                value for value in self._presets.values()
                if value["challengerId"] == challenger
                and value["opponentId"] == opponent_id
                and value["formatId"] == format_id
                and value["state"] == "ready"
            ), None)
            if preset is None:
                return None
            preset["state"] = "claimed"
            resolved = deepcopy(preset["resolvedAITeam"])
            del self._presets[preset["id"]]
        return {
            "presetId": preset["id"],
            "mode": preset["mode"],
            "seed": preset["seed"],
            "team": {
                "id": resolved["id"],
                "packed": resolved["packedTeam"],
                "profile": resolved["profile"],
            },
        }

    def _ensure_pool(self) -> dict[str, Any]:
        snapshot = self._read_json(self.meta_path) or {}
        published_at = snapshot.get("publishedAt")
        if self._pool is not None and self._pool.get("publishedAt") == published_at:
            return self._pool
        with self._pool_lock:
            cached = self._read_json(self.pool_path)
            if cached and cached.get("publishedAt") == published_at:
                self._pool = cached
            else:
                self._pool = self._build_pool(snapshot)
                atomic_json(self.pool_path, self._pool)
        return self._pool

    def _build_pool(self, snapshot: dict[str, Any] | None = None) -> dict[str, Any]:
        snapshot = snapshot or self._read_json(self.meta_path) or {}
        source_updated: dict[str, str | None] = {}
        formats: dict[str, list[dict[str, Any]]] = {item.id: [] for item in self.agents.formats}
        inspect_requests: list[dict[str, str]] = []
        inferred_requests: list[dict[str, Any]] = []
        inferred_metadata: dict[str, dict[str, Any]] = {}

        for format_index, format_config in enumerate(self.agents.formats):
            format_meta = (snapshot.get("formats") or {}).get(format_config.id, {})
            source_updated[format_config.id] = format_meta.get("teamSourceUpdatedAt") or format_meta.get("sourceUpdatedAt")
            source_teams = list(format_meta.get("teams") or [])
            has_observed = False
            for index, team in enumerate(source_teams):
                packed = str(team.get("packedTeam") or "")
                valid = team.get("validationStatus") in {"valid", "prevalidated"}
                if packed and valid:
                    has_observed = True
                    team_id = f"observed:{format_config.id}:{team.get('id') or index}"
                    record = self._record_from_source(team_id, format_config.id, team, packed, "observed", 1.0)
                    formats[format_config.id].append(record)
                    inspect_requests.append({"id": team_id, "packedTeam": packed})
            if not has_observed:
                for index, team in enumerate(source_teams[:200]):
                    roster = [str(value) for value in team.get("roster", [])]
                    if len(roster) != 6:
                        continue
                    request_id = f"inferred:{format_config.id}:{team.get('id') or index}:0"
                    inferred_requests.append({
                        "id": request_id,
                        "formatId": format_config.id,
                        "roster": roster,
                        "seed": 10_000 * (format_index + 1) + index + 1,
                    })
                    inferred_metadata[request_id] = team

        if inferred_requests:
            generated = self._run_tool({"operation": "materialize", "requests": inferred_requests})
            for result in generated.get("teams", []):
                if result.get("error") or not result.get("packedTeam"):
                    continue
                metadata = inferred_metadata[result["id"]]
                format_id = next(request["formatId"] for request in inferred_requests if request["id"] == result["id"])
                record = self._record_from_source(
                    result["id"], format_id, metadata, result["packedTeam"], "inferred", 0.65
                )
                record["roster"] = result.get("roster") or record["roster"]
                record["profile"] = result.get("profile") or []
                formats[format_id].append(record)

        static_index = self._read_json(self.team_index_path) or {}
        for index, team in enumerate(static_index.get("teams") or []):
            format_id = str(team.get("format_id") or team.get("pool") or "")
            if format_id not in formats or not team.get("packed") or str(team.get("validation_status", "")).startswith("invalid"):
                continue
            team_id = f"builtin:{team.get('id') or index}"
            record = {
                "id": team_id,
                "formatId": format_id,
                "name": str(team.get("name") or "内置队伍"),
                "packedTeam": str(team["packed"]),
                "roster": [str(member.get("species_name") or member.get("species") or "") for member in team.get("roster", [])],
                "profile": [
                    {
                        "species": str(member.get("species_name") or member.get("species") or ""),
                        "moves": list(member.get("moves") or []),
                        **({"item": member["item"]} if member.get("item") else {}),
                        **({"ability": member["ability"]} if member.get("ability") else {}),
                    }
                    for member in team.get("roster", [])
                ],
                "sourceKind": "builtin",
                "sourceTeamId": None,
                "sourceUpdatedAt": None,
                "popularityRank": None,
                "battles": None,
                "confidence": 0.8,
                "validationStatus": "valid",
            }
            formats[format_id].append(record)

        if inspect_requests:
            inspected = self._run_tool({"operation": "inspect", "teams": inspect_requests})
            profiles = {team["id"]: team.get("profile") or [] for team in inspected.get("teams", [])}
            for teams in formats.values():
                for team in teams:
                    if not team.get("profile") and team["id"] in profiles:
                        team["profile"] = profiles[team["id"]]

        for teams in formats.values():
            unique: dict[str, dict[str, Any]] = {}
            for team in teams:
                unique.setdefault(team["id"], team)
            teams[:] = unique.values()
        return {
            "schema": "pokemonai-ai-team-pool",
            "publishedAt": snapshot.get("publishedAt"),
            "sourceUpdatedAt": source_updated,
            "formats": formats,
        }

    def _record_from_source(
        self, team_id: str, format_id: str, source: dict[str, Any], packed: str, source_kind: str, confidence: float
    ) -> dict[str, Any]:
        usage = source.get("usage") if isinstance(source.get("usage"), dict) else {}
        return {
            "id": team_id,
            "formatId": format_id,
            "name": str(source.get("name") or "AI 队伍"),
            "packedTeam": packed,
            "roster": [str(value) for value in source.get("roster", [])],
            "profile": [],
            "sourceKind": source_kind,
            "sourceTeamId": str(source.get("id") or "") or None,
            "sourceUpdatedAt": str(source.get("observedAt") or "") or None,
            "popularityRank": int(source.get("rank") or 0) or None,
            "battles": int(usage.get("battles") or 0) or None,
            "confidence": confidence,
            "validationStatus": "valid",
        }

    def _select_team(
        self, format_id: str, mode: str, player_team: str, fixed_team_id: str, seed: int
    ) -> dict[str, Any]:
        teams = list(self._ensure_pool()["formats"].get(format_id, []))
        if mode == "mirror":
            inspected = self._run_tool({"operation": "inspect", "teams": [{"id": "mirror", "packedTeam": player_team}]})
            profile = (inspected.get("teams") or [{}])[0].get("profile") or []
            return {
                "id": f"mirror:{uuid4().hex}", "name": "和我相同", "packedTeam": player_team,
                "profile": profile, "roster": [member["species"] for member in profile],
                "sourceKind": "mirror", "sourceUpdatedAt": None,
            }
        if mode == "generated-random":
            generated = self._run_tool({"operation": "random", "formatId": format_id, "seed": seed})
            return {
                "id": f"generated:{uuid4().hex}", "name": "随机队伍", "packedTeam": generated["packedTeam"],
                "profile": generated.get("profile") or [], "roster": generated.get("roster") or [],
                "sourceKind": "generated", "sourceUpdatedAt": None,
            }
        if mode == "fixed":
            selected = next((team for team in teams if team["id"] == fixed_team_id), None)
            if selected is None:
                raise ValueError("The fixed AI team is no longer available")
            return deepcopy(selected)
        if mode == "popular-random":
            popular = [team for team in teams if team["sourceKind"] in {"observed", "inferred"}]
            if not popular:
                raise ValueError("No popular AI teams are available for this format")
            weights = [
                math.sqrt((team.get("battles") or 0) + 1)
                * (1 / math.sqrt(team.get("popularityRank") or 1))
                * float(team.get("confidence") or 0.5)
                for team in popular
            ]
            return deepcopy(random.Random(seed).choices(popular, weights=weights, k=1)[0])
        if mode == "counter":
            if not teams:
                raise ValueError("No AI teams are available for counter selection")
            candidates = sorted(
                teams, key=lambda team: ((team.get("battles") or 0), team.get("confidence") or 0), reverse=True
            )[:128]
            scored = self._run_tool({
                "operation": "score", "playerTeamPacked": player_team,
                "candidates": [{"id": team["id"], "packedTeam": team["packedTeam"]} for team in candidates],
            })
            best_id = next((item["id"] for item in scored.get("scores", []) if math.isfinite(item["score"])), "")
            selected = next((team for team in candidates if team["id"] == best_id), candidates[0])
            return deepcopy(selected)
        raise ValueError("Unsupported AI team mode")

    def _run_tool(self, payload: dict[str, Any]) -> dict[str, Any]:
        bundled = self.root / ".runtime" / "node" / ("node.exe" if shutil.which("node.exe") else "bin/node")
        executable = bundled if bundled.is_file() else Path(shutil.which("node") or "node")
        completed = subprocess.run(
            [str(executable), str(self.tool_path)],
            input=json.dumps(payload, ensure_ascii=False), capture_output=True, text=True,
            cwd=self.root, timeout=30, check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError((completed.stderr or "AI team tool failed").strip()[:500])
        value = json.loads(completed.stdout)
        if not isinstance(value, dict):
            raise RuntimeError("AI team tool returned an invalid response")
        return value

    def _summary(self, team: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": team["id"], "formatId": team["formatId"], "name": team["name"],
            "roster": list(team["roster"]), "sourceKind": team["sourceKind"],
            "sourceUpdatedAt": team.get("sourceUpdatedAt"), "battles": team.get("battles"),
            "confidence": team.get("confidence"),
        }

    def _expire_presets(self, now: datetime) -> None:
        for preset_id, preset in tuple(self._presets.items()):
            expires_at = datetime.fromisoformat(preset["expiresAt"].replace("Z", "+00:00"))
            if expires_at <= now:
                del self._presets[preset_id]

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any] | None:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else None
        except (OSError, ValueError):
            return None
