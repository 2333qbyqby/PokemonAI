from __future__ import annotations

from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import replace
from datetime import datetime, timezone
import math
from pathlib import Path
import re
from typing import Any, Callable
from urllib.parse import quote

from pokemonai_core.team_library import pack_team, parse_paste, prevalidate_team, to_id

from .http import SafeHttpClient
from .models import FORMAT_IDS, FormatBinding, FormatProbe


MUNCHSTATS_FORMATS: dict[str, FormatBinding] = {
    "champions-ranked-doubles": FormatBinding(
        "champions-ranked-doubles", "championsdoubles", "0", "champions_updated"
    ),
    "champions-ranked-singles": FormatBinding(
        "champions-ranked-singles", "championssingles", "0", "champions_updated"
    ),
    "champions-ou": FormatBinding(
        "champions-ou", "gen9championsou", "1760", "selected_month"
    ),
}

MUNCHSTATS_ATTRIBUTION = "MunchStats"
MUNCHSTATS_URL = "https://munchstats.com"

MUNCHSTATS_REPLAY_FORMATS = {
    "champions-ranked-doubles": "gen9championsvgc2026regmb",
    "champions-ranked-singles": "gen9championsbssregmb",
    "champions-ou": "gen9championsou",
}
MUNCHSTATS_TEAM_REPOSITORY = "champions-mb"
MUNCHSTATS_TEAM_LIMIT = 300
MUNCHSTATS_PLAYABLE_TEAM_LIMIT = 60

