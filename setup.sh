#!/bin/zsh
set -euo pipefail

ROOT_DIR="${0:A:h}"
cd "$ROOT_DIR"

echo ""
echo "n8ninator setup"
echo "================"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required."
  if command -v brew >/dev/null 2>&1; then
    read "INSTALL_NODE?Install Node.js with Homebrew now? [Y/n] "
    if [[ ! "$INSTALL_NODE" =~ ^[Nn]$ ]]; then brew install node; else exit 1; fi
  else
    open "https://nodejs.org/en/download" || true
    echo "Install Node.js, then run ./setup.sh again."
    exit 1
  fi
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 20 )); then
  echo "Node.js 20 or newer is required; found $(node --version)."
  exit 1
fi

if ! command -v ollama >/dev/null 2>&1; then
  echo "Ollama is not installed."
  if command -v brew >/dev/null 2>&1; then
    read "INSTALL_OLLAMA?Install Ollama with Homebrew now? [Y/n] "
    if [[ ! "$INSTALL_OLLAMA" =~ ^[Nn]$ ]]; then
      brew install --cask ollama
    else
      open "https://ollama.com/download/mac" || true
      echo "Install Ollama, then run ./setup.sh again."
      exit 1
    fi
  else
    open "https://ollama.com/download/mac" || true
    echo "Install Ollama, then run ./setup.sh again."
    exit 1
  fi
fi

echo "Installing n8ninator dependencies…"
npm install
npm run build

if ! curl -fsS --max-time 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  echo "Starting Ollama…"
  open -a Ollama || true
  for _ in {1..30}; do
    if curl -fsS --max-time 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi

if curl -fsS --max-time 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  if ! ollama list | awk '{print $1}' | grep -Eq '^gpt-oss:20b$'; then
    echo ""
    echo "The recommended model is gpt-oss:20b (about 14 GB)."
    read "PULL_MODEL?Download it now? [Y/n] "
    if [[ ! "$PULL_MODEL" =~ ^[Nn]$ ]]; then ollama pull gpt-oss:20b; fi
  fi
else
  echo "Ollama did not start yet. Open the Ollama app before launching n8ninator."
fi

echo ""
echo "Setup complete. Run ./start-n8ninator.command or npm start."
