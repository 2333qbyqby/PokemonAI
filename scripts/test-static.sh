#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
NODE_BIN="${NODE_BIN:-node}"
export PYTHONPATH="$ROOT/services/baseline-ai/src${PYTHONPATH:+:$PYTHONPATH}"
export TERM="${TERM:-dumb}"

cd "$ROOT"

echo '[1/8] Python unit tests'
"$PYTHON_BIN" -m pytest services/baseline-ai/tests -q

echo '[2/8] Team catalogue rebuild'
"$PYTHON_BIN" scripts/team-library.py build --project-root "$ROOT"

echo '[3/8] Generated client configuration'
"$PYTHON_BIN" scripts/generate-client-config.py \
  --config config/agents.yaml \
  --output apps/showdown-client/play.pokemonshowdown.com/src/pokemonai-config.ts

echo '[4/8] Directed TypeScript transpilation'
"$NODE_BIN" scripts/transpile-client.mjs

echo '[5/8] Browser-side unit tests'
"$NODE_BIN" --test apps/showdown-client/test/*.js services/web-server/server.test.mjs

echo '[6/8] Generated JavaScript syntax checks'
"$NODE_BIN" --check apps/showdown-client/play.pokemonshowdown.com/js/pokemonai.js
"$NODE_BIN" --check apps/showdown-client/play.pokemonshowdown.com/js/pokemonai-config.js
"$NODE_BIN" --check apps/showdown-client/play.pokemonshowdown.com/js/panel-mainmenu.js
"$NODE_BIN" --check apps/showdown-client/play.pokemonshowdown.com/pokemonai-sw.js
"$NODE_BIN" --check services/web-server/server.mjs

echo '[7/8] Python and structured-data checks'
"$PYTHON_BIN" -m compileall -q services/baseline-ai/src scripts
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
    Path('data/team-library/index.json'),
    Path('apps/showdown-client/play.pokemonshowdown.com/data/pokemonai-teams.json'),
    Path('apps/showdown-client/play.pokemonshowdown.com/manifest.webmanifest'),
]:
    json.loads(path.read_text(encoding='utf-8'))
print('YAML/JSON checks passed')
PY

echo '[8/8] Patch whitespace check'
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git diff --check
else
  echo 'No Git metadata; skipped git diff --check.'
fi

echo 'Static verification passed.'
