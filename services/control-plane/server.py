from __future__ import annotations

import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
from urllib.parse import parse_qs, unquote, urlencode, urlparse

from pokemonai_core.config import load_agents_config
from pokemonai_core.meta import MetaManager
from pokemonai_core.runtime import runtime_catalog, write_instance_configs
from pokemonai_core.ai_teams import AITeamService
from pokemonai_core.teams import TeamLibraryBuilder, load_team_sources


SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* https://play.pokemonshowdown.com wss://sim3.psim.us; img-src 'self' data: http://play.pokemonshowdown.com http://*.psim.us https://play.pokemonshowdown.com https://*.psim.us https://pokemonshowdown.com; media-src 'self' http://play.pokemonshowdown.com https://play.pokemonshowdown.com; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
}


class ControlHandler(SimpleHTTPRequestHandler):
    project_root: Path
    agents_path: Path
    showdown_port: int
    meta_manager: MetaManager
    ai_team_service: AITeamService
    internal_token: str

    def end_headers(self) -> None:
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, value: object, status: int = 200) -> None:
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_json(self, max_bytes: int = 12_000_000) -> dict[str, object]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError as error:
            raise ValueError("Invalid Content-Length") from error
        if length <= 0 or length > max_bytes:
            raise ValueError(f"JSON body must contain 1 to {max_bytes} bytes")
        value = json.loads(self.rfile.read(length))
        if not isinstance(value, dict):
            raise ValueError("JSON body must be an object")
        return value

    def _control_request_allowed(self) -> bool:
        if self.headers.get("X-PokemonAI-Control") != "1":
            return False
        origin = self.headers.get("Origin")
        host = self.headers.get("Host")
        if not origin or not host:
            return True
        parsed = urlparse(origin)
        return parsed.netloc == host and parsed.scheme in {"http", "https"}

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/healthz":
            self._json({"status": "ok"})
            return
        if parsed.path == "/runtime/catalog.json":
            self._json(runtime_catalog(self.project_root, load_agents_config(self.agents_path)))
            return
        if parsed.path == "/api/ai/capabilities":
            self._json(self.ai_team_service.capabilities())
            return
        if parsed.path == "/api/ai/team-pool":
            query = parse_qs(parsed.query)
            try:
                self._json(self.ai_team_service.list_pool(
                    str((query.get("format_id") or [""])[0]),
                    query=str((query.get("query") or [""])[0]),
                    cursor=int((query.get("cursor") or ["0"])[0]),
                    limit=int((query.get("limit") or ["20"])[0]),
                ))
            except (KeyError, TypeError, ValueError) as error:
                self._json({"error": str(error)}, 400)
            return
        ai_team_match = re.fullmatch(r"/api/ai/team-pool/(.+)", parsed.path)
        if ai_team_match:
            detail = self.ai_team_service.pool_detail(unquote(ai_team_match.group(1)))
            self._json(detail or {"error": "AI team not found"}, 200 if detail else 404)
            return
        if parsed.path == "/api/meta/status":
            self._json(self.meta_manager.status())
            return
        if parsed.path == "/api/meta/teams":
            format_id = (parse_qs(parsed.query).get("format") or [None])[0]
            try:
                self._json(self.meta_manager.player_teams(format_id))
            except ValueError as error:
                self._json({"error": str(error)}, 400)
            return
        if parsed.path == "/api/team-catalog":
            query = parse_qs(parsed.query)
            try:
                self._json(self.meta_manager.team_catalog(
                    format_id=(query.get("format_id") or [None])[0],
                    completeness=(query.get("completeness") or ["all"])[0],
                    query=(query.get("query") or [""])[0],
                    sort=(query.get("sort") or ["recommended"])[0],
                    cursor=(query.get("cursor") or [None])[0],
                    limit=int((query.get("limit") or ["30"])[0]),
                ))
            except (TypeError, ValueError) as error:
                self._json({"error": str(error)}, 400)
            return
        catalog_match = re.fullmatch(r"/api/team-catalog/(.+)", parsed.path)
        if catalog_match:
            detail = self.meta_manager.team_catalog_detail(unquote(catalog_match.group(1)))
            self._json(detail or {"error": "Team not found"}, 200 if detail else 404)
            return
        match = re.fullmatch(r"/api/meta/imports/([A-Za-z0-9]+)", parsed.path)
        if match:
            value = self.meta_manager.get_import(match.group(1))
            self._json(value or {"error": "Import not found"}, 200 if value else 404)
            return
        if parsed.path == "/data/pokemonai-teams.json":
            generated = self.project_root / "var" / "generated" / "public" / "pokemonai-teams.json"
            legacy = Path(self.directory or ".") / "data" / "pokemonai-teams.json"
            target = generated if generated.is_file() else legacy
            if target.is_file():
                payload = target.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            else:
                self._json({"teams": []}, 404)
            return
        if parsed.path == "/data/pokemonai-team-catalog.json":
            target = self.project_root / "var" / "generated" / "public" / "pokemonai-team-catalog.json"
            if target.is_file():
                payload = target.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            else:
                self._json(self.meta_manager.catalog_export())
            return
        if parsed.path == "/":
            mode = "online" if parse_qs(parsed.query).get("mode") == ["online"] else "ai"
            query = {"mode": mode}
            if mode == "ai":
                host = (self.headers.get("Host") or "127.0.0.1").split(":", 1)[0]
                query["server"] = f"{host}:{self.showdown_port}"
            self.send_response(302)
            self.send_header("Location", f"/testclient-new.html?{urlencode(query)}")
            self.end_headers()
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/internal/ai/battle-presets/claim":
            if not secrets.compare_digest(self.headers.get("X-PokemonAI-Internal") or "", self.internal_token):
                self._json({"error": "Internal request denied"}, 403)
                return
            try:
                result = self.ai_team_service.claim_preset(self._read_json(10_000))
                self._json(result or {"error": "Battle preset not found"}, 200 if result else 404)
            except (KeyError, ValueError) as error:
                self._json({"error": str(error)}, 400)
            return
        if not self._control_request_allowed():
            self._json({"error": "Control request denied"}, 403)
            return
        try:
            if parsed.path == "/api/ai/battle-presets":
                self._json(self.ai_team_service.create_preset(self._read_json(100_000)), 201)
                return
            if parsed.path == "/api/meta/imports":
                if int(self.headers.get("Content-Length") or 0):
                    self._read_json(1_000)
                result = self.meta_manager.start_import()
                self._json({**result.__dict__, "statusUrl": f"/api/meta/imports/{result.id}"}, 202)
                return
            publish = re.fullmatch(r"/api/meta/imports/([A-Za-z0-9]+)/publish", parsed.path)
            if publish:
                self._json(self.meta_manager.publish(publish.group(1)))
                return
            if parsed.path == "/api/meta/rollback":
                if int(self.headers.get("Content-Length") or 0):
                    self._read_json(1_000)
                self._json(self.meta_manager.rollback())
                return
            self._json({"error": "Not found"}, 404)
        except (KeyError, ValueError) as error:
            self._json({"error": str(error)}, 400)
        except Exception as error:
            self.log_error("Meta API failed: %s", error)
            self._json({"error": "Meta operation failed"}, 500)

    def do_DELETE(self) -> None:  # noqa: N802
        if not self._control_request_allowed():
            self._json({"error": "Control request denied"}, 403)
            return
        parsed = urlparse(self.path)
        match = re.fullmatch(r"/api/ai/battle-presets/([A-Za-z0-9]+)", parsed.path)
        if not match:
            self._json({"error": "Not found"}, 404)
            return
        removed = self.ai_team_service.cancel_preset(match.group(1))
        self._json({"removed": removed}, 200 if removed else 404)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve PokemonAI client and runtime catalogue")
    parser.add_argument("--project-root", default=os.environ.get("POKEMONAI_PROJECT_ROOT", "."))
    parser.add_argument("--bind", default=os.environ.get("POKEMONAI_WEB_BIND", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("POKEMONAI_WEB_PORT", "8080")))
    parser.add_argument("--showdown-port", type=int, default=int(os.environ.get("POKEMONAI_SHOWDOWN_PORT", "8000")))
    args = parser.parse_args()
    root = Path(args.project_root).resolve()
    web_root = Path(os.environ.get("POKEMONAI_WEB_ROOT", root / "apps" / "showdown-client" / "play.pokemonshowdown.com")).resolve()
    agents_path = root / "config" / "agents.yaml"
    agents = load_agents_config(agents_path)
    team_index = Path(agents.team_library_path)
    if not team_index.is_absolute():
        team_index = root / team_index
    if not team_index.is_file():
        sources = load_team_sources(root / agents.team_sources_path, project_root=root)
        TeamLibraryBuilder(sources, root).build(validate=False)
    internal_token = secrets.token_urlsafe(32)
    control_host = "127.0.0.1" if args.bind in {"0.0.0.0", "::"} else args.bind
    write_instance_configs(
        root, agents,
        websocket_url=os.environ.get("POKEMONAI_SHOWDOWN_WS", f"ws://127.0.0.1:{args.showdown_port}/showdown/websocket"),
        control_url=f"http://{control_host}:{args.port}", control_token=internal_token,
    )
    handler = lambda *values, **kwargs: ControlHandler(*values, directory=str(web_root), **kwargs)
    ControlHandler.project_root = root
    ControlHandler.agents_path = agents_path
    ControlHandler.showdown_port = args.showdown_port
    ControlHandler.meta_manager = MetaManager(root)
    ControlHandler.ai_team_service = AITeamService(root, agents)
    ControlHandler.internal_token = internal_token
    server = ThreadingHTTPServer((args.bind, args.port), handler)
    print(f"PokemonAI control plane available at http://{args.bind}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
