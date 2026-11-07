# Questionaire

Goal: a Switchboard-driven workflow engine, offered to any session (Claude Code and Copilot CLI), agnostic of backend. Steps run on Codex agents, Copilot agents or `claude -p`, and can ask for JSON validated against a schema. Copilot's own Dynamic Workflows stay off.

> "I kinda want Copilot to get a switchboard edition of a Workflow pipeline for parity. Multi model expertise. It's going to be similar to what you know, but structured for switchboard, which could technically call upon codex or copilot. Or even Claude against the -p CLI param."

> "we won't enable their Workflows, because I need it to be agnostic and Switchboard driven."

Settled before the questionnaire:

- Both agent families take `outputSchema` on a turn (Codex `turn/start.outputSchema`, Copilot `responseFormat` strict); `claude -p --json-schema` answers `structured_output` or omits it on refusal. The engine validates every answer itself either way.

## Question 1 - Where does a run live?

Q: Where does a workflow run live: the Gateway, the calling session's plugin, or split (script in the session, journal in the Gateway)?
A: Gateway-held. The Gateway runs the script in a sandbox, journals every step, and dispatches steps through the existing agent services. Each step still executes where the calling session lives: the host daemon spawns the agent on the host or through `docker exec` into the session's devcontainer, as agents do today. A run outlives its caller, compaction and restarts, and the phone can list and cancel it.

Recommended because the Gateway already owns agents, routines and durable state, and a split still needs most of the Gateway work while losing the run with its session.

> "oh ok perfect. lock it"

## Question 2 - How is a workflow written?

Q: Sandboxed JS script, declarative step list, or a declarative graph with sandboxed expressions?
A: Sandboxed JS script with the Workflow API agents already know (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, a literal `meta` declaring phases), run in QuickJS (WASM) inside the Gateway with memory, instruction and time budgets. Only JSON and those calls cross the boundary. The script is pinned per run; a restart replays it against journaled answers, so clock and random stay banned. `agent()` takes different options from Workflow's, since a step chooses its backend (Claude, Copilot or Codex).

Recommended because parity is the goal: agents write it right the first time because they already write it. A declarative list cannot filter or branch, and the hybrid pays both the sandbox and the new-language cost.

> "A it is. But still, our Agent call will take slightly different params since we need to be able to choose the Claude/copilot/codex."

## Question 3 - How does a step pick its backend?

Q: One `agent()` with a `backend` option, one function per backend, or the backend in the model string?
A: One `agent(prompt, {backend, model, effort, tier, schema, label, phase})`. The run takes a default backend at start, so most calls omit it. The engine checks options per backend at the call and refuses a wrong one (`tier` on Copilot) with the reason, before anything is sent.

Recommended because it keeps the `agent` name, adds one field, and the per-backend check gives the safety of separate functions. A model name cannot decide the backend, since Copilot also serves Claude and GPT models.

## Question 4 - Who owns a run and its agents?

Q: The starting session, or the run as its own owner?
A: The starting session. The run and its agents belong to it; agents land in its catalog tagged with the run id, steps execute where it lives, and done and failed notices go to it. The session record survives compaction and restarts, so the run does too. Forgetting the session cancels its runs first. A routine-started run names its session, as routines already do.

Recommended because both agent families already enforce session ownership (the owner is a session record), and a self-owned run would only add surviving a forget.

## Question 5 - Fresh agent per step, or reusable threads?

Q: One-shot steps, one-shot plus an optional thread key, or agent handles?
A: One-shot, plus an optional `thread` key. `agent(prompt, {thread: "fixer"})` reuses one agent for every call naming that key in the run; backend and model are fixed at its first use, and calls on one thread queue. Without the key each call is a fresh agent, as in Workflow. Schema correction turns always go to the same agent.

Recommended because it is one optional field, a script without it reads exactly like Workflow, and a fix-until-the-audit-passes loop keeps the fixer's context.

## Question 6 - What may a claude -p step do?

Q: Full access with built-in tools only, full access plus the session's other MCP servers, or read-only by default?
A: Full access, built-in tools only: `--permission-mode bypassPermissions`, `--safe-mode` and `--disable-slash-commands`, so no MCP servers, plugins, skills, hooks or CLAUDE.md, and never the Switchboard plugin. Same footing as Codex and Copilot steps. (`--strict-mcp-config` alone filters only MCP servers; skills and plugin hooks still load, including from a project's `.claude/settings.json`.)

Recommended because matching the other backends keeps a script backend-agnostic. Plugin MCP servers (Lexicon) for steps can come later as their own option.

## Question 7 - Where does a script come from?

Q: Inline or a file path, inline plus a Gateway library, or library only?
A: The start tool takes `script` or `scriptPath`; the plugin reads the file where the session lives (host or container) and sends the text, which the Gateway pins per run. No saved library in the first build.

Recommended because most runs are one-offs an agent writes for the task at hand. A library, which phone- and routine-started runs need, slots in later without changing the run model.

## Question 8 - What does the phone show of a run?

Q: Runs list plus a run page, runs list with Cancel, or nothing yet?
A: Nothing but the indicator for now: the composer's three-comet `Comet.WORKFLOW` lights while a run of that session is running. Today `cometFor` shows it only from `presence.workflow` (Claude's own workflow row read off the pane) while the session is busy; a running Switchboard run lights it too, even while the session sits idle at its prompt.

> "C. Just the indicator 3 comet around the text box that a workflow is running. For now"

## Question 9 - How does a step get a skill file?

Q: A `skills` option, a line in the prompt, or each backend's own skill loading?
A: `agent(prompt, {skills: [path]})`. At dispatch the daemon reads each file where the step runs (host, or `docker exec` into the container), caps its size, and puts it in front of the prompt. Same text on every backend. A missing file fails the step naming the path, before the agent starts.

Recommended because delivery is guaranteed and identical on all three backends; GPT agents told to read a file may skim or skip it.

> "ohh can we pass a skill file path to them?"

## Question 10 - Can a run resume after a script fix?

Q: `resumeFrom: runId` on start, or always fresh?
A: `resumeFrom: runId`. The new run replays the longest unchanged prefix of the old run's `agent()` calls (same prompt and options) from its journal and runs the rest live, as Workflow's `resumeFromRunId` does. A thread whose calls diverge partway gets a fresh agent from that point.

