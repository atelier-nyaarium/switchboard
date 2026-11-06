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

## Question 7 - Restarts

Q: May I restart the Gateway and host daemon to deploy?
A: Yes, always. No need to ask again.

> yes always

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

- Shipped: `424f00d3`, plugin 8.14.32. Needs a Gateway restart (the watch) and a host daemon restart (Codex full access) to go live; asked the owner.

### Phase C status

- Slices 1 to 4 shipped in `7faf0991`: harness on the record (`harness`, `copilotSessionId` via `uuidGen`), `create_session.harness`, host create and wake carry it, `buildLaunchCommand` builds the Copilot launch (`agentArgs`, `copilot` / `copilot.exe`, `AGENT_TYPE=copilot` exported and crossed via WSLENV), `COPILOT_TRUST_RE` answers the trust box with `1`, `COPILOT_WORKING_RE` in both readers, five Copilot vectors.
- Slices 5 and 7 shipped in `dacddfe9`, plugin 8.14.33: the plugin types each push through `POST /session/type` into the pane (`typeIntoPane` host op, bracketed paste on an idle, empty composer, busy then retried); the daemon reports `copilotSpawns`; the phone's create dialog picks Claude or Copilot.
- `1ac559c6`, plugin 8.14.34: the daemon also reports `claudeSpawns`; the terminal view's install macros come in a Claude pair and a Copilot pair, each gated on its CLI (both where neither is); the README gained Copilot setup.
- Slice 6 and the live walk's fixes, reviewed by the Copilot session Testing: a Copilot session confirms at registration by its launch token and a second socket under it is refused; every hook carries `bash` and `powershell` no-ops, since Copilot drops `args` and denies every tool on a hook error (the work computer's crash); typed text loses control characters; a typing key replays a retry; a 503, 504 or network failure backs off and gives up after 15 minutes; Copilot gets MCP instructions with the full guidance, no progress notices and no Claude slash-command tools; ACP chunks form one note per message; the 1.0.106 working footer (`ctrl+c interrupt`) is read; an unauthorized registration stops reconnecting.
- Follow-ups on the board under slice C.

### Phase C design

Slices, each committed on its own:

1. **Harness on the record and the wire.** `SessionRecord.harness?: "claude" | "copilot"` (absent is Claude), persisted in the session-store snapshot; `create_session` takes an optional `harness`; the host create and wake ops carry it. A Copilot session mints its own UUID at create (`copilotSessionId`), launched with `--session-id` the first time and `--resume` after. The harness is fixed for the session's life.
2. **Launch.** `buildLaunchCommand` builds `copilot --allow-all --no-ask-user [--session-id|--resume] <uuid>` with `AGENT_TYPE=copilot` exported beside `PROJECT_NAME` and the token, since `detectAgentType` picks Claude when both are installed. Windows: check how Copilot is installed on Mikan (`ssh mikan`) before choosing `copilot.exe` or the npm shim. No `--model`: Copilot's own default, unless the owner wants one.
3. **Daemon readiness.** Answer Copilot's "Confirm folder trust" box with `1`, as the Claude trust prompt is answered.
4. **Pane reader.** TS and Kotlin twins in `agent-screen` gain Copilot reads: working when the footer after the last rule shows `Working ... esc interrupt`; ready when the `❯` composer sits between rules; composer empty when nothing follows `❯`. Vectors from the captured frames.
5. **Typed delivery.** The Gateway keeps the delivery queue as is. For a Copilot session, a pending row is handed to the host daemon instead of a socket: the daemon waits until the pane reads idle with an empty composer, pastes the rendered `<channel ...>` message with `tmux paste-buffer -p`, presses Enter, and the Gateway acknowledges the row. The rendering reuses `composeModelMessage`, so session id, sender, instructions, awareness and files read as they do for Claude. Progress notices are Claude-only, so the agent watch skips pushing `no_act` progress to a Copilot session; completions still go.
6. **No handshake.** A Copilot session counts as confirmed without the `isMainOrLead` handshake; its first delivery carries the capability guidance.
7. **Detection and the phone.** The daemon reports which CLIs each spawn point has (`claude`, `copilot`) on its spawn records; the phone's create dialog shows a Claude | Copilot pick above the project pick only when the chosen spawn point has both.

## Phase D - The walk

- A Copilot session on Switchboard running gpt-6-luna starts a Codex agent that mulls for 5 minutes and reports back with a poem, exercising Phase B's notices end to end.
- Passed 2026-11-06 00:50: completion typed into the idle pane, poem shown, no progress pings for a Copilot owner.

## Question 8 - ACP or the SDK protocol for Copilot agents?

Q: Keep driving Copilot agents over ACP, or move to the SDK protocol (`copilot --headless --stdio`)?
A: Switch to the SDK protocol. Copilot's own Dynamic Workflows stay off.

> "switch it. But we won't enable their Workflows, because I need it to be agnostic and Switchboard driven."

## Phase E - Copilot agents on the SDK protocol

### Wire facts (probed 2026-11-06 on Copilot CLI 1.0.106, headless protocol version 3)

