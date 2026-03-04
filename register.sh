#!/bin/bash
set -euo pipefail

echo "[bridge] Setting up bridge for project '${PROJECT_NAME:-unknown}'"

# Build MCP binary
if [[ -d /agent-team-bridge ]]; then
    echo "[bridge] Installing bridge dependencies and building binary..."
    cd /agent-team-bridge
    bun install
    mkdir -p build
    bun build --compile --target=bun-linux-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/') src/main.ts --outfile=build/agent-team-bridge
fi

echo "[bridge] Setup complete. Registration happens automatically when Claude Code starts."
