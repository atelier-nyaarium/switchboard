# Delegated agents

A session can hand a self-contained sub-task to a Codex or Copilot child. The daemon supervises one
child per execution target; the gateway owns the durable record.

`claude -p` is available as a workflow backend only. It is not a session agent.

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

## Codex delegation

**A fence is `(daemonInstanceId, targetId, generation, lastEventId)`.** Reconciliation is the only
path that may install a non-advancing fence, with one exception: an idle agent's follow-up that
starts a new turn, accepted by another child than the one fenced at dispatch (`servedByNewChild`).
Only the child that took the command can name its operation, so that is a reaped target relaunched
or a restarted daemon serving it, and no turn was in flight to misplace. The fence alone cannot order
two children; the operation id is what does. Waiting on reconciliation there moves the fence, and the
replayed receipt no longer matches the fence it was dispatched against, so the turn runs and its
answer is dropped. Copilot's twin is `followUpOnNewChild`, read off the agent itself, since a Copilot
follow-up is only dispatched to an idle agent with no turn in flight.

**A reconciliation adopts another stream, never a dead one.** `classifyReconciliationFence` refuses
an older generation of the stream an agent already follows, and the relay drops a reconciliation
from a daemon instance a later hello replaced (`fromReplacedDaemon`). A reconciliation guard clears
only on the answer carrying its own request id, so a replayed answer to an earlier request cannot
strand held frames.

**An uncertain delivery has one rule, `uncertainDeliveryState`.** A refused or unconfirmed start leaves
the agent unavailable, a prompt leaves it recovering, and a refused stop leaves it as it was. Both families'
refusal and abandonment paths take it, and both throw one `AgentTransitionError`.

**One relay, two adapters.** The fence rules live in `agent-fence.ts` and the relay mechanics in
`AgentRelayCore`: acknowledgement, held frames, the reconcile guard, and per-agent serialization.
`CodexRelay` and `CopilotRelay` supply only their wire schemas, applier, agent listing, and
reconcile request. An agent is askable exactly when its family can build that request.

**Every turn and every op ends.** The recovery decisions live once in `agent-recovery.ts`, and each
family translates its record into them and applies the result through its own terminal path; the
shared vectors in `src/__tests__/fixtures/agent-recovery-vectors.json` run through both adapters.
- **An op knows its daemon:** a route stamps each op with the host register frame's
  `daemonInstanceId`, which the host socket keeps and drops with the socket. Both relays read it
  through one callback.
- **Register pass:** at each host register, before the family hellos, a `requested` op stamped with
  another daemon is abandoned through `uncertainDeliveryState` (a stop also clears `pendingInterrupt`).
- **Resend:** at the catalog frame after a register, a `requested` op stamped with the live daemon is
  sent again under its own operation id. `AgentDaemonCore` takes an op once per id: a repeat in
  flight is dropped and a settled one replays its answer, within a count-bounded ledger.
