# Questionaire

What Routines left open. `plans/routines.md` is finished; these are the two things it named and did
not settle, plus whatever they turn out to need.

## Question 1 - What does approving an unanswered secret reach?

A routine's run asks for a vault entry. The owner does not answer within nine minutes, so the request
settles as refused and an attention row is recorded. The occurrence's work window is twelve hours, so
when the owner sees the panel the run that asked is usually still going.

The session has already been told no, and nothing gives it a reason to ask again.

Q: When the owner approves for that one run, what does it reach?

Choices put to the owner:

- **A. The authority only.** A grant for that entry, bound to that occurrence, expiring with its work
  window. If the session asks again it works.
- **B. The authority and the session.** As A, and the reserved session is told the secret is now
  available. It decides whether to retry.
- **C. Re-run the occurrence.** Mint the grant and dispatch that occurrence again.
- **D. Do not build it.** Keep only Link the secret, and say plainly that a refused run cannot be
  given the secret afterwards.

A: pending.

## Question 2 - Should the Routines and Runbooks tabs name their gateway?

Both are scoped to the home gateway and neither says so. Not yet asked.

A: pending.

# Findings

Established before asking, so the choices are real rather than hypothetical.

- **`VAULT_REQUEST_DEADLINE_MS` is nine minutes; an occurrence's `workUntil` is twelve hours.** The
  run that asked is almost always still alive when the panel appears. Approving for one run is
  therefore a live action, not a memorial, which is the opposite of what `plans/routines.md` assumed
  when it deferred this.
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
