from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
from typing import Any

from .config import AgentsConfig, OpponentConfig


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_json(path: str | Path, value: Any) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(target)


def write_status(path: str | Path, state: str, message: str = "") -> None:
    atomic_json(path, {"state": state, "updatedAt": utc_now(), "message": message})


def resolve_instance(
    project_root: str | Path,
    agents: AgentsConfig,
    opponent: OpponentConfig,
    *,
    websocket_url: str,
    control_url: str = "",
    control_token: str = "",
) -> dict[str, Any]:
    root = Path(project_root).resolve()
    format_config = agents.format_for_opponent(opponent)
    profile = opponent.backend.partition("/")[2]
    options = dict(opponent.options)
    device = str(options.pop("device", "cpu"))
    options.update({
        "profile": profile,
        "difficulty": opponent.difficulty,
        "style": opponent.style,
        "openTeamSheets": format_config.open_team_sheets,
    })
    return {
        "id": opponent.id,
        "formatId": format_config.id,
        "username": opponent.username,
        "format": format_config.showdown_format,
        "showdown": websocket_url,
        "authentication": os.environ.get("POKEMONAI_AUTH_URL", "none"),
        "control": control_url,
        "controlToken": control_token,
        "teamPool": format_config.team_pool,
        "device": device,
        "options": options,
    }


def expand_runtime(path: str | Path, backend_id: str) -> tuple[dict[str, Any], Path]:
    """Read the deliberately small public config and derive platform-owned paths."""
    config_path = Path(path).resolve()
    value = json.loads(config_path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Backend config must be a JSON object")
    root_value = os.environ.get("POKEMONAI_PROJECT_ROOT")
    root = Path(root_value).resolve() if root_value else None
    if root is None:
        var_parent = next((parent for parent in config_path.parents if parent.name == "var"), None)
        root = var_parent.parent if var_parent else Path.cwd().resolve()
    pool_index = root / "var" / "generated" / "team-library" / "index.json"
    value.update({
        "authentication": os.environ.get("POKEMONAI_AUTH_URL", "https://play.pokemonshowdown.com/action.php?"),
        "teamIndex": str(pool_index.resolve()),
        "logs": str((root / "var" / "logs" / "agents" / backend_id).resolve()),
        "replays": str((root / "var" / "replays" / backend_id).resolve()),
        "status": str((root / "var" / "run" / "status" / f"{value.get('id', 'unknown')}.json").resolve()),
    })
    return value, root


def write_instance_configs(
    project_root: str | Path, agents: AgentsConfig, *, websocket_url: str,
    control_url: str = "", control_token: str = "",
) -> dict[str, Path]:
    root = Path(project_root).resolve()
    instance_root = root / "var" / "run" / "instances"
    status_root = root / "var" / "run" / "status"
    configured_ids = {opponent.id for opponent in agents.opponents}
    instance_root.mkdir(parents=True, exist_ok=True)
    for path in instance_root.glob("*.json"):
        if path.stem not in configured_ids:
            path.unlink()
    for path in status_root.glob("*.json") if status_root.is_dir() else ():
        if path.stem not in configured_ids:
            path.unlink()

    output: dict[str, Path] = {}
    for opponent in agents.opponents:
        path = instance_root / f"{opponent.id}.json"
        atomic_json(path, resolve_instance(
            root, agents, opponent, websocket_url=websocket_url,
            control_url=control_url, control_token=control_token,
        ))
        output[opponent.id] = path
    return output


def backend_executable(project_root: str | Path, backend_id: str, entrypoint: str, runtime: str = "python") -> Path:
    root = Path(project_root).resolve()
    if runtime == "node":
        bundled = root / ".runtime" / "node" / ("node.exe" if os.name == "nt" else "bin/node")
        if bundled.is_file():
            return bundled
        from shutil import which

        discovered = which("node")
        return Path(discovered) if discovered else bundled
    scripts = "Scripts" if os.name == "nt" else "bin"
    suffix = ".exe" if os.name == "nt" else ""
    candidates = [
        root / ".runtime" / "venvs" / backend_id / scripts / f"{entrypoint}{suffix}",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return candidates[0]


def load_status(path: str | Path) -> dict[str, str] | None:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        if isinstance(value, dict) and isinstance(value.get("state"), str):
            return value
    except (OSError, ValueError):
        pass
    return None


def process_alive(pid: int) -> bool:
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    import ctypes

    process_query_limited_information = 0x1000
    still_active = 259
    handle = ctypes.windll.kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        return False
    try:
        exit_code = ctypes.c_ulong()
        return bool(ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))) and exit_code.value == still_active
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def _recorded_process_alive(root: Path, opponent_id: str) -> bool | None:
    pid_file = root / ".runtime" / "pids" / f"{opponent_id}.pid"
    if not pid_file.is_file():
        return None
    try:
        return process_alive(int(pid_file.read_text(encoding="ascii")))
    except ValueError:
        return False


def runtime_catalog(project_root: str | Path, agents: AgentsConfig) -> dict[str, Any]:
    root = Path(project_root).resolve()
    formats = [
        {
            "id": item.id,
            "label": item.label,
            "showdownFormat": item.showdown_format,
            "gameType": item.game_type,
            "teamPreview": item.team_preview,
            "openTeamSheets": item.open_team_sheets,
            "description": item.description,
            "requiresTeam": item.requires_team,
            "rosterSize": item.roster_size,
            "bringSize": item.bring_size,
            "activeSlots": item.active_slots,
            "regulation": item.regulation,
        }
        for item in agents.formats
        if item.enabled
    ]
    opponents: list[dict[str, Any]] = []
    for item in agents.opponents:
        spec = agents.registry.for_target(item.backend)
        executable = backend_executable(root, spec.id, spec.entrypoint, spec.runtime)
        status_path = root / "var" / "run" / "status" / f"{item.id}.json"
        status = load_status(status_path)
        process_alive = _recorded_process_alive(root, item.id)
        availability = "starting"
        if status and status.get("state") == "ready" and process_alive is not False:
            availability = "ready"
        elif process_alive is False:
            availability = "unavailable"
        elif status and status.get("state") in {"failed", "degraded", "stopped"}:
            availability = status["state"]
        elif not executable.is_file() or (spec.runtime == "node" and not (root / spec.entrypoint).is_file()):
            availability = "unavailable"
        elif status:
            availability = "ready" if status["state"] == "ready" else status["state"]
        public_reason = "" if availability == "ready" else "AI 暂时不可用，请稍后重试。"
        opponents.append(
            {
                "id": item.id,
                "label": item.label,
                "username": item.username,
                "formatId": item.format_id,
                "availability": availability,
                "reason": public_reason,
            }
        )
    return {"formats": formats, "opponents": opponents}
