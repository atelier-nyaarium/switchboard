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

**Every deploy updates the other Gateways too:** `mikan` (`ssh mikan`) and `matrix-edward` (`ssh matrix-edward.local`), each `git pull --ff-only`, `./start-host-daemon.sh`, then `./start-gateway.sh`, and their logs checked for `registered as Gateway`. Floor 6 stopped both until they were updated by hand. Owner: "As you go, ensure you didn't break em. SSH and update them".

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

✅ Built, released as 8.14.56 and deployed (daemon, phone, Router, Gateway, in that order). Acceptance against a real container is Phase 3's. `### Built` and the launch road's slices list what Phase 2c takes over.

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

**Owner, 2026-11-11, superseding the thread line:** "I don't want this message to actually post on a session and remain there." A launch that comes up posts nothing; the thread docks `Starting...` while it boots. "any errors become a dismissable message": a failed launch's row is marked `launch: "failed"`, held on the phone as a dismissible dock, and threads nothing.

**Owner wording, 2026-11-11, the failed launch's popup:** "let's write it as present tense in the popup": `<CLI> is not installed.` The line on its own (the dock, a create's toast, a fire's refusal) reads a CLI's state in the present; the routine row's "Stopped at <time>: <CLI> was not installed" keeps its tense.

**Owner wording, the fire sheet once a fire is queued under a starting session:** the line `Runs once the session starts.`, Fire disabled, Cancel reads `Close`. "sounds good"

**Architecture pass after slice 3:** no fan-out; every bug class above is resolved by a design change. The outcome travels typed (`LaunchFailure`) and each reader renders it once: an agent by `launchFailureText` and `launchNoticeText`, another Domain through `failureFor`, the owner by `ownerLaunchPhrase` and `ownerLaunchLine`. The two owner roads still reading agent words, a create refused before dispatch and a phone Wake's failure, take the owner's line. The daemon's `error` text stays beside the typed failure for an older Gateway.

**After:** the launch outcome as data, worded once per reader (an agent here, an agent in another Domain, the owner's phone), before the 2b release build.

## Phase 2c - Copilot in containers

✅ Built, audited and deployed, last as 8.14.62 (daemon, phone, Router, Gateway on Sakura; mikan and matrix-edward updated). Acceptance against a real container with a signed-in CLI is Phase 3's. `### Built`, `### Red team` and `### Architecture pass` say what stands.

- **Typed delivery reaches a container pane:** `typeSession` refuses any spawn but the host's today, and its target is hard-coded to the host's. It builds the target from the session's spawn point. The daemon types into a container's pane as it already peeks and sends keys there.
- **Each container gets the plugin of each CLI found in it:** each CLI has its own installed check and its own installer, `copilot plugin` for Copilot. Today's check reads Claude's plugin list alone and the install runs `claude plugin`, so a container with Claude set up skips everything else and one without Claude fails. OpenCode needs no plugin install, but its launcher and the Switchboard MCP server run from a Switchboard `dist/` and a bun, which nothing places in a container yet.
- **The compaction file is read inside the container:** `createCompactionFollower` reads the host's home.
- **The two refusals go:** the Gateway's and the daemon's, which hold Copilot to the host.
- **No Claude assumed:** a container with Copilot alone starts, is asked what it has, and offers Copilot alone on the phone, in `crosstalk_discover` and in the `cli` list. A Windows spawn point is offered where any CLI resolves, not only `claude.exe`.
- **A CLI resolved at launch has its id minted before it launches:** a create that waits on `cli_found` launches Copilot without `--session-id` and OpenCode not at all, since `resolvePick` mints the id after the wake left. The daemon mints and reports the id with `cli_found`, or the launch waits for the Gateway's answer to it. Copilot-only containers hit this on every create.
- **The row declares how its runtime reaches a place, with the plugin set spelled once:** `PLUGINS` lives in both `session-harness.ts` and `helpers.ts`, and a provisioned container gets no lexicon while the phone's install macro adds it. The per-CLI installers above read the row's field.
- **OpenCode in a container:** the container `LaunchSite` gets its `dist/` and bun, and OpenCode's row turns `containers` on.

### Built

Commits `b0d48f8f`, `65a08548` and `9daae096`; released as 8.14.57 and deployed.

- **Typed delivery:** `/session/type` targets the record's own place, a host shell or a devcontainer pane.
- **Plugins per CLI:** `PLUGIN_SET` is spelled once in `session-harness.ts`, lexicon included; each row's `plugins` holds its in-container check and install. `provisionPlugins` (`pluginProvisioning.ts`) runs after the look, at most once per container id, for each CLI found.
- **Compaction:** the follower reads Copilot's events file through a per-place port; a container's goes through `docker exec`.
- **OpenCode's container site:** `containerSite.ts`; the checkout's `dist/`, `launch/` and `package.json` copied in by version before each look, run by the container's bun, reaching the Gateway as `switchboard`.
- **The session id is minted where the CLI is resolved:** the lane mints for an unpicked create and reports it on `cli_found`; `resolvePick` keeps a reported id that fits the row.
- **Both rows `containers: true`.**
- **Login:** Copilot's status row ("Please use /login to sign in") reads as logged out on the daemon and the phone; OpenCode's spent free tier (`provider.free-limit`) reads as a sign-in. The phone shows a red **login** chip; **limit hit** is quota and rate limits; **check terminal** has no producer yet. Owner: "I want a new 'login' chip to show if it's specifically login needed. 'check terminal' can be for whatever else."
- **Owner board edits are `no_act`.** Owner: "make it a no_act so it's not pressing to act on right away."
- **Seen live:** evie-bot ran Copilot and OpenCode with no sign-in, both reading **login**; on the host, a Copilot and an OpenCode session the owner created answered a round trip.
- **Found live, 2026-11-11:** ql's project folder `pge_external_client` threw in the phone's `teamInfoToTeam`, and the throw discarded every roster update from every Gateway, so a session created on Sakura read "ended" on the phone. The phone drops a row or container it cannot address; `_` joined the segment rule; the daemon and the Gateway leave a folder name that is no segment out of the catalog.
- **Launch status, 2026-11-11:** a launch threads no row. `Starting...` docks while a session boots; a failed launch's row is marked and held on the phone as a dismissible dock, the card's headline and its own notification.
- **Found live:** a container's home volume keeps the CLI binaries of its first creation, since `post-create` copies the image's home with `--ignore-existing`; evie-bot held Copilot 1.0.10, which has no `--session-id`.

### Bug Classes

- **A name rule written more than once.** Mechanism: the address segment's character set, hand-copied as `TMUX_NAME_RE`, `CONVERSATION_ID_RE`, `SHELL_SAFE_NAME_RE` and the phone's routine id pattern. Widening `SLUG_RE` left `SHELL_SAFE_NAME_RE` behind, so the catalog offered a project the console then refused; Luna's audit caught it before a live use. Resolved by design: every reader takes `SLUG_RE`, and the shell-safe copy is gone.
- **A name off the wire asserted instead of checked.** Mechanism: `Address.of` and `SpawnPoint.of` throw, and `teamInfoToTeam` called them on a roster row inside the landing. One bad row lost the whole update. Resolved at the two intakes (`teamInfoToTeam`, `addressableContainers`); the audit found no other unguarded parse of a wire or disk string.
- **A wait and the memory that covers it set apart.** Mechanism: the daemon held a typed delivery's key for 60 seconds while the plugin retried that key for 15 minutes, so a retry past the hold typed the message again. Resolved by design: both read `TYPED_GIVE_UP_MS`.
- **State torn down without its off signal.** Mechanism: `setFollows` in `copilotCompaction.ts` deleted a follow that was compacting and told nobody, so the phone kept the overlay. Resolved: a dropped follow reports the end.

### Red team, 2026-11-11

Ten Luna angles and an Opus join over `4fea952e..HEAD`. Fifteen findings ranked, three dropped by the join.

- **Fixed:** the typed key's hold; the dropped follow's overlay; the container events read (one `dd`, so a failed read is a failed command, where `tail | head` answered empty); a launch whose CLI's plugins did not install now fails with that reason instead of launching a CLI that never registers; the provision ledger keys the probe by the container id read before it; a fresh launcher's `ready` is checked against its pid; the Starting dock stays off a pane already running a turn; a `clearStatus` test that could not fail; three long comments.
- **Dropped, with the reason:** an overall deadline on plugin setup. Setup runs in the `building` stage, which has no countdown, each script is bounded, and a Stop aborts it.
- **Parked:** see Painpoints, the four entries dated 2026-11-11.
- **Re-audit of the fixes:** two more. With no container id to remember under, plugin setup was skipped and the launch went ahead; it now checks every found CLI. A send refused before the thread had it left its draft taken; the draft is handed back.
- **Prose:** the phase's comments trimmed by an OpenCode session over two relays, 84 comments in 40 files, each diff checked to touch comment lines only.

### Architecture pass, 2026-11-11

No fan-out. The four bug classes above are each closed by a design change, and the red team's leftovers already name their shape.

- **Next, one change:** launch-scoped facts keyed by launch. The CLI pick and the phone's Starting dock both read a launch by its team. Carry the launch id to the pick, and put the launch record's own state and stage on the presence row. Closes two Painpoints entries and names the stage in the dock. Queued on the board, outside this phase.
- **After it:** an agent catalog commit that parses and writes one agent, since a catalog now lives until its session is forgotten; Forget purging what a session owns.
- **No harness reaches `DevContainers.bring`:** its plugin setup branches are covered only through `provisionPlugins` and the ledger.

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

## Phase 2d - OpenCode as an agent backend ✅

OpenCode behind `agentStart` and workflow steps. Planned for after Phase 2a and never made a phase; the owner placed it after 2c, before acceptance ("cool."). Owner, 2026-11-10: "let's add agentStart support as a slice after you get the session support. that way you can use OpenCode session to implement an OpenCode agent."

- **Order:** fold Codex and Copilot into one family adapter first, built here, since it touches both live backends. Then an OpenCode session, reached by `crosstalk_send`, builds the OpenCode adapter on it, and every answer it sends back is reviewed before it lands.
- **The cycle:** its phase list was fixed at start, so after 2c it restarts on this phase and Phase 3.

### Settled with the owner

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
- **Q7f, guidance, the Codex section** (the Luna default shipped with Phase 2b), the owner's wording, and a behavior change: a Luna-family model defaults to `priority` whenever `tier` is omitted ("B. I want Luna fast by default. should be a tiny fix."):
    ```
    ## Codex

    `tier` accepts: `priority` or `standard`
    - When Luna family is selected, tier will be defaulted to `priority`.
    - On `agentMessage`, tier applies to the next new turn.
    ```
- **Q6, how a session gets the backend?** A: its own capability, `opencode-agent`, on by default where OpenCode is installed, listed in the backends line, switchable like `codex-agent` and `copilot-agent`. Owner: "A".
- **Q8, the `delivery` words:** three words, one meaning each, on every backend. `started` is an agent's first turn, from `agentStart` and never from a message. `followup` is an `agentMessage` that began a new turn. `steered` is an `agentMessage` into the turn already running. Codex answered `started` for a message to an idle agent and now answers `followup`. Owner, 2026-11-11: "each word has its own meaning", then "sounds good". `agentResultDelivery` in `agent-state.ts` is the one mapping, and the table's `followupDelivery` field is gone.
- **The order backends are named in:** Codex, Copilot, OpenCode, the table's order, in every agent-facing string. The owner's "newest first." was not about this. Owner, 2026-11-11: "oh that's definitely not what I was talking about. so disregard my newest first comment."
- **An omitted `backend`:** `agentStart` runs without one only when exactly one backend is enabled. With several the caller names it: the tool's schema requires the field and the handler refuses. Owner, 2026-11-11: "I do not want it auto pickup a backend if backend is omited. It shall only do so if there's exactly 1 backend. Otherwise it must be explicit. For instance, you know I don't want you using my Work paid copilot for personal things. So this would do that without either of our knowledge".
- **A workflow start's `backend`:** the same rule, in place of the unwritten Codex default. Claude counts as a workflow backend, so a start with no `backend` runs only where it is the one enabled. Owner, 2026-11-12: "A. same rules. if there is only 1 backend, it will default to that. If multiple, it will kindly bounce the list of which back." Built: the refusal is `agentStart`'s string, and the field's description reuses its sentence.
- **`agentListModels` with no `backend`:** unchanged. It lists every installed backend's families, Copilot's included, and `backend` lists one. Owner, 2026-11-12: "ohh for listing. it will list all family that is installed. or just the CLI of interest".
- **"step" is defined once in the workflow guidance:** "A step is one `agent()` call.", before "Steps use". Owner, 2026-11-12: "B". To fit the guidance's size budget, " (uncollected runs)" after `workflowList` went; the tool's own description says it.
- **The order every list names the backends in:** OpenCode, Codex, Copilot, Claude last. Owner, 2026-11-12: "b for all descriptions that list all 3 CLI, list OpenCode first, since it's the best, codex, and then copilot. Claude last when we get that in as a backend." Set once as the row order of `BACKEND_ROWS`. This replaces Codex, Copilot, OpenCode, and with it "`tier` is Codex only; `effort` is Copilot only." names Codex first.
- **The workflow text names OpenCode:** in the guidance's "Steps use", the tool's CLI list and the `backend` option's comment. Owner, 2026-11-12: "c yeah don't forget OpenCode. that's new."
- **Typos in the owner's wording are fixed and the gist kept.** Owner, 2026-11-12: "a fix my typos. get the gist." "to list" stays.
- **Which backend a session reaches for** is the owner's global note, not this repository: Luna for multi-agent fan-outs, OpenCode on `opencode-go/deepseek-v4-pro` for a single focused task, and the other when either hits its quota. Owner, 2026-11-12: "Global rule changes. Aim for: - Multi agent fanouts - Codex Luna - Single focus - OC DeepSeek pro(I think it's called?). If quota is hit, bounce between either for Luna". The shipped line "`codex` (Luna) for audits, assessments, edits and adversarial second reads" is unchanged.
- **Copilot's "Update available" is not surfaced by Switchboard.** Its own footer line is the signal. Owner, 2026-11-12: "leave it. I appreciate knowing an update is available".
- **Its wording,** the owner's, 2026-11-11, for the brief's line: "Sets the backend for agentStart. If more than one is installed, you must specify which." and "Adjust other ones to be about as concise as that". Written from it: the brief, "`backend` sets the backend for `agentStart`. If more than one is installed, you must specify which."; the `agentStart` description, "`backend` sets the backend. If more than one is installed, you must specify which."; the guidance, the same with `agentStart.backend`; the refusal, "Specify `backend`: codex, copilot, opencode". The three written from it wait on the owner's read. The brief's description and first line name all three backends ("Codex, Copilot or OpenCode"). Owner: "alright. A. name them."
- **Dogfooding:** once OpenCode can start an agent, build, push, have the owner reload the plugin, and implement the rest through `agentStart` on OpenCode and Switchboard workflows. Owner, 2026-11-11: "feel free at any point to build and push, then have me /reload your plugin, and then you just dog food work with start agents and Switchboard Workflows to use them to implement."

