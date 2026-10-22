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
- **Its own tab:** the phone's Assistant view shows where it lives, a strip with one chip per watcher
  showing GitHub's unread count, the door to its conversation, and a gear for Assistant settings:
  where it lives, each watcher's health, grants and actions, and Release. The conversation opens in the usual thread screen.
  `host.assistant` stays out of the Sessions list because the Gateway marks its presence row with
  `role: "assistant"`, never because the phone matches a name.
- **Its own tools:** the plugin registers them only in the assistant session. The Gateway serves
  their routes only to that session's token.
- **Timed compaction:** runs at its due time only while the REPL is idle.

## Notes

`~/projects/notes/` is durable memory under git and the session's working directory.

- `AGENTS.md` holds the owner's own instructions, if any. The assistant's standing rules ship with
  the plugin, so nothing is seeded into the folder.
- `Assistant/` holds the note files: open threads, pending asks, decisions and commitments. The
  assistant creates and updates them as it works, so their contents survive compaction.
- No rules live here. The Gateway holds them, and only owner ops write them.

## The gate

- **Watcher actions run at once:** setting up a watcher is the owner's permission to use its
  actions, so none asks first. Every one is recorded in the conversation.
- **Always refused:** writes to `AGENTS.md`, session settings or hooks, and paths outside notes. The
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
  `channel_reply_structured`, `switchboard_capabilities`, `notify_human`, `inbox` and each declared
  watcher action (`ASSISTANT_SWITCHBOARD_TOOLS`, through `scopeTools`), so no guidance names a tool
  it lacks and no reply snapshots a ref. Its instructions carry the assistant's standing rules
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
  `notify_human`, `inbox`, each declared watcher action and `ToolSearch`. The reply route already refuses a conversation not
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

A watcher declares what the assistant may do with its source. Setting the watcher up is the
permission, so an action runs at once.

- **One shared registry:** `ASSISTANT_ACTIONS` in `src/shared/schemasAssistantActions.ts` holds, per
  action, a key that is its MCP tool name, the watcher it belongs to, a label and a one-line
  description for the owner, its usage text for the model, and Zod schemas for its params and its
  answer. Every action takes an optional `summary`. It holds data and schemas only, so the plugin
  imports no Gateway code, and `assistant_state` carries each watcher's descriptors (`actionsOf`).
- **One class per action on the Gateway:** `WatcherAction<K>` (`watcherAction.ts`), with its `key`,
  its `declaration` and a typed `run(params, ctx)`. The instances sit in a map typed by the
  registry's keys, so a declared action with no class does not compile.
- **One route:** `/assistant/action` takes `{ action, callId, params }`, answers only the assistant's
  own token, parses the params with that action's schema, and runs it (`actionDispatch.ts`).
- **The lane owns every deadline:** each item enters through one road with a deadline that counts
  the queue. One not started by then answers `not_started` and later runs nothing. A `read` (a
  listing, a preview) frees the lane at its deadline and commits nothing that lands after it; a
  `write` (an action) holds the lane until it settles, and its signal ends at the deadline with a
  typed reason (`laneEnd`) the action reads. Stop ends queued and running work at once.
- **An action's deadline is 60 seconds:** one its lane has not started by then is refused with
  nothing sent. No request starts past it, and one in flight is cut there or at 15 seconds. An id
  never sent answers `not_attempted`; a `DELETE` cut before its answer answers `uncertain`. The
  caller-facing waits live in one table (`ASSISTANT_WAITS`, `waits.ts`), and a test pins their
  order: the request inside the action, the preview inside the phone's answer wait, and every route
  inside the Gateway's Bun server, which holds a request up to 255 seconds (`serveLimits.ts`).
- **`rate_limited` means GitHub answered with a rate limit:** an id the shared limit held back was not
  sent, so it answers `not_attempted`, and the note names the wait.
