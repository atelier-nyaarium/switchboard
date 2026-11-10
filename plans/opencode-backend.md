# Questionaire

OpenCode as a session harness beside Claude Code and Copilot, for sessions and the assistant. Create dialog order: Claude | OpenCode | Copilot.

Research digests (session scratchpad, not in the repo): `opencode-seam-map.md` (every place Switchboard knows a session's CLI; only `RESTART_SIGNALS` is a per-backend table, about 16 Copilot seams are `=== "copilot"` checks) and `opencode-research.md` (OpenCode V1 1.19.5 and V2 2.2.6: run modes, API, events, permissions, MCP, compaction, auth, verified from source).

## Question 1 - How does Switchboard drive an OpenCode session?

Q: Pane only as Copilot, pane for the owner plus the local API for Switchboard, or API only?
A: Pane for the owner, API for Switchboard. OpenCode's terminal UI runs in the tmux pane, so the phone's terminal view and attaching keep working. Switchboard talks to that same instance over its local HTTP API for state (events), delivery (prompt), approvals (permission reply) and context (synthetic input, instruction entries). No screen reading or typing for this backend.

> Recommended because screen reading is the most fragile part of Switchboard, and OpenCode is the one CLI with a real control API. Verified from source on both lines: an API prompt appears live in the open UI and joins a running turn at the next step; each session can own its MCP identity (V1 one process per pane; V2 one `opencode serve` per session beside the UI); an API permission reply closes the UI's dialog.

## Question 2 - Which OpenCode line?

Q: V2 pinned, V1, or both behind one adapter?
A: V2 (2.2.6 at the time of asking), pinned. Switchboard installs a pinned version, turns OpenCode's self-update off, and refuses to launch a version outside the range it was built for, as the Router refuses a Gateway behind its protocol floor. Each session runs its own `opencode serve` beside the terminal UI, since V2's standalone mode is sealed off and its default shared service gives MCP children the service's environment. MCP code mode is turned off in the launch config.

> Recommended because building on the line OpenCode is leaving is work done twice; the churn is contained by the pin and the launch check.

## Question 3 - The per-harness table first?

Q: Build one `SessionHarness` record per CLI before OpenCode, or bolt OpenCode on beside each `=== "copilot"` check?
A: The table first. One closed record per CLI (Claude, Copilot, OpenCode) with every seam a field: binary and arguments, delivery road, state source, compaction road, restart signal, slash commands, capability text, phone fields. The checks become lookups and an unknown harness fails to compile. One commit with no behavior change, gated by the Copilot tests, before any OpenCode work. Then OpenCode is one row plus its new roads.

> Recommended by the architecture skill's own measures: the Copilot checks are a structural defect class, `RESTART_SIGNALS` is the half-built table to complete, and the next CLI then costs one record. Owner: "Sounds good. lock it".

## Question 4 - What gets held on an OpenCode session?

Q: A Switchboard-shipped list of scary patterns that ask, OpenCode's default as is, or the list denied outright?
A: Quiet for now. OpenCode's own base policy with no Switchboard list: everything allowed, only `.env` reads ask. No auto-accept flag, so an ask OpenCode does raise reaches the phone's Approve and Deny card over the API. The harness row keeps a slot for extra rules, empty.

> "A. Just quiet for now. don't feel like playing whack a mole."

OpenCode has no judgment of its own: V2's permission engine is an ordered list of wildcard rules (action, resource, effect), last match wins. A scanner splits compound shell commands and checks each part; it does not see inside a script. The `.env` rule names the read action, so only OpenCode's read tool asks; a shell `cat` of the same file is the shell action and runs unasked.

## Question 5 - Does the assistant get OpenCode in this plan?

Q: Sessions first with the assistant later, both now, or sessions only for good?
A: Sessions first. This plan ships OpenCode for ordinary sessions. The harness table carries the assistant's fields from the start, so nothing blocks it. The assistant moves in a later plan, once sessions have run on OpenCode and its guards have their own tests.

> Recommended because the assistant's three guards (the closed tool list, the gate hook, the restart on update) would each be rebuilt on an API that changes every two weeks, before we have lived with it. Owner: "Let's also keep the phase counts lower by merging slices that could be done together."

## Question 6 - Devcontainers in this plan?

Q: Devcontainers folded into Phase 2 with the OpenCode client in the plugin process, the client in the plugin now and containers later, or host only with the client in the daemon?
A: In this plan, with a new shape from the owner. Each devcontainer header gets Start, Stop and Create. A container must be started before a session can be created in it, and only a started container is asked which CLIs it has, so the create toggle offers what that container has installed. The OpenCode API client lives in the plugin process, so host and container run the same code.

> "Change of plans. new start and stop + create button on the devcontainer header. Must start devcontainer to create. and only after started will it be able to query the bins in path"

Today the spawn-point header is display only (`SpawnPointHeader`), its awake and asleep describe sessions and not the container, no start or stop operation exists, and a container starts as a side effect of a create or a wake.

## Question 7 - What does Stop do when sessions are live in that container?

Q: Confirm then stop, refuse while a session works, or stop at once?
A: A prompt, only when a session in the container is active: "These sessions are still active. Stop anyway?", listing them. Active is judged by idle state, not by being open: a session that is open and idle raises no prompt, and with none active Stop acts at once.

> "It shall make a prompt saying these sessions are still active. Stop anyways? checks againt idle state, not merely being open."

The header mock is settled with the owner's changes: no plus sign on the buttons, no status chip or word added to a session card, names only in the Stop prompt, and no hint line under the create toggle.

## Question 8 - Copilot sessions in containers, in this plan?

Q: Keep Copilot in the container slice, or leave Copilot host-only here and lift it in its own small plan?
A: In this plan, as a third slice of Phase 2 after Containers. Some systems hold Copilot and no Claude, so nothing here may assume Claude is installed.

> "8: A. Expect some systems to be Copilot-only."

The first draft assumed dropping two refusals was the whole of it. The audit found three seams of Copilot's own beyond them: typed delivery relayed to a container pane (`typeSession` refuses any spawn but the host's), its plugin provisioned in each container (`provisionPluginSettings` installs Claude's only), and its compaction file read through the container (`createCompactionFollower` reads the host's home). None serves OpenCode.

## Question 9 - How does a session's create pick its CLI?

Q: A session's `crosstalk_send` with a `displayLabel` creates a session under a devcontainer spawn point. Which CLI does it launch?
A: An optional `cli` on `crosstalk_send`. Blank uses the spawn point's only CLI. With several, nothing is created and the answer names them. `crosstalk_discover` prints a spawn point's CLIs where known.

> "Sure, we can use a blank CLI as starting the only one."

> "It probably should carry an optional backend/TUI/agent (or whatever you call it), who's description reads like "Which TUI to use. Leave blank to get the list of CLIs. Ask if unsure which to pick.""

Today this door names no harness: `WakeService` mints the record without one and the wake launches Claude. The relayed send, the assistant's guarded send, and a runbook fire or routine into a new session do the same. Only the phone's Create carries a pick.

Named `cli`, since `agent` and `backend` already mean a delegated Codex or Copilot agent in `agentStart`.

## Question 10 - A session's create against a stopped container?

Q: Does the create start the container, does it need one already running as the phone's Create does, or does the blank probe start it to read the list?
A: Every create starts it. An agent's send starts a stopped container on its own, and only the phone's Create needs one running. The container is looked inside once it is up, and a create that cannot go on from there is a failure notice. No refusal names a stopped container, and no start tool exists. The send no longer waits on any of it: it answers at acceptance, and a notice through the awareness bank, as agents and workflows use, tells the sender the session is up or did not start. A send that wakes an asleep session is told the same way.

> "A: - But we will tear out the await. It shall use the same system reminder system that workflows and agents use. Upon [un]successful start(unknown CLI) or wake(known CLI), it will make the announcement that, that session by id is up."

> "It should autostart right? Only the human flow on the UI needs a start button pressed. Agents should be able to wake automaically." On the stopped-container refusal: "A. Autocreats the session and this error must not exist. Only a fail message is possible. ... I recommend A for 1 less tools."

A container that failed to start is an `act_now` notice telling the sender to investigate the project's `.devcontainer/`.

> "We should probably deliver a act now that the session failed to start. It should probably investigate the `.devcontainer/`. Very typical for project dockers."

Today `reach` awaits the wake for up to 10 minutes before the send answers, and a timeout answers "still starting; try again shortly" with nothing accepted.

## Question 11 - What do a routine and a fire launch into a new session?

Q: On a spawn point with several CLIs, what does a routine or a runbook fire into a new session launch?
A: A new selection. The routine editor gains a CLI pick, stored on the routine, and the fire sheet's new-session target takes the same pick. A run whose selection is not installed at that time is an error, and nothing more is designed for it here.

> "routines: we should make it a new selection. If the selection does not exist during runtime, thats an error case for the future."

## Question 12 - What should `/new` do in an OpenCode session?

Q: A fresh conversation inside the same Switchboard session, or nothing, with one Switchboard session being one OpenCode conversation for life?
A: Left as is. `/new` and the session list stay, nothing follows or hides them, and a pane that wanders off the conversation Switchboard sends to is a known edge case nobody handles.

> "leave it as is, a known edge case we dont care about. That happens currently with Claude too. Never cared to mention"

Switchboard sends to one OpenCode conversation by its id. `/new` and the session list change which conversation the terminal UI shows, inside the UI alone, and no server route reports it.

# Plan

Three phases. Nothing in the research was run: every OpenCode fact was read from source at tags v1.19.5 and v2.2.6, so Phase 2 opens by running it. Three audit laps are folded in.

No question is open. The spike may still move what Phase 2 builds.

**Agent-facing prose is agreed before it is built.** Every tool description, refusal and notice an agent reads is drafted in this plan and settled with the owner, then built verbatim.

> "we should probably talk about all prose you choose as you plan each one. I dont want you to confuse even the agent."

## Decided without asking

