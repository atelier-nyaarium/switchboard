#!/bin/bash
# uninstall.sh - Remove Switchboard configuration from a DevContainer project
#
# Usage:
#   /path/to/uninstall.sh [--quiet]
#
# Run from the project root.

set -euo pipefail

QUIET=false
[[ "${1:-}" == "--quiet" ]] && QUIET=true

log() {
    $QUIET || echo "$@"
}

log "Removing Switchboard configuration..."

# ═════════════════════════════════════════════════════════════════════════════
# .devcontainer/compose.yml - remove switchboard-network
# ═════════════════════════════════════════════════════════════════════════════

COMPOSE_FILE=""
for candidate in ".devcontainer/compose.yml" ".devcontainer/compose.yaml" ".devcontainer/docker-compose.yml" ".devcontainer/docker-compose.yaml"; do
    if [[ -f "$candidate" ]]; then
        COMPOSE_FILE="$candidate"
        break
    fi
done

if [[ -n "$COMPOSE_FILE" ]] && command -v yq &>/dev/null; then
    if yq -e '.networks."switchboard-network"' "$COMPOSE_FILE" &>/dev/null; then
        SERVICES=$(yq -r '.services | keys | .[]' "$COMPOSE_FILE" 2>/dev/null)
        for svc in $SERVICES; do
            yq -Y -i "
                .services.\"${svc}\".networks = (
                    .services.\"${svc}\".networks // [] | map(select(. != \"switchboard-network\"))
                ) |
                if .services.\"${svc}\".networks | length == 0
                then del(.services.\"${svc}\".networks)
                else . end
            " "$COMPOSE_FILE"
        done

        yq -Y -i 'del(.networks."switchboard-network")' "$COMPOSE_FILE"
        yq -Y -i 'if .networks | length == 0 then del(.networks) else . end' "$COMPOSE_FILE"

        log "   ${COMPOSE_FILE} - removed switchboard-network"
    fi
fi

log ""
log "Done. Double check your compose file. yq doesn't preserve comments."