- **A call id makes a retry safe:** the tool mints one per call and repeats it on a retried post. The
  Gateway joins a repeated id to the first call's answer through `createOpDedupe`, holding a settled
  answer ten minutes, so neither the requests nor the record repeat, and keys the record row by it.
- **One GitHub client:** `githubClient.ts` owns the token read, the headers, the refusals and the
  shared rate limit, so polls, listings and actions cannot disagree.
- **The tools follow the registry:** `ASSISTANT_SWITCHBOARD_TOOLS` is derived from its keys, so the
  MCP scope, the gate and the launch permissions list the same tools.
- **`github_done({ ids, summary? })`:** up to 50 unique digit-string thread ids, and an optional
  summary of up to 300 characters. Per id it reads the thread for its title and link, marks it done
  (`DELETE`, 204), then read (`PATCH`, 205, which a done thread also takes). Unread is the inbox,
  since GitHub keeps listing a done thread under `all=true`, and done comes first so a thread leaves
  the inbox only once GitHub confirmed it done; `not_attempted` then always means nothing changed.
  Each id answers one shared outcome: `done`, `not_found`, `rate_limited`, `uncertain` or
  `not_attempted`. A rate limit stops the batch, and the ids after it answer `not_attempted`; so does
  a refused token. A done thread whose mark-read failed answers `done` with a note that it stays in
  `inbox` until sent again. A repeated `DELETE` answers 204 again.
- **The record:** an action that reached the source is recorded in the assistant's conversation
  (Delivery). One where every id answered `not_attempted` posts nothing.

## Events

The source is the only copy. The Gateway stores nothing about a GitHub thread: per watcher it keeps
its poll validator, the newest update time seen, the agent's fetch mark, GitHub's unread count and
health. An assistant stage polls only while the assistant lives on this Gateway and federation is
active, and stops before the shutdown flush.

### Watchers

A watcher is plain Gateway code, never a model.

- **A watcher names itself:** `Watcher.label` is what a wake, a listing, the phone and the
  baseline show, and the source lanes refuse a blank one, so no watcher appears by its id.
- **One source lane per watcher:** it runs the watcher's source calls one at a time: polls, the live listing and
  actions. A poll that read a thread cannot wake it after a `done` landed.
- **A poll answers one of four:** the unread list with its next validator, unchanged, backoff until a
  time, or stopped with a reason.
- **Health survives a restart:** last success, next poll, backoff and stopped state.
- **Secrets come from the vault:** the owner picks a watcher's one entry in Assistant settings,
  through the Grant secrets sheet a routine uses, and `assistant_watcher_grants` makes it the
  watcher's standing grant. Each watcher declares the secret it needs (`Watcher.secret`, GitHub's a
  classic token with the notifications scope), shown on its row and in the picker. The grant covers
  the entry, so a rotated key is a vault edit. A watcher
  without one stops and says it needs a secret. Setting the grant, or Retry, which sets the same
  one again, polls it now, or once a poll in flight lands. The Gateway reads the value each poll through `readForWatcher`, which
  checks the grant after the vault refresh and takes the same release a session's use does. A
  missing or refused grant stops the watcher, and an unreachable vault backs it off. A Gmail
  watcher needs its own OAuth token in the vault, since a watcher cannot use Claude's connectors.

### GitHub notifications

- **The poll:** it reads the unread list, sending the stored `Last-Modified` as `If-Modified-Since`. A
  304 spends no rate limit and keeps the last unread count. It follows `Link: rel="next"` up to 500
  threads, and only to `api.github.com`, so the token never follows a link elsewhere; past 500 the
  count reads "500+".
- **New:** a thread updated after the newest time seen. The first poll after placement sets that
  time without waking, so the backlog is listed rather than woken. New activity on a thread already
  woken for passes the mark and wakes again. A thread arriving later at exactly the newest time seen
  does not wake.
- Holds `X-Poll-Interval` as its floor, 60 seconds when absent. A rate limit, by `retry-after` or a
  spent `x-ratelimit-remaining`, backs off until it resets. A secondary limit that names no wait
  backs off five minutes.
