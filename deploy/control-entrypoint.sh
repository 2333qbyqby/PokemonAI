#!/bin/sh
set -eu

mkdir -p /opt/pokemonai/var/generated/team-library
if [ ! -f /opt/pokemonai/var/generated/team-library/index.json ]; then
  cp /opt/pokemonai/seed/team-library/index.json /opt/pokemonai/var/generated/team-library/index.json
fi

exec python services/control-plane/server.py \
  --project-root /opt/pokemonai --bind 0.0.0.0 --port 8080 --showdown-port 8000
