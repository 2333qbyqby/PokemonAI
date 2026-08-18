from __future__ import annotations

import argparse
import json
from pathlib import Path

from .team_library import TeamLibraryBuilder, TeamSourceSynchronizer, load_team_sources


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Synchronise and build the PokémonAI team library")
    parser.add_argument("command", choices=("sync", "build", "validate", "list"))
    parser.add_argument("--config", default="config/team-sources.yaml")
    parser.add_argument("--project-root", default=".")
    parser.add_argument("--source", action="append", default=[])
    parser.add_argument("--no-validate", action="store_true")
    return parser


def cli() -> None:
    args = build_parser().parse_args()
    root = Path(args.project_root).resolve()
    config = load_team_sources(root / args.config, project_root=root)
    if args.command == "sync":
        manifests = TeamSourceSynchronizer(config).sync(set(args.source) or None)
        print(json.dumps(manifests, indent=2, ensure_ascii=False))
        return
    if args.command in {"build", "validate"}:
        records = TeamLibraryBuilder(config, root).build(
            validate=not args.no_validate, source_ids=set(args.source) or None
        )
        print(f"Built {len(records)} unique teams in {config.library_dir}")
        return
    index = config.library_dir / "index.json"
    if not index.exists():
        raise SystemExit("Team library has not been built yet")
    data = json.loads(index.read_text(encoding="utf-8"))
    for team in data.get("teams", []):
        print(
            f"{team['id']}\t{team['format_id']}\t{team['validation_status']}\t"
            f"{team['name']}\t{team['source_id']}"
        )


if __name__ == "__main__":
    cli()
