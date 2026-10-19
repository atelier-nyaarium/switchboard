# Questionaire

## Question 1 - How does the assistant clear a GitHub item?

Q: What takes an item out of the assistant's view?
A: A mutating action that takes an array of ids and marks those entries done at the source.

> A mutating action that takes an array of IDs and marks those entries as done.

## Question 2 - What does a watcher remember for waking?

Q: What wake state does a watcher keep?
A: Only the newest entry time it has seen. An entry at or below it never wakes again.

> That means for the wake state, we only need to keep track of what minimum entry date/time was last seen. So we don't rewake on last seen

## Question 3 - Does the Gateway keep its own copy of GitHub items?

Q: GitHub as the only copy, or a Gateway mirror reconciled each poll?
A: GitHub is the only copy. Two reads: the wake poll asks only for threads updated since the newest time seen, and a full fetch lists every thread not done, read or unread, when the agent asks. Rules apply as either read lists. The watcher keeps the newest time seen and the last poll's open count.

Recommended because a mirror is a second copy to keep in sync, which is the desync this plan exists to remove.

> A.
>
> and to be clear, there's like the Wake queue that only fetches from `since` and a fetch all that shows all of them if the agent needs a full fetch right?

## Question 4 - Does new activity on a thread already woken for wake again?

Q: A woken thread gets new activity, so its update time passes the mark. Wake again?
A: Yes. New activity is a new alert, and the rules decide again, as GitHub puts the thread back in its inbox.

Recommended because the alternative needs a stored list of every thread ever woken for, the kind of copy Question 3 removed.

> A

## Question 5 - What do the phone chip and the baseline count?

Q: With no Gateway copy, what is the watcher's count?
A: GitHub's unread count. The poll reads GitHub's unread list, which a 304 keeps free on a quiet minute, and the newest time seen still decides wakes. It matches GitHub's own unread badge.

Recommended because the count comes with a read the poll already makes, where counting read threads too would read the whole inbox on every changed poll.

> A.

## Question 6 - How does the agent ask for new versus all?

Q: One fetch with a choice, a `since` the agent passes, or two tools?
A: One `inbox` tool with `scope: "new" | "all"`. `all` lists every thread not done. `new` lists threads updated since the agent's own last fetch, one time the Gateway keeps per watcher. A woken event carries its thread id, so the agent can mark it done without fetching.

Recommended because the agent keeps no timestamp across turns and compactions, and one tool with a strict enum is one road.

> A it is

## Question 7 - Does an action ask the owner first?

Q: Does `done` run at once, or wait for an approval card with a `why`?
A: No approval flow. Setting up the assistant with a watcher is the permission to use that watcher's actions, so an action runs at once and is recorded. This supersedes the design doc's "public asks first" class for watcher actions.

> approval card? let's mock up a design flow without approval flow. the more I think about it, the more unusable Assistant is if it asks for permission. Settings up assistant with the watchers is implied permission to use the actions.

## Question 8 - Where does the record of actions live?

Q: A record line in the conversation plus an Activity list, Activity only, or conversation only?
A: Conversation only. A bare fixed "Marked done" line is not enough, because each done means something different; the record has to carry what it meant.

> The agent will mark it done all the same, but each Done means something different. so I don't like it.
>
> It has to be conversation only, but propose another side by side of what works better

## Question 9 - What does a done carry?

Q: A reason per thread, a fixed outcome per thread, or a summary that is the message?
A: A summary that is the message, and optional. `done({ ids, summary? })`: with a summary, the event was worth bringing up, and the summary is the agent's response with the threads folded under it as proof. Without one, it clears quietly. A fixed outcome such as "told you" is no proof of completion; the GitHub-confirmed thread list is.

> can't be 2. because "tole you" is not a ptoof of completion. 1/3 is more structured correct.
>
> Perhaps 3. But the agent does not need to respond at all to mark it done. Like a lot of notifications is "Your followed repos got a release." which is either important to dev, or nothing important. Agent will decide if it's worth bringing up.
> - If worth bringing up, will show as a response.
> - If not, the aent can mark all done and silently move on.

