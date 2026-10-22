# Questionaire

## Question 1 - Which board items ship before the release?

Q: Which open board items are done before the release?
A: Every open item is either done or closed with a reason. Triage is mine.

> address and close all new task items before releasing.

> sure. I cancel and delete anything not handled by release. so I leave it to you to triage

## Question 2 - Triage

Q: Which items need no code?
A: Three, closed before this plan.

- Baseline after compaction: shipped already.
- Skip a timed compaction: cancelled. No timed compaction exists.
- Routine runbook snapshot: kept as intended and documented in `docs/routines.md`.

The watcher follow-up "one registration per source" waits on a second source, so it is out of scope. Every other item is a phase below.

# Plan

Each phase names the board item it closes. Phases 3, 5 and 6 build on Phases 1, 4 and 5.

## Phase 1 - Keyed FIFO

✅ Shipped in 731b129f and 7f6b3c6a. Closes bd_76eab31a and the queue bullet of bd_500e13ed.

**Problem:** Eight sites each hand-write their own promise-tail FIFO. Two of them are wrong. In `AgentDaemonCore.enqueue`, a throwing `reject` or `describe` rejects the stored tail, so the next command for the same key skips `dispatch`. In tmux, `killSession` deletes the `sendChains` key while sends are still pending, so a later send can overtake them.

**Target:** new file `src/shared/keyed-fifo.ts`.
```ts
export interface KeyedFifo<K> {
  run<T>(key: K, work: () => T | PromiseLike<T>): Promise<T>;
  has(key: K): boolean;
  drain(): Promise<void>;
}
export function createKeyedFifo<K>(): KeyedFifo<K>;
export function createFifo(): Fifo; // one fixed key
```
- `run` returns the work's own value or error. Only the stored tail is recovered. Typed `Promise<T>`, so no call site casts.
- A key is dropped once its tail is still the current one. `has` reads that.
- `drain` settles the tails held at the moment it is called.

**Sites:**
- `createSourceLanes.queued`: the `items.delete`/`dispose` cleanup moves inside the work, and `stop` awaits `drain()`.
- `composeAssistant` `serial`: `stop` awaits `drain()` inside `withinMs`.
- `AgentRelayCore.serialize`: `run(...).catch(log)`.
- `tmuxCore.ts`: `serialized` is deleted; each send calls `sends.run`.
- `AgentDaemonCore.enqueue`: the rejection runs inside the queued work, so it lands before the agent's next command; a throwing adapter is logged.
- `ThreadLifecycle.run`: keyed by the `ThreadRecord` object, so a replacement record gets a new lane. `retire` reads `queues.has(record)`, and `pending` is deleted.
- `createRoutineRunner`: one `walks` FIFO; `runFresh` and `runNow` await it.
- `FileSecretStore` `saveDomain`, `mutateDomain`, `mutateSecret`. `pendingWrites` stays.

**Deleted:** `tails`, `tail`, `sections`, `sendChains`, `serialized`, `AgentDaemonCore.inflight`, `ThreadRecord.queue`, `ThreadRecord.pending`, routine `inFlight` and `queue`, `writeChain`, every recovery chain and identity-checked delete, and `killSession`'s key delete.

**Tests:** new `keyed-fifo.test.ts` covering:
- same-key order;
- cross-key overlap;
- a rejection returned to its caller while the next item still runs;
- `drain` waits only for what was already queued.

Targeted cases: tmux sends keep their order across a `killSession`; a throwing `reject` does not drop the next command; a failed `saveDomain` does not block the next write.

**Risks:** `drain` is a snapshot, so admission must be fenced before it. The existing fences do that: `phase`, `closed` and `admitting`. Whether `killSession` should queue behind pending sends is left unchanged. Add the new module to the AGENTS.md map.

## Phase 2 - Checked commit

✅ Shipped in cb86dc25. Closes bd_4eb7b09c. The hook's logger is guarded, so a landed write never throws.

**Problem:** Nine stores repeat the same set-save-rollback block, and three get it wrong:
- `createRoutineStore.commit` and `createPolicyStore.commit` call `onChanged` inside the save `try`. A throwing hook rolls memory back while the disk already holds the write.
- `DurableOutbox.commit` saves before it splices. On `DurableStoreInstalledError`, memory stays behind the file.
- `InboxClaims` mutates the held objects before `saveChecked`.

