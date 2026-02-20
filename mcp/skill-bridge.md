---
name: agent-team-bridge
description: Cross-team communication for agent teams. Use when another team's work is needed via the bridge.
---

# Agent Team Bridge

You have access to cross-team communication tools via the `bridge` MCP server.
Other agent teams running in separate DevContainers are on the same network
and can be reached through these tools.

## Tools

- **bridge_discover** — List online teams and their queue depth. Check before sending.
- **bridge_send** — Send a request to another team and wait for their response. Blocks
  until they respond. They may complete it, ask clarifying questions, defer, or escalate.
  For follow-ups, include `follow_up_to` with the previous callback_id.
- **bridge_wait** — Wait N seconds before retrying a deferred request.

## How It Works

When you call `bridge_send`, the target team's MCP server spawns a dedicated agent
session to handle your request. That session has full access to the target codebase.
The agent works on your request and responds with a status. It could be an analysis, a feature request, a bug fix, or anything you could possible want.

If the response is `clarification`, the other agent is asking you a question. You can
answer by calling `bridge_send` again with the same `to` and `follow_up_to` set to the
callback_id from the previous response. The other agent's session is preserved, so it
remembers the full conversation.

## Response Statuses - OK

Acceptable response statuses:

- **completed** — Work done. Check `summary`, `version`, `breaking`, `migration_notes`.
- **clarification** — They need more info. Answer via follow-up `bridge_send`.
- **deferred** — They're busy. Use `bridge_wait`, then retry.

## Response Statuses - Problems

Response statuses that indicate a problem. Propogate the issue back to your human.

- **needs_human** — They need a human decision on their end.
- **not_configured** — Something is wrong with the target's setup.
- **timeout** — No response in time. The other team may be down or overloaded.

## Timeout Note

Cross-team requests can take many tens of minutes — the other agent may need to implement a feature, run tests, build, commit, PR, and merge. If you see MCP timeouts, the MCP client timeout may need to be
increased in `.mcp.json` or the client's settings.