## Question 10 - How do quiet clears show?

Q: No trace, one muted line per quiet clear, or one rolling line per day?
A: One muted line per quiet clear, such as "5 cleared quietly", expanding to its threads, with no ping. Every judgment stays checkable.

Recommended because it records what the agent waved off at no notification cost, and needs no in-place row update, which the phone has no road for.

> B

## Question 11 - What does a drop rule do?

Q: With GitHub as the only copy, does a drop rule clear, hide, or go?
A: It goes. A cloud source of truth clears through its own actions, so rules sort only wake versus not. Drop may return with a local source.

> drop is implemented by certain actions. GitHub with a source of truth on the cloud, it doesn't use drip.
>
> for now, drop drop. I will bring it up again if we ever do local sources.

## Question 12 - Does a rule still carry ping?

Q: Drop ping and let the agent decide, keep it as a floor, or keep it for the phone only?
A: Drop ping. A rule says wake or not. A response (a `done` with a summary) always notifies the phone; a quiet clear never does.

Recommended because the agent already judges what is worth bringing up, and a second setting would disagree with it.

> A.

## Question 13 - How is an action's code shaped?

Q: An executor map keyed by action, or an Evie-style class per action?
A: Evie style. The shared declaration holds data and schemas only, so the plugin imports no Gateway code. On the Gateway, each action is a class over it: `abstract class WatcherAction<K>` with its `key`, a `declaration` getter, and `run(params: ParamsOf<K>, ctx: ActionContext): Promise<AnswerOf<K>>`. The instances sit in a map typed `{ [K in AssistantActionKey]: WatcherAction<K> }`, so a declared action with no class does not compile.

> I want "reads better once there are many". so Evie style?

# Research

**GitHub notifications API (docs, 2026-10-18):**
- `GET /notifications` lists unread threads by newest update; `all=true` adds read ones; `since` keeps threads updated after a time.
- `DELETE /notifications/threads/{id}` marks a thread done. `PATCH` marks it read. No bulk done endpoint; `PUT /notifications` marks everything read.
- Classic PAT only, `notifications` or `repo` scope.
- Not documented, verify live: whether `all=true` omits done threads, whether a done thread returns on new activity, how `since` treats an equal timestamp, `all=true` paging, the `DELETE` status on success and on repeat, and `GET /notifications/threads/{id}` for a done thread.
- A 304 leaves `x-ratelimit-remaining` unchanged (verified 2026-10-17, `plans/assistant.md`).

**Verified live, 2026-10-19 (two threads in the inbox):**
- `all=true` lists read and unread threads, newest first by `updated_at`; ids are digit strings.
- `since` keeps a thread updated at exactly that time, and also one a second earlier, so it does not filter as documented. The listing applies the mark itself and ends a `new` read at the first page that reaches it.
- `GET /notifications/threads/{id}` answers 200 with the thread; an unknown id answers 404.
- Not testable with two threads: paging past one page. Still open for Phase 5: whether `all=true` omits done threads, whether a done thread returns on new activity, and `DELETE`'s status on success and on repeat. The owner cleared thread `26357054027` (the evie-bot "Server Manager Agent" release) for that test.

**Mockups:** the Designer cards `assistant-done-silent` (the chosen record, column B) and `assistant-watcher-actions` (settings listing the actions).

# Plan

GitHub is the only copy. Per watcher the Gateway keeps its poll validator (`Last-Modified`), the newest update time seen, the agent's fetch mark, GitHub's unread count and health. Nothing about a thread is stored. The agent clears threads with `done`, which answers per id what GitHub confirmed, and the conversation records every clear.

