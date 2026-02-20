#!/bin/bash
set -euo pipefail

echo "[bridge] Setting up bridge for project '${PROJECT_NAME:-unknown}'"

# Install MCP dependencies
if [[ -d /agent-team-bridge/mcp ]] && [[ ! -d /agent-team-bridge/mcp/node_modules ]]; then
    echo "[bridge] Installing bridge MCP dependencies..."
    cd /agent-team-bridge/mcp && npm install --silent
fi

echo "[bridge] Setup complete. Registration happens automatically when Claude Code starts."
