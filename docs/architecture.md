# Architecture

Entry points, addressing, sessions, and the state planes the console reads.

## Entry points

**`main-mcp.ts`** MCP plugin, user process.
**`main-gateway.ts`** Docker gateway and central router.
**`main-host-daemon.ts`** host `host` WS slot, devcontainer wake, session spawn, terminal view.
**`main-federation.ts`** self-hosted federation relay.

| Port | Service |
|---|---|
| 20000 | Gateway HTTP and WS, loopback only |
| 20001 | Federation Router TLS |
| 20002 | MCP connector WS |

**Bootstrap values:** `GatewayBootstrap.resolve(paths, env, io)` decides the gateway's boot
(`active`, `arming`, or `standalone`) and carries the identity, Domain id, transport, allowlist,
content keys, and cached reach the federation slice reads. `RouterDomainBootstrap.assemble` names
what the Router's constructor builds. The phone's `PhoneIdentity` publishes `PhoneBootstrap`
(`docs/console.md`). `bootstrap-residue` pins that only the assemblers construct the values.

**The gateway graph:** `composeGateway` calls fourteen stages under `src/gateway/compose/` in
order (bootstrap, stores, sessions, persistence, host, agents, awareness, federation, enrollment,
websockets, routes, router presence, router frames, listener), then builds the fault port; a stage
that needs a later one takes a thunk. `FederationContext` is the one reader of the boot: activation after a bootstrap install
publishes the boot, the Domain id, and the slice together, so nothing holds a stale copy. `GatewayGraph` is
`router`, `wsHandlers`, `close`, and `faults`, the port the harness and the boot smoke drive
instead of reaching into the graph.

## Channel conversations

Every connection is channel mode. Each MCP process mints one stable `conversation_id` at startup and
keeps it across reconnects.

- The job key is `storeKey({kind:"conv", conversationId, address})`. Each sender-target pair uses one
  entry; callers never manage session ids.
- Channel entries are `persistent: true` and never TTL-swept. Transient ones expire at 600s.
- `channel_reply` may be called any number of times on a session_id. There is no finality.
- Replies push to the specific sender sub-session, so parallel windows do not cross streams.
- A held push (`ChannelDeliveryCoordinator`) is retired only by the receiving session's
  `channel_delivery_ack`; a session's ack retires only a row held for its own team. A row is a
  `MessageDelivery` or an `EventDelivery`, the second with no sender or reply route, and the queue
  refuses an id the other kind holds.
- The plugin shows a held push once per delivery id for its process's life
  (`mcp/bridge/channelPushDelivery.ts`), so a row re-offered after a lost ack is acked again without
  reaching the session twice. A restart forgets, so delivery stays at least once.
- Claude receives channel pushes as MCP notifications. Copilot receives the same content and
  metadata in a `<channel source="switchboard">` tag typed into its own host pane.
- A Copilot session is confirmed at registration by its launch token, since it has no channel to
  answer a handshake through. One socket types for the pane: the register names its agent process
  (`agentPid`), a plugin reloaded under the same agent (Copilot's `/clear` and `/resume` start a new
  one and may leave the old running) replaces the held socket, and one under another agent, a nested
  process inheriting the token, is refused. Either loser gets `handshake_reject` and stops
  reconnecting, so no push is typed twice.
- `/session/type` requires the caller's confirmed Copilot host-session token. The Gateway derives the
  pane from that session record and caps text at 128 KB. The host serializes typing with other sends,
  polls the pane once per second, drops control characters but tab and newline so nothing ends the
  bracketed paste early, and answers `{ typed: false, reason: "busy" }` when its 200-second wait
  expires.
- A typing request carries a key, the delivery id when there is one, which the host scopes to the
  session and holds for a minute once typed, so a retry after a lost answer replays rather than types
  twice. A busy answer is not held.
