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

# Plan

## Phase 1 - Both tabs reach every gateway

Drop the two `show` filters. `ChatState` holds routines and runbooks per gateway rather than one
list, and each tab groups by gateway the way the Sessions tab already groups, with a header shown
only when there is more than one. Nothing merges and nothing synchronises across gateways.

Refreshing walks the gateways the phone knows rather than home alone.

Confirm what `BoardManager.sourceGatewayIds` is for, and either make it answer what its name says or
rename it to the one thing it means.

## Phase 2 - A run button on every row

A manual run is a fresh occurrence at the moment it is pressed, never a re-entry of a dispatched one,
which the at-most-once ruling forbids. It ignores the recurrence rule, so the one-day minimum does
not apply, and it runs a disabled routine because disable stops the schedule rather than the routine.

No warning and no refusal when one is already running.

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
