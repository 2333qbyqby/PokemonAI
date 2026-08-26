from __future__ import annotations

from http.client import HTTPConnection
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parents[2]


def free_port() -> int:
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        return int(server.getsockname()[1])


def test_control_plane_serves_health_catalog_and_safe_static_paths(tmp_path: Path):
    port = free_port()
    (tmp_path / "config").mkdir()
    (tmp_path / "var" / "generated" / "team-library").mkdir(parents=True)
    shutil.copy2(ROOT / "config" / "agents.yaml", tmp_path / "config" / "agents.yaml")
    shutil.copy2(ROOT / "config" / "team-sources.yaml", tmp_path / "config" / "team-sources.yaml")
    shutil.copy2(
        ROOT / "var" / "generated" / "team-library" / "index.json",
        tmp_path / "var" / "generated" / "team-library" / "index.json",
    )
    env = {
        **os.environ,
        "POKEMONAI_PROJECT_ROOT": str(ROOT),
        "POKEMONAI_WEB_ROOT": str(ROOT / "apps" / "showdown-client" / "play.pokemonshowdown.com"),
        "POKEMONAI_WEB_PORT": str(port),
        "POKEMONAI_SHOWDOWN_PORT": "19000",
    }
    process = subprocess.Popen(
        [sys.executable, "services/control-plane/server.py", "--project-root", str(tmp_path)],
        cwd=ROOT,
        env=env,
    )
    try:
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                connection = HTTPConnection("127.0.0.1", port, timeout=1)
                connection.request("GET", "/healthz")
                response = connection.getresponse()
                if response.status == 200:
                    assert json.loads(response.read()) == {"status": "ok"}
                    break
            except OSError:
                time.sleep(0.05)
        else:
            raise AssertionError("control plane did not become ready")
        connection = HTTPConnection("127.0.0.1", port, timeout=2)
        connection.request("GET", "/runtime/catalog.json")
        response = connection.getresponse()
        catalog = json.loads(response.read())
        assert response.status == 200
        assert "formats" in catalog and "opponents" in catalog
        private_fields = {"backend", "description", "difficulty", "style"}
        assert all(private_fields.isdisjoint(opponent) for opponent in catalog["opponents"])
        assert all(
            not opponent["reason"] or opponent["reason"] == "AI 暂时不可用，请稍后重试。"
            for opponent in catalog["opponents"]
        )
        connection.request("GET", "/api/meta/status")
        response = connection.getresponse()
        status = json.loads(response.read())
        assert response.status == 200
        assert status["source"]["id"] == "munchstats"
        connection.request("GET", "/api/meta/teams")
        response = connection.getresponse()
        teams = json.loads(response.read())
        assert response.status == 200
        assert teams["source"] == "munchstats" and isinstance(teams["teams"], list)
        connection.request("GET", "/api/team-catalog?format_id=champions-ranked-doubles&limit=1")
        response = connection.getresponse()
        catalog = json.loads(response.read())
        assert response.status == 200
        assert catalog["schema"] == "pokemonai-team-catalog"
        assert len(catalog["teams"]) <= 1
        connection.request("GET", "/data/pokemonai-team-catalog.json")
        response = connection.getresponse()
        assert response.status == 200
        assert json.loads(response.read())["schema"] == "pokemonai-team-catalog"
        connection.request("GET", "/api/ai/capabilities")
        response = connection.getresponse()
        capabilities = json.loads(response.read())
        assert response.status == 200
        assert capabilities["schema"] == "pokemonai-ai-capabilities"
        assert all(
            set(format_capability["modes"]) == {
                "mirror", "counter", "popular-random", "generated-random", "fixed"
            }
            for format_capability in capabilities["formats"].values()
        )
        connection.request("GET", "/api/ai/team-pool?format_id=champions-ranked-doubles&limit=1")
        response = connection.getresponse()
        ai_pool = json.loads(response.read())
        assert response.status == 200
        assert ai_pool["schema"] == "pokemonai-ai-team-pool" and len(ai_pool["teams"]) <= 1
        connection.request("POST", "/api/meta/imports", "{}", {"Content-Type": "application/json"})
        response = connection.getresponse()
        assert response.status == 403
        connection.request("GET", "/..%2f..%2fREADME.md")
        assert connection.getresponse().status == 404
    finally:
        process.terminate()
        process.wait(timeout=10)