**Clean break:** 8.13.23's inbox rows, read positions, kept drops, woken and evicted counts go with no migration; they are a desynced copy of GitHub, and only the owner runs it. Three things cross the deploy gap instead of breaking:
- **Rules file:** a legacy decoder runs before the schema parse, removing `drop` rules, mapping an `otherwise` of `drop` to `inbox`, and stripping `ping`, while keeping the other rules' order and revisions. Parsing first would start the store fresh and lose them.
- **Phone and baseline readers:** `evicted` is required in today's `AssistantWatcher` and baseline schemas, so the Gateway sends an inert `0` until a dated removal about two weeks out. An old phone's rule write carrying `ping` has it stripped; one carrying `drop` is refused with "update the app".
- **Old plugin:** the inbox moves to a new command path. The old flush and confirm routes go, so an old plugin's `inbox` fails until the release step reloads it and restarts the assistant.

## Phase 1 - Design doc

✅ Rewrite the Events, Rules and Delivery sections of `docs/assistant.md` for the source-of-truth model, the actions and the record. Retire the "public asks first" effect class for watcher actions: setting up a watcher is the permission to use them. The doc leads the code until Phase 6; `AGENTS.md` map lines change with each phase's code.

## Phase 2 - The source lane and waking by newest time seen

✅ Shipped: `sourceLane.ts`, `watcherState.ts`, the keyed GitHub validator, rules without drop and ping, and event members the delivery queue emits once.

- **One source lane per watcher** replaces the watcher runner and the wake runner. It runs the watcher's GitHub work one call at a time, and the live listing (Phase 3) and actions (Phase 5) run through it too, so a poll that read a thread cannot wake it after a `done` landed.
- **A poll is a transaction the lane holds until it settles:** read GitHub's unread list with the stored validator as `If-Modified-Since` (a quiet minute is a free 304 that keeps the last counted unread total), sort the new threads, push the wake candidates, then commit.
- **New** is a thread updated after the newest time seen. Rules sort it `wake` or `inbox`. Wake candidates go in pushes of up to 20, each item carrying its raw `threadId` and keyed by watcher, thread id and update time. The delivery queue drops a key held in a row or emitted within its 30-day TTL, and a push with nothing left answers as landed.
- **The commit point:** the validator and the newest time seen advance together only once `deliverEvent` has answered queued or delivered for every push in the transaction, or the poll had no candidates. A failed push ends the transaction uncommitted, and the lane retries it with backoff (30 seconds doubling to 15 minutes) by polling again from the committed checkpoint, which sends the old validator and so cannot be answered 304. A restart does the same at start. A candidate read or done on GitHub before the retry is not woken, which is right.
- **The lane never waits on a wake:** each push gets a deadline (90 seconds); past it the transaction ends uncommitted, as a failure does. The backoff wait releases the lane, and the retry queues behind any waiting listing or action. A later push joins the launch already in flight.
- **Stop, on release and on shutdown:** cancels the retry timer, aborts in-flight GitHub requests, and fences commits, so nothing lands after stop. It settles within the 5 seconds the assistant stage has before the shutdown flush.
- **First poll after placement** sets the newest time seen to the newest thread without waking, so the backlog goes to `all`, not to a flood of wakes.
- **Ties:** a thread arriving later at exactly the newest time seen does not wake (Q2). The poll sends no `since`; the lane's own filter (`at > newest`) decides ties.
- **The cap:** a poll reads at most 500 unread threads; past that the count shows "500+".
- **Kept:** `X-Poll-Interval`, rate-limit handling and same-host paging from today's watcher.
- **Rules** lose `drop` and `ping`: an action is `wake` or `inbox`. The rules preview runs over the live first page of `all`, since there are no stored events. The phone's rules model and sheet change in this phase too (`RuleDraft`, `WatcherRulesSheet`, the sandbox and fakes): no drop, no ping, no dropped count, so the regenerated `Protocol.kt` compiles and the Kotlin gate stays green.
- **The inbox store** shrinks to the per-watcher state above.
- **Accepted:** more than 500 new unread threads between committed polls, or a thread read while a poll pages, can move the newest time seen past a thread never read; it stays in `all` but never wakes. A grant moved to another GitHub account wakes that account's unread threads newer than the newest time seen.

### Bug Classes