- **The plugin process owns the OpenCode API client.** It runs beside the OpenCode server wherever that is, reaches it on loopback with the port and password its launch config carries, and already holds the session's socket to the Gateway. It reports the session's state, delivers a pushed message as an API prompt, and answers a permission ask. The daemon only launches.
- **Stop is compose down, and Start is the daemon's existing road** (`ensureContainerUpAsync`): no halt exists anywhere. The owner's `devcontainer-down.sh` removes the container and the daemon's start always recreates one. The teardown never removes volumes, so a container whose home is a mounted volume, as the owner's are, keeps its CLIs (`~/.local/bin`) and sign-ins.
- **The button reads Stop; the operation is a teardown,** and the code names it so. Owner: "you don't need to call the scripts. just respect how it gets it done ... a tear *down*, not a stop." Stop is the word for a person; down is what must happen, since a halted compose project leaves services such as a database on auto-restart, and a reboot brings up the services of containers nobody is using. So the teardown takes the whole compose project with its orphans, never the dev service alone, and the daemon reads a container's state from docker each time and never from what it last did.
- **The daemon keeps its own start and stop and never calls a project's scripts.** They differ per project, and the daemon needs the build transcript, the Gateway network join and the plugin install around them. It takes on what the newer scripts know (see Phase 2).
- **Implementation is Claude only.** Lunas on Codex run the plan's refinement cycle and nothing after it. The implementation cycle skips its compliance steps, and its fan-outs use Claude's own Workflow and agents. Owner: "Skip compliance-* series. Skip codex though, do it with native claude tools. Need it done quick."
- **Progress is reported on the owner's phone conversation,** by `channel_reply`, not at the terminal. Owner, from the phone: "report here from now on."
- **A slice may be committed broken.** Only a phase's end must be green. Owner: "you may freely commit broken slices. Truly, Green Commit should be held to phase ends. Slice ends just means more work to-be-contunued. So don't worry about a fully green test suite"
- **Only the phone's Create needs a running container.** A message to an asleep session still starts its container, and so do routines and runbook fires.
- **One launch, two readers:** `WakeService` answers the minted address at once and the outcome after. A session's send hands the outcome to a notice. The phone's send, a watcher event, a runbook fire and a routine still wait on it, since none of them can read a notice.
- **"Up" is `no_act` and pushed; a failure is `act_now`:** nothing is owed for a session that came up, and a sender whose message went nowhere must act.
- **A failed launch drops the queued message:** a create's record is forgotten with it, and the `act_now` notice says nothing reached the session.
- **A sender in another Domain gets the reason alone,** never the project's path. It can only wake a session shared with it, never create one.
- **A launch has its own durable record,** apart from the session's: its stage and its requesters, each with an op id, an address and a told mark. The notice source rereads it each tick, as the agent watch rereads its catalogs, so a Gateway restart mid-launch still tells and a failed create's notice outlives the record it forgot. Each requester gets one notice. The bank itself holds nothing across a restart.
- **A sender that has gone is told nothing:** the bank drops a gone session's notice and holds a waking one for up to 10 minutes (`deadline` in `awarenessBank.ts`).
- **An approval on an OpenCode session is a courtesy, not a boundary,** as on every ordinary session: Claude launches with its permissions skipped and Copilot in allow-all. The model's shell inherits the server's environment, so it can read the API password and answer its own ask, and it can `cat` a `.env` file unasked. Neither is closed here, and nothing here may describe the card as a control. The assistant's later plan must close both, since its guards are boundaries.
- **Active, for Stop's prompt, means anything but idle:** working, compacting, waiting on an approval or a limit, or holding a running delegated agent or workflow step. Each is on the presence row already. A routine run is not on it and is left out: a routine's session that is mid-turn reads as working.
- **Who installs:** setup installs the pinned OpenCode on the host. Inside a container the owner installs it and Switchboard only looks, per "query the bins in path". The launch check refuses a wrong version either way. The Switchboard MCP server rides in the launch config, so OpenCode needs no plugin install anywhere.
- **The Gateway's own Create stays for host sessions.**
- **A message that arrives mid-turn steers,** OpenCode's default and the closest to how Claude takes a channel message. Nothing waits for idle.
- **No handshake,** as Copilot: the session's token stands in, and the capability guidance rides in the MCP server instructions, which OpenCode passes to the model.
- **The model and provider are OpenCode's own.** Switchboard chooses none. A new session is created with the model the terminal UI last picked, read from OpenCode's state file, since a session created with none runs the server's default whatever the pane shows (spike). Signing in is `opencode auth login`, done once by the owner.
- **The pin is 2.2.5,** the newest V2 release at least 7 days old on the day of the spike, written where the launch check reads it.
- **Self-update is off** in the launch config, so there is no restart signal: OpenCode's entry in `RESTART_SIGNALS` is null, as Copilot's.
- **Session tabs and the sidebar are off** in the launch config, and panes stay at 120 columns or fewer.
- **Create dialog order:** Claude, OpenCode, Copilot.

## Deploy order

Readers before emitters, for both phases: the Router takes the new presence-row and spawn-point fields first, then the Gateway and the daemon, then the plugin, and the phone offers OpenCode last. The Gateway writes `claudeSpawns` and `copilotSpawns` beside the map until their dated removal, and a new phone prefers the map.

The Containers slice deploys the daemon before the Gateway: a Gateway sends `unpicked` for a recordless wake and a create with no known CLIs, which an older daemon refuses as an unknown CLI.

The launch road (slice 3) deploys the daemon, then the phone, then the Gateway. A daemon older than the create door repairs a pane a create meant to leave, and one without launch ids would hold every flight a minute; an older phone alerts on the quiet `Session started.` line and its re-press mints a second session. `start-all.sh` starts the Gateway before the daemon, so run `./start-host-daemon.sh` first.

The Containers slice raises `FEDERATION_PROTOCOL_FLOOR` with its release: an older Gateway strips `cli` from a relayed send and launches Claude unasked. Its new wire is `cli` on `/send` and on the relayed send, the launch outcome on `response_push`, the daemon's wake progress frame, container state, the availability map on the discover answer, and the routine and fire picks.

## Phase 1 - The harness table

✅ Built in four commits. `### Built` lists what Phase 2a and Phase 2c take over.

Two commits, each gated by lint, the tests and the Kotlin gate. The first is the table and changes no behavior. The second holds two fixes and is labeled a behavior change.

- One closed record per harness, keyed by `SESSION_HARNESSES`, holding every seam the code map and the audit found: binary and launch arguments (`buildLaunchCommand`, `HOST.build`, `WINDOWS.build`, `agentTypeExport`, the Windows `copilot.exe` and `WSLENV` lookups), how it gets its id and resumes, delivery and registration as functions in the row (`deliverChannelPush`, `emitLocalAwareness`, `canReceivePush`), handshake or none with who owns the socket (the `agentPid` replacement check), state source (`deriveFromPeek` and its readers, `permissionPrompt`, the phone's pane reader in `agent-screen.ts` and its Kotlin twin), startup prompts (`COPILOT_TRUST_RE`), auto-answers (`limitContinueDigit`, `surveyShowing`), compaction road (`createCompactionFollower`, the compact hook), `RESTART_SIGNALS`, the slash-command tools, typed delivery (`typeSession`), which MCP tool groups it registers (the workflow tools go to Claude and Copilot by name today), how a wake tells it is ready (`paneAgentState`, `awaitReady`, `isAgentReady`), capability text, and where it may run.
- `SessionRecord.harness` and its copies in `HostOp`, `WakeMessage` and `CreateOpts` take `SessionHarness`, never a literal. `copilotSessionId` becomes `mintedSessionId`, held only for a CLI whose row mints one; the row owns the id's shape and its mint. A stored record with the old field restores into it. Claude's transcript id stays its own field.
- Every mint names its harness: `CreateOpts.harness` is required and `WakeCreate` carries one. The send road, the relayed send, the assistant's send, the runbook fire and a routine's reserve (`reserveRoutineSession`) pass Claude by name where they pass nothing today, so a mint door without a pick does not compile.
- The harness travels on the wire where today a field's presence implies it: the register frame, `presence_watch` and the presence row, each optional for the deploy gap with its date.
- Availability becomes one map of harness to spawn points, replacing the parallel `claudeSpawns` and `copilotSpawns` fields from the daemon's catalog through `GatewaySpawnPointsSchema` to the phone's `SpawnAgents`. Old fields stay readable for the gap.
- The phone reads a generated `HarnessRegistry.kt`, written by `codegen-kotlin.ts` from the table as `IntegrationRegistry.kt` is and diffed by the Kotlin gate: the `SessionHarness` enum, the order `harnessesOf` lists a spawn point's CLIs in, `shellMacros` and `PALETTE_SLASH`. A harness the phone cannot draw does not compile.
- A lookup with no entry does not compile, so no harness falls through to Claude, as `consoleSessionLifecycle` coerces any harness but Copilot today. Every row's launch exports `AGENT_TYPE`, Claude's included; only Copilot's does today (`agentTypeExport`). `detectAgentType` stays for a session the owner starts by hand, which carries none. Where a harness may run stays checked at the Gateway and at the daemon, which guard different doors.
- A test pins which panes the presence scheduler auto-answers, which nothing covers today.
- **Second commit:** a fresh Copilot session is greeted (`shouldGreetLaunch`, whose test asserts the opposite today), and console `reload_plugins` refuses a harness without Claude's plugin UI.

### Bug Classes

**Reading a CLI word off a wire or a file: absent, known, or unknown.** Each reader decided the three cases on its own, and three audit rounds each patched a different one.

- **Mechanisms:** `wireHarness` and `knownHarness` (session-harness.ts), `SessionStore.restore`, the register frame into `establishOnConfirm`, `readWatch` in the daemon, `rowHarness` and the relaunch on the phone.
- **Round 1, test agent:** `wireHarness` read an unknown word as Claude. Now it throws.
- **Round 2, alignment audit:** `restore`, the register frame and `rowHarness` still read an unknown word as Claude. `restore` skipped the record, the register refused, the phone refused a relaunch.
- **Round 3, red team:** the skip erased the record from disk on a rollback, and the relaunch refusal blocked a relaunch the Gateway would have done right. `restore` now holds the entry unread and writes it back; the relaunch sends the row's word uninterpreted.
- **Resolved in the architecture step:** `readHarness` answers a closed `HarnessWord` (named, unnamed, unknown) and `foldHarness` makes each reader state all three, in TypeScript and in generated Kotlin. "Unnamed means Claude" lives once, in `UNNAMED_HARNESS`, under its date.

### Built

- **The table:** `src/shared/session-harness.ts`, one `HarnessRow` per CLI. Per-process behavior sits in tables keyed by a row field's value (`LAUNCH_ARGS`, `TRANSPORTS`, `RESTART_SIGNALS`, the instructions and the scheduler's dialogs), so a new value stops the build.
- **One placement rule:** `launchRefusal`, read by the Gateway's create, the daemon's wake before any container starts, and `buildLaunchCommand`.
- **The plugin resolves its CLI once** into a profile with no optional answer, a CLI with no row included.
- **A stored record of a CLI this build does not know** is held unread and written back untouched.
- **The greeting** keys on a session that has never confirmed, not on a missing resume id.
- **Left for Phase 2a:** the wake's readiness reads and the pane regexes; one presence sink for both ingresses; the row's `compaction` split into how it is seen and who hands the baseline; one launch plan for both Gateway doors and both daemon doors; the row split by control road.
- **Left for Phase 2c:** a Windows spawn point is still offered only where `claude.exe` resolves.

