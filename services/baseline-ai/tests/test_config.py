import argparse
import importlib.util
from pathlib import Path

import pytest
import yaml

from baseline_ai.config import load_agents_config


ROOT = Path(__file__).resolve().parents[3]


def test_loads_first_release_config():
    config = load_agents_config(ROOT / "config" / "agents.yaml")
    assert config.format == "gen9randombattle"
    assert [opponent.id for opponent in config.baseline_opponents] == ["easy", "normal", "hard"]
    assert config.expert.id == "expert"
    assert [opponent.backend for opponent in config.opponents] == [
        "poke_env.random",
        "poke_env.max_base_power",
        "poke_env.simple_heuristics",
        "foul_play",
    ]
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
    assert f'format: "{config.format}"' in generated
    assert f'sourceUrl: "{config.source_url}"' in generated
    for opponent in config.opponents:
        assert f'id: "{opponent.id}"' in generated
        assert f'username: "{opponent.username}"' in generated

    client_html = (
        ROOT / "apps" / "showdown-client" / "play.pokemonshowdown.com" / "testclient-new.html"
    ).read_text(encoding="utf-8")
    config_position = client_html.index('src="js/pokemonai-config.js?')
    behavior_position = client_html.index('src="js/pokemonai.js?')
    main_menu_position = client_html.index('src="js/panel-mainmenu.js?')
    assert config_position < behavior_position < main_menu_position


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
    assert command[command.index("--search-parallelism") + 1] == "1"
    assert command[command.index("--search-threads") + 1] == "2"


def test_production_network_and_auth_boundaries():
    compose = yaml.safe_load((ROOT / "compose.prod.yml").read_text(encoding="utf-8"))
    services = compose["services"]
    assert set(services) == {"web", "showdown", "baseline-ai", "expert-ai"}
    assert services["web"]["ports"] == ["80:80", "443:443"]
    assert "ports" not in services["showdown"]
    assert services["showdown"]["expose"] == ["8000"]
    assert services["expert-ai"]["environment"]["POKEMONAI_SHOWDOWN_WS"].startswith("ws://showdown:8000")
    assert "command" not in services["expert-ai"]
    for service in services.values():
        assert service["restart"] == "unless-stopped"
        assert "healthcheck" in service

    caddyfile = (ROOT / "deploy" / "Caddyfile").read_text(encoding="utf-8")
    assert "basic_auth" in caddyfile
    assert "handle /showdown/*" in caddyfile
    assert "reverse_proxy showdown:8000" in caddyfile
    assert 'http://127.0.0.1' in caddyfile


def test_rejects_duplicate_usernames(tmp_path: Path):
    config_file = tmp_path / "agents.yaml"
    config_file.write_text(
        """
format: gen9randombattle
source_url: https://example.test/source
opponents:
  - {id: easy, label: Easy, username: Same User, backend: poke_env.random}
  - {id: normal, label: Normal, username: sameuser, backend: poke_env.max_base_power}
  - {id: hard, label: Hard, username: Hard Bot, backend: poke_env.simple_heuristics}
  - {id: expert, label: Expert, username: Expert Bot, backend: foul_play}
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
