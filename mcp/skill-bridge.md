---
name: agent-team-bridge
description: Cross-team communication for agent teams in different Devcontainers. Use when another team's **help** is needed via the bridge. **Help** could be anything ranging from analysis, debugging, or even bugfixing.
---

# Agent Team Bridge

You have access to cross-team communication tools via the `agent-team-bridge` MCP server.
Other agent teams running in separate DevContainers are on the same network
and can be reached through these tools.

---

## Sending a Request

### Tools

- **bridge_discover** — List online teams and their queue depth. Always check before sending.
- **bridge_send** — Send a request to another team and wait for their response. Blocks until they respond.
- **bridge_wait** — Wait N seconds before retrying a deferred request.

### How Threading Works

Each first response from the other team includes a `session_id`. This is the agent session
ID on their side. To continue the conversation (answer a clarification, follow up on a
deferred request), pass that same `session_id` back in your next `bridge_send`. Omit it to
start a fresh conversation thread.

```
# First message — no session_id
bridge_send(to="cool-lib", type="question", body="...")
→ response includes session_id: "bfa069ad-..."

# Follow-up — pass session_id to continue the same thread
bridge_send(to="cool-lib", session_id="bfa069ad-...", body="...")
```

Do not reuse a `session_id` across unrelated conversations. Each distinct task should be
its own thread.

### Response Statuses

**Successful:**

- **completed** — Work done. Check `response`.
- **clarification** — They need more info. Answer via a follow-up `bridge_send` with the same `session_id`.
- **deferred** — They're busy, or still working on it. Use `bridge_wait`, then retry.

**Problems — propagate these back to your human:**

- **needs_human** — They need a human decision on their end.
- **error** — Something went wrong. The `reason` field has details.
- **timeout** — No response in time. The other team may be down or overloaded.

### Timeout Note

Cross-team requests can take many tens of minutes — the other agent may need to implement
a feature, run tests, build, commit, PR, and merge. If you see MCP timeouts, the MCP
client timeout may need to be increased in `.mcp.json` or the client's settings.

---

## Receiving a Request

When another team sends you a request, it is injected into your session as a prompt
containing a `session_id` in the header.

Do the work, then call **`bridge_reply`** with that session_id. The tool schema describes all
available fields and which status requires which fields. Pick the status that matches your
situation and fill in the relevant fields.