### Design: one agent stack, one driver per backend

Mapped on 2026-11-11 by eleven Luna readers, one per layer, with both Gateway stacks and the contracts read first hand. The two stacks are one state machine written twice. Copilot's copy is the leaner one, and local mode already has the per-backend seam (`LocalBackendSession`) the daemon lacks.

**The rule:** the Gateway knows agents, and a backend is a table row plus a driver. Nothing decides by a backend's name, as nothing decides by a CLI's name.

- **The table:** `AgentBackendDescriptor` takes every fact that is a name branch today: the default model, the start options it takes (`tier`, `effort`), and Copilot's legacy fingerprint spelling. Whether its threads outlive its child is the driver's. `AGENT_BACKENDS` stays the one list, derived from a row per id.
- **One wire:** `agentWire(backend)` builds the command, receipt, event, hello and ack schemas, with the frame types `agentFrameType` already derives. The native handle is `sessionId` for every backend (Codex's `threadId` goes). Delivery on the wire is `started` or `steered`. A failed interrupt is an `interruptResult` with `ok: false`, fenced and reliable, in place of Codex's `interruptFailed` and Copilot's plain rejection. A reconcile reports `turnId` and `turnState`, and Copilot's `active` becomes `inProgress`.
- **One record:** Copilot's shape, where an operation holds its own prompt, model and delivery, plus Codex's sticky `serviceTier` and a turn's `finalItemId`. Codex's `exchanges`, `preDispatch`, `acceptanceFence`, `acceptanceUnverified`, `noOp` and `pendingInterrupt` go: each restates a fact an operation or a turn already holds, and the record's cross-field checks exist only to keep the copies agreeing. An interrupt in progress is read off the stop operation aimed at the active turn.
- **Stored catalogs:** one map on the session record, keyed by backend. A stored Codex or Copilot catalog is converted once at restore. A Gateway rolled back over the new file reads no agents and writes none back, so a rollback loses every agent's history. Accepted: a daemon restart ends running agents anyway.
- **One Gateway stack:** one service, applier, commands facade, route and relay family, built per backend from the table. `composeAgents` holds a map of stacks, and the session store, the inbound frame routing, the workflow families, the awareness roster, the baseline and the notices read that map.
- **One driver per backend, for the daemon and local mode alike:** `AgentBackendSession`, grown from `LocalBackendSession`: open a thread, resume one, start a turn that answers its id now and its outcome later, steer, interrupt, inspect a turn, list models, and report activity, counters and its own close. A generic daemon service runs the commands over it on `AgentDaemonCore`. A driver table pairs each backend with its launcher and its session.
- **OpenCode's driver talks to a bridge:** `opencode serve` is an HTTP server, and a container's loopback is out of the daemon's reach. So a bundled entry point runs beside the server, on the host or inside the container, starts `opencode serve --stdio --port 0` with a minted password in its environment, and speaks JSON lines over its own stdio. The daemon's existing launchers carry that pipe, the server ends with the bridge, and the driver is one more child protocol, as Codex's and Copilot's are.

**Order, the generic stack is Copilot's, generalized in place:** it is the leaner copy and its tests come with it, so the generic stack is born from one that runs. OpenCode is its second tenant and Codex moves last. Each step ends green.

1. Copilot's stack rewritten as the generic one, in its final form: the one record, the one wire (each backend's frames keep their `<backend>_<kind>` types, so no routing changes), and the merged rules below. Its tests carried over, each changed assertion traced to a rule.
2. The generic daemon service over `AgentBackendSession`, Copilot's session as the first driver, used by the daemon and local mode alike.
3. `composeAgents` holds a map of stacks (`AgentStack`), and the consumers read it. Codex's stack sits behind the same seam, unchanged.
4. Tests for each merged rule the carried tests do not reach, and for a stored Codex catalog read as the one shape.
5. OpenCode: its row, its capability, its bridge and driver (built by Switchboard (OC) against the interface, each answer reviewed), `agentListModels`, the tool and guidance wording as settled. Release, reload, dogfood from here.
6. Codex moves: its driver, its catalog converted, its old stack deleted, its tests carried over. Last, since its daemon holds the most.

**What OpenCode adds to the contract:**

- **A prompt has a key:** `TurnOptions.key` and a `key` on `steerTurn`, the operation's id. A prompt posted to an OpenCode session that has just gone idle starts a turn by itself, so a steer that misses its turn and the new turn the service then opens for it must be one prompt. A driver that can tell lands a repeat under one key once; Codex's and Copilot's ignore it.
- **A steer resolves only once its turn took the prompt,** and rejects when the turn ended first. The facts are the driver's, so the race is closed there and the service's rule (a turn that ended under a steer opens a new one) holds unchanged.
- **Threads outlive the child:** OpenCode keeps sessions in its own database, so `resumeThread` and `inspectTurn` work on a fresh server.
- **A child that is this build's own entry point** needs the runtime in a container before it launches there. The driver table says so, and the daemon places it, as it does for a session's launcher.
- **`agentListModels` waits for Codex's move,** so one `models` command answers for every backend. `newestPerFamily` in `src/shared/agent-models.ts` is its rule: a family is an id with its version tokens removed, where a version is a number standing alone or after letters (`v4`, `o3`, `qwen2.5`) and digits before letters are a size (`70b`, `4o`).

A Gateway and its daemon restart together at every deploy, so the wire between them changes without a compatibility window. A plugin older than its Gateway keeps posting to its backend's path in the request shape it knows, and every field it reads in the answer stays.

**Where the two disagree, the merged rule takes the stricter side:**