- Copilot channel and response pushes share one arrival-order queue. A busy answer retries after one
  second for as long as the turn runs. A 503, a 504 or a network failure backs off up to 30 seconds and
  gives up after 15 minutes, leaving a channel row held for the next connection. A channel row is
  acknowledged only after the tag is typed and submitted.
- A Copilot session gets the channel rules and the full capability guidance as MCP server
  instructions, and no `compact_session`, `set_effort_level` or `reload_plugins`, which type Claude
  slash commands. The console's plugin reload refuses such a session too. Its compaction hooks are no-ops; its baseline
  comes from the Gateway instead (below).
- **Every plugin hook carries `bash` and `powershell` no-ops for Copilot:** Copilot runs a
  Claude-format hook's `command` as a shell line and drops `args`, and a `preToolUse` hook that errors
  denies the tool, so the `sh` gate denied every tool in every Copilot session. Claude reads `command`
  and `args` and ignores the two keys.

### What a session's model reads

`shared/system-reminder.ts` is the one builder of the `system-reminder` tag and the one
neutralizer for model-bound text.

- **A message is files, reminder, then body:** `composeModelMessage` orders the parts so the
  sender's words come last. `buildChannelNotification` gives both delivery roads the same content
  and metadata.
- **Foreign text is neutralized at one chokepoint per path:** `composeModelMessage` for a channel
  body, a reply and a `[FILES]` block, `reminderBlock` for its own lines, `guardTools` for
  every string in a tool result and every thrown tool error, since a result can echo another
  session's text, and `compact_session` for the instructions that outlive a compact.
  `neutralizeMarkup` rewrites the opener of a `system-reminder` or `channel` tag to `&lt;`. ASCII
  spellings only.
- **The guard is the only road to a tool:** it wraps `registerTool` and a later `update` callback,
  and `tool()` refuses.
- **A value that must stay one line is collapsed by `oneLine`:** a watcher event's values and the
  baseline's lines, so a newline in foreign text cannot forge another data line.
- **An event is data:** a push with `event="true"` carries no sender, `session_id` or
  `meta.instructions`, and `CHANNEL_INSTRUCTIONS` says no `channel_reply` is owed.
- **A file's bytes are not neutralized:** an attachment is data, and the model reads it through
  Claude Code's own Read, the same boundary as any file in the repo. Rewriting it would corrupt it.
- **Connector tool schemas are not neutralized:** they come from code the plugin runs.
- **The harness covers part of this itself:** Claude Code escapes every meta value as an attribute
  and folds a `</channel` closer in the content, lookalikes included. It leaves a `<channel` opener
  and every reminder tag as written, which is what the neutralizer exists for.
- **Text bound for the phone is never escaped.** Mirrors, console rows and replies keep their bytes.
- `system-reminder-residue.test.ts` refuses the tag spelled anywhere in `src/` but the builder's tests.

### After a compaction

- **The baseline comes back as hook context:** `hooks/hooks.json` runs `main-session-hook` on
  SessionStart `compact`, after both auto and manual compaction. It posts the session token to
  `/session/baseline` and prints one reminder block: conversations addressed to the session, newest
  first, open routine runs, agents with a turn running, the assistant's watcher lines (for
  `host.assistant` alone), and its unfinished board entries. Board lines go last and are cut first, measured after escaping, under Claude Code's 10,000-character hook cap.
  Anything short of a valid answer prints nothing.
- **A Copilot session gets the same lines pushed:** the daemon's `copilotCompaction.ts` overlay sets
  `compacting` on the session's derived presence. When it falls, `composeWebSockets` tells
  `composeGateway`, which reads the session's baseline through `createBaselineReader` and banks it
  as a `baseline` awareness change that pushes at once and is typed into the pane. Both roads render
  through `baselineLines` in `src/shared/session-baseline.ts`; an empty baseline sends nothing.
- **So does the capability guidance:** a second `compact` hook, `main-session-hook capabilities`,
  prints what `switchboard_capabilities` renders, cut at a section under the same cap. A fresh
  Claude session reads it first in its handshake answer; a Copilot session reads it in its MCP
  server instructions.
