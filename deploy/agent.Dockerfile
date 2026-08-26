FROM node:24.19.0-bookworm-slim AS builder

WORKDIR /opt/pokemonai
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/pokemonai-engine ./packages/pokemonai-engine
COPY services/agent-runtime ./services/agent-runtime
RUN npm ci

WORKDIR /opt/pokemonai/vendor/pokemon-showdown
COPY vendor/pokemon-showdown/package.json vendor/pokemon-showdown/package-lock.json ./
RUN npm ci --ignore-scripts
COPY vendor/pokemon-showdown ./
RUN node build

WORKDIR /opt/pokemonai
RUN npm run build:agent

FROM node:24.19.0-bookworm-slim
ENV NODE_ENV=production POKEMONAI_PROJECT_ROOT=/opt/pokemonai
WORKDIR /opt/pokemonai
COPY --from=builder /opt/pokemonai/node_modules ./node_modules
COPY --from=builder /opt/pokemonai/packages ./packages
COPY --from=builder /opt/pokemonai/services/agent-runtime ./services/agent-runtime
COPY --from=builder /opt/pokemonai/vendor/pokemon-showdown/dist ./vendor/pokemon-showdown/dist
VOLUME ["/opt/pokemonai/var"]
CMD ["node", "services/agent-runtime/dist/src/cli.js", "serve", "--config", "/opt/pokemonai/var/run/instances/ranked-doubles-ai.json"]
