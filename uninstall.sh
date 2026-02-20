#!/bin/bash
# uninstall.sh — Remove Agent Team Bridge configuration from a DevContainer project
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

log "── Removing Agent Team Bridge configuration..."

# ═════════════════════════════════════════════════════════════════════════════
# 1. .mcp.json — remove the bridge server entry
# ═════════════════════════════════════════════════════════════════════════════

if [[ -f ".mcp.json" ]]; then
    if jq -e '.mcpServers.bridge.env._marker // empty | test("agent-team-bridge:")' .mcp.json &>/dev/null; then
        jq 'del(.mcpServers.bridge)' .mcp.json > .mcp.json.tmp
        mv .mcp.json.tmp .mcp.json

        # If mcpServers is now empty, remove the file
        if jq -e '.mcpServers | length == 0' .mcp.json &>/dev/null; then
            rm .mcp.json
            log "   .mcp.json removed (was empty)"
        else
            log "   .mcp.json — removed bridge entry"
        fi
    fi
fi

# ═════════════════════════════════════════════════════════════════════════════
# 2. .claude/skills — remove skill file
# ═════════════════════════════════════════════════════════════════════════════

if [[ -f ".claude/skills/agent-team-bridge/SKILL.md" ]]; then
    rm .claude/skills/agent-team-bridge/SKILL.md
    rmdir .claude/skills/agent-team-bridge 2>/dev/null || true
    log "   .claude/skills/agent-team-bridge removed"
fi
rmdir .claude/skills 2>/dev/null || true

# ═════════════════════════════════════════════════════════════════════════════
# 3. .devcontainer/compose.yml — remove bridge-net network
# ═════════════════════════════════════════════════════════════════════════════

COMPOSE_FILE=""
for candidate in ".devcontainer/compose.yml" ".devcontainer/compose.yaml" ".devcontainer/docker-compose.yml" ".devcontainer/docker-compose.yaml"; do
    if [[ -f "$candidate" ]]; then
        COMPOSE_FILE="$candidate"
        break
    fi
done

if [[ -n "$COMPOSE_FILE" ]] && command -v yq &>/dev/null; then
    if yq -e '.networks."bridge-net"."x-marker" // "" | test("agent-team-bridge:")' "$COMPOSE_FILE" &>/dev/null; then

        # Remove bridge-net from all services' network lists
        SERVICES=$(yq -r '.services | keys | .[]' "$COMPOSE_FILE" 2>/dev/null)
        for svc in $SERVICES; do
            yq -i "
                .services.\"${svc}\".networks = (
                    .services.\"${svc}\".networks // [] | map(select(. != \"bridge-net\"))
                ) |
                if .services.\"${svc}\".networks | length == 0
                then del(.services.\"${svc}\".networks)
                else . end
            " "$COMPOSE_FILE"
        done

        # Remove top-level bridge-net
        yq -i 'del(.networks."bridge-net")' "$COMPOSE_FILE"
        yq -i 'if .networks | length == 0 then del(.networks) else . end' "$COMPOSE_FILE"

        log "   ${COMPOSE_FILE} — removed bridge-net"
    fi
fi

log ""
log "✓ Agent Team Bridge configuration removed."