Recommended because the engine needs journal replay for Gateway restarts anyway, and it saves expensive reruns.

## Question 11 - Does a claude -p step read the project's agent instructions?

Q: Safe mode plus the project's instructions appended, safe mode only, or no safe mode?
A: Safe mode plus the instructions appended. The engine reads the step's project `AGENTS.md` (else `CLAUDE.md`) where the step runs, through the same host read as skills, journals it like skill text, and passes it with `--append-system-prompt` on every turn, resumes included.

Recommended because Codex and Copilot read `AGENTS.md` on their own, and parity is what lets a script switch backends with one argument.

> "play around with A" ... "sounds good"

Probe (Claude Code 2.1.319, scrubbed env, a fixture whose `.claude/settings.json` enables a plugin and two hooks, with canaries in `AGENTS.md` and `CLAUDE.md`):
- `--safe-mode` plus the appended `AGENTS.md`: answered the `AGENTS.md` canary, not the `CLAUDE.md` one; no hook fired; `mcp_servers` empty; no plugin skills or agents. The init event's `plugins` still lists installed plugins as an inventory, but none of their skills, agents or MCP servers load.
- Adding `--disable-slash-commands` also drops the 19 bundled skills and the Skill tool, leaving only built-in tools.
- `--json-schema` under safe mode answered a valid `structured_output`.
- `--session-id` then `--resume` with the append on both remembered the first turn and kept the instructions.
- `--safe-mode` alone read neither file.
- Control, `--setting-sources project` with an empty strict MCP config: both hooks fired, the project's plugin loaded, and `CLAUDE.md` was read.

## Question 12 - Where does turn recovery live?

Q: Fix turn recovery in the agent layer first, or keep it in the engine?
A: Agent layer first. The family reducers and the relay guarantee every turn and every op ends: a turn a restarted daemon lost settles `interrupted`, a stop left `requested` can be abandoned and resent, and ops dispatched under a dead daemon are abandoned at the next register. The engine only waits for terminal states. Session agents get the fix too.

Recommended because four audit laps found blockers in the same mechanism, each the engine re-deriving recovery the agent layer does not guarantee; today a session's `codexCollectAgent` or `copilotCollectAgent` can wait for ever on a turn lost to a daemon restart.

> "A it is"

## Question 13 - How does a script see why a step failed?

