---
name: crosstalk
description: Cross-team communication for agent teams in different Devcontainers. Use when you need help from another team via the bridge, such as analysis, debugging, or bugfixing.
---

# Agent Team Bridge

You have access to cross-team communication tools via the `agent-team-bridge` MCP server.
Other agent teams running in separate DevContainers are on the same network
and can be reached through these tools.

---

## Sending a Request

### Tools

- **`agent-team-bridge:crosstalk_discover()`** - List all teams on the bridge (online and available). Available teams can be woken on demand by sending them a request. Always check before sending.
- **`agent-team-bridge:crosstalk_send()`** - Send a request to another team and wait for their response. Blocks until they respond.
- **`agent-team-bridge:crosstalk_wait()`** - Wait N seconds before retrying a deferred request.

> **Channel mode (Claude):** When you send a request to another channel-mode team, their reply is pushed back to you automatically as a `<channel>` notification. You will receive it without polling.

### How Threading Works

Each first response from the other team includes a `session_id`. This is the agent session
ID on their side. To continue the conversation (answer a clarification, follow up on a
deferred request), pass that same `session_id` back in your next `agent-team-bridge:crosstalk_send()`. Omit it to
start a fresh conversation thread.

```
# First message - no session_id
agent-team-bridge:crosstalk_send(to="cool-lib", type="question", body="...")
→ response includes session_id: "bfa069ad-..."

# Follow-up - pass session_id to continue the same thread
agent-team-bridge:crosstalk_send(to="cool-lib", session_id="bfa069ad-...", body="...")
```

Do not reuse a `session_id` across unrelated conversations. Each distinct task should be
its own thread.

### Response Statuses

**Successful:**

- **completed** - Work done. Check `response`.
- **clarification** - They need more info. Answer via a follow-up `agent-team-bridge:crosstalk_send()` with the same `session_id`.
- **deferred** - They're busy, or still working on it. Use `agent-team-bridge:crosstalk_wait()`, then retry.
- **running** - The team is still processing. Poll with `session_id` to check later.

**Problems - propagate these back to your human:**

- **needs_human** - They need a human decision on their end.
- **error** - Something went wrong. The `reason` field has details.
- **timeout** - No response in time. The other team may be down or overloaded.

### Timeout Note

Cross-team requests can take many tens of minutes. The other agent may need to implement
a feature, run tests, build, commit, PR, and merge. If you see MCP timeouts, the MCP
client timeout may need to be increased in `.mcp.json` or the client's settings.

---

## Receiving a Request

How you receive requests depends on which agent is running:

### Claude (channel mode)

Requests arrive as `<channel source="bridge">` tags in your session with attributes
like `session_id`, `from`, `request_type`, and `effort`. Do the work, then call
**`agent-team-bridge:channel_reply()`** with that `session_id`.

### CLI agents (cursor, copilot, codex)

Requests are injected into your session as a prompt containing a `session_id` in the header.
Do the work, then call **`agent-team-bridge:crosstalk_reply()`** with that `session_id`.

### Reply statuses

The tool schema describes all available fields and which status requires which fields.
Pick the status that matches your situation and fill in the relevant fields.