**Target:** in `durable-store.ts`.
```ts
export type CheckedCommit = { landed: true } | { landed: false; error: Error };
export function commitChecked<T>(
  store: Pick<DurableStore, "saveChecked">, next: T, apply: (next: T) => void,
  options?: { snapshot?: unknown; label?: string; onLanded?: () => void },
): CheckedCommit;
```
- It saves first, then calls `apply` once the save landed. `DurableStoreInstalledError` counts as landed.
- Memory changes only after a landed save, so no rollback branch is needed.
- `onLanded` runs after `apply`. If it throws, the error is logged and the commit still counts as landed.

**Sites:**
- `createWatcherStateStore.put`, `createRulesStore`, `createRunbookStore`, `createRoutineMemoryStore`, `createOccurrenceStore`, `createAttentionStore`.
- `createRoutineStore` and `createPolicyStore`, which pass their hook as `onLanded`.
- `createVaultDecisions`, checked branch only.
- `InboxClaims.claim`, `setOutcome` and `ack`: each builds a fresh `ClaimFile` and rethrows on failure.
- `DurableOutbox.commit`: rethrows on failure.

**Deleted:** every `previous` variable and rollback block. The three buried-set trims become `capFifo(buried, MAX_BURIED)`.

**Tests:**
- New `durable-commit.test.ts` covering failure, installed-error landing, and the order of `onLanded` and its errors.
- Adapter cases for `inbox-claims`, `durable-outbox`, and a throwing `onChanged` in `routine-store` and `policy-store`. Policy delete must still bury the id.
- First failure cases for `routine-memory` and `runbook-store`.
- A residue test that allows `saveChecked(` only inside `commitChecked` and the named snapshot writers.

**Risks:**
- A failed hook is now only logged. A policy prune skipped this way leaves grants. A fresh lookup refuses them, since `byKey` no longer answers the policy; a request already waiting re-checks the scope it captured and can still be covered, as it could before.
- Installed means directory sync was not confirmed. It does not mean the write survives a crash.

## Phase 3 - Plugin re-emit dedupe

✅ Shipped. Closes bd_64cdb09e. Beyond the plan: `MAX_PENDING_DELIVERIES` lives in `types.ts`, so the plugin imports no Gateway store; a non-string `delivery_id` is treated as absent; the inbox pump forwards only a known reply disposition (`isReplyDisposition`).

**Problem:** The plugin acks a `channel_push` only after `emitChannelNotification` resolves. If that ack is lost, `ChannelDeliveryCoordinator.drain` offers the row again on reconnect, and the plugin emits it into the session a second time. `ChannelPushPayload` has no `delivery_id`.

**Target:**
- Add `delivery_id?: string` to `ChannelPushPayload`.
- `channelPushPayload` in `channelDelivery.ts` returns `ChannelPushPayload` instead of `Record<string, unknown>`.
- New file `src/mcp/bridge/channelPushDelivery.ts`:
```ts
interface ChannelPushDeliveryDeps {
  emit: (push: ChannelPushPayload) => Promise<void>;
  ack: (deliveryId: string) => void;
  maxRemembered: number;
}
export function createChannelPushDelivery(deps: ChannelPushDeliveryDeps): (push: ChannelPushPayload) => Promise<void>;
```

**Behavior:**
- Repeats of one id run through Phase 1's `KeyedFifo<string>`, so a concurrent repeat waits for the first.
- An id already emitted is acked without emitting.
- A failed emit is neither remembered nor acked.
- The remembered set is capped with `capFifo` at `MAX_PENDING_DELIVERIES`.
- A push with no id emits and is not acked.

**Sites:** `connectToRouter` holds one process-lifetime handler. Its `ack` sends on the current `routerWs`. `channelNotify.ts`, the Gateway's event dedupe and the Gateway's ack path stay unchanged.

**Deleted:** the raw `msg.delivery_id` read and the inline `.then`/`.catch` block.

**Tests:** new `bridge-channel-delivery.test.ts`:
- For both a message and an event, the same id twice after a lost ack emits once and acks twice.
- A failed emit is retried on the repeat.
- Concurrent repeats emit once.

**Risks:** A restart clears the set, so delivery stays at-least-once. An id evicted past the cap can emit again. A reused delivery id would hide a distinct delivery.

## Phase 4 - Watcher labels