Q: Null by default with details on request, always a full result object, or null only?
A: Null only; reasons live in the journal. Every step settles with one outcome, the same across backends, and its reason text, on its settle row in the journal and nowhere else. `agent()` answers `null` for any outcome but `completed` (Workflow parity, no extra option), and the run log stays script-authored. `workflowCollect` and the progress notices read outcomes and reasons from the journal (each step's outcome and reason; failed steps counted, the newest named). That is the debugging road, as Workflow's own journal is for a crashed agent.

> "let's keep detail param out. I want it simpler to write, and informative when it needs to debug."

> "maybe we don't capture error inside of the script then. the journal is where it should go?"

| Outcome | Meaning |
|---|---|
| `completed` | answered, and passed its schema |
| `invalid` | answered, but still failed the schema after 2 correction turns |
| `failed` | the turn errored |
| `interrupted` | stopped by a cancel |
| `lost` | its process died with a daemon restart |
| `declined` | the provider refused the content: a safety classifier, terms of service, or the model declining |
| `rejected` | a bad parameter to `agent()` the call could not catch: a model or effort the daemon refuses, a missing skill file, a schema the provider will not take |
| `unavailable` | the backend is not served, or the host is down |

Recommended because it keeps Workflow parity by default while a fix-until-green loop can tell a broken build from a daemon restart.

> "split refused between a provider refusal (like a over sensitive classifier or TOS) vs a bad param to the agent(). Otherwise I think that's a good structure."

## Question 14 - Merge the per-provider agent tools?

Q: Five shared tools with a clean break, the same with aliases for a while, or keep them separate?
A: Five shared tools, clean break: `agentStart`, `agentMessage`, `agentCollect`, `agentStop`, `agentList`, replacing the ten `codex*Agent` and `copilot*Agent` tools. Only start takes `backend`; the others read it off the agent id. Start's options match the workflow's `agent()`. The old names go in the same release that updates every mention, in this repo and in the nyaaskills repo.

Recommended because it halves the tool definitions every session carries, and gives sessions and scripts one vocabulary.

> "Plan a clean break and an update of the projects/nyaaskills repo"

## Defaults (not asked)

- **Tools:** `workflowStart` (`script` or `scriptPath`, `args`, default `backend`, `resumeFrom`), `workflowCollect`, `workflowList`, `workflowStop`. Descriptions stay short and point to `switchboard_capabilities`; the `agent()` reference lives in the capability guidance, since `guardTools` refuses a description past 1024 characters. `workflowStart` carries a per-invocation id through `requestHead`, so a retried post starts one run. `workflowCollect` waits within `AGENT_WAIT_BUDGET_MS`, the name matching `codexCollectAgent`, `copilotCollectAgent` and `vault_collect`.
- **Tool description (owner's ask):** `workflowStart`'s description says plainly that this is Switchboard's own Workflow, running steps on other providers' CLIs (Codex, Copilot, `claude -p`), and when to reach for it over a built-in Workflow tool: when a step needs GPT or another model family. It then lists only the `agent()` options that differ from Workflow's, one line each, in this shape:

  ```js
  agent(prompt, {
    backend,  // "codex" | "copilot" | "claude"; defaults to the run's
    model,    // that backend's model id
    effort,   // Copilot and claude only
    tier,     // Codex only: "priority" or "standard"
    thread,   // reuse one agent for every call naming this key
    skills,   // skill file paths prepended to the prompt
    schema,   // JSON Schema; the answer is validated, null on failure
  })
  ```

  Everything shared with Workflow (`parallel`, `pipeline`, `phase`, `log`, `args`, `label`) is named, not re-explained. The full reference stays in the capability guidance, within `guardTools`' 1024-character limit.

  > "the description of the tool (if loaded by Claude) should say this is a Switchboard version that utilitizes other provider CLI's or something. Use if you need GPT or other models. Few new parameters you have to explain on `agent`"
- **Capability:** `workflow`, declared by the daemon (`daemonCapabilityDeclaration`) when any agent backend is installed, added to `GATED_CAPABILITY_IDS`, registered beside `registerAgentBackend` for Claude and Copilot sessions, and listed in `registerEveryTool`.
- **Notices:** one chain per run, shaped like one agent turn's: a `no_act` progress notice every 10 minutes while it runs (current phase, steps settled and running, newest log lines), then one `act_now` notice at settle naming `workflowCollect`. Sourced from the run store and worded in one shared module. Step agents send none.
  - The settle notice is at-least-once: never dropped, repeated at most once after a crash, harmless since `workflowCollect` is idempotent. `notified` is written when the awareness bank commits a carrier holding the run's settle change (a new per-subscriber delivered hook), not when the change is observed, since the bank is memory only and holds a closed session's notice. Un-notified terminal runs are observed again at boot and when their session's handshake is confirmed.

  > "Workflow should only report 1 chain of notices for the whole pipeline. Agents inside a workflow will not issue one each."
- **Result:** the script's `return` value, JSON.
- **Determinism:** the VM prelude makes `Date.now`, `Date()`, `Math.random` and an argless `new Date()` throw, and deletes `WeakRef` and `FinalizationRegistry`. No timers. Replay rebuilds the phase and log in memory without sending any notice.
- **Options per backend:** checked by mapping `agent()` options onto each family's strict schema, never a hand-written table. Codex takes `model` and `tier` (its start has no effort, so `effort` is refused); Copilot takes `model` and `effort`; `claude -p` takes `model` and `effort` (low, medium, high, xhigh, max) through its own strict schema; every backend takes `schema`, `skills`, `thread`, `label` and `phase`.
  - A thread's later call maps onto the family's message schema: backend, model, effort and skills must match its first use or be omitted; `tier` and `schema` may change per turn.
- **Where a step fails:** only option names, thread mismatches, a schema ajv cannot compile, and caps (the prompt alone against `AGENT_PROMPT_MAX_BYTES`) reject at the `agent()` call. Everything decided at dispatch (a missing skill file, prompt plus skills over the cap, a backend the daemon does not serve, a model or effort the daemon refuses, an absent `claude`) is a journaled failure settle row answering `null` with its reason, so replay reproduces it.
- **Corrections:** an answer failing its schema gets up to 2 correction turns on the same agent, with ajv's error paths; still failing, the call answers `null`, as a failed item does in Workflow.
- **Stopping agents:** every terminal transition (succeeded, failed, cancelled) stops each run agent with a turn in flight, so a script that throws or returns without awaiting leaves nothing working. Pending stops are derived from terminal runs whose agents are `working`, never held in memory, and sent at each host register (see the call lifecycle).
- **Forget:** cancels the session's runs synchronously before its record drops, marking them `notified` (a forgotten session is owed no notice, and routine sessions reuse names). It stops each agent a stop accepts now, catching each refusal per agent; agents a stop refuses run to completion unowned, as a forgotten session's own agents do today. Close does not cancel.
- **Caps:**
  - 8 concurrent steps per run, enforced by the engine outside the VM; queued thread calls and correction turns take no slot.
  - 200 `agent()` calls per run, counted by `issueOrdinal`; the 201st rejects with a cap error.
  - 4 running runs per session, checked in the start commit and skipped on replay.
  - Script 256 KB, args 64 KB, prompt plus skills `AGENT_PROMPT_MAX_BYTES`, result 64 KB, log 200 lines of 1 KB.
  - An answer over 64 KB answers `null`, never truncated.
  - A run whose script is still pending after a drain with no `agent()` call unsettled fails with "script stalled".
  - Settled runs swept after 7 days.
- **Reach:** steps wait while no host socket is live instead of failing. No plugin local mode. A session with no agent execution target (Windows) is refused at start.
- **Phone:** Q8 supersedes Q1's list and cancel; the phone shows only the indicator.
- **`claude -p`:** a workflow-only daemon runner, not a third agent family; `claude` never joins `AGENT_BACKENDS`.

# Plan

## Phase 1 - Agent layer: every turn and op ends ✅

### Bug Classes

- **Mechanism:** step dispatch and recovery against the daemon. **Defect class:** the engine acts on a host or daemon identity it has not confirmed, so a retry duplicates a full-access agent or a stop is never delivered.
  - Lap 1: abandon-and-retry on a bound past "the daemon's hello".
  - Lap 2: timer abandon could start a second agent; retry tied to a hello naming a new instance.
  - Lap 3: the turn row could journal the dead daemon's id (register precedes the family hellos), and boot stops were committed before any host socket existed. Fixed by the register's instance id on the host socket, and the call lifecycle table as the one place these rules live.
  - Lap 4: a turn whose daemon restarted had no exit (the agent layer itself leaves it `recovering` for good: Copilot's reconcile answers `active: false` and `applyReconciled` keeps the old turn; a Codex reconcile that cannot read the thread does the same); a container start went out before the host's catalog; a stop left `requested` could be neither resent nor held back; an abandoned message's retry ran into its own `indeterminate` op. Four laps in one mechanism: the engine is re-deriving, from outside, recovery the agent layer does not guarantee. Resolved by Question 12: the agent layer guarantees every turn and op ends, and the engine waits only for terminal states.
  - Lap 5 (agent layer): a `working` agent whose reconcile was refused was never asked again; the lost-turn settle skipped terminal bookkeeping and missed a stale `inProgress` read and a lost child; an op whose frame or refusal was lost under the same daemon had no exit; a Copilot reconcile refused a session it could not resume. Every fix landed in the agent layer's own rules, not the engine.

- **Agent layer (Q12):** every turn and every op ends, for session agents and run agents alike. Ships alone, with its own tests, before any engine code.
  - **One decision, two adapters (shipped):** the register-pass and reconcile verdicts live once in `src/shared/agent-recovery.ts`; each family translates its record into that input and applies the result through its own terminal path. Both relays read the live daemon instance from the host socket through one callback. A shared vector table (`src/__tests__/fixtures/agent-recovery-vectors.json`) runs through both family adapters. The daemon core owns operation answers (capture, send, replay) and the retire-before-remove sequence; each family supplies its bound turns and a terminalizer.
  - **Ops know their daemon:** each op is stamped with the register id it was dispatched under, in an optional field added to both families' operation schemas, so the stamp survives a Gateway restart. The host registry keeps the register frame's `daemonInstanceId` on the host socket and drops it with the socket. In this phase the routes stamp at dispatch; Phase 2's seam extraction carries the stamping with it.
  - **Register pass:** at each register, before the family hellos, every `requested` op stamped with another register id is abandoned, since its command died with the old daemon. A start leaves its agent `unavailable`, a message leaves it `recovering` for the hello's reconcile, a stop sets its op `indeterminate` and clears `pendingInterrupt`. It fires the relay's listeners for each agent it changes, as `settle` does.
  - **The daemon takes an op once:** a per-process ledger keyed by operation id, built on `createOpDedupe`. A repeat of an id still running is dropped; a repeat of an id it answered re-sends that answer; only an id it never took runs. The ledger is bounded by count; an id that falls out of it may run again only if it is still `requested` after replay, which means it was refused, and a refused op created nothing.
  - **Resend:** at the catalog frame that follows each register, after the hellos' replay has landed every retained acceptance, every `requested` start, message or stop stamped with the live register id is sent again under its own operation id. This ends an op whose frame or refusal was lost under the same daemon (refusals are not reliable frames, and a Codex start's `settle` abandons nothing).
  - **Stop abandon:** Codex `abandonDelivery` gains a stop branch (it returns early today for an op with no exchange), matching Copilot's and `applyRejection`. A stop left `requested` no longer blocks every later stop.
  - **Lost turns:** a turn's acceptor is the agent's persisted reconciliation fence (daemon instance, target, generation). A reconcile answered under another fence (another instance, or the same instance and target at a newer generation) loses the turn unless it reports the turn settled: Copilot `active: false`, Codex with no `turnState`, and Codex `inProgress`, since a fresh child cannot be running a turn another child started. The daemon binds a turn a reconcile read as running only on a thread its own child already held loaded. A lost turn settles through the family's own terminal path (Codex `withTerminal`, Copilot's terminal branch) as `interrupted`, reason "turn lost: its agent process ended", which clears `pendingInterrupt` and marks a stop still `requested` for that turn `accepted`; the agent goes `idle`. A Codex reconcile that finds the turn settled is not lost, since its terminal follows.
  - **A retired generation ends its turns:** before a daemon retires a generation (child exit, poison, or the watchdog's release), it publishes an `interrupted` terminal under that generation's fence for every turn bound to it. The newer-generation clause above is the backstop.
  - **A reconcile that reaches its target answers:** Copilot answers a session it cannot resume with `active: false` instead of refusing, as Codex answers an unreadable thread. Only a target the daemon cannot open refuses.
  - **Stale agents are asked again:** every `recovering` agent, and every `working` agent whose fence names a daemon instance other than the live one, is asked on every hello and on the persist tick, at most once per `RECONCILE_GUARD_MS` since its last ask whether answered or refused. That pacing is its own per-agent time, since a refusal deletes the relay's guard.
  - **Tests:**
    - A session agent's turn lost to a daemon restart settles `interrupted` and `codexCollectAgent` answers.
    - A stop accepted before a daemon restart leaves the agent `idle` with no `pendingInterrupt` once its turn is lost, and a message then goes through.
    - A `working` agent whose reconcile the new daemon refused at hello is asked again once its target opens, and its turn settles.
    - A child that exits mid-turn settles every turn it held `interrupted`.
    - A Copilot agent whose session the target no longer holds settles its turn and goes `idle`.
    - A start, a message and a stop dispatched under a dead daemon are abandoned at register, never on a timer.
    - A start, a message and a stop whose frame or refusal is lost to a same-daemon reconnect are sent again once and taken once.

## Phase 2 - Engine with Codex and Copilot steps, and the indicator ✅

### Bug Classes

- **Mechanism:** the script scanner in `script.ts`. **Defect class:** a hand lexer guessing whether `/` starts a regex or a division, so valid JavaScript is scanned as holding an `import` or `export` and refused.
  - Lap 2 audit: regex bodies, escaped classes and template interpolation misread.
  - Lap 2 re-audit: `/` after a control statement's `)` or a block's `}` misread. Second patch in one mechanism. Resolved by removing the body scan: the scanner cuts only the meta statement (JSON, so no regex), and a QuickJS `compileOnly` compile of the exact wrapper refuses `import`, `export` and any other syntax error at start.

- **Run store:**
  - A `workflows/` directory, added to `DATA_DIR_ENTRIES` and scanned at boot. Each run is a small record snapshot (written then renamed) plus an append-only journal.
  - The journal append is a shared primitive beside `durable-store.ts`: one fsynced line per row, a row counting only once its trailing newline is written, a failed append truncating back to its starting offset. `checked-commit-residue` widens its pattern to append and file-descriptor writes under `src/gateway`, with that primitive the only allowed caller.
  - The record holds the owner session, the start's operation id, the `resumeFrom` source, pinned script text, args, default backend, declared phases, status, result, failure reason and `notified`. Skill text is stored once per run, keyed by sha256. The journal never holds a status.
  - A terminal transition writes status, result and reason in one record write, landing before any stop; a transition whose write failed sends no stop.
  - Issue rows buffer during a slice and commit after the drain, before any dispatch, since replay re-derives them. Turn rows land before their dispatch, settle rows before the VM sees them.
  - Restore drops a final line without a newline and truncates to the last newline, safe since every row lands before its effect. Any other unparseable line moves the file aside, never rebuilt empty. Boot replays exactly the runs whose record says `running`.
  - The sweep, a persist-tick step, abandons any op still `requested` on the run's agents, retires every agent tagged with it (retrying a refused one next tick), and unlinks the run by settle time, a moved-aside file by mtime.
- **One door:**
  - Every door body is synchronous: VM drains, journal commits and seam calls. Waiting is journaled state, picked up by a fresh entry on the host's register (after its id is stored), a catalog frame, a host-op reply, `onAgentChange`, or the persist tick. `agent()` journals inside the entry that drains the VM and never re-enters the door. With no body awaiting, no lane is needed.
  - The engine's `onAgentChange` listener catches its own throws, since the relay calls listeners after acknowledging the frame and a throw would lose the wake and skip other listeners. A run whose last commit failed is entered again by the persist tick.
  - `transition` checks a table: `running` goes to `succeeded`, `failed` or `cancelled`, and terminal states have no exits. A dispatch checks `running` in the same section that commits its row; a settle on a terminal run is dropped.
  - `workflowStart`'s dedupe lookup (by the start's operation id, over restored records), the 4-run cap and the new run's commit are one synchronous section. `workflows.start()` returns early if already admitting, since activation can run twice.
- **Journal and replay:**
  - Each `agent()` row holds an `issueOrdinal` assigned in the VM at the call, a `settleOrdinal`, and a `callHash` over prompt, resolved backend, model, effort, tier, schema, skill paths and thread key (not skill text, `label` or `phase`). Editing a skill file does not break a prefix; the guidance says to change the path or prompt to rerun.
  - A settle row records an answer or a failure with its reason.
  - Answers reach the VM one at a time per run, each journaled before the VM sees it, then pending jobs drain.
  - Replay releases answers in `settleOrdinal` order, draining after each, and checks every issued call's hash against its row. A mismatch on a pinned script fails the run, naming the call. Restart replay releases failure rows as usual.
- **`resumeFrom`:**
  - Names a terminal run of the same session. The walk releases the old rows by `settleOrdinal` and stops at the first hash mismatch, at the first failure row (so a fixed cause reruns), or when after a drain the next settle names a call not yet issued. Nothing dispatches until the walk ends.
  - The released answers, the turn rows of released calls and the thread map are copied into the new run's journal, so the old run's sweep cannot strand it.
  - A thread agent is adopted only when idle and its last journaled turn belongs to a released call; otherwise the thread starts fresh. The `runId` re-tag lands in one catalog commit before the journal copy and the record. A second resume of the same run finds the agent taken and starts fresh. At boot, a thread-map entry whose agent carries another `runId` counts as absent.
- **Call lifecycle:** one table every other bullet points to. The agent layer guarantees every turn and every op ends (see Agent layer), so the engine only waits for terminal states.

  | Call state | Exit |
  |---|---|
  | issued | Option names, thread rules, schema compile and caps checked; rejects at the call or waits. |
  | waiting | For a slot, the thread's agent to be `idle`, a live host (socket, register id and, for a step opening an agent in a container, the host's catalog naming it), or a `readSkill` reply. Entered again on settle, register, catalog frame, host-op reply or persist tick. |
  | skills | `readSkill` sent. A typed refusal (missing, non-regular, non-UTF-8) or prompt plus skills over the cap settles as a failure. Offline or `disconnected` goes back to waiting and resends at the next catalog frame; `timeout` or not taken resends on the next persist tick. |
  | journaled | Turn row fsynced with a fresh `ambient.newId()`, the exact prompt text and the live register id. |
  | committed | The seam committed the op and dispatched it. A dispatch answering false, or a seam call that throws, abandons any op left `requested` and settles a failure. A newest turn row whose op the catalog does not hold was never committed: the seam is called again with the same id (`beginStart` and `beginMessage` replay by id), a message waiting for its agent to be `idle`. |
  | accepted | The op's turnId is followed. |
  | settled | `completed` goes through validation; a failing answer opens a correction turn (back to journaled, new id, journaled prompt text and schema). `failed` or `interrupted` (a lost turn included, with its reason) settles as a failure. |
  | retried | The call's newest turn row governs. Its op `indeterminate` while the op's stamp names a register id other than the live one means the agent layer abandoned it when the daemon changed: journal a new turn row (fresh id, live register id, same prompt), then dispatch; a message waits for its agent to be `idle`. The same op under the live register id is the daemon's refusal and settles as a failure. An `indeterminate` op on a superseded row is never a settle. |

  | Run agent state | Exit |
  |---|---|
  | `idle` | Takes the thread's next call. Retires once its answer is journaled (non-thread), or at the terminal transition or sweep (thread) unless adopted. On a terminal run, a non-thread agent retires on the first `onAgentChange` showing it `idle`, since its answer is never journaled. |
  | `creating` | Waits; the agent layer always moves it on. |
  | `working` | A terminal run's pending stop: at most one per host socket, sent at the register or on the first `onAgentChange` showing it stoppable. A refused, failed or undispatched stop waits for the next socket. |
  | `recovering` | Waits; the agent layer always moves it on. |
  | `unavailable` | No turn. Retire accepts it. A thread whose agent is `unavailable`, missing from the catalog, or taken when a resume would adopt it opens a fresh agent with the thread's journaled skills, the switch journaled as a thread-map row. |

