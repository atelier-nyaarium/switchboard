# Questionaire

What Routines left open. `plans/routines.md` is finished; these are the two things it named and did
not settle, plus whatever they turn out to need.

## Question 1 - What does approving an unanswered secret reach? [retracted]

Asked as a choice between minting the authority, minting it and telling the session, re-running, or
not building it. Retracted before it was answered.

> I'm approving of what exactly? To a failed idle session because it timed out?
>
> But what do you mean granting after it failed and stopped?

The owner was right and the question rested on a mistake. The request has already settled as
`refused`; a grant minted afterwards revives nothing, because only a NEW request can use one and only
the agent opens those. Approving would have authorized something nothing was waiting on.

Superseded by Question 3.

## Question 3 - Should there be a fresh run after a correction?

Q: The two honest actions are Link the secret, which serves future runs, and a fresh run, which is
the only thing that can finish the work that was blocked. Is the second worth building, or is linking
enough and the next scheduled run soon enough?

A: Both. A manual run for after a correction, and the next scheduled run picks the grants up anyway.

> Either a run now button to manually trigger it after correction, or the next scheduled run will
> kick it off with the added grants.

## Question 4 - Where does a manual run live?

Q: Linking the secret is a save, and a save clears the routine's attention rows, so the panel that
prompted the correction is gone by the time the owner would press anything on it. Does the manual run
belong on every routine row instead?

A: On every row. It is not only for a correction; the owner wants to fire one several times in a day.

> tbh yeah the run button should be on all of them in case I want to hit it more than once in a day.

### Decided rather than asked

Small consequences with a defensible reading, stated to the owner rather than put to them.

- **A manual run is not the schedule, so a disabled routine still takes one.** `DISABLE_EXPLAINS`
  already says disable stops the schedule and keeps the routine and its runs. Pressing a button is an
  explicit act, and it is not the schedule firing.
- **Firing while one is still working is allowed, with no warning and no refusal.** The owner ruled
  on it knowing what it does, which is that a second nudge lands in a session that is mid-turn with
  nothing coordinating the two.

  > no refusals or warns. keep it simple. I Just have to peek myself before running it again. More
  > often than not, I will know since I am intentionally doing it.

  The residual cost stands and is accepted: with two runs open, an unanswered secret is attributed
  to whichever occurrence is found first, so its panel can name the wrong instant.

## Question 2 - Should the Routines and Runbooks tabs name their gateway?

Both are scoped to the home gateway and neither says so. The Sessions tab already carries the
gateway's name in its status row, so the fact is on screen once, one tab away.

A: The owner runs several gateways, and wants them kept separate per gateway rather than
synchronised. That is already the data model; what it exposes is a display gap, taken up in
Question 5.

> yeah I do have multiple gateways. but for simplicity let's make them separate per gateway so we
> aren't fighting synchronization issues across gateways.

## Question 5 - Do routines live on more than one gateway?

`RoutineOps.show` and `RunbookOps.show` both return early unless the id is the home gateway's, so
each tab draws the one gateway this phone enrolled with and cannot reach another. The client already
takes a gateway per call, so this is display, not plumbing.

Q: Are routines only ever on the home gateway, in which case naming it is enough, or does the tab
need a gateway picker, one at a time and named?

A: Every gateway the owner has. The question should not have been asked.

> All Gateways I own. How the heck did you manage to make it only work with 1 gateway? And why is
> this a question? What other crap has been designed with first gateway only?

# Findings: what else is home-gateway only

Asked for after Question 5. Every `homeGatewayId` reference on the phone was read.

**Two drop another gateway's data, and both came from this plan:**

- `RoutineOps.show` and `RunbookOps.show`, each `if (gatewayId != homeGatewayId) return`.

**One is named for several and answers one:** `BoardManager.sourceGatewayIds` returns a list holding
only the home id. The board is owner-scoped on the Router rather than gateway-held, so this may be
harmless, but the name promises what it does not do.

**Everything else is correct and must not be changed.** Roughly twenty other references use the home
gateway as the default for an UNQUALIFIED name, so `sandbox` resolves against home. Sessions,
threads, trust and rename all read that way. That is addressing, not filtering, and none of them
hides another gateway's records.

### Bug Classes