- Transport: `copilot --headless --stdio`, JSON-RPC 2.0 with `Content-Length` framing (ACP used newline framing). `ping` answers `{protocolVersion: 3}`; refuse anything else. `connect` is optional and takes `editorName`, `editorVersion`, `extensionName`, `extensionVersion`.
- `session.create {workingDirectory, model, reasoningEffort, clientName, streaming: false}` answers `{sessionId}`. `session.resume {sessionId, workingDirectory}` in a fresh process restores the conversation; a tool call left pending completes as failed.
- `session.permissions.setApproveAll {sessionId, enabled: true}` approves tool prompts only: a shell call runs, but a read outside the working directory is still denied ("could not request permission from user"). `session.permissions.setMode {sessionId, mode: "allow-all"}` approves tools, paths and URLs, and is what the client sets after create and resume. Agents keep full access, as Codex does.
- `session.send {sessionId, prompt, mode?: "enqueue" | "immediate", wait?: boolean, responseFormat?: {type: "json_schema", jsonSchema: {name, schema, strict?}}}` answers `{messageId}`. `mode: "immediate"` steers the running turn. `session.abort {sessionId, reason: "remote_command"}` ends it: `abort`, `assistant.turn_end`, `session.idle {aborted: true}`.
- Events arrive as `session.event` notifications `{sessionId, event: {type, data, id, timestamp}}`. The ones folded: `assistant.message` (whole `content`, `originatingMessageId` names the send), `tool.execution_start` (`toolName`, `arguments`), `tool.execution_complete` (`success`), `session.idle` (`aborted?`), `session.error` (`errorType`, `message`), `abort`, `assistant.usage`, `session.compaction_start` and `session.compaction_complete`.
- The runtime's `turnId` is `"0"` on every message, so our minted turn ids stay and a turn is the events between its send and `session.idle`.
- `responseFormat` is enforced by the provider: asked for purple under a red, green or blue enum, gpt-6-luna could only answer blue. Every catalog model reports `structured_outputs: true`. `models.list` carries each model's `supportedReasoningEfforts` (the gpt-6 family includes `none`) and price category.
- The npm `@github/copilot-sdk` depends on `koffi`, a native FFI module, so the protocol is spoken directly, as the Codex App Server is.

### Two slices, each one commit and one deploy

1. **The protocol switch, plugin side only.** `copilotHeadless.ts` replaces `copilotAcp.ts`: a Content-Length JSON-RPC transport over the child and `CopilotHeadlessClient` (`open` pings and refuses a protocol version other than 3; `createSession({cwd, model, reasoningEffort})` creates then approves all; `resumeSession`; `send`; `steer`, a send in `immediate` mode; `abort`; `listModels`; `onEvent`). An unknown server-to-client request is answered method-not-found; none is expected without handlers configured. `HeadlessTurn` folds one session's events into notes (a non-empty assistant message, a tool label with its command) and a terminal (`session.idle` completes with the last assistant message, `aborted` interrupts, a `session.error` before idle fails), replacing `AcpTurnText`. `copilotTargets.ts` spawns `copilot --headless --stdio` on the host, in a container and on Windows; the child still loads the owner's plugins, so the hook no-ops stay load bearing. `copilotDaemonService` and `CopilotLocalSession` ride the new client with their commands, receipts and events unchanged, so the Gateway is untouched; a message while working is still refused until slice 2. Tests: `copilot-headless.test.ts` replaces `copilot-acp.test.ts` (framing, the protocol refusal, create then approve-all, send, steer and abort params, the fold), the daemon test drives `session.event` shapes, `codex-failure-residue.test.ts` names the new file. Docs: `docs/agents.md`, the AGENTS.md map line, the Copilot guidance and `docs/architecture.md` drop ACP. Deploy: plugin release, daemon restart.
2. **Steer, effort and schema on the wire.** `CopilotDeliverySchema` gains `steered`, the `message` command gains `expectedTurnId`, the `start` command and `copilotStartAgent` gain `reasoningEffort` (refused when the catalog does not list it for the model), and start and message gain `outputSchema?` for both families: Codex `turn/start.outputSchema`, Copilot `responseFormat` with `strict: true`; the terminal's `finalResponse` is the JSON text as written, and the caller validates. The daemon steers when `expectedTurnId` names the active turn and falls through to a new turn when it just settled, as Codex does; the local backend implements `steerTurn`. `copilotAgentApply` and the reducers accept a steered receipt the way `codexAgentReducers` does; `copilotRoute.message` passes the agent's `activeTurnId`; the MCP descriptions say a running turn is steered. Tests for the steer case and the schema pass-through on both relays. Deploy: Gateway first, since `steered` is a new enum value it parses strictly, then plugin release and daemon restart.

### Verification

- From this session: `copilotStartAgent` with an effort, `copilotMessageAgent` into the running turn (steered), `copilotStopAgent`, then a follow-up on the idle agent (followup) and a start on a container target, which checks the container's Copilot answers protocol version 3.
- A Copilot session reviews the batch (one Testing lap) once the owner creates one.
- The compaction watcher keeps following the next Copilot TUI session; a compaction under the headless runtime shows as `session.compaction_start` on an agent too, which the fold can note.

### Phase E status

- Slice 1 shipped 2026-11-06: `copilotHeadless.ts` under the daemon and the local backend, `--headless --stdio` launches, ACP removed. Proven live through the launcher before the gates: 12 models listed, a gpt-6-luna session created, `echo hiii` run with the notes `bash: echo hiii` and `hiii`, terminal `completed`. A message while working is still refused.
- Slice 2 next.
