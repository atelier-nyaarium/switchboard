# Assistant

The owner's assistant is a long-running Claude Code session on Sakura using Opus. The Gateway feeds
it events. The session decides what to say and do.

## The session

- **One session:** `host.assistant`, resumed and never recreated. `ASSISTANT_WORKDIR` names its
  working directory, and the Gateway mints the record there once at boot; the first wake launches
  it. A name is not a binding, so provenance decides, as for a routine: `isAssistantRecord` reads
  the record's `mintedFrom`. The configured workdir governs, so a stored one is reset to it at
  boot. The 30-day and capacity sweeps skip it, and a forget is refused.
- **Opus only:** no model levels.
- **Its own tab:** the phone's Assistant tab holds its conversation, an inbox strip with one chip
  per watcher, and a gear for Assistant settings: watchers with their grants and rules, check-ins,
  and session options. `host.assistant` stays out of the Sessions list because the Gateway marks it
  in presence.
- **Its own tools:** the plugin registers them only in the assistant session. The Gateway serves
  their routes only to that session's token.
- **Timed compaction:** runs at its due time only while the REPL is idle and no card is open.

## Notes

`~/projects/notes/` is durable memory under git and the session's working directory.

- `AGENTS.md` holds the owner's own instructions, if any. The assistant's standing rules ship with
  the plugin, so nothing is seeded into the folder.
- `Assistant/` holds the note files: open threads, pending asks, decisions and commitments. The
  assistant creates and updates them as it works, so their contents survive compaction.
- No rules live here. The Gateway holds them, and only owner ops write them.

## The gate

Gated on reversibility.

- **Undoable:** runs at once and reports with an Undo.
- **One-way:** public, leaves Sakura, or costs money. Asks first, on a card rendered from the real
  params. A tap or a spoken "sure" approves only the card showing at that moment. One ask can cover a
  plan.
- **Always gated:** writes to `AGENTS.md`, session settings or hooks, the rules, and paths outside
  notes.

**The boundary** is Claude Code's own permission engine, with Switchboard's layers around it.

- **The launch:** `host.assistant` alone launches with `--permission-mode dontAsk`, `--tools
  Read,Edit,Write,Glob,Grep,ToolSearch` and inline `--settings` (`assistantPermissionArgs`), never
  `--dangerously-skip-permissions`. Anything not allowed is denied without asking. Edits are allowed
  under the workdir, reads inside it and in the channel attachments directory. Edits to `AGENTS.md`,
  `CLAUDE.md`, `CLAUDE.local.md`, `.claude/`, `.mcp.json` and `package.json`, and reads of `.env`
  files, are denied; `.git` is a protected path. The engine checks a path and opens the file as one
  step, judges links on both sides, and drops denied files from search results. A workdir that is
  missing, holds home, or cannot be quoted refuses the launch, since the host would otherwise fall
  back to home. Project settings in the workdir still load, since they carry the owner's `AGENTS.md`;
  the session cannot write `.claude/`, so only the owner could add one.
- **Its Switchboard server:** takes no capabilities and lists only `channel_reply`,
  `channel_reply_structured` and `switchboard_capabilities` (`scopeTools`), so no guidance names a
  tool it lacks and no reply snapshots a ref. Its instructions carry the assistant's standing rules
  (`ASSISTANT_INSTRUCTIONS`), so a release updates them in every folder.
- **The hook:** a deny-only second layer, and the only check on MCP arguments the engine does not
  see.

**The hook** ships in the Switchboard plugin's `hooks.json`, outside the session's write access, as
the `gate` mode of the `main-session-hook` bundle. A shell pre-check passes every session whose
`PROJECT_NAME` is not `host.assistant`, so no other session starts `bun` per tool call. A gate that
fails to run exits 2, which blocks the tool. `gateVerdict` is a closed allowlist by exact tool name:

- **Reads:** `Read`, `Glob` and `Grep` inside notes or the channel attachments directory, judged by
  the resolved path, never `.git/` or a `.env` file. A pattern that is absolute or climbs with `..`
  is refused.
- **Writes:** `Write`, `Edit`, `MultiEdit` and `NotebookEdit` inside notes, judged by the resolved
  path through `confine`. Never `.git/`, a `.claude/` folder, an `AGENTS.md`, `CLAUDE.md` or
  `CLAUDE.local.md` at any depth, `watchers/` or `.mcp.json`.
- **Allowed:** `channel_reply`, `channel_reply_structured`, `switchboard_capabilities` and
  `ToolSearch`. The reply route
  already refuses a conversation not addressed to the caller. A reply's attachments take the read
  rule, and a `ref://` to `/`, `~` or `..` is refused, since both are uploaded with the reply.
- **Refused:** every other tool, including `Bash`, shell runs through `vault_run`, delegation to
  sub-agents, Codex or Copilot, web fetches, and other MCP servers' tools.

