# Questionaire

## Question 1 - What is the assistant?

Q: Where does the assistant live, and what can it do?
A: An Assistant section in Switchboard beside Sessions, Runbooks and Routines, with its own tool set. It replaces Gemini's role on the phone with the owner's own service, with storage on Sakura.

> let's chat. I'm wanting it to be adjacent to Switchboard. So a new section in Switchboard like Assistant?
>
> It should get a totally different set of tools as well.

## Question 2 - What runs it?

Q: Which model, and one-shot turns or a session?
A: Always Opus, as one long-running Claude Code session with timed auto-compact. No AI levels.

> we probably have it on always Opus. So not really any AI levels.
>
> Session is fine. That means it can become a long running convo instead of like traditional one shot Gemini.

> assistant will only ever be one long running session. it has auto compact after x minutes, so it's solid for ongoing conversations and new conversations with just the updated knowledge.

## Question 3 - Where does durable memory live?

Q: What survives compaction?
A: A notes workspace at `~/projects/notes/` under git, which is also the session's spawn point. Its `AGENTS.md` holds the standing rules. Notes keep fixed sections the assistant updates as it works: open threads, pending asks, decisions, commitments.

> Conversation wise, Claude is exceptional at compaction handling. But there could be a more durable store. Like if it had it's own workspace at projects/notes/ or something

> that uses. claude me? rename it to agents md

## Question 4 - What does the gate ask?

Q: When does the assistant ask before acting?
A: Gate on reversibility. Undoable acts happen at once and report with an Undo. One-way acts (public, leaves Sakura, costs money) ask first, on a card rendered from the real params. A spoken "sure" counts only for the card showing at that moment. One ask can cover a plan. Writes to `AGENTS.md`, the session's own settings and hooks, and anything outside notes stay gated.

> Opus is also pretty good at rejecting injections. but for thorough safety, we could allow most non writing tools aside from like Edit notes or something and have a gate for execution and edits of AGENTS.md / CLAUDE.md or files outside notes.
>
> Gate is verbal Should I [blah]? and if I tap approve or speak Sure! or something, it accepts.

> a full gate all the time seems very un-assistant like. I don't want to say sure 8 times if it fixes 8 files.

> undoable, just let it happen.

## Question 5 - How is it proactive?

Q: What wakes it without the owner asking?
A: One event inbox on the Gateway, fed by watchers, phone events, routines, and webhooks later. A watcher is plain code that polls with a durable cursor, never Opus. Rules sort each event: wake, hold, drop, or run a read or private action.

> it should have proactiveness like the scheduled Routines. Except this one is woken by Android->Gateway instead of Gateway waking itself.

> a lot of things are manually polled. so I feel like my statement that phone triggers might not work.
> Like GitHub, we might have to poll for that.

## Question 6 - Which sources first?

Q: Which watcher comes first?
A: GitHub notifications, then Gmail. Gmail needs its own OAuth token in the vault, since a watcher cannot use Claude's connectors.

> GitHub notifications are good.

> Could do Gmail?

## Question 7 - What are the base types?

Q: What shape do actions and watchers take?
A: Lifted from Evie. An Action is schema-first, takes refs rather than ids, and answers done, refused or unknown. One Gateway executor serves both a tool call and a tap, and an action ledger records each. A Watcher's poll returns events, backoff or stopped, with the events and the cursor in one durable write.

> Now I want you to look at Evie-bot codebase with it's Actions. Highly type strict and customized to each kind of job scope. Lift any engineering that's directly relevant from my Evie codebase.
>
> GitHub will be one such action. Theorize about what the base action would look like.

## Question 8 - Does an action carry a Purpose?

Q: Keep Evie's Purpose field to hide intermediate calls?
A: No. Each action declares an effect: read is hidden, private just happens, public asks. A public action takes a required `why` param, shown on its card. The ledger records who started an action: the owner, the assistant, or a rule by name.

> But this is my assistant, for me only. So we probably don't need Purpose here. Or if we do, we can use it again to hide intermediate tool calls and only show the human invoked for brevity. Thoughts?

## Question 9 - Are tool calls recorded?

Q: Does the conversation keep a record of each tool call?
A: No. The conversation is messages plus approval cards.

> For now, tools don't record. since it's through a single Claude model.

## Question 10 - What text gets injected?

Q: How does Switchboard's own text reach the model?
A: Standing instructions appear once, in the system prompt and `AGENTS.md`. Per-message state goes in `system-reminder` data lines, and events go in message bodies. Switchboard migrated to this in 8.13.21.

> Let me know if there is like system text being jammed into the proposed agentic messages to make this work

> look to NyaaCode on how they generate and handle system-reminders.

## Question 11 - How do digests and routines meet?

Q: How does a morning routine see only its own sources?
A: One held queue, drained through one door, `flush(watchers)`, which marks items seen. Its callers are a routine (`delivers: [...]`), a `held` tool the owner's ask reaches, and a wake rule. Each watcher keeps one read position, so a 9am ask makes the 10am routine skip those items. Held counts ride in the reminder block.

