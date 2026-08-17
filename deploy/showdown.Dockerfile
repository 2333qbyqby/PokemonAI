FROM node:24.19.0-bookworm-slim AS builder

WORKDIR /app
COPY vendor/pokemon-showdown/package.json vendor/pokemon-showdown/package-lock.json ./
RUN npm ci --ignore-scripts
COPY vendor/pokemon-showdown/ ./
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
