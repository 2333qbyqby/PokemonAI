# Third-party notices

PokémonAI combines independent open-source projects. The integration code and
the modified web client are AGPL-3.0-only. Upstream components keep their own
copyright and license terms.

| Component | Pinned version | License | Upstream source |
|---|---|---|---|
| Pokémon Showdown server | `8ff48edc09e4aed6011c966258a5f95899128443` | MIT | <https://github.com/smogon/pokemon-showdown> |
| Pokémon Showdown client | `daa28cfeb19775dea9f19f90a8c8f1418bac316a` | AGPL-3.0 | <https://github.com/smogon/pokemon-showdown-client> |
| poke-env（VGC-Bench Champions fork） | `379a04628e42b2a2c94790c0788204b652f7ae1b` | MIT | <https://github.com/cameronangliss/poke-env> |
| Foul Play | `c90ecd3189dac1699a8603571990b635c0a7bf6e` | GPL-3.0 | <https://github.com/pmariglia/foul-play> |
| poke-engine | `0.0.48`, feature `terastallization` | MIT | <https://github.com/pmariglia/poke-engine> |
| PokéAPI static data | `PokeAPI/api-data@2cda0b56a3a8ad2529d8aac73528225f96d2c848` | BSD-3-Clause | <https://github.com/PokeAPI/api-data> |
| Caddy | `2.10.2` production image | Apache-2.0 | <https://github.com/caddyserver/caddy> |
| VGC-Bench (MB1–MB4 vendored team subset; full source optional) | `d79f9532947ac114dce1dda2456a590afcd375b2` | MIT | <https://github.com/cameronangliss/vgc-bench> |

The client and server repositories include their original license and copyright
files. Foul Play and the Showdown server run as separate processes; their code
is not copied into the PokémonAI runner. The baseline package installs the
pinned Champions-aware poke-env fork directly from its exact commit and checks
its new-Mega data markers at startup. VGC-Bench MB1–MB4 team files are
included under `data/team-sources/vendored/vgc-bench/` with the upstream MIT license; the
full repository remains an optional fixed-commit data source. The `pokemon-vgc-ai` repository
has a declarative adapter but is disabled and not redistributed because no repository-level
license was confirmed during this implementation. The production web image contains a
downloadable `pokemonai-source.tar.gz` generated from the exact source tree used to build the
deployed client.

The checked-in Simplified Chinese name table is generated from the pinned
PokéAPI static JSON snapshot. The browser uses only the generated local file
and makes no runtime request to PokéAPI. Alternate forms and terms absent from
that snapshot are maintained explicitly in `config/zh-hans-overrides.json`.

Pokémon names, character names, artwork, sounds, and related assets are
trademarks or copyrighted works of their respective owners. PokémonAI does not
bundle Pokémon artwork or audio; the client continues to request those assets
from Pokémon Showdown's public asset hosts.
