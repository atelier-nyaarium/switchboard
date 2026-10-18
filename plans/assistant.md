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

## Phase 2 - Notes workspace, session and interim gate

- `~/projects/notes/` under git. `AGENTS.md` holds the standing rules and names the note files; the fixed sections (open threads, pending asks, decisions, commitments) live in their own writable files.
- **Session:** the `host` spawn point with `~/projects/notes` as its working directory, created once as a stable named session and resumed, never recreated. A spawn point here is `host` or `windows`; notes is a working directory.
- **Reservation:** both the 30-day session sweep and the capacity sweep skip the assistant session. Today `reservedByRoutine` guards only the capacity pass, and the TTL pass deletes by `lastSeen` first.
- **Assistant identity:** the Gateway records which session is the assistant, and its spawn marks it. The plugin registers assistant tools only there, and assistant routes refuse any other token. The shared `/capabilities` list carries no session identity, so it cannot be the check.
- **Gate hook:** host sessions launch with `--dangerously-skip-permissions`, so a PreToolUse hook is the boundary, not the prompt. It ships in the plugin's `hooks.json`, outside anything the session can write, and applies to the marked session. A notes `.claude/settings.json` would be writable or missing.
  - **Closed allowlist:** reads, `channel_reply` on its own conversation, and the assistant's tools.
  - **Writes:** `Write`, `Edit` and `NotebookEdit` inside notes, judged by the resolved path so a symlink cannot leave, never `AGENTS.md`, `.claude/`, `.git/` or `watchers/`.
  - **Refused:** every other tool. That covers `Bash`, `vault_run` (it runs shell commands with no entry), `Agent`, `Workflow`, Codex and Copilot delegation (a child ignores this hook), and other MCP servers' tools.
  - Event text is untrusted data.

## Phase 3 - Event inbox, Watcher type and runner

- **Stage:** an assistant compose stage beside routines. It restores its store before polling, starts on federation activation, and drains before the shutdown flush, as `composeRoutines` does.
- **Watcher type:** a poll answers events, backoff or stopped. Each watcher polls on its own interval, serialized per watcher.
- **Durability:** a poll commits its events and the new cursor in one checked snapshot. A failed write keeps the old cursor. Events carry stable ids, so a replay after a crash dedupes. Every event the inbox keeps is delivered at least once.
- **Limits:** an inbox cap and retention window. Overflow drops the oldest held items, and the count rides in the reminder lines.
- **Health:** each watcher's last success, next poll, backoff and stopped state survive a restart and ride in the reminder lines.

## Phase 4 - GitHub notifications watcher

- Polls `/notifications` with `If-Modified-Since`, honors `X-Poll-Interval` with a 60-second fallback, and backs off on rate limits.
- Read-only: it never marks a thread read on GitHub. Marking read is an action, next slice.
- Tested against fake responses.
- **Grant:** a `watcher` kind on `VaultHolder`, standing and entry-wide; today a standing grant belongs only to a routine with an open occurrence. The watcher's rule file names its entry, and only the owner's grant opens it. The owner's road to that grant is open, below.
- **Gateway read:** the session-bound `/vault/use` route cannot serve a watcher, and `openValue` checks no grant. An internal use refreshes the entry, runs the grant check and the Gateway allowlist, and fails closed.

## Phase 5 - Rules

- `watchers/*.yaml` in notes sort each event: wake, hold, drop. Each watcher declares its ping default; a rule can override it.
- **Reaching the Gateway:** the Gateway container mounts only its log and data, so Compose adds a read-only mount of the notes `watchers` directory, configured per host.
- **Parsing:** a schema validates each file. A reload is all-or-nothing: a bad file keeps the last valid set and puts the error in the reminder lines. The parser is Bun's built-in YAML behind an injected parse, so Vitest under Node can run it, or an exact-pinned `yaml` package.
- **Drops stay undoable:** a dropped event is kept for 7 days. Each reload sorts the kept drops again under the new set, and one that now wakes or holds is delivered. That keeps rule edits undoable under Question 4.
- **Owner-only:** the gate hook refuses assistant writes to `watchers/`, so injected event text cannot rewrite the rules that sort later events.

## Phase 6 - Wake and held delivery

- **Wake:** goes through the send route's wake path, so an offline session is woken. A failed wake leaves the event held.
- **Data only:** an assistant event carries no `meta.instructions`, which the channel notification sets on every message today. `CHANNEL_INSTRUCTIONS` states once how to treat one.
- **Ping:** in this slice the wake carries the resolved ping as a data line, and `AGENTS.md` tells the assistant to notify the owner only when it says yes. The phone-side flag comes with the phone view.
- **Held:** `flush(watchers)` answers a batch, and the read position moves only when the caller confirms the batch arrived; an unconfirmed batch is answered again. A `held` MCP tool calls it, registered only in the assistant session.
- **Baseline:** held counts and watcher health ride in the reminder block, and join the compaction baseline's schema, route and hook lines. They render before the board, which `renderBaseline` cuts when the budget runs out.

## Gates, every phase

Tests per mechanism: timing on the injected ambient, restore after restart, fake GitHub responses, rule parsing, wake, baseline. Then `check:boot`, `kotlin-gate.sh` for any schema change, the Gateway deployed first, and `docs/assistant.md` and the `AGENTS.md` map updated.

## Next slice

- **Routines:** `delivers: [...]` needs the schema field, `Protocol.kt` and the phone's routine editor, or the editor drops it on save. A routine also needs to nudge the assistant session rather than its own.
- **Phone:** the Assistant root view, a per-row ping flag through the owner rows, and summoning it by holding power or from the lock screen.
- **Actions:** cards, Undo, and marking GitHub threads read.
- **Timed compaction:** fires at a due time only when the REPL is idle, and skips while a card is open.
- **Sources:** Gmail, then phone events.