✅ Shipped. Closes the label bullet of bd_500e13ed.

**Problem:** `composeAssistant` keeps `LABELS` keyed by `GITHUB_WATCHER_ID`, and `labelOf` falls back to the raw id. A watcher added without editing that table shows its id in wakes, listings, the console and the baseline.

**Target:**
- Add `readonly label: string` to `Watcher`. `createGithubWatcher` sets `"GitHub notifications"`.
- `SourceLanesDeps.render` becomes `(watcher: Watcher, event: WatcherEvent) => string`, and `pushAll` takes the `Watcher`.
- `createSourceLanes` refuses a blank label next to its existing id check.

**Sites:** `watcher.ts`, `githubWatcher.ts`, `sourceLane.ts` (`render`, `pushAll`, `pollOnce`), and `composeAssistant.ts` (`render`, `listOne`, `watcherOf`, `baselineFor`).

**Deleted:** `LABELS` and `labelOf`.

**Tests:**
- `federation-harness-assistant.test.ts` asserts the supplied label in a wake and in a live listing.
- Add labels to the injected watcher fixtures in `assistant-session`, `assistant-source-lane` (including its `render` stub), `assistant-rules`, `assistant-actions` and the harness.

**Risks:** Injected watchers must now carry a label. Type-level only; no wire change, since `AssistantWatcher.label` already exists.

## Phase 5 - Inbox listing extraction

✅ Shipped. Closes the listing bullet of bd_500e13ed.

**Problem:** The page signing, the byte cut and the mark rule sit inside `composeAssistant` next to placement and owner ops. Only the harness reaches them.

**Target:** new file `src/gateway/assistant/inboxListing.ts`.
```ts
export interface InboxListingDeps {
  watchers: readonly Watcher[];
  state: Pick<WatcherStateStore, "get" | "put">;
  rulesFor: (watcherId: string) => AssistantWatcherRules;
  ambient: Pick<Ambient, "randomBytes">;
  livePage: <T>(watcherId: string, query: () => ListQuery, deadlineMs: number,
    settle: (page: ListPage) => T) => Promise<T>;
}
export function createInboxListing(deps: InboxListingDeps):
  { list(scope: InboxScope, page?: string): Promise<InboxList[]> };
```
- The module mints its own page key, so no caller holds it.

**Moves:** `PageAt`, `PageBodySchema`, `withinBytes`, `MAX_LIST_BYTES`, `signed`, `wrapPage`, `unwrapPage`, `listOne`, and the route's `list` body including its `"stale page; list again"` answer. `listOne` reads `watcher.label` from Phase 4.

**Sites:** `composeAssistant` keeps `livePage`, because it owns `lanes`, and passes `inbox.list` to `createAssistantRoutes`. Update AGENTS.md's listing bullet to name the new file.

**Deleted:** from `composeAssistant`, the `createHmac`/`timingSafeEqual` imports, `zod` if no longer used, and everything that moved.

**Tests:** The harness already pins live `new` reads, mark movement across pages, byte-cut continuation and edited-token refusal. Those stay as the pin, with no duplicate unit tests.

**Risks:** The token payload format and the rule that a cut page never moves the mark must move unchanged, or inbox events get skipped. The key stays process-local.

## Phase 6 - Local rate-limit hold

✅ Shipped. Closes the hold bullet of bd_500e13ed.

**Problem:** When `createGithubClient.request` holds a request itself before any fetch, it answers with the same `backoff` shape as GitHub's own 403/429. Three things go wrong:
- `GithubDone` records a thread it never sent as `rate_limited`.
- `list` throws `"GitHub rate limit"` without saying how long to wait.
- `githubWait` floors the poll's retry at 60s even when the hold ends sooner.

**Target:** in `githubClient.ts`.
```ts
export type GithubHold = { kind: "held"; retryMs: number; reason: string };
request(...): Promise<Response | GithubRefusal | GithubHold>;
export const holdText = (ms: number) => `GitHub rate limit; wait ${Math.ceil(ms / 1000)}s`;
```
- A hold answers `retryMs: Math.ceil(left)` and `reason: holdText(left)`.
- `isRefusal` narrows to `GithubRefusal | GithubHold`.