- **The validator belongs to its grant:** the cursor names the granted entry, so a new grant reads in
  full rather than sending another account's `Last-Modified`. A thread a shifted page repeats is kept
  once.
- **No error carries the token:** a value that is not visible ASCII stops the watcher before any
  request. A rate limit holds for polls and the rules preview alike.
- Its one action is `github_done`.
- Reads a classic token from its granted vault entry. The notification endpoints take no
  fine-grained token. Without a grant, on a 401, on a 404 (GitHub hides what a token may not see),
  or on a 403 that is not a rate limit, the watcher stops with that reason. `createGithubWatcher` in
  `src/gateway/assistant/githubWatcher.ts`, over the shared client.

### Rules

Each watcher carries an ordered rule list, first match wins, kept by the Gateway like routines and
policies. The owner edits it on the phone in Assistant settings; only owner ops write it, so the
assistant cannot rewrite what sorts its own events.

- **A rule:** a phone-minted id, one to 8 conditions, all of which must hold, and an action: `wake`
  or `inbox`. A condition is a field the watcher declares, a test (`is`, `is_not`, `contains`, case
  ignored) and a value. At most 50 rules (`ASSISTANT_RULES_MAX` in `wire-vocabulary.ts`);
  `otherwise` takes anything none matched. `schemasAssistantRules.ts` holds the record,
  `ruleRefusal`, and `firstMatch`, the one reading of which rule decides a thread, which
  `decideEvent`, the listing and the preview all take.
- **No drop, no ping:** GitHub threads are cleared at GitHub through `github_done`, and the agent
  alone decides what is worth telling the owner. The rules file is read through a decoder that
  runs before the schema parse: it removes `drop` rules, maps an `otherwise` of `drop` to `inbox`
  and strips `ping`, keeping the rest's order and revisions.
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
  draws. `assistant_rules_preview` tests a rule at its place by id (else last) against the live
  first page of the watcher's `all` listing, counting what it decides apart from what an earlier
  rule takes, and refuses what a put refuses. The rules and the fields ride in `assistant_state`.
- **Per Gateway:** rules stay with the Gateway that holds them. A move starts the new home on its
  own rules, and moving back finds the old ones.
- **Applied as read:** a poll sorts its new threads as they arrive, and the listing applies the
  rules as it lists, so a rule edit takes effect on the next read.

### Limits

A poll reads at most 500 threads of at most 32 fields. One that throws, hangs past 60 seconds or
answers malformed data backs off for 60 seconds, and its abort signal fires. A source call must
settle once its signal aborts.

**Stop:** on release and on shutdown, it cancels the lane's retry, aborts its GitHub requests and
fences its commits, so nothing lands after stop. It settles within the 5 seconds the stage has
before the shutdown flush. Stop is final. `src/gateway/assistant/` holds the watcher type
(`Watcher`), the per-watcher state and the source lane.

## Delivery

- **Wake:** a poll's new wake-sorted threads go to `host.assistant` through `deliverEvent` in
  `routesSend.ts`, which shares `reach` (target resolution and `tryWakeTeam`) and the
  `ChannelDeliveryCoordinator` with an ordinary send but names no sender. A push carries up to 20,
  each with its thread id, composed once the session is reached. A push the lane gave up on
  composes nothing if its launch finishes later. The queued row is an `EventDelivery`, which holds
  no sender or reply route; the queue refuses an id a message already holds, and an acknowledgment
  retires only a row held for the acknowledging session.
- **Each thread wakes once per update:** a member is keyed by watcher, thread id and update time.
  `acceptEvent` drops a member the queue holds or emitted within its 30-day TTL and answers `seen`
  when none is left, so a retried or restarted push wakes nothing twice. An acknowledgment records
  its row's members as emitted in the same write that retires the row (`PendingDeliveryStore`).
