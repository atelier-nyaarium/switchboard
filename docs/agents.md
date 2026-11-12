# Delegated agents

A session can hand a self-contained sub-task to an OpenCode, Codex or Copilot child. The daemon
supervises one child per execution target; the gateway owns the durable record.

`claude -p` is available as a workflow backend only. It is not a session agent.

`src/mcp/agents/agentTools.ts` registers `agentStart`, `agentMessage`, `agentCollect`, `agentStop`,
`agentList` and `agentListModels` for every backend. `agentStart` takes `prompt`, `backend`, and
optional `model`, `effort` (Copilot), `tier` (Codex), `schema`, and `cwd`. `agentMessage` takes
`agentId` and `prompt`, with optional `schema` and Codex-only `tier`. `agentCollect` and `agentStop`
take `agentId`; `agentList` accepts optional `backend`, `agentId` and `limit`. Capability guidance
uses one `agents` section over the `codex-agent`, `copilot-agent` and `opencode-agent` ids.

**`backend` is named unless only one is enabled.** With several enabled, the start tool's schema
requires it and its handler refuses a call without it, so no start lands on a backend nobody chose.

**A start in the default model's family runs at `priority`.** `startDefaults` in
`src/shared/model-family.ts` sets it when a start names no tier and its model shares a family with
the backend's default. The tool's start and a workflow step's start both take it; a named tier is
kept.

**`agentListModels` asks each backend's driver where the session's agents run.** The route relays the
`agentModels` host op, the daemon asks the driver's `listModels` on that target, and
`offeredModels` in `src/shared/agent-models.ts` keeps the newest of each family and marks the
backend's default, which stays listed even where a newer one superseded it. Codex and OpenCode ask
their server on each call, and Codex's answer also replaces what its child may start. Copilot
answers the list its child gave when it opened.

## One stack, one driver per backend

A backend is a row in `src/shared/agent-backend.ts` and a driver in `src/mcp/agents/drivers.ts`.
Nothing decides by a backend's name: a difference is a row field or the driver's own behavior, and
a backend with no row or no driver does not compile. Every backend runs on the one stack:
`agentService`, `agentApply`, `agentReducers`, `agentCommands`, `agentRelay`, `agentRoute` on the
Gateway, and `agentDaemonService` over a driver on the daemon. Local mode opens the same drivers.

**A driver session's turns have one runner** (`src/mcp/agents/turnRunner.ts`). The daemon service and
local mode both hand it a start, a message and a stop, and it tells each of a turn's acceptance, its
activity and its end, in that order. The rules of a turn live there alone: the adopt after a failed
start, the steer with its fallback to a new turn, the resume of a thread the session does not hold,
and the silent-turn watch. What only a record knows, a pending interrupt or a missing agent, stays
with the record's owner.

**A silent turn is read, then interrupted, then given up with its child.** The daemon service and
local mode each sweep every 30 seconds. A turn with no sign of life for ten minutes is read through the driver's
`inspectTurn`; settled, its terminal is published; anything else, it is interrupted; silent for
another ten minutes, its whole generation is given up, which ends every other turn on that child.
Silence is judged only where a driver reports life (`onProgress`): Codex's and OpenCode's do, and
Copilot's turns are never judged. A tool that says nothing for ten minutes reads as a hang.

**An idle child is reaped where its threads reopen.** With no command in flight and ten quiet
minutes, a session with no running turn is given up unless its driver says it is `busy`. The next
command opens a fresh child and resumes the thread. A driver whose threads die with its child
(`threadsResumable: false`) is never reaped.

**A turn found running is taken, not started twice.** When a start fails after its turn began, and
when a reconcile reads a turn as running on a thread the session already knew, the service asks
the driver's `adoptTurn` for that turn's handle and holds it as its own. A thread first loaded by
the reconcile ran its turn in another process, so it is only reported.

**`delivery` has three words on every backend.** `started` is an agent's first turn, from
`agentStart` and never from a message. `followup` is an `agentMessage` that began a new turn.
`steered` is an `agentMessage` into the turn already running. The wire and the record hold
`started` or `steered`; `agentResultDelivery` maps them for an answer.

