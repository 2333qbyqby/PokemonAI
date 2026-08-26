from __future__ import annotations

import json
from pathlib import Path

import pytest

from pokemonai_core.meta.adapters import (
    MUNCHSTATS_FORMATS,
    MunchStatsAdapter,
    normalize_profile,
)
from pokemonai_core.meta.manager import MetaManager
from pokemonai_core.meta.models import FORMAT_IDS, FormatProbe


@pytest.mark.parametrize(
    ("spread", "teammate", "expected_basis"),
    [
        ("32/0/0/0/0/32", "#1", "derived-independent-marginals"),
        ("0/0/0/32/0/32", "#2", "derived-independent-marginals"),
        ("Jolly:0/32/0/0/0/32", "42.5", "source-joint"),
    ],
)
def test_munchstats_profile_normalization(spread: str, teammate: str, expected_basis: str):
    species_id, profile = normalize_profile({
        "selected_pokemon": "Garchomp",
        "current_pokemon": ["Garchomp", 12.5, 3],
        "base_stats": [108, 130, 95, 80, 85, 102],
        "moves_list": [["Earthquake", "80.0"], ["Protect", "70.0"]],
        "items_list": [["Clear Amulet", "75.0"], ["Life Orb", "25.0"]],
        "abilities_list": [["Rough Skin", "100.0"]],
        "natures_list": [["Jolly", "60.0", ""], ["Adamant", "40.0", ""]],
        "spreads_list": [[spread, "50.0"]],
        "teammates_list": [["Incineroar", teammate]],
        "counters_list": [["Weavile", "55.0"]],
    })
    assert species_id == "garchomp"
    assert profile["usage"] == {"probability": pytest.approx(0.125), "rank": 3}
    assert profile["moves"][0]["probability"] == pytest.approx(0.8)
    assert sum(item["probability"] for item in profile["items"]) == pytest.approx(1)
    if teammate.startswith("#"):
        assert profile["teammates"][0]["probability"] is None
    else:
        assert profile["teammates"][0]["probability"] == pytest.approx(0.425)
    assert {item["basis"] for item in profile["speedDistribution"]} == {expected_basis}


def test_munchstats_update_dates_are_required():
    adapter = MunchStatsAdapter(Path.cwd())
    with pytest.raises(ValueError, match="champions_updated"):
        adapter._source_updated_at(MUNCHSTATS_FORMATS["champions-ranked-doubles"], {})
    with pytest.raises(ValueError, match="selected_month"):
        adapter._source_updated_at(MUNCHSTATS_FORMATS["champions-ou"], {})


class FakeAdapter:
    def __init__(self, dates: dict[str, str], *, team_dates: dict[str, str] | None = None, fail: bool = False):
        self.dates = dates
        self.team_dates = team_dates or dates
        self.fail = fail
        self.fetch_calls: list[str] = []
        self.team_fetch_calls: list[str] = []

    def probe_all(self):
        if self.fail:
            raise RuntimeError("fixture failure")
        return {
            format_id: FormatProbe(
                format_id,
                MUNCHSTATS_FORMATS[format_id].source_format,
                MUNCHSTATS_FORMATS[format_id].rating,
                self.dates[format_id],
                ("Garchomp",),
                {"selected_pokemon": "Garchomp"},
                self.team_dates[format_id],
            )
            for format_id in FORMAT_IDS
        }

    def fetch_format(self, probe, progress=None):
        self.fetch_calls.append(probe.format_id)
        if progress:
            progress(probe.format_id, 1, 1)
        return ({
            "formatId": probe.format_id,
            "sourceFormat": probe.source_format,
            "rating": probe.rating,
            "sourceUpdatedAt": probe.source_updated_at,
            "speciesProfiles": {"garchomp": {"species": "Garchomp"}},
        }, [])

    def fetch_teams(self, probe, progress=None):
        self.team_fetch_calls.append(probe.format_id)
        if progress:
            progress(probe.format_id, 1, 1)
        return ([{
            "id": f"replay-ranking:{probe.format_id}:garchomp",
            "name": "Garchomp",
            "formatId": probe.format_id,
            "sourceKind": "showdown-replay-ranking",
            "sourceLabel": "MunchStats Replays",
            "observedAt": probe.team_source_updated_at,
            "completeness": "roster-only",
            "roster": ["Garchomp"] * 6,
            "sets": [],
            "validationStatus": "roster-only",
        }], [])


def test_date_check_partial_update_publish_failure_and_rollback(tmp_path: Path):
    dates = {
        "champions-ranked-doubles": "2026-08-23T23:09:00Z",
        "champions-ranked-singles": "2026-08-23T23:09:00Z",
        "champions-ou": "2026-07",
    }
    holder = {"adapter": FakeAdapter(dates)}
    manager = MetaManager(tmp_path, adapter_factory=lambda: holder["adapter"])

    first = manager.create_import()
    assert first.state == "ready"
    assert set(holder["adapter"].fetch_calls) == set(FORMAT_IDS)
    assert set(holder["adapter"].team_fetch_calls) == set(FORMAT_IDS)
    manager.publish(first.id)

    holder["adapter"] = FakeAdapter(dates)
    unchanged = manager.create_import()
    assert unchanged.state == "up_to_date"
    assert holder["adapter"].fetch_calls == []
    assert holder["adapter"].team_fetch_calls == []

    holder["adapter"] = FakeAdapter(
        {
            **dates,
            "champions-ranked-doubles": "2026-08-24T23:09:00Z",
            "champions-ranked-singles": "2026-08-22T23:09:00Z",
        },
        team_dates=dates,
    )
    changed = manager.create_import()
    assert changed.state == "ready"
    assert holder["adapter"].fetch_calls == ["champions-ranked-doubles"]
    assert holder["adapter"].team_fetch_calls == []
    assert changed.warnings
    manager.publish(changed.id)
    current = json.loads(manager.current.read_text(encoding="utf-8"))
    assert current["formats"]["champions-ranked-singles"]["sourceUpdatedAt"] == dates["champions-ranked-singles"]

    before_failure = manager.current.read_text(encoding="utf-8")
    holder["adapter"] = FakeAdapter(dates, fail=True)
    assert manager.create_import().state == "failed"
    assert manager.current.read_text(encoding="utf-8") == before_failure

    manager.rollback()
    rolled_back = json.loads(manager.current.read_text(encoding="utf-8"))
    assert rolled_back["formats"]["champions-ranked-doubles"]["sourceUpdatedAt"] == dates["champions-ranked-doubles"]


def test_team_catalog_separates_roster_only_and_full_team_details(tmp_path: Path):
    dates = {format_id: "2026-08-24T00:00:00Z" for format_id in FORMAT_IDS}
    manager = MetaManager(tmp_path, adapter_factory=lambda: FakeAdapter(dates))
    imported = manager.create_import()
    manager.publish(imported.id)

    roster_page = manager.team_catalog(
        format_id="champions-ranked-singles",
        completeness="roster-only",
        query="Garchomp",
        limit=10,
    )
    assert roster_page["total"] == 1
    assert roster_page["teams"][0]["completeness"] == "roster-only"
    detail = manager.team_catalog_detail(roster_page["teams"][0]["id"])
    assert detail is not None
    assert detail["sets"] == []
    assert "packedTeam" not in detail
    assert (tmp_path / "var/generated/public/pokemonai-team-catalog.json").is_file()
