# Questionaire

## Question 1 - What does Forget remove from disk?

Q: What should Forget remove from disk?
A: The session's own conversation in its CLI, Switchboard's own files for it, and the threads of the agents it started.

> "B. finish the plan first. then we do this proper: Workflow and Agents need to be deletable. Otherwise we end up with thousands."

## Question 2 - Forget while the container is stopped

Q: What does Forget say when the session's container is stopped?
A: A prompt. Title "Container is stopped". Buttons "Start container", "Forget anyway", "Cancel". Its line is Question 12's. A start that fails holds the forget, and shows on the session as a failed launch does.

## Question 3 - How a purge runs when the data cannot be reached right now

Q: Every road that ends something has to delete data held by another machine's process, which may be a stopped container, a daemon that is down, or a host that is off. How does a purge run then?
A: One purge queue held by the Gateway. Ending anything removes its Switchboard record at once and, in the same write, queues the ids it named. One drainer deletes through the daemon whenever the place is reachable, and an entry leaves only when the delete is confirmed or the data is already gone. Agents and workflow runs join the queue when they are retired, not only at Forget. An entry older than 30 days is dropped, with no report to the owner.

Recommended because it is the only shape every road can use: adding to a queue needs no waiting, and the sweeps cannot wait on a host.

> "a. yeah. but refine. do not report to me as left behind."

> "30 is fine."

## Question 4 - What ends an agent and a workflow run while the session lives

Q: While a session lives, what ends an agent it started, and a workflow run it started?
A: By age, and by a tool. The age is Question 9's. Two new tools let the session delete one agent or one run right away. Nothing new on the phone. When a workflow run goes at its 7 days, anything left of its steps goes with it.

Recommended because age limits the pile with nobody deciding, and the tools cover "delete it now".

> "A"

## Question 5 - Whether the automatic roads purge too

Q: Do the roads that remove a session without the owner's Forget purge its data too: the 30 day sweep, a routine's own forget, the assistant's session being let go?
A: Yes, all of them. Every road that removes a session ends it the same way Forget does: stop its agents, close its terminal, remove the record, queue the purge. One shared end.

Recommended because with the queue it costs almost nothing more, and it closes today's gap where the sweep removes less than Forget does.

> "A."

## Question 6 - A conversation the owner resumed by hand

Q: What happens to a conversation that is open in a terminal the owner started by hand?
A: Ignore it. Forget targets the conversation id written on the session's record, and nothing is read from the pane. A conversation open in a terminal Switchboard did not start is left alone. When the owner switches a session to another conversation with `/resume`, the record follows to the new id, and the earlier one is not tracked or chased. Claude Code's own cleanup takes those.

> "you mean manually/resumed by me? ignore it. you should not have to chase down every time I /resume."

## Question 7 - How each CLI's data is deleted

Q: By what mechanism is each CLI's data deleted, and Copilot's in particular?
A: Each CLI's own delete call where it has one, and files for Claude Code.
- Codex: `thread/delete`, which removes the rollout, its index rows and descendant threads.
- OpenCode: its session delete, which removes the session and its child sessions.
- Copilot: `session.delete` on the headless protocol. Checked on Copilot CLI 1.0.109, protocol version 3, with one probe session: it answers `{ success: true }`, the session's folder goes and `session.list` no longer names it. A repeat answers `{ success: false }` with "Session file not found", which is the already gone case.
- Claude Code: the transcript and its side folder, removed by the conversation's id. It has no delete for one conversation.

> "Check B now. Tmux start a copilot and /model it to like gpt Luna and greet it once to generate the folder. then implement against the idea that they do have a SDK delete command."

## Question 8 - The leftovers already on disk

Q: What happens to the data already on disk from before this plan?
A: One big sweep, run once the whole plan is built, on Sakura and on mikan. Everything in the Codex, OpenCode and Copilot stores that is not the main conversation of a session in Switchboard's roster goes, marked or not, the owner's own old use included. The roster is the sessions listing plus the assistant. The owner purges the third machine by hand. Claude Code is left to its own 30 day cleanup.