- **Dispatch seam:**
  - Per-family `start`, `message`, `stop`, `observe` and `abandon` taking a `SessionRecord`, extracted from the routes and the `begin*` methods (which take a `Request` today), exported from `composeAgents`. The routes call them after resolving the owner and keep their own `settle`.
  - The host registry keeps the register frame's `daemonInstanceId` on the host socket and drops it with the socket, and the catalog frame's containers beside it. Liveness is one value: the socket, that id, and the catalog entry for a container start or skill read. `start`, `message` and `stop` refuse to commit without it, and stamp each op with the register id.
  - `start` and `message` commit and dispatch only; they neither wait nor abandon on their own. `observe` hands over the daemon's refusal reason while it is still held. The engine looks the owner up with `getByTeam` on every call, since catalogs are keyed by the record object.
- **Step agents:**
  - An optional `runId` on `CodexPersistedAgentSchema`, `CopilotPersistedAgentSchema` and `RosterAgent`. `agentRoster`, the baseline's `runningAgents` and the list projections skip run agents, so `createAgentWatch` sends no per-step notices. The session's message and stop tools refuse a run agent and name `workflowStop`.
  - Retire is its own CAS method on `AgentCatalogPersistence`, accepting any agent with no `inProgress` turn and no `requested` op, `unavailable` included.
