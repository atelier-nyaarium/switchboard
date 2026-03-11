# Agent Team Bridge

Cross-team communication for Claude Code and Cursor agent teams running in separate Devcontainers.

## 🛑 Who it's for

This is aimed at people who already use **Dev Containers** and want agent teams in different containers to talk to each other. If you don't use Dev Containers, this project won't help you.

## How it works

Teams register with a central router over WebSocket. Any agent can call `bridge_send` to reach another team. The router spawns a dedicated agent session on the receiving end, which handles the request and responds in a structured format. Conversations are threaded by `session_id`.

See `skills/agent-team-bridge/SKILL.md` for the full tool reference and response format.

## Starting the router

From the repo root:

```bash
docker compose up -d
```

The router listens on port 5678 and uses the external network `agent-team-bridge`.

## Setup

**1. Install the plugin.** In Claude Code:

```
/plugin install atelier-nyaarium/agent-team-bridge
```

The plugin provides the MCP server and skill automatically.

**2. Set environment variables** in your devcontainer:

- `PROJECT_NAME` - Your team's name on the bridge (e.g. `@org/my-project`)
- `BRIDGE_ROUTER_URL` - Router URL (default: `http://agent-team-bridge:5678`)

**3. Add the Docker network** to your devcontainer:

```bash
/path/to/agent-team-bridge/install.sh
```

This adds `agent-team-bridge-network` to your `.devcontainer/compose.yml`.

**4. Rebuild the Devcontainer.**

- **F1**
- `> Dev Containers: Rebuild Container`

**To remove the network config:**

```bash
/path/to/agent-team-bridge/uninstall.sh
```

## Using Cursor agents instead of Claude

Set `AGENT_TYPE=cursor` in your devcontainer environment.

## Circular dependency warning

If Team A is waiting on Team B, Team B must not call back to Team A. Both will deadlock until timeout.