> a thought. So we can have a morning routine at like 10 for example. Maybe the routine can be told which Actions to subscribe to. That means it only sees the new messages for that.
>
> And if optionally user asks about another Action kinds, it pulls those latest.

> But if it's 1 long running convo, I guess that means subscribing to an action is per call only?

## Question 12 - How do hidden reads show?

Q: Hidden reads as nothing, or as a count?
A: A collapsed count the owner can tap to reveal.

> yeah can tap to reveal

## Question 13 - Does a wake ping the phone?

Q: Does every wake ping?
A: Configurable per watcher or action, with a default its definition declares. A feed defaults to no ping.

> Configurable per Actions. and the actions specifies the default. Like user probably doesn't want to hear everything on an XML feed.

## Question 14 - What survives a compaction?

Q: How does the session get its state back after a compaction?
A: A SessionStart `compact` hook re-sends a baseline from the Gateway. Shipped in 8.13.22 with conversations, routine runs, running agents and board entries. The assistant's state lines (held counts, open cards, watcher positions) join that baseline.

> Do it right after NyaaCode finishes, so you can copy the homework.

## Question 15 - Where does the GitHub token live?

Q: Vault entry behind a watcher grant, or a mount of Sakura's `gh` login?
A: The vault. Entry `28a9df59fd21468c982ab6f616dab59a`, "GitHub - Personal Development", a classic PAT. A live check found it carries `admin:org, delete:packages, notifications, project, repo, user, workflow, write:packages`. The owner swaps in a narrower token later; the watcher takes whatever the entry holds.

> ok pat is in the vault

> I'll change it later. don't worry about it.

## Question 16 - Does the first slice need a phone view?

Q: Build the Assistant view now, or talk through an ordinary conversation thread?
A: Skip it this slice. The next slice tries summoning the assistant by holding power, or from the lock screen.

> sure skip this slice, and next one we can attempt to set up the hold power for assistant. or lock screen stuff.

## Question 17 - How does the watcher get its token?

Q: A vault grant with a new "Allow always" on the request sheet, or a Gateway environment variable?
A: The vault. A rotated key is a vault edit, never an env edit. The watcher asks once through an ordinary vault request in the assistant's thread, and the sheet offers "Allow always" for a watcher.

> We may want to make the assistant utilize Vault or use an ENV, which ever one is more possible. Don't even know if it can access vault from its proposed place

> actually I don't like the idea of ENV very much. Periodically replaced keys should not be required to edit in an env. Vault it is?

## Question 18 - When does the owner pick the watcher's secret?

Q: The watcher asks through a vault request on its first poll, or the owner picks the entry while setting it up?
A: Up front, as a routine's secrets are picked in its editor. A small Assistant setup screen on the phone lists the watchers, each with the Grant secrets sheet a routine uses. A watcher with no grant shows it needs a secret and stays stopped; nothing asks mid-stream.

> I would rather the grant vault item be selected up front while setting up assistant

## Question 19 - Where does the assistant live on the phone?

Q: A session in the Sessions list, or its own place?
A: Its own Assistant tab, holding its conversation thread and its watchers. `host.assistant` leaves the Sessions list. This brings a first Assistant view into this slice.

> ok I don't want assist session to be in sessions. let it be a new tab called Assistant.

## Question 20 - Where do rules live, and what does the front page count?

Q: Rules on the phone, kept by the Gateway like routines (A), or YAML files in notes (B)? And which counts show on the front page?
A: A, recommended: rules edited on the phone in Assistant settings, written only by owner ops. The front page shows only each watcher's inbox count; woke and dropped counts sit on the watcher's own screen, with Replay beside dropped. "Held" is renamed "Inbox" throughout: a rule's action is Wake, Inbox or Drop, and the tool is `inbox`.

> ok.
>
> Inbox is a better word too. relabel it.

## Question 21 - Where are the assistant's settings?

Q: How does the owner change the assistant's setup?
A: A gear on the Assistant tab opens Assistant settings: watchers (status, Grant secrets, rules), check-ins (when it routinely wakes, as routines aimed at the assistant), and session options (compact when idle after N minutes, notes folder, restart). Check-ins and compaction timing land with the next slice and show disabled until then.

> and on the Assistant tab, I want a settings button to change assistant settings (like addressing missing grants or choosing when it routinely wakes up or whatever)

## Question 22 - Who chooses where the assistant lives?

Q: A Gateway environment variable, or the phone?
A: The phone. Assistant settings has a "Lives on" row: a Gateway and the notes folder on it. Choosing another creates the long-lived session there and forgets the old one, record and all. It replaces `ASSISTANT_WORKDIR`, so only one Gateway ever holds the assistant.

> ohh yeah and we would have to select in assistant settings where we want the assistant to live. So I want Sakura. another use might choose like Ubuntu-Server or something. whatever the choice is, the long lived session will be created there and forgotten old location.

