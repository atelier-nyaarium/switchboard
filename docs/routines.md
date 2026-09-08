# Routines

A routine is a schedule the gateway runs, bound to a runbook the owner already approved. The phone
configures one and watches it. It never decides that a routine should run.

The gateway holds the runbook, the reserved session, the idleness fact, the clock and the dispatch,
so a routine is one gateway-local aggregate rather than a record reaching across a service boundary.

## The record

`src/shared/schemasRoutine.ts` is the wire truth: the weekday set, the week interval, the start date,
the time, the zone, the bound values, the runbook id with the revision the owner approved, the
target, and the enabled flag.

Every calendar field is read in the routine's own recorded zone. Without recording it the canonical
zone would be a line in the Dockerfile, and editing that line would reinterpret every stored routine
at once.

`routineRefusal` answers why a record cannot be stored. It bounds nothing by size; a record is
refused for what it means, as a runbook is. A schedule that could never come around is refused by
asking the calculator rather than by inspecting the fields.

`RoutineTarget` is a policy, never a session id. An id would bake in a session that can be closed,
and the occurrence resolves the policy immediately before firing.

## Recurrence

`src/shared/routine-recurrence.ts` answers the next instant a rule names, strictly after a floor.
Nothing in it reads a clock.

- **A spring gap moves forward.** A local time on a day that does not have one answers the moment the
  gap ends, found by searching for where the offset changes. `02:30` becomes `03:00`, not `03:30`.
- **A fall overlap takes the earlier instant.** Both sides of any transition within a day are
  considered, because probing only at the wall time finds whichever side that probe lands on. In Los
  Angeles that happens to be the earlier one and in London it is the later, so probing once is not
  enough.
- **Monday is ISO weekday 1**, whatever a locale starts its week on, and the week interval is counted
  from the Monday the start date falls in.
- **The search is bounded by the rule's own interval**, and starts at the later of the floor and the
  start date, so a routine beginning years out is still reachable.

Two consecutive occurrences are not always a fixed number of hours apart. One local time held across
a transition is twenty three hours from the last, and still the next morning.

## Operations

Six console operations, all owner-authenticated: `routine_list`, `routine_put`, `routine_delete`,
`routine_enable`, `routine_run_now` and `routine_dismiss`.

`routine_put` carries `baseRevision`, the revision the editor was opened at, and the gateway stores
at its own successor. Run now and Dismiss both name an occurrence rather than the routine, since they
answer something the owner is looking at.

The list answer carries each routine with its next instant and any occurrence the owner has not dealt
with. The phone recomputes none of it.