- **Boot and register:** boot only reads: the catalog (before subscribing to `onAgentChange`, as `waitFor` does), the journals, the derived pending stops and the orphans (run agents whose `runId` names no restored run). Nothing is sent at activation, since no host socket exists yet. Each register, after the agent layer's own register pass, sends the pending stops, stops and retires the orphans, and applies the `retried` row. Each catalog frame resends waiting skill reads and dispatches waiting calls.
- **Skills:** a closed `readSkill` host op taking `{target, path}`: a confined read on the host, `docker exec` with the launcher's user and workdir in a container, `~` against the target's home, per-file cap. The Gateway composes the prompt in one function, each skill between fixed markers naming its path, in order, then the prompt; replay uses the journaled text. A thread's skills go on its first call, and again to any fresh agent opened partway through it.
- **Sandbox:**
  - `quickjs-emscripten-core` with the `@jitl/quickjs-wasmfile-release-sync` variant, exact-pinned under the 7-day rule. The WASM compiles once and each run gets its own module through `newVariant`, so one run's abort or memory growth touches no other; confirm that against the installed package when pinning.
  - Host functions are `agent`, `log` and `phase` only. `agent` validates options and compiles the schema synchronously, journals the call and returns a deferred promise. `parallel` and `pipeline` are an in-VM prelude with Workflow's semantics, a thrown thunk becoming `null`.
  - Script shape: `export const meta = <literal>` must be the first statement, cut out by a small scanner that tracks strings, comments, template literals and bracket depth (a typed error otherwise), and evaluated alone with no host functions. Every other `import` or `export` is refused at start by a QuickJS `compileOnly` compile of the exact wrapper the body runs in, never by scanning the body. The rest runs as an async IIFE, with `args` a frozen JSON global.
  - Budgets: the interrupt handler sets a flag outside the VM; the engine drains with a bounded `maxJobs`, checks the flag and memory use after each batch, and fails the run when either trips, whatever the script did with the error. A short wall guard reading `ambient.now` applies to live slices only; replay applies instructions, memory and stack, since each replayed slice already passed live. Fixed `setMemoryLimit` and `setMaxStackSize`.
  - Terminal and close paths dispose every outstanding deferred, then the context, then the runtime, inside a catch.
  - The prelude lives in its own file with an `ambient-residue` allowlist entry naming why.
  - `vm.ts` owns QuickJS handles, budgets and disposal. The engine supplies script, args and host callbacks. `callOptions.ts` validates backend options, joins thread settings and fingerprints replay calls.