- **The commit point:** the poll validator and the newest time seen advance together once every
  push of a poll is delivered or durably queued. A failed push leaves both where they were, and the
  lane polls again from that checkpoint with backoff, 30 seconds doubling to 15 minutes, as it does
  at start; the old validator means the retry cannot be answered 304. A thread read or done on
  GitHub before the retry is not woken. Each push has a 90-second deadline, and the backoff wait
  frees the lane for a listing or an action. Delivery is at least once.
- **Inbox:** `inbox({ scope: "new" | "all", page? })` reads GitHub live through the lane, with the
  token read on every call. Unread is the inbox, since GitHub lists a done thread under `all=true`:
  `all` is every unread thread; `new` is unread threads updated since the
  agent's mark, which moves to the newest time returned only once a `new` read reaches its last
  page uncut. A `new` read keeps only threads strictly after the mark, whatever `since` returns.
  Newest first, 50 a page. The Gateway signs each page token with a key it holds in memory, so the
  agent can neither forge nor edit one, and a restart answers "stale page"; inside it, GitHub's
  `Link` is bound to the grant, the scope and the read's `since` and mark. A list that changes
  between pages may repeat or skip. Each item carries its thread id, title, repository, reason,
  type, a link built from the validated repository and subject (omitted when the repository fails
  validation), and its rule decision. A thread id
  that is not digits is dropped, and every text value is one line and capped. Past 64 KB a page is
  cut, and its next token continues from the first item not shown. It marks nothing.
- **Who reads it:** the `inbox` tool and the action tools are registered only for `host.assistant`.
  The Gateway doors in `assistantRoutes.ts` answer only a token bound to the assistant's own record,
  and answer `not_assistant` or `unauthenticated` otherwise.
- **The record:** an action that reached GitHub for at least one id queues an `assistant_record` row
  through `deliverToOwner` into the assistant's own conversation, never through `channel_reply` or
  `notify_human`. A refused enqueue leaves no row; the tool says so, and the agent sends its summary
  with `notify_human` instead. It carries a
  `notify` flag, the summary in `body` (at most 300 characters, present exactly when `notify` is
  true), and per thread its id, outcome and, when GitHub answered, title and link. With a summary it
  is the assistant's message with the threads folded under it, and it notifies. Without one it is a
  muted "N cleared quietly" line that expands to its threads, kept out of the phone's burst, alert,
  autoplay and unread processing and the session card. A quiet row carries no body, so an older
  phone drops it unseen. Titles, links and outcomes come from GitHub and render as a fixed list of
  text; only the summary is the model's. The conversation is the only action history. A crash after
  GitHub confirms a clear but before its row is queued leaves that clear without a row.
- **Counts:** the chip, the settings health line and the baseline show GitHub's unread count from the
  last poll that read it ("4 unread"), "not checked yet" before one has, and "+" past the 500 a poll
  reads (`unreadText` in
  `AssistantOps.kt`, `renderBaseline`). Settings list each watcher's actions under its secret, from
  `assistant_state` (`watcherActions`); an older Gateway names none.

## What the model reads

- **Standing instructions appear once:** in the plugin's MCP instructions for `host.assistant`
  (`src/mcp/assistant/instructions.ts`). The folder's `AGENTS.md` holds the owner's own instructions.
- **Events:** a channel message with `event="true"` and no sender, `session_id` or
  `meta.instructions`. `CHANNEL_INSTRUCTIONS` says it is data and owes no `channel_reply`. Its body
  is each event's data lines (`eventLines`), thread id included, every value collapsed to one line
  by `oneLine` so a title cannot forge another line, then neutralized like any message body.
- **What it does with one:** the instructions say to decide whether an event is worth bringing up,
  and to answer with `github_done` and a summary if so, or with `github_done` alone to clear it
  quietly.
- **After a compaction:** the SessionStart `compact` hook adds one line per watcher, with GitHub's
  unread count and any stopped or waiting reason, beside the session's conversations, routine runs,
  agents and board entries. The watcher lines come before the board, the part a full baseline cuts.
