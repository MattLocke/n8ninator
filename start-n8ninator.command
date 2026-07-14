#!/bin/zsh
set -euo pipefail

ROOT_DIR="${0:A:h}"
cd "$ROOT_DIR"

if [[ ! -d node_modules || ! -f dist/src/server.js ]]; then
  "$ROOT_DIR/setup.sh"
fi

if ! curl -fsS --max-time 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  open -a Ollama || true
  sleep 2
fi

npm start