- **Session lifecycle:** `workflows.forgetSession(team)` runs synchronously at the top of `dropSessionResume`, before `presence.forget`, covering console and routine forgets. `sessionReserved` asks the engine, so the persistence sweep never takes a session holding a running run. The engine has no handler in the session-ended fan-outs, since close fires them and close does not cancel.
- **Baseline:** an optional running-runs entry (run id, current phase, steps running) in `session-baseline.ts` beside `openRuns`, read from the run store, so a compacted session knows its run is still going.
- **Gateway close:** `workflows.stop()` beside `routines.stop()`: close admission, unsubscribe every listener and host-op continuation, stop dispatching, flush, dispose the VMs, leave agents running. Every entry checks a stopped flag first, since close never closes the host socket and frames keep arriving; settles that land after close are recovered from the catalog at boot. Replay arms in `onActivate`.
- **Indicator:** `PresenceTracker.snapshot()` overlays `workflow` as the derived value or a running run, and marks dirty on start and settle; no schema or `Protocol.kt` change. `cometFor` checks `workflow` before its busy gate, excluding ended and available words, covered by a JVM test. The Gateway deploys first; an older phone shows no comet.
- **Surface:** the tools, capability, guidance and notice from Defaults. `backend: "claude"` is refused until Phase 3.
- **Gates:**
  - `ajv` exact-pinned at 8.20.0, the version the lock already resolves under the SDK, so no nested copy appears. Schemas compile with `strict: false`, so a 2020-12 `$schema` or an unknown keyword does not throw.
  - `check:boot` runs one script through the real sandbox under Bun, including an interrupted runaway loop and a refused memory overrun.
  - A fake Copilot daemon joins the harness beside the Codex one.
  - Tests: a 3-step run gives exactly one notice; a forced replay of a `parallel` script reattaches every answer to its own call; a daemon restart mid-step retries a start and a thread message once each under the new instance, never twice under the same one; the VM's global names match a fixed list; a stalled script fails; a torn journal tail restores to its last full row.
  - The `AGENTS.md` map lines and `docs/workflows.md` land here.

## Phase 3 - claude -p steps ✅

### Bug Classes

- **Mechanism:** cancelling a `claude -p` turn (dispatcher cancel set, daemon runner, container kill). **Defect class:** a cancel is counted as done while the run may still be alive, so a cancelled workflow keeps a full-access agent running.
  - Round 1: the cancel set came from in-memory "accepted" state, so a lost accept reply or a lost cancel was never retried; the container cancel killed only the `docker exec` client. Fixed by reading the set from the journal, retrying until the daemon answers, and a pidfile wrapper that signals the group inside the container.
  - Round 2: an active container cancel answered before the in-container kill did; the orphan check matched the session id a resumed thread reuses. Fixed by awaiting the kill's three-way answer and tagging each run's environment with its turn id.
  - Round 3: a host pidfile write could fail silently; an unanswered KILL after a TERM was never retried. Fixed by stopping a run that cannot be recorded and re-asking a failed KILL.
  - Round 4: the container wrapper's pidfile write could fail the same way (a full or read-only `/tmp`). Fixed by the wrapper killing its run's group and exiting 97, which the runner reports as a failed step.
  - Round 5 (red team): killing the `docker exec` client settled the turn, and the KILL retry was tied to the turn, so a failed in-container KILL was never retried; a turn a daemon restart interrupted got no cancel while its run kept going; a missing container pidfile read as `absent`. Fixed by the design change below.
  - Round 6 (re-audit of round 5): the daemon answered `cancelled: true` on enrolling a debt, so the Gateway stopped asking before any signal landed and a debt the daemon later gave up was never asked again; a hung kill exec stalled its debt; a half-written pidfile and a failed `kill` both read as `absent`. Fixed in the shape below, not by another patch.
  - The shape now, a design change rather than a patch: cancel debt is owned apart from the turn and the run, and the answer carries the outcome. The daemon's kill ledger (`claudeRunner.ts`) answers `cancelled: true` only once the run is confirmed gone (KILL signaled, `absent`, or no pidfile past a six-try startup window) and remembers that; until then it answers `false`. Each kill exec is bounded at 10 s; 60 failures drop the debt unconfirmed, so the next ask enrolls a new one. The pidfile is written by rename, and the kill script answers 3 for gone, 4 for no pidfile, 5 for a failed signal. The Gateway (`claudeSteps.ts`) asks on every tick and registration until a daemon instance confirms. It cancels the latest Claude turn of an unsettled or interrupted issue when its run is terminal or its registered daemon id differs from the current instance. Every path that could leave a run unrecorded still stops it.