_MONTH = re.compile(r"^20\d\d-(0[1-9]|1[0-2])$")
_CHAMPIONS_DATE = "%B %d, %Y at %H:%M UTC"
_POSITIVE_SPEED_NATURES = {"timid", "hasty", "jolly", "naive"}
_NEGATIVE_SPEED_NATURES = {"brave", "relaxed", "quiet", "sassy"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def percentage(value: Any) -> float:
    if isinstance(value, str):
        value = value.strip().removesuffix("%")
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return min(1.0, max(0.0, number / 100.0))


def normalize_options(rows: Any, *, categorical: bool) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    if not isinstance(rows, list):
        return result
    for row in rows:
        if not isinstance(row, list) or len(row) < 2:
            continue
        name = str(row[0] or "").strip()
        probability = percentage(row[1])
        if not name or to_id(name) in {"", "nothing"} or probability <= 0:
            continue
        result.append({"name": name, "probability": probability})
    if categorical:
        total = sum(item["probability"] for item in result)
        if total > 0:
            for item in result:
                item["probability"] /= total
    return result


def normalize_associations(rows: Any) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    if not isinstance(rows, list):
        return result
    for position, row in enumerate(rows, start=1):
        if not isinstance(row, list) or len(row) < 2:
            continue
        species = str(row[0] or "").strip()
        if not species:
            continue
        raw = str(row[1] or "").strip()
        if raw.startswith("#"):
            try:
                rank = int(raw[1:])
            except ValueError:
                rank = position
            probability: float | None = None
        else:
            rank = position
            probability = percentage(raw)
        result.append({"species": species, "probability": probability, "rank": rank})
    return result


def normalize_spreads(rows: Any) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    if not isinstance(rows, list):
        return result
    for row in rows:
        if not isinstance(row, list) or len(row) < 2:
            continue
        label = str(row[0] or "").strip()
        nature: str | None = None
        values_text = label
        if ":" in label:
            nature, values_text = (part.strip() for part in label.split(":", 1))
        try:
            values = tuple(int(value) for value in values_text.split("/"))
        except ValueError:
            continue
        if len(values) != 6 or any(value < 0 or value > 252 for value in values):
            continue
        probability = percentage(row[1])
        if probability <= 0:
            continue
        result.append({"values": list(values), "nature": nature, "probability": probability})
    total = sum(item["probability"] for item in result)
    if total > 0:
        for item in result:
            item["probability"] /= total
    return result


def _speed_multiplier(nature: str | None) -> float:
    nature_id = to_id(nature)
    if nature_id in _POSITIVE_SPEED_NATURES:
        return 1.1
    if nature_id in _NEGATIVE_SPEED_NATURES:
        return 0.9
    return 1.0


def speed_distribution(
    base_stats: Any,
    spreads: list[dict[str, Any]],
    natures: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not isinstance(base_stats, list) or len(base_stats) < 6 or not spreads:
        return []
    try:
        base_speed = int(base_stats[5])
    except (TypeError, ValueError):
        return []
    weights: defaultdict[tuple[int, str], float] = defaultdict(float)
    for spread in spreads:
        speed_points = int(spread["values"][5])
        if spread.get("nature"):
            basis = "source-joint"
            choices = [(str(spread["nature"]), 1.0)]
        else:
            basis = "derived-independent-marginals"
            choices = [(str(item["name"]), float(item["probability"])) for item in natures] or [("", 1.0)]
        for nature, nature_weight in choices:
            speed = math.floor((base_speed + speed_points + 20) * _speed_multiplier(nature))
            weights[(speed, basis)] += float(spread["probability"]) * nature_weight
    total = sum(weights.values()) or 1.0
    return [
        {"value": value, "probability": weight / total, "basis": basis}
        for (value, basis), weight in sorted(weights.items())
    ]


def normalize_profile(payload: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    species = str(payload.get("selected_pokemon") or "").strip()
    species_id = to_id(species)
    if not species_id:
        raise ValueError("MunchStats detail is missing selected_pokemon")
    current = payload.get("current_pokemon")
    usage_probability: float | None = None
    rank = 0
    if isinstance(current, list):
        if len(current) > 1:
            usage_probability = percentage(current[1])
        if len(current) > 2:
            try:
                rank = int(current[2])
            except (TypeError, ValueError):
                pass
    moves = normalize_options(payload.get("moves_list"), categorical=False)
    items = normalize_options(payload.get("items_list"), categorical=True)
    abilities = normalize_options(payload.get("abilities_list"), categorical=True)
    natures = normalize_options(payload.get("natures_list"), categorical=True)
    spreads = normalize_spreads(payload.get("spreads_list"))
    return species_id, {
        "species": species,
        "usage": {"probability": usage_probability, "rank": rank},
        "moves": moves,
        "items": items,
        "abilities": abilities,
        "natures": natures,
        "statSpreads": spreads,
        "speedDistribution": speed_distribution(payload.get("base_stats"), spreads, natures),
        "teammates": normalize_associations(payload.get("teammates_list")),
        "counters": normalize_associations(payload.get("counters_list")),
    }


def _iso_from_timestamp(value: Any) -> str:
    try:
        timestamp = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("MunchStats replay data is missing an update timestamp") from error
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _iso_from_date(value: Any) -> str:
    try:
        parsed = datetime.strptime(str(value or "").strip(), "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise ValueError("MunchStats team data is missing its latest date") from error
    return parsed.isoformat().replace("+00:00", "Z")


def _team_name(value: dict[str, Any]) -> str:
    description = str(value.get("description") or "").strip()
    if description:
        return description
    parts = [str(value.get(key) or "").strip() for key in ("player", "event", "rank")]
    return " · ".join(part for part in parts if part) or str(value.get("team_id") or "MunchStats team")


def normalize_replay_team(format_id: str, row: Any, observed_at: str) -> dict[str, Any] | None:
    if not isinstance(row, dict) or not isinstance(row.get("team"), list):
        return None
    roster = [str(species or "").strip() for species in row["team"]]
    if len(roster) != 6 or any(not to_id(species) for species in roster):
        return None
    roster_key = "+".join(sorted(to_id(species) for species in roster))
    battles = max(0, int(row.get("total_battles") or 0))
    wins = max(0, int(row.get("wins") or 0))
    losses = max(0, int(row.get("losses") or 0))
    try:
        win_rate = float(row.get("win_rate") or 0) / 100.0
    except (TypeError, ValueError):
        win_rate = wins / battles if battles else 0.0
    return {
        "id": f"replay-ranking:{format_id}:{roster_key}",
        "name": " / ".join(roster),
        "formatId": format_id,
        "sourceKind": "showdown-replay-ranking",
        "sourceLabel": "MunchStats Replays",
        "sourceUrl": f"{MUNCHSTATS_URL}/replays/{MUNCHSTATS_REPLAY_FORMATS[format_id]}/",
        "observedAt": observed_at,
        "completeness": "roster-only",
        "roster": roster,
        "sets": [],
        "usage": {
            "battles": battles,
            "wins": wins,
            "losses": losses,
            "winRate": min(1.0, max(0.0, win_rate)),
            "avgRating": int(row.get("avg_rating") or 0),
            "maxRating": int(row.get("max_rating") or 0),
        },
        "validationStatus": "roster-only",
    }


def normalize_vgcpastes_team(row: Any) -> dict[str, Any] | None:
    if not isinstance(row, dict) or not isinstance(row.get("pokemon"), list):
        return None
    roster = [str(item.get("name") or "").strip() for item in row["pokemon"] if isinstance(item, dict)]
    if len(roster) != 6 or any(not to_id(species) for species in roster):
        return None
    team_id = str(row.get("team_id") or "").strip()
    if not team_id:
        return None
    source_url = str(row.get("pokepaste") or row.get("source_link") or "").strip()
    return {
        "id": f"vgcpastes:{MUNCHSTATS_TEAM_REPOSITORY}:{team_id}",
        "sourceId": team_id,
        "name": _team_name(row),
        "formatId": "champions-ranked-doubles",
        "sourceKind": "vgcpastes",
        "sourceLabel": "MunchStats · VGCPastes",
        "sourceUrl": source_url,
        "observedAt": str(row.get("date") or ""),
        "completeness": "roster-only",
        "roster": roster,
        "sets": [],
        "player": str(row.get("player") or "").strip(),
        "event": str(row.get("event") or "").strip(),
        "placing": str(row.get("rank") or "").strip(),
        "hasEvs": bool(row.get("has_evs")),
        "pasteUrl": str(row.get("pokepaste") or "").strip(),
        "validationStatus": "roster-only",
    }


def _meta_set(team_set: Any) -> dict[str, Any]:
    return {
        "species": team_set.species,
        "moves": list(team_set.moves),
        "item": team_set.item,
        "ability": team_set.ability,
        "nature": team_set.nature,
        "statPoints": [int(team_set.evs.get(name, 0)) for name in ("hp", "atk", "def", "spa", "spd", "spe")],
        "teraType": team_set.tera_type,
    }


class MunchStatsAdapter:
    def __init__(self, project_root: str | Path) -> None:
        self.project_root = Path(project_root).resolve()
        self.http = SafeHttpClient(allowed_hosts=frozenset({"munchstats.com", "www.munchstats.com"}))

    def probe_all(self) -> dict[str, FormatProbe]:
        probes: dict[str, FormatProbe] = {}
        for format_id, binding in MUNCHSTATS_FORMATS.items():
            probe = self._probe(binding)
            probes[format_id] = replace(
                probe,
                team_source_updated_at=self._team_source_updated_at(format_id),
            )
        return probes

    def _team_source_updated_at(self, format_id: str) -> str:
        replay_format = MUNCHSTATS_REPLAY_FORMATS[format_id]
        rows = self.http.get_json(
            f"{MUNCHSTATS_URL}/replays/api/search?filter_format={replay_format}"
        )
        timestamps = [
            int(row[6]) for row in rows
            if isinstance(row, list) and len(row) > 6 and str(row[6]).isdigit()
        ] if isinstance(rows, list) else []
        dates = [_iso_from_timestamp(max(timestamps))] if timestamps else []
        if format_id == "champions-ranked-doubles":
            payload = self.http.get_json(
                f"{MUNCHSTATS_URL}/teams/api/{MUNCHSTATS_TEAM_REPOSITORY}/?limit=1&offset=0&sort=newest"
            )
            teams = payload.get("teams") if isinstance(payload, dict) else None
            if isinstance(teams, list) and teams and isinstance(teams[0], dict):
                dates.append(_iso_from_date(teams[0].get("date")))
        if not dates:
            raise ValueError(f"MunchStats {format_id} returned no team update date")
        return max(dates)

    def _probe(self, binding: FormatBinding) -> FormatProbe:
        url = f"{MUNCHSTATS_URL}/api/{binding.source_format}/{binding.rating}/"
        try:
            payload = self.http.get_json(url)
        except RuntimeError:
            if binding.format_id != "champions-ou":
                raise
            payload = self.http.get_json(f"{MUNCHSTATS_URL}/api/{binding.source_format}/")
        if not isinstance(payload, dict):
            raise ValueError(f"MunchStats {binding.format_id} index schema changed")
        pokemon_names = payload.get("pokemon_names")
        if not isinstance(pokemon_names, list):
            raise ValueError(f"MunchStats {binding.format_id} index is missing pokemon_names")
        names = tuple(
            str(row[0]).strip() for row in pokemon_names
            if isinstance(row, list) and row and str(row[0]).strip()
        )
        if not names:
            raise ValueError(f"MunchStats {binding.format_id} returned no Pokemon")
        rating = str(payload.get("selected_rating") or binding.rating)
        source_updated_at = self._source_updated_at(binding, payload)
        return FormatProbe(
            binding.format_id,
            binding.source_format,
            rating,
            source_updated_at,
            names,
            payload,
        )

    def _source_updated_at(self, binding: FormatBinding, payload: dict[str, Any]) -> str:
        raw = str(payload.get(binding.update_field) or "").strip()
        if binding.update_field == "selected_month":
            if not _MONTH.fullmatch(raw):
                raise ValueError(f"MunchStats {binding.format_id} is missing selected_month")
            return raw
        try:
            parsed = datetime.strptime(raw, _CHAMPIONS_DATE).replace(tzinfo=timezone.utc)
        except ValueError as error:
            raise ValueError(f"MunchStats {binding.format_id} has an invalid champions_updated value") from error
        return parsed.isoformat().replace("+00:00", "Z")

    def fetch_format(
        self,
        probe: FormatProbe,
        progress: Callable[[str, int, int], None] | None = None,
    ) -> tuple[dict[str, Any], list[str]]:
        total = len(probe.pokemon_names)
        profiles: dict[str, dict[str, Any]] = {}
        failures: dict[str, str] = {}
        landing_species = to_id(probe.landing.get("selected_pokemon"))
        if landing_species:
            try:
                species_id, profile = normalize_profile(probe.landing)
                profiles[species_id] = profile
            except ValueError as error:
                failures[landing_species] = str(error)
        completed = 1 if landing_species else 0
        if progress:
            progress(probe.format_id, completed, total)

        pending = [name for name in probe.pokemon_names if to_id(name) != landing_species]
        with ThreadPoolExecutor(max_workers=3, thread_name_prefix="munchstats") as executor:
            futures = {
                executor.submit(self._fetch_detail, probe, name): name
                for name in pending
            }
            for future in as_completed(futures):
                name = futures[future]
                try:
                    species_id, profile = normalize_profile(future.result())
                    profiles[species_id] = profile
                except Exception as error:  # each failure is evaluated against coverage below
                    failures[to_id(name)] = str(error)
                completed += 1
                if progress:
                    progress(probe.format_id, completed, total)

        top_species = {to_id(name) for name in probe.pokemon_names[:50]}
        missing_top = sorted(top_species.difference(profiles))
        coverage = len(profiles) / max(1, total)
        if missing_top:
            raise ValueError(f"MunchStats {probe.format_id} is missing top Pokemon: {', '.join(missing_top[:5])}")
        if coverage < 0.98:
            raise ValueError(f"MunchStats {probe.format_id} coverage is {coverage:.1%}, below 98%")
        warnings = [f"{species}: {message}" for species, message in sorted(failures.items())]
        return {
            "formatId": probe.format_id,
            "sourceFormat": probe.source_format,
            "rating": probe.rating,
            "sourceUpdatedAt": probe.source_updated_at,
            "speciesProfiles": profiles,
        }, warnings

    def fetch_teams(
        self,
        probe: FormatProbe,
        progress: Callable[[str, int, int], None] | None = None,
    ) -> tuple[list[dict[str, Any]], list[str]]:
        replay_format = MUNCHSTATS_REPLAY_FORMATS[probe.format_id]
        ranking_rows = self.http.get_json(
            f"{MUNCHSTATS_URL}/replays/api/rankings?format={replay_format}&limit=200"
        )
        if not isinstance(ranking_rows, list):
            raise ValueError(f"MunchStats {probe.format_id} replay team schema changed")
        records = [
            team for row in ranking_rows
            if (team := normalize_replay_team(probe.format_id, row, probe.team_source_updated_at)) is not None
        ]
        warnings: list[str] = []
        if probe.format_id != "champions-ranked-doubles":
            if progress:
                progress(probe.format_id, len(records), len(records))
            return records, warnings

        payload = self.http.get_json(
            f"{MUNCHSTATS_URL}/teams/api/{MUNCHSTATS_TEAM_REPOSITORY}/"
            f"?limit={MUNCHSTATS_TEAM_LIMIT}&offset=0&sort=newest"
        )
        rows = payload.get("teams") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            raise ValueError("MunchStats Champions team repository schema changed")
        repository_records = [
            team for row in rows
            if (team := normalize_vgcpastes_team(row)) is not None
        ]
        records.extend(repository_records)
        playable = [
            team for team in repository_records
            if team.get("hasEvs") and team.get("pasteUrl")
        ][:MUNCHSTATS_PLAYABLE_TEAM_LIMIT]
        total = len(records) + len(playable)
        if progress:
            progress(probe.format_id, len(records), total)

        by_id = {team["id"]: team for team in records}
        with ThreadPoolExecutor(max_workers=3, thread_name_prefix="munchstats-teams") as executor:
            futures = {
                executor.submit(self._fetch_team_paste, str(team["sourceId"])): team
                for team in playable
            }
            completed = len(records)
            for future in as_completed(futures):
                team = futures[future]
                try:
                    paste = future.result()
                    sets = parse_paste(paste)
                    errors = prevalidate_team(sets, probe.format_id)
                    if errors:
                        team["validationStatus"] = "invalid-precheck"
                        warnings.append(f"{team['sourceId']}: {'; '.join(errors)}")
                    else:
                        team["sets"] = [_meta_set(item) for item in sets]
                        team["paste"] = paste.strip()
                        team["packedTeam"] = pack_team(sets)
                        team["completeness"] = "full-set"
                        team["validationStatus"] = "prevalidated"
                except Exception as error:
                    warnings.append(f"{team['sourceId']}: {error}")
                by_id[team["id"]] = team
                completed += 1
                if progress:
                    progress(probe.format_id, completed, total)
        return list(by_id.values()), warnings

    def _fetch_team_paste(self, team_id: str) -> str:
        encoded = quote(team_id, safe="")
        payload = self.http.get_json(
            f"{MUNCHSTATS_URL}/teams/api/{MUNCHSTATS_TEAM_REPOSITORY}/paste/{encoded}"
        )
        text = payload.get("text") if isinstance(payload, dict) else None
        if not isinstance(text, str) or not text.strip():
            raise ValueError("MunchStats team paste is unavailable")
        return text

    def _fetch_detail(self, probe: FormatProbe, species: str) -> dict[str, Any]:
        encoded = quote(species, safe="")
        payload = self.http.get_json(
            f"{MUNCHSTATS_URL}/api/{probe.source_format}/{probe.rating}/{encoded}"
        )
        if not isinstance(payload, dict):
            raise ValueError("MunchStats detail schema changed")
        return payload


def validate_snapshot(snapshot: Any) -> dict[str, Any]:
    if not isinstance(snapshot, dict) or snapshot.get("schema") != "pokemonai-meta":
        raise ValueError("Meta snapshot has an unsupported schema")
    if snapshot.get("source") != "munchstats" or not isinstance(snapshot.get("formats"), dict):
        raise ValueError("Meta snapshot has invalid source metadata")
    formats = snapshot["formats"]
    if set(formats) != set(FORMAT_IDS):
        raise ValueError("Meta snapshot must contain all supported formats")
    for format_id in FORMAT_IDS:
        value = formats.get(format_id)
        if not isinstance(value, dict) or value.get("formatId") != format_id:
            raise ValueError(f"Meta snapshot format is invalid: {format_id}")
        if not value.get("sourceUpdatedAt") or not isinstance(value.get("speciesProfiles"), dict):
            raise ValueError(f"Meta snapshot format is incomplete: {format_id}")
        if "teams" in value and not isinstance(value.get("teams"), list):
            raise ValueError(f"Meta snapshot team corpus is invalid: {format_id}")
    return snapshot
