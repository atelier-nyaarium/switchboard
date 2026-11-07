# Workflows

A workflow is a pinned JavaScript script running in a bounded QuickJS sandbox in the Gateway. Its
record and journal survive Gateway restarts. The engine replays journaled answers, then resumes live
calls. Only JSON crosses the sandbox boundary.

## Tools

| Tool | Use |
|---|---|
| `workflowStart` | Start a run with script text, args, a default backend and optional `resumeFrom`. |
| `workflowCollect` | Wait for a run and read its result, failure reason and step outcomes. |
| `workflowList` | Find this session's runs after reconnect or restart. |
| `workflowStop` | Cancel a running run. |

The MCP tool reads `scriptPath` from the session's working directory and sends the text. Retries
reuse the invocation id. A Windows session has no agent execution target and cannot start a run.

## Script API

`agent(prompt, options)` runs a Codex or Copilot step. Options are `backend`, `model`, `effort`
(Copilot), `tier` (Codex), `thread`, `skills`, `schema`, `label` and `phase`. `thread` reuses an
agent and queues calls for that thread. `parallel`, `pipeline`, `phase`, `log`, `args` and `label`
follow Workflow semantics. A call's `phase` selects a declared phase; otherwise it uses the current
phase. Checkups list phases with running steps. Scripts return JSON. A failed step answers `null`; `workflowCollect`
shows each step's outcome and reason from the journal.

Schemas use a strict subset: every property is required, set `additionalProperties: false`, and use
a type list such as `["string", "null"]` for nullable values. An answer gets two schema correction
turns before an `invalid` outcome.

Outcomes are `completed`, `invalid`, `failed`, `interrupted`, `lost`, `declined`, `rejected` and
`unavailable`. Reasons are stored only on settle rows. Every ten minutes a running run sends one
progress notice with interval activity counts, the latest script log, phase and step totals. A settle
notice names `workflowCollect`.

## Limits and recovery

A session can have four running runs. Each run can issue 200 agent calls, with at most eight
concurrent dispatches. Scripts are capped at 256 KiB, args at 64 KiB, results at 64 KiB, and sandbox
memory at 32 MiB. A live slice has a 200 ms wall guard; VM jobs are also bounded.

`resumeFrom` replays the unchanged call prefix from a terminal run in the same session and stops at
the first changed call. On Gateway restart, running runs replay from their journal. Use
`workflowList` to find a run and `workflowCollect` to get its result after recovery.
