from __future__ import annotations

import argparse
import json
from pathlib import Path

import yaml


def quote(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    raw = yaml.safe_load(Path(args.config).read_text(encoding="utf-8"))
    opponents = raw["opponents"]
    lines = [
        "/** Generated from config/agents.yaml. Do not edit by hand. */",
        "export interface PokemonAIOpponent {",
        "\tid: string; label: string; username: string; description: string;",
        "}",
        "export const PokemonAIConfig = {",
        f"\tformat: {quote(raw['format'])},",
        f"\tsourceUrl: {quote(raw['source_url'])},",
        "\topponents: [",
    ]
    for opponent in opponents:
        lines.append(
            "\t\t{ "
            f"id: {quote(opponent['id'])}, label: {quote(opponent['label'])}, "
            f"username: {quote(opponent['username'])}, description: {quote(opponent.get('description', ''))} "
            "},"
        )
    lines.extend(["\t] as PokemonAIOpponent[],", "} as const;", ""])
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
