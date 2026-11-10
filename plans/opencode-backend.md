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
- **The model and provider are OpenCode's own config.** Switchboard passes none. Signing in is `opencode auth login`, done once by the owner.
- **The spike picks the pin:** the newest V2 release at least 7 days old that day, per the package rule, written where the launch check reads it. 2.2.6 is provisional; it was three days old when this was written.
- **Self-update is off** in the launch config, so there is no restart signal: OpenCode's entry in `RESTART_SIGNALS` is null, as Copilot's.
- **Session tabs and the sidebar are off** in the launch config, and panes stay at 120 columns or fewer.
- **Create dialog order:** Claude, OpenCode, Copilot.

## Deploy order

Readers before emitters, for both phases: the Router takes the new presence-row and spawn-point fields first, then the Gateway and the daemon, then the plugin, and the phone offers OpenCode last. The Gateway writes `claudeSpawns` and `copilotSpawns` beside the map until their dated removal, and a new phone prefers the map.

The Containers slice raises `FEDERATION_PROTOCOL_FLOOR` with its release: an older Gateway strips `cli` from a relayed send and launches Claude unasked. Its new wire is `cli` on `/send` and on the relayed send, the launch outcome on `response_push`, the daemon's wake progress frame, container state, the availability map on the discover answer, and the routine and fire picks.

## Phase 1 - The harness table

Two commits, each gated by lint, the tests and the Kotlin gate. The first is the table and changes no behavior. The second holds two fixes and is labeled a behavior change.

