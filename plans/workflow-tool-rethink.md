# Questionaire

Source: NyaaCode tool feedback. `workflowList` returned 270k characters; `workflowCollect` moved to background at Claude Code's ~120s cut and the caller woke twice (background completion and `act_now` settle notice).

## Question 1 - What does `workflowList` show?

Q: Keep old runs in the list?
A: List only running runs and settled runs nobody collected. A collect returning a settled run marks it collected, durably. The result stays stored; collect by the run ID from `workflowStart` still returns it.

> Can we just toss out all old results? Maybe list only ever lists uncollected results. And if the agent wants the old results a second time for whatever reason, they must remember the workflow ID as given by startWorkflow.

## Question 2 - Does a list row carry `result`?

Q: Include `result` in list rows?
A: No. Rows are for finding ids and status. `result` only comes from collect by id.

> leave out result on listing. result only belongs to the collect by id

## Question 3 - Does `workflowCollect` wait?

Q: Wait for the run, or answer at once?
A: Answer at once: the result, still running, not found, or partial results for a stopped or crashed run. The settle notice is the wake.

> A. Collect should return right away. Either with results, still working, not found, or partial results if the workflow was stopped/crashed.

## Question 4 - What are partial results?

Q: What does collect return for a run with no `result`?
A: Each settled step's answer beside its label. A completed run returns only the script's `result`; its step list carries no answers.

> A. If it didn't give a result as requested, it carries the intermediate turn results instead or something. whatever makes it useful

## Question 5 - Does `agentCollect` answer at once?

Q: Same rule as `workflowCollect`?
A: Yes. Agents match Workflow behavior and patterns.

> Yes. match Agent to Workflow like behavior and patterns

## Question 6 - One mark for list and notice?

Q: Does one collected mark drop a run from the list and withhold its notice?
A: Yes. Collecting a settled run or turn marks it collected; the list skips it and an unsent `act_now` notice is withheld. (Implemented as two bits: delivery sets `notified`, so it cannot double as `collected`.)

## Question 7 - Does `agentList` follow the `workflowList` rule?

Q: List only agents with a running or uncollected turn, rows without answers?
A: Yes. Rows carry agent id, backend, model, state, turn count, last active, latest prompt's first line. `detail` dropped. Collect by agent id is the one way to read an answer; the caller keeps ids of agents it will message again.

## Question 8 - Vault waits?

Q: How do `vault_run` and `vault_collect` wait?
A: Answer at once, and add an awareness notice when a vault job settles. Same pattern as workflows and agents.

> B. Consistent.

## Question 9 - Undeclared phases?

Q: `phase("X")` or `phase: "X"` not listed in `meta.phases` fails the run. Match Claude's Workflow, where it gets its own progress group?
A: Match parity. A phase is display only: replay fingerprints omit it, nothing else reads the declared list.

> hold up. can we align it to meet parity? or is that required to be different?

## Question 10 - Several finished turns, one collect?

Q: An agent finished two turns before collect. Return all, or add a `turnId`?
A: Return every uncollected finished turn, in order, and mark them all collected.

> ohh all of them I guess. for agents.

## Question 11 - Project instructions in `claude` steps

Q: The Gateway injects `AGENTS.md` (or `CLAUDE.md`) text into every `claude` step, capped at 64 KiB; this repo's is 138 KB, so every step is refused.
A: Stop injecting the text. If the file exists, prepend an instruction to read it first.

> If there is an agents md file, we prepend instructions Read agents md first. that's all that's needed.

## Question 12 - Copilot sessions and plugin-raised notices

Q: The plugin's own notices reach Claude sessions only. How does a Copilot session get woken?
A: Type them into the Copilot pane. Same for every other reminder Copilot misses for lack of channels.

> A. Be sure to check other -reminders we are missing from Copilot as a result of missing channels. Anything else needing a system reminder, type into copilot

# Plan

One rule for every long job: start or collect answers at once; a settle notice is the wake; collecting a settled job marks it collected, which drops it from its list and withholds an unsent notice. Clean break: no consumer outside this repo.