- **Mechanism:** the lane's wake push through `deliverEvent`. **Class:** a delivery id is not an idempotency key end to end, because the queue offers a held id again and keeps no tombstone for a retired one, so the lane carries its own dedupe. **Align round:** a push past its deadline still composed when its launch finished, so `compose` now answers nothing once the lane gave up on it; batches landed before a later failure were resent, so landed keys are skipped until the commit. **Red-team round:** the landed keys grew across a long stretch of failures and were pruned to each poll's candidates; they lived only in memory, so a restart mid-retry could wake a thread twice. **Architecture round:** the delivery queue owns event idempotency. An event row carries its member keys, an acknowledgement records them as emitted in the same write that retires the row, and `acceptEvent` keeps only unseen members, so the lane's own dedupe is gone. The late-compose fence stays in the lane.

## Phase 3 - Live listing

✅ Shipped: the `inbox` listing on `/assistant/list`, GitHub's `list` with signed page tokens that continue a cut page, the agent's mark in watcher state, and the flush wire removed.

- **Verify first, live with the PAT:** every open point in Research.
- **`inbox({ scope: "new" | "all", page? })`** on a new command path, behind the assistant-token check, through the lane. It reads GitHub live with the PAT from `readForWatcher` on every call, never cached. `all` is every thread not done; `new` is threads updated since the agent's mark. Newest first, 50 a page. `page` is an opaque token from GitHub's `Link`, same-host only, and a list that changes between pages may repeat or skip; the agent is told so.
- **Each item:** `threadId` (a string, as GitHub sends it), title, repository, reason, type, a validated link and the rule decision. Strict parsing, today's per-field cuts, a total-byte cap, and every text value through `oneLine`.
- **Links** are built from the validated repository and subject (`https://github.com/...`), or omitted.
- **The agent's mark** is held fixed across the pages of one `new` read, and moves to the newest time returned only once the last page is read.
- **The tool's description and the assistant's instructions** change in this phase: `inbox` lists live and marks nothing.
- **A page token is bound to the grant key** the validator already carries, so a grant change between pages refuses rather than reading another account. The rules preview reads the first `all` page through the same listing.
- **The flush wire goes as one unit:** `eventLines` moves beside the wake render first, then the flush and confirm schemas, routes, stubs and `inboxTool` go together.
- **Accepted:** the mark commits when a `new` read's last page is answered, before the answer reaches the agent, so a call lost on the way drops those threads from `new`; they stay in `all`.

### Bug Classes

- **Mechanism:** the listing's page token. **Class:** a token that does not fully name the page it continues, so a continuation reads different state than the page shown. **Align round:** a page cut by the byte cap had no road to its rest, and following `next` moved the mark past the cut items; a cut now continues the same page by a shown-item count, and every token is signed by the Gateway so the agent cannot edit the mark. **Red-team round:** a cut on a read's first page carried no GitHub token, so its continuation read a fresh first page with no grant, scope, `since` or mark held; the watcher now returns `here`, a token for the page just read, and a cut continues from it.

## Phase 4 - The record, end to end

The phone learns the row before anything sends one: this phase ships the Router and the phone, and no Gateway path emits the row until Phase 5.