**Sites:**
- `GithubDone.refused`: `held` maps to `not_attempted`, with the reason as `stop`. A hold on the PATCH after a landed DELETE keeps `done` and stops with the unread note.
- `createGithubWatcher.poll`: maps `held` to a strict `backoff`, so `PollAnswerSchema` does not change.
- `createGithubWatcher.list`: throws the hold's reason. Phase 5's `listOne` returns it as `InboxList.error` without moving the mark.

**Deleted:** `waitText` in `githubDone.ts`. `holdText` replaces it.

**Tests:**
- `assistant-github-watcher.test.ts`: during a hold, the poll makes no fetch, answers a valid backoff for the remaining time, and a list surfaces the wait.
- `assistant-github-done.test.ts`: a hold set between `waitLeft()` and the DELETE records `not_attempted`; a hold on the PATCH keeps `done`.

**Risks:** If `held` is returned unmapped from `poll`, it fails strict parsing and lands in the generic malformed-answer backoff.

## Phase 7 - Assistant tool names from one table

✅ Shipped. Closes the tool-name bullet of bd_500e13ed. Beyond the plan: the `github_done` usage, its ids description, the inbox tool's next-page line and the action tools' unreachable message also name `inbox` through `ASSISTANT_COMMANDS`.

**Problem:**
- `ASSISTANT_SWITCHBOARD_TOOLS` adds `ASSISTANT_COMMANDS.inbox.tool` by hand, as a one-off entry.
- `ASSISTANT_INSTRUCTIONS` spells `channel_reply`, `notify_human`, `inbox`, `github_done` and `Glob` by hand.

A new command or a renamed tool leaves the assistant told to call something it does not have.

**Target:** in `assistant-session.ts`.
```ts
export const ASSISTANT_REPLY_TOOLS = { reply: "channel_reply",
  replyStructured: "channel_reply_structured",
  capabilities: "switchboard_capabilities", notify: "notify_human" } as const;
export const ASSISTANT_SWITCHBOARD_TOOLS: readonly string[] = [
  ...Object.values(ASSISTANT_REPLY_TOOLS),
  ...Object.values(ASSISTANT_COMMANDS).map(({ tool }) => tool),
  ...ASSISTANT_ACTION_KEYS,
];
export const ASSISTANT_BUILTIN_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "ToolSearch"] as const;
```
`ASSISTANT_INSTRUCTIONS` interpolates every tool name it mentions: `ASSISTANT_REPLY_TOOLS.reply`, `.notify`, `ASSISTANT_COMMANDS.inbox.tool`, `"github_done" satisfies AssistantActionKey` and `"Glob" satisfies (typeof ASSISTANT_BUILTIN_TOOLS)[number]`. A rename then fails to compile.

**Sites:** `assistant-session.ts` and `instructions.ts`.

**Deleted:** the one-off inbox entry and the hand-spelled names.

**Tests:** `assistant-tool-scope.test.ts` asserts that the instructions name every `ASSISTANT_COMMANDS` tool and every `ASSISTANT_ACTION_KEYS` entry, so an action added without being taught fails. `check:boot` already proves the scoped list.

**Risks:** The instructions are shipped prose. The rendered string must be byte-identical before and after.

## Phase 8 - One console answer wait for both runtimes

✅ Shipped. Closes the console-wait bullet of bd_500e13ed. Beyond the plan:
- `console-protocol.ts` also holds `CREATE_SESSION_BOUND_MS` and `SEND_BOUND_MS`, moved from `consoleTypes.ts`. `codegen-kotlin.ts` emits `CREATE_SESSION_BOUND_MS` and `MAX_HISTORY_COMMITS`, now exported from `schemasWorkspace.ts`, beside `CONSOLE_ANSWER_WAIT_MS`. `FacetHistoryRules` reads `Protocol.MAX_HISTORY_COMMITS`.
- `gateway-serve-limits.test.ts` checks the preview, send and create-session bounds against the answer wait. Send is a delivery op whose phone wait is built on the answer wait, so that check is the stricter one.
- `ChatRepositoryConstantsTest` asserts `PINNED_READ_TIMEOUT_MS` reads `Protocol.CONSOLE_ANSWER_WAIT_MS` and the spawn retry window clears `Protocol.CREATE_SESSION_BOUND_MS`. `pinnedReadTimeoutOutlastsGatewaysSendBound` is deleted, since it compared against a copied 25,000.
- Deleted: `consoleHandler.test.ts` (a stale copy of the retry window), the regex in `workspace-history.test.ts`, the dead held-poll constants and their tests, the gateway's unused `HOLD_CAP_MS`, and the dead Kotlin `BOARD_REFUSED_PREFIX` with the test scraping it.
- Added `cross-runtime-twin-residue.test.ts`. The board AAD vector tests in both runtimes build from the kind constants.
- The `waits.ts` header names `gateway-serve-limits.test.ts`, the fix Phase 9 listed.