> "Anything not a direct main session of switchboard. If you don't see it as your neighbor in sessions listing (and the hidden assistant), then it goes."

> "ALL from codex, OC, copilot. I don't use them directly anymore. or at least, anything I have used is long over."

> "Same on Mikan as well. I will purge QL myself."

> "but this purge holds until the plan for purge is completely done."

## Question 9 - How long a thread lives

Q: How long does the thread of an agent or a workflow step live on disk?
A: Two cases, by whether there is a thread to come back to.
- A workflow step with no `thread`: its thread is deleted as soon as the step ends, however it ended. Switchboard's own record of the step is what a bad result is investigated from.
- A thread to come back to, which is a workflow's named `thread` or a session's own agent: deleted 24 hours after its last use.
- Only the CLI's thread goes. An answer not yet collected stays in Switchboard's record.
- The two delete tools of Question 4 remain.

> "30 is too long. at 200 a day, that's 5 digits.
> - thread: Set a 24 hour expiration.
> - no thread, archived(stored in Switchboard in case you need to investigate a bad result) or deleted right away?"

> "nah let's keep it simple. no need to keep it even if it fails. it stores enough with every tool call. I like the plan so far."

## Question 10 - A message to an expired agent

Q: What does a message to an agent whose thread expired do?
A: It fails and says why. `agentMessage` is refused as `expired`, telling the session to start a new agent and brief it again. Nothing is recreated. `agentStart` mints its own id, so a start never meets an existing agent. In a workflow, a `thread` key creates on first use, and a thread is never expired while its run is still running.

Recommended because a silently recreated agent has no memory and still answers with confidence, and a plain "not found" does not say what to do next.

Wording proposed with it, not yet settled:
- `agentStart`: "The agent's thread is deleted 24 hours after its last turn."
- `agentMessage`: "A thread unused for 24 hours is deleted. The message is then refused as `expired`: start a new agent and brief it again."

> "A"

## Question 11 - The small records Forget leaves behind

Q: Does this plan also clean the records that name a forgotten session in the Router, the Gateway and the phone?
A: Yes, everything that names the session. Forget cancels its scheduled sends, withdraws its shares, drops its read anchors, deletes its inbox claim file and its held conversation rows, and clears its workspace drafts on the phone. The Router's op ledger is not keyed by session, so it gets a sweep by age. Built as the last phase, after the disk purge works.

Recommended because Question 5 already gives every road one shared end, so each of these is one more line on it, and two are faults today: an armed scheduled send can fire at a session that is gone, and read anchors count against the per-owner stream limit.

> "A. Leave no stragglers behind squatting forever"

## Question 12 - The two Forget prompts under the queue

Q: What do the Forget prompts say now that a queue purges later?
A: Both prompts, each with a second sentence saying what "Forget anyway" does.
- Stopped container. Title "Container is stopped". Line "Switchboard can only purge this session's data while its container is up. Forget anyway purges it the next time the container starts." Buttons "Start container", "Forget anyway", "Cancel".
- Gateway offline, new. Title "Gateway is offline". Line "Switchboard can only purge this session's data while its Gateway is online. Forget anyway purges it the next time the Gateway connects." Buttons "Forget anyway", "Cancel".

Recommended because without the second sentence "Forget anyway" reads as leaving the data on disk for good, which the queue ended.

> "A"

# Plan

Two phases, one lap each. Each ends deployable.

## Phase 1 - Purge of CLI data

Questions 1, 3, 4, 5, 6, 7, 9, 10. Delete calls, the purge queue, one end for a session, then agents and workflow runs.

