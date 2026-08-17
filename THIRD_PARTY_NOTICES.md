# Third-party notices

PokémonAI combines independent open-source projects. The integration code and
the modified web client are AGPL-3.0-only. Upstream components keep their own
copyright and license terms.

| Component | Pinned version | License | Upstream source |
|---|---|---|---|
| Pokémon Showdown server | `8ff48edc09e4aed6011c966258a5f95899128443` | MIT | <https://github.com/smogon/pokemon-showdown> |
| Pokémon Showdown client | `daa28cfeb19775dea9f19f90a8c8f1418bac316a` | AGPL-3.0 | <https://github.com/smogon/pokemon-showdown-client> |
| poke-env | `0.15.0` | MIT | <https://github.com/hsahovic/poke-env> |
| Foul Play | `c90ecd3189dac1699a8603571990b635c0a7bf6e` | GPL-3.0 | <https://github.com/pmariglia/foul-play> |
| poke-engine | `0.0.48`, feature `terastallization` | MIT | <https://github.com/pmariglia/poke-engine> |
| Caddy | `2.10.2` production image | Apache-2.0 | <https://github.com/caddyserver/caddy> |

The client and server repositories include their original license and copyright
files. Foul Play and the Showdown server run as separate processes; their code
is not copied into the PokémonAI runner. The production web image contains a
downloadable `pokemonai-source.tar.gz` generated from the exact source tree used
to build the deployed client.

Pokémon names, character names, artwork, sounds, and related assets are
trademarks or copyrighted works of their respective owners. PokémonAI does not
bundle Pokémon artwork or audio; the client continues to request those assets
from Pokémon Showdown's public asset hosts.
