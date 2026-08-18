from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from baseline_ai.team_library import (
    TeamLibraryBuilder,
    TeamSourceSynchronizer,
    export_paste,
    load_team_sources,
    pack_team,
    parse_packed,
    parse_paste,
    prevalidate_team,
    team_fingerprint,
)


ROOT = Path(__file__).resolve().parents[3]
SAMPLE = """Alpha @ Focus Sash
Ability: Prankster
Level: 50
EVs: 32 HP / 32 Spe / 2 SpA
Timid Nature
- Tailwind
- Protect
- Moonblast
- Encore

Bravo @ Sitrus Berry
Ability: Intimidate
Level: 50
EVs: 32 HP / 32 Atk / 2 SpD
Adamant Nature
- Fake Out
- Protect
- Tackle
- Helping Hand
"""


def test_paste_and_packed_round_trip_have_same_fingerprint():
    sets = parse_paste(SAMPLE)
    assert len(sets) == 2
    packed = pack_team(sets)
    unpacked = parse_packed(packed)
    assert [item.species for item in unpacked] == ["Alpha", "Bravo"]
    assert team_fingerprint(sets) == team_fingerprint(unpacked)


def test_source_config_pins_github_commits_and_keeps_unknown_license_disabled():
    config = load_team_sources(ROOT / "config" / "team-sources.yaml", project_root=ROOT)
    vgc_bench = next(source for source in config.sources if source.id == "vgc-bench")
    unknown = next(source for source in config.sources if source.id == "pokemon-vgc-ai")
    assert len(vgc_bench.ref or "") == 40
    assert vgc_bench.license == "MIT"
    assert vgc_bench.adapter == "vgc-bench"
    assert unknown.enabled is False
    assert unknown.license == "UNKNOWN"
    assert unknown.adapter == "pokemon-vgc-ai"
    assert unknown.pool == "champions-reg-mb"


def test_enabled_unknown_license_is_rejected(tmp_path: Path):
    path = tmp_path / "sources.yaml"
    path.write_text(
        """
sources:
  - id: unsafe
    label: Unsafe
    type: github
    repository: example/repo
    ref: 1111111111111111111111111111111111111111
    enabled: true
    license: UNKNOWN
""",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="unknown license"):
        load_team_sources(path, project_root=tmp_path)


def test_source_id_cannot_escape_the_cache_root(tmp_path: Path):
    path = tmp_path / "sources.yaml"
    path.write_text(
        """
sources:
  - id: ../../escape
    label: Unsafe
    type: directory
    path: teams
    enabled: false
    license: MIT
""",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="unsafe characters"):
        load_team_sources(path, project_root=tmp_path)


def test_builtin_library_builds_public_catalogue(tmp_path: Path):
    # Build in a small isolated project while reusing the real parser and format registry.
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "agents.yaml").write_text(
        """
default_format: test
source_url: /source.tar.gz
formats:
  - id: test
    label: Test
    showdown_format: gen9vgc2025regi
    game_type: doubles
    team_preview: bring6_pick4
opponents:
  - {id: bot, label: Bot, username: Test Bot, backend: pokemonai.vgc, format_id: test}
""",
        encoding="utf-8",
    )
    source = tmp_path / "teams" / "test"
    source.mkdir(parents=True)
    six = "\n\n".join(SAMPLE.strip().split("\n\n") * 3)
    (source / "six.paste.txt").write_text(six, encoding="utf-8")
    sources = tmp_path / "config" / "team-sources.yaml"
    sources.write_text(
        """
cache_dir: cache
library_dir: library
sources:
  - id: local
    label: Local
    type: directory
    path: teams
    enabled: true
    license: MIT
    format_id: test
    pool: test
""",
        encoding="utf-8",
    )
    config = load_team_sources(sources, project_root=tmp_path)
    records = TeamLibraryBuilder(config, tmp_path).build(validate=False)
    assert len(records) == 1
    assert records[0].pool == "test"
    index = json.loads((tmp_path / "library" / "index.json").read_text(encoding="utf-8"))
    assert index["team_count"] == 1
    public = json.loads(
        (tmp_path / "apps" / "showdown-client" / "play.pokemonshowdown.com" / "data" / "pokemonai-teams.json").read_text(encoding="utf-8")
    )
    assert public["teamCount"] == 1


