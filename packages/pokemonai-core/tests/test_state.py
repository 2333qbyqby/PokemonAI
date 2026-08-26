from pathlib import Path

import pytest

from pokemonai_core.state import migrate_state


def test_state_migration_copies_verifies_and_is_idempotent(tmp_path: Path):
    source = tmp_path / "data" / "battles"
    source.mkdir(parents=True)
    (source / "battle.log").write_text("visible log", encoding="utf-8")

    first = migrate_state(tmp_path)
    second = migrate_state(tmp_path)

    assert first == {**first, "copied": 1, "verified": 1}
    assert second == {**second, "copied": 0, "verified": 1}
    assert (tmp_path / "var" / "logs" / "battles" / "battle.log").read_text(encoding="utf-8") == "visible log"
    assert (source / "battle.log").is_file()


def test_state_migration_failure_keeps_original_data(tmp_path: Path):
    source = tmp_path / "data" / "battles"
    target = tmp_path / "var" / "logs" / "battles"
    source.mkdir(parents=True)
    target.mkdir(parents=True)
    (source / "battle.log").write_text("original", encoding="utf-8")
    (target / "battle.log").write_text("different", encoding="utf-8")

    with pytest.raises(RuntimeError, match="verification failed"):
        migrate_state(tmp_path, prune_legacy=True)

    assert (source / "battle.log").read_text(encoding="utf-8") == "original"


def test_state_migration_prunes_only_after_verification(tmp_path: Path):
    source = tmp_path / "data" / "team-library"
    source.mkdir(parents=True)
    (source / "index.json").write_text("{}", encoding="utf-8")

    migrate_state(tmp_path, prune_legacy=True)

    assert not source.exists()
    assert (tmp_path / "var" / "generated" / "team-library" / "index.json").is_file()