The location and the folder are one choice, "Lives in": a folder on one Gateway, such as `sakura · ~/projects/notes` or `ubuntu-server · ~/.assistant/`. The folder need not be a notes repo; Switchboard seeds what it lacks (the assistant section of `AGENTS.md`, the `Assistant/` memory files) on first use.

> ohh picking the location and the notes folder are one in the same. I would say that it lives in my notes folder. someone else would say "~/.assistant/". Notes is my idea of the location of the session

## Question 23 - Where do the assistant's standing rules live?

Q: A section seeded into the folder's `AGENTS.md`, or shipped with Switchboard?
A: Shipped with Switchboard: the plugin's MCP instructions carry an assistant block shown only to `host.assistant`, so every release updates them. `AGENTS.md` in the folder is the owner's own custom instructions only. The `Assistant/` memory notes are files the assistant creates and keeps because those instructions say to; nothing is seeded. Watcher sorting rules are separate: owner data, edited on the phone.

> wait. what rules file? we should have the rules baked into the Assistant API. Not in a file that goes stale across many users. Unless you just mean User's custom AGENT.

# Plan

The first slice proves the loop: a GitHub notification lands on the Gateway, a rule sorts it, and the assistant session either wakes or finds it in its inbox. Actions with cards and Undo, Gmail and phone events come after.

The owner talks to the assistant in its own Assistant tab: its conversation, an inbox strip with one chip per watcher, and a gear for Assistant settings. `host.assistant` leaves the Sessions list. Mockups: the `assistant-tab`, `assistant-settings` and `assistant-watcher-phone` design cards.


**Verified live on 2026-10-17:** a conditional GET with `If-Modified-Since` answers 304 and leaves `x-ratelimit-remaining` unchanged. The first GET carries `last-modified` and `x-poll-interval: 60`. Still from the docs only: the rate-limit response, 403 or 429 with `x-ratelimit-reset` or `retry-after`.

## Phase 1 - Design doc

Write `docs/assistant.md` from the questionaire: the session, notes, the gate, effects, triggers, base types, digest, reminders.

✅ Written, aligned, red-teamed and committed in `ec2d576a`. The red team and architecture audits reshaped Phases 2-6 below.

## Phase 2 - Notes workspace, session and interim gate

✅ Committed in `8cb4fb8a` and `ed97f452`; notes repo `ce3f0e0`, `20d5674`, `ba3ad27`. "Lives in" from the phone replaces `ASSISTANT_WORKDIR` in Phase 4.

- ✅ **Notes:** `~/projects/notes/` under git. `AGENTS.md` is the owner's own instructions; the assistant's standing rules ship in the plugin (`ASSISTANT_INSTRUCTIONS`). The `Assistant/` memory files are the assistant's own, created as it works.
- ✅ **Identity:** `host.assistant`, owned by provenance as a routine's reserved session is: `isAssistantRecord` reads `mintedFrom` against `ASSISTANT_RESERVE_KEY`, so a session that merely shares the name is not the assistant. Chosen over a persisted role field because routines already settle "a name is not a binding" this way. `composeAssistant` mints the record once at boot from `ASSISTANT_WORKDIR`, with no launch, so a Gateway booting before its host connects still provisions; the first wake launches it. A record someone else made under the name is left alone and logged. Unset `ASSISTANT_WORKDIR` makes the record ordinary again.
- ✅ **Reservation:** `reservedByRoutine` became `sessionReserved`: `routines.reserves(team)` or `assistant.reserves(team)`. `SessionStore.sweep` takes a `SweepPolicy` and skips a reserved record in both the TTL and the capacity pass; liveness stays capacity-only. The TTL pass used to delete a routine's reserved session too.
- ✅ **Forget:** `forgetRefusal` reaches the console's forget through `createConsoleDispatcher`, which refuses before any kill.
- **Authority:** deferred to Phase 6 with the first assistant route. The MCP side registers assistant tools only when `PROJECT_NAME` is `host.assistant`, and every assistant route checks the caller's token resolves to the assistant record. `/capabilities` stays machine-scoped.
- ✅ **Gate hook:** host sessions launch with `--dangerously-skip-permissions`, so a PreToolUse hook is the boundary, not the prompt.
  - **Where:** the `gate` mode of the `main-session-hook` bundle, from the plugin's `hooks.json` with matcher `*`. `gateVerdict` and `gateHookOutput` hold the rule.
  - **Who:** a shell pre-check passes every session whose `PROJECT_NAME` is not `host.assistant`, so ordinary sessions pay one `sh` start and no `bun` start per tool call. The spawn and a hand resume both export that name, so no new marker exists. A session holding the name without the provenance is gated too, which is the safe direction. A gate that fails to run exits 2, which blocks.
  - **Home fallback:** the host launches in home when it cannot find the workdir, so a notes root whose real path holds the real home directory denies every tool. `composeAssistant` resets a stored workdir to `ASSISTANT_WORKDIR` at boot.
  - **Path tricks:** a leading `~/` is expanded as the tools expand it, another user's `~` is refused, a dangling link or a second hardlink is refused, every brace alternative of a glob is checked, and a pathless search is judged by the working directory. Grep's regex is never read as a path.
  - **Fail closed:** `onFailure: "block"` makes a timeout or crash block the tool (Claude Code 2.1.295+). A refusal reason is capped at 400 characters, and the hook exits only once stdout has the answer.
  - **Accepted:** `PROJECT_NAME` is the marker; a launch that drops it skips the gate. Both the spawn and the documented hand resume set it.