Phase 2 is three slices in order, each its own lap: OpenCode on the host, containers, then Copilot in containers.

## Phase 2a - OpenCode on the host

✅ Built, released as 8.14.55 and deployed. `### Built` lists what Phase 2b takes over.

- **From Phase 1's architecture pass, built here with the roads that shape them:** one presence sink both ingresses call, which also fires the baseline push; the row's `compaction` split into how a compaction is seen and who fetches the baseline; one launch road that both daemon doors build from, holding the launcher and the version check; the wake's readiness dispatched on the row's `road`; the row split by control road, pane or API. The Gateway's send door still names Claude until Phase 2b's `cli` pick.
- ✅ **Spike, run on the host against 2.2.5:** results under `### Spike`. The container items wait for Phase 2b.
  - An API prompt shows live in the UI, and one sent mid-turn steers.
  - The event names for working, idle, permission and compaction, and what a failed compaction emits.
  - A session created under an id Switchboard chose, with the UI attached to it.
  - The MCP child starts without a first prompt and gets its own session's environment, with two servers running at once.
  - A prompt id Switchboard derived is accepted, a repeat of it lands once, and whether it must sort after earlier ids.
  - Approve, and Deny with a note, on a real `.env` read; the reply closes the dialog.
  - The event stream cut and resumed.
  - Synthetic input reads as context.
  - Server readiness, shutdown and wake, on the host and in a container.
- **Launch:** OpenCode's row. A launcher, its own bundled entry point, runs in the pane. It mints a password, starts `opencode serve --stdio --port 0`, reads the server's URL from its first line, creates the session under an id Switchboard chose with the model the terminal UI last picked, asks for the location's MCP list until the Switchboard server reads `connected`, then runs the terminal UI against that server. The daemon mints neither port nor password and learns neither: port 0 has the server pick a free one, and the launcher writes a status file the daemon polls. In stdio mode the server ends when its stdin closes, and the launcher holds that pipe, so the server cannot outlive the pane. The URL and password reach the plugin through a file only the owner can read, named in the MCP server's environment and removed when the launcher exits; neither is in the command line tmux is given. The launch config is passed by environment and never written into the project, in two variables. `OPENCODE_CONFIG_CONTENT`, which the server reads, carries the Switchboard MCP server, code mode off, self-update off, and `experimental.location_idle_timeout` off, since the default unloads an idle location after 60 minutes and takes the MCP child with it. `OPENCODE_CLI_CONFIG_CONTENT`, which the terminal UI reads, turns tabs off. The launcher checks the version first and a version outside the supported range refuses with its number. A fresh session's greeting is the launcher's first prompt, under one fixed id, so a relaunch greets once.
- **One server, one Switchboard session.** `/new` and the session list are left alone (Question 12).
- **Online** is the plugin's Gateway socket registering, as for every harness, never the server coming up. The plugin process owns that socket. A second registration under the same token replaces it when it names the same agent process (a plugin restarted by its launcher), and is refused otherwise.
- **State:** the plugin follows the server's event stream and reports the same `DerivedPresenceSchema` the daemon's pane readers fill: working, needs login, limit hit, compacting, a waiting permission. A session ingress beside `presence_derive`, which answers the host alone today, takes the team from the socket and never from the frame, feeds the same presence reporter, and accepts only the fields the API yields; the Gateway still derives teammates and workflow state. The event stream is volatile and a local server keeps no replayable log, so on connect and on every reconnect the plugin rebuilds from three reads and only then replaces what it reported: the active sessions for working, the session's pending permissions, and the newest message rows, where an `idle` row carries the last turn's error and a `compaction` row carries a compaction's end or failure. The report clears when the socket closes. No pane reader runs for this harness.
- **Wake:** the row's readiness for OpenCode is the server answering and the plugin registered, never a screen read; both wake branches read Claude's pane today. OpenCode never restarts a dead MCP child, so the launcher does: it reads the MCP status every 5 seconds and reconnects a child that reads `failed`. A wake therefore keeps a pane whose launcher is alive, since a missing registration there is a plugin reconnecting, and killing the pane would lose a running turn. It waits on a launcher still starting, and relaunches on the same OpenCode session id only when the pane's process is gone or the launcher reported `failed`. The daemon's ready is the launcher's status file, written once the MCP server reads `connected`; the Gateway still waits for the registration.
- **Delivery:** the plugin posts a pushed message as a prompt whose id it derives from the delivery id, in OpenCode's `msg_` form and the same on every retry, so a retry lands once; it acks under the delivery id after. The compaction baseline is posted as synthetic input with `resume` false, so it adds context without starting a turn, as Claude's hook does. Awareness travels as for every harness: an `act_now` notice is a pushed message, and the rest rides the next one.
- **Approvals:** a `permission.asked` event becomes the session prompt the phone already draws. The phone's answer, which the daemon types into the pane today, goes by the harness row: for OpenCode an op on the session control plane (`session_control` frames) reaches the plugin, which replies over the API, Approve as `once` and Deny as `reject` with the owner's note as its message. A reply to a request no longer pending answers 404, which reads as already answered. The op is keyed by the console's conversation and op id, as the daemon's road is, so a retried answer replays the first result where the plane would mint a fresh key. OpenCode's base policy stands, so only its read tool asks, on a `.env` file.
- **Controls:** the terminal view's keys and typed text reach the terminal UI in the pane, as for every CLI, so Esc and `/compact` are OpenCode's own. Nothing in Switchboard compacts or interrupts a session by itself, so no API road is built for either. Ctrl+C exits the app on an empty composer, so the Gateway refuses that key for this CLI and a named rule hides it on the phone; Ctrl+D is not a key the terminal view sends. The phone arms no `/goal` for a CLI without the command.
- **Phone:** the create dialog picks the project first, then shows the CLIs that spawn point runs (`harnessesOf`), OpenCode among them where it is installed, in the order Claude, OpenCode, Copilot. The slash palette and shell macros come from its row.
- **Tests:** a fake OpenCode server in the harness beside the fake host, as a request-to-response function: it holds sessions, drops a repeated prompt id, keeps pending permissions and a replayable log, and lets a test cut the event stream. It drives create, delivery, a permission round trip, a compaction and a dropped stream. It cannot see CLI drift, auth, the MCP child's environment or the terminal UI, which the spike and Phase 3 cover. `check:boot` gains an OpenCode `AGENT_TYPE` pass.

### Spike

Run on the host against the installed 2.2.5 (released 2026-10-30), with two private servers, a terminal UI in tmux and a logging MCP server. The pin is 2.2.5. Scripts and captures: `oc-spike/` in the session scratchpad.

**Confirmed as the source read:**

- **Server:** Basic auth, user `opencode`, password from `OPENCODE_PASSWORD`. Ready when stdout prints its URL and `GET /api/info` answers `{version, pid}`. `GET /openapi.json` serves the API document. `opencode --version` prints `opencode v2.2.5`.
- **Ids:** `POST /api/session` takes any id starting `ses`, and the terminal UI opens it with `--session`. A prompt takes any id starting `msg_`. A repeat of an id returns the first message and enqueues nothing, even with other text. An id that sorts before earlier ones is accepted and lands in arrival order.
- **Prompts:** show live in the pane. One sent mid-turn is delivered at the next step boundary. `GET /api/session/active` answers `{<id>: {type: "running"}}` during a turn.
- **Events:** `session.execution.started`, then `succeeded`, `failed` or `interrupted`. `permission.asked {id, sessionID, action, resources}` and `permission.replied`. `session.compaction.started`, then `ended` or `failed`. `mcp.status.changed`. Every connection opens with `server.connected`, and `?types=` repeated filters the stream.
- **Permissions:** a `.env` read asks. `once` closes the dialog and the read runs. `reject` with a message fails the tool with `permission.rejected` and the model reads the message. The session reads `running` while it waits.
- **Synthetic input with `resume` false:** no turn starts, the pane shows one line with its description, and the model reads it with the next prompt.
- **Compaction and interrupt over the API:** both work. A failed compaction emits `session.compaction.failed` with an `error.type`, and its execution still ends `succeeded`.
- **MCP child:** spawned by the server, with the config's `environment`. Two servers on one project each run their own child with their own environment, and each tool call carries `_meta["ai.opencode/sessionID"]`. Two servers ran turns at once on the shared database.
- **A dead MCP child stays down:** status `failed`, the tool is gone, nothing restarts it.
- **Exit keys:** Ctrl+C clears a draft, and on an empty composer exits the app with code 0.

