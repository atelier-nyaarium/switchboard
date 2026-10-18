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

# Plan

The first slice proves the loop: a GitHub notification lands on the Gateway, a rule sorts it, and the assistant session either wakes or finds it held. Actions with cards and Undo, the phone's Assistant view, Gmail and phone events come after.

The owner talks to the assistant through an ordinary conversation thread until the loop works.

**Open:** the owner's road to a watcher grant. Recommended: the watcher asks once through an ordinary vault request in the assistant's thread, and the request sheet gains an "Allow always" button for a watcher holder. The alternative is a grant picker on the vault entry's screen. Either is a phone change.

**Verified live on 2026-10-17:** a conditional GET with `If-Modified-Since` answers 304 and leaves `x-ratelimit-remaining` unchanged. The first GET carries `last-modified` and `x-poll-interval: 60`. Still from the docs only: the rate-limit response, 403 or 429 with `x-ratelimit-reset` or `retry-after`.

## Phase 1 - Design doc

Write `docs/assistant.md` from the questionaire: the session, notes, the gate, effects, triggers, base types, digest, reminders.

✅ Written, aligned, red-teamed and committed in `ec2d576a`. The red team and architecture audits reshaped Phases 2-6 below.

## Phase 2 - Notes workspace, session and interim gate

- **Notes:** `~/projects/notes/` under git. `AGENTS.md` holds the standing rules and names the note files; the fixed sections (open threads, pending asks, decisions, commitments) live in their own writable files.
- **Identity:** `SessionRecord` carries a persisted assistant role, held by at most one record, checked on assign and on restore. An assistant provisioner on the Gateway sets the role, then launches once through the existing `createSession` road on the `host` spawn point with the notes working directory; reattach keeps the role. Generic forget refuses the assistant record. Identity is never inferred from spawn point, working directory, label or `mintedFrom`. `tryWakeTeam` resumes the session but never mints it.
- **Reservation:** `reservedByRoutine` becomes one `sessionReserved(team)` decision: `routines.reserves(team)` or the assistant role. `SessionStore.sweep` consults it in both the TTL and the capacity pass; liveness stays a capacity-only check. Today the TTL pass deletes by `lastSeen` before any reservation is read.
- **Authority:** `SessionAuthority` answers whether a token is the assistant's. `startMcp` registers assistant tools only on that answer, and every assistant route checks it per request. `/capabilities` stays machine-scoped, since it carries no session identity.
- **Gate hook:** host sessions launch with `--dangerously-skip-permissions`, so a PreToolUse hook is the boundary, not the prompt.
  - **Where:** a second mode of the `main-session-hook` bundle in the plugin's `hooks.json`, with a catch-all matcher and its own handler module, outside anything the session can write. A notes `.claude/settings.json` would be writable or missing.
  - **Who:** the provisioner's launch exports an assistant marker, and the hook also gates any session whose working directory resolves inside notes. Either is enough, so an assistant resumed by hand without the marker is still gated. A shell pre-check exits at once for every other session, so ordinary sessions pay no `bun` start per tool call.
  - **Closed allowlist:** exact names only: `Read`, `Glob`, `Grep`, `channel_reply`, and the assistant's tools from one registry shared with their registration, each declaring its gate class. An unknown name or malformed input denies.
  - **Writes:** `Write`, `Edit` and `NotebookEdit` inside notes. The path rule extends `confine()` to take Claude's absolute and cwd-relative paths and judges the resolved target, never `AGENTS.md`, `.claude/`, `.git/` or `watchers/`. It is a pre-tool path decision, not race-proof isolation.
  - **Refused:** every other tool. That covers `Bash`, `vault_run` (it runs shell commands with no entry), `Agent`, `Workflow`, Codex and Copilot delegation (a child ignores this hook), and other MCP servers' tools.
  - **Output:** a refusal prints `permissionDecision: "deny"` with its reason and exits 0. A processing error exits 2, which blocks.
  - **Replies:** check that the reply route refuses a conversation not addressed to the caller, and bind it there if not.
  - Event text is untrusted data.

## Phase 3 - Event inbox, Watcher type and runner

- **Stage:** an assistant compose stage beside routines. It restores its store before polling, starts on federation activation, and stops and awaits in-flight polls and deliveries before the shutdown flush, as `composeRoutines` does. It resolves the assistant through `SessionStore` and keeps no second session id.
- **Store:** one inbox store, sole owner of events, source cursors, poll health, read positions, dispositions and dedupe state. One versioned snapshot through `openDurable`, changed by one checked commit, following `createOccurrenceStore`. A write that fails before install restores the previous memory state; `DurableStoreInstalledError` counts as landed. `PendingDeliveryStore` stays channel transport, never this inbox.
- **Watcher type:** each validated watcher has a stable id. A poll answers events, backoff or stopped. Each watcher polls on its own interval, serialized per watcher.
- **Durability:** a poll's events, its new cursor and its health land in one checked commit. A failed write keeps the old cursor. Events carry stable source ids, and dedupe identity outlives the event row by the retention window, so a late replay cannot resurrect it. Every held or wake-eligible event is delivered at least once.
- **Dispositions:** `held`, `woken`, `ruleDropped` (re-sortable for 7 days) and `evicted` (final, by overflow). An event that becomes eligible again gets a fresh delivery sequence and keeps its source id, so an advanced read position cannot skip it.
- **Limits:** an inbox cap and a retention window for held items. Overflow evicts the oldest held items, and the count rides in the reminder lines.
- **Health:** each watcher's last success, next poll, backoff and stopped state survive a restart and ride in the reminder lines.