### Bug Classes

- **Mechanism:** the PreToolUse path gate, `gateVerdict` over `confine`.
- **Defect class:** the gate re-derives which file a tool will touch, and every spot where its derivation differs from the tool's lets a call through.
- **Round 1 (alignment):** the host's fallback to home made the whole home the notes root. Patched with a root-holds-home refusal.
- **Round 2 (red team):** `~/` expansion, brace alternatives in globs, a dangling link the write follows, a second hardlink, a symlinked root, a pathless search from an outside working directory. Each patched in `placeIn`, `patternEscapes` or `gateHookOutput`.
- **Round 3 (second red team):** `channel_reply` uploaded attachments and snapshotted `ref://` targets from anywhere. Patched: attachments take the read rule, and a ref to `/`, `~` or `..` is refused. Left open: a Grep `glob` such as `**/[.]env` selects a file the read rule would refuse, since the hook never sees the matches; and a write's check is not bound to its open, so a link planted between them is followed.
- **For architecture:** the durable fix is isolation that does not depend on re-deriving paths: the assistant's file tools mediated by the Gateway, or an OS boundary such as a separate user or a sandboxed mount.
- **Resolution (architecture):** the boundary moved to Claude Code's permission engine, whose check and open are one step. `assistantPermissionArgs` launches `host.assistant` in `dontAsk` with `--tools Read,Edit,Write,Glob,Grep,ToolSearch` and inline settings (Edit allowed under the workdir, reads of the attachments directory, denies for instruction files, `package.json` and `.env`). Probed against the real binary: reads outside, writes outside, a write through a symlink, `AGENTS.md`, `.env`, the `[.]env` glob, `Bash`, `Agent` and `WebFetch` all refused; reads and edits in notes and reads of attachments allowed. `scopeTools` lists only the assistant's Switchboard tools. The hook stays as a deny-only layer and the only check on reply attachments and refs. Other options weighed: Claude Code's sandbox covers shell commands only; Switchboard-mediated file tools would need descriptor-relative opens; a bwrap wrapper or a separate Unix user remain the next step if an OS boundary is wanted.

### Accepted

- **Provenance key:** `assistant:reserve` can be formed by a console `create_session` with conversation `assistant` and op `reserve`. Only the owner sends console ops, and a routine's key has the same shape.
- **Running pane:** a pane already running keeps the hooks it loaded. After a plugin update, a gate change or an `ASSISTANT_WORKDIR` change, `reload_plugins` or restart the assistant.
- **Version floor:** `onFailure: "block"` needs Claude Code 2.1.295 or later; Sakura runs 2.1.302. Nothing enforces the floor.
- **Project settings:** `--setting-sources user` would keep a planted `.claude/settings.json` out, but it also drops the owner's `AGENTS.md` (probed). The session cannot write `.claude/`, so only the owner could plant one; a planted `Read(//etc/**)` allow did not open a read in the probe either.
  - **Closed allowlist:** exact names only. Reads (`Read`, `Glob`, `Grep`) inside notes or the channel attachments directory; `channel_reply`, `switchboard_capabilities`, `ToolSearch`. An unknown name, or a path tool's malformed input, denies.
  - **Writes:** `Write`, `Edit`, `MultiEdit` and `NotebookEdit` inside notes. `confine` gained a `Withhold` that runs on the spelled and the resolved segments, so a symlink cannot alias a protected file. Protected: `.git/`, any `.claude/`, any `AGENTS.md`, `CLAUDE.md` or `CLAUDE.local.md`, `watchers/`, `.mcp.json`. A pre-tool path decision, not race-proof isolation.
  - **Refused:** every other tool. That covers `Bash`, `vault_run` (it runs shell commands with no entry), `Agent`, `Workflow`, Codex and Copilot delegation (a child ignores this hook), web fetches, and other MCP servers' tools.
  - **Replies:** the reply route already refuses a conversation not addressed to the caller (`refuseForeignReply`).
- ✅ **Notes:** `AGENTS.md` gained an `## Assistant` section, and `Assistant/` holds `Open Threads.md`, `Pending Asks.md`, `Decisions.md` and `Commitments.md`, committed and pushed in the notes repo.

## Phase 3 - Event inbox, Watcher type and runner

✅ Committed in `c76f6b2d` and `776dd3fc`. Nothing wires a watcher yet; Phase 4 adds the first.

