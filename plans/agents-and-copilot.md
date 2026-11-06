# Questionaire

## Question 1 - When does an agent start answer?

Q: Should `codexStartAgent` and `copilotStartAgent` (and message) return before the daemon accepts the turn, or once it has?
A: Once the daemon accepts the turn. A failed start still answers with its error.

## Question 2 - The 10-minute progress notice

Q: Push the no-act progress notice only while the session is working, or always?
A: Always, Claude sessions only, since it rides the channel push. Classified `no_act`, so the session reads it and ends its turn quickly unless something is steering very wrong.

> Claude only since channel sdk. and yes let it ping the idle session. It should be classified as a no act, so the agent just sees it and ends turn quickly. unless something is steering very wrong.

## Question 3 - Copilot delivery

Q: Type a delivery into the Copilot pane when its composer is idle, or a long-poll tool?
A: Type it into the message box when idle.

## Question 4 - Which spawn points get the Claude | Copilot toggle

Q: Linux/WSL host only, or Windows too?
A: Both WSL and Windows. The work computer is set up the same as Mikan.

## Question 5 - Spending Copilot for testing

Q: May the Copilot subscription be used on this machine for TUI captures and the walk?
A: Yes, exclusively for testing: capturing patterns and building the Copilot features.

## Question 6 - Tool description length

Q: How is the 1024-character limit enforced?
A: The engine throws at registration, and the build fails. Shipped in `012a6019`.

> Let's make the Switchboard engine itself throw an error instantly upon any listed tool being above character count. So we know sooner. Should fail build.

# Plan

## Phase A - Small fixes (shipped, 8.14.31 and 012a6019)

- Every tool description and field description at most 1024 characters, guarded at registration and in the build.
- Codex threads start with `danger-full-access`. Daemon-backed agents need `./start-host-daemon.sh`.

## Phase B - Async agents

- Gateway: `codexRoute` and `copilotRoute` `settle` waits for daemon acceptance only on start and message; await keeps waiting for the turn.
- Local backend (`src/mcp/local/`): start and message return once the turn is started.
- Awareness: an agent subscriber fed by a 5-second watch over both catalogs. Completion is `act_now`, naming the agent and the await tool. Progress is `no_act` but pushed, every 10 minutes while a turn runs, carrying the newest short turn notes. The awareness bank needs a push flag for a `no_act` change.
- Gateway activity retention keeps the newest notes once capped (`agent-record.ts`), as the local runtime does.
- Local mode emits the same notices from the MCP process through the channel emitter.
- Tool descriptions for start, message and await say how results arrive.

## Phase C - Copilot sessions

- The harness (`claude` or `copilot`) on the session record, chosen at create, fixed for the session's life.
- Launch: `copilot --allow-all --model ...` with `--session-id` minted at create and `--resume` on wake; WSL and Windows spawns.
- The daemon reports which CLIs each spawn point has; the phone's create dialog shows Claude | Copilot above the project pick only when both are present.
- Delivery: a Copilot session's channel rows are typed into its pane when the composer is idle, carrying the session id, sender, instructions and awareness; acknowledged once typed.
- A Copilot pane reader (TS and Kotlin twins) from real captures: ready, working, composer empty, blocking prompts.
- No handshake, compaction hooks or Claude permission prompts for a Copilot session; capability guidance is typed with the first delivery.

### Copilot TUI facts (captured 2026-11-05, Copilot CLI 1.0.83, frames in the session scratchpad `copilot-cap/`)

- Launch with `copilot --allow-all --model gpt-6-luna` still opens a boxed "Confirm folder trust" prompt: `1. Yes`, `2. Yes, and remember this folder`, `3. No (Esc)`, footer `↑/↓ to navigate · enter to select · esc to cancel`. Answer `1` (or `2`).
- Idle: a status row (`<cwd> ... Session: N AIC used`), then a rule, the composer `❯ ` with typed text after it, a rule, and a footer (`v… · / commands · ? help · ... <model>` idle, `@ files · # issues ... <model>` while typing).
- Working: the footer becomes `<glyph> Working[ · 470 B] esc interrupt ... <model>`, the glyph cycling (`◎`, `●`, `◉`). Transcript rows: `❯ <prompt>  HH:MM`, `❯ Thinking…`, `❯ Thought for 1s`, `$ Shell <title> N lines…`, `● <reply>`.
- Delivery: `tmux load-buffer` then `paste-buffer -p` lands a multi-line message as one composer entry; `Enter` submits it. A `<channel ...>` wrapped message was read and answered.
- Launch with `--no-ask-user` so the agent never blocks on a question in the pane.

### Phase B status

- Built, uncommitted: routes answer `accepted`, `agentAwareness.ts` watch and subscriber, bank `push`, `agent-notice.ts` shared wording, local `notify` and `acceptedAnswer`, newest-window activity retention, tool descriptions. Tests being updated by a Codex Luna agent.

## Phase D - The walk

- A Copilot session on Switchboard running gpt-6-luna starts a Codex agent that mulls for 5 minutes and reports back with a poem, exercising Phase B's notices end to end.