**Mechanism:** the per-gateway split from Question 17. **Class:** a model made plural while its one
reader stayed singular, with a comment recording the gap as a decision. `RunbookManager` became one
library per gateway to close a real bug, `RunbookOps.show` kept drawing the home one, and the comment
"the tab draws the home gateway's copy; another gateway's is held and not drawn" made the limitation
read as intent to every later reader, including the author. `RoutineOps` then copied it. A comment
that states a limitation without saying it is one is how a gap survives review.

# Findings: what the home gateway is for

`adoptHomeGateway` keeps the stored id while the Domain keyring still admits it, and otherwise takes
`admitted.firstOrNull()`. The owner never picks it and there is no control for it, so a filter built
on it is first-gateway-only in the literal sense.

Its five jobs, every one of them resolving or identifying rather than restricting:

1. Completing an unqualified name, so a bare `sandbox` means that spawn on the home gateway.
2. Filling the gateway segment of this phone's own local address.
3. Reading the Domain id off the home gateway's signed roster.
4. Naming which of the owner's gateways is asking, on a cross-domain trust request.
5. Deciding which gateway claims a runbook library written before libraries were split per gateway.

None of the five decides what may be shown. `docs/console.md` states how the id is selected and never
what it is for, which is how it came to be borrowed as a visibility filter: a thing with no stated
purpose gets used for whatever is nearby.

## The direction, given after the audit

> Home Gateways are a relic of the past. It should have died when we completed the router plan. All
> Gateways are now equals. The router needs to be the centralized node between them.

Recorded in `AGENTS.md` rather than only here, since the owner said they expected to have to repeat
it, which means it has been lost before.

It does not change what this plan builds; it decides how. Nothing new is built on `homeGatewayId`,
and the grouping gives no gateway a privileged position: they sort stably by id, and the home one is
not first. Removing it is separate work, and four of its five jobs have a clean Router-side answer.
The fifth is the hard one: with equal gateways, a bare `sandbox` genuinely names more than one thing,
so either names get qualified or the Router disambiguates. That is where that work will actually
live, and it is why this plan does not attempt it in passing.

# Plan

Refined once against five audits. What changed: Phase 1 was written as "drop two filters" and that
was wrong, because dropping them alone would draw another gateway's rows and then send every action
on them to the home gateway. The same goal, its real cost. Nothing was added that the goal did not
already need, and three things the audits raised were left out deliberately: retiring
`homeGatewayId`, giving gateways human-readable names, and teaching the harness a second gateway.

## Phase 1 - Both tabs reach every gateway [done]

**Phone only.** `sendValueOp(gatewayId, op)` already addresses whichever gateway it is given, and
`ConsoleClientRoutines` says so in its own first line: a routine runs on one gateway, so every call
names the one it means. No wire, no gateway, no Kotlin codegen. The client layer was built for this
and the ops layer threw the answer away.

**It is not "drop two filters".** The audit found that dropping them alone makes things worse rather
than better: a row from another gateway would draw, and then every action on it would go to the home
one. Enable, dismiss, run, edit, fire and the runbook picker all pass an id and no gateway, and the
ops default the gateway to home.

### The one change that makes the rest impossible to get wrong

Take the `= host.homeGatewayId()` defaults off every `RoutineOps` and `RunbookOps` method. Then a
call without a gateway does not compile, and the compiler enumerates the call sites rather than a
reviewer doing it. A row is drawn inside its gateway's group and carries that gateway, so an action
cannot be built without the machine it acts on.

That is the fence. A residue test was the first idea and it is the weaker one: the two offenders were
in ops classes rather than screens, and any scan is defeated by one helper. Make it a type error.

### What that then requires

- **State becomes per gateway.** `ChatState.routines`, `runbooks` and `routineZone` are singular
  today. The zone is each gateway's own, so a schedule read against another's is a wrong time on
  screen. Nothing is persisted, so there is no old blob to migrate.
- **Compose keys and drafts take the gateway.** `item(key = "routine:${id}")` collides for two
  gateways holding one id, and so do `RoutineOps.drafts` and the runbook drafts, where `"new"` is
  shared outright.
- **`routineNotificationId` takes the gateway.** Keyed on the routine id alone, two gateways holding
  a `triage` share one Android notification and reconciliation cancels the other's.
