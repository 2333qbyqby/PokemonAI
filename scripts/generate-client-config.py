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
    formats = raw.get("formats") or [
        {
            "id": "default",
            "label": str(raw["format"]),
            "showdown_format": str(raw["format"]),
            "game_type": "doubles" if "vgc" in str(raw["format"]).lower() else "singles",
            "team_preview": "bring6_pick4" if "vgc" in str(raw["format"]).lower() else "none",
            "open_team_sheets": "vgc" in str(raw["format"]).lower(),
        }
    ]
    default_format = str(raw.get("default_format", formats[0]["id"]))
    opponents = raw["opponents"]
    lines = [
        "/** Generated from config/agents.yaml. Do not edit by hand. */",
        "/* eslint-disable @stylistic/max-len */",
        "export interface PokemonAIFormat {",
        "\tid: string; label: string; showdownFormat: string; gameType: 'singles' | 'doubles';",
        "\tteamPreview: string; openTeamSheets: boolean; description: string; requiresTeam: boolean;",
        "}",
        "export interface PokemonAIOpponent {",
        "\tid: string; label: string; username: string; description: string;",
        "\tformatId: string; difficulty: number; style: string;",
        "}",
        "export const PokemonAIConfig = {",
        f"\tdefaultFormat: {quote(default_format)},",
        f"\tsourceUrl: {quote(str(raw['source_url']))},",
        "\tteamLibraryUrl: \"/data/pokemonai-teams.json\",",
        "\tformats: [",
    ]
    for item in formats:
        showdown_format = str(item["showdown_format"])
        team_preview = str(item.get("team_preview", "none"))
        requires_team = team_preview != "none" or "random" not in showdown_format.lower()
        lines.append(
            "\t\t{ "
            f"id: {quote(str(item['id']))}, label: {quote(str(item['label']))}, "
            f"showdownFormat: {quote(showdown_format)}, gameType: {quote(str(item['game_type']))} as 'singles' | 'doubles', "
            f"teamPreview: {quote(team_preview)}, openTeamSheets: {str(bool(item.get('open_team_sheets', False))).lower()}, "
            f"description: {quote(str(item.get('description', '')))}, requiresTeam: {str(requires_team).lower()} "
            "},"
        )
    lines.extend(["\t] as PokemonAIFormat[],", "\topponents: ["])
    legacy_id = str(formats[0]["id"])
    for opponent in opponents:
        lines.append(
            "\t\t{ "
            f"id: {quote(str(opponent['id']))}, label: {quote(str(opponent['label']))}, "
            f"username: {quote(str(opponent['username']))}, description: {quote(str(opponent.get('description', '')))}, "
            f"formatId: {quote(str(opponent.get('format_id', legacy_id)))}, "
            f"difficulty: {int(opponent.get('difficulty', 1))}, style: {quote(str(opponent.get('style', 'balanced')))} "
            "},"
        )
    lines.extend([
        "\t] as PokemonAIOpponent[],",
        "} as const;",
        "",
    ])
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
