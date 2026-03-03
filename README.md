# Agent Team Bridge

Cross-team communication for Claude Code and Cursor agent teams running in separate Devcontainers.

## 🛑 Who it's for

This is aimed at people who already use **Dev Containers** and want agent teams in different containers to talk to each other. If you don't use Dev Containers, this project won't help you.

## How it works

Teams register with a central router over WebSocket. Any agent can call `bridge_send` to reach another team — the router spawns a dedicated agent session on the receiving end, which handles the request and responds in a structured format. Conversations are threaded by `session_id`.

See `skills/agent-team-bridge/SKILL.md` for the full tool reference and response format.

## Starting the router

From the repo root:

```bash
docker compose up -d
```

The router listens on port 5678 and uses the external network `agent-team-bridge`.

## Setup

**1. Append to the Devcontainer's Dockerfile:**

```dockerfile
# Agent Team Bridge
RUN git clone --depth 1 https://github.com/atelier-nyaarium/agent-team-bridge.git /agent-team-bridge \
    && cd /agent-team-bridge/mcp && npm i --silent
```

**2. Build and start the Devcontainer, then run the install script:**

```bash
/agent-team-bridge/install.sh
```

This configures `.mcp.json`, `.cursor/mcp.json`, `.claude/settings.json` (plugin), and `.devcontainer/compose.yml` (network).

**3. Rebuild the Devcontainer.**

- **F1**
- `> Dev Containers: Rebuild Container`

**To uninstall, run:**

```bash
/agent-team-bridge/uninstall.sh
```

<details>
<summary>Manual configuration (what the scripts do)</summary>

**Dockerfile addition:**

```dockerfile
# Agent Team Bridge
RUN git clone --depth 1 https://github.com/atelier-nyaarium/agent-team-bridge.git /agent-team-bridge \
    && cd /agent-team-bridge/mcp && npm i --silent
```

**Plugin in `.claude/settings.json`:**

```json
{
	"extraKnownMarketplaces": {
		"agent-team-bridge": {
			"source": {
				"source": "github",
				"repo": "atelier-nyaarium/agent-team-bridge"
			},
			"autoUpdate": true
		}
	},
	"enabledPlugins": {
		"agent-team-bridge@agent-team-bridge": true
	}
}
```

**MCP server in `.mcp.json`:**

```json
{
	"mcpServers": {
		"agent-team-bridge": {
			"command": "node",
			"args": ["/agent-team-bridge/mcp/server.js"],
			"env": {
				"TEAM_NAME": "@org/my-project",
				"BRIDGE_ROUTER_URL": "http://agent-team-bridge:5678",
				"AGENT_TYPE": "claude",
				"MODEL_SIMPLE": "auto",
				"MODEL_STANDARD": "sonnet",
				"MODEL_COMPLEX": "opus"
			}
		}
	}
}
```

**External network in `.devcontainer/compose.yml`:**

```yaml
networks:
  agent-team-bridge-network:
    name: agent-team-bridge
```

Add `agent-team-bridge-network` to your service's `networks` list.

</details>

## Using Cursor agents instead of Claude

In `.cursor/mcp.json`, set:

```json
"AGENT_TYPE": "cursor"
```

## Circular dependency warning

If Team A is waiting on Team B, Team B must not call back to Team A — both will deadlock until timeout.