- **A steer that lands as its turn ends:** Codex's daemon starts a new turn with the prompt once the end is confirmed; Copilot's reports `steered` into a finished turn and the message is lost. The generic service takes Codex's.
- **A message while an interrupt is in flight:** Codex refuses until the turn's terminal; Copilot allows a steer into the turn being aborted. Refused for all.
- **An event on a record with no fence:** Codex reconciles; Copilot lets the event set the first fence. Reconciled for all.
- **Codex compares the record's fence at dispatch with its fence at receipt,** so commentary arriving between a steer's dispatch and its receipt refuses the acceptance. The merged rule checks the turn and the stream, as Copilot's does.
- **A terminal's payload:** Codex's schema requires a completed turn's answer and a failed turn's error; Copilot's allows neither. Required for all.
- **A daemon told to stop refuses new commands,** and a refusal's diagnostics are capped at 256 and kept only for an operation still waiting. Both for all.
- **A silent turn:** Codex interrupts one after ten minutes without progress; Copilot waits forever. The watchdog's clock is generic and the probe is the driver's `inspectTurn`.
- **Left as they are:** `reasoningEffort` and `serviceTier` stay outside an operation's fingerprint, since adding either would fail every stored record's check.

### Built so far

Steps 1 to 4, committed as `78597087` once the audit below was triaged. Copilot's Gateway stack, daemon service and local session are deleted, and one generic stack (`agentService`, `agentApply`, `agentReducers`, `agentCommands`, `agentRelay`, `agentRoute`, `agentStack`), one daemon service (`agentDaemonService`) and one driver contract (`backendSession.ts`) run it. Codex sits behind `AgentStack` on its own stack.

Step 5 without `agentListModels`, committed as `75e89fa8` and released as 8.14.63 on Sakura, mikan and matrix-edward: OpenCode's row, the `opencode-agent` capability, the bridge (`src/opencode-agent/bridge.ts`, entry `main-opencode-agent.ts`), the driver (`opencodeSession.ts`), its launcher, and the container runtime placement. The Router and the phone were left as they were: neither reads a capability id strictly.

**First live run, 2026-11-11, host target:** `agentStart` on OpenCode answered `started` and completed with a correct answer; an `agentMessage` to the idle agent answered `followup` on the resumed thread; a second message while that turn ran answered `steered` under the running turn's id; `agentStop` settled a running turn `interrupted` and its notice arrived. A Switchboard workflow with two OpenCode steps sharing one `skills` file and a `schema` succeeded, which also shows the skill journaling change live.

Seen on that run and left: a collected turn's `delivery` is the word of the last message into it, on both stacks, so a turn a follow-up opened and a steer then joined reads `steered`.

Step 6, Codex's move, in the working tree. Mapped first by nine OpenCode readers in one Switchboard workflow, one per slice (reports kept in the scratchpad), then built:

- **Gateway:** Codex is one more `createAgentStack`. Its own service, reducers, applier, commands, relay and route are deleted. One catalog store per backend; a stored `codexCatalog` or `copilotCatalog` is read once at restore (`LEGACY_CATALOG_FIELD`, dated). The `family` branch of `decideAgentReconciliation` is gone, so Codex adopts a turn its daemon reports running that the record did not know, as the others do.
- **Daemon:** `AgentDaemonService` took what only Codex's service had: the silent-turn watchdog and the idle reap (`now`, `setSweep` seams), a bound on remembered threads, `adoptTurn` after a failed start and at reconcile, and settling an earlier turn asked about while a later one runs. The contract grew `adoptTurn`, `onProgress` and `busy`. `CodexBackendSession` (`src/mcp/agents/codexSession.ts`, built by an OpenCode agent from a spec and reviewed) is the driver for the daemon and local mode: the held-terminal deadline, counters, progress from the turn's own thread, inspect, adopt, the model list.
- **OpenCode's driver reports life too:** the bridge sends one `progress` line per turn every 15 seconds from a wider event list, probed against a real 2.2.5 server. Copilot's driver reports none, so its turns are never judged silent (`bd_458e7ca2ca3b98ec7c60cd2301ad6db2`).
- **`agentListModels`:** a `models` request kind on each backend's route, the `agentModels` host op, `AgentDaemonService.listModels` over the driver, the same in local mode, and `offeredModels` (newest per family, the default marked and always listed). The owner's Q7 wording is in.
- **Tests:** the harness's fake daemon lost its Codex-only surface (`createFakeDaemon`, `agentCommands("codex")`, `onAgentCommand`). The seam, register-recovery and recovery-vector tests run every backend through the one stack. Codex's contract, relay, harness and daemon tests were carried over by agents from specs.
- **Deleted:** Codex's daemon service, command dispatch, session lifecycle, watchdog, live-turn store and daemon types, and its own wire files (`codex-agent.ts`, `codexAgent*.ts`). The App Server messages its driver reads stay in `src/shared/codex-app-server.ts`.
- **One target layer:** `agentTargets.ts` holds the manager, the env scrub and the one process adoption for every backend, with no Codex defaults (`ExecutionTargetManagerOptions`). `codexTargets.ts`, `copilotTargets.ts` and `opencodeTargets.ts` hold a launcher each; the three copies of process adoption are one `adoptProcess`.
- **A turn that hung running, found by a carried-over relay case:** an event held for reconciliation was judged a duplicate once the reconcile receipt moved the fence past it, and was acknowledged unapplied. `drainDeferred` now replays it as `held`. A regression case in `agent-route.test.ts` fails without it.
- **The fake daemon keeps an outbox:** a restart case hung because the fake sent each frame once, so a terminal in flight when the host socket closed was gone, where the real daemon replays what was not acknowledged. Under Codex's own stack the same case passed on microtask order alone. The fake now holds frames until acknowledged and replays them after its hello.

**The OpenCode Go plan ran out mid-run (2026-11-11):** fourteen agents on `opencode-go/deepseek-v4-pro` in about 35 minutes reached its five hour usage limit, and four of five implementers were cut off. Their partial edits were finished by Luna.

### Audit, 2026-11-11

Six Luna readers on the uncommitted slice: Gateway parity with both old stacks, the daemon and the driver contract, local mode, stored state and mixed versions, decisions by a backend's name, and the tests. Changed after triage:

- **A message's receipt that replays after reconciliation adopted its turn** was refused and the operation left uncertain. `decideAcceptance` binds a requested operation to a turn no other operation opened.
- **Held frames:** `AgentRelayCore.defer` compared event ids across streams, and dropped an outcome when 128 were held. It compares the stream too, and drops commentary only.
- **A requested operation with no daemon named** was neither abandoned nor resent at a register. `decideRegisterRecovery` abandons it, on both stacks.
- **A write held unconfirmed** left its operation `requested` and unsent: the agent refused the next message, and the next register would have sent the stale one. The generic service gives the operation up. Codex's stack keeps the gap until it moves.
- **Local mode** took the merged rules it lacked: a pending interrupt refuses a message and a second stop, a steer whose turn ended opens a new turn, the driver's failure code reaches the answer, and not-found reads as the Gateway's.
- **`settledNow`:** whether a turn ended under a steer was read after a fixed number of promise hops, which a rejected steer got wrong in local mode. Both callers now ask the turn's own promise.
- **Copilot's driver** answers a turn before its send does, as the old service did, and an exit while its models are read fails the open. The daemon service retires a session whose driver closes.
- **One registry:** `BACKEND_ROWS` is keyed by every `AgentBackendId`, and the workflow backend schemas, the gated capability ids and the tool fixture derive from it. The relay core's `backendId === "codex"` is gone.

Read and left: the mixed-version findings are the window the deploy note above accepts. A Gateway and its daemon restart back to back on each machine.

**For Codex's move, from the driver audit:** a driver cannot hand back a turn it finds running (`adoptTurn`), cannot be told its terminal was published before it parks a thread, and the silent-turn watchdog has no home yet.

### Align audit, 2026-11-11, Codex's move

Eight Luna readers and an Opus join on the uncommitted slice: Gateway parity, daemon parity, stored state and mixed versions, the settled wording, local mode, the tests carried over, residue, and workflow dispatch. Changed after triage:

- **A reconcile about a running turn kept the owner it was started under.** A resume handover renames the owner's key, and the turn's terminal then names a session the Gateway no longer holds. `runReconcile` rebinds the running turn, as Codex's own dispatch did.
- **An older plugin's list request was refused:** Codex's route accepted an ignored `detail`, and plugins from before 2026-11-07 still send it. `AgentListInputSchema` takes it again, dated 2026-11-25.
- **A workflow step on Luna ran at the standard tier.** `startDefaults` ran on the tool's path alone. It moved to `src/shared/model-family.ts` and the workflow dispatch applies it to a start.
- **Codex's model list was its child's handshake answer.** It is read on each call and replaces what the child may start; an empty answer replaces nothing.
- **`agentListModels` was missing from the guidance's tool list, the brief and the map.** Added to each.
- **The legacy catalog read lost its date** in the comment pass. Restored, 2026-12-11.
- **Dead exports:** four App Server schemas nothing read are deleted, and seven helpers are file-local.

Read and left:

- **A stored Codex operation with no acceptance marker is no longer put into recovery.** The old stack wrote the marker at every restore since 2026-08-05, and all 2,416 accepted operations in Sakura's file carry a fence.
- **Copilot's model list is still its child's handshake answer.** Not changed without a live run.
- **"`effort` is Copilot only; `tier` is Codex only"** names Copilot first, in the options' order. The owner's wording.
- **The foreign-daemon acceptance branch** is reached by "applies what a turn said while its acceptance waited on a reconciliation" in `agent-route.test.ts`.

**Second pass** on what the first changed, the daemon's frame order, the route's answers, and recovery with local mode. Four Luna readers and an Opus join; two findings dropped as wrong, three kept:

- **A steer refused while Codex still held a finished turn's terminal was rejected.** Codex holds a terminal up to ten seconds for its final item, so the turn's own promise had not settled and the generic service refused the message, where Codex's dispatch read the thread and opened a new turn. After a refused steer the service now asks the driver's `inspectTurn`; a settled turn is published and the prompt opens a new one. Local mode took the same rule.
- **Local mode lost a turn whose start reply failed,** and a retry sent the prompt again on a second thread. It now takes the running turn through `adoptTurn`, as the daemon does. Same at HEAD; the Codex driver made it cheap.
- **Local mode has no silent-turn watchdog.** Same at HEAD. On the board under the one-handler entry, `bd_c9b55cbd21bc148fa77a38b0f3169a55`.

### Red team, 2026-11-11, Codex's move

Eight Luna readers and an Opus join: daemon interleavings, the Codex driver, the relay under replays, security, deploy and mixed versions, workflows, what the harness cannot see, and cost. Eleven findings, checked against the code. Changed:

- **A refused steer could publish an empty answer.** The second align pass made a refused steer ask `inspectTurn`, and Codex's read can show a turn completed before its final item is in it. The driver now reads a turn it still holds a terminal for as running until the answer is in the read; the hold's deadline settles it as before.
- **A reconcile reported a turn as running after publishing its terminal.** `runReconcile` read an earlier turn while the running one ended. It looks again after the read. On the Gateway a reconciliation naming a turn the record already ended no longer makes it active, where the record used to fail to parse and the receipt was held for good.
- **Held frames waited on an unrelated later frame** once the five minute guard swallowed their ask. A one-shot re-ask fires when the guard lifts.
- **Listing Copilot's models left its child running for good,** since no reap takes a child whose threads cannot reopen. A child opened only to list is given up after, and concurrent listings of one target share one read.
- **Each event built its fence twice.** Once now.

**Re-check of those fixes,** four Luna readers and an Opus join; two angles found nothing:

- **The driver's held-turn rule could strand a turn.** A hold's one deadline read that said running left the terminal held with no timer, and the new rule then read the turn as running for good, until the watchdog gave its whole child up. The rule holds only while the deadline is armed.
- **Local mode could take another prompt's turn as its own.** Two messages racing on an idle agent: the second start is refused, and the adopt added above handed back the first one's turn. A turn the agent already holds is not adopted.
- **Left: Copilot's steer refused just before its turn's end reaches the daemon is rejected,** since Copilot's driver has no `inspectTurn`. Same at HEAD, and not changed without a live run.

Read and left:

- **A backend's capability is checked only at the tool,** so a session that posts to a switched-off backend's route still starts its child. Same at HEAD. On the board, `bd_b0c16c940c9df941d2e3ddf4dd572cf7`.
- **A held counter can be counted twice** when a replay counts it and more than 4,096 counters pass before the held copy drains. Dropping the held copy on a replay was tried and taken back: a replay ignored as a duplicate would then lose an event only the held copy can apply.
- **`agentListModels` fails when Codex's default model is not offered,** since its child's open checks the default. Every start fails then too.
- **The outbox can evict a terminal past 1,000 held frames, and a same-process turn mismatch can ask forever.** Same at HEAD. On the board with the held-frame entry, `bd_6f6eeb94f93e76dcca7a126d098a6e35`.
- **A cumulative acknowledgement cannot pass an unreduced frame:** the socket stage applies a backend's frames one at a time.
- **Dropped as wrong or accepted:** an older daemon or plugin beside a newer Gateway for the minutes between restarts, error text reaching the owner's own session, and the catalog's cost, which matches HEAD.

### Architecture audit, 2026-11-12

Six Luna readers, one per Bug Class below plus the Codex driver and the names, and an Opus join that checked each claim against `e87b5715`. Six opportunities, in this order:

| | Name | Ends |
|---|---|---|
| A | The daemon's real agent runtime in the harness | The fake daemon as a second implementation |
| D | A typed catalog commit outcome | The uncertain catalog write |
| B | One owner for a held frame | A held frame judged against a fence that moved |
| C | One turn runner over the driver | The same command rules in local mode and the daemon |
| E | One owner for a Codex turn's hold | Not a listed class; the hold rule was patched twice |
| F | A naming pass | Nothing alone; last, since B and C delete half the names |

**A is built:**

- **`agentDaemonRuntime.ts`:** the daemon's agent side as one value, a target manager and a service per backend with the hello, the replay, the routing and the model listing. `hostDaemon.ts` builds it and constructs no service.
- **`scriptedAgents.ts`:** a driver per backend whose child is a pair of streams. A scenario holds a turn, feeds it activity and settles it; it can no longer write a receipt, an event id, a generation or a reconcile answer.
- **The fake daemon is deleted:** `FakeAgentDaemon`, `createFakeDaemon`, `stockAgentResponder`, `sendAgent` and `onAgentCommand`. The Codex and workflow harness suites run the real target manager, daemon service and outbox, and a child that exits reaches generation 2 in a harness case. Breaking `AgentDaemonCore.replay` fails three of them; before, nothing would have.

**What the real daemon found on its first run:** a daemon restarted with a turn's terminal in flight, and a message sent straight after. The new daemon's turn was accepted while the record still held the old turn, so its receipt was held; the old terminal then arrived and was applied, and nothing retried the held receipt until the five minute guard lifted. The follow-up's answer sat for five minutes. The fake never showed it, since its reconcile answers came from its own map.

**Changed in `AgentRelayCore`:**

- **A held frame is retried after every frame applied to its agent** (`retryHeld`), where it used to wait for the answer to its own reconcile ask. The map that matched that answer is gone.
- **The drain no longer acknowledges before it replays.** It cleared the hold and acknowledged first, so a frame held again had already been dropped by the daemon.
- **A replay of a held frame decides nothing** (`retriesHeldCopy`): judged on its own it could read as a duplicate and be acknowledged. A counter can no longer be counted by both the replay and the held copy.

**Red team on A, 2026-11-12.** Six Luna readers and an Opus join: the relay's held frames, the applier under repeated retries, the extraction's parity, whether the harness can lie, what the test migration lost, and residue. Seven findings kept, each checked against the code. Changed:

- **A frame from a retired generation was held for good.** A lost acknowledgement left a generation 1 terminal in the daemon's outbox; once the fence moved to generation 2 its replay read as foreign and was held, retried and asked about every five minutes, and carried on every connect. At HEAD the drain acknowledged it unapplied, which hid the same hold. `applyEvent` now ignores an event that can never be placed: one from an older generation of the stream the agent follows (`retiredGeneration`), or one naming a turn the record already ended.
- **A lost acknowledgement was never sent again,** which is what left that frame in the outbox. A frame replayed at or below the acknowledged mark is acknowledged again. The harness's lost-acknowledgement case now ends with a third link that carries nothing of the turn.
- **A throw in a retry lost the held frames after it.** `retryHeld` keeps what it did not reach.
- **Every scripted backend offered one set of driver methods,** so a Copilot case took recovery branches production never takes. `REAL_SESSION` names each backend's set, a test holds it to the real classes, and only OpenCode's scripted session drops a repeated start by its key. Every harness case still passes with the stricter doubles, so the daemon's own ledger is what keeps a start to once.
- **No case made the Gateway resend:** a reliable answer replays before the resend runs. A refused start whose refusal the link lost is the new case: nothing retains a refusal, the Gateway resends, and the daemon answers from its ledger without asking the backend again.
- **Loss flags passed at setup were dropped,** as `skillText` was, and a fake host that built its own daemon never shut it down.
- **The held-replay case could pass with the replay swallowed.** A second case proves the held copy is applied.

Read and left:

- **A refused reconciliation may leave a held frame with no ask coming** when the agent's fence already names the live daemon. Unproven, same at HEAD, and B's to bound.
- **A refused start whose write conflicts is acknowledged unpersisted.** Same at HEAD; D gives the commit the outcome to tell.
- **An agent with 128 held frames retries all of them per applied frame.** Bounded by the cap.
- **Dropped as wrong or out of scope:** local mode's silent turn, which this change does not touch, and two harness notes about failures no case models.

**Re-check of those repairs,** three Luna readers and an Opus join; the applier angle found nothing:

- **An acknowledgement could reach a daemon it did not name.** A frame arriving on a host socket another had replaced was labelled with the new socket, so it was applied, and the repeated acknowledgement added above then answered it on the new daemon's link. A daemon matched an acknowledgement by target, generation and event id alone, and every daemon numbers those from the same start. `queueHostFrame` now judges the socket a frame arrived on, and `AgentDaemonCore.acknowledge` ignores one naming another daemon. The labelling was the same at HEAD.
- **A throw during a retry left the retry state wrong.** A change listener that threw skipped the retry of held frames, and inside a retry it queued a decided frame again. A listener's throw is caught where it is called, and a held frame whose own retry throws stays held while the rest are tried.
- **Left: the scripted backends' test reads each real class's prototype,** so an optional method added as an instance property would pass it. None is one today.

A and its two audit rounds are committed as `50084644` and released as 8.14.65 on Sakura, mikan and matrix-edward. A Codex `agentStart` ran through the extracted runtime and completed.

**D is built:** `AgentCatalogPersistence.write` is the one catalog write, and answers `landed`, `unconfirmed`, `conflict`, `failed` or `owner_missing`. An unconfirmed write is in the record and on disk unless a crash undoes it; the last three changed nothing. The store's result carries the held catalog for it.

- **`AgentService.commit` switches on the kind.** Only `landed` lets an operation be sent. `unconfirmed` gives the operation up, as before; `conflict` and `failed` held nothing and give nothing up.
- **A daemon frame whose write is unconfirmed is `unconfirmed` to the relay,** a disposition of its own. Listeners hear it and held frames are retried, since the record changed. The frame stays held, and is decided when `confirmed` says its revision is on disk. It used to answer `reconcile`: the daemon was asked about a record that was right, and the frame's retry then read as a duplicate and was acknowledged with its durability still open.
- **A collect lost its turns on an unconfirmed mark.** The mark was held, the write read as nothing changed, and the retry found the turns already collected and handed over none. Found by the type forcing the branch. A retirement had the same shape and answered "not retired" for an agent already gone from the record.

The journal, retention and eviction the audit also proposed are not built: they change how long an agent stays addressable, which is the owner's call.

**Red team on D, 2026-11-12.** Three Luna readers and an Opus join: every caller of the persistence layer, the relay's waiting frames, and the tests against the written claims. Four findings kept. One stream carries every agent on a target and its acknowledgements are cumulative, which is what made the first two matter. Changed:

- **A waiting frame never cleared once its session was forgotten.** Its revision could no longer be confirmed, so it was queued again for good and held back the acknowledgements of every agent on that target. `confirmation` now answers `gone` when the owner's catalog no longer reaches the revision, and the frame is let go.
- **A waiting frame was retried only by its own agent's next frame or a reconnect.** A later write by any other agent had already put it on disk. `retryAwaiting` runs when any agent's write lands and on each `reconcileStale`.
- **A disk that kept failing its directory sync cost one snapshot write per waiting frame per retry.** One attempt per owner per pass.
- **The map and the doc said every caller keeps the five kinds apart.** Only `write` and `AgentService.commit` do; `apply` and `retire` fold the three that changed nothing. Reworded.

Read and left:

