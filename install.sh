#!/bin/bash
# install.sh - Configure a DevContainer project for Agent Team Bridge
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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/src/main.ts" ]]; then
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
    echo "Usage: install.sh <team-name>"
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
echo "║     Agent Team Bridge - Install          ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Team:     ${TEAM_NAME}"
echo "  Router:   ${ROUTER_URL}"
echo "  Network:  ${NETWORK_NAME}"
echo ""

bash "${SCRIPT_DIR}/uninstall.sh" --quiet 2>/dev/null || true

# ═════════════════════════════════════════════════════════════════════════════
# 1. .mcp.json
# ═════════════════════════════════════════════════════════════════════════════

echo "── .mcp.json"

BRIDGE_MCP_ENTRY=$(cat <<MCPJSON
{
    "command": "/agent-team-bridge/build/agent-team-bridge",
    "args": [],
    "env": {
        "TEAM_NAME": "${TEAM_NAME}",
        "BRIDGE_ROUTER_URL": "${ROUTER_URL}",
        "AGENT_TYPE": "${AGENT_TYPE}",
        "MODEL_SIMPLE": "auto",
        "MODEL_STANDARD": "sonnet",
        "MODEL_COMPLEX": "opus"
    }
}
MCPJSON
)

if [[ -f ".mcp.json" ]]; then
    jq --tab --argjson entry "$BRIDGE_MCP_ENTRY" '.mcpServers["agent-team-bridge"] = $entry' .mcp.json > .mcp.json.tmp
    mv .mcp.json.tmp .mcp.json
    echo "   Updated existing .mcp.json"
else
    jq --tab -n --argjson entry "$BRIDGE_MCP_ENTRY" '{ mcpServers: { "agent-team-bridge": $entry } }' > .mcp.json
    echo "   Created .mcp.json"
fi

echo "── .cursor/mcp.json"
mkdir -p .cursor
if [[ -f ".cursor/mcp.json" ]]; then
    jq --tab --argjson entry "$BRIDGE_MCP_ENTRY" '.mcpServers["agent-team-bridge"] = $entry' .cursor/mcp.json > .cursor/mcp.json.tmp
    mv .cursor/mcp.json.tmp .cursor/mcp.json
    echo "   Updated existing .cursor/mcp.json"
else
    jq --tab -n --argjson entry "$BRIDGE_MCP_ENTRY" '{ mcpServers: { "agent-team-bridge": $entry } }' > .cursor/mcp.json
    echo "   Created .cursor/mcp.json"
fi

# ═════════════════════════════════════════════════════════════════════════════
# 2. .claude/settings.json - add agent-team-bridge plugin
# ═════════════════════════════════════════════════════════════════════════════

echo "── .claude/settings.json"

BRIDGE_MARKETPLACE=$(cat <<'MKJSON'
{
    "source": {
        "source": "github",
        "repo": "atelier-nyaarium/agent-team-bridge"
    },
    "autoUpdate": true
}
MKJSON
)

mkdir -p .claude
if [[ -f ".claude/settings.json" ]]; then
    jq --tab --argjson mk "$BRIDGE_MARKETPLACE" '
        .extraKnownMarketplaces["agent-team-bridge"] = $mk |
        .enabledPlugins["agent-team-bridge@agent-team-bridge"] = true |
        .enabledPlugins = (.enabledPlugins | to_entries | sort_by(.key) | from_entries) |
        .extraKnownMarketplaces = (.extraKnownMarketplaces | to_entries | sort_by(.key) | from_entries)
    ' .claude/settings.json > .claude/settings.json.tmp
    mv .claude/settings.json.tmp .claude/settings.json
    echo "   Updated existing .claude/settings.json"
else
    jq --tab -n --argjson mk "$BRIDGE_MARKETPLACE" '{
        enabledPlugins: { "agent-team-bridge@agent-team-bridge": true },
        extraKnownMarketplaces: { "agent-team-bridge": $mk }
    }' > .claude/settings.json
    echo "   Created .claude/settings.json"
fi

# ═════════════════════════════════════════════════════════════════════════════
# 3. .devcontainer/compose.yml - add external network
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
    echo "   Warning: No compose file found - skipping network setup."
    echo "   Manually add your container to the '${NETWORK_NAME}' Docker network."
else
    SERVICE_NAME=$(yq -r '.services | keys | .[0]' "$COMPOSE_FILE" 2>/dev/null)

    if [[ -z "$SERVICE_NAME" || "$SERVICE_NAME" == "null" ]]; then
        echo "   Warning: Could not detect service name - skipping network setup."
    else
        echo "   Detected service: ${SERVICE_NAME}"

        # Network: auto-created on first compose up
        yq -Y -i "
            .networks.\"agent-team-bridge-network\".name = \"${NETWORK_NAME}\"
        " "$COMPOSE_FILE"

        HAS_NETWORKS=$(yq -r ".services.\"${SERVICE_NAME}\".networks" "$COMPOSE_FILE" 2>/dev/null)

        if [[ "$HAS_NETWORKS" == "null" ]]; then
            yq -Y -i ".services.\"${SERVICE_NAME}\".networks = [\"agent-team-bridge-network\"]" "$COMPOSE_FILE"
        else
            yq -Y -i ".services.\"${SERVICE_NAME}\".networks += [\"agent-team-bridge-network\"]" "$COMPOSE_FILE"
        fi

        echo "   Added agent-team-bridge-network to ${COMPOSE_FILE}"
    fi
fi

# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "✓ Installed for ${TEAM_NAME}"
echo ""
echo "  Next steps:"
echo "  1. Double check your .devcontainer/compose.yml file. yq unfortunately doesn't preserve comments."
echo "  2. Rebuild your Devcontainer."
echo "  3. If you already haven't, start the team bridge router."
