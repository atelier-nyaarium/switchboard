# Assistant

The owner's assistant is a long-running Claude Code session on Sakura using Opus. The Gateway feeds
it events. The session decides what to say and do.

## The session

- **One session:** `host.assistant`, resumed while it lives on a Gateway. A name is not a binding,
  so provenance decides, as for a routine: `isAssistantRecord` reads the record's `mintedFrom`. The
  30-day and capacity sweeps skip it, and a plain forget is refused. A release ends it, and placing
  it again starts a fresh conversation. Its notes folder keeps its files; a move does not copy them.
- **Where it lives is its record:** the owner picks a Gateway and a folder on that Gateway's host in
  Assistant settings. `assistant_place` mints the record there, or moves a held one's folder, which
  a running session takes at its next launch; the first wake launches it. The record is the commit:
  place saves it before answering, and takes its change back when the save fails. A new placement
  starts with no watcher grants. `assistant_release` ends the pane and forgets the record first, so
  a refused forget changes nothing. Past it, the release saves, stops the watchers and drops their
  grants there whatever the save says; an unsaved release or a grant left behind is named in the
  answer, and releasing again finishes it. The stage runs these ops one at a time and starts none
  after shutdown. A move reads every Gateway, places, then releases
  every other home (`AssistantOps.move`), so a refused place leaves the old home untouched. The
  phone names any Gateway that did not release.
- **Opus only:** no model levels.
- **Its own tab:** the phone's Assistant view shows where it lives, an inbox strip with one chip per
  watcher, the door to its conversation, and a gear for Assistant settings: where it lives, each
  watcher's health and grants, and Release. The conversation opens in the usual thread screen.
  `host.assistant` stays out of the Sessions list because the Gateway marks its presence row with
  `role: "assistant"`, never because the phone matches a name.
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
- **Always gated:** writes to `AGENTS.md`, session settings or hooks, and paths outside notes. The
  watcher rules have no path from the session at all.

**The boundary** is Claude Code's own permission engine, with Switchboard's layers around it.

- **The launch:** `host.assistant` alone launches with `--permission-mode dontAsk`, `--tools
  Read,Edit,Write,Glob,Grep,ToolSearch` and inline `--settings` (`assistantPermissionArgs`), never
  `--dangerously-skip-permissions`. Anything not allowed is denied without asking. Edits are allowed
  under the workdir, reads inside it and in the channel attachments directory. Edits to `AGENTS.md`,
  `CLAUDE.md`, `CLAUDE.local.md`, `.claude/`, `.mcp.json` and `package.json`, and reads of `.env`
  files, are denied; `.git` is a protected path. The engine checks a path and opens the file as one
  step, judges links on both sides, and drops denied files from search results. The launch refuses
  a workdir that is missing, holds home, is reached through a link, or cannot be quoted. A missing
  one makes the host fall back to home, and a link's spelling is not the place it leads. Project settings in the workdir still load, since they carry the owner's `AGENTS.md`;
  the session cannot write `.claude/`, so only the owner could add one.
- **Its Switchboard server:** takes no capabilities and lists only `channel_reply`,
  `channel_reply_structured`, `switchboard_capabilities`, `notify_human` and `inbox`
  (`ASSISTANT_SWITCHBOARD_TOOLS`, through `scopeTools`), so no guidance names a tool it lacks and no
  reply snapshots a ref. Its instructions carry the assistant's standing rules
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
  `CLAUDE.local.md` at any depth, or `.mcp.json`.
- **Allowed:** `channel_reply`, `channel_reply_structured`, `switchboard_capabilities`,
  `notify_human`, `inbox` and `ToolSearch`. The reply route already refuses a conversation not
  addressed to the caller. The attachments of `channel_reply` and `notify_human` take the read rule,
  and a `ref://` to `/`, `~` or `..` in either is refused, since both are uploaded with the message.
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
stage restores the inbox before the first poll, polls only while the assistant lives on this
Gateway and federation is active, and drains before the shutdown flush.

### Watchers

A watcher is plain Gateway code, never a model.

- **A poll answers one of three:** events, backoff until a time, or stopped with a reason.
- **Each watcher polls on its own interval**, serialized per watcher.
- **Events and cursor share one checked write:** a failed write keeps the old cursor. Stable event
  ids dedupe a replay after a crash. Every event the inbox keeps is delivered at least once.