- ✅ **Stage:** `composeAssistant` opens `assistant-inbox.json` through `openDurable` and builds the watcher runner. `start` runs on federation activation and only for a configured assistant; `stop` runs before the shutdown flush, waits up to 5 seconds for polls in flight, then aborts the rest and waits for them to settle. Stop is final, so an activation during shutdown starts nothing. It resolves the assistant through `SessionStore` and keeps no second session id.
- ✅ **Store:** `createInboxStore`, sole owner of events, cursors, poll health, read positions, dispositions and dedupe state. One versioned snapshot, changed only by `commitPoll`'s checked write, following `createOccurrenceStore`. A write that fails before install restores the previous memory state; `DurableStoreInstalledError` counts as landed. `PendingDeliveryStore` stays channel transport.
- ✅ **Watcher type:** `Watcher` in `src/gateway/assistant/watcher.ts`, a stable id and `poll(cursor)` answering events, backoff or stopped; `WatcherEventSchema` is what a rule will test.
- ✅ **Runner:** `createWatcherRunner` arms a watcher's next poll only once its last one lands, so polls never overlap. A throw, a hang past 60 seconds or an answer failing `PollAnswerSchema` becomes a backoff, and the poll's abort signal fires; a write that does not land retries in 60 seconds with the old cursor; an interval below 10 seconds is raised to 10. A restart resumes at the stored next poll, and a stopped watcher gets one more try. An answer landing after `stop` writes nothing. An abort ends the poll's timed wait, so no timer outlives a stop. The next poll is armed before `onAccepted` runs, and a throwing hook is logged. Watcher ids must match `WATCHER_ID_RE` and be unique. A poll answers at most 500 events of at most 32 fields. The store hands out copies and reads source ids as own keys, so `__proto__` is just an id.
- ✅ **Durability:** a poll's events, its new cursor and its health land in one checked write. Events carry stable source ids, and a source id is remembered 30 days, past every row, so a late replay cannot resurrect one.
- ✅ **Dispositions:** rows are `inbox`, `woken` or `ruleDropped`. An eviction removes the row and counts it in the watcher's `evicted`, rather than keeping an evicted row. Rows are held in seq order, so a re-sequenced drop from Phase 5's replay is the newest and the cap evicts by seq. `accepted` lists only the rows kept. A restored `nextSeq` is raised past every held seq and read position.
- ✅ **Limits:** 500 unread inbox rows per watcher, 14 days for inbox and woken rows, 7 days for rule drops. An unread row lost to either is counted.
- ✅ **Health:** last success, next poll, backoff and stopped survive a restart in the snapshot. They reach the reminder lines with Phase 6.
- ✅ **Harness:** `startRouterOnly` closes every Gateway graph it composed, once, before the Router stops, so a watcher's timers cannot outlive a test.

### Red team

- **Fixed:** a start during shutdown's stop wait left the runner running; a throwing `onAccepted` disarmed its watcher; a poll ignoring its abort kept its 60-second timer past `stop`; `accepted` could name rows the cap evicted; a hand-edited snapshot could reuse a seq; rows evicted by array order rather than seq; poll batches and field counts were unbounded; router-only harness teardown skipped the Gateway close.
- **Accepted:** a wall-clock jump moves the next poll and retention with it. A rollback of an hour delays a restored poll by an hour, and a forward jump past 14 days evicts. Neither is guarded.
- **Accepted:** a poll that ignores its abort can overlap the next one. `Watcher.poll` must settle on abort; Phase 4's `fetch` passes the signal.
- **Accepted:** the 30-day seen map has no count cap. GitHub thread volume keeps it small; a high-volume source needs a per-watcher budget first.

### Bug Classes

- **Mechanism:** a stage's `start` reached from `onActivate`, and its `stop` from `composeListener.close`.
- **Defect class:** `close` stops a stage, waits, and only later closes intake, so an activation landing in that wait starts the stage again after shutdown.
- **Round 1 (red team):** the watcher runner. Patched with a final stop.
- **Round 2 (architecture):** the routine runner had the same hole. Patched with a final stop and a start-after-stop test.
- **Design fix (board):** a graph-level closing phase that `onActivate` and intake check first, then drain, flush and dispose.

## Phase 4 - GitHub notifications watcher

✅ Committed in `90401922` and `84721cac`. Not yet deployed; the Router goes first.