def test_packaging_does_not_exclude_vendor_showdown_data():
    web_dockerfile = (ROOT / "deploy" / "web.Dockerfile").read_text(encoding="utf-8")
    package_script = (ROOT / "scripts" / "package-source.ps1").read_text(encoding="utf-8")
    assert "--exclude=data" not in web_dockerfile
    assert "vendor\\pokemon-showdown\\data" not in package_script


def test_explicit_sync_can_select_a_disabled_known_license_source(monkeypatch):
    config = load_team_sources(ROOT / "config" / "team-sources.yaml", project_root=ROOT)
    syncer = TeamSourceSynchronizer(config)
    seen = []

    def fake_sync(source):
        seen.append(source.id)
        return {"source": source.id, "status": "ok"}

    monkeypatch.setattr(syncer, "_sync_github", fake_sync)
    result = syncer.sync({"vgc-bench"})
    assert seen == ["vgc-bench"]
    assert result == [{"source": "vgc-bench", "status": "ok"}]


def test_explicit_sync_still_blocks_an_unknown_license_source():
    config = load_team_sources(ROOT / "config" / "team-sources.yaml", project_root=ROOT)
    with pytest.raises(ValueError, match="unknown license"):
        TeamSourceSynchronizer(config).sync({"pokemon-vgc-ai"})


def _git_blob_sha(payload: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(payload)).encode("ascii") + b"\0" + payload).hexdigest()


def _remote_source_config(tmp_path: Path):
    path = tmp_path / "sources.yaml"
    path.write_text(
        """
cache_dir: cache
library_dir: library
sources:
  - id: remote
    label: Remote
    type: github
    repository: example/teams
    ref: 1111111111111111111111111111111111111111
    include: ["teams/**/*"]
    enabled: true
    license: MIT
""",
        encoding="utf-8",
    )
    return load_team_sources(path, project_root=tmp_path)


def test_github_sync_verifies_blob_and_atomically_replaces_stale_cache(tmp_path: Path, monkeypatch):
    config = _remote_source_config(tmp_path)
    destination = config.cache_dir / "remote"
    destination.mkdir(parents=True)
    (destination / "stale.txt").write_text("old", encoding="utf-8")
    payload = b"Pikachu @ Light Ball\nAbility: Static\n- Thunderbolt\n"
    sha = _git_blob_sha(payload)
    syncer = TeamSourceSynchronizer(config)
    monkeypatch.setattr(
        syncer,
        "_json",
        lambda _url: {
            "tree": [
                {"path": "teams/current.paste.txt", "type": "blob", "size": len(payload), "sha": sha}
            ]
        },
    )
    monkeypatch.setattr(syncer, "_bytes", lambda _url, **_kwargs: payload)

    [manifest] = syncer.sync()

    assert not (destination / "stale.txt").exists()
    assert (destination / "teams" / "current.paste.txt").read_bytes() == payload
    assert manifest["files"][0]["git_blob_sha"] == sha
    stored = json.loads((destination / "pokemonai-source-manifest.json").read_text(encoding="utf-8"))
    assert stored["commit"] == "1" * 40


def test_failed_github_sync_keeps_the_previous_cache(tmp_path: Path, monkeypatch):
    config = _remote_source_config(tmp_path)
    destination = config.cache_dir / "remote"
    destination.mkdir(parents=True)
    (destination / "previous.paste.txt").write_text("known good", encoding="utf-8")
    payload = b"tampered"
    syncer = TeamSourceSynchronizer(config)
    monkeypatch.setattr(
        syncer,
        "_json",
        lambda _url: {
            "tree": [
                {"path": "teams/current.paste.txt", "type": "blob", "size": len(payload), "sha": "0" * 40}
            ]
        },
    )
    monkeypatch.setattr(syncer, "_bytes", lambda _url, **_kwargs: payload)

    with pytest.raises(ValueError, match="Git blob SHA mismatch"):
        syncer.sync()

    assert (destination / "previous.paste.txt").read_text(encoding="utf-8") == "known good"
    assert not (destination / "teams" / "current.paste.txt").exists()