- One closed record per harness, keyed by `SESSION_HARNESSES`, holding every seam the code map and the audit found: binary and launch arguments (`buildLaunchCommand`, `HOST.build`, `WINDOWS.build`, `agentTypeExport`, the Windows `copilot.exe` and `WSLENV` lookups), how it gets its id and resumes, delivery and registration as functions in the row (`deliverChannelPush`, `emitLocalAwareness`, `canReceivePush`), handshake or none with who owns the socket (the `agentPid` replacement check), state source (`deriveFromPeek` and its readers, `permissionPrompt`, the phone's pane reader in `agent-screen.ts` and its Kotlin twin), startup prompts (`COPILOT_TRUST_RE`), auto-answers (`limitContinueDigit`, `surveyShowing`), compaction road (`createCompactionFollower`, the compact hook), `RESTART_SIGNALS`, the slash-command tools, typed delivery (`typeSession`), which MCP tool groups it registers (the workflow tools go to Claude and Copilot by name today), how a wake tells it is ready (`paneAgentState`, `awaitReady`, `isAgentReady`), capability text, and where it may run.
- `SessionRecord.harness` and its copies in `HostOp`, `WakeMessage` and `CreateOpts` take `SessionHarness`, never a literal. `copilotSessionId` becomes one harness session id; a stored record with the old field restores into it. Claude's transcript id stays its own field.
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
- **For the architecture step:** one three-way reading per runtime, with each reader stating what it does with each case, in place of a function per reader.

Phase 2 is three slices in order, each its own lap: OpenCode on the host, containers, then Copilot in containers.

## Phase 2a - OpenCode on the host

- **Spike first, on the real machine:** pick and install the pin, run a server and a terminal UI against it in tmux, and confirm what the source said. Record what differs before building on it.
  - An API prompt shows live in the UI, and one sent mid-turn steers.
  - The event names for working, idle, permission and compaction, and what a failed compaction emits.
  - A session created under an id Switchboard chose, with the UI attached to it.
  - The MCP child starts without a first prompt and gets its own session's environment, with two servers running at once.
  - A prompt id Switchboard derived is accepted, a repeat of it lands once, and whether it must sort after earlier ids.
  - Approve, and Deny with a note, on a real `.env` read; the reply closes the dialog.
  - The event stream cut and resumed.
  - Synthetic input reads as context.
  - Server readiness, shutdown and wake, on the host and in a container.
- **Launch:** OpenCode's row. A wrapper starts `opencode serve` on a port and password the daemon mints, creates the session under an id Switchboard chose, then runs the terminal UI against that server in the pane, on the host or inside a container alike. The minted values reach the wrapper through a file only the owner can read, which it removes; they are never in the command line tmux is given. The launch config is passed by environment and never written into the project, in two variables. `OPENCODE_CONFIG_CONTENT`, which the server reads, carries the Switchboard MCP server with the session's identity and the server's port and password, code mode off, self-update off, and `experimental.location_idle_timeout` off, since the default unloads an idle location after 60 minutes and takes the MCP child with it. `OPENCODE_CLI_CONFIG_CONTENT`, which the terminal UI reads, turns tabs off. The version is checked before launch and a version outside the supported range refuses with its number.
- **One server, one Switchboard session.** `/new` and the session list are left alone (Question 12).
- **Online** is the plugin's Gateway socket registering, as for every harness, never the server coming up. The plugin process owns that socket, and a second registration under the same token replaces it.
- **State:** the plugin follows the server's event stream and reports the same `DerivedPresenceSchema` the daemon's pane readers fill: working, needs login, limit hit, compacting, a waiting permission. A session ingress beside `presence_derive`, which answers the host alone today, takes the team from the socket and never from the frame, feeds the same presence reporter, and accepts only the fields the API yields; the Gateway still derives teammates and workflow state. On connect and on every reconnect the plugin reads the active sessions, replays the session log from its saved sequence and lists the pending permissions, since `permission.asked` is not in the log, and only then replaces what it reported. The report clears when the socket closes. No pane reader runs for this harness.
- **Wake:** the row's readiness for OpenCode is the server answering and the plugin registered, never a screen read; both wake branches read Claude's pane today. An MCP child that died stays down in OpenCode, so the session reads offline, and a wake that finds the pane alive without a registration restarts the launch on the same OpenCode session id, on the host and in a container.
- **Delivery:** the plugin posts a pushed message as a prompt whose id it derives from the delivery id, in OpenCode's `msg_` form and the same on every retry, so a retry lands once; it acks under the delivery id after. The compaction baseline is posted as synthetic input with `resume` false, so it adds context without starting a turn, as Claude's hook does. Awareness travels as for every harness: an `act_now` notice is a pushed message, and the rest rides the next one.
- **Approvals:** a `permission.asked` event becomes the session prompt the phone already draws. The phone's answer, which the daemon types into the pane today, goes by the harness row: for OpenCode a new op on the workspace plane reaches the plugin, which replies over the API, Approve as `once` and Deny as `reject` with the owner's note as its message. The op is keyed by the console's conversation and op id, as the daemon's road is, so a retried answer replays the first result where the plane would mint a fresh key. OpenCode's base policy stands, so only its read tool asks, on a `.env` file.
- **Controls:** compact and interrupt go through the API. Ctrl+C and Ctrl+D exit the app on an empty composer, so the Gateway refuses both keys for this harness, and a named rule in `SessionOps` hides them on the phone.
- **Phone:** the create dialog picks the project first, then shows the CLIs that spawn point runs (`harnessesOf`), OpenCode among them where it is installed, in the order Claude, OpenCode, Copilot. The slash palette and shell macros come from its row.
- **Tests:** a fake OpenCode server in the harness beside the fake host, as a request-to-response function: it holds sessions, drops a repeated prompt id, keeps pending permissions and a replayable log, and lets a test cut the event stream. It drives create, delivery, a permission round trip, a compaction and a dropped stream. It cannot see CLI drift, auth, the MCP child's environment or the terminal UI, which the spike and Phase 3 cover. `check:boot` gains an OpenCode `AGENT_TYPE` pass.

## Phase 2b - Containers

The strings an agent reads are under **Agent-facing prose**, below Phase 2c.

- **One lifecycle owner per project:** Start, Stop and every `ensureContainerUpAsync` caller go through one queue keyed by project, and a Stop is fenced against the starts and creates behind it. Wakes are joined by team today, so two sessions of one project can each recreate its container. The owner covers the look inside, the CLI resolution and the session launch, not the container start alone. It holds the running `devcontainer up` child, which `runDevcontainer` never exposes today, so Stop kills it outside the queue, runs the teardown, and fails the launches waiting on it with a typed reason.
- **Found by label, never by name:** one resolver finds a project's dev container by its `devcontainer.local_folder` label and its compose project by `com.docker.compose.project`. It replaces every spelling of the legacy `<project>_devcontainer` name (`tmuxCore`, the Codex and Copilot targets, `claudeRunner`, `teardownContainer`, `workflowSkillRead`, `reloadPlugins`), which misses a container the owner's newer scripts started.
- **Start and Stop:** Start is `ensureContainerUpAsync`, with a `TMPDIR` of its own per project, since the CLI names temp files by the millisecond and two starts at once collide. Stop is compose down on the whole project with its orphans and stale networks, passing every `dockerComposeFile` entry in order. Both are new console ops relayed to host ops. Both answer at acceptance and report an outcome with its reason after, as `claudeRunner` does, since a start can fail before any container exists and docker then says nothing; the header shows the last failure.
- **State:** stopped, starting or running per project, read from docker when the daemon connects and from docker's event stream after, filtered by label, so a start or stop outside Switchboard shows too. It travels as its own field from the daemon's catalog through the Gateway and the Router's projection to `GatewayRegistry`, apart from session presence.
- **What is installed:** when a container starts running or its id changes, the daemon looks inside for the binary of each harness whose row allows containers, in the shell setup the launch uses, and reports it in the availability map.
- **The container wake names its harness.** It launches Claude whatever was asked today.
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
## Phase 2c - Copilot in containers

- **Typed delivery reaches a container pane:** `typeSession` refuses any spawn but the host's today, and its target is hard-coded to the host's. It builds the target from the session's spawn point. The daemon types into a container's pane as it already peeks and sends keys there.
- **Each container gets the plugin of each CLI found in it:** each CLI has its own installed check and its own installer, `copilot plugin` for Copilot. Today's check reads Claude's plugin list alone and the install runs `claude plugin`, so a container with Claude set up skips everything else and one without Claude fails. OpenCode needs none.
- **The compaction file is read inside the container:** `createCompactionFollower` reads the host's home.
- **The two refusals go:** the Gateway's and the daemon's, which hold Copilot to the host.
- **No Claude assumed:** a container with Copilot alone starts, is asked what it has, and offers Copilot alone on the phone, in `crosstalk_discover` and in the `cli` list.

## Agent-facing prose

For Phase 2b. Taken past the owner string by string. A string he did not reword stands as drafted.

`<address>` is a session's address, `<spawn>` a spawn point's.

A blank `cli` is never a probe; `crosstalk_discover` is. A `displayLabel` on a session that exists is ignored, as today (`decideWakeCreate`).

**How the strings reach the agent:**

- The refusals are typed on the wire and the plugin renders the text below exactly, line breaks kept and with no `Bridge error:` prefix, on `crosstalk_send` and on the assistant's guarded send, whose `Not sent:` line collapses to one line today.
- A launch notice carries a `session:` data line above its text, naming the address. Two of the owner's strings name none, and the bank renders only a notice's body and source.
- A sender in another Domain gets the container failure without its second sentence.

**Still to take past the owner, before the Containers slice builds them:**

- The crosstalk skill's line that a send "Blocks until they respond" (`skills/crosstalk/SKILL.md`).
- `crosstalk_discover`'s description, which names `displayLabel` alone.
- The assistant's instructions on creating a session (`src/mcp/assistant/instructions.ts`).

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

## Later

- The assistant on OpenCode: its closed tool list as a deny-all rule set with an allow list, its gate as a plugin hook before each tool call, in its own plan.
- A scary-command ask list, if wanted.
