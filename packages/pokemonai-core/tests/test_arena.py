import json
from pathlib import Path

from pokemonai_core.arena import _write_reports


def test_arena_writes_json_csv_and_markdown(tmp_path: Path):
    players = ["Alpha", "Beta"]
    battles = [{"roomid": "battle-1", "p1": "Alpha", "p2": "Beta", "winner": "Alpha", "turns": 7, "path": "one.log.json"}]
    metadata = {
        "Alpha": {"backendCommit": "a" * 40, "modelSha256": "", "averageDecisionMs": 2.5},
        "Beta": {"backendCommit": "b" * 40, "modelSha256": "c" * 64, "averageDecisionMs": 4.0},
    }
    _write_reports(tmp_path, players, battles, requested=2, metadata=metadata)
    payload = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert payload["failedGames"] == 1
    assert payload["metadata"]["Beta"]["modelSha256"] == "c" * 64
    assert (tmp_path / "report.csv").is_file()
    assert "1/2" in (tmp_path / "report.md").read_text(encoding="utf-8")