def test_github_sync_with_no_matches_preserves_previous_cache(tmp_path: Path, monkeypatch):
    config = _remote_source_config(tmp_path)
    destination = config.cache_dir / "remote"
    destination.mkdir(parents=True)
    (destination / "previous.paste.txt").write_text("known good", encoding="utf-8")
    syncer = TeamSourceSynchronizer(config)
    monkeypatch.setattr(syncer, "_json", lambda _url: {"truncated": False, "tree": []})

    with pytest.raises(ValueError, match="matched no supported team files"):
        syncer.sync()

    assert (destination / "previous.paste.txt").read_text(encoding="utf-8") == "known good"


def test_directory_source_rejects_a_symlink_outside_its_root(tmp_path: Path):
    source = tmp_path / "teams"
    source.mkdir()
    outside = tmp_path / "outside.paste.txt"
    outside.write_text(SAMPLE, encoding="utf-8")
    link = source / "escape.paste.txt"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlinks are unavailable on this platform")
    config_path = tmp_path / "sources.yaml"
    config_path.write_text(
        """
cache_dir: cache
library_dir: library
sources:
  - id: local
    label: Local
    type: directory
    path: teams
    enabled: true
    license: MIT
""",
        encoding="utf-8",
    )
    config = load_team_sources(config_path, project_root=tmp_path)
    builder = TeamLibraryBuilder(config, tmp_path)
    with pytest.raises(ValueError, match="escapes its configured root"):
        list(builder._source_files(config.sources[0]))


def test_explicit_build_can_include_a_disabled_known_license_source(tmp_path: Path):
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "agents.yaml").write_text(
        """
default_format: test
source_url: /source.tar.gz
formats:
  - {id: test, label: Test, showdown_format: gen9vgc2025regi, game_type: doubles, team_preview: bring6_pick4}
opponents:
  - {id: bot, label: Bot, username: Test Bot, backend: pokemonai.vgc, format_id: test}
""", encoding="utf-8")
    cache = tmp_path / "cache" / "external"
    cache.mkdir(parents=True)
    six = "\n\n".join(SAMPLE.strip().split("\n\n") * 3)
    (cache / "team.paste.txt").write_text(six, encoding="utf-8")
    sources = tmp_path / "config" / "team-sources.yaml"
    sources.write_text(
        """
cache_dir: cache
library_dir: library
sources:
  - id: external
    label: External
    type: github
    repository: example/repo
    ref: 1111111111111111111111111111111111111111
    enabled: false
    license: MIT
    format_id: test
    pool: test
""", encoding="utf-8")
    config = load_team_sources(sources, project_root=tmp_path)
    assert TeamLibraryBuilder(config, tmp_path).build(validate=False) == []
    records = TeamLibraryBuilder(config, tmp_path).build(validate=False, source_ids={"external"})
    assert len(records) == 1
    assert records[0].source_id == "external"


def test_unsupported_team_adapter_is_rejected(tmp_path: Path):
    path = tmp_path / "sources.yaml"
    path.write_text(
        """
sources:
  - id: bad
    label: Bad
    type: directory
    path: teams
    adapter: executable-plugin
    enabled: false
    license: MIT
""", encoding="utf-8")
    with pytest.raises(ValueError, match="Unsupported team source adapter"):
        load_team_sources(path, project_root=tmp_path)


def test_export_paste_uses_showdown_stat_casing():
    team = parse_paste(
        "Pikachu @ Light Ball\nAbility: Static\nEVs: 4 HP / 8 SpA / 12 SpD / 16 Spe\nTimid Nature\n- Thunderbolt"
    )
    exported = export_paste(team)
    assert "4 HP / 8 SpA / 12 SpD / 16 Spe" in exported