**Problem:** `CONSOLE_ANSWER_WAIT_MS` and `WORKSPACE_HOP_MARGIN_MS` live in `workspace-op.ts`, but the assistant preview reads both. The phone's `ConsoleHttp.PINNED_READ_TIMEOUT_MS` is a second literal, kept equal only by a regex in `workspace-bounds.test.ts`.

**Target:**
- Move both constants to `console-protocol.ts`. The margin becomes `CONSOLE_HOP_MARGIN_MS`.
- `codegen-kotlin.ts` emits `const val CONSOLE_ANSWER_WAIT_MS: Long = 35000L` next to `CONSOLE_PROTOCOL_VERSION` in `object Protocol`.
- `ConsoleHttp.PINNED_READ_TIMEOUT_MS = Protocol.CONSOLE_ANSWER_WAIT_MS`.

**Sites:**
- `console-protocol.ts`; `workspace-op.ts` (`WORKSPACE_BOUNDS.save`); `codegen-kotlin.ts`.
- `Protocol.kt`, regenerated in the same commit; `ConsoleHttp.kt`.
- The `preview` comment in `waits.ts`.
- `workspace-bounds.test.ts` and `gateway-serve-limits.test.ts`.
- AGENTS.md's `WORKSPACE_BOUNDS` bullet.

**Deleted:** both exports from `workspace-op.ts`, the Kotlin literal, and the regex test `"starts from the phone's own read timeout"`.

**Tests:**
- `workspace-bounds.test.ts` keeps its nesting checks against the moved constants.
- `./scripts/kotlin-gate.sh` diffs `Protocol.kt`, which replaces the regex pin.
- `ChatRepositoryConstantsTest.pinnedReadTimeoutOutlastsGatewaysSendBound` keeps its ordering check.

**Risks:** The value stays 35,000. `lint` and `test` both pass with a stale `Protocol.kt`, so the Kotlin gate runs before the push.

### Bug Classes

**Mechanism:** cross-runtime ordering tests, `ChatRepositoryConstantsTest` and `src/__tests__`, each restating the other runtime's value as a literal or a regex read.
**Class:** a TS value kept equal to a Kotlin value by hand.
- Round 1: the console answer wait, the history cap, and the send-bound Kotlin test.
- Round 2: the create-session bound, copied in both runtimes; the TS copy (30,000) no longer matched the phone (40,000). The hold-cap test guarded dead phone constants.

- Architecture: the dead `BOARD_REFUSED_PREFIX` Kotlin twin and the TS test scraping it.

The fix lands in one place: `codegen-kotlin.ts` emits the value into `Protocol`. `cross-runtime-twin-residue.test.ts` refuses a same-name Kotlin twin of a `src/shared` export, a Kotlin comment quoting a TS declaration, and a TS test capturing a Kotlin initializer. Its exemptions and bd_f68b03e2 hold the remaining instances.

## Phase 9 - Long waits past Bun's idle cut

✅ Shipped. Closes bd_19648cd9. Beyond the plan:
- Probes on Bun 1.4.0, the Gateway's version: the server's `idleTimeout` cuts a GET or a bodiless POST, not a POST whose body was read, and `server.timeout(req, 0)` does not carry to the next request on the socket. Bun's client fetch abandons an idle request at 300s. `node:http`, the askpass transport, has no client idle timeout.
- The table lives in `src/shared/gateway-long-waits.ts`, so the plugin reads it too. `/vault/capture` is long: a refresh plus a create.
- The plugin's `routerRequest` lifts Bun's fetch timeout for long routes, which is the half that holds today. It resends a long route after a failure only when the route replays by id (`/task-board`) or the connection was refused (`ConnectionRefused` in Bun, `ECONNREFUSED` in Node).
- `vaultClient.refresh` makes at most `VAULT_REFRESH_MAX_CALLS` Router calls; a second restart answers unavailable.
- `DEFAULT_WAKE_TIMEOUT_MS` and `POST_WAKE_SETTLE_MS` live in `wake.ts`. The test's wait table also pins the short routes with a Router-bound wait (assistant, agents, blob read, vault search) under the cut.
- Follow-ups on bd_dd8127ef: resend opt-in per route (`/respond` and `/poll` resend today), one route contract, a Bun-runtime gate, and pinning the image.

