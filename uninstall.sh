#!/bin/bash
# uninstall.sh - Remove Agent Team Bridge configuration from a DevContainer project
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

log "Removing Agent Team Bridge configuration..."

# ═════════════════════════════════════════════════════════════════════════════
# 1. Legacy cleanup (pre-plugin installs injected config directly)
# ═════════════════════════════════════════════════════════════════════════════

if command -v jq &>/dev/null; then
    for mcp_file in ".mcp.json" ".cursor/mcp.json"; do
        if [[ -f "$mcp_file" ]] && jq -e '.mcpServers["agent-team-bridge"]' "$mcp_file" &>/dev/null; then
            jq --tab 'del(.mcpServers["agent-team-bridge"])' "$mcp_file" > "${mcp_file}.tmp"
            mv "${mcp_file}.tmp" "$mcp_file"

            if jq -e '.mcpServers | length == 0' "$mcp_file" &>/dev/null; then
                rm "$mcp_file"
                log "   ${mcp_file} removed (was empty)"
            else
                log "   ${mcp_file} - removed legacy entry"
            fi
        fi
    done
fi

if [[ -f ".claude/skills/agent-team-bridge/SKILL.md" ]]; then
    rm .claude/skills/agent-team-bridge/SKILL.md
    rmdir .claude/skills/agent-team-bridge 2>/dev/null || true
    rmdir .claude/skills 2>/dev/null || true
    log "   Cleaned up legacy .claude/skills/agent-team-bridge"
fi

# ═════════════════════════════════════════════════════════════════════════════
# 2. .devcontainer/compose.yml - remove agent-team-bridge-network
# ═════════════════════════════════════════════════════════════════════════════

COMPOSE_FILE=""
for candidate in ".devcontainer/compose.yml" ".devcontainer/compose.yaml" ".devcontainer/docker-compose.yml" ".devcontainer/docker-compose.yaml"; do
    if [[ -f "$candidate" ]]; then
        COMPOSE_FILE="$candidate"
        break
    fi
done

if [[ -n "$COMPOSE_FILE" ]] && command -v yq &>/dev/null; then
    if yq -e '.networks."agent-team-bridge-network"' "$COMPOSE_FILE" &>/dev/null; then
        SERVICES=$(yq -r '.services | keys | .[]' "$COMPOSE_FILE" 2>/dev/null)
        for svc in $SERVICES; do
            yq -Y -i "
                .services.\"${svc}\".networks = (
                    .services.\"${svc}\".networks // [] | map(select(. != \"agent-team-bridge-network\"))
                ) |
                if .services.\"${svc}\".networks | length == 0
                then del(.services.\"${svc}\".networks)
                else . end
            " "$COMPOSE_FILE"
        done

        yq -Y -i 'del(.networks."agent-team-bridge-network")' "$COMPOSE_FILE"
        yq -Y -i 'if .networks | length == 0 then del(.networks) else . end' "$COMPOSE_FILE"

        log "   ${COMPOSE_FILE} - removed agent-team-bridge-network"
    fi
fi

log ""
log "Done. Double check your compose file. yq doesn't preserve comments."
