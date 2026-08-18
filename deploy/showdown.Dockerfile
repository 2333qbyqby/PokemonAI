FROM node:24.19.0-bookworm-slim AS builder

ARG SHOWDOWN_COMMIT=8ff48edc09e4aed6011c966258a5f95899128443
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY vendor/pokemon-showdown/package.json vendor/pokemon-showdown/package-lock.json ./
RUN npm ci --ignore-scripts
COPY vendor/pokemon-showdown/ ./
# Source archives produced before the VGC update accidentally omitted this directory.
# Repair it from the exact lockfile commit rather than a moving branch.
RUN if [ ! -f data/tags.ts ]; then \
      git clone --filter=blob:none --no-checkout https://github.com/smogon/pokemon-showdown.git /tmp/showdown-upstream \
      && git -C /tmp/showdown-upstream fetch --depth=1 origin "${SHOWDOWN_COMMIT}" \
      && git -C /tmp/showdown-upstream checkout --detach "${SHOWDOWN_COMMIT}" \
      && cp -a /tmp/showdown-upstream/data /app/data \
      && rm -rf /tmp/showdown-upstream; \
    fi
COPY config/showdown-config.js /app/config/config.js
RUN node build

FROM node:24.19.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    POKEMONAI_SHOWDOWN_BIND=0.0.0.0 \
    POKEMONAI_SHOWDOWN_PORT=8000 \
    POKEMONAI_SHOWDOWN_LOGS=/app/logs
COPY --from=builder /app /app
EXPOSE 8000
CMD ["node", "pokemon-showdown", "start", "--skip-build", "--no-security"]