- **The awareness bank is left alone:** a banked change still rides the next message, and reads
  against the baseline's current state.
- **`compact_session` always sends fixed recall-first instructions,** then the caller's own, if any.
  Auto-compaction takes none: a PreCompact hook can only block.

## Addressing

**`shared/session-id.ts`** owns session/team key production, separators, slug validation, `Address`,
`SpawnPoint`, and target parsing. Kotlin mirrors it through the shared fixture vectors.

Two target grammars, one per door. A session at the MCP door names a local team field (`spawn` or
`spawn.session`) or a qualified address, and `parseTarget` fills this Gateway's Domain and id into
the local forms. The console names its Domain and Gateway on every target, `domain.gateway.spawn`
or `domain.gateway.spawn.session`, and `parseQualifiedTarget` refuses anything else. Equal Gateways
make a bare name ambiguous, so the phone never sends one and `consoleTargets` never resolves one.
Neither grammar has a placeholder Domain: a Gateway without a Domain builds no routes, and its
listener answers only `/health`, the setup routes and `/federation/retire` until one is active.

A bare project is a spawn point by catalog membership, not by dot detection. `my.app` may still be a
project. Sending to a spawn point without a session fails.

## Host spawn points

A host spawn point is a named shell, not a session. `host` is bash; `windows` is PowerShell over WSL.
Both produce ordinary host tmux sessions.

**`isHostSpawn` and `host-spawn.ts`** own host-spawn classification. `host-spawn-residue.test.ts`
rejects new classification sites.

**`kind`** identifies tmux location, not interpreter. Windows sessions still use WSL tmux.

**Discovery**: absent `HostSpawnState` means unknown, never no spawn points. Host spawn points are
discovery metadata, not presence rows, and `/discover` strips them. Unreachable gateways contribute
no spawn-point offer.

A gateway's own rows and shells come from itself; the Router's projection supplies every other
gateway's. Taking the Router's copy of its own would hide a live session behind a lost presence
write. Spawn points ride only the presence baseline, so `presenceReporter` forces a new one when
they change.

**Windows launch facts**: use the CLI's `.exe` name (`binary.windows` in its row), append to `WSLENV`, encode `-EncodedCommand` as UTF-16LE
base64, and always use `Set-Location`. `pwsh.exe` is not assumed available.

Windows workdir paths use forward slashes. UNC paths are rejected. Browsing uses native
`Get-ChildItem`, not Linux `/mnt` paths.

`hostWorkdirHint` falls back to the session label. A label is not necessarily a path and must not be
passed to `wslpath`.

The daemon also serves `kasaScan`, a host op with a closed contract: no caller input, a discovery broadcast on every non-loopback IPv4 interface, typed candidates back. `wifiNetwork` is closed the same way and answers the WiFi the host is on, or `none`. `docs/devices.md` holds both.

## Session CLIs

`src/shared/session-harness.ts` holds one row per session CLI (`HARNESS`), and every place that
differs by CLI reads it. Behavior that belongs to one process sits beside that process, in a table
keyed by a row field's value: `LAUNCH` in `hostResolve.ts`, `ROADS` in `sessionLaunch.ts`,
`TRANSPORTS` in the plugin's `helpers.ts`, `RESTART_SIGNALS` in `agent-screen.ts`. A new CLI, or a new value of a field, stops the
build until each is handled. The phone reads the same rows through the generated
`proto/HarnessRegistry.kt`.

**A session's CLI is fixed at create and named everywhere.** Every record carries `harness`, and every
door that creates one names it. It rides the register frame, the wake, the `presence_watch` entry and
the presence row.

**A CLI word off a wire or a file is read one way.** `readHarness` answers named, unnamed or unknown,
and `foldHarness` makes each reader say what it does with each. Unnamed is an older sender and reads
as Claude until its dated removal. Unknown is a newer build's CLI: a launch is refused, a stored record
is held unread and written back untouched, and the phone passes the word back uninterpreted.

