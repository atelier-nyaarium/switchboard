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

## Question 3 - Should the attention panel offer a fresh run?

Q: The two honest actions are Link the secret, which serves future runs, and a fresh run, which is
the only thing that can finish the work that was blocked. Is the second worth building, or is linking
enough and the next scheduled run soon enough?

A: pending.

## Question 2 - Should the Routines and Runbooks tabs name their gateway?

Both are scoped to the home gateway and neither says so. Not yet asked.

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