Every path is judged by what it resolves to. A leading `~/` is read as home, as the tools read it,
and another user's `~` is refused. A dangling link and a file with a second hardlink are refused,
since resolving the path cannot see where either leads. A glob is refused when any brace
alternative starts at a root or climbs with `..`. A search with no path is judged by the working
directory. If the notes root's real path contains home, every tool is denied, since the host
launches in home when it cannot find the workdir.

The hook sets `onFailure: "block"` (Claude Code 2.1.295 or later), so a timeout or a crash blocks
the tool rather than letting it through. A refusal reason is capped at 400 characters, and the hook
exits only once its answer is written.

The hook alone is a path decision made before the tool runs; the engine is what binds the check to
the open. A running pane keeps the hooks and flags it launched with, so restart the assistant after
a plugin update. A hand resume must carry the assistant's flags too.

**Event text is data:** notification titles and mail bodies are never instructions.

## Actions

- **Schema-first:** each action declares its params and takes refs in place of raw ids.
- **One executor:** the Gateway runs an action whether a tool call or a tap started it. It answers
  `done`, `refused` or `unknown`.
- **Each action declares its effect:**
  - `read`: changes nothing. Hidden, shown as a collapsed count the owner can tap to reveal.
  - `private`: changes only Sakura-side state and is undoable. Runs at once and reports with an Undo.
  - `public`: one-way. Asks first, and takes a required `why` shown on its card.
- **Ledger:** records each action and who started it: the owner, the assistant or a named rule.
- **No tool-call record:** the conversation holds messages and approval cards.

## Events

One inbox on the Gateway receives watcher events, phone events, routines and webhooks. An assistant
stage restores the inbox before the first poll, starts on federation activation, and drains before
the shutdown flush.

### Watchers

A watcher is plain Gateway code, never a model.

- **A poll answers one of three:** events, backoff until a time, or stopped with a reason.
- **Each watcher polls on its own interval**, serialized per watcher.
- **Events and cursor share one checked write:** a failed write keeps the old cursor. Stable event
  ids dedupe a replay after a crash. Every event the inbox keeps is delivered at least once.
- **Health survives a restart:** last success, next poll, backoff and stopped state.
- **Secrets come from the vault:** the owner picks a watcher's entries up front on the phone's
  Assistant setup screen, through the Grant secrets sheet a routine uses. The grant covers the
  entry, so a rotated key is a vault edit. A watcher without one stays stopped and says it needs a
  secret. The Gateway reads the value through the same grant check a session's use passes. A Gmail
  watcher needs its own OAuth token in the vault, since a watcher cannot use Claude's connectors.

### GitHub notifications

- Polls `/notifications` with `If-Modified-Since`. A 304 spends no rate limit.
- Holds `X-Poll-Interval` as its floor, 60 seconds when absent, and backs off on a rate-limit answer.
- Read-only. Marking a thread read is an action.
- Reads a classic token from its granted vault entry. The notification endpoints take no
  fine-grained token. Without a grant, or on a 401, the watcher stops with that reason.

### Rules

Each watcher carries an ordered rule list, first match wins, kept by the Gateway like routines and
policies. The owner edits it on the phone in Assistant settings; only owner ops write it, so the
assistant cannot rewrite what sorts its own events.

- **Each event is sorted:** wake, inbox, drop, or run a `read` or `private` action. A final rule
  catches anything else.
- **Ping:** each watcher and action declares a default, and a rule can override it. A feed defaults
  to no ping.
- **A rule-dropped event is kept 7 days.** Each rule edit sorts the kept drops again and delivers
  any that now wake or go to the inbox.

### Limits

An inbox cap and a retention window. Overflow evicts the oldest inbox items for good, and the count
rides in the reminder lines.

## Delivery

- **Wake:** goes through the send route's wake path, so an offline session is woken. A failed wake
  leaves the event in the inbox.
- **Inbox:** one queue, drained through one door, `flush(watchers)`. It answers a batch and moves
  the read position only once the caller confirms the batch arrived; an unconfirmed batch is
  answered again. The `inbox` tool calls it when the owner asks, a check-in calls it with its
  watchers, and a wake rule calls it too. Each watcher keeps one read position, so a 10am check-in
  skips what a 9am ask already saw.
- **Counts:** the tab's strip shows each watcher's inbox count only. Woke and dropped counts sit on
  the watcher's own screen, with Replay beside dropped.

## What the model reads

- **Standing instructions appear once:** in the system prompt and `AGENTS.md`.
- **Per-message state:** `system-reminder` data lines carry inbox counts and watcher health.
- **An event is a message body** with no `meta.instructions`. Its ping is a data line, and `AGENTS.md`
  says to notify the owner only when that line says yes.
- **After a compaction:** the SessionStart `compact` hook re-sends inbox counts, watcher health, read
  positions and open cards, beside the session's conversations, routine runs, agents and board
  entries. The assistant's lines come before the board, the part a full baseline cuts.