**The row owns a session id's shape.** A CLI keeps its own id, or starts and resumes under one the
Gateway mints (`sessionId`, `mintedSessionId` on the record). The shape also guards the launch command
line.

**`launchRefusal` is the one placement rule,** read by the Gateway's create, the daemon's wake before any
container starts, and `buildLaunchCommand`. A place is the host shell, the Windows shell or a container.

**A CLI is reached by one of two roads** (`road` on its row). On the pane road the daemon reads the
screen for its state, answers its dialogs and presses a prompt's answer, and a message enters as a
channel notification or typed text. On the API road the plugin does all of it against the CLI's own
local server, and no pane reader runs. `paneRoad` narrows a row to the pane-only facts.

**One launch road serves a wake and a create** (`mcp/devcontainer/sessionLaunch.ts`). Its readiness
is a table by road: a screen read, or the launcher's status file.

**A plugin-read session reports its own state.** Its `session_presence` frame carries the fields its
API yields, the Gateway takes the team from the socket and never the frame, and both ingresses end in
one sink, which also raises the baseline push when a compaction ends. The report clears when the
session's last socket closes.

**A prompt answer goes by the road.** The daemon presses it into a pane; for an API CLI the Gateway
asks the plugin over the session control plane (`session_control` frames, `sessionControlPlane.ts`),
keyed by the console's conversation and op id so a retry replays the first answer.

**The plugin resolves its CLI once** (`mcp/sessionCli.ts`) into a profile with every answer filled, a
CLI with no row included.

**Which CLIs a spawn point runs** travels as one `harnessSpawns` map from the daemon's catalog to the
phone, where the create dialog offers them.

**A session is greeted on each launch until it first confirms.**

### OpenCode

Pinned to one version (`OPENCODE_PIN`); a launch refuses any other with its number. Each session runs
its own server, since OpenCode's shared service gives every MCP child the service's environment.

**The launcher** (`main-opencode-launch.ts`, `opencode-launch/launcher.ts`) runs in the pane. It
mints a password, starts `opencode serve --stdio --port 0`, and reads the URL the server announces. It
creates the session under the id the Gateway minted, with the model the terminal UI last picked, since
a session created with none runs the server's default whatever the pane shows. It asks for the
location's MCP list until the Switchboard server reads `connected`, which is what starts the MCP
child, then runs the terminal UI against that server. The server ends when the launcher's pipe closes,
so none outlives its pane.

**The launcher keeps the plugin alive.** OpenCode never restarts a dead MCP child, so the launcher
reads its status every 5 seconds and reconnects one that reads `failed`. A wake therefore keeps a pane
whose launcher runs, since no registration there is a plugin reconnecting.

**A launch status is only as live as its pid.** The launcher writes `starting`, `ready` or `failed`
with its own pid, and `failed` the moment its server or terminal UI goes, since the UI reconnects to a
dead server forever. A wake relaunches on a dead pid or `failed`. The launcher removes only a status
it still owns, so a relaunch's status survives the old launcher's exit.

**Nothing secret is on a command line.** The URL and password reach the plugin through a file only the
owner can read, named by `SWITCHBOARD_OPENCODE_SERVER` in the MCP server's environment and removed
when the launcher exits. The daemon learns neither; it polls the launcher's status file.

**The plugin follows the server's event stream** (`mcp/opencode/`). The stream is volatile and a local
server keeps no replayable log, so every connection rebuilds from three reads before it reports: the
active sessions, the pending permissions, and the newest message rows. A turn reads as working from
its first step, since a repeated prompt id opens an execution with none.

**The plugin posts its own baseline.** For each finished compaction the follower names, after every
read and on each live end, the session fetches the baseline from the Gateway, as Claude's compact hook
does, and posts it as synthetic input under an id derived from the compaction's. OpenCode drops a
repeated id, so reconnects, retries and a restarted plugin land it once, and a failed compaction gets
none. The Gateway pushes a baseline only for a row whose `baseline` is `gateway`.