- **One row kind,** `assistant_record`: an optional summary, a `notify` flag, and per thread `{ threadId, title, url, outcome }`. Added to the Gateway push entry, the Router row kinds and the phone mailbox schema, with `Protocol.kt` regenerated in the same commit.
- **One outcome enum, shared** by the action's answer and the row: `done`, `not_found`, `rate_limited`, `uncertain`, `not_attempted`.
- **The phone persists it** as a `Message` with a record discriminator and its thread list, and renders a response (the summary as the assistant's message, threads folded under it) or a quiet line ("N cleared quietly", expanding to its threads).
- **`notify: false`** keeps the row out of burst, alert and autoplay processing and out of `countsUnread`. A read receipt resolves to the nearest countable message. These rules sit in one rule file beside the ops class, with JVM tests.
- **Proof stays apart from prose:** titles, links and outcomes render as the fixed list; only the summary is the model's.

## Phase 5 - Typed actions

- **Declarations, as Evie's do,** in one shared registry: per watcher, per action, a key that is the exact MCP tool name (`github_done`), a label and description, a params schema, an answer schema, and a client-safe descriptor for `assistant_state`. The action binds its watcher, so a call names no `watcherId`.
- **GitHub `github_done({ ids, summary? })`:** `ids` are unique digit strings, at most 50; `summary` at most 300 characters. On the Gateway each action is a `WatcherAction<K>` class over its declaration (Q13), held in a map typed by the registry's keys, so a declared action with no class does not compile. The record row reuses the action's per-thread outcome schema. Per id the Gateway reads the thread (`GET /notifications/threads/{id}`) for its title and link, then `DELETE`s it, answering per id with the shared outcome. A rate limit stops the batch, honouring `Retry-After`, and the rest answer `not_attempted`.
- **One dispatcher route,** `/assistant/action`, takes `{ action, params }`, checks the assistant token, resolves the declared action, parses the params with its schema, runs it through the lane with the PAT from `readForWatcher`, and answers with its schema.
- **The record:** the dispatcher posts an `assistant_record` through `deliverToOwner` into the assistant's own conversation (`ownerSessionKey("host.assistant")`), never through `channel_reply` or `notify_human`. With a summary it is a response with `notify` true; without, a quiet line with `notify` false.
- **Three allow lists, one source:** `ASSISTANT_SWITCHBOARD_TOOLS` is derived from the registry's keys, so the MCP scope, the gate and `assistantPermissionArgs` (`hostResolve.ts`) all take them. The assistant-only registration imports the registry and registers one tool per action. `check:boot` asserts the tools are listed.
- **An action holds the lane until its requests settle:** `run` releases the lane at its deadline, which is safe only for a read. An id not yet sent answers `not_attempted`, and one whose request passed its deadline answers `uncertain`, never retried blindly.
- **One GitHub client** owns the token read, headers, refusals and the shared rate limit, so polls, listings and actions cannot disagree. The action's context hands it over.
- **A call id** from the tool dedupes a retried call and keys the record row, so a retry neither repeats the `DELETE`s nor posts a second record.
- **The assistant's instructions** add `done`: decide whether an event is worth bringing up; answer with `github_done` and a summary if so, else `github_done` quietly. Event text stays data.
- **Accepted:** the model holds the granted PAT's authority over any notification it can reach (Q7). A crash between a confirmed `DELETE` and the record's enqueue loses that record; the thread is still done on GitHub.

## Phase 6 - Phone

- **Chip and baseline:** GitHub's unread count ("4 unread", "500+"), with the "in inbox" and lost-unread wording gone.
- **Settings:** each watcher's action descriptors under its secret, as in the mockup, from the existing state call. Decisions stay in `AssistantOps`.
- **Sandbox and fakes** answer the new state and record.

## Clean-break checklist

Inbox store rows, read positions, drop store and replay, woken and evicted counts, the watcher runner and wake runner (replaced by the source lane), the flush and confirm routes and `inboxTool`, the rules schemas' `drop` and `ping`, the stored-event preview, the baseline watcher lines, the phone chip, rules sheet and settings, `SandboxAssistantGateway`, and the tests `assistant-inbox`, `assistant-rules`, `assistant-tool-scope`, `assistant-wake-runner`, `federation-harness-assistant`, `session-baseline`, `AssistantOpsTest` and `RuleDraftTest`.

## Gates, every phase

Each phase ships green on its own: `bun run lint`, the full `bun run test`, `check:boot`, and the Kotlin gate for any schema change. Tests per mechanism against fake GitHub responses: the commit point across a failed push and a restart, a paged `new` read, the rules decoder, the deploy-gap readers, the record's quiet rules. Deploy order: Router, then the phone, then the Gateway, then the plugin. `docs/assistant.md` and the `AGENTS.md` map follow each phase.