- **`RunbookOps` collisions.** `refusals` is keyed by runbook id alone. `synced` is correctly keyed
  by gateway, id and revision, but both clears match the id alone, and `refresh` calls
  `synced.clear()` for every gateway while refreshing one.
- **`RoutineOps.asked` is one counter for all gateways**, so a slow answer from one discards a fresh
  answer from another. It becomes a counter per gateway.
- **Background paths walk every admitted gateway.** `DrainHost.refreshRoutines` refreshes home alone,
  and the wake instant is computed from the single routine list, so a non-home routine would never
  update in the background and never wake the phone. Bound the fan-out: gateways are asked
  concurrently and one unreachable gateway must not hold up the pass.
- **`RunbookFireSheet` starts at `state.homeGatewayId` outright**, and `RoutineEditor` offers
  runbooks from the merged list, so a routine on one gateway could pin another's runbook.

### Wording

- Empty states say "No routines" when they mean "none on any reachable gateway". An admitted gateway
  that cannot be read right now has no wording at all today.
- The editor's "It is kept as X, where this Gateway reads it" stops being singular once a row can
  come from any of them.
- **Do not copy the Sessions tab's sort**, which puts the home gateway first. Sort by id, no
  privileged position.

Gateway ids are hostname-derived slugs and are the only name available; there is no human-readable
gateway name anywhere in the phone model. Use the id and do not invent one.

Confirm what `BoardManager.sourceGatewayIds` is for, and either make it answer what its name says or
rename it to the one thing it means.

`homeGatewayId` keeps all five of its jobs and stops being consulted about what to draw.
`docs/console.md` gains the five, since stating only how it is selected is what let it be borrowed.

### What can be tested, and what cannot

The collisions are all reachable from plain JVM tests: `RoutineOpsTest` and `RunbookOpsTest` already
build their ops over fakes with a gateway argument, so two gateways holding one id is a unit test,
not an integration one. Every hazard above gets one.

The harness cannot help: `addDomain` mints a whole Domain and there is no way to add a second gateway
to one. Building that is not this plan's work. So the end-to-end, two gateways drawn in one tab, is
verified by hand on the emulator, which the sandbox can seed.

### The hand check, and what the sandbox could not show before it

The sandbox already admitted three gateways and answered all three IDENTICALLY, so it could not have
shown a grouping bug at all. It now answers per gateway: one holds the full set, one holds the same
ids as different records in another zone, and one answers empty.

What the emulator then showed, on both tabs: three groups sorted by id with the home one LAST, the
same id drawn as two records under two headers, each schedule line carrying its own gateway's zone,
a gateway that answered and holds nothing drawn as a bare header, the fire sheet opening the row's
gateway's copy with no Gateway to pick, and the new-record button asking which gateway.

It also showed one thing no gate had: the picker listed gateways in keyring order, which leads with
the home one, while the tab sorted by id. Two orders for one set of gateways on one screen, and the
privileged position this plan set out to remove. The picker sorts by id now.

### What it actually took, where that differs from the plan above

- **The fire sheet lost its Gateway picker rather than gaining a scoped one.** `runbook_fire` takes
  one gateway id, and it is both where the record is read and where the session lands. Once a row
  belongs to a Gateway, picking a different one would preview that Gateway's copy of the id, which is
  a different runbook. `gatewayTargets` went with it, having no other caller.
- **A new record needed a Gateway to be born on, which the plan did not name.** Both FABs took
  `state.homeGatewayId`. `NewOnGatewayFab` takes one Gateway without asking and asks when there are
  several, and it is one composable rather than a branch copied into two screens.
- **`RunbookOps` seeded its state from the home library at construction.** Every other gateway's
  stored copy was invisible until a refresh answered. `RunbookManager.placed()` answers every
  gateway's library, the pre-split copy under whichever gateway claims it.
- **The ports lost `homeGatewayId()` entirely.** `RoutineHost` and `RunbookHost` no longer offer it,
  so neither ops class can reach for it again.

### What the audit found after the first green gate

Handed to an auditor told to look wider than the diff. Four findings, all real, all fixed here.

- **A group was never cleared for a gateway that left the keyring.** `show` replaces one group and
  keeps the rest, so a revoked gateway's routines and runbooks stayed on screen and stayed
  actionable. `refreshAll` now prunes to the gateways it was given, which also settles most of the
  next finding by removing the rows an op could be built from.