- **Health survives a restart:** last success, next poll, backoff and stopped state.
- **Secrets come from the vault:** the owner picks a watcher's one entry in Assistant settings,
  through the Grant secrets sheet a routine uses, and `assistant_watcher_grants` makes it the
  watcher's standing grant. The grant covers the entry, so a rotated key is a vault edit. A watcher
  without one stops and says it needs a secret. Setting the grant, or Retry, which sets the same
  one again, polls it now, or once a poll in flight lands. The Gateway reads the value each poll through `readForWatcher`, which
  checks the grant after the vault refresh and takes the same release a session's use does. A
  missing or refused grant stops the watcher, and an unreachable vault backs it off. A Gmail
  watcher needs its own OAuth token in the vault, since a watcher cannot use Claude's connectors.

### GitHub notifications

- Keeps `Last-Modified` as its cursor, and sends it as `If-Modified-Since` on the first page of the
  next poll. A 304 spends no rate limit. The first poll takes the 500 most recent unread.
- Follows `Link: rel="next"` up to 500 events, and only to `api.github.com`, so the token never
  follows a link elsewhere.
- Holds `X-Poll-Interval` as its floor, 60 seconds when absent. A rate limit, by `retry-after` or a
  spent `x-ratelimit-remaining`, backs off until it resets. A secondary limit that names no wait
  backs off five minutes.
- **One event per thread update:** the source id is the thread id with its `updated_at`, so a thread
  updated again comes back rather than reading as a replay.
- Read-only. Marking a thread read is an action.
- Reads a classic token from its granted vault entry. The notification endpoints take no
  fine-grained token. Without a grant, on a 401, on a 404 (GitHub hides what a token may not see),
  or on a 403 that is not a rate limit, the watcher stops with that reason. `createGithubWatcher` in `src/gateway/assistant/githubWatcher.ts`.

### Rules

Each watcher carries an ordered rule list, first match wins, kept by the Gateway like routines and
policies. The owner edits it on the phone in Assistant settings; only owner ops write it, so the
assistant cannot rewrite what sorts its own events.

- **A rule:** a phone-minted id, one to 8 conditions, all of which must hold, and an action:
  `wake`, `inbox` or `drop`. A condition is a field the watcher declares, a test (`is`, `is_not`,
  `contains`, case ignored) and a value. At most 50 rules (`ASSISTANT_RULES_MAX` in
  `wire-vocabulary.ts`); `otherwise` takes anything none matched. `schemasAssistantRules.ts` holds
  the record, `ruleRefusal`, and `firstMatch`, the one reading of which rule decides an event,
  which `decideEvent` and the preview both take.
- **Ping:** each watcher declares a default (GitHub: off). A rule or `otherwise` may override it;
  one left at the default follows the default. A drop never pings.
- **The store:** `createRulesStore`, sole writer of `assistant-rules.json`, on the policy store's
  model. Each rule and `otherwise` carry their own revision, which the store names; the list's
  revision moves with every write and is what a sort names. A put carries the revision it read, 0
  for a new rule. A stale one is refused; the same content at the held revision or the one before it
  answers as stored without a write, since its first answer was lost. A deleted id stays buried in
  memory, up to 256, so a retried create cannot bring it back within one Gateway run; a delete of an id already gone answers done. A move places a
  rule before another by id over the list revision drawn; a repeat finds it in place, and a stale
  one is refused. A file naming one id twice starts fresh.
- **Ops:** `assistant_rule_put`, `assistant_rule_delete`, `assistant_rule_move` and
  `assistant_otherwise_put`, each answering `ConsoleAssistantRulesResult`: stored or not, with the
  held rules either way, so the phone decides from the answer and the fenced read after it only
  draws. `assistant_rules_preview` tests a rule at its place by id (else last) against the
  watcher's last 50 events, counting what it decides apart from what an earlier rule takes, and
  refuses what a put refuses. The rules, the fields and the drop count ride in `assistant_state`.
- **Per Gateway:** rules and the inbox stay with the Gateway that holds them. A move starts the new
  home on its own rules, and moving back finds the old ones.
- **Sorted as it lands:** a poll's events are sorted in the same checked write that keeps them. Each
  row stores its decision (action, ping, rules revision) apart from its disposition, so a wake is
  driven from the row and never re-derived.
