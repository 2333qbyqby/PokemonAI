from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import yaml


def build_command(args: argparse.Namespace) -> list[str]:
    raw = yaml.safe_load(Path(args.config).read_text(encoding="utf-8"))
    formats = {
        str(entry.get("id")): str(entry.get("showdown_format"))
        for entry in raw.get("formats", [])
        if isinstance(entry, dict)
    }
    if not formats and raw.get("format"):
        formats["default"] = str(raw["format"])
    experts = [entry for entry in raw.get("opponents", []) if entry.get("backend") == "foul_play"]
    if len(experts) != 1:
        raise ValueError("Configuration must contain exactly one foul_play opponent")
    expert = experts[0]
    options = expert.get("options") or {}
    format_id = str(expert.get("format_id", "default"))
    battle_format = formats.get(format_id)
    if not battle_format:
        raise ValueError(f"Foul Play opponent references unknown format: {format_id}")
    if "vgc" in battle_format.lower() or "double" in battle_format.lower():
        raise ValueError("Foul Play is singles-only; use pokemonai.vgc for doubles")
    required_options = ("search_time_ms", "search_parallelism", "search_threads")
    missing = [name for name in required_options if name not in options]
    if missing:
        raise ValueError(f"Missing Foul Play options: {', '.join(missing)}")

    return [
        sys.executable,
        str(Path(args.foul_play_root).resolve() / "run.py"),
        "--websocket-uri",
        args.websocket_uri,
        "--ps-username",
        str(expert["username"]),
        "--bot-mode",
        "accept_challenge",
        "--pokemon-format",
        battle_format,
        "--search-time-ms",
        str(options["search_time_ms"]),
        "--search-parallelism",
        str(options["search_parallelism"]),
        "--search-threads",
        str(options["search_threads"]),
        "--run-count",
        "2147483647",
        "--save-replay",
        "never",
        "--log-level",
        "INFO",
        "--log-to-file",
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description="Start Foul Play from the PokemonAI agent registry")
    parser.add_argument("--config", required=True)
    parser.add_argument("--foul-play-root", required=True)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument(
        "--websocket-uri",
        default=os.environ.get("POKEMONAI_SHOWDOWN_WS", "ws://127.0.0.1:8000/showdown/websocket"),
    )
    parser.add_argument("--print-command", action="store_true")
    args = parser.parse_args()
    command = build_command(args)
    if args.print_command:
        print(json.dumps(command, ensure_ascii=False))
        return
    data_dir = Path(args.data_dir).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    os.chdir(data_dir)
    os.execv(sys.executable, command)


if __name__ == "__main__":
    main()
