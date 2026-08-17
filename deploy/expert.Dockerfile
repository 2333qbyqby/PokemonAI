FROM python:3.12.13-slim-bookworm AS poke-engine-builder

ARG RUST_VERSION=1.97.1
ARG RUSTUP_VERSION=1.29.0
ENV CARGO_HOME=/opt/cargo \
    RUSTUP_HOME=/opt/rustup \
    PATH=/opt/cargo/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -fsSLo /tmp/rustup-init \
      "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
    && curl --proto '=https' --tlsv1.2 -fsSLo /tmp/rustup-init.sha256 \
      "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init.sha256" \
    && cd /tmp && sha256sum --check rustup-init.sha256 \
    && chmod +x /tmp/rustup-init \
    && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}"
RUN python -m pip wheel --no-cache-dir --no-deps --wheel-dir /wheels \
    'poke-engine==0.0.48' \
    '--config-settings=build-args=--features poke-engine/terastallization --no-default-features'

FROM python:3.12.13-slim-bookworm
ENV PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    PYTHONIOENCODING=utf-8
WORKDIR /data
COPY --from=poke-engine-builder /wheels /wheels
RUN python -m pip install --no-cache-dir /wheels/poke_engine-0.0.48-*.whl \
    requests==2.33.0 websockets==14.1 python-dateutil==2.8.0 PyYAML==6.0.3 \
    && rm -rf /wheels
COPY vendor/foul-play /opt/foul-play
COPY config/agents.yaml /opt/pokemonai/config/agents.yaml
COPY services/expert-ai/runner.py /opt/pokemonai/expert-runner.py
VOLUME ["/data"]
ENTRYPOINT ["python", "/opt/pokemonai/expert-runner.py", "--config", "/opt/pokemonai/config/agents.yaml", "--foul-play-root", "/opt/foul-play", "--data-dir", "/data"]
