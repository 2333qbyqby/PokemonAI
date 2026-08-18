import argparse
import importlib.util
import json
import re
from pathlib import Path

import pytest
import yaml

from baseline_ai.config import load_agents_config


ROOT = Path(__file__).resolve().parents[3]


def test_loads_multi_format_registry():
    config = load_agents_config(ROOT / "config" / "agents.yaml")
    assert config.default_format == "champions-reg-mb"
    assert config.format == "gen9championsvgc2026regmb"
    assert [item.id for item in config.formats] == ["champions-reg-mb", "gen9-random"]
    vgc = config.format_by_id("champions-reg-mb")
    assert vgc.game_type == "doubles"
    assert vgc.team_preview == "bring6_pick4"
    assert vgc.open_team_sheets is True
    assert vgc.team_pool == "champions-reg-mb"
    assert len(config.opponents_for_format("champions-reg-mb")) == 8
    assert all(opponent.backend == "pokemonai.vgc" for opponent in config.opponents_for_format("champions-reg-mb"))
    assert config.expert.id == "random-expert"
    assert config.expert.options == {
        "search_time_ms": 500,
        "search_parallelism": 1,
        "search_threads": 2,
    }


def test_generated_client_config_matches_registry():
    config = load_agents_config(ROOT / "config" / "agents.yaml")
    generated = (
        ROOT
        / "apps"
        / "showdown-client"
        / "play.pokemonshowdown.com"
        / "src"
        / "pokemonai-config.ts"
    ).read_text(encoding="utf-8")
    assert f'defaultFormat: "{config.default_format}"' in generated
    assert f'sourceUrl: "{config.source_url}"' in generated
    assert 'teamLibraryUrl: "/data/pokemonai-teams.json"' in generated
    for format_config in config.formats:
        assert f'id: "{format_config.id}"' in generated
        assert f'showdownFormat: "{format_config.showdown_format}"' in generated
    for opponent in config.opponents:
        assert f'id: "{opponent.id}"' in generated
        assert f'username: "{opponent.username}"' in generated
        assert f'formatId: "{opponent.format_id}"' in generated

    client_html = (
        ROOT / "apps" / "showdown-client" / "play.pokemonshowdown.com" / "testclient-new.html"
    ).read_text(encoding="utf-8")
    config_position = client_html.index('src="js/pokemonai-config.js?')
    behavior_position = client_html.index('src="js/pokemonai.js?')
    main_menu_position = client_html.index('src="js/panel-mainmenu.js?')
    assert config_position < behavior_position < main_menu_position
    assert 'rel="manifest"' in client_html
    assert 'style/pokemonai.css' in client_html


def test_dual_mode_bootstrap_precedes_the_showdown_client():
    client_html = (
        ROOT / "apps" / "showdown-client" / "play.pokemonshowdown.com" / "testclient-new.html"
    ).read_text(encoding="utf-8")
    app_position = client_html.index('src="js/pokemonai-app.js?')
    client_position = client_html.index('src="js/client-main.js?')
    assert app_position < client_position
    assert not re.search(r'<script[^>]+src=["\']https?://', client_html, re.IGNORECASE)
    inline_scripts = re.findall(r"<script(?:\s[^>]*)?>(.*?)</script>", client_html, re.DOTALL | re.IGNORECASE)
    assert all(not script.strip() for script in inline_scripts)


def test_checked_in_simplified_chinese_snapshot_is_pinned_and_complete():
    snapshot = (
        ROOT
        / "apps"
        / "showdown-client"
        / "play.pokemonshowdown.com"
        / "src"
        / "pokemonai-zh-hans-data.ts"
    ).read_text(encoding="utf-8")
    assert "2cda0b56a3a8ad2529d8aac73528225f96d2c848" in snapshot
    for entry in (
        '"pikachu": "皮卡丘"',
        '"thunderbolt": "十万伏特"',
        '"levitate": "飘浮"',
        '"leftovers": "吃剩的东西"',
        '"fire": "火"',
    ):
        assert entry in snapshot


def test_gen9_random_battle_terms_have_chinese_entries():
    snapshot = (
        ROOT
        / "apps"
        / "showdown-client"
        / "play.pokemonshowdown.com"
        / "src"
        / "pokemonai-zh-hans-data.ts"
    ).read_text(encoding="utf-8")
    random_sets = json.loads(
        (ROOT / "vendor" / "pokemon-showdown" / "data" / "random-battles" / "gen9" / "sets.json")
        .read_text(encoding="utf-8")
    )

    def showdown_id(value: str) -> str:
        return re.sub(r"[^a-z0-9]", "", value.lower())

    required = set(random_sets)
    for pokemon in random_sets.values():
        for battle_set in pokemon["sets"]:
            for field in ("movepool", "abilities", "items", "teraTypes"):
                required.update(showdown_id(value) for value in battle_set.get(field, []))
    missing = sorted(term for term in required if f'"{showdown_id(term)}":' not in snapshot)
    assert not missing, f"Missing Gen 9 Random Battle Chinese terms: {missing}"