**Problem:** The Gateway serves with `idleTimeout: GATEWAY_IDLE_TIMEOUT_S` (255s), but five routes can hold a request longer. When Bun cuts the socket, the caller sees a dead connection.

| Route | Worst case |
|---|---|
| `POST /send` | `WAKE_TIMEOUT_MS` (600s by default) plus `POST_WAKE_SETTLE_MS` |
| `POST /task-board` | up to five 120s Router calls |
| `POST /vault/use`, `/vault/askpass` | about 470s |
| `POST /vault/collect` | about 350s |

The current test compares only `VAULT_ROUTE_WAIT_CAP_MS` and the assistant waits. The `waits.ts` comment names `assistant-waits.test.ts`, which does not exist.

**Target:** in `serveLimits.ts`.
```ts
type GatewayLongWaitRoute = "POST /send" | "POST /task-board"
  | "POST /vault/use" | "POST /vault/collect" | "POST /vault/askpass";
export const GATEWAY_LONG_WAIT_ROUTES: ReadonlySet<GatewayLongWaitRoute>;
export function isGatewayLongWaitRoute(method: string, pathname: string): boolean;
```
`serve()` in `index.ts` calls `server.timeout(req, 0)` for these routes before `graph.router(req)`. Every other request keeps 255s.

**Sites:**
- `serveLimits.ts`.
- `index.ts`, which also exports `DEFAULT_WAKE_TIMEOUT_MS`.
- `routerClient.ts` exports `TOOL_CALL_TIMEOUT_MS`; `boardClient.ts` exports its default attempts.
- The `waits.ts` comment.

**Deleted:** the `longestRoute < idleTimeout` assertion.

**Tests:** in `gateway-serve-limits.test.ts`:
- Build each POST route's bound from the exported constants, and assert a route is in the set exactly when its bound reaches the cap.
- Read the path literals in `httpRouter.ts` and the loopback route maps, and fail on any path the table does not classify.
- Pin that `server.timeout(req, 0)` is called behind `isGatewayLongWaitRoute`.
- Keep the assistant order assertions.

**Risks:**
- No gate runs under Bun's real cut, so the source read is the only pin. Probe the opt-out once under Bun.
- Check the caller side: if Bun's client `fetch` (in `routerRequest` and in askpass) also cuts near 300s, the opt-out only moves the failure, and `routerPost`'s four retries could resend a `/send`.
- The opt-out sets no new deadline. Each route's own bound remains the deadline.

## Phase 10 - Graph-level closing phase

✅ Shipped. Closes bd_f506f915. Beyond the plan:
- The fence also covers `FederationContext.activate`, enrollment (503), the Router client's reconnects, registration retries and the side effects of a `gateway_register` result. The Router filter sits in `routerClient` and lets `tool_result` and `tool_error` through, so calls in flight settle.
- The pump drains early and stops last: frames stop arriving at the fence, while a session's delivery ack during the stage drains still reaches the Router. The pump stops just before the Router client.
- Every close step runs even after one throws; the first error is the result.
- The routine runner's final latch is gone. The assistant keeps `ownerOpsClosed` for owner ops already dispatched when the fence rises.
- The vault harness test posted through a session bound to the pre-restart graph; the fence's 503 exposed it.
- Follow-ups on bd_f80fc673: messages on open sockets, admitted HTTP and Router work, the assistant's 5s stop cutoff, connector upgrades, stray retry timers.

**Problem:** `composeListener.close` stops the routine and assistant stages, flushes, and only then stops enrollment and the federation client. An activation landing in that wait runs `onActivate`, which starts the stages again. The routine runner and the watcher runner each carry a final stop as a patch for this. HTTP intake, WS intake and Router frames keep arriving during the drain, and the inbox delivery pump has no stop or drain.