def test_vgc_bench_reg_mb_maps_to_current_champions_pool(tmp_path: Path):
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "agents.yaml").write_text(
        """
default_format: champions-reg-mb
source_url: /source.tar.gz
formats:
  - {id: champions-reg-mb, label: Current, showdown_format: gen9championsvgc2026regmb, game_type: doubles, team_preview: bring6_pick4}
opponents:
  - {id: bot, label: Bot, username: Bot, backend: pokemonai.vgc, format_id: champions-reg-mb}
""", encoding="utf-8")
    cache = tmp_path / "cache" / "bench" / "teams" / "reg_mb"
    cache.mkdir(parents=True)
    six = "\n\n".join(SAMPLE.strip().split("\n\n") * 3)
    (cache / "MB1.txt").write_text(six, encoding="utf-8")
    source_config = tmp_path / "config" / "team-sources.yaml"
    source_config.write_text(
        """
cache_dir: cache
library_dir: library
sources:
  - id: bench
    label: Bench
    type: github
    repository: example/bench
    ref: 1111111111111111111111111111111111111111
    include: ["teams/**/*"]
    adapter: vgc-bench
    enabled: false
    license: MIT
""", encoding="utf-8")
    config = load_team_sources(source_config, project_root=tmp_path)
    records = TeamLibraryBuilder(config, tmp_path).build(validate=False, source_ids={"bench"})
    assert len(records) == 1
    assert records[0].format_id == "champions-reg-mb"
    assert records[0].pool == "champions-reg-mb"


def test_vendored_vgc_bench_samples_are_traceable_and_prevalidated():
    config = load_team_sources(ROOT / "config" / "team-sources.yaml", project_root=ROOT)
    source = next(item for item in config.sources if item.id == "vgc-bench-samples")
    assert source.enabled is True
    assert source.license == "MIT"
    assert source.repository == "cameronangliss/vgc-bench"
    assert source.ref == "d79f9532947ac114dce1dda2456a590afcd375b2"
    paths = sorted((ROOT / str(source.path) / "teams" / "reg_mb").glob("MB*.txt"))
    assert [path.name for path in paths] == ["MB1.txt", "MB2.txt", "MB3.txt", "MB4.txt"]
    for path in paths:
        team = parse_paste(path.read_text(encoding="utf-8"))
        assert len(team) == 6
        assert prevalidate_team(team, "champions-reg-mb") == []


def test_champions_precheck_rejects_nonperfect_ivs_and_invalid_stat_points():
    from baseline_ai.team_library import prevalidate_team

    sets = list(parse_paste("\n\n".join(SAMPLE.strip().split("\n\n") * 3)))
    # The generic fixture deliberately repeats species/items, so use a clean Champions
    # team for rule-specific assertions.
    sample = ROOT / "data" / "team-sources" / "vendored" / "vgc-bench" / "teams" / "reg_mb" / "MB1.txt"
    champions_sets = list(parse_paste(sample.read_text(encoding="utf-8")))
    champions_sets[0].ivs["spe"] = 0
    champions_sets[1].evs["hp"] = 33
    champions_sets[2].evs.clear()
    champions_sets[2].evs.update({"hp": 32, "atk": 32, "def": 3})

    errors = prevalidate_team(champions_sets, "champions-reg-mb")
    assert any("non-31 IVs" in error for error in errors)
    assert any("outside 0..32" in error for error in errors)
    assert any("67 total Stat Points" in error for error in errors)
    assert prevalidate_team(sets, "test") == []


def test_builder_excludes_precheck_invalid_champions_team(tmp_path: Path):
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    sample = (
        ROOT
        / "data"
        / "team-sources"
        / "vendored"
        / "vgc-bench"
        / "teams"
        / "reg_mb"
        / "MB1.txt"
    ).read_text(encoding="utf-8")
    sample = sample.replace("Level: 50\n", "Level: 50\nIVs: 0 Spe\n", 1)
    (source_dir / "illegal.txt").write_text(sample, encoding="utf-8")
    config = tmp_path / "sources.yaml"
    config.write_text(
        f"""
sources:
  - id: fixture
    label: Fixture
    type: directory
    path: {source_dir.as_posix()}
    include: ['*.txt']
    enabled: true
    license: MIT
    format_id: champions-reg-mb
    pool: champions-reg-mb
""",
        encoding="utf-8",
    )
    private_dir = tmp_path / "private"
    raw = config.read_text(encoding="utf-8")
    config.write_text(f"library_dir: {private_dir.as_posix()}\n" + raw, encoding="utf-8")
    library_config = load_team_sources(config, project_root=tmp_path)
    records = TeamLibraryBuilder(library_config, tmp_path).build(validate=False)
    public_file = (
        tmp_path
        / "apps"
        / "showdown-client"
        / "play.pokemonshowdown.com"
        / "data"
        / "pokemonai-teams.json"
    )
    assert records[0].validation_status == "invalid-precheck"
    assert any("non-31 IVs" in error for error in records[0].validation_errors)
    public = json.loads(public_file.read_text(encoding="utf-8"))
    assert public["teamCount"] == 0
    assert public["totalTeamCount"] == 1
    assert public["teams"] == []