- ✅ **Watcher:** `createGithubWatcher` polls `/notifications` with `If-Modified-Since` on the first page and keeps `Last-Modified` as its cursor; a 304 answers no events and keeps it. Follows `rel="next"` up to 500 events, only on `api.github.com`. `X-Poll-Interval` is the floor, 60 seconds when absent. A rate limit backs off until `retry-after` or `x-ratelimit-reset`; a 401, or a 403 that is not a rate limit, stops it. Read-only. Tested against fake responses. The first poll takes what GitHub holds unread.
- ✅ **Source id:** the thread id with its `updated_at`, so a thread updated again is a new event rather than a replay.
- ✅ **Holder:** `watcher` joins `VaultHolderSchema` with a `watcherId`. `holderFitsTier` now reads: a standing grant iff the holder is not a session. `setStandingGrants` is the one writer of standing grants, with `setRoutineGrants` and `setWatcherGrants` over it. `covers` takes a `WatcherScope` and matches only that watcher's standing grant, so a watcher's grant never covers a session. **Deviation:** the grant type still shares one `VaultHolder` across tiers, guarded by the refine, rather than encoding the pairs in per-tier holder types: the phone renders one `VaultHolder` for every grant, and splitting it would fork that rendering for no gain the schema refine does not already give.
- ✅ **Gateway read:** `createVaultUse` in `vaultUse.ts` holds `ready`, `usable` and `release`, and `readForWatcher` takes the same `release` with `covers` checked after the vault refresh, so a grant revoked during the wait releases nothing. The routes call it; `decide` and `settle` stay in the routes, since they are the request road a watcher never takes. A missing or refused grant stops the watcher with the reason, an unreachable vault backs it off.
- ✅ **Owner's grant:** `assistant_watcher_grants` sets a watcher's one secret (more is refused, since the GitHub watcher reads one token) and pokes the runner, so a watcher stopped for a secret polls again at once. Retry on a stopped watcher sets the same grant again, which is how a rotated key recovers one stopped by a 401. Assistant settings lists the watchers and opens the routine's `GrantSecretsSheet`; `grantableOn` is now the one rule that sheet's entries pass, shared with the routine and policy editors. No request road.
- ✅ **Lives on:** the placement is the reserved session record itself, so no second store can disagree with it. `assistant_place` mints it or moves its folder; `assistant_release` drops the watchers' grants first and refuses if they stay, then stops the watchers, ends the pane and forgets the record through the console's forget with the reserve admitted. Placing again starts a fresh conversation. `ASSISTANT_WORKDIR` is gone. The phone's `AssistantOps.move` reads every Gateway, places on the new one, then releases every other home, and names any that did not release.
- ✅ **Assistant tab:** a root view after Sessions: where it lives, an inbox strip with one chip per watcher (a needs-a-secret chip in the tertiary color), Open conversation, and a gear for the settings sheet (Gateway and folder with the directory picker, watchers with health and grants, Release). `role: "assistant"` on the presence row keeps it off the Sessions list. **Deviation:** the conversation opens in the usual thread screen rather than inside the tab; embedding it needs `ThreadScreen` split from its tab chrome.
- **Lifecycle:** watchers are built in, so none is deleted; a release drops their grants instead.
- **Deploy order:** the Router parses presence rows with `TeamInfoSchema`, which strips an unknown field, so the Router deploys before the Gateway or `role` never reaches the phone.

### Red team

- **Fixed:** place, release and a grant change interleaved, so a place during a release's wait started a runner the release then orphaned, and a grant could land mid-release; the stage now runs them one at a time. A release whose forget was refused (a waking session) left the assistant placed but ungranted and unpolled; release now owns the forget and restores both. A grant change with no runner started none; it now starts one, and refuses when the assistant does not live there. A folder reached through a link launched with the link's spelling while the tools reached its target; the launch refuses it. A 404 retried every minute and a secondary rate limit without `retry-after` stopped the watcher; a 404 now stops with the scope reason and a secondary limit backs off five minutes. A move missed a Gateway it could not read and drew a mutation's answer unfenced; it now names an unread Gateway with the ones that did not let go, and draws only the fenced read after a change. The grant sheet stayed bound to a home that moved; it now closes. The sandbox placed on a never-registered Gateway. On the re-check: a queued op ran after shutdown, and a grant write that did not land answered as if it had; ops now refuse once the stage stops, stop waits up to five seconds for one already running, and a grant that does not read back refuses.
- **Accepted:** two phones moving at once can each leave a home; one owner, so no lease. A phone older than this build lists the assistant in Sessions, and fails to decode `vault_grants` once a watcher grant exists; both update together, Gateway first. A newer phone against an older Gateway reads it as holding no assistant. The first poll takes the 500 most recent notifications; older ones past the cap are not read. A released assistant's thread stays in Sessions as an ended conversation until forgotten.

### Bug Classes

- **Mechanism:** the assistant stage's owner ops (`place`, `release`, `setWatcherGrants`) over its runner and the session record.
- **Defect class:** an op that awaits leaves the runner and record half changed for the next op to observe.
- **Round 1 (red team):** serialized every op, and release now restores what it took when its forget is refused.
- **Round 2 (re-check):** ops refuse after shutdown, stop waits for one running, and a grant write is read back.
- **Design fix (architecture):** the session record is the one commit point. Release forgets first, whose refusal changes nothing, then saves the session records checked, then stops the watchers and drops their grants as cleanup; a grant left behind is inert once nothing is placed, and the release answers naming it. Place saves checked before it answers, so the phone never releases the old home for a placement a crash would lose. The compensation code is gone, and no state a read or a restart sees is half released. The shutdown drain beyond this is board item `bd_f506`.
- **Round 3 (re-check of the design fix):** its failure paths. A place whose save fails now takes its record change back, so the persist tick cannot save a refused placement. A release past its forget finishes the teardown whatever the save says, answers that it is not yet saved, and a retry saves again. A new placement drops any grant an interrupted release left, so a leftover is never reused.