**Target:** one closing phase owned by `composeGateway`.
- `close` enters it first. From then `onActivate` starts nothing, `serve` answers 503, a new socket closes at open, and Router frames are dropped before dispatch.
- Then stop intake sources (enrollment, the Router client, the delivery pump), drain the stages, flush, and dispose timers.
- A second `close` joins the first.

**Sites:** `composeGateway.ts` (`onActivate`), `composeListener.ts` (`close`, the HTTP router), `composeWebSockets.ts` (open), `composeRouterFrames.ts` (frame dispatch), the inbox delivery pump, and `index.ts` if the 503 lives in `serve`.

**Deleted:** the final-stop patches in the routine runner and the watcher runner, once the graph fence covers both. Keep either if research shows another caller needs it.

**Tests:**
- A harness case: an activation landing while `close` waits starts no stage.
- Intake during close: HTTP answers 503, a socket open is refused, a Router frame is not dispatched.
- The pump stops and drains.

**Risks:** The flush must still see live writers, so the fence refuses new work without stopping the writers it flushes. Research the Router client's reconnect and the pump before cutting the order.

## Phase 11 - Single flight and presence peeks

✅ Shipped. From the Phase 1 architecture round; bd_4d5b9b08. Beyond the plan:
- A presence watch's token renews only when its target or cadence changes, since the host daemon sends fresh entries on every update. The in-flight guard is keyed by that token, so a team stopped and re-added mid-peek ticks at once.
- `withPeekSlot` is unchanged, so its brief seventh capture stands.

**Problem:**
- `PresenceScheduler.tick` can observe one capture twice. `runPeek` hands a joiner and any caller within 300ms of the last capture the same result object, and stamps `lastCapture.at` when a capture completes. At the 500ms cadence a peek slower than about 200ms serves its frame to the next tick, and overlapping ticks join one capture. Either way one flicker confirms a flip.
- Six sites hand-write "join the call already in flight for this key": `createOpDedupe`'s flight half, `WakeService.tryWakeTeam`, `runPeek`, `runDeduped`, `AgentDaemonCore.acquireSession`, and the vault tools' `collect`. `runDeduped` is `createOpDedupe` with a 60s hold.

**Target:**
- Presence: a tick skips a result it already observed for that team (identity), skips while its own peek is in flight, and a completion after `stopWatching` or a replaced watch lands nothing.
- New `src/shared/single-flight.ts`: `createSingleFlight<K, T>().run(key, work)`, the in-flight half of `createOpDedupe`, which `createOpDedupe` then uses.
- `runDeduped` becomes `createOpDedupe` with a 60s hold.

**Sites:** `presenceScheduler.ts`, `hostOpRunner.ts`, `op-dedupe.ts`, `wakeService.ts` (`tryWakeTeam`; presence start and end move inside the work), `agentDaemonCore.ts` (`acquireSession`), the vault tools' `collect`. `joinCreate` stays: its release outlives the launch. `hostDaemon.inflightWakes` stays: it suppresses, not joins.

**Tests:** a presence case where a cached and a joined result each count once; `single-flight.test.ts` for join, failure not held, and key release. Existing dedupe tests stay as the pin.

**Risks:** `withPeekSlot` can briefly run seven captures when a queued microtask takes a freed slot; fix with a permit handoff only if this phase touches it anyway.

## Phase 12 - Gateway trust files and the op store

✅ Shipped; bd_5e43c2eb. Beyond the plan:
- A key grant whose write failed acks `waking` without custody, so the Router redelivers and the next attempt installs. Before, the claim stayed and a redelivery skipped the install.
- The residue test counts the raw writes allowed per exempt file, not just the file.
- The agent catalog answers an installed but unconfirmed write as `unconfirmed`; its callers map it as they mapped the thrown error.

From the Phase 2 architecture round. Same class as Phase 2: memory moves before the write, or a write is not atomic, so a failure leaves the two disagreeing.

