FROM node:24.19.0-bookworm-slim AS client-builder

ARG SHOWDOWN_COMMIT=8ff48edc09e4aed6011c966258a5f95899128443
ARG FOUL_PLAY_COMMIT=c90ecd3189dac1699a8603571990b635c0a7bf6e
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build/client
COPY apps/showdown-client/package.json apps/showdown-client/package-lock.json ./
RUN npm ci
COPY apps/showdown-client/ ./
RUN node build

WORKDIR /source
COPY . ./
# Keep the AGPL source download complete even when building from an older thin archive
# that omitted unmodified Pokémon Showdown data files.
RUN if [ ! -f vendor/pokemon-showdown/data/tags.ts ]; then \
      git clone --filter=blob:none --no-checkout https://github.com/smogon/pokemon-showdown.git /tmp/showdown-upstream \
      && git -C /tmp/showdown-upstream fetch --depth=1 origin "${SHOWDOWN_COMMIT}" \
      && git -C /tmp/showdown-upstream checkout --detach "${SHOWDOWN_COMMIT}" \
      && cp -a /tmp/showdown-upstream/data vendor/pokemon-showdown/data \
      && rm -rf /tmp/showdown-upstream; \
    fi
RUN if [ ! -f vendor/foul-play/fp/battle/state.py ]; then \
      git clone --filter=blob:none --no-checkout https://github.com/pmariglia/foul-play.git /tmp/foul-play-upstream \
      && git -C /tmp/foul-play-upstream fetch --depth=1 origin "${FOUL_PLAY_COMMIT}" \
      && git -C /tmp/foul-play-upstream checkout --detach "${FOUL_PLAY_COMMIT}" \
      && cp -a /tmp/foul-play-upstream/. vendor/foul-play/ \
      && rm -rf vendor/foul-play/.git /tmp/foul-play-upstream; \
    fi
RUN tar --exclude=.git --exclude=.runtime --exclude=node_modules \
    --exclude=__pycache__ --exclude='*.pyc' --exclude=.pytest_cache \
    --exclude=./data/agents --exclude=./data/battles --exclude=./data/test-results \
    --exclude=./data/team-sources/cache --exclude=artifacts --exclude=pokemonai-source.tar.gz \
    -czf /tmp/pokemonai-source.tar.gz .

FROM caddy:2.10.2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=client-builder /build/client/play.pokemonshowdown.com /srv
COPY --from=client-builder /tmp/pokemonai-source.tar.gz /srv/pokemonai-source.tar.gz
