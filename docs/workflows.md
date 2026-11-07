# Workflows

A workflow is a pinned JavaScript script running in a bounded QuickJS sandbox in the Gateway. Its
record and journal survive Gateway restarts. The engine replays journaled answers, then resumes live
calls. Only JSON crosses the sandbox boundary.

## Tools

| Tool | Use |
|---|---|
| `workflowStart` | Start a run from `script` text or a `scriptPath`, with args, a default backend and optional `resumeFrom`. |
| `workflowCollect` | Wait for a run and read its result, failure reason and step outcomes. |
| `workflowList` | Find this session's runs after reconnect or restart. |
| `workflowStop` | Cancel a running run. |

The MCP tool takes exactly one of `script` and `scriptPath`, reading the path from the session's
working directory. Retries reuse the invocation id. A Windows session has no agent execution target
and cannot start a run.

A script starts with `export const meta = <JSON literal>`. Static imports and exports in the body
fail compilation. Dynamic imports have no module loader and fail when called. The Gateway compiles
the script with QuickJS before storing the run, so a syntax error is refused at start with its
message. A start answers retryable `not_ready` while QuickJS loads.

## Script API

`agent(prompt, options)` runs a Codex, Copilot or Claude step. Options are `backend`, `model`,
`effort` (Copilot and Claude), `tier` (Codex), `thread`, `skills`, `schema`, `label` and `phase`.
`thread` reuses an agent and queues calls for that thread. `parallel`, `pipeline`, `phase`, `log`,
`args` and `label` follow Workflow semantics. A call's `phase` selects a declared phase; otherwise
it uses the current phase. Checkups list the phases of running steps. Scripts return JSON. A failed
step answers `null`; `workflowCollect` shows each step's outcome and reason from the journal. A
script that throws fails the run with the error's message.

## Backends and outcomes

`createWorkflowAgentDispatch` in `src/gateway/workflows/agentDispatch.ts` routes Codex and Copilot
through the Gateway's delegated-agent commands. Codex uses its App Server session and turn protocol
(`src/gateway/codexAgentCommands.ts`, `src/mcp/devcontainer/codexAppServer.ts`). Copilot uses
`copilot --headless --stdio` and its JSON-RPC session protocol
(`src/gateway/copilotAgentCommands.ts`, `src/mcp/devcontainer/copilotHeadless.ts`). Claude is
workflow-only: `createClaudeSteps` in `src/gateway/workflows/claudeSteps.ts` asks the daemon to start
one `claude -p` process per turn; a workflow thread resumes its stored Claude session id through
`createClaudeRunner` in `src/mcp/devcontainer/claudeRunner.ts`. See `docs/agents.md` for the
delegated-agent protocols.

Finished answers pass through `answerOutcome` in `src/gateway/workflows/agentViews.ts`; failures and
refusals use `failureOutcome` and `refusalOutcome` there. `answerOutcome` treats a completed text answer as a
decline only when no schema was requested. A schema-backed answer is never a decline based on its
answer text. The engine validates it, sends up to two correction turns, then records `invalid` if it
still fails. A completed step returns its answer to the script. Other outcomes return `null`;
`workflowCollect` shows each step's outcome and reason and the run's result. `settle` rows in the
journal retain each step answer.

| Outcome | Meaning |
|---|---|
| `completed` | The answer is available to the script. |
| `invalid` | The answer failed schema validation after correction turns. |
| `declined` | An unstructured answer matched the decline rules. |
| `rejected` | The target or requested capability is not accepted. |
| `unavailable` | The backend or required execution service is unavailable. |
| `interrupted` | The turn was stopped or interrupted. |
| `lost` | The agent turn was lost when its process ended. |
| `failed` | The step failed for another reason. |

## Journal and ownership

`src/gateway/workflows/workflowSchemas.ts` defines the journal rows.
`src/gateway/workflows/engine.ts` appends and replays them; `src/gateway/workflows/runner.ts` owns
their durable storage.

| Row | Purpose |
|---|---|
| `issue` | The call, selected backend, options and replay fingerprint. |
| `turn` | One dispatch attempt, including its target and backend identifiers. |
| `settle` | The step outcome, answer and reason; may include `threadMap`. |
| `thread_map` | The latest agent or Claude session for a named thread. |
| `skill_text` | Project instructions or skill text needed for replay. |

