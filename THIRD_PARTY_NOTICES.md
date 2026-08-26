# Third-party notices

PokémonAI combines independent open-source projects. Integration code and the modified web client are AGPL-3.0-only. Upstream components retain their copyright and license terms.

| Component | Pinned version | License | Upstream source |
|---|---|---|---|
| Pokémon Showdown server | `8ff48edc09e4aed6011c966258a5f95899128443` | MIT | <https://github.com/smogon/pokemon-showdown> |
| Pokémon Showdown client | `daa28cfeb19775dea9f19f90a8c8f1418bac316a` | AGPL-3.0 | <https://github.com/smogon/pokemon-showdown-client> |
| PokéAPI static data | `PokeAPI/api-data@2cda0b56a3a8ad2529d8aac73528225f96d2c848` | BSD-3-Clause | <https://github.com/PokeAPI/api-data> |
| Caddy production image | `2.10.2` | Apache-2.0 | <https://github.com/caddyserver/caddy> |
| VGC-Bench MB1-MB4 team data subset | `d79f9532947ac114dce1dda2456a590afcd375b2` | MIT | <https://github.com/cameronangliss/vgc-bench> |

The VGC-Bench files under `resources/teams/vendored/vgc-bench/` are retained only as ordinary team-library data with their upstream MIT license. PokémonAI does not include or run VGC-Bench, poke-env, Foul Play, or their trained models.

The checked-in Simplified Chinese name table is generated from the pinned PokéAPI static snapshot. The browser does not request PokéAPI at runtime. The production web image contains a downloadable `pokemonai-source.tar.gz` generated from the source tree used for deployment.

Pokémon names, character names, artwork, sounds, and related assets are trademarks or copyrighted works of their respective owners. PokémonAI does not bundle Pokémon artwork or audio; the client uses Pokémon Showdown's configured public asset hosts.