- **Drops replay:** a rule-dropped event is kept 7 days, at most 1,000 per watcher. A rule save sorts
  the kept drops again; one that now wakes or goes to the inbox takes a fresh sequence. An evicted
  event, or one past its 7 days, is never sorted again. The inbox keeps the rules revision it last
  sorted under, in the same write. An inbox at any other revision sorts again at start and in the
  next poll's write, so a replay that did not land is retried, and a rules file that started fresh
  sorts the drops under the defaults. A rescued event can be one already handled at its source.

### Limits

Each watcher keeps at most 500 unread inbox items (`INBOX_CAP`); overflow evicts the oldest by
sequence, for good. Inbox and woken items are kept 14 days and rule drops 7 days. A source id is
remembered 30 days, longer than any row, so a replay cannot bring one back. An unread item lost to
the cap or to age is counted in the watcher's `evicted`, and the count rides in the reminder lines.
Every read and every write starts from the inbox trimmed as of now, so a read never shows a row
the next write would drop, and an unread row is counted in `evicted` the moment it leaves `unread`.

A poll answers at most 500 events of at most 32 fields. One that throws, hangs past 60 seconds or
answers malformed data backs off for 60 seconds, and its abort signal fires. A watcher's poll must
settle once its signal aborts. A hook failure after a poll lands never disarms the watcher.
Shutdown waits up to 5 seconds, then aborts what is left and writes nothing those polls answer.
Stop is final. `src/gateway/assistant/` holds the watcher type (`Watcher`), the inbox store
(`createInboxStore`) and the runner (`createWatcherRunner`).

## Delivery

- **Wake:** a wake-sorted event waits in the inbox as unread. The Gateway hands it to `deliverEvent`
  in `routesSend.ts`, which shares `reach` (target resolution and `tryWakeTeam`) and the
  `ChannelDeliveryCoordinator` with an ordinary send but names no sender. One push carries up to 20
  waiting wake events, oldest first. `deliverEvent` composes the batch only once the session is
  reached, just before the queue takes it, so a row the assistant read while the wake waited is not
  sent, and `markWoken` leaves a row already read as read.
  Its delivery id is derived from the rows it carries, so a retry of the same batch is the same
  delivery. Once it is delivered or durably queued, one checked write moves those rows to `woken`. A
  failed wake leaves them in the inbox and retries on its own backoff, 30 seconds doubling to 15
  minutes, as well as on the next poll, rules change, placement or start. A channel acknowledgment
  never moves a read position, and retires only a row held for the acknowledging session.
  Delivery is at least once: a crash between the push and the `woken` write sends the batch again.
  `createWakeRunner` (`src/gateway/assistant/wakeRunner.ts`) runs one round at a time, and a nudge
  during a round runs another. The queued row is an `EventDelivery`, which holds no sender or reply
  route; the queue refuses an id a message already holds.
- **Inbox:** `flush` answers the unread rows, oldest first, with the highest sequence read per
  watcher, and moves nothing. `confirm` moves each read position up to its boundary in a checked
  write, never down and never past a sequence not yet handed out. An unconfirmed batch is answered
  again. Both read the inbox trimmed as of now, so a row that expired is counted lost before the
  position passes it. Inbox calls run one at a time, and each watcher keeps one read position.
- **Who reads it:** the `inbox` tool is registered only for `host.assistant`. It flushes, then
  confirms once it holds the answer. The Gateway doors in `assistantRoutes.ts` answer only a token
  bound to the assistant's own record, and answer `not_assistant` or `unauthenticated` otherwise.
- **Counts:** the tab's strip shows each watcher's inbox count only. The dropped count sits on the
  watcher's Rules sheet; a rule save replays drops. `assistant_state` carries the woken count.

## What the model reads

- **Standing instructions appear once:** in the plugin's MCP instructions for `host.assistant`
  (`src/mcp/assistant/instructions.ts`). The folder's `AGENTS.md` holds the owner's own instructions.
- **Events:** a channel message with `event="true"` and no sender, `session_id` or
  `meta.instructions`. `CHANNEL_INSTRUCTIONS` says it is data and owes no `channel_reply`. Its body
  is each event's data lines (`eventLines`), every value collapsed to one line by `oneLine` so a
  title cannot forge a `ping:` or `watcher:` line, then neutralized like any message body. Its ping is a data
  line, and the instructions say to tell the owner through `notify_human` only when it says yes.
- **After a compaction:** the SessionStart `compact` hook adds one line per watcher, with its inbox
  count, stopped or waiting reason, and unread lost, beside the session's conversations, routine
  runs, agents and board entries. The watcher lines come before the board, the part a full baseline
  cuts.
