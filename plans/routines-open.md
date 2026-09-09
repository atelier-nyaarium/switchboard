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
- **Firing while one is still working is allowed.** Two open works in one session name the same
  routine, so no authority is confused. The only cost is that an unanswered secret is attributed to
  whichever of the two occurrences is found first, so its panel can name the wrong instant.

## Question 2 - Should the Routines and Runbooks tabs name their gateway?

Both are scoped to the home gateway and neither says so. The Sessions tab already carries the
gateway's name in its status row, so the fact is on screen once, one tab away.

A: pending.

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