**Deploy:** each phase is Gateway first, then plugin release. No phase changes the host daemon. The new Gateway accepts the old empty list request.

## Phase 1 - Workflows, agents, and the plugin's own notices ✅

### Workflow runs

- Two durable bits on the run record: `collected` (only a collect returning a settled run sets it) and `notified` (notice delivery, a collect, and `forgetSession` set it). Delivery alone never hides a run from the list. `WorkflowRunRecordSchema` takes `collected` optional on read; an old settled record restores with both bits set, so an upgrade neither moves runs aside, floods the list, nor sends a stale notice.
- The awareness bank gains per-identity retraction (`AwarenessBank` has only whole-session `dropFor`). A collect retracts the run's banked change. A notice already committed to a carrier is sent; that needs the session connected, and a disconnected session cannot collect.
- `workflowCollect` answers at once: running with step outcomes, settled with `result`, not found, or a run without `result` carrying each settled step's answer. Issues with no settle row show as pending. Answers appear only where the journal stored one (lost and interrupted settle `answer: null`).
- Partial answers share a 256 KiB aggregate budget; past it, later step answers are left out and their rows say so. (Per-step cap 64 KiB, 200 calls a run.)
- `workflowList` gets its own projection, not `runAnswer`: run id, `meta.name` when it is a bounded string, status, `createdAt`, `settledAt`, step counts by outcome. Running and uncollected runs only. Optional bounded `limit` and `status` on the Gateway and MCP schemas.
- The seven-day settled sweep (`SETTLED_RETENTION_MS`) stays: collect by id works for a week.
- An undeclared phase is accepted and shown as its own group (`declaredPhase` in the engine).

### Project instructions in `claude` steps

- A fresh Claude session's prompt starts with an instruction to read `AGENTS.md` first when the target has one, else `CLAUDE.md` when it has that. Presence comes from the existing host read: a read or a `too_large` refusal means present, and the text is discarded; any other refusal moves on to the next file. The prefix lands in the journaled turn prompt, so replay reuses it; a resumed thread (`--resume`) gets no prefix.
- Project-instruction text is never journaled or passed to `appendSystemPrompt` again. Existing `skill_text` rows for `AGENTS.md` or `CLAUDE.md` paths are ignored on replay, and `copyResumeTurns` stops copying them.
- Verify by a real `claude -p` run under the current flags (`--safe-mode`) that the read-first instruction works, before relying on it.

### Agents

- Each persisted turn, Codex and Copilot, gains the same two durable bits as a run: `collected` and `notified`; settled turns restore with both set. The agent watch's in-memory `told` set and its `began` floor give way to `notified`, so a Gateway restart neither repeats a delivered notice nor drops an undelivered one.
- A collect is a catalog mutation: a new collect command per family writes the marks through `AgentCatalogPersistence`, retries a revision conflict from a fresh catalog, and answers once the write landed.
- `agentCollect` answers at once with a collect result of its own: an ordered `turns` array of every uncollected settled turn (outcome, answer, error), plus the running turn's state if any. No `waitTimedOut`. An agent that is `recovering` or `unavailable` still hands back stored uncollected turns.
- The collect carries the plugin's operation id; the agent keeps its last eight non-empty collect receipts (operation id and turn ids), so a retried collect after a lost answer replays the same turns.
- Collect refuses a workflow-owned agent (`runId`), as message and stop already do.
- The agent watch reads the collected mark: `agentRoster` and `RosterAgent` carry it and the watch skips collected turns, so a collect before the next tick sends nothing. A collect also retracts any banked notice for those turns.
- Public `agentList`, Gateway and local: agents with a running or uncollected turn, compact rows for both families, `detail` dropped. The internal lists the workflow dispatcher reads (`listRunAgents`, `reconcileTerminalRuns`) stay complete.
- Local mode (`localAgentHost`, `LocalAgentHandlers`) takes the same rules; its marks live for the process.
- `AGENT_WAIT_BUDGET_MS` leaves the collect paths only; start and message acceptance keep it, as do the `/codex` and `/copilot` serve limits.