**A steer says what it knows.** A driver answers `taken` when it knows the turn holds the prompt,
and nothing when it only sent it. A steer that only sent, whose turn has ended since, is given again
as a new turn, and so is one the driver rejected because its turn ended. Whether a turn ended is
asked of the turn's own promise (`settledNow`), and after a rejected steer of the driver's
`inspectTurn` too: Codex holds a finished turn's terminal up to ten seconds for its final item, so
the promise alone would refuse a message the agent could take. Both posts carry the operation's id
as their key, so a driver that can tell lands one prompt.

**A catalog write has five outcomes, and a changed record is never read as an unchanged one.**
`AgentCatalogPersistence.write` tells them apart:

| Kind | The record | On disk |
|---|---|---|
| `landed` | changed | yes |
| `unconfirmed` | changed | yes, unless a crash undoes the rename |
| `conflict` | unchanged | no |
| `failed` | unchanged | no |
| `owner_missing` | unchanged | no |

- **A session's operation** is sent only on `landed`. On `unconfirmed` the service gives the
  operation up at once: left `requested`, it would refuse the agent's next message and be sent at the
  next daemon register. The session hears `not_found` for `owner_missing` and `persistence_failed`
  for the rest.
- **A daemon frame** whose write is `unconfirmed` is in the record, so listeners hear it and a
  collect sees it. A frame that names a stream is held unacknowledged until the revision is
  confirmed on disk. That frame blocks every agent on its target, since one stream carries them all,
  so it is retried when any agent's write lands and on each persist tick, and let go once its
  session is forgotten. A write that changed nothing is still asked about and retried.
- **A collect's mark** whose write is `unconfirmed` is made, and the collect hands over its turns.

A Gateway restart forgets which frames were waiting: the daemon replays them, they read as
duplicates, and they are acknowledged with the restored catalog's durability unchecked.

## Workflow backends

Workflow Codex calls use the Codex App Server family; Copilot calls use its headless CLI family
described below. Claude runs as a daemon-managed `claude -p` process for each turn; a named workflow
thread resumes its Claude session id. `createClaudeSteps` in
`src/gateway/workflows/claudeSteps.ts` owns Gateway turn handling, and `createClaudeRunner` in
`src/mcp/devcontainer/claudeRunner.ts` owns process execution,
cancellation and the result outbox.

All three backends share `answerOutcome` and `failureOutcome` in
`src/gateway/workflows/agentViews.ts`. A completed answer reaches the script; other outcomes return
`null` and are available with their reasons through `workflowCollect`. Schema-backed completed
answers are not classified as declines. The workflow journal, outcomes and recovery contract are in
`docs/workflows.md`.

## The daemon stream

**A fence is `(daemonInstanceId, targetId, generation, lastEventId)`.** Reconciliation is the only
path that may install a non-advancing fence, with one exception in `decideAcceptance`: a `started`
receipt from another stream is accepted when the agent is idle and holds no such turn. Only the
child that took the command can name its operation, so that is a reaped target relaunched or a
restarted daemon serving it, and no turn was in flight to misplace. The fence alone cannot order
two children; the operation id is what does.

**A reconciliation follows another stream, never a dead one.** `classifyReconciliationFence` refuses
an older generation of the stream an agent already follows, and the relay drops a reconciliation
from a daemon instance a later hello replaced (`fromReplacedDaemon`).

**A held frame stays unacknowledged until it is decided.** It is retried after each frame applied to
its agent, and decided when a retry applies it or ignores it, or when it is commentary dropped at
the cap. An event that can never be placed is ignored rather than held: one from an older generation
of the stream the agent follows, or one naming a turn the record already ended. An event the daemon
replays below the decided mark is not judged, and its acknowledgement is repeated once nothing below
it is open. A receipt is judged every time, since it is placed by its operation.

**One ledger owns a frame's life** (`agentFrameLedger.ts`). It takes a frame at arrival, before the
agent's queue, so no acknowledgement passes one that is here and undecided. A reducer that throws
holds its frame as `failed`, so only commentary dropped at the cap is acknowledged unapplied.

