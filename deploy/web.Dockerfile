FROM node:24.19.0-bookworm-slim AS client-builder

WORKDIR /build/client
COPY apps/showdown-client/package.json apps/showdown-client/package-lock.json ./
RUN npm ci
COPY apps/showdown-client/ ./
RUN node build

WORKDIR /source
COPY . ./
RUN tar --exclude=.git --exclude=.runtime --exclude=data --exclude=node_modules \
    --exclude=artifacts --exclude=pokemonai-source.tar.gz \
    -czf /tmp/pokemonai-source.tar.gz .

FROM caddy:2.10.2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=client-builder /build/client/play.pokemonshowdown.com /srv
COPY --from=client-builder /tmp/pokemonai-source.tar.gz /srv/pokemonai-source.tar.gz