- **A Gateway restart forgets which frames were waiting.** The daemon replays them, they read as duplicates and are acknowledged. The catalog they are judged against was just read from disk. Same at HEAD.
- **An unconfirmed refusal of an operation is not held:** it names no stream and the daemon keeps no copy. A crash that undoes the write also restarts the daemon, and the operation is then abandoned as stale.
- **A second failed write while giving an operation up leaves it `requested`,** so the next register from the same daemon resends it. Same at HEAD.
- **No case drives `conflict`, `failed` or `owner_missing` through a session's start, message or stop,** or an unconfirmed notify mark, retirement or register pass. The persistence test covers the kinds themselves.

Left for B, and built there: a frame whose application `failed` had no ask and no deadline, the outbox evicted past 1,000 without telling the Gateway, and `askAgain` re-asked once.

### Bug Classes

- **The same command rules live in local mode and in the daemon service** (`LocalAgentHandlers`, `AgentDaemonService`). Four disagreements found in one pass and patched in local mode. Codex's move found three more: the adopt after a failed start and the refused steer, both patched in local mode again, and the watchdog, left. One command handler over the driver for both is on the board, `bd_c9b55cbd21bc148fa77a38b0f3169a55`.
- **A list that names backends by hand:** the registry array, two workflow schemas, the gated capability ids and the tool fixture each listed Codex and Copilot. Patched to derive from `BACKEND_ROWS`. The guidance prose still names them and is the owner's wording.
- **An uncertain catalog write** (`AgentCatalogPersistence.commit` over a store that keeps an unconfirmed write in memory): patched in the generic service by abandoning the operation, while the shared layer still reported it as "catalog changed while saving". Ended by opportunity D: `write` answers five kinds and every caller switches on them.
- **A frame held for reconciliation is judged against a fence that moved while it waited** (`AgentRelayCore` deferred frames over `classifyEventFence` in the applier). Round one, the audit: a held receipt, patched with `laterFence` and binding the operation by its turn. Round two, Codex's move: a held event, patched with the `held` flag past the duplicate check. Round three, the red team: held frames had no ask pending once the guard swallowed one, patched with a one-shot re-ask. Round four, the architecture step: a held receipt waited on its own reconcile answer while the frame that placed it had already been applied, and the drain acknowledged before it replayed; patched with a retry after every applied frame. Four rounds in one mechanism. The fence orders by event id while a held frame's own id no longer says where it stands, and nothing owns how long a frame may wait. One owner for a held frame's order, deadline and replay gaps is on the board, `bd_6f6eeb94f93e76dcca7a126d098a6e35`, and is opportunity B above.
- **The harness's fake daemon was a second implementation of the daemon's wire behavior:** it had no outbox, so a case's result depended on which microtask ran first, and its reconcile answers came from its own map. Ended by opportunity A: the harness runs the daemon's own runtime.

### Architecture B: one owner for a held frame

Designed 2026-11-12 from a full read of `AgentRelayCore`, `agentApply.ts`, `agent-recovery.ts` and `agent-fence.ts`. The deadline is the owner's answer A, 10 minutes.

**What is scattered today, all in `AgentRelayCore`:** `deferred` (the held frames per agent), `streams` with `undecided` (the hold barriers and the acknowledgement mark), `lastReconcileAskedAt` and `reasks` (the ask guard and its one-shot retry), `retrying` and `retryAgain` (reentrancy), and `countedEvents` (a bounded set so a counter counts once).

**What that shape still gets wrong:**

- **A frame is known to the stream only once its reducer ran.** Frames queue per agent, so a later frame of another agent can be decided first and acknowledged past an earlier one still queued. If that earlier one is then held, the daemon has already dropped its copy.
- **Only a `reconcile` disposition asks.** A `failed` application is held with no ask and no end.
- **The retry of a swallowed ask is one shot.** A same-process mismatch (`askAgain`) holds its frames for good.
- **A counter's once-only mark is forgotten after 4,096 others,** held or not.
- **Nothing ends a hold,** and one held frame stops the cumulative acknowledgement of every agent on that target.
- **The daemon's outbox evicts past 1,000 unacknowledged frames and tells nobody.** A turn whose terminal was evicted reads as working for good, since an agent whose fence names the live daemon is never asked about.

**The ledger, `src/gateway/agentFrameLedger.ts`, pure and clocked by its caller:**

