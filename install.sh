#!/bin/bash
# install.sh - Add the switchboard Docker network to a DevContainer project
#
# Usage:
#   /path/to/install.sh
#
# Run from the project root (where .devcontainer/ lives).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NETWORK_NAME="${BRIDGE_NETWORK_NAME:-switchboard}"

# ── Preflight ─────────────────────────────────────────────────────────────────

if [[ ! -d ".devcontainer" ]]; then
    echo "Error: No .devcontainer/ directory found. Run this from your project root."
    exit 1
fi

if ! command -v yq &>/dev/null; then
    echo "Error: yq is required.  pip install yq  /  brew install yq"
    exit 1
fi

bash "${SCRIPT_DIR}/uninstall.sh" --quiet 2>/dev/null || true

# ═════════════════════════════════════════════════════════════════════════════
# .devcontainer/compose.yml - add external network
# ═════════════════════════════════════════════════════════════════════════════

COMPOSE_FILE=""
for candidate in ".devcontainer/compose.yml" ".devcontainer/compose.yaml" ".devcontainer/docker-compose.yml" ".devcontainer/docker-compose.yaml"; do
    if [[ -f "$candidate" ]]; then
        COMPOSE_FILE="$candidate"
        break
    fi
done

if [[ -z "$COMPOSE_FILE" ]]; then
    echo "No compose file found in .devcontainer/."
    echo "Manually add your container to the '${NETWORK_NAME}' Docker network."
    exit 1
fi

SERVICE_NAME=$(yq -r '.services | keys | .[0]' "$COMPOSE_FILE" 2>/dev/null)

if [[ -z "$SERVICE_NAME" || "$SERVICE_NAME" == "null" ]]; then
    echo "Could not detect service name in ${COMPOSE_FILE}."
    exit 1
fi

yq -Y -i "
    .networks.\"switchboard-network\".name = \"${NETWORK_NAME}\"
" "$COMPOSE_FILE"

HAS_NETWORKS=$(yq -r ".services.\"${SERVICE_NAME}\".networks" "$COMPOSE_FILE" 2>/dev/null)

if [[ "$HAS_NETWORKS" == "null" ]]; then
    yq -Y -i ".services.\"${SERVICE_NAME}\".networks = [\"default\", \"switchboard-network\"]" "$COMPOSE_FILE"
else
    # Ensure default is present before adding the switchboard network
    HAS_DEFAULT=$(yq -r ".services.\"${SERVICE_NAME}\".networks | index(\"default\") // empty" "$COMPOSE_FILE" 2>/dev/null)
    if [[ -z "$HAS_DEFAULT" ]]; then
        yq -Y -i ".services.\"${SERVICE_NAME}\".networks = [\"default\"] + .services.\"${SERVICE_NAME}\".networks" "$COMPOSE_FILE"
    fi
    yq -Y -i ".services.\"${SERVICE_NAME}\".networks += [\"switchboard-network\"]" "$COMPOSE_FILE"
fi

echo "Added switchboard-network to ${COMPOSE_FILE} (service: ${SERVICE_NAME})"
echo ""
echo "Next steps:"
echo "  1. Double check your compose file. yq unfortunately doesn't preserve comments."
echo "  2. Set PROJECT_NAME and BRIDGE_ROUTER_URL in your devcontainer environment."
echo "  3. Rebuild your Devcontainer."