### Plugin notices reach Copilot

- `emitLocalAwareness` types the awareness block into a Copilot pane through the serialized typed delivery and its busy retry, instead of returning false. Local agent notices need it now; Phase 2's vault notice rides it. A queued local done notice is rechecked when the queue reaches it, and dropped once its turns were collected. The schemas refuse a collected mark without its notified mark.

### Docs and gates

- `WORKFLOW_START_DESCRIPTION`, collect and list descriptions, `COLLECT_DESCRIPTION`, `WORKFLOW_INSTRUCTIONS` under 1024 (`daemon-capabilities.test.ts`), the `AGENT_TOOLS_INSTRUCTIONS` recovery line (it claims `agentList` finds workflow agents, which the `runId` filter already prevents), `docs/workflows.md`, `docs/agents.md`, `agents/agents.md`.
- Tests to move: `workflow-runner.test.ts`, `federation-harness-workflows.test.ts` (expects a collected run to stay listed), `workflow-claude-dispatch.test.ts` and `workflow-engine.test.ts` (project instructions journaled and copied on resume), `agent-awareness.test.ts`, `federation-harness-codex.test.ts`, `copilot-route.test.ts`, `tool-description-budget.test.ts`.
- New: delivered notice is not collection; collect before the next watch tick sends nothing; two quick turns collected together; a retried collect replays; restart keeps both bits; an old settled record sends no notice; a 138 KB `AGENTS.md` gets the prefix.

## Phase 2 - Vault ✅

- `vault_run` answers at once with a `jobId`. The plugin's job does the waiting in the background: it long-polls `/vault/collect` for the owner's answer, starts the child on approval, and finishes capture before the job counts as settled. Approval, denial and expiry all settle the job.
- A Gateway restart retracts open vault requests (the `vault-open-requests` ledger), so the background poll then reads the request as expired and the job settles refused, with its notice. The poll rides out the restart's connection errors rather than settling on them.
- A repeated run while the request is open joins its job, so one approval starts one child. A launch that throws, or a run approved during shutdown, settles refused. Withdraw refuses once the child exited.
- `vault_collect` answers at once from the job map. The MCP `waitMs` inputs go. Results live for the plugin process, as today.
- On settle the plugin raises a notice naming `vault_collect` through `emitLocalAwareness`, so Copilot gets it too; collecting first withholds it.
- The loopback routes keep their waits and long-route classification: askpass (`/vault/askpass`, `/vault/collect`), `/vault/capture`, `/assistant/send`, `/assistant/run`. No `gateway-long-waits.ts` change.
- `vault-tools.test.ts` covers a job settling with no caller waiting, capture included; `vault-askpass.test.ts` stays green unchanged. Vault guidance and `docs/vault.md`.

## Phase 3 - Copilot baseline after compaction

- The Gateway already receives `compacting` in each derived presence report (`DerivedPresenceSchema`, merged by the daemon's `copilotCompaction.ts` overlay). On a Copilot session's `compacting` true to false, the Gateway builds its baseline (`composeBaseline`) and pushes it as an awareness row through the delivery queue, which the plugin types into the pane with the busy retry. No daemon change.
- The baseline renders through one shared function for the Claude hook and the Copilot push.
- Copilot's MCP instructions gain `BASELINE_RULE`, which only the Claude branch carries now.
- Test: a Copilot compaction end delivers one baseline; a Claude session's does not.

## Painpoints

- **Codex and Copilot routes repeat collect and list:** `CodexRoute.collect` and `CopilotRoute.collect` each carry their own `turnView` and `agentTrouble`; a third backend copies both. Tracked on the board under the two-stacks item.
- **Per-turn fields cost four schema variants per family:** the stored turn schemas are strict discriminated unions on `state`, so a per-turn mark would touch every variant twice. Marks live on the agent (`turnMarks`) instead.
- **Audit reads went through the container's journal files:** until this ships, the running Gateway's `workflowList` overflows and its `claude` steps refuse this repo's `AGENTS.md`, so every audit result was pulled from the run's `journal.jsonl` under the Gateway's data directory.