- **`receive(frame)` at arrival, before the per-agent queue,** answers a ticket: `new`, `held` (a replay of a frame still held, which retries the held copy) or `decided` (a replay at or below the stream's decided mark, which is acknowledged again and not reduced). The stream knows the frame from that moment, so no acknowledgement passes it.
- **`resolve(ticket, decided | held(why))`** after the reducer. A held ticket keeps the time it was first held and whether its counter was counted, for its whole life. The per-agent cap stays 128 and still drops only commentary.
- **The acknowledgement mark is the ledger's:** through the highest decided id below the lowest open ticket. `countedEvents` goes, since a decided replay never reaches the reducer.
- **Unfenced frames,** a rejection, get a ticket with no stream.

**The relay's policy over it:**

- **An ask repeats every `RECONCILE_GUARD_MS` while an agent holds a frame for `reconcile` or `failed`,** where it fired once.
- **At 10 minutes the hold is closed** (`HELD_FRAME_LIMIT_MS`), counted from the later of the first hold and the live daemon's last hello, and only while a daemon is live. The daemon's last reconciliation is applied at its word, which adopts the turn it reports running. The applier's `closeHeld` then ends the record's open turn as interrupted with `AGENT_TURN_UNACCOUNTED_REASON` unless that reconciliation vouches for it. The held frames are tried once more against that record, and whatever still cannot be placed is given up and logged, a receipt's requested operation going `indeterminate` first. No interrupt is sent. The settled turn tells the session through the awareness it already has.
- **A frame awaiting its write has no deadline:** it is in the record, and `gone` already lets it go.

**The daemon's hello names what its outbox evicted,** per stream, and the Gateway asks about every working agent on such a target whatever its fence says.

Slices: B1 the ledger and its tests. B2 the relay on it, every relay and harness test passing unchanged. B3 the repeated ask and the close, with virtual-clock cases. B4 the eviction marker. Each is audited before the next.

**Built, 2026-11-12.** B1 and B2 are commit `4fdc58de`, every existing relay and harness test passing unchanged; B3 and B4 follow it.

- **What the build changed in the design:**
  - **A receipt is judged every time.** The first cut skipped any replay at or below a stream's decided mark. A receipt the outbox evicted can come back from the daemon's operation ledger out of stream order, and the applier places a receipt by its operation whatever its id, so only an event is told as decided by its position.
  - **No interrupt is sent to the daemon at a close.** Each branch was walked: where the daemon reports the turn running it is kept, where it reports another the first is not running, and where it answers nothing an interrupt would be refused too.
  - **The close reads the daemon's last reconciliation,** kept per agent only while it holds unplaced frames, where the design said "the turn the daemon last reported". A duplicate or an older generation's reconciliation is no word on the turn.
  - **A frame given up at a close is tried once more first,** so one the adopted turn can now take is applied, and a receipt still unplaced answers its operation `indeterminate` before it goes. A close whose write is unconfirmed makes the frames await that write.
  - **The eviction marker is a count per stream in every hello,** so a lost hello loses nothing, and the field is absent when nothing was dropped, since an older Gateway's hello schema is strict.
- **Checked by reading, with no gate:** frames reach the relay one at a time in arrival order (`queueHostFrame` chains them), and the daemon's `open` handler sends its hello and its replay before any live frame. An event told as decided by position relies on both.
- **Not covered:** no harness case drives the close through the real daemon; the cases in `agent-relay-close.test.ts` run the real service and applier on a clock the test moves.
- **A new line an agent reads:** an interrupted turn's reason, "turn lost: its daemon could not account for it" (`AGENT_TURN_UNACCOUNTED_REASON`). To settle with the owner.

**Audit of B1 and B2, 2026-11-12.** Three Luna readers on `4fdc58de`: old against new by scenario, the ledger as a state machine, and comments with what still sits outside the ledger. The ledger read found no defect. Two kept, both in how the relay settles:

- **A throw before the hold or the decision left a ticket open for good.** `isAskable` runs first and can throw; the replay of an open ticket is dropped as queued, so its stream's acknowledgements stopped. `reduce` now never throws and holds a ticket still open as `failed`.
- **A throw while retrying one held frame skipped the frames after it,** which the old loop caught per frame. The ask is caught where it is made, and `reduce` isolates each ticket.
- **Two rules were spelled twice:** whether a reduction is a retry, now read off the ticket's state, and whether a frame has a stream, now read off its identity.
- **A counter's mark was set before it counted.** Counted first now, and a relay case counts a held counter across two retries and a replay.
- **Comments:** nine reworded or cut, three that claimed more than the ledger knows.
- **Left:** streams are never pruned, as before the ledger. The ask guard's timestamp is not cleared when a reconciliation resolves, so a new need inside the guard waits for the watch.

**Red team of B3 and B4, 2026-11-12.** Three Luna readers on `3e792b8e`: the close against the applier, the timers, and the written claims against the code. The close was reworked on what they found.

- **A close could act on a stale answer.** The last report was kept per agent and read at the close whatever had happened since, so a turn opened after it was ended as unaccounted, and a report from a replaced daemon could vouch. The relay now keeps the daemon's last reconciliation receipt with when it came and when the record's open turn last changed. The receipt counts only if it is newer than the turn and from the live daemon, and the open turn is ended only if the daemon was asked since it opened.
- **An adopted turn kept the old fence,** so a reconciliation from a new generation that could not be written left its turn's events foreign for good. The close now applies that receipt through the reconciliation reducer itself, with `closing` turning a contradiction into "lost, and the daemon's turn adopted" under the receipt's fence. `closeHeld` only ends what is left unvouched.
- **An idle record skipped a running report** and gave up the frame the report would have placed. Applying the receipt first adopts it.
- **A frame decided during a close was acknowledged ahead of the close's own write.** Every frame decided against an unconfirmed close now awaits that write.
- **A send that did not get out spun the watch at zero delay,** since only a sent ask moved the guard. The next try is timed from the try.
- **A new daemon could be given up on before its hello,** on the old deadline. A close waits for the live daemon's hello; an ask does not.
- **A hello's eviction count was marked seen before its asks went out.** Marked after, and only where they did.
- **Relay timers outlived the Gateway's close.** `stop` clears them, called from the close.
- **Written claims corrected:** a throwing reducer's frame can still go as commentary at the cap; a decided event's acknowledgement is repeated only once nothing below it is open; a frame may be tried more than once at a close.
- **Left:**
  - **A start whose accepted receipt is given up leaves a live session on the daemon** that the record no longer names. It takes a record that refuses every write for ten minutes.
  - **A duplicate reconciliation is no word on the turn,** so a daemon that answers nothing new for ten minutes loses a turn it may still run. That is the owner's rule as stated.
  - **Repeated hellos postpone a close,** since each starts the wait over. A flapping link holds frames until it settles.
  - **Eviction counts are never pruned** on either side, and an eviction ask is not guarded. Both are bounded by how often an outbox overflows.
  - **A newer daemon's hello is refused by an older Gateway once it names an eviction.** The Gateway is restarted before the daemon on each machine.
- **A close needs an ask made during the hold.** Found while writing the re-check's brief: an ask from before the hold satisfied "asked since the turn opened", so a daemon no ask reached was still given up on. A close now gives nothing up until an ask went out since the hold began, and a close that gave nothing up asks again. An agent that cannot be asked at all is closed without one.
- **Cases added:** the last millisecond before the limit, a turn opened after the last ask, a send that does not get out, a close whose write is unconfirmed, a daemon whose hello has not come, an eviction ask that did not get out, and a daemon no ask reached.

**Re-check of the close, 2026-11-12.** Two Luna readers on `379c4e92`: the logic, and the timers with the cases.

- **A frame placed during a close retried the others without the close,** so a frame on another stream was decided and acknowledged while the close's write was still unconfirmed, and a frame left unplaced armed a second close at once. A closing reduction now retries nothing; the close visits each held frame itself.
- **A step queued before `stop` still asked or closed.** `tend` and the ask both stop.
- **Judged not defects:**
  - **A stale contradicting reconciliation used at a close** ends the same turn that no word at all ends, and the held receipt is decided as soon as a later frame passes it.
  - **A `creating` agent on a lossy target** is recovered by the resend at register: the daemon's operation ledger answers a repeated start with its accepted receipt.
  - **A failed ask for a stale agent is tried each persist tick.** It never reaches the wire, and a link that returns is asked at once.
- **Left, on the board:** a live daemon that never speaks a backend, because it no longer offers it, is asked forever. Its agents stay working and their frames held. That is older than the ledger.
- **Cases added:** two streams under an unconfirmed close, and a stopped relay.

### Architecture C: one turn runner over the driver

**Built, 2026-11-12,** in three local commits after B: the runner and the daemon on it (`0165552b`), local mode on it (`70894c25`), and the listing and reap parity.

- **`src/mcp/agents/turnRunner.ts`** runs one driver session's turns for whoever owns the session. It holds the adopt after a failed start, the steer with its fallback to a new turn under one key, the resume of a thread the session does not hold, the hold of what a child says before its turn is announced, thread memory, and the silent-turn watch. Its side supplies four callbacks: a turn's activity, counter and end, and a session past saving.
- **`AgentDaemonService` lost about 150 lines.** `runStart`, `runMessage` and `runInterrupt` are each one call and its answer on the wire; `runReconcile` is built from the runner's primitives; the sweep calls `watch`. Every daemon, runtime and harness case passed unchanged.
- **`LocalAgentHandlers` keeps only its records.** Its copies of the steer, the adopt and the dispatch are gone.
- **What local mode gained by sharing:** activity a child reports before naming its turn is kept; a silent turn is watched; a thread on the child that replaces a reaped one is resumed first, or the agent says it ended with its process; a child that closes ends its running turns as lost; a message or a stop waits for the one before it on that agent; listings share one read, a busy child is not reaped, and a child opened only to list models on a driver that cannot resume is given up.
- **Changed for the daemon:** an adopted turn the runner already told of is refused as another prompt's, which only local mode checked.
- **Left with each record's owner:** the pending interrupt and not-found, in `AgentService` and `LocalAgentHandlers`. The failure code is the driver's, read by both.
- **A test fake was wrong:** local mode's test backend opened every agent on `thread-1`, which the old per-agent bookkeeping hid. A driver opens a thread per agent, and one turn runs per thread.
- **Not covered:** no case runs local mode's 30 second sweep; `turn-runner.test.ts` holds the watch's rule and the sweep is a timer around it.

**Audit of C, 2026-11-12.** Three Luna readers on the three commits: the daemon against its old self, local mode, and the written claims against the code.

- **A model listing could strand an unused child.** Local mode asked whether any agent record existed, and a record outlives its child, so a listing after a Copilot child had closed kept the replacement it opened, which nothing reaps. It now asks that child's runner, as the daemon does.
- **Holding a new thread was written twice,** by the daemon through the runner and by local mode beside it. `begin` holds a turn's thread, and the runner's own open is gone. The thread map kept an owner nothing read; it is a set.
- **The daemon's idle clock changed, on purpose:** it starts at a turn's end and at what the runner publishes. A signal for a turn that has ended, or one not yet announced, no longer moves it. A child with a turn running is never reaped and a busy driver says so itself.
- **Written claims corrected:** only a driver that cannot resume answers that the agent ended with its process, a failed resume is its own error; the watch interrupts anything it cannot read as settled.
- **Cases added:** an early counter, the directory a resume is given, a session retired while a silent turn was read, and the stranded listing child.
- **Left:** a stop waits behind a message that is mid-steer, on both sides, up to 150 seconds on OpenCode. On the board.

### Architecture E: one owner for a Codex turn's ending

**Built, 2026-11-12.** `CodexTurnTracker` became `CodexTurns`, and `CodexBackendSession` lost its three per-turn maps.

- **One state per turn:** its output, the promise its handle waits on, and an ending that is `running`, `holding` with an armed deadline, or `checking` with a read in flight. A frame, a read, a deadline and the terminal the thread's owner publishes all end a turn through one function.
- **A hold cannot be left unarmed.** A deadline read that still said running used to drop the timer and leave the turn to the ten minute watch. It arms the next deadline, and the third ends the turn on what was witnessed.
- **An inspect that settled a held turn left the hold behind,** to settle a second time on a late item. The inspect ends the turn itself.
- **A handle registered after its turn ended is resolved at once,** from the last 256 ended turns. A terminal that beat an adopt's read used to leave a handle only the watch could end.
- **The handle resolves when the turn ends,** not when the thread lifecycle publishes. The lifecycle still buffers a terminal that beats its start reply, since the park must wait for the turn to be known as the thread's own.
- **A child's exit ends every turn in the owner,** and no frame or registration opens one after.
- **Not changed:** `adoptTurn` still answers nothing for a settled read. A Codex start whose fate is unknown poisons its generation, so a start that was merely refused opened no turn to adopt.
- **Dropped:** the tracker's stored commentary and its truncation flag, which nothing read. The cap on what is passed on stays.

**Audit of E, 2026-11-12.** Two Luna readers on `8d4a6f75`: the old session against the new owner sequence by sequence, and the written claims with the cases. No defect found.

- **Written claims corrected:** a close tries each unplaced frame, not every held one; a hold is three deadlines and their reads, not thirty seconds; `end` resolves and remembers, and the hand-on is the deciding path's; one promise only while a turn runs.
- **A comment named a residue test that no longer exists.** Gone, with seventeen comments shortened or cut.
- **Cases added:** an answer that lands while a deadline read is out, and a turn nobody registered that an inspect or the thread's owner ends.

### Architecture F: a naming pass

**Built, 2026-11-12,** after B, C and E removed half the names it was written for.

- **A backend is no longer called a family.** `AgentRelayFamily` is `AgentRelayPort`, `AgentCatalogFamily` is `AgentCatalogPort`, and the workflow engine's `agentFamilies.ts` is `stackAgents.ts` (`createStackAgents`, `backendOfAgent`).
- **"Held" now means a frame the relay holds.** The runner's map of what a child said before its turn was announced is `early`.
- **A reconciliation's fence verdict is `follows`,** so "adopt" is left to a turn.
- **Found by the alignment read and renamed too:** a notice's and a roster agent's `family` are `backend`, with `familySchema`, `hostFamilyPass` and `HostFamilyFrame`.
- **Codex names left generic code:** the service tier alias in local mode, a test alias, and `codex-tools.test.ts`, which is `agent-request.test.ts`.
- **Comments that counted two backends** now say every backend, in `agent-fence.ts`, `agent-record.ts`, `agent-execution-target.ts`, `agentRouteEnvelope.ts` and local mode's host.
- **`docs/agents.md` split its Codex section:** the stream, the ledger, the close and the recovery rules are under "The daemon stream", and "Codex delegation" keeps what is Codex's.
- **Left as they are:**
  - **`TargetSession` in the daemon service.** It wraps exactly one driver session with its runner, so "session" there is not a third meaning.
  - **`threadId` in the driver contract.** Every driver calls it a thread.
  - **`await` for a collect, `interrupt` for a stop, `serviceTier` for `tier`.** Each is a wire, a stored field or the tool's own word, and each crossing is one mapping.
  - **The baseline's `agents[].family`** names a backend on the wire between the Gateway and a session's hook, which update apart. An assistant action's `family` is its own word: where the action runs.
  - **"`backend` limits the list to one family"** in `agentList`'s description. Agent-facing, so it is the owner's to word.

## Phase 3 - Acceptance and docs

- Live on Sakura from the phone: create an OpenCode session, talk to it, watch it in the terminal view, approve a `.env` read from the card, compact it, close and wake it, and crosstalk with a Claude session in both directions.
- A devcontainer from the phone: start it, see the toggle offer only what is installed inside, create a session, stop the container with a session live, and wake that session again. Start one outside Switchboard and see its header follow. From a session: create one in a stopped container by `cli` and be told it is up, then name a CLI it lacks and be told the list. Break a project's `.devcontainer/` and be told to investigate it. Create one on another Gateway and be told there too. Run a routine into a new session with its pick, and fire a runbook into one with its pick.
- A container with Copilot alone: its header offers Copilot alone, a session is created, talked to, compacted and woken.
- Docs: `docs/architecture.md` (the harness table, the OpenCode roads), `docs/console.md` (the create pick), `docs/environment.md`, the setup step that installs the pin, AGENTS.md map lines. The stale line the map found, that Copilot gets no progress notices, goes. ✅ Each was already written with its slice, and the stale line is gone. The setup step is new: "3) Install OpenCode <pin>" in the setup menu (`scripts/setup-opencode.ts`), showing what this machine has against the pin and running `OPENCODE_INSTALL_CMD`, the phone macro's command.

## Side fix - Create and Forget for stopped containers

The owner's decisions are under `## Owner asks, open`. Mapped on 2026-11-12 by an Opus read of the code; the four Luna readers ahead of it failed on Codex's usage limit. Its claims were checked before building.

**What exists:** the daemon reports every devcontainer, running or stopped. The Gateway starts a stopped container on any create, the phone's included, and answers `pending`. A failed owner create posts the `launch: "failed"` notice row the phone docks. The phone has two Create buttons: the Gateway header's, which offers host shells only (`SessionsScreen` `onCreate`: "Containers create from their own header"), and a container header's, shown only while it runs (`containerButtons`).

**Missing, all on the phone:** Create is not offered for a stopped container, and a stopped container keeps the CLI list from the last look inside (`spawnContainerOf` reads `clis` whatever the run state).

Slices:

1. ✅ **The owner's line for a CLI missing in a container** reads "Devcontainer does not have OpenCode. Choose another CLI." `ownerLaunchLine` takes the launch's place; `lacksCliText` is the one spelling it shares with `launchRefusal`. The routine rows keep "was not installed". Commit `2323cad2`.
2. ✅ **A stopped container's CLIs read as unknown:** `spawnContainerOf` answers `UNOPENED_CONTAINER` unless the container is running with `clis` present, as the Gateway's `installedAt` does. The routine editor and the fire sheet then offer all three for a stopped container too. Commit `3b791319`.
3. ✅ **Create lists every devcontainer and starts a stopped one:** the Gateway header's Create offers `spawnChoices` (host shells, then containers); a container header's Create holds while stopped or starting; a stopped project reads "stopped" beside its name; a remembered project preselects only when it is ready; the sandbox's create moves a stopped container through starting to running. The session reads "Starting container" on its card's headline and its thread's starting dock while its container starts (`containerStartLine`). Commit `3b791319`, walked on the emulator.
   - **One readiness rule, from the audit:** an OpenCode audit found the meaning of a pick written only in the New session dialog, the fire's "Start on" list blind to it, and a container with an unread state word offered as a host shell while its header drew no Create. `spawnReadiness` in `SpawnChoices.kt` now answers all three pickers, and `spawnChoices` moved out of `runbooks/` beside it. The routine editor shows no note, since its run is later.
   - **A stopped entry is not greyed.** Owner, 2026-11-12, on the mockup: "don't grey a stopped entry. it can be up in a moment if chosen." This replaces "dimmed" in the decision under `## Owner asks, open`.
4. **The Forget purge: moved out of this plan.** Owner, 2026-11-12: "B. finish the plan first. then we do this proper: Workflow and Agents need to be deletable. Otherwise we end up with thousands." It gets its own plan after this one, covering a session's conversation, the threads of agents it started, and workflow data. Board, `bd_d22f96f9d49837029087a2b07fc6201c`.
5. **Forget asks first when the container is stopped: moved with slice 4,** since its line promises a purge. The prompt's wording stays settled.

**Asked on 2026-11-12, defaults built and not yet answered:** a running container with no CLI is listed disabled with "no CLI" beside it; a stopped project is never the remembered preselection; the dock's line for a failed start stays "Devcontainer failed to start." with docker's reason on the container's header. Also built without an ask: a container whose state word this build cannot read is listed disabled with no note, as its header draws nothing to press.

**Forget today, mapped 2026-11-12 for slice 4:** Forget kills the tmux session and drops the Gateway's record and what hangs off it. Nothing on disk is removed: Claude's transcript and its side folders under `~/.claude`, Copilot's `~/.copilot/session-state/<id>/`, OpenCode's session in its database (`opencode session delete <id>` exists), the plugin's `session-capabilities/<name>.json` and the launcher's status file all stay, on the host or in the container's home. No agent thread a session started is removed either. A kill into a stopped container reads as done, so a Forget there answers `killed` with nothing run. No sweep looks for leftovers of a session with no record. Only OpenCode's minted `ses_sb` ids can be told apart from the owner's own sessions after the record is gone.

**Traps:** `rememberedProject` can preselect a stopped container, one mis-tap from a build. `ownerCliPhrase` writes the routine rows too, so the new line is the owner line's alone. The sandbox's create ignored container state. A Forget's start failure posts no launch notice, so slice 5 reads the change in `SpawnContainer.failure` against the one from before the start. The phone's Create claim lapses at `SPAWN_HOLD_CAP_MS`, 30 minutes.

## Painpoints

- **A workflow call with an option the engine does not know vanishes (2026-11-11):** `agent()` throws on one such as `cwd`, and `parallel()` turns the throw into `null`, so the run shows no step and no reason. On the board, `bd_7fe5d9a585cd9656aa67bc1dd21b979a`.
- **A plain SSH command has no `bun` (2026-11-11):** `~/.bun/bin` is added by the login shell on mikan and matrix-edward, so every deploy command sets the path first.
- **One undecided frame holds every agent on its target (2026-11-12):** `AgentRelayCore` acknowledges per stream, a daemon and target and generation, while it holds frames per agent. A frame held for one agent stops the cumulative acknowledgement for all of them. Since B the ledger holds both, frames per agent and undecided ids per stream, but the block itself stands. Two of D's four red team findings came from it.
- **The relay's unit tests stub the applier with a flag (2026-11-12):** `setup` in `agent-relay.test.ts` answers `reconcile` or `applied` from a boolean, so a case can pass against a rule the real applier never produces. The case that pinned "release only on its own reconcile answer" was one; the real daemon in the harness is what showed the rule wrong.
- **Two 1,024 character budgets leave no room for settled wording (2026-11-12):** adding the owner's approved words overflowed `workflowStart`'s description by 61 and `WORKFLOW_INSTRUCTIONS` by 12. One sentence moved to the field's description and " (uncollected runs)" was cut. Each further word in either costs one already agreed.
- **An open question to the owner lives only in a message (2026-11-12):** the board and this plan held the titles of three waiting questions and none of their options. Asking them again meant searching the session transcript for the original wording.
- **No tool reads a session's chip (2026-11-12):** whether `needsLogin` shows was read with `curl` on the Gateway's loopback `/teams`, from a host session that happens to reach it. A session in a container, or on another Gateway, has no way to check what the phone draws.
- **The phone's Create list showed only "host" a minute after a daemon and Gateway restart (2026-11-12):** evie-bot was running with all three CLIs. Not reproduced; the list may wait on the daemon's first look inside its containers with nothing saying so.
- **An OpenCode session stays on the model its last turn used (2026-11-12):** the plugin posts a delivered prompt with no model, and the server reuses the session's last one. A session created in evie-bot before sign-in ran on the free model, hit its daily limit, and kept reading as login after the credentials were imported and its pane showed the signed-in model. A session created after the import answered at once. Only a prompt typed in its terminal moves it.
- **The comment step rewrites records as if they were code comments (2026-11-11, again 2026-11-12):** told to make prose timeless, a Luna step cut a doc comment's rule once, then replaced this plan's audit section and two Bug Classes histories with a description of the code, and stripped the reasons from five map lines in `AGENTS.md`. Each was restored by hand. The step needs the plan and the map's reasons named as out of bounds.
- **An OpenCode step's `schema` is one sentence in its prompt (2026-11-11):** two of nine long mapping steps answered in prose after 300 tool calls and settled `invalid`, with their reports written. Codex enforces a schema at its API. One repair message into the same thread, naming the validation error, would have saved both.
- **A running step or agent shows nothing until it ends (2026-11-11):** `workflowCollect` reads every unfinished step as `pending`, queued or working, and `agentCollect` on a running turn answers no activity and no counts. The first sign of life is the ten minute notice, or `agentList`'s `lastActiveAt`, which moves with each applied activity.
- **OpenCode refuses its whole event stream over one type name it does not know (2026-11-11):** `/api/event?types=` answers 400 for an unknown name, so a renamed event on a pin bump stops every turn's events. `EVENT_TYPES` in the bridge was probed against 2.2.5 by hand; no gate asks a real server.
- **An OpenCode steer waits for a step boundary (2026-11-11):** the bridge answers only once the turn took the message, up to two minutes, then withdraws it and refuses.
- **Workflow steps sharing a `skills` file all failed but the first (2026-11-11):** the store answers a skill row already journaled as a no-op, and the dispatcher read that as "could not be journaled". Changed in `appendSkillText` with a harness test; no earlier test started two steps with one skill.
- **A workflow whose result passes the size limit settles `failed` with every step completed (2026-11-11):** eleven map reports returned together read "workflow result is not JSON or exceeds the limit". Each step's answer was still on the collect, so nothing was lost, but the run reads as a failure.
- **A daemon restart kills every delegated agent mid-turn, and nothing says so first (2026-11-11):** `start-host-daemon.sh` restarts with a workflow's Codex steps running, and they settle `lost`. A deploy and an audit cannot overlap, and only memory keeps them apart.
- **The Gateway's log does not outlive a restart (2026-11-11):** `start-gateway.sh` recreates the container, so `docker logs` starts over, and `volumes/gateway/debug.log` holds no console ops. Who forgot two sessions an hour earlier could not be read anywhere.
- **The release phone build logs no send (2026-11-11):** `DebugLog` reaches nothing in release, so a double send could be shown at the Router and the Gateway and never on the phone that made it.
- **`setup.sh --verify` reads a busy start as down (2026-11-11):** it asks `/health` once. Right after a restart the Router or the Gateway can miss that one ask and pass a minute later.
- **A second spelling of a rule hides from the search for it (2026-11-11):** `SHELL_SAFE_NAME_RE` held the segment's character set as `[a-z0-9.-]`, so a search for `a-z0-9-` passed it by when the rule widened. That copy is gone and tmux names read `SLUG_RE`, but no residue test holds the set to `session-id.ts`.
- **An agent catalog commit costs the whole catalog (2026-11-11):** `AgentCatalogStore.commit` parses every agent to change one, and `session-resume.json`, 20 MB on Sakura, is written whole. A catalog now lives until its session is forgotten.
- **A CLI pick is applied by team, not by launch (2026-11-11):** `wake_result` and `cli_found` in `websocket.ts` call `resolvePick` for the team, and the first pick wins. A replayed result of an earlier launch can land on a retry's record and name its CLI and session id.
- **A late pick confirms nothing when two tokened sockets wait (2026-11-11):** `standLateToken` returns on more than one waiting socket and nothing asks again when one closes, so the survivor stays unconfirmed until evicted.
- **OpenCode's login and limit chips last until the next turn (2026-11-11):** both come from the last settled turn's error, so a sign-in fixed outside a turn still reads as login.
- **The Starting dock reads presence, not the launch record (2026-11-11):** a launch whose Gateway waiter ended while its record still runs shows no dock, and the dock cannot name a stage. The record's own state on the presence row closes both.
- **The host daemon runs on import:** `src/mcp/devcontainer/hostDaemon.ts` opens its socket and timers at module top level, so no test calls `handleWake`. Phase 1's container refusal and `launchHarness` there were checked by reading. Phase 2b adds container orchestration to the same function.
- **Copilot's phone palette is Claude's:** both rows of `HARNESS` hold `CLAUDE_SLASH` as `slashPalette`, so the phone offers a Copilot session slash commands it does not have.
- **`detectAgentType` answers the first CLI on the path:** a hand-started session with no `AGENT_TYPE` reads as Claude on any machine that has Claude installed, whatever CLI it runs in.
- **A CLI with no row gets Claude's slash tools:** `OTHER_AGENT` in `src/mcp/sessionCli.ts` sets `claudeSlashTools`, so `compact_session` and `set_effort_level` register for a CLI that cannot run them.
- **21 dated shims fall due on 2026-11-23:** the optional `harness` fields, `unnamed`, `claudeSpawns` and `copilotSpawns`, and the `copilotSessionId` twin. Nothing but a grep for the date finds them.
- **An OpenCode session's plugin runs from the checkout's `dist/`:** `LAUNCH` in `hostResolve.ts` points the MCP server at the daemon checkout, so a `--build-only` there changes what a live session runs on its next plugin restart, and every source commit first restores `dist/`. The marketplace copy the other CLIs run is not used.
- **The daemon blocks on `execSync` inside a start:** `isContainerReady` (up to 15 s) and plugin provisioning (up to 120 s) in `helpers.ts` hold the daemon's event loop, and a Stop cannot interrupt either. Every other session's presence and every host op wait behind them.
- **`hostDaemon.ts` is about 850 lines:** the wake, the catalog, the host ops and the container wiring share one module that runs on import. A split by concern is due.
- **Every caller reads a `WakeResult` its own way:** `ok`, `failure`, `refusal`, `errorKind` and `error` ride one shape, and `launchOutcome`, `createSession`, the console `wake` (`definite`), the send's `reach` and both reserves each decide what a timeout or a dropped link means. Two red-team rounds patched one reader at a time. A typed verdict from `WakeService` (up, failed with a cause, refused, unknown) would leave nothing to interpret.
- **The console takes its launch readers as loose optional deps:** `beginLaunch`, `watchOwnerLaunch`, `watchRoutineLaunch`, `awaitsLaunch`, `isLive`, `launching` and `isWakeInFlight` on `ConsoleHandlerDeps`, wired one by one in `composeRouterFrames`. One launch facade would keep the fence rules in one place; the assistant reserve repeats the routine reserve's order by hand.
- **`composeGateway` binds later stages by closure over a `const` declared below:** `tellRoutine` and `onRunbookMoved` name `routines` before it exists, safe only because nothing calls them during composition.
- **A stale CLI in a container fails as a 10-minute timeout:** `docker-workspace`'s `post-create` never refreshes binaries on an existing home volume, and Copilot's row declares no minimum version, so an old Copilot launches, rejects `--session-id`, and the session never registers. A version floor on the row would refuse it with a reason; a refresh in `post-create` would remove the cause.
- **A host Copilot's Switchboard plugin is stale:** Copilot never updates its own plugin copies; the owner's host session ran 8.14.41 against an 8.14.57 Gateway. A container's are installed once and never updated either, since its `installed` check passes for any version.
- **The container runtime is keyed by a version read once at boot, and old roots stay:** a `--build-only` or a pull under the same version leaves stale `dist/`, and each release leaves about 3 MB per container home. It is also copied into every container, OpenCode or not.
- **The container's bun, home and uid are assumed:** `/home/vscode/.bun/bin/bun`, and `docker cp -a` keeps the host uid, which matches `vscode` on this machine only by chance. A bun elsewhere leaves OpenCode unoffered with nothing logged.
- **An id minted for a launch that only read a live pane:** the lane mints at pick, before the pane road decides to read rather than launch, so `cli_found` can name an id nothing runs.
- **OpenCode's spent-free-tier text no longer reaches the phone:** it reads as login, and `needsLogin` carries no detail, so "switch models" is lost.
- **OpenCode's other turn failures show nothing:** `provider.connect`, `timeout`, `transport`, `invalid-request` and the rest leave the card live. "check terminal" is the owner's word for whatever else, and has no producer yet. Owner, on reading them as "check terminal": "good idea. but I might hold on the check terminal idea. we got a lot on our plates still".
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

- **Mechanical implementation goes to the Test OC session** (`host.76340a`, OpenCode, working in this checkout) by `crosstalk_send`, when it is mechanical enough to relay. Each relay names disjoint files from any teammate's, and its result is reviewed before it lands. Owner, 2026-11-10: "ok from now on, use Text OC session to do implementation, when mechanical enough to relay."

- **Try Copilot and OpenCode in the evie-bot container once 2c lands.** The base image installs OpenCode 2.2.5 (`docker-workspace` `6eddb07`). Owner: "sweet. then you can try it on Evie bot later." and "also try open code there too." OpenCode goes into the running container by hand (no rebuild). First with no login, to see that the phone's login-required chip shows. Owner: "actually don't yet. see if the detect for login required chip shows" and "for both copilot and oc". The pane check reads Claude's wording, so Copilot's logged-out screen may need its own. Only after that, the host's auth file copied in, mode 600, never printed. Owner: "copy it in this time".
  - **Run on 2026-11-12, 8.14.66.** Owner: "use Evie bot to ensure your login chip is noticed. then copy my login configs in and see that the session status works through devcontainer. then test a quick prompt on them". The chip's data, `needsLogin`, read true for an OpenCode and a Copilot session with no login. OpenCode 2.2.5 keeps credentials in its database, so there is no auth file: `opencode auth export` on the host was piped into `opencode auth import` in the container, and `model.json` copied. A session created after that read online with no chip and answered a prompt on `opencode-go/deepseek-v4.1-flash`.
  - **Copilot's login stays out of the container.** The chip check was the test. Owner, 2026-11-12: "A. we got enough data". Test sessions to forget: `evie-bot.26570e`, `evie-bot.dd0ca7`, `evie-bot.06b640`.

- **The phone's Create lists every devcontainer and starts a stopped one, and Forget offers to start a stopped container.** Owner, 2026-11-12, on the stopped-container prompt: "A. If it errors, hold off the forget and just have the usual startup failure path maybe I think? if that's the case, the create path needs the same thing. Show all Devcontainers and if it isn't up yet, attempt an auto up. Figure out the best way to display the start fail when auto up fails". This reverses Question 10's "only the phone's Create needs one running".
  - **The Forget prompt, settled:** title "Container is stopped"; line "Switchboard can only purge this session's data while its container is up."; buttons "Start container", "Forget anyway", "Cancel". A start that fails holds the forget.
  - **A failed auto-up shows on the session,** through the launch-failure dock, the card's headline and a notification, for Create and for Forget. A session an agent or a workflow created is told by its notice, as today. Owner, 2026-11-12: "A. Seems good. As for the agent or Workflows, it will just have to system notify them." A stopped project reads "stopped" beside it and is not greyed (owner, 2026-11-12: "don't grey a stopped entry. it can be up in a moment if chosen."); all three CLIs are offered for a stopped container, and a missing one fails with "Devcontainer does not have OpenCode. Choose another CLI." Create is built, commits `2323cad2` and `3b791319`; the Forget half is not. Board, `9fdb9c972f5040a99c0477b881690967`.

- **Forget purge, question 1, answered B on 2026-11-12, for a plan of its own after this one.** Asked: what should Forget remove from disk? A) the session's own conversation in its CLI and Switchboard's two files for it, agent threads stay; B) A plus the threads of agents it started; C) Switchboard's files only. Owner: "B. finish the plan first. then we do this proper: Workflow and Agents need to be deletable. Otherwise we end up with thousands." Still to ask in that plan: whether a hand-started terminal's conversation is purged, what a one-time sweep may touch given only OpenCode's `ses_sb` ids prove ownership once a record is gone, whether the 30 day sweep and a routine's forget purge too, and how an agent or a workflow run is deleted on its own, without its session being forgotten.
  - **Groundwork set aside,** stash `forget-purge-road-own-files`: one spelling of the capabilities and launch status paths (`src/shared/session-files.ts`), a `purgeSession` host op answering `purged` or `place_down`, and `createSessionPurge` removing Switchboard's two files on the host or by `docker exec`. Type-checked, with no test and no Gateway caller yet.
  - **Three Create defaults told to the owner the same day, unanswered:** "no CLI" listed and unpickable; a remembered project preselected only when up; the failed start line unchanged.
  - **matrix-edward missed the 8.14.67 deploy,** powered off. Board, `bd_d563b8ca162f5c257d0bce4e4882545c`.

