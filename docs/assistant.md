# Assistant

The owner's assistant is a long-running Claude Code session on Sakura using Opus. The Gateway feeds
it events. The session decides what to say and do.

## The session

- **One session:** resumed at the `host` spawn point and never recreated. Its working directory is
  `~/projects/notes`. The 30-day and capacity sweeps skip it.
- **Opus only:** no model levels.
- **One thread:** the owner talks to it through an ordinary conversation thread.
- **Its own tools:** the plugin registers them only in the assistant session. The Gateway serves
  their routes only to that session's token.
- **Timed compaction:** runs at its due time only while the REPL is idle and no card is open.

## Notes

`~/projects/notes/` is durable memory under git and the session's working directory.

- `AGENTS.md` holds the standing rules and names the note files.
- The note files hold fixed sections for open threads, pending asks, decisions and commitments. The
  assistant updates them as it works, so their contents survive compaction.
- `watchers/*.yaml` holds the rules that sort events. The owner edits them; the assistant cannot.

## The gate

Gated on reversibility.

- **Undoable:** runs at once and reports with an Undo.
- **One-way:** public, leaves Sakura, or costs money. Asks first, on a card rendered from the real
  params. A tap or a spoken "sure" approves only the card showing at that moment. One ask can cover a
  plan.
- **Always gated:** writes to `AGENTS.md`, session settings or hooks, the rules, and paths outside
  notes.

**The hook:** host sessions launch with `--dangerously-skip-permissions`, so the boundary is a
PreToolUse hook, not the prompt. It ships in the Switchboard plugin, outside the session's write
access, and applies to the session its spawn marks as the assistant and to any session working
inside notes. It is a closed allowlist:

- **Allowed:** reads, replies on its own conversation, and the assistant's own tools.
- **Writes:** `Write`, `Edit` and `NotebookEdit` inside notes, judged by the resolved path, never to
  `AGENTS.md`, `.claude/`, `.git/` or `watchers/`.
- **Refused:** every other tool, including `Bash`, shell runs through `vault_run`, delegation to
  sub-agents, Codex or Copilot, and other MCP servers' tools.

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
- **Secrets come from the vault:** a watcher's rule file names its entry, and only the owner's grant
  opens it. The watcher is the grant holder, and the Gateway reads the value through the same grant
  check a session's use passes. A Gmail watcher needs its own OAuth token in the vault, since a
  watcher cannot use Claude's connectors.

### GitHub notifications

- Polls `/notifications` with `If-Modified-Since`. A 304 spends no rate limit.
- Holds `X-Poll-Interval` as its floor, 60 seconds when absent, and backs off on a rate-limit answer.
- Read-only. Marking a thread read is an action.
- Reads a classic token from its vault entry. The notification endpoints take no fine-grained token.

### Rules

`watchers/*.yaml` lives in notes. Compose mounts the directory read-only into the Gateway container,
configured per host.

- **Each event is sorted:** wake, hold, drop, or run a `read` or `private` action.
- **A schema validates each file.** A reload is all-or-nothing: a bad file keeps the last valid set,
  and its error rides in the reminder lines.
- **Ping:** each watcher and action declares a default, and a rule can override it. A feed defaults
  to no ping.
- **A rule-dropped event is kept 7 days.** Each reload sorts the kept drops again under the new set
  and delivers any that now wake or hold.

### Limits

An inbox cap and a retention window. Overflow evicts the oldest held items for good, and the count
rides in the reminder lines.

## Delivery

- **Wake:** goes through the send route's wake path, so an offline session is woken. A failed wake
  leaves the event held.
- **Held:** one queue, drained through one door, `flush(watchers)`. It answers a batch and moves the
  read position only once the caller confirms the batch arrived; an unconfirmed batch is answered
  again. The `held` tool calls it when the owner asks, a routine calls it with its `delivers` list,
  and a wake rule calls it too. Each watcher keeps one read position, so a 10am routine skips what a
  9am ask already saw.

## What the model reads

- **Standing instructions appear once:** in the system prompt and `AGENTS.md`.
- **Per-message state:** `system-reminder` data lines carry held counts, watcher health and a rules
  error.
- **An event is a message body** with no `meta.instructions`. Its ping is a data line, and `AGENTS.md`
  says to notify the owner only when that line says yes.
- **After a compaction:** the SessionStart `compact` hook re-sends held counts, watcher health, read
  positions and open cards, beside the session's conversations, routine runs, agents and board
  entries. The assistant's lines come before the board, the part a full baseline cuts.
