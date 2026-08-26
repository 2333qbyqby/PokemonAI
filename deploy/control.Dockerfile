FROM python:3.12.13-slim-bookworm

ENV PYTHONUNBUFFERED=1 POKEMONAI_PROJECT_ROOT=/opt/pokemonai
WORKDIR /opt/pokemonai
COPY packages/pokemonai-core /opt/pokemonai/pokemonai-core
COPY backends /opt/pokemonai/backends
COPY config /opt/pokemonai/config
COPY resources /opt/pokemonai/resources
COPY services/control-plane /opt/pokemonai/services/control-plane
COPY scripts/team-library.py /opt/pokemonai/scripts/team-library.py
COPY deploy/control-entrypoint.sh /opt/pokemonai/deploy/control-entrypoint.sh
RUN python -m pip install --no-cache-dir /opt/pokemonai/pokemonai-core
RUN python scripts/team-library.py build --project-root /opt/pokemonai \
    && mkdir -p /opt/pokemonai/seed/team-library \
    && cp /opt/pokemonai/var/generated/team-library/index.json /opt/pokemonai/seed/team-library/index.json
VOLUME ["/opt/pokemonai/var"]
CMD ["sh", "deploy/control-entrypoint.sh"]
