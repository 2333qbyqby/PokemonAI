#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
NODE_BIN="${NODE_BIN:-node}"
export PYTHONPATH="$ROOT/packages/pokemonai-core/src${PYTHONPATH:+:$PYTHONPATH}"
export TERM="${TERM:-dumb}"

cd "$ROOT"

echo '[1/9] Python unit tests'
"$PYTHON_BIN" -m pytest packages/pokemonai-core/tests services/control-plane/test_server.py -q

echo '[2/9] TypeScript agent tests'
npm run test:agent

echo '[3/9] Team catalogue rebuild'
"$PYTHON_BIN" scripts/team-library.py build --project-root "$ROOT"

echo '[4/9] Generated client configuration'
"$PYTHON_BIN" scripts/generate-client-config.py \
  --config config/agents.yaml \
  --output apps/showdown-client/play.pokemonshowdown.com/src/pokemonai-config.ts

echo '[5/9] Directed TypeScript transpilation'
"$NODE_BIN" scripts/transpile-client.mjs

echo '[6/9] Browser-side unit tests'
"$NODE_BIN" --test apps/showdown-client/test/*.js

echo '[7/9] Generated JavaScript syntax checks'
"$NODE_BIN" --check apps/showdown-client/play.pokemonshowdown.com/js/pokemonai.js
"$NODE_BIN" --check apps/showdown-client/play.pokemonshowdown.com/js/pokemonai-config.js
"$NODE_BIN" --check apps/showdown-client/play.pokemonshowdown.com/js/pokemonai/catalog.js
"$NODE_BIN" --check apps/showdown-client/play.pokemonshowdown.com/js/pokemonai/navigation.js
"$NODE_BIN" --check apps/showdown-client/play.pokemonshowdown.com/js/pokemonai/teams.js
"$NODE_BIN" --check apps/showdown-client/play.pokemonshowdown.com/js/pokemonai/team-carousel.js
"$NODE_BIN" --check apps/showdown-client/play.pokemonshowdown.com/js/panel-mainmenu.js
"$NODE_BIN" --check apps/showdown-client/play.pokemonshowdown.com/js/panel-pokemonai-teams.js
"$NODE_BIN" --check apps/showdown-client/play.pokemonshowdown.com/pokemonai-sw.js

echo '[8/9] Python and structured-data checks'
"$PYTHON_BIN" -m compileall -q packages backends services/control-plane scripts
"$PYTHON_BIN" - <<'PY'
import json
from pathlib import Path
import yaml

for path in [
    Path('config/agents.yaml'),
    Path('config/team-sources.yaml'),
]:
    value = yaml.safe_load(path.read_text(encoding='utf-8'))
    assert isinstance(value, dict), path
for path in [
    Path('config/runtime-lock.json'),
    Path('var/generated/team-library/index.json'),
    Path('var/generated/public/pokemonai-teams.json'),
    Path('apps/showdown-client/play.pokemonshowdown.com/manifest.webmanifest'),
]:
    json.loads(path.read_text(encoding='utf-8'))
print('YAML/JSON checks passed')
PY

echo '[9/9] Patch whitespace check'
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git diff --check
else
  echo 'No Git metadata; skipped git diff --check.'
fi

echo 'Static verification passed.'
