#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "pokemonai-core" / "src"))

from pokemonai_core.team_library import (  # noqa: E402
    TeamLibraryBuilder,
    TeamSourceSynchronizer,
    load_team_sources,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Synchronise and build the PokémonAI team library")
    parser.add_argument("command", choices=("sync", "build", "validate", "list"))
    parser.add_argument("--config", default="config/team-sources.yaml")
    parser.add_argument("--project-root", default=".")
    parser.add_argument("--source", action="append", default=[])
    parser.add_argument("--no-validate", action="store_true")
    args = parser.parse_args()
    root = Path(args.project_root).resolve()
    config = load_team_sources(root / args.config, project_root=root)
    if args.command == "sync":
        print(json.dumps(TeamSourceSynchronizer(config).sync(set(args.source) or None), indent=2, ensure_ascii=False))
        return
    if args.command in {"build", "validate"}:
        records = TeamLibraryBuilder(config, root).build(
            validate=not args.no_validate, source_ids=set(args.source) or None,
        )
        print(f"Built {len(records)} unique teams in {config.library_dir}")
        return
    index = config.library_dir / "index.json"
    if not index.exists():
        raise SystemExit("Team library has not been built yet")
    for team in json.loads(index.read_text(encoding="utf-8")).get("teams", []):
        print(
            f"{team['id']}\t{team['format_id']}\t{team['validation_status']}\t"
            f"{team['name']}\t{team['source_id']}"
        )


if __name__ == "__main__":
    main()