## Phase 5 - Rules

- ✅ **Record:** each watcher's ordered rule list, first match wins, ending in a catch-all. A rule is one or more conditions joined by "and", each a field, a test and a value, and an action: `wake`, `inbox` or `drop`, with an optional ping override. Each watcher declares its fields (GitHub: reason, repository, type, title) and its ping default. The phone edits a rule in a sheet (the `assistant-rule-editor` card), never as JSON.
- ✅ **Preview:** the editor shows how many of the watcher's last 50 events the rule would have matched, and saving replays kept drops it now catches.
- ✅ **Store:** `createRulesStore`, sole writer, revisioned, with `canonicalRule` and `rulesRefusal` in `schemasAssistantRules`. **Deviation:** one op, `assistant_rules_put`, carries the whole list at its base revision, so delete and reorder are puts; the list rides in `assistant_state` rather than a list op. `assistant_rules_preview` answers the preview.
- ✅ **Phone:** Assistant settings lists the watchers, and a watcher's Rules button opens its list and editor. `RuleDraft.kt` holds the decisions and every list edit. **Deviation:** a sheet from settings rather than a watcher screen, and the dropped events show as a count with no Recent list.
- ✅ **Drops stay undoable:** a rule-dropped event is kept for 7 days. Each rule edit sorts the kept drops again through the inbox store, and one that now wakes or goes to the inbox gets a fresh delivery sequence. An evicted event is never sorted again. That keeps rule edits undoable under Question 4. Kept drops are capped at 1,000 per watcher (`DROP_CAP`), and a drop past it is not counted as evicted.
- ✅ **Replay survives a crash:** the inbox keeps the rules revision it last sorted under, advanced in the same checked commit as the re-sort. At start, an inbox behind the rules store replays again.
- ✅ **The inbox file survives the change:** the decision and the revision land as optional fields on v1. The row's rule decision (action, ping, rules revision) is recorded where sorting first happens.
- ✅ **Owner-only:** only owner ops write rules, so injected event text cannot rewrite the rules that sort later events. The gate's `watchers/` protection is gone.

### Alignment

- **Fixed:** a resort sorted drops past their 7 days, and the drop count, the preview and the unread count read rows a write would prune; reads now take the clock. A replay whose write failed waited for the next start; every poll's write now catches up an inbox behind the rules. Ping decisions sat in the Composable, and a drop's stored decision could ping; a drop never pings, and the Gateway stores it without an override. The docs promised a watcher screen with Replay.

### Red team

- **Fixed:** a rules file that started fresh (quarantined, deleted, or a later build tightening the schema) stranded kept drops until its revision passed the inbox's; the inbox now sorts again whenever its revision differs. The preview tested a rule alone, so a rule an earlier one shadows reported matches it would never decide; it now runs at its place in the list and counts what an earlier rule takes. A preview answered for an unknown watcher or an undeclared field; it now refuses what a put refuses. A refused delete showed the raw revision text, and the rule and grant sheets could reopen after the assistant moved away and back.
- **Accepted:** restored rules pass the schema only, as runbooks and routines do; a watcher must not retire a field without migrating its rules, since `is_not` on a missing field matches everything. A failed catch-up on a stopped watcher waits for the next start, grant change or save. Case is ignored with `toLowerCase`, not full Unicode folding. Contradictory conditions are the owner's to see in the preview. A rescued drop can be one already handled at its source. Rules and the inbox stay with their Gateway across a move.

### Bug Classes

- **Mechanism:** the phone rule editor's save over the whole-list put (`afterRefusal`, `rulesStore.put`).
- **Defect class:** a positional whole-list put leaves the phone guessing, after a refusal, which row the owner meant and whether their write already landed.
- **Round 1 (alignment):** the editor kept its opened copy, so every retry after a stale refusal was refused again. Patched with a rebase while the edited row stands, and a lost-answer retry the store answers as stored.
- **Round 2 (re-check):** the catch-all rebased unchecked, and a lost-answer New could append twice. Patched with `afterRefusal` reading Landed, Over or Stuck per slot.
- **Round 3 (red team, accepted):** a concurrent refresh can win the read fence, so the editor decides from a copy older than the refusal and reads Stuck; the next tap recovers. This is also the second instance of the painpoint "A fenced read cannot inform a decision".
- **For architecture:** rules carry no identity, so every edit is positional. A stable rule id, with single-rule ops the store merges, would let the Gateway decide rather than the phone guess.

## Phase 6 - Wake and held delivery