**A hold ends.** While an agent holds a frame nothing can place, the daemon is asked again every
`RECONCILE_GUARD_MS`. After `HELD_FRAME_LIMIT_MS`, ten minutes from the later of the first hold and
the daemon's last hello, the hold is closed. The daemon's last reconciliation is applied at its word,
which ends a turn it contradicts and adopts the one it reports running. The record's open turn then
ends as interrupted unless that reconciliation says it is the one running, and each frame is tried
again. What still cannot be placed is given up, a receipt's requested operation going
`indeterminate` first.

**A close is careful about what it knows.** A reconciliation counts only if it came after the open
turn did, and the open turn is ended only if the daemon was asked since it opened, so a turn that
just started is kept. Nothing is given up while no daemon is live, before a new daemon's hello, or
until an ask has gone out since the hold began. A
write the record refuses leaves the frames held for another try, an unconfirmed one is awaited, and
a frame awaiting its write has no limit. A frame placed during a close retries no other: the close
tries each unplaced frame itself, so one it decides, on whichever stream, waits on the close's own
unwritten step.

**The daemon says what its outbox dropped.** Past 1,000 unacknowledged frames on a stream it evicts
the oldest and counts it, and every hello carries the counts. The Gateway asks about each working
agent on such a target, whose terminal may be among them.

**An uncertain delivery has one rule, `uncertainDeliveryState`.** A refused or unconfirmed start leaves
the agent unavailable, a prompt leaves it recovering, and a refused stop leaves it as it was. The
refusal and abandonment paths take it, and throw one `AgentTransitionError`.

**One relay core, a port per backend.** The fence rules live in `agent-fence.ts`, a frame's life in
`AgentFrameLedger`, and the relay mechanics in `AgentRelayCore`: what a hold asks and when it ends,
and per-agent serialization. `AgentRelay` supplies a backend's wire schemas, applier, agent listing, and reconcile
request. A held frame is one per stream and event id, and only commentary is dropped at the cap: an
outcome evicted there would be acknowledged unapplied.

**Every turn and every op ends.** The recovery decisions live once in `agent-recovery.ts`; the
vectors in `src/__tests__/fixtures/agent-recovery-vectors.json` run through them and through the
stack's own appliers.
- **An op knows its daemon:** a route stamps each op with the host register frame's
  `daemonInstanceId`, which the host socket keeps and drops with the socket. Every relay reads it
  through one callback.
- **Register pass:** at each host register, before the hellos, a `requested` op not stamped with the
  live daemon, one stamped with none included, is abandoned through `uncertainDeliveryState`.
- **Resend:** at the catalog frame after a register, a `requested` op stamped with the live daemon is
  sent again under its own operation id. `AgentDaemonCore` takes an op once per id: a repeat in
  flight is dropped and a settled one replays its answer, within a count-bounded ledger.
- **Lost turns:** a reconcile answered under another fence (instance, target or generation) settles
  the known turn `interrupted`, reason "turn lost: its agent process ended", unless it reports that
  turn settled. A retiring generation ends its own turns first (`AgentDaemonCore`'s
  retire-before-remove), and the daemon reports no turn state for a thread it cannot resume or a
  turn it cannot read. Asked about an earlier turn while the thread runs a later one, it reads the
  earlier one and settles it.
- **Stale agents are asked again:** a `recovering` agent, and a `working` one fenced to another
  daemon, is asked on every hello and every persist tick, paced per agent by `RECONCILE_GUARD_MS`
  from its last ask whether answered or refused.

**An acknowledgement retires the daemon's only copy.** `ignored` and `applied` permit it; only a
withheld decision does not. Held frames are keyed by agent, although the stream is per target.

**A retired generation publishes nothing new.** `publish` checks liveness, and retirement retracts
nothing already retained in the outbox. `release` must name the generation, or a late exit tears down
its successor.

**A refused request is not an unavailable agent.** Request failures use the request-error envelope
and HTTP 400; genuine agent failure uses the unavailable result envelope.