- **Lost turns:** a reconcile answered under another fence (instance, target or generation) settles
  the known turn `interrupted`, reason "turn lost: its agent process ended", unless it reports that
  turn settled. Codex binds a turn a reconcile read as running only on a thread its child holds.
  A retiring generation ends its own bound turns first (`AgentDaemonCore`'s retire-before-remove), and
  Copilot answers `active: false` for a session it cannot resume.
- **Stale agents are asked again:** a `recovering` agent, and a `working` one fenced to another
  daemon, is asked on every hello and every persist tick, paced per agent by `RECONCILE_GUARD_MS`
  from its last ask whether answered or refused.

**An acknowledgement retires the daemon's only copy.** `ignored` and `applied` permit it; only a
withheld decision does not. Held frames are keyed by agent, although the stream is per target.

**`thread/read` needs `includeTurns: true`.** Without it, a successful live-server response has an
empty `turns` array.

**`ThreadLifecycle` owns parked threads.** `codex app-server` starts every configured MCP server in
`~/.codex/config.toml` as its own child on `thread/start`. A thread nobody unloads holds those
servers for the app server's whole life. `thread/archive` unloads the thread and kills them;
follow-up use unarchives and resumes it.

**A retired generation publishes nothing new.** `publish` checks liveness, and retirement retracts
nothing already retained in the outbox. `release` must name the generation, or a late exit tears down
its successor.

**`startTurn` hands the turn id to `onStarted` before draining.** A terminal can beat its own
`turn/start` reply. Scheduling registration does not work. The local session and the daemon both rely
on this ordering.

**A terminal hold names its release event and bound.** The tracker holds a terminal that precedes its
final item until that item arrives or the deadline releases it. A read still reporting `inProgress`
leaves it held.

**Progress is any frame from the turn's own thread.** Matching only a turn id, or counting only
tracker-parsed frames, misattributes or interrupts live work. Reconciliation treats an unconfirmed
turn as `recovering`.

**A silent turn is interrupted, then its child retired.** Ten minutes without a frame from its thread
and the daemon sends `turn/interrupt`; a second silent window releases the whole target, which ends
every other agent's turn on that child, since the App Server has no per-thread kill. Both steps are logged on the daemon pane, as are a frame arriving
more than 60 s after the last one and any interrupted terminal, so an interruption nobody asked for
is attributable there.

**Bookkeeping names the record, never only the id.** `mutate` checks identity before its request and
never after it; an awaited reply can resume after that record was replaced. Retire, load, and poison
refuse or drop by record identity. Retirements move the record to the back, and eviction leaves
queued or non-parked records for a later pass.

**A turn's clock and warning live with its binding in `CodexLiveTurns`.** Rebinding to another thread
creates a different identity and inherits neither.

**A request failure is a `kind`, never a sentence.** The transport emits `refused`, `timeout`,
`unreadable`, or `closed`. Callers must not branch on wording. Notifications dispatch in a microtask,
preserving reply-before-notification wire order.

**A refused request is not an unavailable agent.** Request failures use the request-error envelope
and HTTP 400; genuine agent failure uses the unavailable result envelope.

**Result availability is explicit.** A terminal result means finished. `agent_dead` means the agent
cannot run. `agent_unreachable` means its App Server may still be running, so do not duplicate work.

**Reconnect adopts persisted threads.** The daemon reopens the execution target, resumes the stored
thread, and adopts its running or settled turn before accepting a follow-up. Reconciliation emits its
receipt before an adopted terminal, preserving the fence. It reads and never deletes a thread.

**A refusal settles the operation.** The route's waiter wakes on it and answers `indeterminate` with
a retryable error. The first follow-up after a daemon restart is answered that way while the gateway
reconciles the agent; the retry lands once the agent is idle again.

**The model is a start parameter, not configuration.** It is checked against `model/list` at use time
and is never silently substituted.

**`ignored` and `failed` differ.** `ignored` may be acknowledged and retired; `failed` is never
acknowledged, because this gateway could not build its record.

**A start or message answers once the daemon takes the turn**, with `observation: "accepted"`, on both
families and in local mode. Only `codexCollectAgent` and `copilotCollectAgent` wait for a turn.

**The session hears about its turns as awareness.** `createAgentWatch` in `src/gateway/agentAwareness.ts`
reads every agent of both families every 5 seconds. A turn that settles gets one `act_now` notice
naming its await tool. A running turn gets a `no_act` notice every 10 minutes with its newest notes;
its subscriber's `push` makes the bank push it rather than wait for a message, so an idle session
reads it and ends its turn. A turn settled before the watch began is history and is not announced, so
a restart announces only what settled since, the downtime included. Each turn is its own awareness
identity, so two quick completions stay two notices. A `recovering` agent may resume its turn, so only
`unavailable` ends one early. Local mode raises the same notices from the MCP process through
`emitLocalAwareness`, and both render through `src/shared/agent-notice.ts`. Only a Claude session
receives them.

**A waiting call holds for less than the client survives**, bounded by `CODEX_WAIT_BUDGET_MS`. Node's
fetch abandons a silent connection at 300s and `routerPost` re-posts, so a longer hold never delivers
its answer. A turn outliving an await's budget keeps running, and the completion notice still arrives.

**Enabling it:** the capability is announced when `codex` is on `PATH`. A session picks the tools up
at its next start, never mid-session.

## Local agent mode

A session without a serving daemon runs the child itself (`src/mcp/local/`). Installing the CLI is
the opt-in.

- **The gate is reachability, not configuration.** A daemon declaration wins; otherwise
  `shared/agent-binary.ts` probes `PATH`.
- **`AgentDispatch` hides the serving mode.** Local dispatch calls `LocalAgentBackend.handle` with
  the same body; local validation and result parsing reuse the gateway schemas.
- **The list is projected per backend.** `projectCopilotListAgent` in `copilot-agent.ts` is the sole
  owner of Copilot's strict field set. `CopilotListAgentSource` makes the wrong record a compile
  error.
- **Child errors are normalized where stored.** `errorText` covers every `fail()` site and
  `applyTerminal`.
- **A closed local child must be evicted.** `LocalBackendSession.onClosed` is identity-guarded so a
  late close cannot evict its successor.
- **Idle reaping is Codex-only.** `threadsResumable` gates it. The hold spans the whole `handle()`
  request, not one child call; at every instant either that hold or `activeTurnId` guards the child.
  `applyTerminal` stamps the idle clock.
- **Codex loads before every follow-up turn.** `ThreadLifecycle` owns the rule; a fresh child
  unarchives and resumes a parked thread.
- **Local settlement uses the same owner.** `CodexLocalSession` calls `client.settleTurn`;
  `onTerminal` resolves the caller. Child exit, close, and retirement settle parked turns directly.
- **`LocalTurnHandle.settled` never rejects.** A rejection becomes a failed terminal.

A Codex thread starts with `danger-full-access` and `approvalPolicy: "never"`, so it can write
anywhere, reach the network, and run anything the delegating session could. The prompt is the only
boundary, as it is for the session itself. A start's or a new turn's `outputSchema` rides as
`turn/start.outputSchema`, which constrains the final message; a steer keeps the running turn's. The
caller validates the `finalResponse` text, on both families: the schema is not persisted on the
operation, so a turn re-dispatched after a Gateway restart runs without it.

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
start's `reasoningEffort` is refused when the catalog the daemon read at open does not list it for the
model. A start's or a new turn's `outputSchema` rides as the send's `responseFormat` with `strict`
on; the provider holds the answer to it, and the caller validates the `finalResponse` text.

**Enabling it:** `copilot` on `PATH` announces the capability. Login uses the CLI and `/login`; no
API key is forwarded. Default model `gpt-6-luna`.