- **The freshness fence was added to one sibling and not the other.** `RoutineOps.refresh` grew a
  per-gateway counter; `RunbookOps.refresh` had none, so two reads of one gateway could land out of
  order. Both now share `GatewayReadFence`, which is the point: one implementation rather than two
  that agree today.
- **A nonblank gateway id is not an admitted one.** Accepted rather than built out. An op posted to a
  revoked gateway is refused by the transport, so the failure is loud and safe, and pruning removes
  the rows that made it reachable. A capability type resolved from the keyring is the real answer and
  belongs with retiring `homeGatewayId`, not here.
- **An empty keyring left a button that did nothing.** `NewOnGatewayFab` renders nothing without a
  gateway; the empty state already says no Gateway could be read.

### The alignment audit, and what it changed

Five angles, one auditor each, against the shipped commit rather than the diff alone.

What it found and what was done:

- **A sixth job for `homeGatewayId`, introduced by this plan's own board fix.** An unassigned board
  entry has no session Gateway, so its attachment blob falls back to this phone's write route. The
  list in `docs/console.md` says six now, because a list that is one short is how the fifth got
  borrowed in the first place.
- **One visibility filter is left.** `TrustOps.shareableSessions` offers only sessions on this
  Gateway, and the share it feeds sends `requesterGatewayId = homeGatewayId()`. Widening the list
  alone would offer sessions the share then names wrongly, so it moves with the share op. Recorded
  rather than changed, and it belongs with retiring `homeGatewayId`.
- **Rules were sitting inside composables where no gate can reach them.** The per-gateway lookups and
  the wake instant became `ChatState` extensions with tests, which is the standing rule about a
  decision living beside its ops class rather than in a screen.
- **Two tests could not see the failure they claimed to cover.** One was rewritten to assert the
  round trip that actually differs, then proved by breaking the fix and watching it fail.

Two findings were rejected against the code:

- **"The rows use the phone's zone instead of the gateway's."** Every row time is an instant, so the
  owner's zone is the right one, and the rule's own line already names the zone it is kept in. The
  comment saying so is the fix, since the auditor read it the way a later reader would.
- **"The documents violate a no-semicolon rule."** There is no such rule. It was asserted against
  forty pre-existing lines, which is the reminder that a confident tone is not evidence.

### `BoardManager.sourceGatewayIds`, confirmed and removed

It was worse than "named for several and answers one". The board is one Router-held board:
`boardEntries`, `boardEntriesOn(gw)` and `boardEntriesFor(team)` all returned the same list, and
`lastSyncedAt(gw)` ignored its argument. `sourceGatewayIds` returned `[home]`, and `BoardScreen`
filtered it by `it != boardGatewayOf(null)`, which is also home. **The stale-column notice was
therefore provably always empty and had never once rendered.**

The signal behind it is real: a cached board should say so. So it keeps the notice and loses the
per-gateway framing. `lastSyncedAt()` takes no gateway, and `sourceGatewayIds` and `boardEntriesOn`
are gone.

Then the writes turned out to be the same shape and worse. Seven board write methods took a
`gatewayId`; six ignored it outright, and the seventh used it as the destination for an attachment's
blob. `BoardRow.gatewayId` is `entry.session?.gatewayId ?: ""`, so **adding an attachment to an
unassigned backlog entry uploaded the blob to `""` and recorded `blobGateway = ""`**, which no other
device can ever fetch. Silent, and nothing on screen said so.

So the six lost the parameter, and `boardSetAttachments` resolves its own destination from the entry,
falling back to this phone's write route. A caller can no longer hand a board write a wrong gateway,
because six do not ask and the seventh does not believe them. `BoardEntryDialog` and `boardModal`
lost the gateway with them.

### Bug Classes

**Mechanism:** per-gateway scoping on the phone. **Class:** a model that is plural in one place and
singular in the reader beside it, where the singular side compiles, runs, and looks correct.

Patched three times now, which makes it a design bug rather than three unlucky ones:

1. `RoutineOps.show` and `RunbookOps.show` each drew the home gateway and dropped the rest. Patched
   by grouping state per gateway and removing the defaulted parameter, so the compiler enumerates.
