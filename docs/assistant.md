# Assistant

The owner's assistant is a long-running Claude Code session using Opus, on the one Gateway the
Router's record names. That Gateway feeds it events. The session decides what to say and do.

## The session

- **One session:** `host.assistant`, resumed while it lives on a Gateway. A name is not a binding,
  so provenance decides, as for a routine: `isAssistantRecord` reads the record's `mintedFrom`. The
  30-day and capacity sweeps skip it, and a plain forget is refused: only a home change ends it, and
  a new home starts a fresh conversation. Its notes folder keeps its files; a move does not copy them.
- **Where it lives is the Router's record:** one per Domain owner (`assistantHomeService.ts`). The
  phone writes it as a compare-and-swap (`assistant_home_put`) and reads it with
  `assistant_home_read`. It names a Gateway or nobody, and seals the folder and what a move carries
  (each watcher's rules and grant, and Safety) under `assistantHomeAadKind`, bound to the Gateway and
  the version, so a replayed or swapped record does not open. A put naming a Gateway that is not
  connected now is refused, and nobody is a stored row, never a delete. The named Gateway files one
  report per version, placed or refused with a reason, which the Router keeps in its own row and
  shows only beside the choice it answers. The `assistantHome` plane tells the phone either moved.
- **Every Gateway follows it** (`createHomeFollow`): it reads the record at each registration
  (`createRegistrationRead`) and takes each pushed change. A durable mark (`homeMark.ts`, scoped to
  the active Domain) holds the newest version and lands before anything else, so a version applies
  once and a restart never re-applies over an owner's edit.
  - **Named:** with its watchers stopped, it places the session record in the sealed folder, resets
    poll state and grants, takes the carried rules and Safety (fresh when nothing was carried), keeps
    a carried grant only when this Gateway may use its entry, then starts its watchers and reports.
    The first wake launches the session; the host daemon creates the folder with its parents when it
    is missing (`ensureAssistantWorkdir`), never home or a folder above it.
  - **Not named, or nobody:** it ends waiting sends, stops its watchers, forgets the session (retried
    while it wakes), and drops its grants, rules and Safety. Its routes answer `not_assistant` from
    the moment its mark says so, and a late wake cannot register once the record is gone.
  - **Never written:** a Gateway's own session record stays in charge.
  - **Cut off from the Router:** it keeps running on its mark. A mark write that fails stops it
    acting until one lands.
- **Opus only:** no model levels.
- **Its own root:** the drawer's Assistant entry draws the one landing `assistantRoot` folds from
  the Router's record, its report, a held put failure, Router reach and the roster. Nothing is drawn
  before the first read. Otherwise it is the Router unreachable, set up (nobody or never written),
  moving, the move's error, the home unreachable, or placed. Set up and the error offer Settings, and
  a gear in the top bar opens it on every landing past the first read while the Router is reachable
  (`rootOffersSettings`).
  - Placed, a `placed` report for the held choice (`placedGateway`), enters its conversation in the
    usual thread screen, titled "Assistant", with one chip per watcher under the title, a gear for
    Assistant settings in place of the session menu, and no tab row (`threadChrome`). Back goes
    Terminal, Chat, Sessions.
  - The gear opens the Settings page: Assistant location (the Gateway, the folder, Move here or Set
    up here, Remove assistant), then the home's Safety and each watcher's health (`WatcherStatus`),
    secret, grants, actions, a Rules page with its count, and Retry when stopped. Rules opens a
    rule's Editor page. `docs/console.md` holds how the pages route.
  - **Writes** (`AssistantOps`): Set up and Move are one sealed put. A placed, reachable home carries
    its fresh `assistant_state`; an unplaced one carries what the record sealed; a placed home that
    cannot be reached carries nothing, only once the owner confirms abandoning it. Remove puts
    nobody. A conflict adopts the winner, and an unknown outcome is read back. A record never written
    seeds from the one registered Gateway that answers holding it, unless the owner chose first.
  - **One writer** (`AssistantHomeFence`): the record, its failure, each Gateway's answer, the stored
    copy and the role stamp land only through it, against the ticket their work began under, so a
    late answer or a re-provision never repaints a newer choice.
  - `isAssistant` knows it by a role stamp, a persisted role, or the chosen home's address, never
    by name. `openThread` refuses it, and `followedTeams` keeps it followed without a tab.
  - The open conversation follows a move and leaves when the record names another Gateway, nobody,
    or a refusal of the held choice (`followAssistant`). An unreachable home it still names keeps
    the thread.
  - `host.assistant` stays out of the Sessions list because the Gateway marks its presence row with
    `role: "assistant"` (`ASSISTANT_ROLE`), never because the phone matches a name.
- **Hidden from every session and friend:** only the owner sees it or opens a conversation with it.
  - The Gateway: `ordinaryRows` takes it out of `GET /teams` and `/discover`, so `crosstalk_discover`
    and the cross-Domain gate never offer it. `/pending` answers a session only its own jobs
    (`actsForBoundSession`). A session's or another Gateway's `send` to it answers as an absent
    session before anything wakes it; the owner's sends pass.
  - The Router: `friendProjection` drops its row, `ShareService.share` refuses it, and a share made
    earlier is withdrawn when its stamped row lands (`assistantSeen`).
  - The phone: `ordinarySessions` keeps it out of every session picker. The role is persisted with
    the threads, so a cached thread with no presence row stays out too.
  - A session the assistant wrote to still answers through `/respond`.
- **Its own tools:** the plugin registers them only in the assistant session. The Gateway serves
  their routes only to that session's token.

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
  `channel_reply_structured`, `switchboard_capabilities`, `notify_human`, `inbox`, each declared
  watcher action and the crosstalk tools (`ASSISTANT_SWITCHBOARD_TOOLS`, through `scopeTools`), so
  no guidance names a tool it lacks and no reply snapshots a ref. `ASSISTANT_ONLY_TOOLS` are
  registered for it alone, which `check:boot` proves against a bound session and a tokenless one. Its instructions carry the assistant's standing rules
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
  `notify_human`, `inbox`, each declared watcher action, the crosstalk tools and `ToolSearch`. The
  reply route already refuses a conversation not addressed to the caller. The attachments of
  `channel_reply`, `notify_human` and `crosstalk_send` take the read rule, and a `ref://` to `/`, `~`
  or `..` in the field each uploads (`full`, or a send's `body`) is refused. A field that is not
  text is refused.
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

## Sends

The assistant reaches other sessions through `crosstalk_send`, and the owner approves each send on a
phone card. Replies and notices to the owner never ask. `gateway/assistant/sendGuard.ts` holds the
guard; `docs/vault.md` holds the request lifecycle it shares with the vault.

- **One door:** the assistant's `crosstalk_send` posts to `/assistant/send` (`sendGuarded` in
  `mcp/assistant/sendTools.ts`). An older Gateway answers a plain-text 404, which the tool reports
  as a refusal. `/send` refuses a session send that presents the assistant's token, whatever `from`
  names, so the guard's `assistant` ingress (`sendFromAssistant`) is the only road out.
- **Bound once:** `createSendGuard` resolves the target to its canonical address, naming a friend
  Domain when there is one, and binds it with the exact body, disposition, label, whether it creates
  a session, and each file's digest, name, type and size. A label, file name or type that spans
  lines is refused, as are files to a friend Domain and a card past the plugin action payload cap.
  A repeat of the same intent joins the open card.
- **Held:** the card is a `plugin_action` row, `assistant` `send-request`, retracted by
  `send-retract`. The tool waits up to 230 seconds, then answers `pending` with a request id;
  `crosstalk_collect` and `crosstalk_withdraw` continue it. The deadline is the vault's.
- **Delivered at the tap, as bound:** `assistant_send_answer` approves or denies, deny with an
  optional note. Approval rebinds the target and re-reads each file's staged size; a moved target
  or a changed file fails the send. A relay that lost its answer reads as possibly delivered. The
  outcome, sent, denied, expired, failed or withdrawn, stays collectable through a grace past the
  deadline.
- **Approve every send:** an owner setting per Gateway, on by default, read at every send; a failed
  read asks. Off, a send goes without asking only while the owner spoke last: `createOriginMarker`
  holds the origin of the newest row it saw in acceptance order. An owner row counts once
  acknowledged; any other row counts as soon as it is offered; a reply counts as it is pushed. Every
  channel row reaches the session through the delivery queue, whose observer is required, so no
  road skips the marker. A restart, a session's end and a fresh placement clear it, and an owner row
  accepted before boot never reads owner.
- **Accepted risk:** the marker sees only channel rows. An earlier event still in context, or data
  the assistant read through a tool after an owner input, does not make it ask. A check-in is an
  owner input (see Check-ins), so a runbook that has the assistant read its inbox and then send
  carries the same risk as asking it to in chat.
- **Recorded where accepted:** a sent message lands in the owner's view of both conversations
  through the `peer` mirror, keyed by the request id, with a `guard` word saying whether it was
  approved or went unasked. A denied, expired or failed send is not recorded.
- **Restart:** the request ids of open cards are written before a card goes and retracted at the
  next federation activation, so no card outlives the process that could answer it.
- **The phone:** `AssistantSendManager` holds the cards per Gateway, `AssistantPlugin` claims the rows,
  and `AssistantSendSheet` shows every bound field and the full text. Approval takes `ApprovalGate`.
  The notification posts on the assistant's channel, private on the lock screen, and no notification
  action approves. Assistant settings' Safety section holds the setting and lists waiting cards.

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
  order: the request inside the action and the preview inside the phone's answer wait. The assistant
  routes sit inside the Gateway's 255-second idle timeout, pinned by `gateway-serve-limits.test.ts`.
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
- **Its fields:** `reason`, a list of GitHub's 16 reasons; `type`, a list of the subject types seen;
  `repository` and `title`, text. `GITHUB_FIELD_SPECS` holds them.
- Reads a classic token from its granted vault entry. The notification endpoints take no
  fine-grained token. Without a grant, on a 401, on a 404 (GitHub hides what a token may not see),
  or on a 403 that is not a rate limit, the watcher stops with that reason. `createGithubWatcher` in
  `src/gateway/assistant/githubWatcher.ts`, over the shared client.

### Rules

Each watcher carries an ordered rule list, first match wins, kept by the Gateway like routines and
policies. The owner edits it on the phone in Assistant settings; only owner ops write it, so the
assistant cannot rewrite what sorts its own events.

- **A rule:** a phone-minted id, one to 8 conditions, all of which must hold, and an action: `wake`
  or `inbox`. A condition is a field the watcher declares, a test and a value. At most 50 rules
  (`ASSISTANT_RULES_MAX` in `wire-vocabulary.ts`); `otherwise` takes anything none matched.
- **A field is a choice list or text:** each watcher declares its fields (`Watcher.fieldSpecs`). A
  choice list (`enumeration`) carries value and label pairs, takes `is` and `is_not`, and compares
  the exact value; labels are display only. Text takes `is`, `is_not` and `contains`, case
  ignored. A missing field fails every test on it, `is_not` included. A value is stored trimmed of
  ASCII whitespace at its edges, `trimRuleValue`, and nothing else.
- **One parse, one match:** `parseRuleForFields` in `schemasAssistantRules.ts` refuses an undeclared
  field, a value off its list, a test its kind does not take and a blank value. `firstMatch`, the
  one reading of which rule decides a thread, skips a rule that does not parse; `decideEvent`, the
  listing and the preview all take it.
- **A rule that no longer fits is kept:** validity is read against the current declarations on
  every read and never stored, so a declaration change moves no revision. An unfit rule matches
  nothing and rides in `invalid` with its reason; the phone strikes it through and blocks Save
  until it fits, and a put repairs it in place.
- **The phone's Save gate is the Gateway's parse:** `fittingRule` in `RuleDraft.kt` decides Save and
  the preview, and the Save sends what it answers. `tests/fixtures/assistant-rules/vectors.json`
  pins it to `parseRuleForFields` on both runtimes.
- **Values off the list are reported:** every poll checks its events against the declarations,
  the priming poll included, and keeps each value outside its field's list once, up to 32, with an
  overflow flag. An entry leaves once the declaration lists it. The phone shows them under the
  watcher's Rules row, so a new GitHub value is seen before a rule needs it.
- **No drop, no ping:** GitHub threads are cleared at GitHub through `github_done`, and the agent
  alone decides what is worth telling the owner. The rules file is read through a decoder that
  runs before the schema parse: it removes `drop` rules, maps an `otherwise` of `drop` to `inbox`
  and strips `ping`, keeping the rest's order and revisions.
- **The store:** `createRulesStore`, sole writer of `assistant-rules.json`, on the policy store's
  model. The file parses strictly, so an unknown key quarantines it. Each rule and `otherwise`
  carry their own revision, which the store names; the list's revision moves with every write and
  is what a sort names. A put carries the revision it read, 0
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
  rule takes, and refuses what a put refuses. The rules, the declarations, the unfit rules and the
  values off the list ride in `assistant_state`.
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

## The locked phone

A locked phone or a paired watch gets only an assistant row's locked form. Code enforces where the
title is used, never what it says; `ASSISTANT_INSTRUCTIONS` tells the assistant its titles are public.

- **The locked form** (`AssistantLockedForm.kt`): `lockedLine` gives a reply or notice its title on
  one line, a notifying record "Assistant finished N items", and anything else "Assistant update".
  It never falls back to the summary or the body. `spokenTier` answers `Tier.LOCKED` for an
  assistant row on a locked phone.
- **Locked means `isDeviceLocked`**, so a Smart Lock reads as unlocked. The service reads it into
  `ChatRepository.deviceLocked`; no public lock listener exists, so `DeviceLockWatch` starts at
  screen off and checks once a second only while a lock would change what is said.
- **Notifications carry only the locked form, unlocked too** (`assistantNotificationBuilder`): a watch
  bridges what the phone shows and ignores a public version, so no surface ever holds the body. The
  notification is private with a public version, and its Play actions require an unlock. Any thread
  holding a record takes this builder, since only the assistant writes records.
- **Speech:** the queue decides each head's tier as it starts, and `relock` swaps a head being
  spoken at another tier for its locked form when the phone locks. A locked line is never
  attributed with session labels. After unlock nothing replays; a row heard only as its locked line
  stays unread with Play.
- **Quiet peer rows:** the assistant's send records and the replies to them are stamped `quiet` at
  drain and re-stamped when a thread comes to read as the assistant (`withAssistantPeersQuiet`):
  shown, never alerted, spoken or counted unread. The drain applies the presence and assistantHome
  planes before a tick's rows. A row alerted before the phone knew its team is the assistant cannot
  be retracted.
- **A placed home stamps the role:** `AssistantHomeFence` records the home's address as the
  assistant once its report says placed, on every record landing, and past addresses keep theirs.

## Summon

Long-press power, with Switchboard as the digital assistant, opens the Assistant view with the
composer focused and the keyboard up. Nothing draws over the keyguard and the app holds no
microphone; Gboard's mic key dictates. `summon-residue.test.ts` refuses `showWhenLocked`,
`turnScreenOn` and `RECORD_AUDIO`, and pins `ACTION_ASSIST` to `MainActivity`. The decisions live in
`AssistantSummon.kt`, the activity's half in `MainActivity` (`consume`, `retryDismissal`).

- **Unlock first:** a summon that finds the keyguard showing calls `requestDismissKeyguard` at once,
  so the system asks for the PIN, then the app lands. A dismissal error retries once, and the retry
  re-reads whether the device is locked. Back on the prompt lands the Assistant without the keyboard.
- **Read once, held in `SummonBus`:** a restored or from-history launch replays nothing, a rotation
  keeps a summon not yet landed, and process death drops it. Every keyguard callback names its
  summon, so an older one moves nothing. An intent asking to open something else supersedes it.
- **Only the shown window acts on it:** routing, the app-lock handoff and the keyboard all wait for a
  resumed window. A summon raised while the attachment picker is open creates a second
  `MainActivity`, and the stopped one beneath must not take it.
- **Landing:** placed, it lands on the Assistant's Chat; before any Gateway answers, on the last
  assistant conversation (`lastAssistant`), which the answer then retargets; unplaced, on Settings.
  The arrival clears what draws above the shell (`dismissForArrival`) and closes the drawers.
- **The keyboard fires once** (`focusStep`), when the Chat and its composer are drawn, nothing covers
  them, the app lock is clear and the window is focused. A locked summon arms it only when our
  dismissal succeeds.
- **The app lock:** a summon whose keyguard asked for a credential also stands for the app's own
  lock, once; a Smart Lock dismissal does not. No API proves a credential was entered, so a trust
  agent granting trust while the system prompt shows reads as a challenge.
- **Setup:** the role cannot be requested by an app. Assistant settings shows a Digital assistant row
  while the role is not held or its session is not adopted (`assistantSessionAdopted`), opening the
  system's picker and naming the Press and hold power setting. A role picked before the session
  shipped recorded none, so it takes one re-pick.

## The panel

With the session adopted, long-press power opens a panel over the app beneath instead of switching
to Switchboard. `AssistantVoiceService`, `AssistantPanelSessionService` and a stub
`AssistantRecognitionService` (`AssistantPanelService.kt`) are what the role binds;
`AssistantPanelSession` is the panel, and `AssistantPanelRules.kt` holds every decision it makes.

- **Nothing draws over the keyguard or the app lock:** `onPrepareShow` asks `panelShow` before any UI
  is enabled. A locked keyguard, an app lock that would ask (`AppLock`, `appLockAsks`) or no
  conversation yet hands off to today's summon on `MainActivity`. An open panel hides if the app lock
  asks again. `assistant_session.xml` refuses a keyguard launch, and `summon-residue.test.ts` pins both.
- **One answer for the app lock:** `AppLock` holds it for the process, so the Activity and the panel
  read the same one. A rotation keeps it; `MainActivity` finishing gives it back.
- **One foreground:** `ForegroundLease` brings the process to the foreground on the first host shown
  and back on the last one hidden, so closing the panel never backgrounds the Activity.
- **The surface:** `AssistantPanel` draws the thread from its own renderer pool, the draft's text,
  the screen chip and Send. It sends what it shows: the text and an attached screen; the draft's
  files stay for the app's composer. Attachment taps, link menus and row menus do nothing here;
  "Open in app" reaches them. Each summon is a fresh session, since `onHide` calls `finish`.
- **Share screen:** the screenshot and the screen text arrive with the summon and stay in memory,
  dropped on hide. A tap attaches them; only a send writes them, as `screen.png` and `screen.txt`
  with role `screen`. The text is read from a bounded walk of the `AssistStructure`, password fields
  left out (`screenText`).
- **Screen text never speaks for the owner:** a `screen` file rides every send road to the Gateway,
  where `createOriginMarker` reads an owner row carrying one as not the owner's own words, so a
  `crosstalk_send` after it asks a card even with approve-every-send off.
- **The integration probe** (`IntegrationProbe`): debug builds only, at app start and at each panel
  show, it logs to the ingest what the phone would allow an assistant: the role, the assist
  settings, the torch, which intents resolve, candidate permissions declared and granted, and
  notification-listener, Do Not Disturb and Accessibility access. Each show also logs the shape of
  the assist data (`assistFacts`). Only counts, booleans and setting states leave the phone.

## Check-ins

A routine whose target kind is `assistant` is a check-in: it runs in the assistant's session rather
than reserving one. `docs/routines.md` holds the routine side; this is the assistant's.

- **An owner input:** the nudge arrives through `sendFromOwner`, so the origin marker reads it as the
  owner's message. With Approve every send off, the check-in's work may send unasked.
- **Its tools:** `get_session_routine` and `report_session_routine` are `ASSISTANT_ROUTINE_TOOLS`,
  part of `ASSISTANT_SWITCHBOARD_TOOLS`, so the scope, the gate and the launch list them, and the
  instructions teach them. The nudge names the run as `routineId@instant`.
- **Mid-task by nature:** a check-in never waits for the assistant to go idle; its nudge lands beside
  whatever the assistant is doing.
- **No secrets:** a check-in links no vault entries, and a run of one holds no routine grant.
- **Where it lives:** saved only on a Gateway where the assistant is placed. One that fires while the
  assistant is not placed stops for review with `assistant_unplaced`. No routine reserves or forgets
  the assistant's session.
- **What to read:** the runbook says `new` or `all`. A `new` read moves the assistant's one mark per
  watcher, as any read does.
- **The phone:** the routine editor offers Assistant beside the spawn points only where that
  Gateway's assistant answer is placed and carries `checkIns`; an older Gateway would drop the kind
  and store a spawn routine.

## What the model reads

- **Standing instructions appear once:** in the plugin's MCP instructions for `host.assistant`
  (`src/mcp/assistant/instructions.ts`). The folder's `AGENTS.md` holds the owner's own instructions.
- **Its capabilities are its own:** `switchboard_capabilities` serves both kinds of session. The
  assistant's answer lists `ASSISTANT_CAPABILITIES`, built from the Switchboard tools its scope
  allows (Claude Code's own file tools are not Switchboard's and are left out), then the
  standing rules again for after a compaction. What the Gateway enables is named as other sessions',
  never as something a restart would add.
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