**Differs, and what it moves:**

- **No replayable log.** A local server stores no durable events; `events.persist` is set only in OpenCode's hosted build, and the log route answers its marker alone. Reconnect rebuilds from the three reads the State bullet names.
- **The MCP child starts when the location boots, not at session create.** The terminal UI attaching boots it, and so does any location call. The wrapper makes that call and waits.
- **A session created without a model runs the server's default,** a free model with a daily cap, whatever the terminal UI shows. The UI keeps its last pick in `~/.local/state/opencode/model.json`. The launch reads `recent[0]` and its variant and creates the session with it; with no readable file it sets none.
- **`--stdio` ties the server to its stdin** and prints `{"url": ...}` on stdout. It also scrubs the password from the MCP child's environment, so the plugin reads URL and password from a file the config's `environment` names. Plain `serve` leaves the password in the child's and the shell tool's environment.
- **A repeated prompt id still emits an empty `started` and `succeeded` pair.** State reporting must not treat it as a turn.
- **A limit hit reads `provider.free-limit`** beside the `provider.rate-limit` the source names. The mapping takes both.
- **A reply to a permission no longer pending answers 404 `PermissionNotFoundError`.** A retry reads that as already answered.
- **Restarting the server alone on the same port works:** the terminal UI reconnects by itself and the MCP child starts again. `POST /api/experimental/mcp/{server}/connect` also restarts a dead child. The wake still relaunches the pane, one road.
- **A failed turn puts its prompt back in the UI's composer** as a draft.
- **The pane names an MCP tool `<server>_<tool>`.**

**Not run:** a sign-in failure (`provider.auth`, from source), an automatic compaction, and everything in a container.

### Built

Committed as `32ea5dd5`, released as 8.14.54 (`b2781fed`) and deployed to the Router, the Gateway, the daemon and the owner's phone. The architecture step's changes are `a8fb60d9`, released as 8.14.55 to the Gateway and the daemon. CI green.

- **Table:** `opencode` row, `road` as a pane or API union, `baseline`, `versions`, `refusedKeys`, `goals`, a nullable Windows binary, `launchRefusal` by place. `OPENCODE_PIN` is 2.2.5.
- **Launcher:** `src/opencode-launch/launcher.ts` behind ports, entry `src/main-opencode-launch.ts`, a fourth bundle in `scripts/build.ts`. Run for real: ready in 3 seconds, clean after the UI exits and after a pane kill.
- **Daemon:** `sessionLaunch.ts` is the one launch road for the wake's two branches and the create op; `LAUNCH` in `hostResolve.ts` builds the launcher command. OpenCode is offered where its binary is on PATH or under `~/.opencode/bin` and the launcher bundle exists.
- **Plugin:** `src/mcp/opencode/` client, follower and session; the `api` transport, the presence frame and the control frame in `helpers.ts`. Run against the real server: delivery once per id, a quiet notice with no turn, deny with a note, stale on a repeat, compaction.
- **Gateway:** `session_presence` ingress, `sessionControlPlane.ts`, the prompt answer by road, the refused key.
- **Audit folded:** 8 findings confirmed by skeptics, in three classes, all fixed (see `### Bug Classes` below). Of 22 low notes, the real ones are fixed; the rest are deferred below.
- **Phone:** OpenCode in the New session pick (fits at three CLIs, checked in the emulator), no Ctrl+C and no Goal for its sessions, a seeded sandbox session. A session with no presence row reads as unnamed in every phone rule.
- **Architecture step, after the release:** the plugin posts its own baseline per compaction id, and a presence report is erased only by its own live socket (see `### Bug Classes`).
- **Not built, by decision:** no API compact or interrupt, since nothing in Switchboard calls one (Controls bullet).
- **Left for Phase 2b:** `containers` is false on the row; the launcher's root and status file inside a container; `check:boot`'s OpenCode pass, which runs the launcher spec against a fake `opencode`.
- **Deferred, on the board or Phase 3:** the Gateway's send door names no CLI and its wake does not join a create in flight (both moot until Phase 2b's `cli` pick); setup installing the pin (Phase 3).

### Bug Classes

**Treating the daemon as the only reader of a session's state.** One mechanism: the Gateway's presence working map.
- **Round 1, audit:** a host daemon disconnect cleared every team's state, including what an OpenCode plugin reported, and the plugin resends only on its own reconnect. Now `clearAllWorking` takes a keep rule and the daemon's loss spares an API session's report. A cleared report also leaves the compacting set, or a relaunch read as a compaction's end.
- **Round 2, architecture:** any socket of a session closing erased its report, so a nested agent refused with the session token took the live plugin's approval prompt with it, and the daemon's ingress accepted an API session. **Design change:** a report is erased only when the session's live socket closes, and the daemon's ingress refuses a session whose own plugin reports, the same rule the plugin's ingress requires.

**Reading "no registration" as "plugin dead".** One mechanism: the launcher road's repair in `sessionLaunch.ts`.
- **Round 1, audit (four findings):** a wake killed a live OpenCode pane mid-turn while its plugin reconnected, and killed a create still launching. Now a live launcher is kept or awaited; the launcher restarts a dead plugin itself.
- **Round 2, red team (three findings):** the keep trusted a status file that asserted `ready` with no liveness behind it, so a dead server under a live UI, a launcher winding down, or a SIGKILLed launcher read as ready on every wake. **Design change:** every status carries the launcher's pid and is live only while that pid runs; the launcher writes `starting` first and `failed` the moment its server or UI goes, and removes only a status it still owns.

**Compaction and turn state from events plus a snapshot.** One mechanism: `opencode.ts` and the follower.
- **Round 1, audit:** a snapshot read a finished compaction as running, nothing cleared `compacting` at the turn's end, a missed start lost its baseline, a live end blinded the next read to a missed one, a repeated prompt id's empty execution cleared a held limit, and a dropped connection's late read could overwrite its successor's view. Now an execution's end clears it, a compaction is tracked by its message id, only a step clears an error, and each connection fences its own read.
- **Round 2, tests and red team (five findings):** one remembered id still misjudged a failed compaction, an end buffered during a read, and a prompt row above a running compaction; a snapshot read an empty execution's idle row as clearing a held error; an end while the plugin's socket was down lost its edge. **Design change:** the follower keeps the set of compactions already given their edge and replays buffered events through the live path idempotently; a running compaction is one with no output row above it; the snapshot's error comes from the idle row that ended a turn with a step; a reconnect re-reports an edge the Gateway could not hear.
- **Round 3, architecture:** the class could still be written: a baseline carried as a `compacting` edge across hops that lose frames, rebuilt by edge memory in three processes, lost when a launcher restarted the plugin mid-compaction and pushed for a failed one. **Design change:** the plugin fetches and posts its own baseline per compaction id, and OpenCode's duplicate-id rule lands it once. The edge memory is deleted; `compacting` is display only, and the Gateway pushes a baseline only for a row whose `baseline` is `gateway`.

## Phase 2b - Containers

The strings an agent reads are under **Agent-facing prose**, below Phase 2c.

**First, from Phase 2a's architecture step:** two structural changes, so that containers fill tables rather than rewrite the launch road.

