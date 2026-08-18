"""Runtime guard for the Pokémon Champions-aware poke-env data snapshot."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any



# These forms are present in the pinned VGC-Bench poke-env fork and absent from the
# older PyPI 0.15.0 data snapshot.  They are also used by the bundled Reg M-B teams.
REQUIRED_CHAMPIONS_SPECIES = ("staraptormega", "dragonitemega")


def missing_champions_species(
    pokedex: Mapping[str, Any] | None = None,
) -> tuple[str, ...]:
    if pokedex is None:
        from poke_env.data import GenData

        pokedex = GenData.from_gen(9).pokedex
    data = pokedex
    return tuple(species for species in REQUIRED_CHAMPIONS_SPECIES if species not in data)


def assert_champions_poke_env_support() -> None:
    missing = missing_champions_species()
    if not missing:
        return
    raise RuntimeError(
        "The installed poke-env data snapshot does not support Pokémon Champions "
        f"({', '.join(missing)} missing). Re-run scripts/bootstrap.ps1 or rebuild the "
        "baseline-ai image so the commit pinned in services/baseline-ai/pyproject.toml "
        "is installed."
    )