2. The board carried a gateway through seven writes that mostly ignored it, and `sourceGatewayIds`
   named a list of one. Patched by taking the parameter away from everything that did not use it.
3. `RoutineOps` gained a per-gateway read fence and `RunbookOps` did not, in the same change that
   made both plural. Patched by extracting `GatewayReadFence` so there is one.

The common cause is that "which gateway" is an ordinary `String` threaded by hand, so every new
plural reader is a fresh chance to forget. The fix that would make the class inexpressible is an
admitted-gateway value resolved from the keyring, which every op takes and no caller can invent. That
is the same work as retiring `homeGatewayId`, and it is on the board rather than in this plan.

## Phase 2 - A run button on every row

A manual run is a fresh occurrence at the moment it is pressed, never a re-entry of a dispatched one,
which the at-most-once ruling forbids. It ignores the recurrence rule, so the one-day minimum does
not apply, and it runs a disabled routine because disable stops the schedule rather than the routine.
No warning and no refusal when one is already running.

Unlike Phase 1 this does touch the wire: `routine_run_now` names an occurrence and takes only a
`missed` one, which is a different act. A fresh run is its own operation, and the Kotlin codegen
follows it.

What the gateway side has to answer, each confirmed against the code:

- **Nothing in the state machine assumes a rule-named instant.** `open` bounds `scheduledAt` only as
  a nonnegative integer, and preparation never reads it. The ad-hoc occurrence is ordinary.
- **`recordSevereMiss` takes its newest from occurrences of every kind.** A manual run at 14:32 moves
  that mark past a rule-named slot that has gone unrun, and the owner is then never told it was
  missed. It has to walk from the newest RULE-named occurrence.
- **The disabled bypass is three checks, not one.** `advance` gates on enablement before preparing,
  again after preparing, and again before dispatching. A manual run passes all three and keeps every
  other check: idleness, preparation, the revision fence and the deadline.
- **`open` is keyed by routine and instant**, so two presses in one millisecond are one row. Correct
  as it stands.
- **`nextAt` never reads occurrences**, so an ad-hoc run does not disturb the next scheduled run.
  `lastRanAt` moves, which is what it means.

The console operation is a new one rather than a widened `routine_run_now`, which names an occurrence
and takes only a `missed` one. It carries the routine and no instant, since the gateway owns `now`.
Its answer names the occurrence it opened. `ConsoleOpSchema` is already a codegen root, so
`Protocol.kt` follows; `console-result-codegen.test.ts` catches a missing result type.

The row's button and the miss panel's button would both read "Run now" on one card. The panel's
becomes **Run missed**, since it runs that slot rather than a fresh one.

The attention panel keeps only Link the secret, and says plainly that a run already refused cannot be
given the secret afterwards.

# Findings

Established before asking, so the choices are real rather than hypothetical.

- **`VAULT_REQUEST_DEADLINE_MS` is nine minutes; an occurrence's `workUntil` is twelve hours.** I read
  the second number as "the run is still alive" and put a question to the owner on it. It is only the
  outer bound on authority. The request itself has settled as `refused`, and nothing but a new request
  can use a new grant.
- **A routine's authority is live only while `work` is not `done`, and `work` reaches `started` only
  if presence observed the session working.** So a session that was seen working and went idle loses
  the authority within about a minute, and one that was never observed keeps it for twelve hours.
  Same failure, opposite outcomes, decided by whether an observation landed. Nothing owner-facing
  should rest on that, which is the second reason Question 1 was retracted.
- **`routineHolding(sessionTarget)` answers a routine id, never an occurrence.** Any occurrence-bound
  grant has to make `covers` occurrence-aware, or approving Monday's run authorizes next Monday's in
  the same session. That is the silent over-grant this question has to avoid whichever choice wins.
- **`VaultHolder` need not grow a third kind.** A routine holder carrying a bound occurrence works,
  provided `covers` checks both the provenance and that exact occurrence's window.
- **`settleGrants` owns five revocation paths and understands only standing linked-entry grants.** An
  occurrence grant has to be reconciled by all five, or a save or a disable leaves it live.
- **`runNow` accepts only a `missed` occurrence.** Choice C is not a small extension of it: the
  occurrence in question is `dispatched`, so C needs its own road and would re-do work the agent may
  already have done.