- **A launch site per place:** a daemon-side `Record<LaunchPlace, LaunchSite | null>` holding the runtime, the root holding `dist/` and `launch/`, and status read and clear for each target, with the container row null until this phase fills it. Liveness becomes "the status pid is a process on this pane's tty", through the pane's own probe (`#{pane_tty}`, `ps -t` through the target's exec), which holds in any place and cannot be fooled by pid reuse. The launcher leaves its last word on disk (`failed`, or `exited` with the UI's code) and the daemon's removal before a launch is the only delete. `ExistingPane` becomes the door's intent, and the launcher road reads its status for any existing pane, which closes a container pane answering success on `peek` with its launcher dead. One launcher spec keyed by `ApiRoad.server` holds the entry, the bundle and the argv that `build.ts`, `LAUNCH` and the availability check read, and `check:boot` runs it against a fake `opencode`.
- **Which CLI runs at a place, one probe and one resolver:** a pure probe from the row (binary on PATH or under `homeDir`, plus the site's runtime and bundle for an API row), run through the place's own launch shell, over `SESSION_HARNESSES` filtered by `launchRefusal`. Windows keeps its PowerShell runner, takes the same filter and drops the `claude.exe` gate. Each row declares how its Switchboard runtime reaches a place: a marketplace installer for Claude and Copilot (the plugin set spelled once), a placed bundle and bun for OpenCode. An unresolved pick gets its own `HarnessWord` case and one `resolveCli(word, available)` that the daemon calls once the place reports, folding `BARE_PROJECT_HARNESS` and the adopt-as-Claude path into it.

- **One lifecycle owner per project:** Start, Stop and every `ensureContainerUpAsync` caller go through one queue keyed by project, and a Stop is fenced against the starts and creates behind it. Wakes are joined by team today, so two sessions of one project can each recreate its container. The owner covers the look inside, the CLI resolution and the session launch, not the container start alone. It holds the running `devcontainer up` child, which `runDevcontainer` never exposes today, so Stop kills it outside the queue, runs the teardown, and fails the launches waiting on it with a typed reason.
- **Found by label, never by name:** one resolver finds a project's dev container by its `devcontainer.local_folder` label and its compose project by `com.docker.compose.project`. It replaces every spelling of the legacy `<project>_devcontainer` name (`tmuxCore`, the Codex and Copilot targets, `claudeRunner`, `teardownContainer`, `workflowSkillRead`, `reloadPlugins`), which misses a container the owner's newer scripts started.
- **Start and Stop:** Start is `ensureContainerUpAsync`, with a `TMPDIR` of its own per project, since the CLI names temp files by the millisecond and two starts at once collide. Stop is compose down on the whole project with its orphans and stale networks, passing every `dockerComposeFile` entry in order. Both are new console ops relayed to host ops. Both answer at acceptance and report an outcome with its reason after, as `claudeRunner` does, since a start can fail before any container exists and docker then says nothing; the header shows the last failure.
- **State:** stopped, starting or running per project, read from docker when the daemon connects and from docker's event stream after, filtered by label, so a start or stop outside Switchboard shows too. It travels as its own field from the daemon's catalog through the Gateway and the Router's projection to `GatewayRegistry`, apart from session presence.
- **What is installed:** when a container starts running or its id changes, the daemon looks inside for the binary of each harness whose row allows containers, in the shell setup the launch uses, and reports it in the availability map.
- **The container wake names its harness.** Built in Phase 2a (`resolveLaunchHarness` and the launch road).
- **Phone:** `agentsOn` reads the availability map for every spawn point; it answers Claude alone for any container today. Every advertised container draws its header, sessions or none, with Start, Stop and Create from that state, Create only while running, and the create toggle offers only what was found. Stop asks first only when a session in the container is active, and names those sessions; the rule sits beside the ops class, where a JVM test reads it. The sandbox gains container fixtures with state and availability, and answers Start, Stop and Create. The availability map says unknown apart from none, per spawn point; `SpawnAgents` is two booleans today. `spawnChoices` lists a container with no sessions, since it feeds New session, the fire sheet and the routine editor.
- **A session's create names its CLI:** `crosstalk_send` takes an optional `cli`, on the assistant's guarded variant too, whose owner card names it. It rides `/send`, the relayed send op and `WakeCreate` to the mint. `crosstalk_discover` prints a spawn point's CLIs where they are known, which puts the availability map on the discover answer and its schema; `/discover` strips `spawnPoints` on purpose today.
- **A stopped container starts on any create.** What the create needed is checked once the container is up.
- **One wording per cause, on either road:** a create that needs a pick, names a CLI the spawn point lacks, or finds none installed gets the same words at once from a running container and by notice from one that had to start.
- **The mint may not know its CLI yet:** against a stopped container the provisional record carries what was asked, the launch resolves it once the container reports, and no wake leaves without one.
- **A session's send never waits on a launch:** a send that creates or wakes is accepted with its message queued under the minted address, and answers `starting` with that address. A launch subscriber on the awareness bank, beside the agent watch, reads the launch record and tells each requester when the session registers, or why it did not: the container failed to start, the CLI is not installed (with the list found inside), or the session never came up. For a container that failed to start, the notice names the project's `.devcontainer/` to investigate.
- **The `starting` answer carries the resolved address:** `ResponsePayload` has no target and its status has no `starting`, `formatResult` prints the `to` the agent typed, and the relay drops the remote target. All three gain it.
- **A failure finalizer, keyed to the accepted send:** it retires the delivery row and the reply job, both committed at acceptance where `abort` skips them, drops the awareness that rode the message, and forgets a create's record.
- **A relayed send's outcome rides `response_push`,** with a launch field the sender's Gateway banks as a notice, so its transport, share check and binding are the reply's own. No new op.
- **A launch the Gateway gave up on is cancelled at the daemon,** so no pane opens for a record that was forgotten.
- **Held deliveries drain at registration** (`onTeamConnect`), without the 3 second settle `reach` adds after a wake today. The first build checks that a fresh session takes its greeting before its queued message.
- **No gap rule:** an older plugin has no `cli` and sends none, which is the blank case. It is refused only on a spawn point with several CLIs, until it updates.
- **Every door that mints passes its pick, or none:** none takes the spawn point's only CLI, on the relayed send and the assistant's send as on a session's.
- **A routine and a fire carry a pick:** the routine record's spawn target and `runbook_fire`'s new-session target each gain an optional CLI. The routine editor and the fire sheet draw it with New session's toggles: what the spawn point runs, a single one selected, and all three where its CLIs are unknown. A held pick the spawn point no longer runs stays shown and marked, as `spawnMenu` keeps a held value. A routine saved without one keeps none. A routine reserves its own session through `create_session` (`reserveRoutineSession`), apart from the fire's road, and both pass the pick. A run whose pick is not installed, or with none on a spawn point with several, is a plain error on its occurrence; a thrown reserve reads as `host_unreachable` and waits today. A put without the pick, as an older phone sends, keeps the held one, and clearing it takes an explicit value.
- **Order inside this slice:** the no-wait send lands first as its own commit with its own harness tests, on Claude alone. The lifecycle and the `cli` pick build on it.
- **The deadline does not run during a build:** the daemon tracks its own `devcontainer up`. While one is going the launch is healthy and its countdown stands still, however long the build takes. The countdown runs only once the container is up, and the timeout notice names that window. A build that never ends is ended by Stop, which fails the launch. The daemon reports each wake's stage in a new frame: build going, container up, CLI found, failed with a typed reason. `WakeCoordinator` arms its countdown at container up; today the deadline is fixed when the wait starts, `ackReceived` can only shorten it, and the Gateway throws `wake_result`'s error text away. The CLI found is written onto the pending record before the session registers, since registration reads the harness off the record. Owner: "those godot ones can take a while. Daemon should be keeping track of whats happening. If hte docker build is going, it should consider it healthy: countdown does not move."
- **A pending create may lack a CLI.** Phase 1's rule that every mint names one holds for Phase 1 and ends there. Here the blank lasts only while the create is pending: the launch resolves it, or the record is forgotten. Owner: "As long as that stays in phase 1 and dies with it, it's fine."
- **No unit tests for the daemon's container orchestration.** Start, stop, state and the look inside are developed against a separate lab, as the enrollment work was, and accepted live in Phase 3. Owner: "We just have to live with no tests for this. System orchastration is too dificult to pin on a unit test."

### Built

Commits `62b9aa88`, `720f44a9` and `e5ef5274`.

- **Launch sites:** `LaunchSite` per `LaunchPlace` in `sessionLaunch.ts` (the container row stays null; Phase 2c places a `dist/` there). Liveness is `paneHolds`, the status pid on the pane's tty. The launcher leaves `exited` with the UI's code; `clearStatus` before a launch is the only delete. `LaunchDoor` (`wake`, `create`) replaced `ExistingPane`. `LAUNCHERS` in `launcher-spec.ts` feeds `build.ts`, `LAUNCH` and the probe. `check:boot` runs the launcher against a fake `opencode` (`scripts/lib/fakeOpencodeBin.ts`).
- **One probe, one resolver:** `cliProbeScript` and `parseCliProbe` run through `runInPlace`; `placeCandidates` filters by `launchRefusal`; Windows dropped the `claude.exe` gate. `HarnessWord` gained `unpicked` (wire word `unpicked`); `resolveCli` and `pickAt` in `cli-resolve.ts`, with the owner's wording in `cliRefusalText`. A recordless wake sends `unpicked`, which replaced `BARE_PROJECT_HARNESS`. The console `wake` op carries the row's CLI for a session with no record; an older phone's falls back to Claude until 2026-11-24.
- **No-wait send:** `WakeService.beginWake` answers the started team at once; `launchRecords.ts` holds each launch durably (`launches.json`) with its requesters and tells each one by the bank (`launches` source, the started notice pushed at once). A failure withdraws the queued rows (`ChannelDeliveryCoordinator.withdraw`), drops their reply jobs, and forgets a create. A relayed send from a session reader queues the same way; its outcome rides `response_push.launch` and the sending Gateway banks it. `ResponsePayload` gained `target` and the status `starting`.
- **Wake stages:** `wake_stage` frames (`building`, `container_up`, `cli_found`) from the daemon; the countdown holds through a build and runs whole from `container_up`. `wake_result` carries a typed `failure` (`LaunchFailure`). A given-up wake sends `wake_cancel`.
- **Container state on the wire:** `GatewaySpawnPoints.containers` (`ContainerState`: state, last failure, CLIs found, absent until looked inside), taken from the daemon's `catalog` and `containers` frames; console ops `container_start` and `container_stop` relay the matching host ops. The availability map stays `harnessSpawns` for host shells; containers carry theirs in `containers[].clis`.
- **The pick:** `cli` on `crosstalk_send`, `/send`, the relayed send, the assistant's guard and its card intent. Refusals travel typed (`SendRefusal`) and the plugin renders `sendRefusalText` with no prefix. A record may lack `harness` while its create waits; `resolvePick` names it on `cli_found`. Routine targets and a fire's new-session target carry `cli` (`CLI_PICKS`); a routine whose pick does not fit stops for review (`launch_failed`, slice 3). `crosstalk_discover` prints CLIs from `spawnClis`.
- **Protocol floor 6.**
- **A give-up reaches the daemon:** `WakeCoordinator` holds each launch's stage, so a waiter that joins a build has no deadline and one after `container_up` gets the time left; the launch record's countdown reads it (`countdownFrom`), and the daemon announces its in-flight stages again on every connect. A dropped host link forgets nothing. A failed create sends `wake_cancel` once per host link until one reaches, and the daemon closes a pane its finished wake made when a cancel lands in the register window. A send to a minted address joins its launch.
- **The launch runs in the project's lane:** a Stop meanwhile closes the pane the launch made and fails it `stopped`. A missing project or `devcontainer.json` fails it `container`. A look that finds no CLI on a running container looks again at 30 s and 2 min; a failed host probe keeps the last answer and retries.
- **A stopped container's CLIs are unknown to a pick:** routines and fires create unpicked there, and the daemon resolves and reports `cli_found`; a typed `cli` failure on the launch stops the routine for review. A create that finds a pane leaves it, dead launcher or not; the next wake repairs it.
- **Red team:** a friend's launch notice is rebuilt where it is received. Routines saved without a pick run Claude, which they always ran: a put with none stores `claude`, a restore writes it onto stored ones, and `unpicked` is stored as asked. A running container whose probe fails is never torn down, and a daemon exit kills its builds. A wake waits behind a host create of the same pane; a resend to a live minted session wakes nothing. A blank record takes its CLI from its plugin's register frame. A failed launch keeps a reply job an earlier message holds. An empty CLI list on a running container reads as unknown. The phone refuses an unpicked save or fire where several CLIs are known, and keeps Start and Stop busy until the state moves.
- **Another Domain gets no path:** `noticeOf` drops `projectPath` and replaces an `error` reason before a notice leaves. A notice the bank drops for a gone sender marks it told.
- **Seen in the emulator:** the container headers, Start, Stop and Create; the Gateway header's Create offering host alone; an unopened container offering Claude alone; the routine editor's and fire sheet's pick, a default following the spawn point and a held or tapped one staying marked.
### Bug Classes

**Two authorities give up on one launch, and a cancel names only a team.** Mechanisms: `WakeService`'s in-process timeout, the launch record's tick, and the daemon's `wake_cancel` handler with `cancelledWakes` and `madePanes`.
- **Round 1, alignment audit:** only the in-process timeout cancelled, so a host drop, a Gateway restart or a timeout in the register window left a pane up for a forgotten record. Now the record cancels a failed create once per host link, and the daemon closes a pane its finished wake made.
- **Round 2, re-audit:** the in-process timeout still cancelled every wake, so the new late-cancel memory killed a woken session's live pane. Now only a create is cancelled, and only a never-confirmed pane is remembered.
- **Resolved in the architecture step (slice 2):** every launch carries a Gateway-minted id on every frame, opened durably before dispatch; the launch records are the one give-up authority, and a cancel names its launch.
- **Red team of slices 1 and 2:** the held stage was one slot per team, so a second launch took the first's build hold; the owner's claim covered one launch, not the session; a kill queued behind a launch the Gateway no longer tracked; a newer request joined a unit launched with an older token. Now stages are held per launch and any build holds the pane's waiters, the claim marks every running launch of the session, a kill preempts the pane, and a join needs the same token, resume id, fresh mark and CLI.

**One session launched by two roads.** Mechanisms: the `createSession` host op and the `wake` frame, tracked apart on the Gateway (`inflightCreates`, `flights`, `launching`) and on the daemon (`inflightWakes` holds no create).
- **Rounds before this phase:** `a103133a` marked a create in flight; `5de25e50` built `WakeService` beside it; `e8f617f1` added `joinCreate`.
- **Round 4, red team:** a host create and a wake for the same session ran two launches on one pane. Now a wake waits behind a create of the same team.
- **Resolved in the architecture step (slices 1 and 3):** one lane per physical pane on the daemon, and every create a wake flight carrying the create door; the Gateway cannot emit `createSession`.

**A run read its launch's end by time.** Mechanisms: the reserve reading the team's newest launch record against the occurrence's `since`, and the record's prune.
- **Red team of slice 3:** a failed record no requester held was pruned within a tick, so the next sweep relaunched, restarting a container the owner stopped; `since` blamed a run for a launch it never waited on; a waiter's timeout after the daemon's success failed a launch that registered later. **Design change:** a run joins its launch as a requester and the record tells it (`tellRoutine`, `runner.launchEnded`); a waiter's timeout settles nothing, the record's countdown does; one reader (flight or record) fences Close, Forget and both reserves.
- **Re-audit of that change:** the record fence held Close and Forget for a whole countdown, a walk between a failure's settle and its tell could relaunch, and a retargeted run took its old team's failure. Now Close and Forget read the flight alone, `awaits(run)` holds a run until it is told, and the tell names its team.

**A launch failure turned into text at each road.** Mechanisms: the daemon's `error` field, `afterWake`, `createSession`, the fire's register wait, and the notice.
- **Round 1, alignment audit:** readers showed the bare kind (`cli`, `container`). Now the daemon's `error` is `launchFailureText`.
- **Round 2, re-audit:** that text carried the project path to another Domain through `afterWake`, a create read with the woken-session wording, and a fire dropped the failure. Now the Gateway renders the typed failure at each road through `launchFailureText` with `created` and `foreign`, and `failureFor` is the one cross-Domain rule.
- **Round 3, red team:** a received notice trusted the sending Domain's own `foreign`, `created` and address, and a refused reason went into the reminder unescaped, so a friend could write reminder lines. **Design change:** the receiver rebuilds a foreign notice from the job's own target (`foreignNotice`), `failureFor` reduces a foreign CLI failure to its cause, every refusal reason is one line, and every failed `wake_result` is typed.

- **To check live:** a fresh session takes its greeting before its queued message. The drain now runs at registration with no settle, and the plugin can register before the greeting is typed; if the order inverts, hold the drain for a never-confirmed session until its handshake confirms.

### Architecture: one launch road

Approved by the owner. A panel weighed four shapes (every create a wake flight; a daemon lane only; one launch ledger with ids; a create answered at acceptance) and picked a sequence. Sol disagreed with its order (identity must come before the Gateway cutover) and then agreed with this one, with changes folded in.

**Slice 1, a daemon launch lane (no Gateway or wire change):** ✅ Built. `launchLane.ts` (`createLaunchLane`, every effect a port) holds a queue per physical pane (`physicalPane`); a request joins only the tail of its pane's queue for the same team and a compatible door; `DevContainers.ensureUp` takes the generation read at admission; `killSession` queues on the lane. `launch-lane.test.ts` holds the daemon's first launch tests, and `launch-lane-residue.test.ts` fences the launch and tmux create primitives to the lane's construction in hostDaemon. The store's `paneTaken` and `paneHeldElsewhere` carry the physical name rule, read by the routine reserve and save.
- `launchLane.ts`, importable and unit-tested, owns `inflightWakes`, `cancelledWakes`, `wakeStages` and `madePanes`.
- Keyed by physical pane: a container's (project, session), and one host key per session name for every host-kind spawn point, since they share one tmux server.
- The store refuses a second logical owner of one host pane (`host.foo` beside `windows.foo`). Close and forget's kill go through the lane.
- **On a name collision, a random name re-rolls and a chosen one resumes only its own record or refuses** (owner, 2026-11-10): a send's, a Create's and a fire's mint re-rolls; a routine's fixed name, a Wake of an unrecorded row and a registering plugin's name resume their own record, else refuse. `host-daemon` and `assistant` are reserved on every host spawn point but the assistant's own.
- Both doors enter it and keep their reply contracts. It coalesces only compatible requests: a create's leave-the-pane does not satisfy a wake's repair, so that wake queues.
- The project generation is captured at admission; a Stop invalidates queued launches and awaits their cleanup.
- The launch function and tmux create primitives are reachable only through the lane (an import residue test).
- `createInContainer`'s start, placement check and Stop undo move into the lane before it goes.

**Slice 2, launch identity:** ✅ Built. `WakeService` mints the id (`newLaunchId`) and opens it in the launch records (`LaunchLedger.open`) before the frame goes; the records are the one give-up, cancel and forget, and the flight does none of them. `beginWake(..., { retain: true })` is the owner's claim, taken by the phone's Wake and a create riding a wake. `WakeCoordinator` matches waiters and stages by id, an untagged side matching its team. The daemon's lane answers per taker, cancels by id, and keeps tagged results in an outbox replayed on connect until `wake_result_ack`; its catalog declares `launchIds`, after which the Gateway refuses an untagged result or stage.
- The Gateway opens a launch durably, with a collision-resistant id, before it dispatches. The id rides `wake`, `createSession`, `wake_stage`, `wake_result` and `wake_cancel`, and the lane keys by it.
- A frame for another id touches nothing; a newer launch queues behind a running one on its pane.
- A launch carries a retention claim: a send-minted provisional launch may be given up and forgotten; an owner create that joins it takes the claim, persisted before it answers, and then neither give-up cancels or forgets.
- The daemon declares the capability; against a peer without it, an untagged cancel or result is refused rather than guessed. Tests send old frames late, after a replacement launch began.
- Terminal results are kept until the Gateway acks them by id and replayed on connect, beside stages. Replaying one keyed by team alone could settle a newer launch, so it waits for the id.

**Slice 3, one road on the Gateway:**
- A create, a routine reserve and a fire open a `WakeService` flight, carrying a create intent. The flight holds until registration and the daemon's result both land; Close and Forget are fenced on it.
- Deleted: `inflightCreates`, `joinCreate`, `launching`, the presence create sets, the wait behind a create.
- `HostOp` splits into what a Gateway may emit and an inbound legacy set; `createSession` only in the latter, with a dated shim.
- A phone Wake held through a long build answered `lost` in the harness, the Router redelivering a delivery op still in flight; the phone's Wake and Create answers belong here.
- Before it lands: routine and assistant reserves are bounded and launch-aware (launching apart from a terminal failure, a review cause for `stopped` and `container`); a fire answers at acceptance or keeps a retry identity; the phone keeps a create's pending identity. `check:boot` and the harness attach on the wake.

**Slice 3, as built from the owner's answers below:** ✅ Built.
- **Gateway:** `createSession` opens `beginWake(team, undefined, { retain: true, door: "create" })` and answers at dispatch; `watchOwnerLaunch` joins an owner requester (`OWNER_LAUNCH_KEY`), told through `tellOwnerLaunch` as a `notice` row worded by `ownerLaunchLine`. A flight holds until registration and `daemonDone(launchId)`. `HostOp` lost `createSession`; the daemon reads `DaemonHostOp`, its shim dated 2026-11-24. `cli_refused` is gone: a pick refusal is a `cli` launch failure.
- **Routines:** `reserve(routine, roads, run)` answers `ok` for a live session, else joins the run to its launch as a requester (`routine:<id>:<scheduledAt>`) and answers `launching`; the record tells it (`tellRoutine`), and `runner.launchEnded` stops it for review (`launch_failed`) or walks it again. A refusal before dispatch answers `launch_failed` at once. The runner waits `session_starting`, `noteWaiting` keeps a waiting run's cause current, and `RoutineState.waiting` names it. `reviewReason` is `ownerLaunchPhrase`.
- **Red-team rounds:** a Create sends the create door only for a record it just made, so a held session's pane is repaired; a fire queues under any launch (`launching: true`) and answers `starting` from the send, while a phone send still waits so a failure reads on the message; a waiter's timeout settles nothing; a live team wins over a late failure; `daemonDone` waits only on a daemon that tags launches; the daemon takes `door: "wake"`. Close and Forget fence on the flight; the reserves read the flight or an unsettled record, and `awaits(run)` holds a run its outcome is owed. A tell carries the launch's team, so a retargeted run ignores its old one. A watch alone never invents a record, and a wake that never left is abandoned.
- **Daemon:** a wake frame's `door: "create"` runs the lane's create policy; an unknown door is refused typed. A container wake repairs a found pane whose CLI reads `gone` (`viaPane`), as the host's does; `unknown` is left.
- **Phone:** a create keeps its claim and op id until the session's row or a line in its thread shows (cap 30 min); a fire answering `starting` keeps the sheet open; a titleless `notice` is quiet; `missStory` is the one miss text map.
- **Create:** mint or adopt as today, then a `WakeService` flight with `retain` and a create intent (the daemon's create door, which leaves a found pane). It answers at once with the minted id and the existing `status: "pending"`; a typed refusal before dispatch still throws. The phone keeps the pending row and its op id until presence shows the session, so a re-press joins.
- **Fire into a new session:** the create above, then the body queued under the minted name as a held delivery; answers `fired: true` with `sessionId` and a new optional `status: "starting"`. The body drains at registration.
- **The owner's outcome line:** an owner requester on the launch record; on settle the Gateway posts a `notice` row from the new session's address with the owner's wording. A failure alerts; `Session started.` does not.
- **Routines and check-ins:** a reserve answers `launching` while the ledger holds a launch for the team, and starts none; a failure settled after the occurrence opened stops it for review (`launch_failed`, the typed failure kept on the occurrence, the owner's wording); waiting reads `session_starting`, a new miss reason. The assistant's reserve takes the same road.
- **One road:** the host create goes through the wake; `inflightCreates`, `joinCreate`, `launching`, the presence create sets and the wait behind a create go. `createSession` stays as an inbound host op shim for an older Gateway (dated).
- **CLI named:** `CliRefusal`'s `not_installed` carries the CLI asked for, so the owner's line names it.

**Owner, 2026-11-10, how the owner's launches answer:** a phone Create and a fire into a new session answer at once with the new session's name; the row shows starting, and the outcome (up, or why not) lands as a line in that session's thread. A re-press joins the same launch. "A it is."

**Owner, 2026-11-10, a routine's run while its session starts:** the run waits on its own launch, shown as starting, and nothing relaunches; up delivers it, a failure stops it for review with the cause; the assistant's reserve gets the same bound. "routine should tap into the existing system of recognizing what the Devcontainer is doing... If it's building, that's a good state and it should not kill it to restart when a Unity container takes 10 minutes to build."

**Owner wording, a launch's failure on the phone** (the routine row's "Stopped at <time>: ___." and its notification body, capitalized there), the owner's edit of the drafts:

```
devcontainer failed to start
devcontainer was stopped while it started
session did not come up within 10 minutes
session encountered an error while starting: <reason>
<CLI> was not installed
Multiple CLI are installed. Select one in the run config
No CLI is installed
```

`<CLI>` is the CLI the run asked for, carried on the failure; `Selected CLI was not installed` only where an older daemon names none.

**Owner wording, a routine waiting on its session:** the live row reads `Session is starting.`; a run whose grace ran out first reads `session never finished starting` (notification `Session never finished starting`), miss reason `session_starting`.

**Owner wording, the line in a new session's thread** once the owner's Create or fire finishes starting it: the same phrases, capitalized, as their own line, plus `Session started.`

**Owner wording, the fire sheet once a fire is queued under a starting session:** the line `Runs once the session starts.`, Fire disabled, Cancel reads `Close`. "sounds good"

**Architecture pass after slice 3:** no fan-out; every bug class above is resolved by a design change. The outcome travels typed (`LaunchFailure`) and each reader renders it once: an agent by `launchFailureText` and `launchNoticeText`, another Domain through `failureFor`, the owner by `ownerLaunchPhrase` and `ownerLaunchLine`. The two owner roads still reading agent words, a create refused before dispatch and a phone Wake's failure, take the owner's line. The daemon's `error` text stays beside the typed failure for an older Gateway.

**After:** the launch outcome as data, worded once per reader (an agent here, an agent in another Domain, the owner's phone), before the 2b release build.

## Phase 2c - Copilot in containers

- **Typed delivery reaches a container pane:** `typeSession` refuses any spawn but the host's today, and its target is hard-coded to the host's. It builds the target from the session's spawn point. The daemon types into a container's pane as it already peeks and sends keys there.
- **Each container gets the plugin of each CLI found in it:** each CLI has its own installed check and its own installer, `copilot plugin` for Copilot. Today's check reads Claude's plugin list alone and the install runs `claude plugin`, so a container with Claude set up skips everything else and one without Claude fails. OpenCode needs no plugin install, but its launcher and the Switchboard MCP server run from a Switchboard `dist/` and a bun, which nothing places in a container yet.
- **The compaction file is read inside the container:** `createCompactionFollower` reads the host's home.
- **The two refusals go:** the Gateway's and the daemon's, which hold Copilot to the host.
- **No Claude assumed:** a container with Copilot alone starts, is asked what it has, and offers Copilot alone on the phone, in `crosstalk_discover` and in the `cli` list. A Windows spawn point is offered where any CLI resolves, not only `claude.exe`.
- **A CLI resolved at launch has its id minted before it launches:** a create that waits on `cli_found` launches Copilot without `--session-id` and OpenCode not at all, since `resolvePick` mints the id after the wake left. The daemon mints and reports the id with `cli_found`, or the launch waits for the Gateway's answer to it. Copilot-only containers hit this on every create.
- **The row declares how its runtime reaches a place, with the plugin set spelled once:** `PLUGINS` lives in both `session-harness.ts` and `helpers.ts`, and a provisioned container gets no lexicon while the phone's install macro adds it. The per-CLI installers above read the row's field.
- **OpenCode in a container:** the container `LaunchSite` gets its `dist/` and bun, and OpenCode's row turns `containers` on.

## Agent-facing prose

For Phase 2b. Taken past the owner string by string. A string he did not reword stands as drafted.

`<address>` is a session's address, `<spawn>` a spawn point's.

A blank `cli` is never a probe; `crosstalk_discover` is. A `displayLabel` on a session that exists is ignored, as today (`decideWakeCreate`).

**How the strings reach the agent:**

- The refusals are typed on the wire and the plugin renders the text below exactly, line breaks kept and with no `Bridge error:` prefix, on `crosstalk_send` and on the assistant's guarded send, whose `Not sent:` line collapses to one line today.
- A launch notice carries a `session:` data line above its text, naming the address. Two of the owner's strings name none, and the bank renders only a notice's body and source.
- A sender in another Domain gets the container failure without its second sentence.

**Taken past the owner during the Containers slice:**

- The crosstalk skill's `crosstalk_send` line, the owner's wording: "Send a message to another team. They will reply to you the same way." Owner: "Only Claude has channel push, so we should reword that."

- `crosstalk_discover`'s description, restructured with the owner ("way too much in 1 sentence ... Try a new structure"); its last line is the owner's wording, with "refuse" for "refuses":
  ```
  # Crosstalk Discover

  List reachable agent teams, excluding this session.

  Each team is a spawn point, with:
  - Its CLIs, where known.
  - Its active sessions, at their full addresses.
  - Its asleep sessions, with their last-seen time.

  A spawn point is not a target. To create a session under it, `crosstalk_send` with:
  - `displayLabel`
  - `cli`, when it lists several
  - Host spawn points refuse session auto-creation. Ask the user to make one first.
  ```

- The assistant's instructions, a bullet after Sending, the last line the owner's wording ("we reduce it since the results coming back are pretty obvious"):
  ```
  - **New sessions:**
    - `crosstalk_send` with `displayLabel` creates one.
    - Set `cli` when the spawn point lists several.
    - A system reminder will tell you when it delivers, or whether the spawn point encountered an issue.
  ```

**Notice, a woken session's CLI is not installed (`act_now`):**

```
`<address>`'s CLI is not installed. Talk to the user.
```

Installed once or never reads the same. Owner: "Lets not try to distinguish between once installed and no longer installed."

**`crosstalk_send`, field `cli`:**

```
Sets this new session's CLI: `claude`, `opencode` or `copilot`.
Leave blank to use the spawn point's only CLI. If it has several, nothing is created and you get their names. Ask the user if unsure which to pick.
```

**`crosstalk_send`, field `displayLabel`,** the owner's wording:

```
Sets this new session's label. Required when creating a new session.
```

**`crosstalk_send`, field `to`,** the owner's wording:

```
Session to send to.
- An offline session will auto-start and then be messaged.
- A nonexistent session (identified by `to`) will be created first.
```

The tool's own description is 983 of its 1024 characters, so it gains nothing.

**Send answer, a session being woken or created:**

```
Starting `<address>`. Message will auto-send afterwards. You will be notified by a system reminder when it completes or fails.
```

The owner wrote `<system-reminder>`. A tool result is neutralized (`neutralizeMarkup`), so that tag would reach the agent as `&lt;system-reminder>`; the words are used unless the owner picks another spelling.

**The CLI list, wherever one is given,** the owner's form:

```
This spawn point has:
- claude
- opencode
```

The next three are each one wording, given at once from a running container and by `act_now` notice from one that had to start.

**Several CLIs and none named,** the owner's wording:

```
`<address>` has multiple CLIs. You must choose which. Ask the user if not sure.
This spawn point has:
- claude
- opencode
```

**The named CLI is not installed,** the owner's wording:

```
The specified CLI is not installed.
This spawn point has:
- claude
```

**No CLI installed,** the owner's wording:

```
This spawn point has no CLI installed. Talk to the user.
```

**Notice, started (`no_act`):**

```
`<address>` started. Your message was sent. No action needed.
```

**Notice, container failed to start (`act_now`),** the owner's wording:

```
Devcontainer for `<spawn>` failed to start. Investigate `<project path>/.devcontainer/` and talk to the user.
```

**Notice, never came up (`act_now`),** the owner's wording:

```
`<address>` did not come up within 10 minutes. Send again to retry.
```

**Notice, failed another way (`act_now`):** the reason is daemon text; another Domain gets `the launch failed`.

```
`<address>` did not come up: <reason>. Send again to retry.
```

**Notice, the owner stopped its devcontainer (`act_now`):**

```
`<address>` did not start: the user stopped its devcontainer.
Ask the user before sending again.
```

**Refusal, a CLI that place never runs,** the owner's wording, and the same for a Windows shell:

```
Devcontainer does not have OpenCode. Choose another CLI.
```

**Refusal, a nonexistent session and no `displayLabel`,** today's, reworded to match:

```
`<address>` does not exist. Set `displayLabel` to create it.
```

**`crosstalk_discover`, a spawn point's line,** with its CLIs where known:

```
- <spawn> (CLIs: claude, opencode)
- <spawn>
```

Running or stopped is not shown: an agent's send starts the container either way.

**Eliminated:** the refusal for a stopped container, and the separate notice for a CLI found missing after a start.

## Phase 3 - Acceptance and docs

- Live on Sakura from the phone: create an OpenCode session, talk to it, watch it in the terminal view, approve a `.env` read from the card, compact it, close and wake it, and crosstalk with a Claude session in both directions.
- A devcontainer from the phone: start it, see the toggle offer only what is installed inside, create a session, stop the container with a session live, and wake that session again. Start one outside Switchboard and see its header follow. From a session: create one in a stopped container by `cli` and be told it is up, then name a CLI it lacks and be told the list. Break a project's `.devcontainer/` and be told to investigate it. Create one on another Gateway and be told there too. Run a routine into a new session with its pick, and fire a runbook into one with its pick.
- A container with Copilot alone: its header offers Copilot alone, a session is created, talked to, compacted and woken.
- Docs: `docs/architecture.md` (the harness table, the OpenCode roads), `docs/console.md` (the create pick), `docs/environment.md`, the setup step that installs the pin, AGENTS.md map lines. The stale line the map found, that Copilot gets no progress notices, goes.

## Painpoints

- **The host daemon runs on import:** `src/mcp/devcontainer/hostDaemon.ts` opens its socket and timers at module top level, so no test calls `handleWake`. Phase 1's container refusal and `launchHarness` there were checked by reading. Phase 2b adds container orchestration to the same function.
- **Copilot's phone palette is Claude's:** both rows of `HARNESS` hold `CLAUDE_SLASH` as `slashPalette`, so the phone offers a Copilot session slash commands it does not have.
- **`detectAgentType` answers the first CLI on the path:** a hand-started session with no `AGENT_TYPE` reads as Claude on any machine that has Claude installed, whatever CLI it runs in.
- **A CLI with no row gets Claude's slash tools:** `OTHER_AGENT` in `src/mcp/sessionCli.ts` sets `claudeSlashTools`, so `compact_session` and `set_effort_level` register for a CLI that cannot run them.
- **21 dated shims fall due on 2026-11-23:** the optional `harness` fields, `unnamed`, `claudeSpawns` and `copilotSpawns`, and the `copilotSessionId` twin. Nothing but a grep for the date finds them.
- **An OpenCode session's plugin runs from the checkout's `dist/`:** `LAUNCH` in `hostResolve.ts` points the MCP server at the daemon checkout, so a `--build-only` there changes what a live session runs on its next plugin restart, and every source commit first restores `dist/`. The marketplace copy the other CLIs run is not used.
- **The daemon blocks on `execSync` inside a start:** `isContainerReady` (up to 15 s) and plugin provisioning (up to 120 s) in `helpers.ts` hold the daemon's event loop, and a Stop cannot interrupt either. Every other session's presence and every host op wait behind them.
- **`hostDaemon.ts` is about 850 lines:** the wake, the catalog, the host ops and the container wiring share one module that runs on import. A split by concern is due.
- **A Gateway rollback below `64786716` loses routine history:** the occurrence store parses its rows as one array, so a stored `session_starting` or `launch_failed` an older build does not know quarantines the whole file, and slots inside the grace run again. `assistant_unplaced` opened the same gap. Parsing per row and holding an unreadable row unread, as `SessionStore` does, would close it.
- **Run missed on an asleep session starts it and answers that it cannot run:** `runNow` gives up on `launching`, since a missed row has no waiting state. Pressing again once the session is up runs it.
- **A send commits its awareness before its launch can withdraw it:** `lease.commit()` marks an agent's turn told once the row is queued, so a failed launch that withdraws the row loses the notice it carried. Agent sends and fires share it.
- **A given-up create can outlast the daemon's late-cancel window:** `knownSince` moves a record's countdown on every host reconnect, so a send-minted create that never registered can expire after the lane's 15 minute late cancel and leave its pane.
- **A send's mint stays keyed under its typed name:** `beginWake` holds the flight under both names, so a Create of that typed name while the mint launches is refused as ambiguous rather than launched.
- **Relayed launch notices are told on banking, not delivery:** a sending Gateway's restart loses one, it has no away retry, and a lost relay ack sends a second copy.
- **The assistant's card is held before its pick is checked,** so a `needs_pick` costs the owner a second card.
- **A create refused before dispatch shows agent wording:** its toast reads `launchFailureText` ("Send again to retry"); the fire's refusal and the thread line use the owner's.
- **A daemon replays tagged results to an older Gateway:** a Gateway rolled back before launch ids never acks and applies a replayed result by team, so for up to 30 minutes a stale result can settle a newer launch of that team. Replaying only to a Gateway that has acked on the link would close it.
- **A host probe that never answered reads as no CLI:** `hostClis ?? []` is a known empty list to `installedAt`, so a host whose first probe failed refuses picks until the 30 s retry answers.
- **No gate runs the real OpenCode binary:** the fake server encodes one reading of 2.2.5, and each behavior it rests on (duplicate prompt ids, the compaction row's id, synthetic input with no turn) was confirmed by hand scripts against a real server. A pin move finds drift only in Phase 3's manual pass.

## Owner asks, open

- **Tell the owner when the app can create an OpenCode session.** Asked from the phone on 2026-11-10: "let me know when session start or startAgent is ready for use in this android app. I think a good exercise would be to make a session and you cross talk it to do adversarial from now on." ✅ Told on 8.14.54. Adversarial reads go to the session the owner names.
- **An OpenCode backend for `agentStart` and workflow steps,** a slice after Phase 2a. Owner, 2026-11-10: "let's add agentStart support as a slice after you get the session support. that way you can use OpenCode session to implement an OpenCode agent." Its tool text is settled with the owner first, and the build is handed to an OpenCode session by `crosstalk_send`. It is not a cycle phase yet; add it as `## Phase 2a2 - OpenCode as an agent backend` once planned.
  - **Q1, one family adapter first?** A: fold Codex and Copilot into one family adapter (options, dispatch, event fold, recovery, cancel per backend), then OpenCode is one adapter on it. Owner, 2026-11-10: "A."
  - **Q2, where an agent runs?** A: one headless `opencode serve` per execution target, supervised by the daemon as Codex's App Server is; each agent is an OpenCode session on it, a turn is a prompt, collect reads the turn's messages. Local mode runs its own the same way. Owner: "A".
  - **Q3, the agent's model?** Optional; omitted on OpenCode it is `opencode-go/deepseek-v4-pro`. A new tool lists the models each backend offers, newest version per family. Owner: "We need a new tool to list models a backend has. Claude and Codex will be down to a few. Copilot will list whatever the enterprise enabled. We should attempt to dedup the model listing by version numbers by only offering the newest. Usually same price for better performance. And if model is omited on OpenCode, default to the deep seek model, since OpenCode offers it at a good discount. the costlier one, not the flash one." On the dedup: "I meant dedup as in opus 5.4 superceded by opus 5.5. Pro and Flash are 2 different models. like a haiku vs opus."
  - **Q4, the listing tool's shape?** A: one `agentModels` tool, optional `backend`, each backend's models read live from that backend (OpenCode's provider list, Copilot's headless client, Codex's App Server, Claude's few), newest per family, the default marked. A family is the id with its version numbers removed. The static model lines in the agent guidance go. Owner: "A it is".
  - **Q5, what an agent may do unasked?** A: allow all; the agent's session is created with an allow-everything rule set, as Copilot agents run in allow-all and Codex unsandboxed. Owner: "A".
  - **Q7a, the listing tool's name:** `agentListModels`, keeping agent plus a verb. Owner: "A. now the description next".
  - **Q7b, its description,** the owner's wording:
    ```
    # List Agent Models

    List the newest models in all enabled model families.
    - `backend` lists for just that backend
    ```
  - **Q7c, `agentStart` field `model`,** the owner's wording: "Model ID as listed by `agentListModels`. Omit to use the backend's default."
  - **Q7d, `agentStart` description sentence,** the owner's wording: "Set `model` and `cwd` to start with. Use `agentListModels` to lists the models."
  - **Q7e, guidance, the OpenCode section,** the owner's wording:
    ```
    ## OpenCode

    `model` uses the format: `provider/model`
    ```
  - **Q7f, guidance, the Codex section,** the owner's wording, and a behavior change: a Luna-family model defaults to `priority` whenever `tier` is omitted ("B. I want Luna fast by default. should be a tiny fix."):
    ```
    ## Codex

    `tier` accepts: `priority` or `standard`
    - When Luna family is selected, tier will be defaulted to `priority`.
    - On `agentMessage`, tier applies to the next new turn.
    ```
  - **Q6, how a session gets the backend?** A: its own capability, `opencode-agent`, on by default where OpenCode is installed, listed in the backends line, switchable like `codex-agent` and `copilot-agent`. Owner: "A".

## Later

- The assistant on OpenCode: its closed tool list as a deny-all rule set with an allow list, its gate as a plugin hook before each tool call, in its own plan.
- A scary-command ask list, if wanted.