- **Runner:** a short-lived `spawnOnce(target, argv, env)` in the daemon, reusing `scrubChildEnv`, the `docker exec` argument builder and the stderr classifier. `bypassPermissions`, `--safe-mode`, `--disable-slash-commands`, `--append-system-prompt`, `--model`, `--effort`, `--json-schema`, `--output-format json`, the prompt over stdin.
- **Isolation:** `--safe-mode` disables CLAUDE.md, plugins, hooks, MCP servers, custom commands and agents, and `--disable-slash-commands` drops the bundled skills, while auth and built-in tools work.
- **Project instructions (Q11):** the step's project `AGENTS.md`, else `CLAUDE.md`, read where the step runs through the skills host read, stored once per run by sha256 like skill text, and passed with `--append-system-prompt` on every turn, resumes included. A missing file appends nothing. Replay uses the journaled text.
- **Isolation test:** in a fixture project whose settings enable a plugin and a hook, with canaries in `AGENTS.md` and `CLAUDE.md`: the init event's `skills` and `mcp_servers` are empty, no hook fires, and the step answers the `AGENTS.md` canary only.
- **Sessions:** the first turn pre-mints its id with `--session-id` from a journaled uuid; later turns `--resume` it from the same cwd. The runner reads `structured_output`, then `result`. `is_error`, a non-zero exit or "No conversation found" fails the turn. A rebuilt container loses the transcript, so its thread degrades to a fresh agent.
- **Restarts and cancel:** the turn is journaled `dispatched` before the send. The daemon holds each result in an outbox replayed on Gateway reconnect; a daemon restart interrupts the turn with a typed `interrupted` outcome, at most once. Cancel signals the process group (TERM, then KILL) through the daemon's kill ledger; a container turn is signaled inside the container through a pidfile, since a `docker exec` child outlives its client, and runs under a one-hour `timeout` as a backstop.
- **Availability:** `claude`'s presence counts toward the `workflow` declaration, appended after the `AGENT_BACKENDS` flatMap in `daemonCapabilityDeclaration`. An absent `claude` is a dispatch-time step failure.
- **Decided at implementation:**
  - The turn's result is a daemon frame (`claude_turn_result`, acked by `claude_turn_ack`), not the `claudeRun` host-op reply, which answers only `accepted`, `busy`, `binaryMissing` or `badTarget`. A turn outlives the host-op wait.
  - A claude turn row carries `operationId: null` and a required `registerInstanceId`, `agentId` (the claude session uuid) and `target`. On a register naming a new daemon instance, every claude turn still open under the old one settles `interrupted` with reason "runner lost: the host daemon restarted", once.
  - A `sessionMissing` result (a rebuilt container, "No conversation found") degrades the thread: a fresh session uuid with the thread's journaled skills, the switch journaled as a thread-map row, at most once per call.
  - At most 8 claude turns run per daemon; a ninth answers `busy` and the call waits for the tick.
  - The project instructions are read through `readSkill` as `AGENTS.md`, else `CLAUDE.md`, at the target's base, journaled as `skill_text`, and appended on every turn.
  - The Gateway acks a result only after its settle row lands; duplicate settled results and results for terminal runs are acked without another settle.
  - The Gateway stamps a new turn after awaited project-instruction reads, using the live register id.
  - Cancels are read from the journal: the latest Claude turn of each issue with no settle or an interrupted one, in a terminal run or under a daemon that is no longer live. Each is asked every tick and on registration until a daemon instance confirms the run gone. Gateway close cancels nothing.
  - A container run starts under a `setsid` wrapper that writes its process group to a pidfile inside the container; a cancel signals that group there, since killing the `docker exec` client leaves it running. A host run writes a pidfile too, for a restarted daemon. A signal goes only to a process whose environment carries `SWITCHBOARD_CLAUDE_TURN` for that turn. The daemon answers an error when a container run could not be signaled, so the Gateway asks again.
  - Turn ids use a bounded filename-safe form; cancel carries the execution target.
  - A host or container run whose pidfile cannot be written is stopped at once and fails its step (the container wrapper exits 97), so every accepted run can be cancelled after a daemon restart. Both pidfiles are written by rename. Retries live in the kill ledger described under Bug Classes.
  - A thread mapping rides on its settle row, so a crash cannot keep the outcome and lose the mapping; only a mid-step session switch writes a standalone thread-map row. `threadMapsOf` reads both shapes, so older journals replay.
  - Claude answers go through the same outcome reading as Codex and Copilot (`answerOutcome`, `failureOutcome`): a decline, a rejected option and a refusal read alike on every backend. A refused host op or a missing CLI settles `unavailable` or `failed` rather than waiting.
  - The dispatcher is split by concern: `agentDispatch.ts`, `claudeSteps.ts`, `dispatchPrompt.ts`, `dispatchCore.ts`, `agentViews.ts`, `agentFamilies.ts`, `terminalAgents.ts`.
  - `resumeFrom` copies a claude call's journaled `AGENTS.md` or `CLAUDE.md` row with its skills, so an adopted thread resumes with the same instructions appended.
  - The isolation test uses stream-json to inspect the init event; production keeps json output. It makes a model call on the owner's login, so it runs only with `SWITCHBOARD_CLAUDE_LIVE=1`; it passed live once (`AGENTS.md` canary, no skills or MCP servers, no hook).

## Follow-up after Phase 2 - Copilot compaction status (Q15) ✅

- **Source:** Copilot writes `session.compaction_start` and `session.compaction_complete` to `~/.copilot/session-state/<copilot-session-id>/events.jsonl`. The pane cannot show a whole compaction: Copilot prints `● Compacting conversation history...` as a transcript line that scrolls off in about 15 s while the background compaction runs over a minute (seen on Testing: 90 frames, our `isCompacting` matched none).
- **Session id:** the Gateway already mints a Copilot session's id (`copilotSessionId` on the session record, passed as `--session-id` at launch), so `presence_watch` entries carry it and no hook is needed.
- **Daemon:** follows that events file for each Copilot session and sets `DerivedPresenceSchema.compacting` from start to complete, through the same derived-presence road the pane reader feeds, so the phone's existing compacting dock shows it with no phone change.
- **Tests:** a start event sets compacting and a complete clears it; a session with no recorded id falls back to the pane reader.

## Question 16 - What does a 10-minute checkup say?