**A message is a prompt** whose id is a hash of the delivery id, so a retry lands once. A notice that
asks nothing is posted as synthetic input, which adds context without starting a turn.

**Approve is `once` and Deny is `reject`** with the owner's note. A request no longer pending answers
stale.

## Sessions and wake

Devcontainer sessions are loose `project.session` peers. The daemon sets `PROJECT_NAME` to the
composite name before launch.

**The daemon, not a project's compose, puts a devcontainer on the Gateway's network.** The plugin
reaches the Gateway as `switchboard`, which resolves only there, so a container left off it starts
Claude and never connects. `joinGatewayNetwork` attaches on every wake, built or already running,
and a wake that cannot attach fails rather than leave a session `connecting`. The network is external
to the Gateway's compose, so a Gateway restart never removes it from under a container.

The host is another spawn point and uses the same create, resume, and forget path. Its default
workdir is `~/projects/<label>`.

**The launch command puts the daemon's own bun bin dir ahead of PATH.** A pane inherits the tmux
server's PATH, which is whatever shell started that server, and `~/.bashrc` returns early for a
non-interactive shell, so sourcing it adds nothing. Without the export the plugin's `bun` is not found
and the session never registers.

**`host-daemon`** is reserved and must never be dispatched or registered as a session. Residue tests
enforce this at the sinks.

## Session identity binding

A bind token is delivered only through the daemon launch command and presented at registration and on
HTTP requests. Same-project panes remain mutually impersonable by OS construction.

**`sessionAuthority.ts`** owns binding resolution. `toClaim` is name-keyed and ignores undelivered
reattach tokens; `toAnswerFor` is socket-keyed and follows the registered incarnation; `toActFor`
composes live-first with record fallback.

`UNBOUND` is an explicit resolver value. A missing or unparseable subject must not become an
accidental permit.

**A host-shell session presents its launch token at registration,** matched against the record, not
through `toClaim`. A fresh launch presents its token before the binding activates, so a claim-based
rule refuses every real host session.

**`doWakeTeam` refuses to mint under a host spawn,** because `/send` accepts an unbound sender. Only
the console's authenticated `create_session` and an assistant send its guard cleared
(`WakeCreate.cleared`) open a host record. A reattached pane and a purged
`DATA_DIR` lose their proof and must be relaunched.

## Phone path

The phone reaches the Router through signed OwnerOps. `deliver` carries a `console_op` row.
`gateway_value` is forwarded as a `value_op` frame. The phone also sends
`consumer_register`, `inbox_read`, `inbox_advance`, `planes_read`, `report_read`, and
`capabilities_report`. Results are sealed under `opResultAadKind` or `valueResultAadKind`.

`ConsoleSocketMode.INBOX` selects the inbox socket. `PollDrain.drainTick` reads the owner inbox and
planes, then advances the inbox once when rows drain; `processEntries` threads each row by its
store key. The phone holds no home Gateway; every call names its Gateway. A Domain-less phone
reaches the Router through the token-only transport, whose reach answer names the Domain; the
signed client exists only for a Ready boot.

## Versioned state planes

These are the Gateway's own planes. The Router's console planes (`presence`, `taskBoard`, `vault`
over `planes_read` and the console socket) stand at a `PlaneLineage` and are read by one fold;
`docs/console.md` holds that rule.

The console reads versioned server-state snapshots through OwnerOps. `shared/plane-registry.ts`
owns version identity, hash-gated bumps, held reads, and the 60s recovery tripwire.

Planes: **presence**, **linked-peers**, **read-anchors** per owner. A linked friend's sessions ride
the Router's presence projection as its `linked` field; no Gateway pushes or pulls presence to
another.

**Wire rule:** flat, hand-named optional fields. Kotlin codegen cannot reliably type generic maps or
decode-side unions. An absent known-version ships nothing; an empty array ships current truth.