**Problem:**
- `CrossDomainPeers` mutates memory, then writes with plain `fs.writeFileSync`, not atomic. A failed `add` leaves a peer trusted in memory while `confirm` reports failure. A torn file parses as no peers, so every link is forgotten silently.
- `CrossDomainShareState.land` writes before memory, but plain and unguarded: a failed write in `onShareDelta` throws out of the socket listener instead of going unready.
- `ContentKeyStore.commit` fills memory before the write. A failed write then answers a redelivered grant `already_present`, and the key is gone after a restart.
- `Allowlist` adds admissions and the owner root in memory before the write.
- `DurableStoreInstalledError` is read by hand in `composeGateway` `saveSessions` and twice in `AgentCatalogStore`; `saveSessions` and `persistAgentCatalogChecked` are two copies of one write.
- `DurableOpStore.markComplete` saves best effort, yet `docs/runbooks.md` and AGENTS.md say a fire's key is released only once its completion is durable. A failed write and a restart fire the runbook again.
- `checked-commit-residue.test.ts` sees only `.saveChecked(`, so none of the above shows.

**Rule:** trust is granted only once written; trust is withdrawn at once. Additions and replacements go file first through `commitChecked`. Removals and revocations stay memory first, then write, so a failed write never leaves a revoked peer live in this process.

**Target:**
- `DurableStore` takes an optional `mode`, so the trust files can use it at 0600 and get atomic, fsynced writes with the installed reading.
- `CrossDomainPeers` and `CrossDomainShareState` move onto `DurableStore`. `add` goes through `commitChecked`; removals keep memory first. `CrossDomainShareState.apply` answers `"unwritten"` on a failed write, and `onShareDelta` goes unready and re-reads, as on a gap.
- `ContentKeyStore.commit` and `Allowlist` additions go file first; the static `writeFile`s map a directory sync failure to `DurableStoreInstalledError`.
- One `saveSessionsChecked` in `composeSessions`, used by the assistant placement and the agent catalog; `composeGateway` leaves the residue allowlist.
- `DurableOpStore.markComplete` answers whether the completion landed; `runbook_fire` keeps its key held when it did not.
- The residue test also refuses `writeFileSync(` and `writeFileAtomic(` under `src/gateway`, with a reason per exception (`identity.ts` exclusive create, `transport.ts` reach cache, `composeBootstrap.ts` sentinel, `bootstrapInstall.ts` staging, `enrollTls.ts`), and `instanceof DurableStoreInstalledError` outside `durable-store.ts`.

**Tests:** a failed peer add leaves no trust; a failed removal still revokes in memory; a failed share delta goes unready; a failed key commit holds no key; a failed op completion keeps the fire key held.

**Risks:** `CrossDomainPeers` and `CrossDomainShareState` keep their file names, so existing files load unchanged.

## Phase 13 - Router enrollment writes and the phone's board intent

From the Phase 2 architecture round. No board item.

**Problem:**
- `FileSecretStore.loadDomain` hands back its live object, and `EnrollmentCoordinator` changes it in place before queueing `save`. A revocation whose write failed is live in this process and gone after a restart. A retried `retire` or `admit` is a duplicate, skips the save, and `flushOrError` reads the old failed write, so the retry reports failure forever.
- `shareService.unlink` calls `dropLinkEdge` without awaiting it, and its success answer drops `durability_uncertain`.
- `OwnerStateStore.compact` installs the new manifest before it switches the journal; a directory sync failure there leaves later commits appended to the old journal, lost on restart.
- `BoardManager.mutate` drops `persist`'s answer, and `enqueueWrite` returns an op id even when nothing was queued, so `BoardOps.intend` reads on as if it were.

**Target:**
- Coordinator transitions go through `mutateDomain` on cloned state and publish only what was committed; `loadDomain` answers a copy.
- `unlink` awaits `dropLinkEdge` and passes its outcome on.
- `compact` enters an uncertain state that refuses writes until the manifest and journal agree, or is shown not worth it with evidence.
- `enqueueWrite` answers a refusal; `intend` surfaces it through the refusal list.

**Tests:** a failed revocation write is not live; a retried admit after a failed write lands; an unlink answer carries its outcome; a refused board intent is reported.

**Risks:** Router changes deploy before the Gateway; the phone change ships with the next phone build.

## Painpoints

- **A test keeps a dead Kotlin constant alive:** nothing on the phone reports an unused `const val`, and a cross-runtime test that names one counts as a use. `ChatRepository.LONG_POLL_HOLD_MS`, its held-read siblings in `ConsoleHttp`, and `ConsoleClientTypes.kt:BOARD_REFUSED_PREFIX` each outlived their last reader, guarded by tests on both runtimes, and only an audit found them. A Kotlin unused-symbol check (Lexicon's reference counts, or detekt's `UnusedPrivateMember` widened to internal) would surface the next one.