def test_expert_runner_builds_arguments_from_registry():
    runner_path = ROOT / "services" / "expert-ai" / "runner.py"
    spec = importlib.util.spec_from_file_location("pokemonai_expert_runner", runner_path)
    assert spec and spec.loader
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    command = runner.build_command(
        argparse.Namespace(
            config=str(ROOT / "config" / "agents.yaml"),
            foul_play_root=str(ROOT / "vendor" / "foul-play"),
            websocket_uri="ws://showdown:8000/showdown/websocket",
        )
    )
    assert command[command.index("--ps-username") + 1] == "PokemonAI Expert"
    assert command[command.index("--pokemon-format") + 1] == "gen9randombattle"
    assert command[command.index("--search-time-ms") + 1] == "500"


def test_production_network_and_auth_boundaries():
    compose = yaml.safe_load((ROOT / "compose.prod.yml").read_text(encoding="utf-8"))
    services = compose["services"]
    assert set(services) == {"web", "showdown", "baseline-ai", "expert-ai"}
    assert services["web"]["ports"] == ["80:80", "443:443"]
    assert "ports" not in services["showdown"]
    assert services["showdown"]["expose"] == ["8000"]
    assert services["expert-ai"]["environment"]["POKEMONAI_SHOWDOWN_WS"].startswith("ws://showdown:8000")
    for service in services.values():
        assert service["restart"] == "unless-stopped"
        assert "healthcheck" in service

    caddyfile = (ROOT / "deploy" / "Caddyfile").read_text(encoding="utf-8")
    assert "basic_auth" in caddyfile
    assert "handle /showdown/*" in caddyfile
    assert "reverse_proxy showdown:8000" in caddyfile
    assert "rewrite @pokemonai_root /testclient-new.html" in caddyfile
    assert 'http://127.0.0.1' in caddyfile
    assert "script-src 'self'" in caddyfile
    assert "wss://sim3.psim.us" in caddyfile
    assert "https://play.pokemonshowdown.com" in caddyfile


def test_rejects_duplicate_usernames(tmp_path: Path):
    config_file = tmp_path / "agents.yaml"
    config_file.write_text(
        """
format: gen9randombattle
source_url: https://example.test/source
opponents:
  - {id: easy, label: Easy, username: Same User, backend: poke_env.random}
  - {id: normal, label: Normal, username: sameuser, backend: poke_env.max_base_power}
""",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="Duplicate opponent username"):
        load_agents_config(config_file)


def test_rejects_unsupported_backend(tmp_path: Path):
    config_file = tmp_path / "agents.yaml"
    config_file.write_text(
        """
format: gen9randombattle
source_url: https://example.test/source
opponents:
  - {id: easy, label: Easy, username: Easy Bot, backend: unknown}
""",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="Unsupported backend"):
        load_agents_config(config_file)


def test_rejects_vgc_backend_on_singles(tmp_path: Path):
    config_file = tmp_path / "agents.yaml"
    config_file.write_text(
        """
default_format: singles
source_url: /source.tar.gz
formats:
  - {id: singles, label: Singles, showdown_format: gen9ou, game_type: singles}
opponents:
  - {id: bad, label: Bad, username: Bad Bot, backend: pokemonai.vgc, format_id: singles}
""",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="requires a doubles format"):
        load_agents_config(config_file)


def test_champions_poke_env_dependency_is_commit_pinned():
    import json

    commit = "379a04628e42b2a2c94790c0788204b652f7ae1b"
    pyproject = (ROOT / "services" / "baseline-ai" / "pyproject.toml").read_text(encoding="utf-8")
    lock = json.loads((ROOT / "config" / "runtime-lock.json").read_text(encoding="utf-8"))
    assert f"cameronangliss/poke-env/archive/{commit}.tar.gz" in pyproject
    assert lock["upstreams"]["pokeEnv"] == commit


def test_champions_runtime_guard_uses_new_mega_markers():
    from baseline_ai.champions_compat import missing_champions_species

    assert missing_champions_species({"staraptormega": {}, "dragonitemega": {}}) == ()
    assert missing_champions_species({"staraptormega": {}}) == ("dragonitemega",)


def test_baseline_image_keeps_vendored_team_provenance():
    dockerfile = (ROOT / "deploy" / "baseline.Dockerfile").read_text(encoding="utf-8")
    assert (
        "COPY data/team-sources/vendored /opt/pokemonai/data/team-sources/vendored"
        in dockerfile
    )
    assert (ROOT / "data" / "team-sources" / "vendored" / "vgc-bench" / "LICENSE").is_file()


def test_thin_source_docker_builds_repair_pinned_upstreams():
    showdown = (ROOT / "deploy" / "showdown.Dockerfile").read_text(encoding="utf-8")
    expert = (ROOT / "deploy" / "expert.Dockerfile").read_text(encoding="utf-8")
    web = (ROOT / "deploy" / "web.Dockerfile").read_text(encoding="utf-8")
    repair = (ROOT / "scripts" / "ensure-upstreams.py").read_text(encoding="utf-8")
    assert "SHOWDOWN_COMMIT=8ff48edc09e4aed6011c966258a5f95899128443" in showdown
    assert "data/mods/champions" not in showdown  # the complete pinned data tree is restored
    assert "AS foul-play-source" in expert
    assert "FOUL_PLAY_COMMIT=c90ecd3189dac1699a8603571990b635c0a7bf6e" in expert
    assert "vendor/foul-play/fp/battle/state.py" in web
    assert '"markers": ("run.py", "fp/battle/state.py")' in repair
