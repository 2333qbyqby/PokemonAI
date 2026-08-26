from pathlib import Path

from pokemonai_core.ai_teams import AITeamService
from pokemonai_core.config import load_agents_config


ROOT = Path(__file__).resolve().parents[3]
FORMAT_ID = "champions-ranked-doubles"
OPPONENT_ID = "ranked-doubles-ai"


def test_ai_team_modes_resolve_to_single_use_battle_presets(monkeypatch):
    service = AITeamService(ROOT, load_agents_config(ROOT / "config" / "agents.yaml"))
    teams = [
        {
            "id": "team-a", "formatId": FORMAT_ID, "name": "Popular A", "packedTeam": "ai-a",
            "roster": ["A"] * 6, "profile": [], "sourceKind": "observed", "sourceUpdatedAt": "2026-08",
            "popularityRank": 1, "battles": 100, "confidence": 1.0, "validationStatus": "valid",
        },
        {
            "id": "team-b", "formatId": FORMAT_ID, "name": "Counter B", "packedTeam": "ai-b",
            "roster": ["B"] * 6, "profile": [], "sourceKind": "builtin", "sourceUpdatedAt": None,
            "popularityRank": None, "battles": None, "confidence": 0.8, "validationStatus": "valid",
        },
    ]
    pool = {
        "publishedAt": "2026-08-26T00:00:00Z",
        "sourceUpdatedAt": {FORMAT_ID: "2026-08"},
        "formats": {FORMAT_ID: teams},
    }
    monkeypatch.setattr(service, "_ensure_pool", lambda: pool)

    def run_tool(payload):
        operation = payload["operation"]
        if operation == "validate":
            return {"valid": True}
        if operation == "inspect":
            return {"teams": [{"id": item["id"], "profile": []} for item in payload["teams"]]}
        if operation == "random":
            return {"packedTeam": "generated", "profile": [], "roster": ["R"] * 6}
        if operation == "score":
            return {"scores": [{"id": "team-b", "score": 5.0}, {"id": "team-a", "score": 1.0}]}
        raise AssertionError(operation)

    monkeypatch.setattr(service, "_run_tool", run_tool)
    expected = {
        "mirror": "player-team",
        "counter": "ai-b",
        "popular-random": "ai-a",
        "generated-random": "generated",
        "fixed": "ai-b",
    }
    for mode, packed in expected.items():
        created = service.create_preset({
            "challenger": "Player One", "opponentId": OPPONENT_ID, "formatId": FORMAT_ID,
            "playerTeamPacked": "player-team", "mode": mode, "fixedTeamId": "team-b", "seed": 7,
        })
        claimed = service.claim_preset({
            "challenger": "Player One", "opponentId": OPPONENT_ID, "formatId": FORMAT_ID,
        })
        assert claimed and claimed["presetId"] == created["id"]
        assert claimed["team"]["packed"] == packed
        assert service.claim_preset({
            "challenger": "Player One", "opponentId": OPPONENT_ID, "formatId": FORMAT_ID,
        }) is None
