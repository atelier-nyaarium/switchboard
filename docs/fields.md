# Fields, computed fields and automations

The Gateway reads typed values (a sensor's temperature, a frame of bytes), derives new ones from them, and tells the assistant when one becomes a value the owner named. None of it reaches the phone as code: the phone reads the declarations and the values.

## The field table

`src/shared/field-types.ts` holds the kinds and their rules once; codegen writes the same data into `Protocol.kt` as `FieldTypes`, and `kotlin-gate.sh` diffs it.

- **Kinds:** `enumeration` (Choice), `text`, `number`, `bytes`. Choice and text take condition tests; number and bytes take none, and `conditionsIssue` refuses a condition over them.
- **Units:** a number is stored in a stored unit (`C`, `%`); `F` is a display unit only. `toDisplay` and `fromDisplay` convert, a converted value storing at 0.01 so it reads back as typed.
- **Range:** `inRange` keeps `|value| x 10^decimals` within 2^53, so both runtimes format it the same.
- **Bytes:** lower-case hex, at most 64 bytes, shown as offset rows of eight (`bytesText`).
- **Parse and render:** `parseFieldValue` in `src/shared/field-values.ts` answers a value or an issue (`path`, `message`, `code`), rounding a reading to its declared decimals. `formatFieldValue` is the one text renderer; `FieldRules.kt` is its phone twin.
- **Pinned:** `tests/fixtures/field-types/vectors.json` (grammar, rounding, conversion, range, rendering), replayed by both runtimes.

## Owner records

`src/gateway/ownerRecords.ts`, `createOwnerRecords`: the store under computed fields and automations. Phone-minted ids, Gateway-named revisions, buried ids, `commitChecked`, `onChanged` after the write. `batch` plans several puts and removes against one draft and lands them in one write, or none when any is refused. The envelope (`id`, `revision`, `incarnation`, `kind`) parses strictly; a body this build cannot read is held unread, reserves its id and its place in the cap, and is written back untouched. A put carries its base revision, and a repeat of the stored content answers stored. The `refusal` hook runs on every put and on `invalidOf`, so validity is read, never stored; a refusal may carry the issue shape.

## Expressions

`src/shared/expressions.ts`. A flat node table, each node naming only earlier nodes: field, literal, compare, all, any, not, choose, band, take, arithmetic, unknown. At most 64 nodes.

- **Check:** `checkExpression` types every node against the inputs' declarations and refuses with an issue naming the node. All-text-literal branches infer a Choice of those literals.
- **Evaluate:** `evaluate` never throws. Whole-number arithmetic runs on BigInt and truncates toward zero; a result past 2^53, a division by zero or a short frame answers unknown. A band keeps its side, by node index, until a value passes its dead zone.
- **Values:** known or unknown with a reason. `conforms` reads a known value off its declared type as unknown.

## Computed fields

`src/gateway/computed/computedFields.ts`, `createComputedFields`. A computed field is a label, an optional unit and decimals, and a node table. Fields may name fields, as a DAG at most four deep.

- **One input port:** `input(ref)` answers a field's declaration and value together. Each pass reads every input once and resolves one snapshot of types, order and validity, which `typeOf`, `invalidOf` and `value` read.
- **State:** per field, a basis hash (expression plus every input's type), an `epoch` minted per fresh baseline, the last known value, `seq`, the band sides and the last 16 transitions (`previous`, `value`, `at`), all in one commit. An expression edit or a type change starts a new epoch and tells nothing; the first known value is a baseline. An unknown result reads unknown and keeps the last known value for the next comparison.
- **Calls:** `start()` runs the first pass once listeners are wired; `inputsChanged(keys)` re-evaluates fields naming those keys and their dependents; `typesChanged()` re-evaluates everything. `onCommit` fires after every landed write.

## Automations

`src/gateway/computed/automations.ts`, `createAutomations`, over the record in `src/shared/schemasAutomation.ts`. An automation is `enabled`, a trigger, a list of actions, and an optional `label` a projection names itself by. A trigger is `event` (a source and its conditions, decided in the assistant's lane; `docs/assistant.md`), `value` (a Choice or boolean computed field, the value it `becomes`, and `coolDownSec`) or `crossing` (a sensor's number: `device`, `measure`, `direction` above or below, `threshold`, `deadZone`, `coolDownSec`). The one action is `tell_assistant` with `when`: `now` or `quietly`. A sensor's thresholds write `crossing` automations that tell quietly, one per side that is set.

- **A crossing's band:** the store hands computed fields one derived field per crossing automation (`crossing:<id>`, a one-sided band over the device's reading). It is evaluated and kept in the field state like a stored field, counts toward no cap and is listed nowhere, and an edit to the automation gives it a new basis, so the number it is saved over is its baseline. `drain()` reads it as `becomes` low or high. The row's sentence is the device's name, the reading's label, the direction and the threshold in the owner's unit, and its event tells the number it fired on.

- **One writer:** `write(intent)` is the only door into the store. `judgeAutomationWrite` in `automationJudge.ts` reads the intent against what is held and answers the rows to write or a refusal, and `createOwnerRecords.batch` commits them in one write, so a failed or refused set leaves the store as it was. The intents: `owner_put` and `owner_remove` (no alert id, and an event automation only at the assistant's home), `carry` (the home's whole set of event automations: what this Gateway cannot run is dropped with a log, and a set that does not fit under the cap or takes an id another automation holds is refused whole), `adoption` (stored rules, until 2026-11-28) and `projection` (one sensor's whole alert set, under that sensor's id prefix only). The cap, the id shape, the revision and validity are the record store's, on every row.
- **One reader:** `drain()` is the only place a `value` transition becomes a fire. It runs at construction, after a put, a remove and a clear, and on each field commit. Repeating it changes nothing.
- **Checkpoint:** per automation, the record revision, incarnation, field epoch and `handledSeq`. A revision change (create, edit, re-enable) baselines at the field's current `seq`; an epoch change at that epoch's seq 0. A baseline whose write failed is held in memory for the next drain.
- **Crossing:** a stored transition above `handledSeq` with `value === becomes && previous !== becomes`. Transitions lost past the 16 kept log one `uncertain` run. Cool-down reads the transition's own time. Off the assistant's home, a crossing logs `refused`. An invalid or disabled automation never fires.
- **The sensors queue:** a crossing appends an event in the same commit as its checkpoint, at most 256 events or 64 KiB. The event carries its automation's `when`, absent for `quietly`, and an older entry without one reads as `quietly`. A full queue logs `refused` once and holds the transition (`blockedSeq`) until a clear makes room. An event's id is `automation:<id>:<incarnation>:<epoch>:<seq>`, and its `at` is its append time, strictly increasing. An event body this build cannot read stays queued and unlisted. Entries leave by `clear`, which drains again, so a repeated clear retries.
- **The source:** the `sensors` source (text fields automation, field and value) lists the queue for the source lane. Its events say how they tell, so no event automation triggers on them.
- **Composition order:** read the home, build computed fields, build automations (it drains at construction, so it must see the home), then `start()`.

## Device definitions

`src/shared/device-definitions/`: one JSON file per model under its family, the same bytes whether shipped, built or shared. A definition is `{ format, key, version, family, label, models, match { sources, namePrefix, activeScan }, inputs, readings, examples, attribution }`: each input is a company's maker data as bytes, each reading a field spec and a node table over the inputs. `definitionRefusal` is the one load rule: the schema, sources inside the family's catalogued markers (a definition never widens the radio filter), every reading checked against its inputs, and every example replayed. `SHIPPED_DEFINITIONS` loads at boot and refuses a bad file. `govee-h5110` is the first.

## Newer kinds on an older phone

`scripts/codegen-kotlin.ts` gives every sealed root a decode policy in `SEALED_ROOTS`. A `preserve` root (`AssistantFieldSpec`, `ConsoleDeviceReadResult`) decodes a kind this build does not know to `Unknown(kind, raw)`; every `when` over it carries a fail-closed arm that shows the field and never saves or acts on it. Codegen refuses a discriminated root with no policy, and a `preserve` root without a future-kind fixture in `tests/fixtures/protocol/_manifest.json` (`expect: { ts: "fail", kotlin: "unknown" }`).