- **Wake:** a typed, senderless assistant-event input to the shared send path in `routesSend`, with no `from`, conversation id or return route. It shares target resolution, `tryWakeTeam` and `ChannelDeliveryCoordinator` with ordinary sends, under a delivery id derived from the event. A wake-sorted event lands as `inbox` and moves to `woken` in a checked commit once the wake lands, so a failed wake leaves it in the inbox. The rule's decision (action, ping, rules revision) is stored on the row apart from its disposition, so wakes are driven from durable inbox state after a restart and never re-derived from the rules; `onAccepted` is at most a nudge. Channel acknowledgment never moves an inbox read position.
- **Data only:** an `event` variant on `ChannelPushPayload` and `PendingDelivery`, kept through the durable delivery row. `emitChannelNotification` omits `meta.instructions` and reply fields for it; `no_ack` still sets instructions, so it is not this. `CHANNEL_INSTRUCTIONS` names the marker once: data, no `channel_reply` owed. The body still goes through `composeModelMessage` and `neutralizeMarkup`.
- **Ping:** in this slice the event carries the resolved ping as a data line, and `AGENTS.md` tells the assistant to notify the owner only when it says yes. The phone-side flag comes with the phone view.
- **Inbox:** `flush(watchers)` answers a batch id with the per-watcher boundaries it read. A separate confirm advances only those boundaries in a checked inbox commit; an unconfirmed batch is answered again. Flushes are serialized per watcher. The `inbox` tool calls flush and confirms once its result is returned, registered only after the identity check.
- **Phone:** the Assistant tab shows the conversation and the inbox strip, one chip per watcher with its inbox count, and a yellow chip for a watcher that needs a secret, opening settings.
- **Baseline:** an assistant section in `SessionBaselineSchema`, served by `createBaselineRoutes` for the assistant session only and rendered by `linesOf` after agents and before the board. `renderBaseline` stays the sole owner of order and budget.

## Gates, every phase

Tests per mechanism: timing on the injected ambient, restore after restart, fake GitHub responses, rule parsing, wake, baseline, and the gate's allow and deny table. Then `check:boot`, `kotlin-gate.sh` for any schema change (the vault holder and rule changes carry the Kotlin models, the Assistant tab and settings, and `GrantSecretsSheet`), the Gateway deployed first, and `docs/assistant.md`, `docs/vault.md`, `docs/environment.md` and the `AGENTS.md` map updated, `main-session-hook` as both the compact and the PreToolUse entry.

## Next slice

- **Check-ins:** routines aimed at the assistant, listed in Assistant settings. `delivers: [...]` needs the schema field, `Protocol.kt` and the phone's routine editor, or the editor drops it on save. A check-in nudges the assistant session rather than opening its own.
- **Phone:** a per-row ping flag through the owner rows, and summoning the assistant by holding power or from the lock screen.
- **Actions:** cards, Undo, and marking GitHub threads read.
- **Timed compaction:** fires at a due time only when the REPL is idle, and skips while a card is open. Its interval is set in Assistant settings.
- **Sources:** Gmail, then phone events.

## Painpoints

- **Path rules re-derived per caller:** `src/mcp/workspace/confine.ts:confine` says it is not a security boundary, yet the assistant gate leaned on it as one, and three red-team rounds found spellings it and the tools read differently. Any new "only this folder" need should start from the tool's own enforcement, not another derivation.
- **Provenance is a caller-formable string:** `mintedFrom` is `${conversationId}:${opId}`, and a console op picks both, so `routineOwns` and `isAssistantRecord` can be satisfied by an owner op that means something else. A field only the Gateway writes would make ownership unforgeable.
- **No per-session tool scope in the MCP server:** registration is capability-gated machine-wide, so scoping one session meant wrapping `registerTool` (`src/mcp/assistant/instructions.ts:scopeTools`). A declared scope per registrar would replace the wrapper.
- **Manual fake time races microtasks:** `src/testing/fakeAmbient.ts:fakeAmbient:advance` fires the first due timer before yielding, so an answer resolved just before `advance` loses to a deadline that lands in the same call whenever its promise chain is one hop deeper. Adding an abort race inside `answerOf` flipped a passing test into a 721-poll loop. Manual drive also reads the real clock unless `now` is pinned. Tests now settle with `advance(0)` after each answer and pin `now`; yielding once before the first firing would remove the trap.
- **No commit spans two stores:** the assistant's release touches the session record (`src/shared/session-store.ts`, flushed by `composePersistence`), the vault decisions file and the runner, each durable on its own schedule. Ordering them by hand and writing every failure path took four rounds (`src/gateway/compose/composeAssistant.ts:composeAssistant` release, recorded under Phase 4's Bug Classes). Any later op that moves state across two Gateway stores starts from the same blank page; a small "commit point, then cleanup that is safe to repeat" helper, or one owner-scoped journal, would carry the rule.
- **A fenced read cannot inform a decision:** `android/.../GatewayReads.kt:GatewayReadFence.read` answers `Stale` without the value, so a caller that must act on what a Gateway said (the assistant's move) bypasses the fence and asks directly. Every ops class that one day needs a read to decide will hit the same wall.
- **The cycle's phase text is cached at start:** `cycleStartPlan` copies each phase's detail, so the step prompts kept showing the original Phase 2 after the plan was rewritten.