Q: Counts since the last check plus the newest note, counts only, or notes only?
A: Counts since the last check, plus the newest note. "Since last check: 30 model turns, 14 tool calls (9 shell, 4 edits, 1 read), 3 files changed. Latest: <newest note>." The Gateway keeps running counters per turn from the event stream (Copilot tool starts and turn boundaries, Codex command, file-change and turn items), never from the capped notes, and resets the window at each notice. A workflow run's checkup sums its steps and adds steps settled and failed. Agent turns get the same line.

Recommended because counts show it is moving and the note shows on what; high counts with the same note across checkups is the looping signal. The notes are native model narration (Codex `commentary`-phase agent messages, Copilot intermediate assistant messages); only Copilot's `tool: command` lines are formatted by Switchboard.

> "A. But I want to know first if "I'm rerunning the full suite" is a native status feature, or something we jammed on"

## Question 15 - How does Switchboard see a Copilot compaction?

Q: Read Copilot's own events file, or teach the pane reader Copilot's line?
A: Read the events file; recorded under "Follow-up after Phase 2".

> "ok read that."

## Phase 4 - One set of agent tools (Q14)

- **Tools:** `agentStart`, `agentMessage`, `agentCollect`, `agentStop`, `agentList` replace `codexStartAgent`, `codexMessageAgent`, `codexCollectAgent`, `codexStopAgent`, `codexListAgents` and their `copilot*` twins. One registrar replaces `registerCodexTools` and `registerCopilotTools`.
  - `agentStart` takes `prompt`, `backend` (only the backends this session has enabled; `claude` stays workflow-only), `model`, `effort`, `tier`, `schema` (renamed from `outputSchema`) and `cwd`, checked per backend by mapping onto each family's strict start schema, the same rule the workflow's `agent()` uses. One option set for both, so a session call and a script call read alike.
  - `agentMessage`, `agentCollect` and `agentStop` take an `agentId` and route by its `codex_` or `copilot_` prefix; `agentMessage` takes `tier` and `schema` per turn. `agentList` lists both families, filtered by `backend` if given.
  - Descriptions stay under `guardTools`' 1024 characters; model lists and backend notes move into the capability guidance.
- **Capabilities:** `codex-agent` and `copilot-agent` stay as the per-backend switches, and the tools register when either is on. The guidance merges into one `agents` section naming which backends are on.
- **Everything that names the old tools, updated in the same release:** completion notices (`agent-notice.ts`), `codexAgentIdentity.ts`, `capabilities.ts` guidance, the assistant's tool scope and gate tests, `agents/codex.md` (becomes a backend-neutral agent driver), `docs/agents.md`, `AGENTS.md`, and the tool-description budget test.
- **nyaaskills repo (`~/projects/nyaaskills`):** replace every old name in `skills/architecture`, `skills/security`, `skills/testability`, `skills/quality`, `skills/compliance`, `cycles/audited-implementation.md` and `cycles/plan-refinement.md`, with "relay to Luna via `codexStartAgent`" becoming `agentStart` with `backend: "codex"`. Committed and released in that repo's own build flow, landed together with the Switchboard plugin release so no session sees a name that is gone.
- **Clean break:** no aliases. Deploy order: the Switchboard plugin release and the nyaaskills release together; the Gateway routes (`/codex`, `/copilot`) stay as they are, since only the MCP surface is renamed.

## Painpoints

- **The fake daemon drifted from the real one:** `src/testing/fakeHost.ts` registered without a `daemonInstanceId` and sent its catalog before hello, unlike `src/mcp/devcontainer/hostDaemon.ts`. Every harness test passed against an order production never uses, so a frame-order bug was invisible to the gates. Nothing pins the fake's frame order to the daemon's; a shared frame-sequence fixture both read would.
- **Two near-identical family stacks:** Codex and Copilot each carry their own reducers, applier, service, relay adapter and route (`src/gateway/codex*` and `copilot*`). Phase 1 moved the recovery decisions into `agent-recovery.ts`, but start, message and stop sequencing is still written twice; Phase 2's seam extraction is the place to finish it.
- **The family split reached the workflow dispatcher:** `src/gateway/workflows/agentDispatch.ts` repeats the Codex and Copilot branches for observe, start, message, stop, retire and retag. Phase 3 adds a third family; one typed adapter per backend with the wait, settle and retire logic outside is the shape, decided then.
- **The fake clock cannot jump:** `src/testing/fakeAmbient.ts` in manual drive rearms an interval against the real time its last firing observed, so one long `advance()` can skip a one-second tick. The workflow notice harness test had to step second by second, and a timer-sensitive test passing under a jump proves little.
- **No single place to shorten a stage's timing for the harness:** compressing the ten-minute workflow checkup needed a `workflowProgressIntervalMsForTests` threaded through `gatewayTypes.ts`, `composeGateway.ts`, `composeAwareness.ts`, `workflowAwareness.ts` and `federationHarness.ts`. A stage-level timing record the harness overrides once would replace that.
- **The engine ends a run from inside a host call:** `engine.ts:createWorkflowEngine:issueCall` calls `terminalize` on a restart mismatch while the script is still executing; `vm.ts` now defers the dispose until the guest unwinds, but the cleaner shape is a refusal the drive loop turns into the terminal transition.
- **Test fakes model the easy lifetime, so the cancel class passed its own tests:** the runner test's fake child never closed on `kill()`, while `docker exec` does, and the fake host answered every cancel `cancelled: true` at once. Both hid a failed KILL that was never retried, so round 5 shipped green. Fakes that stand in for a process should copy its exit and close behavior; one shared fake child for the runner tests would hold that rule in one place.
- **Dispatch tests re-implement the engine's journal write:** `src/__tests__/workflow-claude-dispatch.test.ts` `setup` writes settle and thread-map rows itself, so moving the mapping into the settle row broke a test that never touched the engine. A tiny journal writer shared by the engine and the fixture, or the journal view on the board, removes the second copy.
- **The cancel contract had no single definition:** what "the run is gone" means was spread over the kill script's exit codes, `containerKill`'s mapping, `hostOrphanKill` and `stepDebt`, and each round moved one of them. It is now written once under Bug Classes, but the code still spreads it across four places; a typed kill answer owned by the ledger is the shape if it moves again.
- **Cleanup agents delete what they do not recognize:** a comment pass removed the owner-requested FIXME on `engine.ts:createWorkflowEngine:appendSettle` as noise. A FIXME tracked on the board should name its board entry, so a sweep can tell it from pollution.