## Phase 4 - GitHub notifications watcher

- Polls `/notifications` with `If-Modified-Since`, honors `X-Poll-Interval` with a 60-second fallback, and backs off on rate limits. Its cursor and events commit through the inbox store as one transaction.
- Read-only: it never marks a thread read on GitHub. Marking read is an action, next slice. Tested against fake responses.
- **Holder:** `watcher` joins `VaultHolderSchema` as the third kind, with a stable `watcherId`; the comment naming `remote` as the third kind is updated. The grant type encodes the valid pairs rather than leaving them to `holderFitsTier`: a session holds window or session grants, a routine or a watcher holds a standing one. `covers` matches a watcher by id; routine liveness stays tied to its session. Today a standing grant belongs only to a routine with an open occurrence.
- **Owner's grant:** per the Open item. Under the recommended road, an entry request carries its holder apart from `sessionTarget`, which only routes the row to the assistant's thread, and requests match by holder. The sheet offers "Allow always" only for a watcher, mapped to a standing grant; window and session are refused for one. The grant commits before the request settles approved. The watcher's rule file names its entry; only the owner's tap grants it.
- **Gateway read:** the `/vault/use` flow (`ready`, `usable`, `decide`, `release`) moves into one `createVaultUse` service composed by `composeVault`. The route and a `readForWatcher` port both call it; `covers` stays the grant predicate, and the entry and the Gateway allowlist are resolved again before release. `openValue` stays decrypt-only.
- **Lifecycle:** an accepted rules reload that removes a watcher retracts its open requests and prunes its grants. A rejected reload keeps both.

## Phase 5 - Rules

- `watchers/*.yaml` in notes sort each event: wake, hold, drop. Each watcher declares its ping default; a rule can override it. A watcher's file names its vault entry.
- **Reaching the Gateway:** the Gateway container mounts only its log and data, so Compose adds a read-only mount of the notes `watchers` directory, configured per host.
- **Parsing:** a schema validates each file. A reload is all-or-nothing: a bad file keeps the last valid set and puts the error in the reminder lines. The parser is Bun's built-in YAML behind an injected parse, so Vitest under Node can run it, or an exact-pinned `yaml` package.
- **Drops stay undoable:** a rule-dropped event is kept for 7 days. Each accepted reload sorts the kept drops again through the inbox store, and one that now wakes or holds gets a fresh delivery sequence. An evicted event is never sorted again. That keeps rule edits undoable under Question 4.
- **Owner-only:** Phase 2's path rule refuses assistant writes to `watchers/`, so injected event text cannot rewrite the rules that sort later events. Nothing here adds a second write check.

## Phase 6 - Wake and held delivery

- **Wake:** a typed, senderless assistant-event input to the shared send path in `routesSend`, with no `from`, conversation id or return route. It shares target resolution, `tryWakeTeam` and `ChannelDeliveryCoordinator` with ordinary sends, under a delivery id derived from the event. A failed wake leaves the event held. Channel acknowledgment never moves an inbox read position.
- **Data only:** an `event` variant on `ChannelPushPayload` and `PendingDelivery`, kept through the durable delivery row. `emitChannelNotification` omits `meta.instructions` and reply fields for it; `no_ack` still sets instructions, so it is not this. `CHANNEL_INSTRUCTIONS` names the marker once: data, no `channel_reply` owed. The body still goes through `composeModelMessage` and `neutralizeMarkup`.
- **Ping:** in this slice the event carries the resolved ping as a data line, and `AGENTS.md` tells the assistant to notify the owner only when it says yes. The phone-side flag comes with the phone view.
- **Held:** `flush(watchers)` answers a batch id with the per-watcher boundaries it read. A separate confirm advances only those boundaries in a checked inbox commit; an unconfirmed batch is answered again. Flushes are serialized per watcher. The `held` tool calls flush and confirms once its result is returned, registered only after the identity check.
- **Baseline:** an assistant section in `SessionBaselineSchema`, served by `createBaselineRoutes` for the assistant session only and rendered by `linesOf` after agents and before the board. `renderBaseline` stays the sole owner of order and budget.

## Gates, every phase

Tests per mechanism: timing on the injected ambient, restore after restart, fake GitHub responses, rule parsing, wake, baseline, and the gate's allow and deny table. Then `check:boot`, `kotlin-gate.sh` for any schema change (the vault holder and request change carries the Kotlin models and `VaultRequestSheet`), the Gateway deployed first, and `docs/assistant.md`, `docs/vault.md` and the `AGENTS.md` map updated, `main-session-hook` as both the compact and the PreToolUse entry.

## Next slice

- **Routines:** `delivers: [...]` needs the schema field, `Protocol.kt` and the phone's routine editor, or the editor drops it on save. A routine also needs to nudge the assistant session rather than its own.
- **Phone:** the Assistant root view, a per-row ping flag through the owner rows, and summoning it by holding power or from the lock screen.
- **Actions:** cards, Undo, and marking GitHub threads read.
- **Timed compaction:** fires at a due time only when the REPL is idle, and skips while a card is open.
- **Sources:** Gmail, then phone events.