- **Architecture opportunities from 2026-11-12, all four built in this plan and live in 8.14.68:** B, one owner for a held frame; C, one turn runner over the driver for the daemon and local mode; E, one owner for a Codex turn's hold; F, a naming pass after B and C. Told to the owner in that order on 2026-11-12 with "say if any should wait"; the answer named none.
  - **B's hold deadline, answered A on 2026-11-12.** Asked: how long may a held frame wait? A) 10 minutes, then give up on that turn: it ends as interrupted, the session that started the agent is told, and the agent takes a new message; a turn the daemon still reports as running is adopted instead. B) the same at 30 minutes. C) no deadline, as today. Owner: "A".
  - **C's design notes, read 2026-11-12 before B took the turn:** the driver-level rules go in one runner per driver session (`begin` with the adopt after a failed start, the steer with its fallback to a new turn under one key, the hold of what a child says before its turn is announced, the silent-turn watch, thread memory and resume). The record-level rules stay with each record's owner: the pending interrupt and not-found, in the Gateway's `AgentService` and in `LocalAgentHandlers`. Local mode gets a keyed queue per agent at its runtime, as the daemon core has. The daemon's `accepted` receipt and local mode's turn record are both written from the runner's `accepted` callback, before any held activity is published.

- **Tell the owner when the app can create an OpenCode session.** Asked from the phone on 2026-11-10: "let me know when session start or startAgent is ready for use in this android app. I think a good exercise would be to make a session and you cross talk it to do adversarial from now on." ✅ Told on 8.14.54. Adversarial reads go to the session the owner names.
- **OpenCode as an agent backend:** now `## Phase 2d`.

## Later

- The assistant on OpenCode: its closed tool list as a deny-all rule set with an allow list, its gate as a plugin hook before each tool call, in its own plan.
- A scary-command ask list, if wanted.