**Result availability is explicit.** A terminal result means finished. `agent_dead` means the agent
cannot run. `agent_unreachable` means its process may still be running, so do not duplicate work.

**Reconnect adopts persisted threads.** The daemon reopens the execution target, resumes the stored
thread, and adopts its running or settled turn before accepting a follow-up. Reconciliation emits its
receipt before an adopted terminal, preserving the fence. It reads and never deletes a thread.

**A refusal settles the operation.** The route's waiter wakes on it and answers `indeterminate` with
a retryable error. The first follow-up after a daemon restart is answered that way while the gateway
reconciles the agent; the retry lands once the agent is idle again.

**`ignored` and `failed` differ.** `ignored` may be acknowledged and retired; `failed` is never
acknowledged, because this gateway could not build its record.

**A start or message answers once the daemon takes the turn**, with `observation: "accepted"`, on every
backend and in local mode. Nothing waits for a turn.

**A collect answers at once.** It returns `{ agentId, agentState, running, turns }`: every ended turn
not yet collected, oldest first, and the running turn's id. A turn a dead agent held reads `lost`. The
collect is a catalog write (`AgentCatalogPersistence.collect`) marking those turns collected and told
in `turnMarks` on the agent (`src/shared/agent-turn-marks.ts`), and it keeps the last eight
non-empty collects' operation ids and turn ids as receipts, so a resent collect replays the same turns. A workflow's agent is refused, as message
and stop refuse it. An agent stored before marks restores with its ended turns collected and told.

**`agentList` shows busy and uncollected agents only**, as compact rows (`src/shared/agent-collect.ts`),
newest first. Naming an `agentId` lists that agent whatever its turns.

**The session hears about its turns as awareness.** `createAgentWatch` in `src/gateway/agentAwareness.ts`
reads every agent of every backend every 5 seconds. A turn that ends gets an `act_now` notice naming
`agentCollect` until its stored `notified` mark is set, which delivery and a collect both do; a collect
also withdraws the turn's notice from the bank. A running turn gets a `no_act` notice every 10 minutes with its newest notes;
its subscriber's `push` makes the bank push it rather than wait for a message, so an idle session
reads it and ends its turn.  The marks are stored, so a restart neither repeats a told turn nor drops an
untold one. Each turn is its own awareness
identity, so two quick completions stay two notices. A `recovering` agent may resume its turn, so only
`unavailable` ends one early. Local mode raises the same notices from the MCP process through
`emitLocalAwareness`, and both render through `src/shared/agent-notice.ts`. A Claude session gets a
channel event; a Copilot session gets the block typed into its pane through the serialized typed
delivery, which rechecks a done notice when its turn comes and drops it once the agent's turns were
collected.

**A waiting call holds for less than the client survives**, bounded by `AGENT_WAIT_BUDGET_MS`. Node's
fetch abandons a silent connection at 300s and `routerPost` re-posts, so a longer hold never delivers
its answer. A turn outliving an await's budget keeps running, and the completion notice still arrives.

## Codex delegation

**`thread/read` needs `includeTurns: true`.** Without it, a successful live-server response has an
empty `turns` array.

**`ThreadLifecycle` owns parked threads.** `codex app-server` starts every configured MCP server in
`~/.codex/config.toml` as its own child on `thread/start`. A thread nobody unloads holds those
servers for the app server's whole life. `thread/archive` unloads the thread and kills them;
follow-up use unarchives and resumes it.

**`startTurn` hands the turn id to `onStarted` before draining.** A terminal can beat its own
`turn/start` reply, and the thread's park must not run before the turn is known to be its own.
`CodexBackendSession` registers the turn's handle inside that callback.

**One owner ends a Codex turn.** `CodexTurns` holds each turn's output, the promise its handle waits
on, and its hold deadline. A frame, a `thread/read`, a deadline and the terminal `ThreadLifecycle`
publishes all end a turn it holds through one function, which resolves the handle and remembers the
terminal. One the owner decided is then handed on for the thread to park behind. A handle registered
after its turn ended is already resolved, from the last 256 ended turns. A child that exits fails
every turn it holds.

