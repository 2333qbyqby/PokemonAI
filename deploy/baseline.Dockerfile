FROM python:3.12.13-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    POKEMONAI_SHOWDOWN_WS=ws://showdown:8000/showdown/websocket \
    POKEMONAI_PROJECT_ROOT=/opt/pokemonai
WORKDIR /opt/pokemonai
COPY services/baseline-ai /opt/pokemonai/baseline-ai
COPY config/agents.yaml /opt/pokemonai/config/agents.yaml
COPY config/team-sources.yaml /opt/pokemonai/config/team-sources.yaml
COPY data/team-library /opt/pokemonai/data/team-library
COPY data/team-sources/vendored /opt/pokemonai/data/team-sources/vendored
RUN python -m pip install --no-cache-dir /opt/pokemonai/baseline-ai
VOLUME ["/data"]
CMD ["pokemonai-baseline", "--config", "/opt/pokemonai/config/agents.yaml", "--project-root", "/opt/pokemonai", "--data-dir", "/data"]
