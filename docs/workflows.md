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

A script starts with `export const meta = <JSON literal>`; nothing else may `import` or `export`.
The Gateway compiles the script with QuickJS before storing the run, so a syntax error is refused
at start with its message. A start answers `not_ready` (retryable) for the first second or so after
the Gateway boots, while the compiler loads.

## Script API

`agent(prompt, options)` runs a Codex, Copilot or Claude step. Options are `backend`, `model`,
`effort` (Copilot and Claude), `tier` (Codex), `thread`, `skills`, `schema`, `label` and `phase`.
`thread` reuses an agent and queues calls for that thread. `parallel`, `pipeline`, `phase`, `log`,
`args` and `label` follow Workflow semantics. A call's `phase` selects a declared phase; otherwise
it uses the current phase. Checkups list the phases of running steps. Scripts return JSON. A failed
step answers `null`; `workflowCollect` shows each step's outcome and reason from the journal. A
script that throws fails the run with the error's message.

### Claude steps

Claude steps run `claude -p`. `--safe-mode` disables project `CLAUDE.md`, skills, installed plugins,
hooks, MCP servers, custom commands and agents. `--disable-slash-commands` disables skills and
commands. Authentication, model selection and built-in tools remain available.

Each turn appends project `AGENTS.md`, or `CLAUDE.md` when `AGENTS.md` is missing. A missing pair
adds no project instructions. The same journaled text is used on resumed turns. The first turn uses
`--session-id`; later turns use `--resume`. A `sessionMissing` result switches a thread to one fresh
session once. Another missing-session result fails the step.

The daemon runs at most eight Claude turns at once. Further calls wait for a tick after `busy`. A
daemon restart interrupts open turns with reason `runner lost: the host daemon restarted`.

Ending a run cancels its open Claude turns: TERM to the turn's whole process group, then KILL after
five seconds. A container turn is signaled inside the container through its pidfile. Gateway close
cancels nothing.

`src/__tests__/claude-isolation.test.ts` checks the isolation against the real CLI. It makes a model
call on your login, so it runs only with `SWITCHBOARD_CLAUDE_LIVE=1`.

Schemas use a strict subset: every property is required, set `additionalProperties: false`, and use
a type list such as `["string", "null"]` for nullable values. An answer gets two schema correction
turns before an `invalid` outcome.

Outcomes are `completed`, `invalid`, `failed`, `interrupted`, `lost`, `declined`, `rejected` and
`unavailable`. Reasons are stored only on settle rows. Every ten minutes a running run sends one
progress notice with interval activity counts, the latest script log, phase and step totals. Script
text in a notice is collapsed to one line and escaped, so a log cannot forge a notice line. A settle
notice names `workflowCollect`.

## Limits and recovery

A session can have four running runs. Each run can issue 200 agent calls, with at most eight
concurrent dispatches. Scripts are capped at 256 KiB, args at 64 KiB, results at 64 KiB, and sandbox
memory at 32 MiB. A live slice has a 200 ms wall guard; VM jobs are also bounded.

`resumeFrom` replays the unchanged call prefix from a terminal run in the same session and stops at
the first changed call. On Gateway restart, running runs replay from their journal. Use
`workflowList` to find a run and `workflowCollect` to get its result after recovery.