A settled call carries its thread mapping on the `settle` row. A standalone `thread_map` row is
written only when a Claude `sessionMissing` result switches a thread to a fresh session mid-step.
`threadMapsOf` in `src/gateway/workflows/workflowSchemas.ts` reads both forms in journal order, so
replay and `resumeFrom` recover the same thread.

`createWorkflowAgentDispatch` in `src/gateway/workflows/agentDispatch.ts` coordinates backend dispatch
and run cleanup.
`createClaudeSteps` in `src/gateway/workflows/claudeSteps.ts` owns Claude turns, result acknowledgements
and journal-derived cancellation retries. `createWorkflowPrompt` in
`src/gateway/workflows/dispatchPrompt.ts` reads skills and project instructions.
`src/gateway/workflows/dispatchCore.ts` exports turn, thread and host-failure helpers.
`answerOutcome` and `failureOutcome` in `src/gateway/workflows/agentViews.ts` own shared outcome mapping.
`createAgentFamilies` in `src/gateway/workflows/agentFamilies.ts` owns normalized Codex and Copilot
operations; `createTerminalAgents` in `src/gateway/workflows/terminalAgents.ts` stops and retires
agents after a run.

`src/mcp/devcontainer/claudeRunner.ts` runs the CLI in the host daemon.
`src/shared/host-op.ts` defines its run, cancel and result frames; `src/mcp/devcontainer/hostDaemon.ts`
routes them. `agentTeams` in `src/gateway/compose/composeAwareness.ts` samples running agent turns
and feeds `setAgentsRunningReader`; `snapshot` in `src/gateway/presence.ts` projects `teammates` for
their owning sessions.

### Claude steps

Claude steps run `claude -p` with `--safe-mode` and `--disable-slash-commands`. Switchboard appends
project instructions with `--append-system-prompt`.

Each turn appends project `AGENTS.md`, or `CLAUDE.md` when `AGENTS.md` is missing. A missing pair
adds no project instructions. The same journaled text is used on resumed turns. New sessions use
`--session-id`; later thread and correction turns use `--resume`. A `sessionMissing` result switches
a thread to one fresh session once. Another missing-session result fails the step.

The daemon runs at most eight Claude turns at once. Further calls wait for a tick after `busy`. A
daemon restart interrupts open turns with reason `runner lost: the host daemon restarted`.

Ending a run cancels its open Claude turns. A daemon restart also cancels interrupted turns while the
run continues. The Gateway derives cancel debt from journaled Claude turns. It retries unacknowledged
cancels each tick and after daemon registration. The runner sends TERM, then tries KILL five seconds
later. It acknowledges after a KILL attempt or when no process matches. Container turns use
turn-tagged pidfiles; host orphan processes must match the turn tag. Gateway close cancels nothing.

The runner keeps each result in its outbox until `claude_turn_ack`. The Gateway sends that ack only
after a new recognized result's `claudeTurnResult` resolves at the settle write. Duplicate, terminal
and unknown results are acknowledged without another settle.

A missing CLI settles `unavailable`. An invalid target settles `failed`. `busy` waits for a tick.

The real-CLI isolation test sends a model request. It runs only with `SWITCHBOARD_CLAUDE_LIVE=1`. It
checks appended `AGENTS.md`, empty skills and MCP server lists, and no project hook.

Schemas use a strict subset: every property is required, set `additionalProperties: false`, and use
a type list such as `["string", "null"]` for nullable values. An answer gets two schema correction
turns before an `invalid` outcome.

Outcomes are `completed`, `invalid`, `failed`, `interrupted`, `lost`, `declined`, `rejected` and
`unavailable`. Step outcome reasons are stored on settle rows. Every ten minutes a running run sends
one progress notice with interval activity counts, recent script logs, phase and step totals. It
counts non-completed steps and names the newest outcome and reason. Script text in a notice is
collapsed to one line and escaped, so a log cannot forge a notice line. A settle notice names
`workflowCollect`.

## Limits and recovery

A session can have four running runs. Each run can issue 200 agent calls, with at most eight
concurrent dispatches. Scripts are capped at 256 KiB, args at 64 KiB, results at 64 KiB, and sandbox
memory at 32 MiB. A live slice has a 200 ms wall guard; VM jobs are also bounded.

`resumeFrom` replays the unchanged call prefix from a terminal run in the same session and stops at
the first changed call. On Gateway restart, running runs replay from their journal. Use
`workflowList` to find a run and `workflowCollect` to get its result after recovery.
