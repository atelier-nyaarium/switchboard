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

Seven console operations, all owner-authenticated: `routine_list`, `routine_put`, `routine_delete`,
`routine_enable`, `routine_run_now`, `routine_run` and `routine_dismiss`.

`routine_put` carries `baseRevision`, the revision the editor was opened at, and the gateway stores
at its own successor. Run missed and Dismiss both name an occurrence rather than the routine, since
they answer something the owner is looking at.

**`routine_run` is a different act from `routine_run_now`, which is why it is its own operation.**
Run missed re-runs a slot the rule named and the owner is looking at, and takes only a `missed` one.
A pressed Run opens a fresh occurrence at the instant it was pressed, so it carries no instant: the
gateway owns `now`, and answers the occurrence id it opened.

The list answer carries each routine with its next instant and any occurrence the owner has not dealt
with, plus the zone that Gateway keeps them in. The phone recomputes none of it.

## The tab

A routine belongs to the Gateway that runs it. The Routines tab asks every admitted Gateway,
concurrently, and groups the answers by Gateway; one that cannot be read leaves the rest drawn. The
heading appears only when there is more than one, and groups sort by Gateway id.

Each group carries the zone its Gateway keeps schedules in, which is what the editor converts a typed
wall-clock time into on save. The rows do not use it: a next run, a last run and a miss are all
instants, so they read in the owner's own zone, and the rule's line names the zone it is kept in.
Notification ids, editor drafts and list keys all carry the Gateway, because two Gateways may hold
the same routine id and neither may cancel or overwrite the other.

An empty tab distinguishes the two things it can mean: no Gateway answered at all, or the Gateways
that answered hold nothing.

## The runner

`src/gateway/routines/runner.ts` owns when, and everything that could act on an occurrence enters
through `advance`, so the timer, the reconcile tick and a pressed run cannot each be walking the
same one.

It wakes on the earliest thing worth waking for, and a bounded tick runs beside it because a timer
only counts down: a machine resuming from suspend would otherwise sit past a deadline holding a timer
for the old delay.

`src/gateway/routines/occurrences.ts` holds the durable rows. Every move is a compare-and-swap from a
named state and version, and `src/shared/routine-occurrence.ts` says which moves exist at all.

- **`dispatched` is written before the nudge is handed over.** Exactly once was not available, so a
  crash between the two loses the run visibly rather than sending it twice.
- **Enablement and the deadline are re-read immediately before that write**, since preparation is
  awaited and either can change while it runs.
- **A miss carries its reason.** Being down, waiting on a busy session and being disabled share a
  deadline but not a story.
- **Recovery collapses.** Occurrences still inside their twelve hours run; everything older becomes a
  single severe miss, so a week away is one panel. Reconstruction never reaches past the routine's
  `since`, which the gateway stamps when it first takes one.
- **The severe-miss walk reads rule-named occurrences only.** A pressed run's occurrence carries
  `adhoc`, and counting it as the newest would move the floor past a scheduled slot that never ran,
  so pressing Run would silently swallow the miss the owner needed to see.

### A pressed run

`runFresh` opens an occurrence at the instant it was pressed and walks it through the same `advance`
as everything else, so it cannot race the timer or the tick.

- **It bypasses enablement and nothing else.** Disable stops the schedule, not the routine, and
  pressing a button is not the schedule firing. Idleness, preparation, the revision fence and the
  deadline all still apply, so a pressed run on a busy session waits exactly as a scheduled one does.
- **It walks only a row it opened itself.** Occurrences are keyed by routine and instant, and `open`
  answers whatever is already there. A press landing on a millisecond the rule already named would
  otherwise run the rule's own row down a road that skips the gates a scheduled run keeps, so a row
  that is not this call's own is refused. At-most-once forbids the re-entry either way.
- **It does not disturb the schedule.** `nextAt` never reads occurrences, so the next scheduled run
  is where it was. `lastRanAt` moves, which is what it means.
- **Nothing refuses it while a run is already working.** The owner ruled on that knowing what it
  does: a second nudge lands in a session that is mid-turn, with nothing coordinating the two.
- **Several windows can be open in one session, so everything that closes them closes them all.**
  `workingOccurrences` answers every one, and a session ending marks each `done`. Closing only the
  first would leave the routine's authority alive in a session that is gone, for up to twelve hours.
  `firstWorkingOccurrence` beside it answers one representative. That is right for readers about the
  routine rather than the run, since `routineTeam` derives the session target from the routine id and
  one session therefore belongs to exactly one routine.
- **The answer says what became of the run, not that a row was opened.** Preparation is awaited, so
  the deadline or a moved revision can settle the occurrence before the operation answers.

The stage is armed from the federation context's activation callback, so it cannot fire before the
routes exist, and both the already-active boot and a later enrollment go through it. Shutdown stops
admission and drains the attempt in flight before the listener's flush.

The store publishes every write it takes through a required `onChanged`, and the stage sweeps on it.
A runner that armed from the store and was not told the store moved would only ever fire on the tick,
so a routine saved a moment before its slot would wait the tick out.

## What the session asks back

A nudge names a command from `src/shared/session-commands.ts`, which holds the tool name, the gateway
path and both schemas in one entry. The gateway serves the path and the MCP registers the tool from
that same entry, so prose cannot ask a session to call something nothing answers.

`get_session_routine` is registered for any token-bound session and sits behind no capability: a
session a routine reserved must be able to read what it was asked, and the owner never opts that
session into anything. It answers the snapshot taken when the occurrence was prepared, never a fresh
render, so a runbook edited on Tuesday cannot rewrite instructions issued on Monday.

Four outcomes stay distinct: no routine on this session, unknown occurrence, wrong session, and an
unrecognized token. Separating the middle two does tell a caller that some instant is spoken for. It
is kept because a session told "unknown" about its own run, after its session was replaced underneath
it, would report a routine broken that is merely somewhere else.

An occurrence is named on the wire by its scheduled instant alone. `deliveryKey` is the composite
that names a delivery row, and the two are not interchangeable: every consumer of the wire form reads
it with `Number`.

Answering records `readAt` on the occurrence, and the list carries it as `lastReadAt`. That is the
other half of liveness: a session that woke and did something else is not one that picked the routine
up, and nothing else can tell them apart. It still says nothing about whether the work was any good.

## What no gate here can reach

`bun run check:boot` runs the real `main-mcp` as a subprocess, answers the gateway's handshake as a
client does, and checks the tool registers for a bound session, answers its own session, refuses a
token the gateway does not know, and is absent without a binding. A residue test cannot see a tool
that is never registered.

The emulator covers Compose, the clock-change receiver and the zone conversion. Drive it with `adb`
as `AGENTS.md` describes. It cannot represent the following, which is a manual pass on a real phone
after any change to the poll loop, the alarm, or the service:

- **Doze and app standby buckets.** The emulator idles differently. Use
  `adb shell dumpsys deviceidle force-idle` on the device and confirm a routine miss still reaches
  the phone, then `unforce`.
- **The sandbox arms no alarm at all.** Its network doors are shut, so the poll loop that would arm
  one never runs. The alarm path is only observable on a provisioned build against a real Gateway.
- **OEM battery managers.** Xiaomi, Samsung, Huawei and OnePlus each kill background work on their
  own terms and none of it appears on a stock emulator image. Confirm the app is exempted in the
  vendor's own battery screen, not just Android's.
- **Notification channels after an OS upgrade.** A channel the owner silenced stays silenced across
  reinstalls; a miss then lands with nothing shown.
- **Boot.** `adb reboot` on the device, then confirm the routine list still reads and a miss recorded
  while it was off is shown.