def test_vendored_vgc_bench_source_is_offline_playable():
    sources = {source.id: source for source in load_team_sources(ROOT / "config" / "team-sources.yaml").sources}
    source = sources["vgc-bench-samples"]
    assert source.enabled is True
    assert source.type == "directory"
    assert source.repository == "cameronangliss/vgc-bench"
    assert len(source.ref or "") == 40
    assert source.license == "MIT"

    private = json.loads((ROOT / "data" / "team-library" / "index.json").read_text(encoding="utf-8"))
    teams = [team for team in private["teams"] if team["source_id"] == source.id]
    assert len(teams) >= 4
    assert all(team["validation_status"] in {"prevalidated", "valid"} for team in teams)
    assert all(len(team["roster"]) == 6 for team in teams)


def test_team_pool_uses_deterministic_per_agent_shuffle(tmp_path: Path):
    from baseline_ai.team_library import TeamPool

    index = tmp_path / "index.json"
    index.write_text(
        json.dumps(
            {
                "teams": [
                    {"pool": "vgc", "packed": f"team-{index}", "validation_status": "prevalidated"}
                    for index in range(8)
                ]
                + [{"pool": "vgc", "packed": "bad", "validation_status": "invalid-precheck"}]
            }
        ),
        encoding="utf-8",
    )
    first = TeamPool(index, "vgc", seed="vgc-1")
    again = TeamPool(index, "vgc", seed="vgc-1")
    different = TeamPool(index, "vgc", seed="vgc-2")
    first_order = [first.next() for _ in range(8)]
    assert first_order == [again.next() for _ in range(8)]
    assert first_order != [different.next() for _ in range(8)]
    assert "bad" not in first_order



def test_packed_output_sanitizes_untrusted_nicknames():
    sets = parse_paste(SAMPLE.replace("Alpha @", "Bad|Name] @", 1))
    packed = pack_team(sets)
    assert "|Name]" not in packed
    assert "\n" not in packed
    assert len(parse_packed(packed)) == 2


def test_public_catalogue_only_exposes_roster_species(tmp_path: Path):
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "agents.yaml").write_text(
        """
default_format: test
source_url: /source.tar.gz
formats:
  - id: test
    label: Test
    showdown_format: gen9vgc2025regi
    game_type: doubles
    team_preview: bring6_pick4
opponents:
  - {id: bot, label: Bot, username: Test Bot, backend: pokemonai.vgc, format_id: test}
""",
        encoding="utf-8",
    )
    source = tmp_path / "teams"
    source.mkdir()
    (source / "six.txt").write_text("\n\n".join(SAMPLE.strip().split("\n\n") * 3), encoding="utf-8")
    source_config = tmp_path / "config" / "team-sources.yaml"
    source_config.write_text(
        """
library_dir: data/team-library
sources:
  - id: local
    label: Local
    type: directory
    path: teams
    enabled: true
    license: MIT
    format_id: test
    pool: test
""",
        encoding="utf-8",
    )
    config = load_team_sources(source_config, project_root=tmp_path)
    TeamLibraryBuilder(config, tmp_path).build(validate=False)
    private = json.loads((tmp_path / "data/team-library/index.json").read_text(encoding="utf-8"))
    public = json.loads(
        (tmp_path / "apps/showdown-client/play.pokemonshowdown.com/data/pokemonai-teams.json").read_text(
            encoding="utf-8"
        )
    )
    assert public["teams"][0]["roster"] == [
        {"species": mon["species"]} for mon in private["teams"][0]["roster"]
    ]