**A terminal hold names its release event and bound.** A completed turn with no answer waits for its
final item. At ten seconds its thread is read: a settled read ends it, a read that cannot say ends
it with no answer, and one still reporting `inProgress` arms the next deadline. The third deadline's
read ends it whatever it says, so a hold is three deadlines and their reads at most. An inspect reads
a held turn as running only until its first deadline; after that an answerless settled read ends it.

**Progress is any frame from the turn's own thread.** Matching only a turn id, or counting only
tracker-parsed frames, misattributes or interrupts live work. The driver reports it through
`onProgress`. It logs a frame arriving more than 60 s after the last one and any interrupted
terminal, so an interruption nobody asked for is attributable on the daemon pane.

**A poisoned thread closes the driver.** A request that timed out or answered unreadably leaves the
child's state unknown, so the driver closes, the service gives the generation up, and its running
turns end as lost. The App Server has no per-thread kill.

**Bookkeeping names the record, never only the id.** `mutate` checks identity before its request and
never after it; an awaited reply can resume after that record was replaced. Retire, load, and poison
refuse or drop by record identity. Retirements move the record to the back, and eviction leaves
queued or non-parked records for a later pass.

**A request failure is a `kind`, never a sentence.** The transport emits `refused`, `timeout`,
`unreadable`, or `closed`. Callers must not branch on wording. Notifications dispatch in a microtask,
preserving reply-before-notification wire order.

**The model is a start parameter, not configuration.** It is checked against `model/list` at use time
and is never silently substituted.

**Enabling it:** the capability is announced when `codex` is on `PATH`. A session picks the tools up
at its next start, never mid-session.

## Local agent mode

A session without a serving daemon runs the child itself (`src/mcp/local/`). Installing the CLI is
the opt-in.

- **The gate is reachability, not configuration.** A daemon declaration wins; otherwise
  `shared/agent-binary.ts` probes `PATH`.
- **`AgentDispatch` hides the serving mode.** Local dispatch calls `LocalAgentBackend.handle` with
  the same body; local validation and result parsing reuse the gateway schemas.
- **The list and the collect share the Gateway's shapes.** `agentListAnswer`, `agentListRow` and
  `collectAnswer` in `src/shared/agent-collect.ts` serve every backend and local mode; local marks
  live for the process.
- **Child errors are normalized where stored.** `errorText` covers every `fail()` site and
  `applyTerminal`.
- **A closed local child must be evicted.** `AgentBackendSession.onClosed` is identity-guarded so a
  late close cannot evict its successor, and a listener set after the close is called at once.
- **A turn's rules are the daemon's.** `LocalAgentHandlers` keeps the agent records and answers each
  request; the turns run through the same `TurnRunner`. The pending interrupt and the failure code
  are the record's, written here and in the Gateway's `AgentService`.
- **One message or stop per agent at a time,** queued at the runtime as the daemon core queues them.
- **A child that closes ends its running turns as lost,** and a thread on its replacement is resumed
  before its next turn. A driver that cannot resume one answers that the agent ended with its process.
- **A model listing ends the child it opened when no agent uses it,** read off that child's runner,
  never off the agent records, which outlive a child.
- **Idle reaping needs resumable threads.** `threadsResumable` on the driver row gates it. The hold spans the whole `handle()`
  request, not one child call; at every instant either that hold or `activeTurnId` guards the child.
  `applyTerminal` stamps the idle clock.
- **Codex loads before every follow-up turn.** `ThreadLifecycle` owns the rule; a fresh child
  unarchives and resumes a parked thread.
- **Local settlement uses the same owner.** `CodexBackendSession` calls `client.settleTurn`;
  `onTerminal` resolves the caller. Child exit, close, and retirement settle parked turns directly.
- **`TurnHandle.settled` never rejects.** A rejection becomes a failed terminal.

A Codex thread starts with `danger-full-access` and `approvalPolicy: "never"`, so it can write
anywhere, reach the network, and run anything the delegating session could. The prompt is the only
boundary, as it is for the session itself. A start's or a new turn's `schema` option rides as
`turn/start.outputSchema`, which constrains the final message; a steer keeps the running turn's. The
caller validates the `finalResponse` text, on every backend. An operation keeps its schema, so a
turn sent again after a Gateway restart still carries it.

