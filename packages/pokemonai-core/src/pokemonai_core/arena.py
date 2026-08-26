from __future__ import annotations

import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
from typing import Any

import yaml

from .config import load_agents_config
from .runtime import backend_executable


def _git_commit(path: Path) -> str:
    result = subprocess.run(
        ["git", "-C", str(path), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def _file_hash(path: Path | None) -> str:
    if path is None or not path.is_file():
        return ""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _current_meta_updated_at(root: Path, format_id: str) -> str:
    try:
        value = json.loads((root / "var" / "meta" / "current.json").read_text(encoding="utf-8"))
        return str(value.get("formats", {}).get(format_id, {}).get("sourceUpdatedAt", ""))
    except (OSError, ValueError, TypeError):
        return ""


def _decision_average(root: Path, opponent_id: str, started: datetime) -> float | None:
    values: list[float] = []
    for path in (root / "var" / "logs" / "agents").rglob(f"{opponent_id}.jsonl"):
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                item = json.loads(line)
                recorded = datetime.fromisoformat(str(item["recordedAt"]).replace("Z", "+00:00"))
                if recorded >= started:
                    values.append(float(item["elapsedMs"]))
            except (KeyError, TypeError, ValueError):
                continue
    return round(sum(values) / len(values), 3) if values else None


def _write_reports(
    output: Path,
    players: list[str],
    battles: list[dict[str, Any]],
    *,
    requested: int,
    metadata: dict[str, Any],
) -> None:
    output.mkdir(parents=True, exist_ok=True)
    summary = {
        player: {
            "wins": sum(1 for battle in battles if battle.get("winner") == player),
            "losses": sum(1 for battle in battles if battle.get("winner") not in {player, None, "", "tie"}),
            "ties": sum(1 for battle in battles if battle.get("winner") in {None, "", "tie"}),
        }
        for player in players
    }
    payload = {
        "players": players,
        "requestedGames": requested,
        "games": len(battles),
        "failedGames": max(0, requested - len(battles)),
        "summary": summary,
        "metadata": metadata,
        "battles": battles,
    }
    (output / "report.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    with (output / "report.csv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["battleId", "p1", "p2", "winner", "turns", "failed"])
        for battle in battles:
            writer.writerow([
                battle.get("roomid", ""),
                battle.get("p1", ""),
                battle.get("p2", ""),
                battle.get("winner", ""),
                battle.get("turns", ""),
                False,
            ])
    lines = [
        "# PokémonAI Arena",
        "",
        f"Games: {len(battles)}/{requested}",
        "",
        "| Player | Wins | Losses | Ties | Avg decision ms |",
        "|---|---:|---:|---:|---:|",
    ]
    for player in players:
        item = summary[player]
        average = metadata.get(player, {}).get("averageDecisionMs") or ""
        lines.append(f"| {player} | {item['wins']} | {item['losses']} | {item['ties']} | {average} |")
    (output / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_arena(project_root: str | Path, plan_path: str | Path) -> Path:
    root = Path(project_root).resolve()
    plan = yaml.safe_load(Path(plan_path).read_text(encoding="utf-8"))
    if not isinstance(plan, dict):
        raise ValueError("Arena config must be a mapping")
    format_id = str(plan.get("format", "")).strip()
    games = int(plan.get("games", 1000))
    seed = int(plan.get("seed", 0))
    timeout_seconds = int(plan.get("timeoutSeconds", 120))
    websocket = str(plan.get("showdown", "ws://127.0.0.1:8000/showdown/websocket"))
    if games < 1:
        raise ValueError("Arena games must be positive")

    agents = load_agents_config(root / "config" / "agents.yaml")
    agents.format_by_id(format_id)
    configured = agents.opponents_for_format(format_id)
    opponent_id = str(plan.get("opponent", configured[0].id if configured else ""))
    opponent = next((item for item in configured if item.id == opponent_id), None)
    if opponent is None:
        raise ValueError(f"Arena opponent is not configured for {format_id}: {opponent_id}")
    spec = agents.registry.for_target(opponent.backend)
    node = backend_executable(root, spec.id, spec.entrypoint, spec.runtime)
    script = root / "scripts" / "run-agent-integration.mjs"
    if not node.is_file() or not script.is_file():
        raise RuntimeError("Build the agent runtime before running Arena")

    started = datetime.now(timezone.utc)
    run_dir = root / "var" / "evaluations" / started.strftime("%Y%m%d-%H%M%S")
    run_dir.mkdir(parents=True, exist_ok=True)
    baseline = "ArenaBaseline"
    battles: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    for game in range(games):
        command = [
            str(node),
            str(script),
            "--project-root", str(root),
            "--format-id", format_id,
            "--opponent", opponent.username,
            "--showdown", websocket,
            "--timeout-ms", str(timeout_seconds * 1000),
            "--username", baseline,
            "--team-index", str((seed + game) % 2_147_483_647),
        ]
        try:
            result = subprocess.run(
                command,
                cwd=root,
                capture_output=True,
                text=True,
                timeout=timeout_seconds + 10,
                check=True,
            )
            item = json.loads(result.stdout.strip().splitlines()[-1])
            battles.append({
                "roomid": item["roomId"],
                "p1": baseline,
                "p2": opponent.username,
                "winner": item["winner"],
                "turns": item["turns"],
                "seed": seed + game,
            })
        except (subprocess.SubprocessError, ValueError, KeyError, IndexError) as error:
            failures.append({"game": game, "seed": seed + game, "error": str(error)})
    if failures:
        (run_dir / "failures.json").write_text(
            json.dumps(failures, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    common = {
        "formatId": format_id,
        "formatPackSha256": _file_hash(root / "packages" / "pokemonai-engine" / "src" / "formats.ts"),
        "metaSourceUpdatedAt": _current_meta_updated_at(root, format_id),
        "showdownCommit": _git_commit(root / "vendor" / "pokemon-showdown"),
        "seedStart": seed,
        "baseline": "deterministic-legal-damage-without-belief-or-search",
    }
    metadata = {
        baseline: {**common, "averageDecisionMs": None},
        opponent.username: {
            **common,
            "backendCommit": _git_commit(root),
            "averageDecisionMs": _decision_average(root, opponent.id, started),
        },
    }
    _write_reports(
        run_dir,
        [baseline, opponent.username],
        battles,
        requested=games,
        metadata=metadata,
    )
    return run_dir
