#!/bin/bash
# install.sh — Configure a DevContainer project for Agent Team Bridge
#
# Usage:
#   PROJECT_NAME=@org/my-app /path/to/install.sh
#   /path/to/install.sh <team-name>   # fallback if PROJECT_NAME unset
#
# Example:
#   PROJECT_NAME=@nyaarium/cool-library ./install.sh
#   BRIDGE_ROUTER_HOST=my-router ./install.sh @nyaarium/nextjs-app
#
# Run from the project root (where .devcontainer/ lives).

set -euo pipefail

BRIDGE_VERSION="v0.1.0"
BRIDGE_MARKER="agent-team-bridge: ${BRIDGE_VERSION}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/mcp/skill-bridge.md" ]]; then
	BRIDGE_ROOT="${SCRIPT_DIR}"
else
	BRIDGE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi

AGENT_TYPE="${BRIDGE_AGENT_TYPE:-claude}"

TEAM_NAME="${PROJECT_NAME:-${1:-}}"
ROUTER_HOST="${BRIDGE_ROUTER_HOST:-agent-team-bridge}"
ROUTER_PORT="${BRIDGE_ROUTER_PORT:-5678}"
NETWORK_NAME="${BRIDGE_NETWORK_NAME:-agent-team-bridge}"

if [[ -z "$TEAM_NAME" ]]; then
    echo "Usage: PROJECT_NAME=<team-name> install.sh   OR   install.sh <team-name>"
    echo ""
    echo "Example: PROJECT_NAME=@nyaarium/cool-library ./install.sh"
    echo ""
    echo "Environment variables:"
    echo "  PROJECT_NAME         (default: PROJECT_NAME env var or first argument)"
    echo "  BRIDGE_ROUTER_HOST   (default: agent-team-bridge)"
    echo "  BRIDGE_ROUTER_PORT   (default: 5678)"
    echo "  BRIDGE_AGENT_TYPE    (default: claude)  Options: claude, cursor"
    echo "  BRIDGE_NETWORK_NAME  (default: agent-team-bridge)"
    exit 1
fi

ROUTER_URL="http://${ROUTER_HOST}:${ROUTER_PORT}"

# ── Preflight ─────────────────────────────────────────────────────────────────

if [[ ! -d ".devcontainer" ]]; then
    echo "Error: No .devcontainer/ directory found. Run this from your project root."
    exit 1
fi

if ! command -v jq &>/dev/null; then
    echo "Error: jq is required.  apt-get install jq  /  brew install jq"
    exit 1
fi

if ! command -v yq &>/dev/null; then
    echo "Error: yq is required.  pip install yq  /  brew install yq"
    exit 1
fi

echo "╔══════════════════════════════════════════╗"
echo "║     Agent Team Bridge — Install          ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Team:     ${TEAM_NAME}"
echo "  Router:   ${ROUTER_URL}"
echo "  Network:  ${NETWORK_NAME}"
echo ""

# Uninstall first

bash "${SCRIPT_DIR}/uninstall.sh" --quiet 2>/dev/null || true

# ═════════════════════════════════════════════════════════════════════════════
# 1. .mcp.json
# ═════════════════════════════════════════════════════════════════════════════

echo "── .mcp.json"

BRIDGE_MCP_ENTRY=$(cat <<MCPJSON
{
    "command": "node",
    "args": ["/agent-team-bridge/mcp/server.js"],
    "env": {
        "BRIDGE_ROUTER_URL": "${ROUTER_URL}",
        "BRIDGE_TEAM_NAME": "${TEAM_NAME}",
        "BRIDGE_AGENT_TYPE": "${AGENT_TYPE}",
        "_marker": "${BRIDGE_MARKER}"
    }
}
MCPJSON
)

if [[ -f ".mcp.json" ]]; then
    jq --argjson bridge "$BRIDGE_MCP_ENTRY" '.mcpServers.bridge = $bridge' .mcp.json > .mcp.json.tmp
    mv .mcp.json.tmp .mcp.json
    echo "   Updated existing .mcp.json"
else
    jq -n --argjson bridge "$BRIDGE_MCP_ENTRY" '{ mcpServers: { bridge: $bridge } }' > .mcp.json
    echo "   Created .mcp.json"
fi

# ═════════════════════════════════════════════════════════════════════════════
# 2. .claude/skills/bridge.md
# ═════════════════════════════════════════════════════════════════════════════

echo "── .claude/skills/bridge.md"

mkdir -p .claude/skills/agent-team-bridge
cp "${BRIDGE_ROOT}/mcp/skill-bridge.md" .claude/skills/agent-team-bridge/SKILL.md
echo "   Copied skill template"

# ═════════════════════════════════════════════════════════════════════════════
# 3. .devcontainer/compose.yml — add external network
# ═════════════════════════════════════════════════════════════════════════════

echo "── .devcontainer/compose.yml"

COMPOSE_FILE=""
for candidate in ".devcontainer/compose.yml" ".devcontainer/compose.yaml" ".devcontainer/docker-compose.yml" ".devcontainer/docker-compose.yaml"; do
    if [[ -f "$candidate" ]]; then
        COMPOSE_FILE="$candidate"
        break
    fi
done

if [[ -z "$COMPOSE_FILE" ]]; then
    echo "   Warning: No compose file found — skipping network setup."
    echo "   Manually add your container to the '${NETWORK_NAME}' Docker network."
else
    SERVICE_NAME=$(yq -r '.services | keys | .[0]' "$COMPOSE_FILE" 2>/dev/null)

    if [[ -z "$SERVICE_NAME" || "$SERVICE_NAME" == "null" ]]; then
        echo "   Warning: Could not detect service name — skipping network setup."
    else
        echo "   Detected service: ${SERVICE_NAME}"

        # Top-level external network definition
        yq -Y -i "
            .networks.\"bridge-net\".external = true |
            .networks.\"bridge-net\".name = \"${NETWORK_NAME}\" |
            .networks.\"bridge-net\".\"x-marker\" = \"${BRIDGE_MARKER}\"
        " "$COMPOSE_FILE"

        # Add to service's network list
        HAS_NETWORKS=$(yq -r ".services.\"${SERVICE_NAME}\".networks" "$COMPOSE_FILE" 2>/dev/null)

        if [[ "$HAS_NETWORKS" == "null" ]]; then
            yq -Y -i ".services.\"${SERVICE_NAME}\".networks = [\"bridge-net\"]" "$COMPOSE_FILE"
        else
            yq -Y -i ".services.\"${SERVICE_NAME}\".networks += [\"bridge-net\"]" "$COMPOSE_FILE"
        fi

        echo "   Added bridge-net to ${COMPOSE_FILE}"
    fi
fi

# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "✓ Installed for ${TEAM_NAME}"
echo ""
echo "  Next steps:"
echo "  1. docker network create ${NETWORK_NAME}    (if not already created)"
echo "  2. Start bridge router                       (see bridge repo docker-compose.yml)"
echo "  3. Rebuild your DevContainer"