## Copilot delegation

A session can delegate a self-contained task to a logged-in Copilot CLI through Copilot's own
protocol, the one its SDK speaks: `copilot --headless --stdio`, JSON-RPC with Content-Length framing
(`copilotHeadless.ts`). `open` pings and refuses a protocol version other than 3, so a Copilot older
than 1.0.106 is refused before a session exists. A session is created in allow-all mode (tools, paths and
URLs; approve-all alone still denies a read outside the directory), as the delegating session runs. A send answers at once with a message id; the turn's events follow, and
`session.idle` settles it. `HeadlessTurn` is the one fold for the daemon and the local backend: each
assistant message is a note, a tool start is a note with its command, an error the turn ends on fails
it, an aborted idle interrupts it, and the last assistant message is the answer. A follow-up into a
running turn is a steer (`session.send` in `immediate` mode, answered `steered`); the message names
the turn it means (`expectedTurnId`), and one that has settled since opens a new turn instead. A
start's `effort` is refused when the catalog the daemon read at open does not list it for the
model. A start's or a new turn's `schema` option rides as the send's `responseFormat` with `strict`
on; the provider holds the answer to it, and the caller validates the `finalResponse` text.

**Enabling it:** `copilot` on `PATH` announces the capability. Login uses the CLI and `/login`; no
API key is forwarded. Default model `gpt-6-luna`.

## OpenCode delegation

`opencode serve` is an HTTP server on loopback, and a container's loopback is out of the daemon's
reach. So the driver's child is a bridge (`src/main-opencode-agent.ts`), a bundled entry point that
runs beside the server on the host or inside the container, starts
`opencode serve --stdio --hostname 127.0.0.1 --port 0` with a password it mints, and speaks JSON
lines over its own stdin and stdout (`src/shared/opencode-agent.ts`). The server ends with the
bridge, and the bridge ends when its stdin closes. Neither the URL nor the password crosses the
pipe, and a failure's text has URLs removed.

- **An agent is an OpenCode session,** created under an id the bridge mints, at the agent's working
  directory, with the model split at the first `/` and an allow-everything permission rule, so
  nothing is ever asked. A model the server does not offer is refused by name. OpenCode keeps
  sessions in its own database, so a thread outlives its server and `resumeThread` finds it again.
- **A turn is a prompt, and its id is the prompt's message id,** derived from the operation's id.
  OpenCode lands a repeated id once, so a replayed start or a steer's fallback posts nothing twice.
- **A steer is taken at a step boundary.** The bridge posts it and answers only once the prompt's
  row sits inside the turn it was sent for. One the turn ended without is withdrawn from the inbox
  and rejected, after that turn's terminal, and the service then opens one new turn under the same
  key. The wait is two minutes: a single tool call longer than that refuses the message.
- **A turn's end is read from the session's rows.** The event stream replays nothing after a
  reconnect, and a repeated prompt id emits an execution with no step. Every connection reads the
  active sessions and the rows first, settles turns that ended while it was down, decides steers
  still waiting, and emits a counter for each tool row not yet counted.
- **Commentary is each finished text part before the last message.** The last assistant message is
  the answer and is never also commentary. A tool start is a counter, kinded by its name
  (`counterKindOfTool`, shared with Copilot).
- **`schema`:** OpenCode has no response format on a prompt, so the driver appends an instruction
  and the schema to the prompt text. The caller validates the answer, as for every backend.
- **In a container the bridge runs from the copied runtime,** the same one a session's launcher
  uses. The daemon places it before the first launch there (`ownRuntime` on the driver row). The
  bridge runs under bun with a project's bun settings and `.env` shut out, since its working
  directory is the project.

**Enabling it:** `opencode` on `PATH`, or under `~/.opencode/bin` where its installer puts it,
announces the capability. Sign-in is the CLI's own. Default model `opencode-go/deepseek-v4-pro`.