**The delete, on the daemon:**
- One new `HostOp` that deletes one thing at one place, on the host or inside a container. Its wait is its own entry in `SLOW_HOST_OP_MS`, long enough to start a CLI's client.
- A Codex thread (`thread/delete`), an OpenCode session (its session delete) and a Copilot session (`session.delete`) go through that backend's agent driver at the place. `AgentBackendSession` gains an optional delete, and the daemon's `AgentDaemonService` runs it on the child it opens on demand, in order with that agent's commands, and drops the `TurnRunner`'s memory of the thread. A session CLI's own conversation goes the same way, since it lives in the same store.
- A Claude Code conversation is its transcript and side folder, found by its id under Claude's projects folder. The id is checked as a UUID at the plugin's registration and again at the delete, and both paths must resolve inside that folder.
- Switchboard's own files for a session name (`ownSessionFiles`, from the stashed `createSessionPurge`) are deleted on the daemon's launch lane for that name. The entry is dropped once a new record takes the name.
- The session CLI table `HARNESS` gains how each CLI's conversation is deleted, so nothing decides by a CLI's name.
- Closing a pane is a step of the same entry. A conversation is deleted only after its pane is gone or confirmed absent.
- Answers are closed: deleted, already gone, place down, failed. Only a missing file, a 404 or a CLI's own not-found reads as already gone. A refusal from an older daemon is never read as gone.

**The queue, on the Gateway:**
- Held inside the snapshot `sessionResumeSnapshot` writes, as a fourth key, so dropping a record and queueing its ids is one file write. The restore reads it back as an optional checked field, and an older snapshot reads as an empty queue.
- An entry names its place, what to delete (a backend and id, a Claude Code conversation id, or a session name), the pane to close first, and when it was queued.
- One drainer, outside the persist step: armed when the host daemon registers, when a container starts, and on a timer with backoff. An entry leaves on deleted or already gone. Place down, an unknown op, or a relay failure retries.
- An entry older than 30 days is dropped. No report, no list.

**One end:**
- One function ends a session for every road, and it never waits on the host. It captures every id first, then removes the record and queues the entries in one checked write through `saveSessionsChecked`.
- The ids: the main conversation is `resumeIdOf(record)` with `record.harness`, and each agent gives its backend, target and native `sessionId` while `AgentCatalogStore.get` can still answer. Earlier conversation ids are not tracked.
- It does everything today's ends do between them: `workflows.forgetSession` first, then the board release, presence, awareness, and the vault, routines and assistant `sessionEnded` hooks.
- The roads: the phone's Forget, the 30 day sweep, the routine runner's `forgetFinishedSessions`, the assistant's session being let go, and a failed launch or wake removing a record that names a CLI. Only `forgetBlank` stays a plain forget.
- The 30 day sweep picks its candidates and calls the end once per record, where it calls `SessionStore.sweep`'s bulk delete today.
- Forget asks the daemon to close the pane first, as today, without holding the end on the answer.

**Known cost:** a Gateway rolled back below this build writes the snapshot without the queue, so pending purges are lost.

