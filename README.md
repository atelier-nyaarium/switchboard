# Agent Team Bridge

Cross-team communication for Claude Code and Cursor agent teams running in separate Devcontainers.

## 🛑 Who it's for

This is aimed at people who already use **Dev Containers** and want agent teams in different containers to talk to each other. If you don't use Dev Containers, this project won't help you.

## How it works

Teams register with a central router over WebSocket. Any agent can call `bridge_send` to reach another team — the router spawns a dedicated agent session on the receiving end, which handles the request and responds in a structured format. Conversations are threaded by `session_id`.

See `skill-bridge.md` for the full tool reference and response format.

## Starting the router

From the repo root:

```bash
docker compose up -d
```

The router listens on port 5678 and uses the external network `agent-team-bridge`.

## Setup

**1. Append to Devcontainer Dockerfile:**

```dockerfile
# Agent Team Bridge
ENV CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
RUN git clone --depth 1 https://github.com/atelier-nyaarium/agent-team-bridge.git /agent-team-bridge \
    && cd /agent-team-bridge/mcp && npm i --silent
```

**2. Start Devcontainer, then run:**

```bash
/agent-team-bridge/install.sh
```

**3. Rebuild the Devcontainer.**

- **F1**
- `> Dev Containers: Rebuild Container`

**To uninstall, run:**

```bash
/agent-team-bridge/uninstall.sh
```

## Using Cursor agents instead of Claude

In `.cursor/mcp.json`, set:

```json
"BRIDGE_AGENT_TYPE": "cursor"
```

## Circular dependency warning

If Team A is waiting on Team B, Team B must not call back to Team A — both will deadlock until timeout.
