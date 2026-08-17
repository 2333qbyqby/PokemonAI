FROM python:3.12.13-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    POKEMONAI_SHOWDOWN_WS=ws://showdown:8000/showdown/websocket
WORKDIR /opt/pokemonai
COPY services/baseline-ai /opt/pokemonai/baseline-ai
COPY config/agents.yaml /opt/pokemonai/config/agents.yaml
RUN python -m pip install --no-cache-dir /opt/pokemonai/baseline-ai
VOLUME ["/data"]
CMD ["pokemonai-baseline", "--config", "/opt/pokemonai/config/agents.yaml", "--data-dir", "/data"]