**Agents and workflow runs:**
- **A step with no `thread`:** its thread is queued for delete when the step ends, however it ended. Retiring reads the agent's backend, target and native id, and adds the entry in memory before the catalog write, so both land in one snapshot.
- **A Claude step:** `claude -p` steps have no agent driver, so they get their own step-end path, which queues the step's session id and target as a Claude Code conversation delete.
- **A thread to come back to:** a workflow's named `thread` or a session's own agent is retired and queued 24 hours after its last use. The clock is the later of its last activity and its last collect, so `AgentCatalogPersistence.collect` records a time. Never while its run is running, never with a turn running or an operation requested, never while `recovering`.
- **A run's end keeps its named threads:** it stops them and leaves them to the age pass, where today it retires every agent of the run at once. A resume within the day reuses them. Agents with no thread are still retired at once.
- **An uncollected answer stays:** an expired agent with a turn not yet collected keeps its record, marked as holding no thread. Its record goes once collected.
- **A message to an expired or deleted agent:** refused as `expired`, a new shared error code, telling the session to start a new agent and brief it again. It is checked before the daemon's liveness, and it covers an id whose record is already gone.
- **A workflow run at its 7 days:** `WorkflowRunner.sweep` retires only the agents still tagged with that run, and queues the Claude session ids its journal still names through a checked write before `WorkflowRunStore.remove`.
- **Two tools:** `agentDelete` and `workflowDelete`. Each does now what the age rule does later: stop, wait idle, retire, queue. `agentDelete` refuses a step agent. `workflowDelete` refuses a run that a live run resumes from.
- **The predicate lives once,** beside `listedAgent`. The age pass runs hourly, off the 3 second tick.
- **Local mode:** `LocalAgentHandlers` gains a delete request, its own age pass and a collect time, on the same predicate, deleting through its own driver with no queue.
- **Guidance:** `AGENT_TOOLS_INSTRUCTIONS`, `WORKFLOW_INSTRUCTIONS`, the agent and workflow tool descriptions and the agents skill say the lifetime. Wording proposed in Question 10 is settled with the owner string by string.

**Order:** the daemon, then the Gateway, then the plugin release that carries the two tools.

## Phase 2 - Prompts, small records, the one sweep

Questions 2, 8, 11, 12.

**Phone:**
- The stopped container prompt and the offline Gateway prompt, worded as Question 12. The decision sits beside `SessionOps`, never in a Composable, and gates `SessionForget.forget` as a whole: its handlers, notification cancels and navigation run only once the forget commits.
- The offline prompt shows only on a current roster that says disconnected. A roster still read from cache waits.
- "Start container" holds the forget on a waiter for the session's spawn point, which settles on running or on a failure. A failure keeps the session and becomes its `LaunchError`. The sandbox gets a Start that fails.
- Forget clears the session's drafts. `WorkspaceDraftStore` keeps each target's drafts in a folder of their own, and the clear also drops that target's held edits in `WindowOps` and `RawFileOps`.

**Router, on a session forgotten:**
- One `onSessionForgotten` listener cancels every scheduled send of the session and keeps the cancelled records, withdraws its shares through `ShareService.withdraw`, and deletes its read anchors through a new write that advances the read anchor version.
- The Gateway's pending forgets for the Router are kept in the snapshot beside the queue and replayed at registration until confirmed. `SessionRegistryReporter` holds them in memory today.
- The op ledger gets a sweep through `onSweep`, at the inbox row lifetime plus a week.

**Gateway, in the one end:**
- Its `InboxClaims` file is deleted.
- Its rows in `PendingJobStore` are dropped, and `PendingDeliveryStore.failTeam` runs.

**Order:** Router release first, then Gateway, then the app.

**The one sweep,** run once after both phases are deployed, on Sakura and on mikan:
- A script lists everything in the Codex, OpenCode and Copilot stores, on the host and in each running container, and keeps only the main conversation of each session in the roster: the sessions listing plus the assistant. A stopped container is listed as not swept.
- Everything else is deleted through Phase 1's delete calls. Marked or not, the owner's own old use included, and agents' threads that a live session still lists. Such an agent's catalog entry is retired first, so a later message reads `expired`.
- Skipped: a thread with a turn running, one whose state cannot be read, and one a running workflow names.
- One more pass removes what earlier forgets left: claim files and held rows on the Gateway, and read anchors on the Router, that name no session in the registry.
- Claude Code is left to its own 30 day cleanup. The owner purges the third machine by hand.
- A dry run prints the counts first. The delete runs only on the owner's go-ahead for those counts. The keep set and the listing are rebuilt just before deleting, and a changed set stops to ask again.

## How it is built

- Cycle `audited-implementation`, every step except the compliance series.
- One lap per phase.

> "all. implementation one will be all but compliance-* series"

## Open while building

- Every agent-facing string: the two tool lines of Question 10, the `expired` refusal, the two new tools' descriptions.
