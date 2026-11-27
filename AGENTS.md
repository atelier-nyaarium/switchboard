# Agents

Cross-team communication and devcontainer coordination. This file is a map, not history.

## Layout

- `src/main-mcp.ts` / `main-gateway.ts` / `main-host-daemon.ts` / `main-federation.ts` / `main-vault-askpass.ts` / `main-session-hook.ts` / `main-opencode-launch.ts` / `main-opencode-agent.ts` - eight entry points
- `hooks/hooks.json` / `src/mcp/baseline/baselineHook.ts` / `capabilityHook.ts` - the plugin's SessionStart `compact` hooks: the baseline, and the capability guidance
- `src/mcp/capabilitiesTool.ts` `capabilityGuidance` - the one rendering of a session's capability guidance: the handshake answer (`channelReply.ts`), the `compact` hook and `switchboard_capabilities`; the `agents` section combines every enabled backend's `<id>-agent` capability
  - **A fresh session cannot skip it:** the plugin auto-answers a handshake only once the role is known, so a new process's agent answers its first one itself, and that answer carries the guidance. A Copilot session, confirmed at registration without one, reads it in its MCP server instructions. The hook renders the set the session started with, which the MCP process records per `PROJECT_NAME` (`saveStartupCapabilities`). Only a cut or unreadable guidance names the tool.
- `src/mcp/devcontainer/hostResolve.ts` `assistantPermissionArgs` - the assistant's launch: Claude Code's permission engine in `dontAsk` with a closed `--tools` list and inline settings, the boundary its hook layers over
- `src/mcp/assistant/gate.ts` / `gateHook.ts` - the assistant's PreToolUse gate, `main-session-hook gate`: a deny-only second layer by exact tool name, and the only check on the attachments and refs of `channel_reply` and `notify_human`
  - **Every allowed write needs a held phone hold** (`src/shared/assistant-hold.ts`): claimed from the summon panel or Assistant tab within the last 10 minutes, the claim stamped on the Router's clock and its age judged on the Gateway's; an unreadable hold refuses. `src/mcp/hookGateway.ts` is the one road a hook asks the Gateway by.
- `src/gateway/assistant/assistantRestart.ts` - typing `/exit` into an idle assistant whose pane waits on a restart to apply an installed update; the pane reader per CLI is `restartPending` in `src/shared/agent-screen.ts`
- `src/mcp/assistant/instructions.ts` - the assistant's standing rules in its MCP instructions, and `scopeTools`, which lists only its own Switchboard tools
- `src/shared/assistant-session.ts` / `src/gateway/compose/composeAssistant.ts` - the assistant's one session: placed and let go as the Router's home record says, owned by provenance, reserved from both sweeps, never plainly forgotten; the `assistant_*` console handlers. `docs/assistant.md` holds the design
- `src/shared/schemasAssistantHome.ts` / `src/federation-server/assistant/assistantHomeService.ts` / `src/gateway/assistant/homeFollow.ts` / `homeMark.ts` - where the assistant lives: the record's wire, the Router's choice and report rows, the Gateway's follow, and its durable mark
  - **A version applies once, and the mark lands first:** `createHomeFollow` writes the mark before anything it causes, ignores a version at or below it, and reruns only an apply a crash cut short. The mark is scoped to the active Domain, and one that fails to land stops the assistant acting.
  - **A carried entry this build cannot read is dropped, never the move:** `readableSealed` filters the carried automations, functions and services one by one before the payload is parsed, so a newer build's action kind, function or service costs that entry alone. A move carries the functions its automations run by value (`carried.functions` of the home record, `CarriedFunction`), the phone picking them with `carriedFunctionsOf`, and the sealed payload stays within `ASSISTANT_HOME_SEALED_MAX_BYTES`.
  - **A generated field says how its null encodes:** `scripts/codegen-kotlin.ts` marks a required nullable field `@EncodeDefault(ALWAYS)` and an optional one `NEVER`, so no `Json` setting decides, and the phone seals with `wireJson` like everything else. `PhoneEncodedFixtureTest.kt` writes `tests/fixtures/phone-encoded/cases.json` with the phone's own encoder and `phone-encoded.test.ts` parses each case by its schema, the one gate that runs the phone's encoding against the Gateway's schemas; `kotlin-null-encoding-residue.test.ts` refuses a generated nullable field with no mode and any `explicitNulls`. The carried fields stay `.nullish()` for a phone on 8.14.81, which sealed nulls.
  - **A move carries the automation list it read:** `carriedOf` in `AssistantOps.kt` takes it as a required argument, and a move or a seed whose list cannot be read writes nothing.
- `src/gateway/router/registrationRead.ts` - a whole-state read at each registration: one in flight, a stale registration's answer dropped, a failure retried while registered; the share mirror and the assistant's home take it
- `src/gateway/assistant/source.ts` / `sourceState.ts` / `sourceEnabled.ts` / `sourceLane.ts` / `githubClient.ts` / `githubSource.ts` / `iftttClient.ts` - what a source polls and answers; what it keeps between polls, and the `not_found` threads it hides; which sources are off; one lane per source, its polls, listing and actions one at a time; the one road to GitHub, its token read and shared rate limit; GitHub notifications; the Gateway's IFTTT trigger
  - **The key leaves only in the URL handed to fetch:** read at the post under the `ifttt` grant, not retained between calls, never logged or answered, and the post follows no redirect.
  - **A disabled source polls, wakes and lists nothing:** the lanes read `enabled` where they arm, where a poll starts and before it commits, and `switched` voids a poll in flight. The inbox listing and the baseline skip it. The store holds the off set, so absent is on.
  - **A poll commits only once its wakes are queued:** the validator and the newest time seen advance together. A failed or late push leaves both, so the retry, or a restart, polls again from that checkpoint. The first poll after placement wakes nothing.
  - **The lane owns every deadline, through one road:** `read` frees the lane at its deadline and settles nothing after it; `write` holds the lane until the work settles and ends its signal at the deadline with a typed reason, `laneEnd`. Work not started by its deadline answers `not_started` and runs nothing. `linkedSignal` in `src/shared/ambient.ts` is the one signal-with-a-timer every bound uses, and `waits.ts` holds the caller-facing waits.
- `src/shared/schemasActionFront.ts` / `src/mcp/assistant/actionFront.ts` / `src/gateway/assistant/assistantRoutes.ts` / `src/gateway/assistant/statusMemo.ts` / `src/shared/schemasAssistantActions.ts` / `src/shared/schemasPhoneCapabilities.ts` / `src/gateway/assistant/sourceAction.ts` / `actionDispatch.ts` / `phoneDispatch.ts` / `githubDone.ts` - `list_actions` at `/assistant/actions` and `run_action` at `/assistant/run`; action ids `phone/<key>`, `gateway/<key>` and `source/<key>`, the family naming where it runs; one params Zod object for the listing's JSON Schema and Gateway parse; the holder's last `status` answer for phone availability, kept for the hold window and cleared on `no_holder`; source and phone dispatchers behind the routes
- `src/shared/schemasDeviceTool.ts` / `src/mcp/assistant/deviceTool.ts` / `src/gateway/assistant/deviceDispatch.ts` - the assistant's `device` tool: the console op table, each op offered or withheld (`DEVICE_TOOL_OFFERS`), its op union and per-kind results, `dangerActOf`; the tool, posting `{ device, callId }` to `/assistant/run`; the dispatcher, holding a danger act on the owner's card. `docs/devices.md` holds the design
  - **The op union is the console's own request objects:** `DEVICE_TOOL_OFFERS` is `satisfies Record<DeviceConsoleOpKind, boolean>`, so a console op added without an entry does not compile, and the union filters `DEVICE_CONSOLE_REQUESTS` by it. An offered kind also needs its result in `DEVICE_TOOL_RESULTS`, compile-checked. The assistant's answers are the console's parsed through the assistant schemas, which drop a record's address; a failure is a fixed phrase per kind, since transport text names addresses.
  - **The surface fences a danger put, not only the dispatch:** `DeviceStage.assistant` refuses a put matching a catalogue danger act unless called with `approved`, which only `approvedDeviceRun` passes.
  - **The danger tier comes from the catalogue:** a setting put is guarded when it equals a danger act's `put` (`samePut`), the same `put` the phone's act button sends, generated into `IntegrationRegistry.kt` as a Kotlin constructor (`kotlinValue`).
  - **The phone's bindings are generated:** `PhoneCapabilityRegistry.kt` from the TS registry, so a key with no handler or a handler with the wrong types does not compile; `kotlin-gate.sh` diffs it.
  - **The tool allowlist stays fixed:** `ASSISTANT_SWITCHBOARD_TOOLS` names only `list_actions` and `run_action` for actions and `device` for devices, so a new key or device op needs a registry entry and handler, not an allowlist change. `check:boot` proves the tools are listed for the assistant alone.
  - **A call id joins a retry to the first call:** `run_action` mints one per call, each family dispatcher holds its answer through `createOpDedupe`, and a source action's record row is keyed by it, so a retried post repeats no request and no record. A phone action records nothing.
  - **An action answers by its deadline:** one its lane has not started is refused with nothing sent. The Gateway sets Bun's `idleTimeout` to its 255-second cap and lifts it per request for routes in `src/shared/gateway-long-waits.ts`. The plugin's `routerRequest` disables its fetch timeout for long routes.
- `src/shared/schemasAssistantSend.ts` / `src/gateway/assistant/sendGuard.ts` / `src/mcp/assistant/sendTools.ts` - the assistant's guarded `crosstalk_send`: its wire, routes and wait cap; the guard that binds an intent, holds it on an owner card and delivers it as bound, the Safety store and the origin marker; the tool's post, collect and withdraw. `docs/assistant.md` holds the design
  - **`/assistant/send` is the assistant's only road out:** `/send` refuses a session send presenting its token, whatever `from` names, and only the guard builds the `assistant` ingress (`sendFromAssistant`).
  - **The marker cannot be skipped by a new road:** every channel row reaches a session through the delivery queue, whose `observer` is required, and an offer reads the held row. A restart, a session's end and a fresh placement clear it.
- `src/gateway/ownerRequests.ts` - the owner-request lifecycle the vault and the send guard share: ids, deadline, per-target cap, joins, settlement, collection, withdrawal and the restart ledger
  - **`step` is the only mutator and `retire` the only delete:** each entry holds one phase (waiting, claimed, settled) and one timer, which re-arms when it fires early. Retention is the adapter's `collectUntil`, read once at settlement, so no adapter is a special case. A takeover opens under the deadline it replaces (`deadlineAt`) and the request it replaces does not count against the cap (`replacing`); `waiting` reads what still waits on the owner, `revise` restates a waiting request in place under its own id, session and deadline, and `unclaim` gives a claim back to waiting. `owner-requests.test.ts` drives it with a timer that fires before its instant.
- `android/.../assistant/AssistantSendOps.kt` / `AssistantSendSheet.kt` / `AssistantSendText.kt` / `plugins/assistant/AssistantPlugin.kt` - the phone's held send cards per Gateway and their answer, the card, its pure text, and the core handlers that claim the rows
- `android/.../AssistantLockedForm.kt` / `DeviceLockWatch.kt` - what a locked phone or a watch may show and speak of an assistant row (`lockedLine`, `spokenTier`), and the screen-off watch that tells playback the phone locked. `docs/assistant.md` holds the rules
  - **No surface ever holds the assistant's body while locked:** its notifications carry only `lockedLine`, unlocked too, since a watch bridges what the phone shows and ignores a public version.
- `android/.../AssistantSummon.kt` - long-press-power summon: the `Summon` transitions, `SummonBus`, and every decision (`summonLanding`, `focusStep`, `promptsAppLock`); `MainActivity.consume` raises one and asks the keyguard to dismiss. `docs/assistant.md` holds the rules
  - **Only a resumed window acts on a shared bus:** a picker leaves a stopped `MainActivity` beneath a second one, so `routesNow`, `focusStep`, the app-lock handoff and `WorkspaceOpenBus` routing all read `resumed`.
  - **Nothing draws over the keyguard:** `summon-residue.test.ts` refuses `showWhenLocked`, `turnScreenOn` and `RECORD_AUDIO`.
- `android/.../assistant/AssistantPanelService.kt` / `AssistantPanelSession.kt` / `AssistantPanel.kt` / `AssistantPanelRules.kt` / `IntegrationProbe.kt` - the panel over another app: the services the assistant role binds, the session, its surface, every decision it makes, and the debug probe. `docs/assistant.md` holds the rules
  - **`panelShow` decides before any UI is enabled:** a locked keyguard, an app lock that would ask or
    no conversation hands off to `MainActivity`'s summon; `summon-residue.test.ts` pins the order.
  - **Each summon is a fresh session:** `onHide` calls `finish`, so a capture landing late has no
    session to land on.
- `android/.../AppLock.kt` / `ForegroundLease.kt` - the app lock's one answer for the process, and the one foreground both hosts hold
  - **The lock outlives a rotation, not the Activity:** `MainActivity` finishing gives it back,
    since the service would otherwise keep the process, and the answer, alive.
  - **An unlock prompt the phone could not show keeps it locked:** `AppLock.answered` takes the
    prompt's `OwnerPrompt`, unlocks only on what `passes`, and holds `fault` for the lock screen's
    line until the next unlock or relock.
- `src/shared/gateway-long-waits.ts` - the POST routes whose default wait passes Bun's 255s idle cut, and which of them replay a repeat; read by `src/gateway/index.ts` and the plugin's `routerRequest`
  - **The plugin's fetch lift holds the long routes:** Bun 1.4.0 does not cut a POST after its body is
    read, and its fetch abandons an idle request at 300s. No gate here runs either Bun behavior;
    `gateway-serve-limits.test.ts` derives the set from each route's wait.
- `src/gateway/vault/vaultUse.ts` - the one release a vault value leaves by: the routes' and a service's standing grant read
- `src/shared/schemasAssistant.ts` - the assistant's console answer: where it lives on a Gateway and its sources there
- `src/shared/field-types.ts` / `field-values.ts` / `expressions.ts` / `src/gateway/ownerRecords.ts` / `src/gateway/computed/computedFields.ts` / `automations.ts` / `src/gateway/assistant/outboxSource.ts` / `android/.../FieldRules.kt` - the field table, a value's parse and render, the expression nodes, the owner-record store, computed fields, automations with their outbox (`AutomationOutbox`), the source that lists it in the assistant's lane, and the phone's render twin. `docs/fields.md` holds the design
  - **`drain()` is the one reader of field transitions:** the field state stores its last 16 transitions in the same commit as its `seq`, and a checkpoint per automation names the record revision and field epoch, so no crossing is inferred from today's value.
  - **A refused batch says why by a typed cause, and its caps are checked on the final count:** `OwnerCause` (`bad_id`, `invalid`, `newer_build`, `moved`, `spent`, `absent`, `removed`, `unsaved`, or a `cap` naming the total or a kind) rides every refusal, so a caller maps it and guesses nothing. `maxByKind` caps each kind (256 automations, 256 functions) beside the total of 512 records, `batch` counts the rows it would leave whatever order its writes list, and `unreadOf` says whether a row a newer build wrote holds an id.
  - **Every sealed root names a decode policy:** `SEALED_ROOTS` in `scripts/codegen-kotlin.ts`; codegen refuses a discriminated root without one, and a `preserve` root without its future-kind fixture. A `preserve` root also decodes a known member it cannot read whole as `Unknown`, kept as sent (`function-step-future-value.json`), so a member that grows a value never fails the list that holds it.
- `src/shared/schemasAutomation.ts` / `src/shared/schemasAssistantRules.ts` / `src/gateway/compose/composeAssistant.ts` - the automation record, its trigger and action unions, the row a Gateway lists and the four console answers; a source's field declarations and the conditions tested against them (`trimRuleValue`, `valuesOf`, `canonicalConditions`, `conditionsIssue`, `conditionsWarning`, `conditionsMatch`); the lane's decision, `eventIssue`, `eventWarning`, `eventSentence` and `previewTrigger`. `docs/assistant.md` holds the rules
  - **Every match fires, and one waking match wakes:** `decide` takes an event that says how it tells (`told`), else wakes when an armed event automation of the source matches and tells `now`. No order, no first match.
  - **An automation's validity is read, never stored:** `eventIssue` checks the trigger against its source's current `fieldSpecs` on every read. An unfit one is kept, arms nothing, and rides in the row's `invalid`.
  - **A body is checked by one assessment, and one policy, `levelOf`, gives each issue its level** (`src/gateway/computed/automationValidity.ts`): `argsIssue` is the one check of an action's values, for a flat action and for a `do` step alike (holes only in a text parameter, a device value against the offered switches, a choice against its options, values that are all literal against the action's row). `assessBody(body, functions)` yields every `BodyIssue` in written order: `trigger`, `choice` (a condition's choice its source no longer offers), `action`, `step`, `call` (a function that cannot be followed, or a private one), `fit` (the call's bindings) and `name` (a declared value that shadows). `levelOf` answers `refuses`, `unarmed`, `error` or `warning` from the issue's cause through one table, `ISSUE_LEVELS` in `schemasAutomationSave.ts` (generated as `Protocol.Wire.IssueCause` with its `level`): an emitter names its cause, a step issue with no cause is an error, and only `REFUSALS` refuse. `docs/fields.md` (One assessment of a body) says which issue takes which level. No error blocks a save: the judge and the store's `refusal` hook (`writeIssue`, `functionIssue`) refuse `refuses` alone; `automationIssue` answers `refuses` and `unarmed`, for `armed`, `retireOf` and the row's `invalid`; `issuesOf` is a save's and a check's `issues` and the row's `errors`; frame entry checks fit alone (`entryIssue`, `calledEntryIssue`), never the callee's steps; and a run fails a step with errors at its turn (`actionStops`, `stepStops`, the pass's `errorAt`, `STEP_ERRORS`), after the steps before it ran. A step's read values go through the same check with no hole read (`resolved`). A function that did not come with a move reads `FUNCTION_LEFT`, off the trigger, never stored. `STEPS` is keyed by every step kind, so a new kind does not compile without its check, and `automation-validity-residue.test.ts` refuses a second judge of an action's values.
  - **The row's sentence is the Gateway's:** `eventSentence` writes it from the trigger and the source's labels; no record stores one and the phone composes none.
  - **`write` is the automation store's one door** (`src/gateway/computed/automationJudge.ts`): every write is an intent (the owner's put or remove, the home's carried set, a sensor's stored thresholds converted) that `judgeAutomationWrite` turns into rows or a refusal, and `createOwnerRecords.batch` lands every row or none. An owner writes an event automation only at the home; a carry keeps every event automation, one this Gateway cannot run stored as it is and read invalid, and is refused whole when it does not fit or takes a held id; a conversion replaces only a row still in the form its sensor's page stored. `refusalOf` answers what a write would be refused for and writes nothing, which is how a home move asks first. The intents also include `save` (an automation with its function, as `edit` or `copy`) and `sweep` (functions no automation runs). A save never writes where it should not: a derived id (`copyIdOf` for a copy, `carryIdOf` for a carried function, keyed from `automation-function-key`, never logged or answered) is claimed by `claimDerived`, which walks the chain to the first id free for this intent, so a rerun reaches the same id and a staying automation's function is never written over; `usersOf` is the one reader of who runs a function and answers unknown while an unread automation row is held, unknown meaning used, so the delete at none and the carry's free check never take a function an unread automation runs. A carry takes functions by value: a function keeps its own id unless an automation holds it or a staying automation runs it, pointers follow, and one whose function did not come never binds to a stayer's. A move in place (`inPlace`: the function a held event automation here already runs) claims that function at its own id and, when it is held, puts nothing over it. A new road is a new intent, which the judge's switch must then handle.
  - **Users are read through calls:** `usersOf` is every automation pointing at a function and every function calling it, unknown while an unread automation or function row is held. A save's users for the confirm check are every automation that reaches a function it writes (`reachOf`), its own `called` writes must each be reached by it, and what refuses in its own walk under the functions it writes (a loop, a call cut by a write) is refused where the automation's own row would not be rechecked; a user it leaves unfit reads its error. The delete at none keeps a function the automation's new function calls (`unused` reads the save's own writes). A carry lands by three rules (`judgeCarry`): an automation already here keeps the function it holds, or one a newer build wrote (`keptBy`), and no carried body lands on that function or on anything it calls (`inPlace`), though a reference that did not come may share a kept body's dangling id, so a rerun moves nothing; only what an arriving automation needs is landed (`land`, `build`: its pointer's function, then what that calls, each on its own id when only moving automations run it, else on a derived one, with its calls mapped by `recalled`), so a carried function nothing arriving needs is written nowhere; and a pointer or a call whose function did not come lands where nothing is held (`vacant`), except from an older phone, whose own id is taken when only movers use it, which is how its move back finds the function the let-go kept. One landing has one source (`claimedBy`). A function moves when everything that runs it moves, a least fixed point over `usersOf` (`movingFunctions`), never a recursion over callers. The sweep removes only functions no automation reaches.
  - **One binding check for a pointer and a call:** `boundIssue` in `automationValidity.ts` is `fitOf` with the trigger's precedence, then each device value a held switch. The pointer takes it (`callIssue`), a call read before it runs takes it with an expression standing as its declared type (`callFits`), and a call at its entry takes it with every value as read (`calledEntryIssue`), so a value of another type ends the call before any of its function's steps run.
  - **A function with no name is one automation's own steps:** `unnamed(fn)` in `schemasFunction.ts` is an empty name, the one test of it; the schema refuses a name of spaces, so a build that requires a name never reads one as named. Such a function has at most one automation pointing at it and no function calling it. The judge refuses a save that would leave one it writes, points at or calls otherwise, by the code `private`, and makes no named function unnamed while an unread row leaves its users unknown; and `assessBody` reads it at every read (a call naming one, or a pointer to one more than one held automation points at, is `FUNCTION_PRIVATE`), which is the only guard for a carry and so never a refusal there. It is listed for its own editor and for a move, counts toward the function cap, and leaves with the automation in the same write. `serves.functions.unnamed` tells a phone this Gateway holds one.
  - **A condition's value is one string or a list, read and written in one place per runtime:** `valuesOf` reads either shape on both runtimes, `canonicalConditions` and the phone's `conditionOf` write it, and `holds` is the one matcher; `docs/assistant.md` (Automations) holds the stored form and the matching. The list is `JsonElement` in Kotlin, as the codegen carries every union. `serves.conditions` (`skew:condition-lists`) names the tests and how many values a Gateway takes; the phone offers chips and `contains_not` only there (`servedTests`, `valuesMax`) and `carryRefusal` refuses a move to a destination without them.
  - **The phone's Save gate is pinned to the Gateway's parse:** `fittingAutomation` in `AutomationDraft.kt` refuses only what the wire cannot carry, so a blank or unfit condition saves `unarmed`. It, `SourceFields.fits` and `issueOf`, and `conditionsIssue` and `conditionsWarning` all replay `tests/fixtures/assistant-rules/vectors.json`, so the trim, the stored form, the fit and the warning cannot drift between runtimes.
- `src/shared/schemasFunction.ts` / `schemasAutomationSave.ts` / `automation-fit.ts` / `automation-carry.ts` / `automation-walk.ts` / `switch-cases.ts` - a function record (name, up to `FUNCTION_PARAMS_MAX` typed values, up to `FUNCTION_STEPS_MAX` steps; `FUNCTIONS_MAX` of them), the save op and its coded refusals, the fit rule, the choice of functions a move carries, the one walk over an automation's actions, and a switch's case values. `docs/fields.md` holds the design
  - **A switch's case values are read in one place:** `caseKey` in `schemasAssistantRules.ts` (trimmed, lower case) is the one comparison the run (`caseTaken`), the duplicate check, a choice field's option uniqueness and the phone share; `switchIssues` in `switch-cases.ts` answers a cause per issue, never a level, and `choiceFieldOf` reads a choice subject as exactly `event.<field>`, all pinned by `tests/fixtures/switch-cases/vectors.json`. A switch's sides are `case:N` and its default `case:<cases.length>`, read and written only through `sidesOf` and `withSides`. `docs/fields.md` (The tree) holds the causes and the run.
  - **A function is an owner record beside the automations, and an automation runs one through a pointer:** `run_function` (`function`, literal `values`) is an action kind, never an effect, and one id space spans both kinds, so an id one kind holds is `invalid` for the other. A function a newer build wrote is held unread and counted in the caps; its automation reads `FUNCTION_UNREAD` and never fires.
  - **A function runs another through a `call` step, and the walk follows it:** `call { function, values? }` is a step kind, never a `do` step and never an effect; its values are by the callee's value names, each a literal or an expression read in the caller's scope at the call's turn. `reached(automation, functionOf)` answers a callee's steps under its call's path, so a function reached twice is at two paths, and a call it does not follow is an `unfollowedCall` with why: `loop` (its function is already above it), `missing`, or `budget` (past `WALK_ENTRIES_MAX` entries, or `RUN_FRAMES_MAX` functions entered, the cap a run holds too, so a save refuses what a run could not finish). `stepsOf` and `callsOf` read one function at every depth, `reachOf` every function a run can enter, and `recalled` a body with its call ids mapped. The phone's twin in `assistant/AutomationWalk.kt` follows calls and replays `tests/fixtures/automation-walk/vectors.json`, including call, loop, missing and nested cases; its `callsOf` also serves the carry.
  - **The walk is the one reader of what an automation reaches, and its entries are closed:** `reached(automation, functionOf)` answers, in written order, an `action` (never a call), a `step` of the function a call was followed into, or an `unfollowedCall` saying why (`not-expanded` when walked without functions, `missing` when its function is not held). An entry is read only through `visit`, which takes a handler per case and per step kind, so a reader that ignores a case does not compile; an unfollowed call proves no reach, which is what `asksOf` reads. `written` is the one-level reader for the list as stored, `pointerOf` the call an automation makes, and a body is opened only through them (`Sealed`, `walked`). The walk also owns the step path, which is numbers alone: `0.2.0.1` is the call at action 0, its step 2, that step's first side, step 1 (a first side, an if's "then" or a try's body, is 0; the second, else or catch, is 1). `sidesOf(step)` is the one reader of a step's lists, each with its side and number, and `withSides` writes them back; the phone's twin is `sidesOf` in `assistant/AutomationWalk.kt` for a stored step and in `StepTree.kt` for a card, over the sealed `Side`. `within(site, address)` spells an `Address` of indexes and named sides under its call; `stepsOf(fn)` answers a function's steps at every depth with their numbers under the function, the one reader for a check that has no automation; `siteAmong` finds the call a step runs under among a fire's frames (`siteIn` in `automationFires.ts`), `below` gives its numbers under that call, and `addressIn` in `automationFrames.ts` names the sides by reading them against the body. `byPath` orders, and `STEP_PATH_RE` is what a stored path matches. `automation-walk-residue.test.ts` refuses another reader or a probe around the visitor, and `tests/fixtures/automation-walk/vectors.json` is replayed by both runtimes.
  - **Fit is one rule on both runtimes:** `AUTOMATION_TRIGGER_GIVES` says what each trigger kind gives by name and type (`EVENT_GIVEN_FIELDS` beside a source's declared fields for an event), `triggerGiven` and `fitOf` answer whether a trigger and an automation's values fill a function (`functionReads` what it reads), and `assistant/FunctionFit.kt` replays `tests/fixtures/automation-fit/vectors.json`. A crossing's `device` is the sensor's name and gives text, never a switch.
  - **One save op lands an automation with its function, or refuses by code:** `automation_save` carries the automation with its base, an optional function as `edit` or `copy`, the functions its calls reach as `called` (each an id, a body and a base, 0 adding it), and `confirmed`; its answer holds both rows and the issues of what the automation runs (`issues`, `AutomationIssue`: `level`, `record`, `id`, `step`, `param`, the span, `case`, `value`, `line`), or an `AutomationSaveRefusal` whose `code` is one of `AUTOMATION_SAVE_REFUSALS` with its facts (`record`, `path`, `step`, `param`, `labels`), prose beside it for an older phone. The phone reads an older Gateway's `hole`, `unfit` and step `invalid` refusals until skew row `step-refusals` closes. `automation_put` and the list row keep the shape an older phone reads.
  - **A check is a save that writes nothing:** `automation_check` carries a save's payload and answers `ready` with the `issues` that save would land with, or the refusal it would get now, with what the body it would run reads (`reads`). A copy's derived id is left off an issue until it is written. `assess` in `automations.ts` is the one answer, the judge then the store's own dry run (`store.refusalOf`), and `write` is `assess` then `batch`, so a check and a save cannot disagree on the same rows. A check reserves nothing: the save is judged again.
  - **A save that only points names the function it showed:** `functionBase` on the save op is the pointed function's revision as the screen drew it, and a stored revision that moved refuses `moved` with `record: "function"`. A save that stops pointing names the function it held the same way, so a flatten cannot overwrite an edit made elsewhere. A toggle and a save that writes the function itself carry their own bases.
  - **The list answers its functions, and a build says whether it serves them:** `functions` on the listing (`AutomationFunctionRow`: id, revision, body, `users` the automations that point at it, `callers` the functions that call it, `moves`, `reads`, `invalid`) is built from one store read, `moves` and `reads` follow calls (`reachOf`, `readsThrough`), a function no automation reaches is unlisted, and `serves.functions` names the step kinds and value types this Gateway holds. `carriedFunctionsOf` in `automation-carry.ts` picks what a move takes, with vectors under `tests/fixtures/automation-carry`.
- `src/shared/script-grammar.ts` / `script-types.ts` / `schemasScript.ts` / `src/gateway/computed/automationScript.ts` / `automationScriptOps.ts` / `src/gateway/liveConsole/doing.ts` - a function's steps as script: the statement grammar, the types a name reads as, the two console reads' wire, the printer and the reader that lowers a script's tree to steps, the reads' handlers, and the doing members a script names an action by. `docs/fields.md` (The script) holds the text and its rules
  - **The Gateway alone prints and parses:** `script_print` and `script_parse` are console reads that write nothing, `serves.functions.script` says a Gateway holds them, and the phone holds no parser. A print answers the text, `readOnly`, each step's span by its walk path and each name with its type and reach; a parse answers the canonical steps or up to eight issues with spans, and with steps up to eight of their issues, each with its `level` (`stepIssuesOf`), placed in the text through the parse's `places`. Both answer `types` (the members of `Error`, and of `Event` under an event trigger), and `console_describe` with `script` answers the vocabulary a script names, doing members included.
  - **A doing call is its action's row:** each row of `AUTOMATION_ACTIONS` names its `call` (an entity and a method), `withDoing` registers one doing member per row for the `script` audience alone, and `doingAction` is the parser's one lookup, so a new action kind is written in script by adding its row. A doing member has no handler: the evaluator and a hole's save check refuse one, and the live console's fence lists each and proves both refusals.
  - **A script is parsed once, then read:** `parseScriptSource` in `script-grammar.ts` turns the lexer's tokens into statements (`ScriptNode`) whose values are the expression parser's own nodes, and `parseScript` lowers that tree to steps with its tables (plugs, functions, action rows). No source is sliced and parsed again, and nothing counts brackets: a `{` is a block after `if (...)`, `else`, `switch (...)`, a case's values, `default`, `try`, `catch (e)` and `parallel`, and a record where an expression stands. `SCRIPT_BLOCKS_MAX` bounds the parser's stack. A faulted statement raises one issue and the parser carries on at the next line, past a block that line opened.
  - **A value is a literal or an expression:** a quoted string with no hole is a constant, so a literal; one with a hole is an expression, kept as written. What a quoted string is depends on its `Position` alone: an action's text parameter and a `throw` take its body as the text they store (`bodyOf`, each stored character mapped to its span for `placeIssue`), a plug, a word, a choice and a function's name take a constant and refuse a hole, and a kept or given value takes either. Printing is the lexer's rule run backwards, one function for a constant (`quoteConstant`) and one for a text (`quoteText`: each run escaped, each hole as written). A plug or a function is written by name when exactly one holds it and no id is spelled so (`nameFor`, `idFor`). An expression that would read bare as something else prints in parentheses: one literal anywhere, a string with a hole anywhere but a kept value.
  - **Every function settles after one round:** `parse(print(f))` is the canonical function, and a seeded sweep in `automation-script.test.ts` holds that printing it again changes nothing and reads back the same steps, spans and reaches. The printer answers each step's span and each name's reach itself, so a text that reads only needs no parse.
  - **What would not read back reads only:** a `do` naming no action or holding `as`, a call to a function not held, a `let` named as a word the language took, a text with an open hole, and whatever else fails `parseScript` on the printed text, which `printScript` runs before it answers. A text past `SCRIPT_SOURCE_MAX` is answered empty with why. A parse bounds its body as a save does (`overBounds`) and refuses at the first step over, with that step's span.
  - **A script with errors is a step, and the phone edits script by tree:** an `unparsed` step holds the text as typed, alone in its function (`UNPARSED_ALONE`), and fails `unread` at its turn with nothing of it run. On the phone (`assistant/ScriptDraft.kt`, `assistant/ScriptView.kt`) each tree, the automation's own or a callee's, holds its script edit, its Cards or Script choice and the script page; a parse answer lands only for its own text and context (`scriptCurrent`), and a tree is swapped only through `swappedOwn` and `swappedCallee`, so no swap forgets what the tree holds. `ScriptDraftTest` drives each rule.
- `src/shared/schemasAssistantInbox.ts` / `src/gateway/assistant/inboxListing.ts` / `assistantRoutes.ts` / `src/mcp/assistant/inboxTool.ts` - the live listing's wire, `eventLines` the one rendering of an event in a wake and a listing; the listing itself, its page tokens and the mark; the Gateway door, answering only the assistant's own token; the `inbox` tool, registered for `host.assistant` alone
  - **A listing reads the source every call and stores nothing but the mark:** `new` reads after the agent's mark, which `listOne` in `inboxListing.ts` moves only once a read's last page is shown whole. The module signs every page token with a key it mints and holds in memory, so the agent can neither forge nor edit one; a cut page's token names the last item shown, so the next page continues after it whatever left the list in between. A token also carries the count of actions run on its source at the read's first page (`acted`), and a `new` read that spans an action leaves the mark, so a thread an action shifted between a source's own pages is shown again, never passed.
  - **An event is data, end to end:** `PendingDelivery` is a union of `MessageDelivery` and `EventDelivery`, and an event row holds no sender or reply route, so none can be read off it; the queue refuses an id held by the other arm. `ChannelPushPayload.event` carries it to the session, and `emitChannelNotification` gives it no sender, `session_id` or `meta.instructions`.
  - **The batch is composed where it is sent:** `deliverEvent` calls the wake's `compose` after `reach` and hands the result straight to the synchronous accept.
  - **The queue skips an event member it holds or emitted within the delivery TTL:** an event row carries its member keys, and `acknowledge` records them as emitted in the same write that retires it. `acceptEvent` drops a seen key and answers `seen` when nothing is left, so a retried or restarted push wakes nothing twice. A message duplicate is still offered again.
- `android/.../AssistantOps.kt` / `AssistantHomeFence.kt` / `AssistantHomeRouter.kt` / `ConsoleClientAssistant.kt` / `AssistantRoot.kt` / `assistant/AssistantScreen.kt` / `assistant/AssistantFeaturesPage.kt` / `assistant/AssistantSourcePage.kt` / `assistant/InboxStrip.kt` / `assistant/IntegrationRows.kt` - the gateway calls, the home's read, move, remove and seed, `inboxRows` and the health lines; the one writer of the home; the Router's home ops and their sealing; the landing fold, `isAssistant`, and `ShellPage` with its resolve and keys; the root with no conversation, the settings index and its pages; the Features page; a service source's page; the conversation's inbox strip; the Sources view's service rows
  - **An unread word is not a refusal:** the entry holds an `AssistantRead` (reading, refused or answered), and `GatewayRegistry.assistantRead` is its one reader: off the roster it is reading before the roster loads and refused after. A read that fails over reading lands refused and over an answer keeps the answer (`readAfter`), so no page waits without a Retry. Every surface says what it draws for each: a spinner, the unread line with Retry (`UnreadLine`), or a stated default. Over a home it has not read, the Location page offers no folder and no move in place (`locationBase`, `folderShown`), only a move to another Gateway, which is how the assistant leaves a home that cannot be reached; a late answer reseeds the folder only while untouched (`folderAfter`). A service's grants page builds its entry from an answer alone (`serviceEntryOf`), so "Choose key" is never offered over grants it has not read.
- `src/shared/schemasIntegrations.ts` / `android/.../proto/IntegrationRegistry.kt` / `android/.../IntegrationRules.kt` / `assistant/IntegrationAddPage.kt` / `assistant/IntegrationEntryPage.kt` - the integrations catalogue: every brand, service and protocol declared once (group, discovery, needs, yields, capabilities, acts with a tier), its generated Kotlin twin, the phone's decisions over it, the Add page and an entry's page. `docs/devices.md` holds the design
  - **A catalogue entry the phone cannot draw does not compile:** the generated enums are closed, and each page's `when` over a group, a discovery mode, a need kind or a capability has no else branch. Device drivers and the grant-bearing service ids derive from the catalogue.
  - **The Gateway says what it serves:** `offered` on the assistant state; the phone draws Add from the compiled catalogue filtered by it, so an older Gateway hides an entry and an older phone ignores the field.
- `android/.../PlugSetup.kt` / `PlugSetupOps.kt` / `AndroidPlugSetupPlatform.kt` / `SandboxPlugSetup.kt` / `KasaCodec.kt` / `PhoneLocation.kt` / `assistant/PlugSetupPage.kt` - a fresh device's setup from the phone: the rules and answers, the run, Android's network picker and the plug link, the emulator's plug, the codec twin pinned by `tests/fixtures/kasa-codec/vectors.json`, the one location reading the Features row and the signal bars share, and the page. `docs/devices.md` holds the flow
  - **The phone joins through the system picker, never a scan:** a prefix `WifiNetworkSpecifier` needs no location permission. The phone's own scan only adds signal bars, and only when `phoneLocation` answers `ON`; otherwise the list is radios.
- `android/.../DeviceOps.kt` / `DeviceSlots.kt` / `SlotViews.kt` / `DeviceRules.kt` / `ConsoleClientDevices.kt` / `SandboxDevices.kt` / `ClockPicker.kt` / `assistant/AssistantSourcesPage.kt` / `assistant/AssistantDevicePage.kt` - the phone's devices: every call and landing, the view and its slots, the typed slot facade over `PublishedViews`, what the pages decide, the Router calls, the emulator's fake Gateway, the shared time picker, the Sources view and a device's page. `docs/devices.md` holds the rules
  - **Every device answer lands on its own slot:** a ticket is minted before the await and lands only its slot's part, a per-plug slot is owned while the plug is held at its incarnation, and a write holds one `Writing` claim through its settle. A Gateway the roster does not name is asked nothing.
- `android/.../SensorRules.kt` / `PairRules.kt` / `DefinitionMatch.kt` / `PhoneRadio.kt` / `AndroidBlePlatform.kt` / `assistant/SensorDevicePage.kt` / `assistant/ListenEntryPage.kt` - phone sensor rows, scan sightings and Pair choices, shared definition matching, radio ownership, and the Sensor and Listen pages. See `docs/devices.md` for the rules.
  - **`PhoneRadio` owns scanning:** it reconciles wanted bindings with registered addresses. One consumer handles events. `watch` runs only when bindings differ or registration is unknown. Screens and receivers cannot call it.
  - **This Phone readings use their listing Gateway:** persisted bindings let a receiver post after process death without a listing.
  - **Readings stay Celsius:** `temperatureUnit` changes display through `toDisplay` and `fromDisplay`.
  - **A sensor's page lists its automations and writes none:** `watching` in `assistant/AutomationUses.kt` picks the crossings of that device from its Gateway's list, through the same `usedBy` fold a source's page reads, and each row opens the automation editor. New opens `AutomationSlot.New(watch)`, which `newAutomationDraft` starts on a crossing of that sensor's first number; `offersWatch` asks the same function, so New is drawn only where it would open. A row the Gateway cannot run shows why, and removing a sensor says how many automations it leaves behind, or that any watching it will stop when that list is unread (`removeSensorLine`); the removal re-reads the Gateway's automations.
- `android/.../assistant/AssistantPermissions.kt` / `AssistantSettingsLines.kt` / `FeatureToggles.kt` / `PhoneCapabilityOps.kt` - the Features page's rules (`phoneSettingRows`, `featureViews`, `featureToggle`, `switchEnabled`, `grantedAfterAsk`, the lines), the index's status lines, the persisted wanted set, and the capability ops: the journal, `permissionState`, `grants`, and `PhoneCapabilityPlatform` with its Android implementation
  - **One availability rule, `grants`:** the page's switch and lines and the dispatch read it, and `permissionState` is the switch in front of it. A need with neither a manifest permission nor the listener mapping is ungranted everywhere; a torch without a back flash is unsupported everywhere, checked before its needs. The screen only renders and calls.
  - **A disabled feature answers `disabled` with no needs:** off is not a missing grant.
  - **The Android reads sit behind `PhoneCapabilityPlatform`:** `PhoneCapabilityOpsTest` drives `enqueue` through `execute` to delivery with a fake, which is what a Context in the constructor made impossible.
  - **The home has one writer, `AssistantHomeFence`:** every home effect takes a `HomeTicket` before it awaits and lands through `land`. Nothing begun before a re-provision lands; a Gateway's word or a failure begun under an older choice does not land; a record lands only when `newerHome` orders it later. A late answer never repaints what a newer choice settled.
  - **Placement is the Router's record and its report, never a Gateway's answer:** `placedGateway` reads a `placed` report for the held choice. An `AssistantWord` is only that Gateway's own state.
- `android/.../PhoneCapabilities.kt` / `PhoneCalendarRules.kt` / `AssistantNotificationListener.kt` / `NotificationRing.kt` / `NotificationRules.kt` / `AppMatchingRules.kt` / `PhoneLaunchRules.kt` / `PhoneTelephonyRules.kt` - the phone handlers, the calendar's rules, the listener's entry conversion and bounded ring, the rules for listing and replying, the app match the launch and the notifications filter share, the launch decisions (the maps URI, the app resolve, the alarm and timer extras), and the number, URI and SMS part rules
  - **The listener decides nothing:** the service converts and the ring holds; `NotificationRules` is the one reading, so a JVM test covers it. Eviction takes a dismissed row before a showing one, and a reconnect marks every row the system no longer shows as dismissed.
- `android/.../AutomationOps.kt` / `ConsoleClientAutomations.kt` / `assistant/AutomationDraft.kt` / `assistant/AutomationParts.kt` / `assistant/AutomationActions.kt` / `assistant/AutomationContext.kt` / `assistant/AutomationUses.kt` / `assistant/AutomationsPage.kt` / `assistant/AutomationEditorPage.kt` / `AutomationTriggerForms.kt` / `AutomationActionForms.kt` / `assistant/HoleTextRules.kt` / `HoleTextEditor.kt` / `assistant/StepTree.kt` / `CardsDraw.kt` / `StepCards.kt` / `SwitchCases.kt` / `assistant/RunsDraft.kt` / `FunctionRules.kt` / `FunctionCarry.kt` / `FunctionFit.kt` / `RunsBlock.kt` / `SandboxAutomations.kt` - each Gateway's automation list, what it says it holds (`serves`) and its calls, on the `PolicyOps` model, with the editor's edit session; the draft, `SourceFields` (labels, menus, `issueOf`), `fittingAutomation`, `automationEditing`, `editable` and `outcomeOf`, the one reading of a save's or delete's answer; a trigger as the editor holds it, the offer it is checked against, and a text's preview; an action as the editor holds it, drawn and checked from its Gateway's row; what a Gateway serves an editor and whether one may open; which rows a source triggers or a sensor's numbers are watched by; the Automations view; the editor, its trigger forms and its action cards; a text with holes on its own page, its paint, its completions and its rules; what an automation runs as the editor holds it (its own steps or a pointer, and how a save writes the function), what the Runs block draws and blocks, the choice and refusal of functions a move carries, the fit twin, the block and its picker; the emulator's Gateway
  - **A page reads its op's result from its ops class, never from its own coroutine:** `AssistantOps.runWork` and `work` hold each page's busy flag and line; `AutomationOps.edits` holds the editor's, an `EditorSessions`. The editor sends through `AutomationOps.commit` and `remove`, as the other three editors send through their ops class, and one send reads the draft's carried context once, for its body and for its answer.
  - **A refused `automation_list` fails the move:** only a listed answer carries (`eventRows`), so a list not served or unreachable writes nothing.
  - **The editor offers only what its Gateway says it holds:** `automationContext(registry, home, gatewayId)` in `assistant/AutomationContext.kt` is the one reader of what a Gateway serves and the one place `away` is decided. Its offer is `Known` (read off a listing that arrived: each trigger's row with the names a hole may use, each action's row with its parameters and its `danger` and `home` flags, the numbers its sensors read, its switches) or `Unknown` with why; no parameter defaults an offer. The draft carries the context it was minted with (`EditContext`), and `over(held)` keeps it through a Gateway restart until a fresh answer arrives, so the sensor page's New, the Automations view's New, the editor and the row lines cannot disagree. Away from the assistant's home (`away`) no event triggers, nothing tells it and no IFTTT key is held, so only a crossing or a clock that switches a plug starts there (`newAutomationGateways`). `editable` keeps a row whose trigger the Gateway does not hold out of the editor.
  - **An action is drawn from its Gateway's row, never from a form this build wrote:** `ActionDraft.Filled` holds a kind and its parameters by name, and `ActionsSection` draws each `ParamOffer` by its kind (text, word, switch, choice), so a kind added to the Gateway's catalogue needs no phone build. `actionOf` builds the wire action through the generated serializer. An action whose kind is not offered, whose row holds a parameter kind this build cannot draw, or that holds a key its row does not name is `Kept`: listed, removable and saved as it was sent. A value typed into a parameter this build's own class lacks is sent raw (`AutomationAction.Unknown`), never dropped, and a `Filled` action holding a value its row no longer names is an issue that blocks the save (`actionIssue`), never a shorter action: the value is drawn stray with a Clear (`actionFields`, `withoutValue`), and an action whose kind is gone may be removed even when it is the only one (`canRemove`). An action whose row says `home`, held on a Gateway away from the home, draws a warning that does not block the save (`actionWarning`), since it would be refused on every run, and its row says so (`doesText`); a new one is not offered there (`freshAction`). `AutomationDraftTest` decodes the protocol fixture of the real catalogue, and `automation-actions.test.ts` pins that fixture to `AUTOMATION_SERVES`. The action cap, the interval and cool-down bounds, the parameter kinds and the crossing directions are generated (`Protocol.Wire`), and the form switches on `ActionParamKind` with no `else`.
  - **A number is typed in the owner's unit and saved in the stored one:** `triggerOf` converts a crossing's threshold through `fromDisplay` and scales its dead zone without the offset; `triggerDraftOf` is the way back. The draft carries the unit it was typed in (`AutomationDraft.display`, set once at its mint), and a crossing the stored unit of the number it was typed against (`TriggerDraft.Crossing.unit`), and every conversion and suffix reads those, never what is known at save time. A crossing minted while its number was absent holds the stored value as raw text, drawn with the stored unit once its number is offered (`crossingSuffix`) and saved as it stands; picking that same number back converts it to the owner's unit and picking another number clears it (`Crossing.picked`). With a unit held, a pick keeps the text as typed. The editor asks for the home's word and re-reads what its Gateway serves after a restart. `automationStanding` reads the context: an editor waits while its Gateway's offer is unknown, and a new automation also while the home's sources are being read; `unopenedLine` says what a page without a draft is waiting on. A hint is silent while the field it would name is still blank (`triggerHint`, `actionHint`).
  - **A trigger swapped away comes back as it was left:** the draft keeps each kind it left (`swapped`), which `changedFrom` does not read.
  - **A text's preview is the Gateway's:** the editor asks `automation_preview` for a text that holds a hole, after typing settles, and draws its filled form or the hole it refused (`textPreviewOf`); the phone fills nothing itself. A save's refused hole is drawn under its own field while that text is still what was sent (`refusedHole`), or in the editor's general line when no field draws it (`generalLine`), and a dangerous action's `confirm` asks once and sends again with `confirmed`.
  - **A text with holes is edited on its own page, inside the automation's own edit:** tapping a Message or an IFTTT value names it on the draft (`TextRef`), and the page draws `HoleTextEditor` for it. Every change is written through to the draft, so its back arrow keeps the text, and the system Back closes that page before it asks to leave (`EditorSessions.inner`). It is no second edit session, since `Editors` shows one at a time and would hide the automation's. A hole is painted as the Console paints an expression, from the lexer's own parts (`holePaint` is `consoleTextPaint`), the hint and completions are the Console's for the hole under the cursor, read from that hole's tokens (`holeAssist` is `consoleTextAssist`), and "Names here" lists the trigger's names from its Gateway's row, before the trigger is complete, with what they hold once the preview answers (`namesHere`), then a function's declared values, then the Console's entities. A name inserted where a backslash would escape its brace takes a space first (`holeGap`, read off the part the lexer puts that backslash in).
  - **What an automation runs is a `RunsDraft`, and the Gateway judges the save:** `runsOf` and `headOf` split it into a head (`RunsHead`) and cards, `saveOpOf` builds `automation_save` or nothing when the draft cannot be written, and `PointMode` says how a pointer's function is written (a shared body, an own one, a copy on Save through `madeUnique`). `runsIssue` blocks Save only for what the phone cannot write (no steps, a card that is no step, a Call with no function, a value name it cannot send, a cleared shared name); a broken card is written as typed and saves (`stepOfDraft`, `sentValueOf`), and a value row's line (`runsNote`) never blocks. `runsView` is what the block draws and is null where functions are not served, and `triggerGiven` and `fitOf` in `FunctionFit.kt` twin the Gateway's fit on `tests/fixtures/automation-fit/vectors.json` for the picker's list and the value rows alone. A save's coded refusal reaches `outcomeOf` as data.
  - **Whether a draft would save is the Gateway's answer, asked while editing:** the editor builds the op a save would send (`functionSaveOf`) and, once typing settles, asks `automation_check` with it (`checkRead`, `AutomationOps.check`, always `confirmed`, only where functions are served). `checkedFor` takes the answer only for exactly that op, so a draft that changed is judged by nothing until its own answer lands, and `checkAfter` keeps the last answer through a read that failed. `checkSaidOf` turns a refusal into the same `AutomationSaid` a refused save produces, through the one mapping both take (`automationSavedOf`, then `outcomeOf`), and the page draws `checkSaid ?: session.said` wherever a save's refusal is drawn. A check's refusal blocks Save until the draft changes (`saveAllowedAfterCheck`); a pending or unreachable check blocks nothing, and the save is judged again when sent. A ready check's `issues` are placed by `checkIssuesOf` (`drawnIssuesOf`: the step's path through `keyAt` on the tree `cardsOf` names by `id`, which answers none for a function no page shows) and replace each card's own hint (`cardIssueOf`); a `CardIssue` is drawn by its level (`drawsAsError`), a local issue takes its cause's level from `IssueCause` (`SourceFields.issueOf`, `caseViews`), and a hint with no cause draws neutral until the check answers, and what no card holds is drawn under the Runs block. Issues never block Save, and a save that lands with them says so (`savedIssuesLine`). The hole, unfit and step-invalid refusals are read only for an older Gateway (`skew:step-refusals`). The automation's own `moved` is left to the save's rebase offer. What a body reads is the check's `reads` for the function pointed at (`checkedReads`), else the listed row's. The phone holds no fit rule that gates a save.
  - **A function that changed elsewhere blocks Save and offers Reload:** a pointer-only save names the revision the editor showed (`functionBase`), and the check or the save answers `moved` for the function. `AutomationSaid.FunctionMoved` names that function, and `movedFor` applies it only while the draft still points at it in a mode Reload serves (`reloadable`), so picking another function is not held by it. `AutomationOps.reloadFunction` runs in the edit's own send, re-reads the list, and lands `reloadedFunction`: the listed body and revision, the pointer's extras kept, a typed value carried to the value of the same name and type, with a line when step edits were dropped. That line is an `AutomationSaid.Note`: told without the error colour (`saidRefuses`) and dropped at the next edit. A read that brought nothing newer keeps the draft and the moved state and tells why.
  - **The cards are a tree of steps, each named by a key minted once** (`StepDraft` in `assistant/StepTree.kt`): `Do`, `If`, `Switch` (its cases each a `CaseDraft` with its own key), `Try`, `Wait`, `Exit`, `Note`, `Call`, and `Kept` for what cards do not draw, written back byte for byte. Every edit, text page and said-at names a card by key; a path is derived (`pathsOf`), and a refusal or a last run that arrives by path is mapped to a key (`keyAt`). `cardsDraw` is the one projection the screen draws (cards, side labels, add slots, and `Branch` rows: a CASE with its chips, DEFAULT with what falls to it, an else-if link, ELSE; `AddBranch` for "+ Case" and "+ Else if"), `cardBlocks` groups its rows under the card that owns them by depth, so a card's border holds its sides and nested cards, `moveChoices` lists a card's moves (its own list, the sides of the card above, out of the card drawing it) through `movedStep`, the statements offered are `serves.functions.statements` met with what cards draw (`statementsOffered`), and the caps only refuse an add.
  - **An else-if chain is a reading, never a stored form:** an `If` whose else is exactly one `If` draws as one card (`chainOf`), each link edited by its own key, so an untouched chain writes back byte for byte (`StepTreeTest`). "+ Else if" puts a fresh `If` in the last link's else holding what that else held (`withElseIf`), and removing a link hands its else to the link before (`withoutLink`).
  - **A switch's issues are the twin's, drawn on its chips:** `assistant/SwitchCases.kt` twins `switch-cases.ts` (`caseKey`, `choiceFieldOf` from `lexConsole` tokens, `switchIssues`) on `tests/fixtures/switch-cases/vectors.json`; `caseViews` puts each issue on its chip at its cause's level and `defaultLine` names what falls to the default. A check's issue for a case is not drawn again on the card (`drawnIssuesOf`). The map draws a line per case (`FlowCase`), and a plug is `FlowKey.Plug`. `docs/assistant.md` (the editor) holds what the cards draw.
  - **The stored form is derived at the save:** no name stores flat when every card is a plain action within the flat cap and it holds no values (`flatActions`), else an unnamed function: the one it already runs, or a new one under the draft's `newFunctionId`, minted at its first statement and again for a fresh body. A flatten of a function it ran names that function's revision (`functionBase`), so an edit made elsewhere refuses it `moved`. A Gateway without `serves.functions.unnamed` refuses a tree with no name before the save (`NeedsName`) and keeps values only on a named function (`NameWithValues`). Clearing a name keeps the function as it is, its values too, and copies it first when another automation or a calling function runs it (`othersOf` reads both); "Make unique" of an unnamed function stays unnamed, the picker never lists one, and the list row reads its steps (`FunctionLine.Own`, `ownLine`: a `do` step as a flat row reads it, `doesLine`, and a steering card as its label and the distinct `do` steps it reaches).
  - **A call is a card, and its callee is edited inside the automation's edit** (`assistant/CallCards.kt`): `StepDraft.Call` holds each value `Typed` as the callee declares it or `Read` from a name in scope (`callNames`); the picker lists named functions less any whose calls reach back (`callChoices`), and "New function" mints one at base 0. "Open its steps" pushes the callee's page (`inside`, closed by Back after the text page and the picker, `AUTOMATION_PAGES`), whose cards sit on the draft by function id (`callees`, `CalleeDraft`); keys are unique across trees, so `stepAt`, `withStep`, `minusStep`, `plusStep(tree)` and `movedTo` find a card wherever it sits, and a refusal naming a called function by `id` lands on its card (`cardsOf`). A save sends in `called` each callee the automation still reaches and that changed since it was opened, with the base it read (`calledOf`), and a callee it no longer reaches does not block Save, while its edits still count as a change and are said to be left behind (`droppedEdits`, `holdsWork`: an empty new function holds none) (`reachedCallees`); every reader of a callee's params, calls or issues goes through `functionSource`: the automation's own cards, an edited callee's cards, else the listed row, never an untouched copy, which only its own page draws and which is re-read when its row moved, on reopening (`openedCallee`) and whenever a list lands (`freshened`, `AutomationOps.freshenEdits`); `reachOver` is the one walk over calls, and the issue checks and `stepOfDraft` take the resolver as a required `CalleeParams`; a value the trigger gives is shown as given (`callRows`), and a callee's page names the other automations its edits reach (`alsoRunBy`); its cards preview with its own values (`scopeAt`, `namesAt`), and one the phone cannot write is named on the automation's page (`RunsIssue.InCallee`). A `moved` refusal is read by the `id` it names (`MovedFunction`, `movedIdOf`): the pointed function's Reload, or that callee's alone (`movedCallee`, `reloadedCallee`), and either blocks Save. The editor's on-screen copy is rebuilt whenever an answer replaces a body (`mirrorKey`: the revision and every function base). Pointing at a function carries an edited callee copy of it into the pointer, with the base it read, and drops an untouched one (`pointedTo`), so no reader meets a body no page shows. A Call card's typed value its type cannot read is its hint (`callValueIssue`). A value typed then erased is no value (`withCallValue`), and one its function no longer declares is drawn with Clear and saved for the Gateway to judge (`strayCallValues`). The Call card says when its callee, or one it calls, moved or holds a refusal, a problem or an error the check found (`callLine`).
  - **Run now is the editor's menu item** (`MenuAction` beside `RemoveMenu`): offered for a stored automation that is unchanged, still there and not already asking (`runOffered`); `AutomationOps.run` mints a call id per tap and keeps it while that tap went unanswered, so the retry joins it, holds what the Gateway answered in `runs` for the opening that asked (`runShown`, `runLine`), and reads the list again once a run starts.
  - **A condition is one expression,** edited on the text page in `TextMode.EXPRESSION`, and read by the Gateway as true or false right now (`conditionAsk`, with the names a run sets as `runNames`). A card's last run is drawn only while the editor shows what is stored (`lastRunShown`: the listed row's revision and its function's are the ones it opened, and nothing but `enabled` changed), its paths under the pointer's call (`runPathOf`). A condition is sent and saved as typed, so the Gateway's offsets land on it. "Keep trying" and an event's cool-down are held on the draft and written back.
  - **A declared value is a row with its own key:** `FunctionValueDraft` is minted once per row, and the automation's set values and a step's reference (`FunctionValueReference`) hold that key, never the name. A rename changes one row's name and moves nothing; names are resolved where the draft is drawn, previewed, checked and saved (`wireParams`, `valuesByName`, `stepOf`). A removed row leaves its references pointing at nothing, which blocks Save.
  - **A value the trigger gives is no issue:** fit fills it from the trigger and its row says so. A type mismatch is drawn on its row, and the Gateway saves it as an error, as it does an edit of a shared function's values that leaves another user unfit, a Device value's switch included.
  - **A move carries the functions its event automations run:** `carriedFunctionsOf` in `FunctionCarry.kt` lists each once in listing order, with every function it reaches through calls (a function not listed stays behind), `carryRefusal` refuses before the Router would when the destination does not hold a step kind, and `sealedRefusal` when the payload is over `ASSISTANT_HOME_SEALED_MAX_BYTES`. `FunctionCarryTest` replays `tests/fixtures/automation-carry/vectors.json`.
  - **An event automation's write holds the move lock:** `AutomationHost.carried` runs its put and delete under `AssistantOps.writes` and refuses one whose Gateway is no longer the home once it holds the lock, so a move seals a write or the write is never sent. The caller says what it read: `save` and `delete` take the stored body the edit was made from (`draft.original`, a row's automation), and the lock is taken when that or the body being written is an event automation. A function write reads its listed row's `moves`; a missing row at the assistant's home takes the move lock. Any other automation stays where it is, so its write goes straight to its Gateway (`movesWithHome`), and its editor stands when the home leaves (`editorStands`).
- `android/.../assistant/FlowMap.kt` / `FlowLayout.kt` / `FlowReplay.kt` / `FlowSheet.kt` / `FlowMapView.kt` - Automations as a flow map: the graph and its facts, the layout, the replay, the card's model, the canvas. `docs/assistant.md` (The map) holds the rules
  - **The graph is read from the walk alone, and a style from one fact:** `flowGraph` takes nodes and lines from `reached` and the pointer's own row, `flowFacts` maps the last runs onto them by step path, and colour, pattern and weight are each a `when` with no `else` over one fact, so a new fact does not compile until each channel answers it.
  - **The band only renders and calls:** a selection is read through `selectionAfter` and a replay through `replayStands` at draw, and the replay's play, end, pause and scrub are `Replaying`'s, so a refresh never leaves a stale selection or replay drawn.
- `src/shared/schemasAssistantRecord.ts` / `android/.../AssistantRecordRules.kt` - the outcome enum and per-thread shape an action's answer and its record row share; the phone's reading of a record row: `recordOf`, `isQuietRecord`, `threadRows` (a run of quiet records as one row), the view the thread page draws, and the codec
  - **A quiet record carries nothing an older phone would show:** `ConsolePushEntrySchema`'s refine ties `notify` to a summary in `body`, so an older phone shows a response and drops a quiet row. The new phone keeps a quiet record out of the burst, alerts, autoplay, `countsUnread` and the session card's reads.
- `src/gateway/sessionBaseline.ts` / `compose/composeBaseline.ts` / `src/shared/session-baseline.ts` - the baseline a compacted session reads back, its loopback door, the push a compaction's end raises for a CLI no hook hands its baseline, and its wire shape and lines
- `src/vault-askpass/askpass.ts` - the askpass helper's decision over gateway, tty, and clock ports; the tty race and the no-tty hold
- `src/gateway/` - Docker-side HTTP and WS router
- `src/gateway/composeGateway.ts` - the compose stages in order, fault port, cycles, and `close`; `index.ts` is the Bun adapter
  - **Close is one fenced phase:** it refuses intake first (activation, HTTP with 503, new sockets, inbound
    Router frames other than call replies, Router reconnects), drains the inbox pump and the stages while the
    Router stays connected, flushes, then stops everything with the pump and the Router client last. Every
    step runs even after one throws, and a second `close` joins the first.
- `src/gateway/compose/gatewayTypes.ts` - `GatewayConfig`, `GatewayDeps`, `GatewayGraph`, and the `GatewayFaultPort` the harness drives
- `src/gateway/compose/federationContext.ts` - the one federation reader; activation publishes boot, Domain id, and slice together
- `src/gateway/compose/composeBootstrap.ts` - directories, identity, keyring, boot decision, schema wipe
- `src/gateway/compose/composeStores.ts` - every durable writer and the restored session-resume payload
- `src/gateway/compose/composeSessions.ts` - registries, `SessionStore`, planes, presence, session authority
- `src/gateway/compose/composePersistence.ts` - the flush every writer takes part in, and its tick
- `src/gateway/compose/composeHost.ts` - the host socket, wake service, host relay, presence watch, and the typed pane wait
- `src/gateway/compose/composeAgents.ts` - one stack per agent backend: its service, relay, and HTTP route
- `src/gateway/compose/composeAwareness.ts` - awareness bank and watches; five-second agent sampling dirties presence when the owner set changes
- `src/gateway/compose/composeFederation.ts` - `buildSlice`, the Router client, and the share mirror's registration read and delta apply
- `src/gateway/compose/composeEnrollment.ts` / `src/gateway/federation/enrollPending.ts` / `src/gateway/router/routerExchange.ts` / `src/shared/schemasEnrollSetup.ts` - a setup that has not finished: the arm, the asks and the install; its record on disk; the pinned HTTPS exchange it asks through; the two loopback routes' wire. `docs/federation.md` holds the flow
  - **A status read is the only thing that asks:** `status()` makes one ask when three seconds have
    passed, and no timer does, so a Gateway with no setup screen open is silent.
  - **The pin is the certificate seen at this arm:** read again on every arm and resume, required of
    every ask, and required of the bundle's own transport. `routerExchange` reads the peer
    certificate before it writes, leaning on no HTTP client's pinning; `check:pinning` runs it under Bun.
  - **Arming is refused while a transport is installed:** `arm` answers `already_enrolled`, so a
    re-enroll is setup's one stop, clear and start, and a boot that finds a transport retires a
    leftover record.
  - **The Gateway that just enrolled dials the address it was armed with:** `onInstalled` hands it to
    the federation stage, since the container is not restarted between the prompt and the install.
- `src/gateway/compose/composeWebSockets.ts` - session sockets and held-delivery handover
- `src/gateway/compose/composeRoutes.ts` - the route surface, built once a Domain is active and rebuilt when federation activates; passes the host relay to session typing
- `src/gateway/compose/composeRouterFrames.ts` - Router frame dispatch and the console dispatcher
- `src/gateway/compose/composeRouterPresence.ts` - the Router presence dirty hook, unlink and untrust teardown
- `src/gateway/compose/composeListener.ts` - the HTTP entry point
- `src/gateway/compose/composeFaults.ts` - the fault port's construction
- `src/gateway/httpRouter.ts` - HTTP dispatch, including `/session/type`, the setup routes, and blob routes; before a Domain it answers health, the setup routes and `/federation/retire` alone
  - **`/enroll/arm`, `/enroll/status` and `/federation/retire` take the host's token:** every
    devcontainer on the Gateway's network reaches this port, and only the host holds `HOST_WS_TOKEN`.
- `src/gateway/routes.ts` - `RoutesDeps`, `RoutesCarryOver`, and the composer that wires session typing with the other route modules
- `src/gateway/routes/addressing.ts` / `callerGuards.ts` / `relay.ts` - local address minting, the refusal gates, cross-Gateway relay
- `src/gateway/routes/routesStatus.ts` / `routesCapabilities.ts` / `routesPresence.ts` - health, pending and teams; the capability fold; discovery
- `src/gateway/routes/routesSession.ts` - `/session/type`, authenticated against the caller's own host-session record, for a CLI whose delivery is typed
- `src/gateway/routes/routesSend.ts` / `routesRespond.ts` / `routesBoard.ts` - the send and `deliverEvent`, the senderless source event, sharing `reach`; the reply and its poll; the task board
  - **Who reads a reply is read off the job:** `readerOf` in `pending-job-store.ts` answers `phone` or `session`, or nothing for a job an older Gateway relayed. The send stamps it on the delivery and the relayed op, the tag names the reply's fields from it, and the reply route drops spoken tiers for a session. `docs/console.md` holds the rule.
- `src/gateway/routes/routesHumanNotify.ts` / `routesBlob.ts` - console push, and the local-then-Router blob read
- `src/gateway/boot.ts` - `GatewayBootstrap.resolve`, the boot phase decision, the federation slice types, and `RouterHandlers` split into frames and presence
- `src/gateway/router/registerAuth.ts` / `valueResult.ts` - the `gateway_register` frame and the `value_result` settlement, pure
- `src/gateway/wake.ts` - container/session wake decisions
- `src/gateway/wakeService.ts` / `launchRecords.ts` - one launch per team, whichever door it came through; the durable launch records, the one give-up authority, and who each launch tells. `docs/architecture.md` (One launch road) holds the rules
  - **A create is a wake with the create door:** `beginWake` is the only road, the create door goes only for a record just made, and the Gateway never emits `createSession` (`HostOp`); the daemon reads it as `LegacyCreateSessionOp` until its dated removal.
  - **A waiter settles nothing:** a timeout or a dropped link leaves the record to its tick (live, then the countdown), and a live team wins over a late failure.
  - **A routine run is a requester, never a reader of time:** it joins its launch and is told (`tellRoutine`, `runner.launchEnded`); `awaits(run)` holds it until told, so no walk relaunches a build.
- `src/shared/claude-session-cut.ts` / `src/mcp/devcontainer/sessionCut.ts` / `src/gateway/sessionCuts.ts` / `src/gateway/compose/composeSessionCut.ts` / `src/shared/schemasSessionCut.ts` / `src/mcp/cut/cutTools.ts` / `android/.../SessionCut.kt` - a Claude session compacted above a picked message: the file rules (index, plan, build, read-back, `pickTurn`), the daemon's host op, the Gateway's road (ask, close, build, repoint, wake), its wire, the session's summary tool, and the phone's rules. `docs/architecture.md` (Cutting a conversation) holds them
  - **The source file is only read, then deleted once the session is back on the new one:** the build lands beside it under a new id, and a wake on that id queues the old one's delete. The record keeps what a cut replaced in `cutFrom`, which a forget deletes.
  - **A launch waits out a cut** (`WakeService.hold`), so it resumes the conversation the record names once the cut repointed it.
  - **Every check that can refuse runs before the close:** a plan bounded by the request's marker, so a cut that cannot land leaves the session running.
  - **The CLI pin is exact:** `CUT_CLI_VERSIONS` names each Claude Code version a cut was proven on, and an update refuses cuts until it is added.
- `src/gateway/sessionEnd.ts` / `purgeQueue.ts` / `purgeHolds.ts` / `src/mcp/devcontainer/sessionPurge.ts` / `src/shared/session-files.ts` - the one end of a session on every road that removes one; what ended sessions, agents and workflow steps left at their places, queued in the session snapshot until the daemon deletes it; the one read of who still holds an entry; the daemon's delete of one thing at one place; Switchboard's own files for a session name. `docs/architecture.md` (One end) holds the rules
  - **Removal and its deletes are one write:** the end reads the ids, removes the record, queues, then saves, and never waits on the host. An agent's retirement queues its thread before the catalog write and takes it back when the write fails.
  - **An entry names its place with no daemon connected:** a container by its project alone, an agent's thread by the agent's own target. The drainer fills the path from the catalog at the delete, so ending a container session while the daemon is away still queues everything.
  - **A forgotten session leaves nothing that names it:** the end drops its held jobs (`PendingJobStore.forgetTeam`) and its queued deliveries and settles its inbox address (`settleAddress`), each step alone so one that throws skips no other; the Router's `onSessionForgotten` listeners cancel its armed scheduled send, withdraw its shares and delete its read anchors, each answering false for a write that did not land so the Gateway reports the forget again. Unconfirmed forgets ride the session snapshot (`routerForgets`), and one still owed lands before the upsert of a session created again under its name. The Router's op ledger is keyed by op, so no forget reaches it: `sweepOpLedger` would drop an entry a week past its row's lifetime, a batch per pass in one write, and nothing registers it on the Router's pass.
  - **The one sweep** (`src/gateway/purgeSweep.ts`, `src/shared/schemasPurgeSweep.ts`, `scripts/purge-sweep.ts`): a `threads` host op lists a backend's whole store at a place through its driver's `listThreads`, the Gateway keeps a roster session's own conversation, every id a record held unread names and what either spawned, skips what runs or cannot be read, and deletes the rest through the purge queue. A thread stays as the one it was spawned under does. A dry run answers counts and a fingerprint of the threads and of the orphan names; an apply names it and a set that moved is refused. `/purge/sweep` takes the host's token. `docs/architecture.md` (One end) holds the sorting rules.
  - **A listing is whole or it throws:** a driver that cannot page to the end of its store answers nothing, so no count is taken from part of one.
  - **A running session CLI holds back what it may have moved to:** an OpenCode or Copilot record keeps its launch conversation id, so an unnamed thread touched since a connected session at that place last touched its own is left, and the dry run prints the bound (`SweepRow.liveSince`).
  - **The Router sweeps its own leftovers each pass** (`sweepOrphans` in `scheduledService.ts` and `readAnchorsService.ts`): an armed send or a read anchor naming a session no admitted Gateway reports (`reported` in `ownerServices.ts`), a day past its last touch. A Domain that cannot be read sweeps nothing.
  - **Only `deleted` and `gone` retire an entry:** a place that is down, an older daemon's refusal and a failed delete all retry, and 30 days drops one unasked.
  - **A host place names its spawn point, whose home the daemon opens** (`spawnHome` in `hostDaemon.ts`): its own for `host`, the Windows profile for `windows`, place down while that is out of reach. A thread at a spawn point no driver reaches (`driversReach`) is not queued.
  - **`purgeHolds` is the one read of who holds an entry:** its pane, its files, its conversation. A record of another host spawn point holds the pane alone; a record that resumes a conversation, or a running run's named thread, holds it whatever name queued the delete. A new holder is a reader row, never a branch in `drainOne`.
  - **Only a home that was found answers `gone`:** `createPurge` checks the home it is about to search is there (host: place down; a container: the delete fails), and `session-end-residue.test.ts` names every plain removal of a record that does not go through the end.
  - **The queue counts what a workflow run's seven day removal still found** (`BackstopTally`, on `/health` as `backstop`): an agent still tagged, or a delete that answers `deleted`. Zero is healthy; a `workflowDelete` counts nothing.
- `src/gateway/sessionAuthority.ts` - sole owner of credential-field access; residue-tested
- `src/gateway/presence.ts` / `readAnchors.ts` / `hostOpCoordinator.ts` - session presence including running-agent `teammates`, read anchors, host RPC correlation
- `src/shared/schemasPresence.ts` `DerivedPresenceSchema` - what the daemon derives from a pane, the `presence_derive` frame
  - **One schema, every road:** the daemon's state, the frame, the Gateway's parse, `TeamInfo`'s derived fields (`projectDerived`) and the one equality (`sameDerived`) all read it. A new field is a schema line, its derivation, and on the phone a `Presence` property that `reported` must fill to compile.
  - **A Copilot compaction is read from Copilot's own events file, never the pane:** `copilotCompaction.ts` follows `~/.copilot/session-state/<id>/events.jsonl` for each watch entry of a CLI whose row says `copilot-events`, under the record's `mintedSessionId`, which the Gateway puts on `presence_watch`, and `PresenceScheduler.setOverlay` merges `compacting` into every report, so the phone needs nothing new. The pane's spinner line scrolls off in seconds while the compaction runs for a minute.
- `src/gateway/router/boardClient.ts` - Router-held task board client
- `src/gateway/router/vaultClient.ts` - vault sealing/opening, delta-held Router list, approval-gated values, and the gateway write
- `src/gateway/vault/decisions.ts` / `requests.ts` / `vaultRoutes.ts` / `answerEntry.ts` / `remember.ts` / `reconcile.ts` - grants and `displayShape`; request rows that settle once, admit a joining caller, and cap open requests per target; loopback routes, each resolving the one principal, a session by its token; a typed request answered from a held entry, the policy a remember writes, and the one reconcile over the open requests
  - **A grant resolved through a policy is qualified by it, and `qualificationRefusal` is the one
    reading of when the policy stops answering:** gone, disabled, rebound, selector dropped, or
    another revision. `covers` checks the policy before the holder and holds a qualified window to
    the one key it was given for, `policyMoved` and `policiesListed` prune, and `requests.answer`
    runs the same reading at the tap before any grant is minted. A grant, an entry request and a
    scope carry one optional `PolicyRef`, on the wire and in memory, so half a qualification cannot
    exist; the schema refuses a standing grant with one.
  - **The value is read as it leaves:** `release` resolves the entry through `usable` at settlement
    on every road. `decide` carries no value thunk, so a request-time snapshot cannot return.
  - **A policy selects; a title is a label:** the askpass route looks the line's selector key up
    with `byKey`, and the one enabled policy naming it, whose bound entry `usable` accepts, opens
    an entry request carrying the policy at the revision held now. Anything else opens a typed
    request that says why (`why`), carries `runsAnything` for a key that runs a shell (`runsAnything`
    in `decisions.ts`), `cannotRemember` for a key `rememberable` refuses, and `answering`, the
    usable entries already answering sudo, for a sudo key alone (`answeringOf`, `keyProgram`): one
    password answers every sudo command, which no other program promises.
  - **A policy's revision is stamped on a request in three places, each read from the store at that
    moment:** the askpass route, `answerEntry` (an entry answer qualified by the policy it just wrote or
    held, `rememberedPolicy`) and the reconcile (`takeOver` opens the entry request a policy resolves
    for a typed one, `reviseEntries` restates a waiting one at the revision it reads).
    `covers` trusts a scope's revision only because nothing else stamps one. A capture creates an entry and never a policy; a session's line becomes a selector only
    through the owner's tap on a card that prints the key.
  - **A typed request answered from a held entry reads, writes and answers in one synchronous
    stretch:** `createAnswerEntry` waits for `use.ready()`, claims the request (`claimTyped`), checks
    the entry is `usable` and, with `remember`, that the key is `rememberable` (its own `selectorKey`
    and within `MAX_SELECTOR_LEN`), writes the policy through `rememberedPolicy` (a `name` creates, none
    adds at the held revision; it never enables, rebinds or touches another entry's policy), then
    answers qualified by it. A refusal gives the claim back (`unclaim`) and leaves everything as it was.
  - **One reconcile reads every open request against the committed policies:** `createVaultReconcile`
    runs after each policy write, on the persist tick (`vault.tick`) and when a vault read lands
    (`onRefreshed`). An entry request its policy still selects is restated at the new revision in place
    (`reviseEntries`, `revise`), and refused only on a reading; a typed request a policy now covers is
    answered by a covering grant or taken over by an entry request that names it (`takeOver`,
    `replaces`). `stop()` at the Gateway's close lets a pass in flight take nothing over.
- `src/gateway/vault/operationSet.ts` - the set a window grant covers
- `src/shared/command-wrappers.ts` - the wrapper table read from each program's help, and `peelWrappers`, the one see-through both a grant's set and a policy's key take
- `src/shared/selector-key.ts` - the one shape rule, `shapeFrom`; `selectorKey`, what askpass presents and what a policy stores; `withoutAskpassFlags`, the one walk the helper's brief and a policy's keys both take, so `sudo -A apt` keys as `sudo apt`; `parseSudo`, the one parse of a sudo line that `withoutAskpassFlags`, `selectorKey` and the warning (`sudoCommand`) all read; `keyProgram`, a key's first word
  - **The key sees through what sudo runs, never sudo itself:** after `sudo`, leading `VAR=value` words and the table's wrappers are peeled, so `sudo env DEBIAN_FRONTEND=noninteractive apt-get install` keys as `sudo apt-get`. One of sudo's own options keeps the whole line, as before, and a wrapper left running a string keys its whole line. Sudo's options are read once by `parseSudo`: a valued flag's value attached or the next word, long options with or without `=`, and `--`, which stays only before a dash-led command. A key is its own `selectorKey`, pinned over every short line of awkward tokens by `schemas-policy.test.ts`.
- `src/gateway/compose/composeVault.ts` - vault client, decisions, requests, routes, and console operations
- `src/shared/schemasDevices.ts` / `src/gateway/devices/store.ts` / `driver.ts` / `road.ts` / `shapes.ts` / `scan.ts` / `homeNetwork.ts` / `kasa/` / `src/gateway/compose/composeDevices.ts` / `src/mcp/devcontainer/kasaScan.ts` / `wifiNetwork.ts` / `src/testing/fakeKasaPlug.ts` - the device layer: the wire, the durable store with tombstones, the driver contract, the one road every handler takes, the decline projections, the Gateway's relays to the daemon's scan and its WiFi name, the Kasa driver on its own XOR transport, the handler bodies, the daemon's broadcast scan and WiFi read, and the loopback fake plug. `docs/devices.md` holds the design
  - **Every handler goes through the road:** `composeDevices.ts` holds the handler bodies and cannot name a store or a driver; `device-road-residue.test.ts` reads it. The road takes a bound per call and knows no surface: `BOUND_MS` in `composeDevices.ts` gives the console and the assistant theirs (`ASSISTANT_WAITS.action`) and `AUTOMATION_ATTEMPT_MS` is an automation attempt's, with nested per-plug bounds, all drained by close. It owns the per-device queue raced at its start against the lease, the close fence, the toggle doubt and the one failure map (`declineFrom`).
  - **The deadline gates starting an effect, never committing one that landed:** a plug answer that arrives after the deadline still commits.
  - **One op table, typed answers:** a device op is its request in `DEVICE_CONSOLE_REQUESTS` and its result in `DEVICE_CONSOLE_RESULTS`; a new op is those two entries and a handler, each compile-checked. A result is `ok` or `refused` with a closed `code`, an `effect` and an optional `landed`, so no reader parses a reason.
  - **The effect latch says whether an effect may have landed:** `mutateWithIdentity` opens an attempt after the identity read passes and before the mutation is written, and denies only that attempt when the plug refuses it or the transport never wrote it. The latch stays marked while any attempt of the operation is undenied, so a later step's refusal cannot hide an earlier step that landed. The transport's `sent` is its own typed fact, and the road is its only reader, to answer not started.
  - **Identity before every mutation:** the driver reads `sysinfo` and sends nothing on a MAC mismatch, so a reused DHCP address cannot switch the wrong plug.
  - **The scan is a closed host op:** no caller input, the daemon's own four-second window under the host bound, typed candidates; the Gateway answers a daemon that is down or late as a refusal, never as an empty list.
  - **The fake plug applies a held command:** `hold` runs the command and withholds only the reply, so a held relay command flips the fake's relay; one `waitForHeldReply` takes one hold.
- `src/shared/ble-recognition.ts` / `src/shared/device-definitions/` / `src/gateway/devices/sensorReadings.ts` / `readingsHold.ts` / `thresholdConversion.ts` / `src/mcp/devcontainer/bluetooth/` - Bluetooth sensors: a family recognized by its catalogue markers, the definitions that read a model's adverts, a sensor's read and 24-hour low and high, the readings hold the road ingests into, the dated conversion of stored thresholds, and the daemon's BlueZ client over its own D-Bus wire. `docs/devices.md` holds the design
  - **A threshold is a crossing automation, and a sensor stores none:** the owner writes it in the automation editor, and the sensor's page only lists the automations that watch its numbers. Until 2027-01-15 `thresholdConversion.ts` rewrites the thresholds an older build stored, `value` automations over a band field, as crossings under the same ids, once per sensor, before fields evaluate, and retries a write that did not land on the persist tick. It reads `sensor-thresholds.json` and never writes it, so a build before this finds it as it left it, though that build runs no crossing; `sensor-thresholds-converted.json` holds the sensors done, and the removal deletes both files. A converted row lands before its old band field is removed, so it keeps that row's cool-down.
  - **The store's parts are files of their own:** `automationState.ts` holds the state shape and `restore`, `automationValidity.ts` what makes an automation invalid or unarmed here, `automationWords.ts` its sentence and the names a trigger reads, `automationSteps.ts` a step's words, natures and rules; each takes what it reads as arguments, never the factory's state. `src/gateway/compose/composeAutomations.ts` builds computed fields and automations as a pair in their one order (`openAutomationPair`) and holds the automation console handlers, and the test fixtures build through it.
  - **One fire, one road** (`src/gateway/computed/automations.ts`, `automationFires.ts`, `automationSteps.ts`, `automationOutbox.ts`, `automationLog.ts`, `automationRunner.ts`, `src/gateway/compose/automationActions.ts`): `drain()`, `tick()` and the lane's `arrived` only record a fire, in the commit that moves the checkpoint or slot, or after the poll's own commit. It holds the record's revision, the trigger's names, the fields it tells, one record per action keyed by step path (`StepPathSchema`, ordered by `byPath`) with the step whose turn it is in `active`, a `frames` record for each function call it entered, and its own tells as read (`resolved`). `pump` is the one reader: it commits and starts what one pass answers (`createPass(ports).pass(input)` in `automationPass.ts`, which reads the state, the answers that came back, the clock and read-only ports, and touches nothing else). The rules a pass follows are pure functions beside it (`nextEffect`, `claim`, `admit`, `mayRun` and `outdatedSets` in `automationFires.ts`, `dueAt`, `heard`, `recovered` and `retries` in `automationSteps.ts`, `roomFor` in `automationOutbox.ts`, `logged` in `automationLog.ts`), as `agentFrameLedger.ts` is to its relay. `RUNNERS` is keyed by every `EffectKind` and `AUTOMATION_ACTIONS` by every action kind, so a new kind does not compile without its row, and `run_function` has no runner because it is a pointer. The run reads the row, never the kind: an effect whose row says `home` is refused unsent away from the home, a text is clipped to its parameter's `max`, and the one check of an action's values (`argsIssue`) reads every `switch` parameter.
  - **How a frame moves through a tree of steps is one pure function** (`moved` and `entered` in `automationFrames.ts`): given a body, the address whose turn it was (indexes and sides), how that step ended and the frame's first uncaught failure, it answers the next address, the catch entered with what it caught, or how the frame ended. `tests/fixtures/automation-frames/failure-table.json` is the failure table, a Gateway-only corpus and so not a `vectors.json`. The pass moves every frame through it.
  - **A block opens a strand per branch, and one rule ends an owner:** `parallel` gives each of its steps a cursor (`branchesOf`) and stays open, as a call does while its function runs. A strand ends at its root (`moved` answers `strand`), remembers its own first uncaught failure in `frame.strands`, is guarded only by a `try` inside it (`guardOf`), and ends alone at a `throw`. An owner (a block, a call's frame) is over when no cursor remains beneath its path (`settleOwners`): a block ends done, or failed `together` with `errors`, each failed branch's first in written order, which a `try` around it catches as `e.errors`. An `exit` written inside a strand and a body wider than `RUN_STRANDS_MAX` (`widthOf`) are errors; through calls the cap is held at the block's turn (`TOO_MANY_BESIDE`). A set is dated by the last wait before it in its own strand or one around it (`intentAt` with `rootOf`), never a sibling's. The last run serves every step in flight as `beside`.
  - **A task is a `start` step's record** (`src/gateway/computed/automationTasks.ts`): at its turn a `start` opens a strand on its list, keeps its task under `as` by a key no record a person writes is read as (`$task`, and `$all` and `$any` for a join, in `src/shared/task-values.ts`), and its cursor moves on at once; its record stays open until the strand ends, by the one rule that ends an owner (`settleOwners`, which ends the task and goes on up, since a task's end moves no cursor), done or failed with the strand's first uncaught failure, and takes its place in the order tasks ended (`ended`). A task reads how it stands each time a step reads it, at any depth of a kept value (`dressed`: `done`, `failed`, `error`, shown as `running`, `done` or `failed`), and is kept by name alone (`kept`); `all` and `any` are builtins over tasks and joins (`joined`), so joins nest. An `await` reads its expression once through the read slot into `awaits` (`waitedOf`: a task, or `all` or `any` of tasks and joins), refuses a value that names no `start` record of this run (`NO_TASK`) and one that could never end (`waitsForever`: what can end grows from the tasks ended and those with no open await beneath, until nothing more joins it), then waits in the pass until `awaited` answers: one task's outcome, `all` failed `together` with each failure, `any` the first to end by `ended` and never failed. One task and `all` mark what they took `seen`; a frame's end waits for every task it started and remembers the first failed one no await saw (`unawaited`). A task's width counts beside the steps after it, and a catch's beside what its try started (`widthOf`); a start past the cap at its turn ends refused.
  - **What each step kind does at its turn** (`advance` in `automationPass.ts`, `readSteering` in `automations.ts`): `try`, `exit` and `note` end at once and the walk reads what they mean (`howOf`); an `if`'s condition, a `switch`'s subject (as the text a hole holding it prints, `shown` on the holes port), a `let`'s value, a `wait`'s minutes and a `throw`'s text are read once through the pump's read slot, which ends the step (`steered` with the side or the case taken, `failedAs` with a code and a sentence) or stores when a `wait` ends (`until`), over at the first pass after it. A condition that is not true or false, or cannot be read, fails `unread` and takes neither side; a subject that cannot be read takes no case. A frame keeps `vars` (a `let`'s values, JSON within `FRAME_VAR_BYTES_MAX`, `FRAME_VARS_MAX` of them) and `caught` by its try's path, which `scopeOf` hands a step as names: the trigger's, the function's values, the variables, and `e` (the failure, printing its sentence) inside a catch. A steering step logs a row only when it fails.
  - **A tree's step checks are one entry per kind in `STEPS`:** a condition, a value and a wait's minutes must parse against the names in scope (`namesIn`: the trigger's, the function's values, every `let` name, `e`), a `let` taking a name a value or the trigger holds is an error, a literal wait is within `WAIT_MINUTES_MAX`, a `throw`'s text is checked as any text with holes, and `functionIssue` and `functionReads` read every depth through the walk's `stepsOf`. An expression is checked as a bare source (`expressionIssue` in `liveConsole/holes.ts`, the port's `expression`), never wrapped in braces as a text, and `holesOver(registry)` is the one build of the holes port. An issue names its step by its numbers under the function, `step` beside `param`, and a kept name that shadows an entity is a warning there. A blank condition or value parses and is an error. A `do` step's `as` is an error while its action's catalogue row has no `gives` (`GIVES_NOTHING`), which is every row today; the first row that gives stops the build until the step's end stores its result. `serves.functions.statements` lists the step kinds this Gateway runs (`FUNCTION_STATEMENT_KINDS`, keyed by every kind), beside `steps`, the actions a `do` step may name; a Gateway that answers none runs `do` alone.
  - **A condition is previewed by the Gateway, as a text is:** `automation_preview` takes one request (`PreviewRequest` in `automationPreview.ts`: the trigger, an optional text with the function's `params` and `values`, an optional `condition` and the `runNames` a run sets before that step) and answers `condition` as `holds`, an `unread` reason, or the `issue` a save would refuse. A condition that parses only with the run's own names reads a value an earlier step keeps, so it is never evaluated; one with no event to read says no event has come in yet; a value that is not true or false says so. The checks are the save's (`holes.expression`), so the preview and a save cannot disagree.
  - **A strand's steps run in written order, one at a time, and a run has one strand unless a block opens more:** the pump holds up to `EFFECTS_MAX` attempts in flight across every run (`nextEffects`), never two to one device, and among one run's open steps on a device the one written first goes first, a retry included. A failed step is logged and the next runs. An attempt answers `done`, `refused`, `unreachable` or `no_answer`, or is a hold, which is no attempt and is taken back off the step. `attemptOf` maps the road's `Outcome` for the automation port, with `FAILURE_WORDS` for a driver failure whose effect did not land, and the IFTTT mapping sits beside it; `KIND_NATURES` beside `RUNNERS` gives each effect `sets`, `sends` or `nudges`; `RETRIED` in `automationSteps.ts` is the one table of nature against word. A throw before anything was sent is a hold, and a port's throw is `no_answer`.
  - **Each step keeps trying for its own ten minutes:** `KEEP_TRYING_MS` from its turn (an automation's `keepTryingMin` sets the window of every step of its run, its own and a function's alike), backing off `BACKOFF_MIN_MS` to `BACKOFF_MAX_MS` from each answer, and a step that only ever held ends `unreachable`. Nothing is refused for lateness, and a tell is never refused for age. One due time orders the runner: a first attempt is due at its turn and a retry at its last answer plus its gap (`dueAt`), and `nextEffect` over the `Runnable` steps takes the one due first, so neither side starves. A read has its own slot beside the effect in flight, so a message's holes are read while another fire's effect is out; a text whose fill throws is used with its holes marked (`fillerOf`), for a tell and an effect alike.
  - **An attempt carries its bound, and the transport says when a plug never accepted:** each caller hands the road its bound, `AUTOMATION_ATTEMPT_MS` for an automation (`BOUND_MS` is the console's and the assistant's), the queue counted. A bound that passes while the op waits in the device queue is a hold; a connect that never opens within `KASA_CONNECT_MS` (`connectBy` in the Kasa transport) is `unreachable` for every caller; one that passes after the command was written is `no_answer`. An IFTTT attempt has the same bound, its vault read counted (`iftttClient.trigger(params, bound)`), and one whose bound is spent when the read returns is `not_ready`, a hold. `DEVICE_READ_WAIT_MS` sits above `KASA_CONNECT_MS`, so a dead plug reads `unreachable`.
  - **The effect latch alone says whether a command went out:** `effectLatch` in `driver.ts` is marked while any attempt is undenied, `carries` says the operation means to change the device, and a driver calls `carry()` before its first command and `attempt()` before each write. `effectLatch(mayStart)` takes its floor check as a required argument and `attempt()` throws unsent when `EFFECT_FLOOR_MS` of the bound is not left when it is called, and `declineFrom` reads a timeout with the latch unmarked and `carries` as not started, whatever an earlier read of the operation wrote.
  - **A restart judges each step by its nature** (`recovered`), read from the fire's own body: a claimed `sends` or `nudges` step ends `no_answer`, a claimed `sets` step resumes inside its time and ends `timeout` past it, a step between attempts resumes, and a step that never began an attempt forgets its start. A stored start ahead of the clock is clamped on every judgment. `readFire` reads the shape 8.14.84 stored until its dated removal, and an unreadable fire is dropped with one `uncertain` row.
  - **A fire reads the version it fired:** the state holds each automation body a held fire refers to, by `versionKey`, in `versions`, and each function body by `frameKey` in `functionVersions`; `commit` is their one writer (`pinned`, `pinnedFunctions`), and `bodyOf` and `stepAt` answer every question about a step after the fire (its nature, the kind on its log row, the switch a landed set names, the runner and the tell's text). A fire with no body retires. The retire order (`retireOf`) is: the automation gone or another incarnation; `enabled: false` (`SWITCHED_OFF`); no pinned body; a started run, which continues on the body and frame it pinned; an unstarted fire at another revision; then the automation's own unarming issues, its function left to frame entry. So an edit retires only an unstarted fire, and a function's revision change never retires one. A fire that retires is never resumed or retried: `settle` decides `retireOf` before recovery and before answers land, `natureAt` answers no nature for it, and a retiring fire ends every step it began with what is known: a claim ends `no_answer`, an open step with a last word ends with it (`endHeard`, through `timedOut`) and logs its row, a step that never heard one logs nothing, then one retire row covers the steps left unreached, none for a finished fire.
  - **A function call is a frame entered at its turn:** `enter` pins the function's version and opens the frame on its first step, the call's own record staying open until the frame ends. Inside a frame `fire.active` names each step whose turn it is, one to a strand, and nothing scans for them: a step's record is made at its turn, and `advance` in `automationPass.ts` asks `moved` where a cursor goes once its step ends. A frame that ends with a failure nothing caught ends its call refused (`CALL_FAILED`), the row after its steps' own. A function gone or unread at entry ends the call refused (`FUNCTION_GONE`, `FUNCTION_UNREAD`), one whose bindings do not fit fails it `unread` with `STEP_ERRORS` before any step runs (`entryIssue`), a step with errors fails `unread` at its own turn (`errorAt`, `STEP_ERRORS`), and each step reads its values once at its own turn (`frame.resolved`), a value it cannot read ending it refused (`VALUE_UNREAD`, `STEP_UNFIT`, `FRAME_UNREAD`) rather than throwing. A function's tell is a step told through the outbox under `stepMember`, and `AutomationHoles.evaluate` and `evaluateHole` read an expression beside fill. An event trigger's `coolDownSec` is measured from its last admitted match, or from a match the lane alone tells (`firedAt` per automation and incarnation), and logs one `COOLING` row until a run comes between. It covers the lane too: `eventsOf` answers `cooling`, and a cooling automation wakes nobody (`wakers` in `composeAssistant.ts`). A crossing's and a value's cool-down stay their checkpoint's.
  - **A `call` step enters a frame at its own path, with what the call gives:** at its turn the step's values are read once in the caller's scope (`calledOf`, kept in the caller frame's `resolved`), then `entering` opens the callee's frame under the call's path, holding those values (`frame.values`), which is all a callee reads of its caller beside the trigger's names. A callee's end is its call step's end: done, or failed `call_failed`, which a caller's `try` catches as any failure and anything else remembers while its body carries on. A loop is held twice: the judge refuses a save whose calls reach a function again (`loop`), and `enter` fails a call into a function already on the frames above it, or past `RUN_FRAMES_MAX` frames, since a frame pins the version it entered and an edit behind a waiting run could close a loop no save saw. An edit of a callee changes nothing for a run already inside it.
  - **A newer set ends the older open ones:** when a set lands, every older open set of that switch ends refused (`outdatedSets`, `NEWER_SET`); a toggle never ends a toggle, and the switch and nature come from the body the landed fire fired with, so an edit of the newer automation hides nothing. The newest landed set per switch is held in `landedSets`, so a function step that resolves to a `device_set` after a newer fire of another automation set that switch ends `NEWER_SET` too, its switch read from `frame.resolved`. A run's sets are dated by `intentAt`: its fire, or the end of the last wait it passed, so a step after a wait does not lose to a set that landed during the wait.
  - **A read lands only on the run it was read for:** `readStep` and `readSteering` find the run by `sameRun` (member, incarnation, revision, seq and time), never by member alone, since an event's member is admitted again once it leaves the `fired` list. A read whose run is over answers that the pump should run again (`unwanted`), so the next reader does not wait for a tick.
  - **Only "nothing was sent" is a hold:** the vault not answering yet, the devices not loaded, and the road's own not-started, which `DeviceStage.automationSet` answers as the road's `Outcome<void>` with no word of its own. An unreachable plug is `unreachable`, tried again for `sets` and `sends`; a refused identity and an IFTTT key that is gone are refused at once, and an IFTTT post with no response is `no_answer`.
  - **Admission gives each automation a share:** `admit` supersedes an unstarted fire only when an earlier pass stored it, never an event's; when the queue is full the automation holding the most fires gives one up, a tie costing the newcomer's own, and a started run is never evicted. A run is started once its `active` list is not empty, read from that alone, so a restart that erases a held step's clock leaves it started; one run per automation is started (`mayRun`), at most `WAITING_EVENTS_MAX` event fires of one automation wait, and a newcomer past that is `suppressed` (`BEHIND`) and kept as a light run of its own tells while there is room. A run whose every step is its automation's own tell is light (`Fire.light`, set at admission and by `tellsOnly`): every light run advances each pass, counts in no waiting cap, is never replaced, and is the first to go when the queue is full. The pump takes a second `mayRun` pass, so a waiting run starts in the pump where the run before it ended at its turn. The outbox makes room the same way: the oldest quiet event of the automation holding the most, the asker's entry counted, never a `now` one, with one `suppressed` row per automation that lost events. Only an outbox full of `now` events holds a tell: its step waits, logged once, and ends `timeout` when its window passes.
  - **What a hole filled is data:** a message with a hole is told with `note`, the owner's text unfilled, and the assistant's instructions call `note` the owner's words and `message` data. A message with no hole has no `note`.
  - **A log row says its kind, and its kind is its key** (`automationLog.ts`): `step` (a step ended, or was held: its path, its action or statement kind, the function it ran in), `tell` (told for a whole run by the dated reader, or events dropped for room), `lost` (replaced, crowded, behind, refused for a full queue, inside its cool-down) and `trigger` (the run or its trigger: retired, missed, the clock, an unread store). Each has its own builder (`stepRow`, `tellRow`, `lostRow`, `triggerRow`) and nothing else makes a row, so no call site assembles a key. What stands is state beside the rows (`Log.standing`, by automation then key): a refusal logs once until another row of its key lands, and a lost run logs once until any other row of its automation does (`standingAfter`); dropping old rows for room never re-arms one. Past `LOG_MAX` the automation holding the most rows loses its oldest (`capped`), and `loggedFor` drops a gone automation's rows and standing at each commit. On disk the rows stay in the shape 8.14.87 reads (`storedOf`: no `kind`, which `readLog` reads back from the fields its builder set) and `standing` sits beside `log`; each row and each standing reason is read alone, and standing absent is read back from the rows.
  - **The last run is served on the row** (`automationLastRun.ts`, `AutomationRow.lastRun`): every step a run reached with its kind, how it ended and why, the side an `if` took, the function it ran in, the step in flight and whether it still runs. The pass records it for every started fire it sees, in `settle` too, so a fire a graceful stop lands is recorded as it ends (`recorded`: a later admission never replaced by an earlier one, by the place `fire` gives each admitted fire, `State.order`). Each carries a stamp of what it ran (`RunStamp`: its body but for `enabled`, and every frame's function at its incarnation and revision, so a function entered at two versions never stands), and it is served and kept only while that stamp is what its automation runs now (`lastRunStands`), so an edit or a run kept going on a version an edit replaced shows nothing, read and never stored; a toggle keeps it. A run whose fire is gone reads ended (`settledRuns`, at each commit and at restore). A failed step keeps the reason it was given (`saying`), so its row and its last run say the same. `automations.last(id)` reads it on the console, and `automations.log` is the log.
  - **A run by hand is a fire of its own** (`run`, the `automation_run` console op): its member is keyed by the call id and kept in `fired`, so a repeated call id runs nothing again; its names are what the trigger gives now (`namesNow`, none for an event); it skips an event's cool-down and replaces no waiting fire. It is refused `gone`, `off`, `invalid`, `away` (an event automation away from the home) or `not_admitted`, and logs and shows as its last run like any run.
  - **An outbox event leaves with what it belongs to:** a write that removes an automation drops its queued events (`dropOwned`), its fires retiring at the next pass, a let-go empties the outbox (`emptyOutbox`), and `retained` is the one retention check, read where the outbox is listed, at a restart and when an entry asks for room. An edit, a disable and a toggle keep them.
  - **A function nobody runs is kept for a week, then swept:** a let-go deletes no function, one no automation reaches (its pointer, or a call below it) is unlisted and tracked in `unusedFunctions`, and the persist tick sweeps it after `FUNCTION_UNUSED_KEEP_MS` through the `sweep` intent, never while an unread automation row is held.
  - **A log row never holds an error's message:** an untyped throw stores a fixed reason and logs its class (`errorName` in `src/shared/error-name.ts`), since a message can carry a URL with a key. A carried automation the judge drops is logged by a fixed word (`DroppedAutomation.why`), never its issue's sentence, which can quote a stored value.
  - **A store opened under a name passed in lists its names:** `AUTOMATION_STORES` in `composeAutomations.ts` is every file `openAutomationPair` opens, and `data-dir-inventory.test.ts` holds each to `DATA_DIR_ENTRIES`, refuses another module that opens under a name that is not a literal, and names every module that constructs a `DurableStore` under a subdirectory.
  - **The outbox writer keeps the lane reader's bounds:** `told` clips the title and every field, `memberOf` digests a member past 256, and `outbox.events()` hides an entry outside them, so one entry cannot fail every poll.
  - **A clock's next slot is computed from the slot it last handled, never from a fresh clock read** (`src/gateway/computed/automationClock.ts`): `tick()` walks each armed `time` or `interval` automation from its stored slot, fires a slot that is at most five minutes late and only counts an older one, commits the slots with the fires, then `rearm` arms one timer for the nearest next slot from the walk's own `now`. A walk whose write failed is retried half a minute on. A saved, edited or re-enabled clock starts from now, and so does one whose stored slot is more than the grace ahead of the clock, which is a clock that went back; it passes over the one slot it had last handled (`skip`) and logs that, so nothing refires. The persist tick calls `tick()` too, for a timer a suspend swallowed. `stop()` ends both and waits out the run in flight, before the devices close.
  - **A text with holes is checked at every read and filled at the fire** (`src/shared/text-holes.ts`, `src/gateway/liveConsole/holes.ts`, `src/gateway/computed/automationText.ts`): a text is a string's body with no quote around it, so `parseConsoleText` reads it with the one lexer and parser into a constant or a template node (`\{`, `\}` and `\\` are a text's escapes). `text-holes.ts` holds three one-line helpers over the lexer's parts (`hasHoles`, `unreadText`, `unescapedText`) and no model of its own, and the phone reads `lexConsoleText` the same way; the corpus's `texts` section pins both. `holeIssue` is the first issue in the text, the parser's or the checker's, an error at the step: an open hole, one that does not parse, a second statement or an assignment, a root name that is neither one of the trigger's (`AUTOMATION_TRIGGER_NAMES`) nor an entity, an entity named bare anywhere in it (a held name shadows an entity at the save as at the fire, and a value or a variable named as an entity, a word of the language or `e` is a warning: `resolveName` in `liveConsole/registry.ts` is the one answer to what a bare name means, for the checker, the evaluator and the fill, and `holeScope` and `holeNames` in `automationScope.ts` are the one build of a function step's scope, for the fire, the preview and the save check; `hole-name-residue.test.ts` refuses a second of either), an entity's member it lacks or its method left uncalled, an unknown function, a free builtin given the wrong number of arguments, a method no value takes and a slow member, and the issue carries its span. `fillHoles` never throws: a hole that is one name prints that name's shown form, any other prints as one line, and one that fails prints `{?}` and logs an `uncertain` run.
  - **A tell is a step:** every `tell_assistant` action holds a record at its path and is told at its turn, in written order, through the outbox under `stepMember(member, path)`, with its own `when`, its message, and `note` when the written message had holes. Two tells are two events, and a tell after an effect waits for it. An automation's own tell with holes is filled at its turn through the read slot into `fire.resolved` (`readOwnTell`), as a frame's `do` step is read into `frame.resolved`. Away from the home a tell ends refused before its message is read. The lane keeps an event automation's leading tells with no message, through a pointer into its function's leading top-level steps (`laneTells`, `laneTellWhen`): those hold no record at the top level (`runSteps`), and the fire records the paths the lane told as its functions stood (`Fire.lane`), so inside a frame only a tell recorded there, and still a leading one in the body the frame pinned, is passed over (`laneTold`). A tell an edit moved to the front while its run waited is told through the outbox. A message that fills to nothing is told with no message. A tell past its window is not told, though room came first, as an effect past its window is not tried; a restart starts a waiting tell's window again, as it does a held effect's. Until 2026-12-16 a fire stored with one `tell` for the whole fire is told as it stands, one still waiting on its fill without its message. An event's fire is keyed by the lane's own `memberKey`, so later activity on a thread fires again.
  - **A save that adds a dangerous action is confirmed:** the judge refuses an owner put whose dangerous actions (`AUTOMATION_ACTIONS[kind].danger`) the held record lacks unless the op carries `confirmed`, answering `confirm` with their labels. A new event-triggered automation that reaches more than a tell asks as well, and so does one whose trigger becomes an event, one whose held pointer could not be followed (`asksOf` counts no reach for it), and an edit of a function whose users it reaches; a step's danger key equals its flat form's (`dangerKey`), so naming a flat automation's steps asks nothing again. A toggle or an edit that keeps them asks nothing. A dangerous step whose own values read the event's words is asked with them named (`askLabel`, `eventWords` in `automation-fit.ts`): "Send to IFTTT, with the event's title", a bare `event` reading its title. A word that reaches the value through a `let` is not named.
  - **A crossing is watched through a band no store holds:** `createAutomations.derivedFields` hands `createComputedFields` one band per crossing automation (`crossingField` in `crossingBand.ts`), evaluated and kept in the field state like a stored field and never a record, so `drain()` reads its transitions as it reads any field's.
  - **Every read of an automation's actions is one walk:** `reached` in `src/shared/automation-walk.ts` and `assistant/AutomationWalk.kt` answers each action, with a function lookup each of the function's steps, and a call it did not follow as its own case, each with its step path in written order (`written` is the one-level reader). The Gateway reads an entry through `visit` and the phone through a `when` with no `else`, `automation-walk-residue.test.ts` refuses another reader, and `tests/fixtures/automation-walk/vectors.json` is replayed by both runtimes.
  - **A paired sensor's silence is told once, and its end once** (`src/gateway/computed/sensorSilence.ts`): `watchSensors` on the persist tick judges each sensor by its page's `staleAt` (`sensorReadings.ts`) and tells it after `SILENCE_HOLD_MS` more, one event for a radio whose sensors all went silent together, and a quiet event when it is heard again. It writes through the outbox in the commit that marks it (`silences` in the automation state), at the assistant's home alone. A sensor never heard tells nothing, a notice with no room waits, and no silence is told before this process has itself listened for the stale limit plus the hold, so a start after long downtime raises no alarm. A daemon that links later than that can still raise one, truly: nothing was being recorded.
  - **One reconcile loop is the only BlueZ caller:** `createBluezCoordinator` holds the desired discovery holds and one epoch-scoped link; events only edit state and mark it dirty. A signal landing while a connect is in flight is buffered and replayed once the link is up.
- `src/shared/live-console-grammar.ts` / `src/gateway/liveConsole/` / `src/gateway/compose/composeLiveConsole.ts` / `src/shared/schemasLiveConsole.ts` / `src/mcp/liveConsole/consoleTool.ts` - the language's one lexer and parser, and the Gateway engine. The engine has a registry, builtins, evaluator, renderer and entities. `composeLiveConsole` serves `/console/eval` with the wire in `schemasLiveConsole.ts`. `consoleTool.ts` registers the agent's `console` tool. `docs/console-live.md` holds the design
  - **One lexer, one parser, for an expression, a text and a script:** `Lexer` reads characters once into tokens. A string is one token whose body the lexer reads itself (`parts`: a run, an escape, or a hole whose own tokens are lexed where they stand), so a quote inside a hole opens a nested string and only the lexer decides where a string ends; a quoted string and every hole inside it end with their line (`\n` or `\r`), so no token of an expression holds a line break. `lexConsole` reads an expression, `lexConsoleText` a text (a body with no quote), `lexScript` a script (with `comment` tokens and a `newline` per line break, outside holes). `ConsoleParser` is recursive descent over those tokens: a string with a hole is a `template` node, a parenthesized expression is `grouped` and spans its brackets, a bracket that faults says so once, and nesting past `CONSOLE_DEPTH_MAX` is refused. The script's statement parser extends it. The evaluator, the hole checker, the fill and the type reader all walk that one tree; `grammar-residue.test.ts` refuses a second reader of where a string, a hole or a statement ends.
  - **Read-only, and a test proves it:** the stage receives `Pick`ed read seams only, and the stage test's fence reads every registered member over real stores and asserts no byte, snapshot or host op moved; a member with no row in its table fails it. Evaluation clones each handler's answer once it is read. Calls are limited to registry members and the builtin table. `Scan` looks like a read but writes, so it is not registered; a sweeping read (the vault's `list(now)`) is a write, which is why service grants read `standing()`.
  - **One description:** `registry.describe(audience)` is the tool's listing, and `registry.hash` names it so a client can cache it.
  - **An audience is a wait, too:** `bluetooth.listen` serves host sessions only, since a listen outlasts the phone's answer wait.
  - **One projection, every door:** `registry.projection(audience)` is the describe the phone caches, the source the agent's text renders from, and what `registry.hash` hashes. The owner's console ops reach the stage only through `LiveConsoleStage.console`.
- `android/.../liveconsole/` / `LiveConsoleOps.kt` / `ConsoleClientLiveConsole.kt` / `SandboxLiveConsole.kt` - the phone's Console page: the lexer's twin (`ConsoleTokens.kt`: an expression, a text and a script) pinned by `tests/fixtures/live-console-tokens/vectors.json`, completions and the hint (`consoleAssist`), the card a result draws as (`cardOf`), the Gateway it reads (`consoleGatewayOf`), the screen; each Gateway's history and vocabulary; the three calls; the emulator's canned answers
- `src/gateway/runbooks/store.ts` - gateway-held runbooks; sole writer, so a stored record has passed the rules
- `src/gateway/routines/store.ts` - gateway-held routines; sole writer, and it publishes `onChanged` so the runner cannot be left armed for what the store no longer says
- `src/gateway/workflows/` / `src/gateway/compose/composeWorkflows.ts` / `src/gateway/workflows/routes.ts` / `src/mcp/workflows/workflowTools.ts` - the durable sandboxed workflow engine and journal, dispatch bridge, owner-scoped routes, MCP tools, progress and settle notices; `docs/workflows.md` holds the tool and script contract, and what a step and a run leave
  - **The VM owns every QuickJS handle:** `vm.ts` holds the module, runtime, context, deferreds and budgets; `engine.ts` hands it a script, args and host callbacks and reads back a result or a `WorkflowVmError` naming its budget. The compile check and a run share one bounded runtime. A dispose asked for inside a host call lands once the guest unwinds.
  - **Call options:** `callOptions.ts` validates backend options, joins thread settings and fingerprints replay calls. Replay fingerprints omit `label` and `phase`.
  - **A script's syntax is QuickJS's call, never a scanner's:** `script.ts` cuts only the `export const meta` statement; the validator in `vm.ts` compiles the exact wrapper with `compileOnly` inside the synchronous start section, on one module loaded at engine start, so no lexer guesses whether a `/` starts a regex.
  - **Claude results settle before ack:** duplicate, terminal and unknown results are acked without another settle.
  - **Claude turn rows use a reread daemon id:** `attemptClaude` rereads liveness after host reads, before journaling.
  - **A resume holds its calls on a named thread whose agent is still ending its turn** (`adoptResumeThreads`), then retags and messages it. A step never starts a fresh thread in its place.
- `src/gateway/workflows/agentDispatch.ts` - `createWorkflowAgentDispatch`, shared dispatch and run cleanup
- `src/gateway/workflows/claudeSteps.ts` - `createClaudeSteps`, Claude turns and journal-derived cancel retries
- `src/gateway/workflows/dispatchPrompt.ts` - `createWorkflowPrompt`, skills and project instructions
- `src/gateway/workflows/dispatchCore.ts` - call state, journal helpers, host-failure mapping
- `src/gateway/workflows/agentViews.ts` / `stackAgents.ts` / `terminalAgents.ts` - outcomes and views; an agent on whichever backend's stack holds it; terminal cleanup
  - **Cancel acknowledgements follow KILL attempts or no match:** the runner retries failed kill attempts; the Gateway retries unacknowledged requests each tick. Pidfiles identify container turns and host orphans; host orphan kills check the turn tag. Gateway close sends no cancel.
- `src/gateway/routines/memory.ts` - what a routine remembers between runs, keyed by its incarnation
  - **The incarnation, not the id:** minted once and carried across edits, so memory survives a
    rename and dies with the routine. An id reused after a delete gets a new one, which is what stops
    a fresh routine inheriting a dead one's history; so does a change of target kind, since spawn
    history can hold what a check-in must not see. `sameContent` excludes it, or a save would read
    as an edit because the gateway owns a field.
  - **A run belongs to the incarnation it was prepared under:** the occurrence records it, and
    `pastLife` makes a run of any other, or of none, count as over, with no grant and no memory to
    read, file or recover into (`memoryKey`). The fence needs no write after the routine's, so no
    crash can cross it, and the store mints an incarnation at restore for a routine stored without
    (`restoreHeld`; `docs/routines.md` holds the rewrite).
  - **The occurrence is written before the memory store, always:** a crash between them leaves a
    proposal to retry and has already closed the run's authority. The reverse advances history while
    losing the report and leaving the vault window wide.
  - **A history conflict bounces exactly once:** two runs can be live at once, so the second is handed
    what is held and `memoryBounced` makes its next filing land as it stands. Bouncing forever leaves
    two windows nothing closes.
- `src/gateway/routines/routineRoutes.ts` / `sessionRoutine.ts` - the loopback door a routine's own session reads its instructions through, and the four outcomes it answers with
  - **The gateway names every revision:** a put carries the revision the caller read and the store
    writes its own successor, answering with the record. Nothing on the phone chooses a number, so a
    number the gateway would not have chosen is unwritable. A base that does not match what is held
    is refused with what is; a repeat of the stored content at the stored base is a lost answer.
    `overwrite` replaces regardless, still at the next revision, because no revision arithmetic can
    tell a copy that descends from the held one from a divergent one. Only an owner tap reaches it.
- `src/gateway/compose/composeRunbooks.ts` - the runbook store and its console operations
- `src/gateway/policies/store.ts` - gateway-held authorization policies; sole writer, one enabled holder per selector key
  - **Every refusal of a write is a `PolicyRefusal`, never prose:** `putRefused` and `deleteRefused` are the only builders, each carrying `refusal` and the `refusalReason` sentence, `shapeRefusal` answers `too_many_commands`, `command_too_long` and `invalid`, and `contextRefusal` answers `full` and `taken`, all as codes.
  - **A put refuses what restore would not hold, and restore drops what it cannot hold:** `shapeRefusal`
    parses the candidate through `AuthorizationPolicySchema`, so a put the vault's remember builds
    cannot write a record restore rejects. Restore drops a key that is no longer its own `selectorKey`
    or is over `MAX_SELECTOR_LEN` (`heldKeys`), never re-keys it, drops a policy left with none, and
    gives a pruned policy the next revision. A duplicate id, two enabled holders of one key or more
    than the cap starts the store fresh, as an unparseable file does. The runbook and routine stores
    restore on the schema alone.
  - **The policy commits first, then the vault reconciles:** `onChanged` fires after the write is on
    disk and reaches `onPolicyMoved`, which prunes the policy's grants and runs the vault's reconcile over the open requests. The vault also writes policies, through remember.
    Reversed, a failed write would destroy valid grants. Entry-wide authority stays broader than a
    policy's: an entry-wide grant covers a policy scope, and a qualified grant never covers a bare
    use. `docs/policies.md` holds the whole of it.
- `src/gateway/compose/composePolicies.ts` - the policy store, its console operations, and the `onPolicyMoved` seam the vault reads
- `src/gateway/routines/store.ts` / `occurrences.ts` / `runner.ts` - routines, their occurrences, and
  the loop that walks one; `compose/composeRoutines.ts` arms it from federation activation
  - **`advance` is the only door:** the timer, the reconcile tick, Run missed and a pressed Run all
    enter there, so none of them can walk an occurrence another is already walking.
  - **`rearm` wakes for what follows the clock reading the walk used, never a fresh one:** a platform
    timer runs a hair before its instant, so the walk it woke finds the slot still ahead; a fresh
    reading past the slot names the week after, and the slot waits on the reconcile tick.
    `routine-runner.test.ts` pins it.
  - **`dispatched` is written before delivery is attempted:** a crash between them loses the run
    visibly rather than repeating it, which is the at-most-once choice. Enablement and the deadline
    are re-read immediately before that write, since preparation is awaited.
  - **Recovery cannot reach past `since`:** the gateway stamps when it took a routine, so one saved
    today is never handed a miss for a slot that passed before it existed.
  - **`adhoc` says no rule named this instant, and two things read it:** the three enablement gates,
    which it bypasses because disable stops the schedule rather than the routine, and the severe-miss
    walk, which must skip it. Counting a pressed run as the newest occurrence moves that walk's floor
    past a scheduled slot that never ran, so the owner is never told it was missed.
  - **`runFresh` walks only a row it opened:** `open` answers whatever is already at that instant, so
    a press landing on one the rule named would otherwise run it without the gates it keeps. It reads
    the row back afterwards, since preparation is awaited and a deadline can settle it first.
  - **Several work windows can be open in one session, and the two readers say which they mean:**
    `workingOccurrences` is what anything ending a session takes, or the routine keeps reaching its
    secrets through a window nothing closed. `firstWorkingOccurrence` answers one representative,
    which is right only for a routine that holds secrets: a spawn session belongs to exactly one
    routine, and the assistant's session holds check-ins, which hold none.
  - **A target's kind decides through `targetRules` in `reservation.ts`, nowhere else:** the team,
    the idle wait, ownership by provenance, owning the session, holding secrets, the save refusal
    and the reserve. A check-in (kind `assistant`) runs in the assistant's session; a put without a
    kind over one is refused, so an older phone cannot turn it back. `docs/routines.md` holds both.
- `src/gateway/console/consoleRunbookFire.ts` - renders a stored runbook and lands it in a session, creating one first
  - **A preview and a fire reach the same words:** `textOf` is the one road from an id and values to
    text, so `runbook_preview` cannot answer something a `runbook_fire` would not send. A fire may
    name the revision it previewed, and a stored record that has moved past it is refused.
  - **A durable in-flight record is a crash, not a fire in flight:** `consoleHandler` keeps its own
    set of fires this process started. A completion on disk replays, a held key refuses, and
    anything else runs. The key is released only once the completion is durable, or a success the
    migration fence refused to record could be delivered twice.
- `src/gateway/boardAwareness.ts` - board awareness recipients and net-change classification
- `src/gateway/agentAwareness.ts` / `src/shared/agent-notice.ts` - delegated agents' turns told to their owning session: the watch over both catalogs, its subscriber, and the one wording the Gateway and local mode share
  - **A start answers at acceptance; the session learns the rest as awareness:** each settled turn gets one `act_now` notice naming its await tool, each running turn a pushed `no_act` notice every 10 minutes with its newest notes. A subscriber's `push` is what arms a deadline for a `no_act` change. A turn settled before the watch began is history, each turn is its own identity, and only `unavailable` ends a turn early, since a `recovering` agent may resume it.
- `src/gateway/workspaceAwareness.ts` - what a phone workspace op changed, banked `no_act` for the session; `workspaceAnswerNoting` is the console's one road from a plane result to an answer
- `src/gateway/awarenessBank.ts` - subscriber state, deadlines, and liveness reads
- `src/gateway/daemonCapabilities.ts` - daemon capability answer
- `src/gateway/federation/crossDomainShareState.ts` - this Gateway's copy of the Router's shares for its own sessions; a snapshot replaces it, a delta moves it one revision
  - **The Router writes; this reads, and reads nothing until a snapshot of this registration
    lands:** the file may predate a withdrawal the Gateway was not connected to hear, so every read
    answers nothing shared until `replace` runs, and `unready` on a disconnect or a gap closes them
    again. No sweep, no touch, no drop lives here.
- `src/gateway/federation/contentKeyStore.ts` - gateway keyring, sole rule owner, sole writer of `content-keys.json`
  - **Trust lands on disk before it is held; a revocation is held before it lands:** the keyring, the
    allowlist, `crossDomainPeers.ts` and `crossDomainShareState.ts` add through `commitChecked`, so a
    failed write grants nothing, and remove in memory first, so a failed write never leaves a revoked
    peer live. A key grant whose write failed is released for redelivery.
- `src/gateway/federation/bootstrapInstall.ts` - staged bootstrap install and re-enrollment merge
  - **One signer check for a first and a repeat enrollment:** the frame's signer and every key
    envelope's signer must be admitted consoles under the merged live and bundle view.
- `src/shared/agent-backend.ts` - the agent backend table: one row per backend id (default model, the start options it takes) and every name derived from its id
  - **Nothing decides by a backend's name:** a difference is a descriptor field, or the backend's driver. Every backend runs on the one stack below.
  - **A backend with no row does not compile, and no list names backends by hand:** `BACKEND_ROWS` is keyed by every `AgentBackendId`, and `AGENT_BACKENDS`, the capability ids and the workflow backend schemas (`WORKFLOW_BACKEND_IDS`, the agents plus `claude`) derive from it.
  - **The row order is the order every list names the backends in:** OpenCode, Codex, Copilot, and Claude last where a list has it. A refusal's list, the guidance's "Backends enabled" line and its sections, and a model listing all read it. Prose that names them by hand follows the same order.
  - **A start names its backend unless one is enabled:** `agentStart` and `workflowStart` hold the same rule and the same refusal, "Specify `backend`: ...". Claude counts for a workflow, so its start defaults only where no agent backend is enabled. `agentListModels` with none lists them all.
- `src/shared/agent-models.ts` - `newestPerFamily` and `offeredModels`, which of a backend's models `agentListModels` answers: a family is an id with its version tokens removed, and the backend's default stays listed and marked
- `src/shared/agent-identity.ts` / `agent-activities.ts` / `agent-state.ts` / `agent-persisted.ts` / `agent-catalog.ts` / `agent-wire.ts` - the one agent contract: ids and prompts; a turn's commentary; the result and request a session posts and reads; the stored agent; its catalog and the two stored shapes read at restore; the Gateway to daemon frames, built per backend by `agentWire`
  - **An operation holds its own prompt, model and delivery,** and an interrupt in flight is read off the stop aimed at the running turn (`interruptingOperation`), so no fact is stored twice.
  - **Backend catalogs are converted to one shape at restore:** `restorePersistedAgentCatalog` reads Codex's exchanges and thread id and Copilot's `followup`, and `SessionStore.restore` reads each backend's catalog from its recorded field (`LEGACY_CATALOG_FIELD`). `agent-catalog.test.ts` runs a stored Codex record through it.
  - **`delivery` has three words on every backend:** `started` is an agent's first turn, `followup` a message that opened a turn, `steered` a message into the running turn. The wire and the record hold `started` or `steered`, and `agentResultDelivery` is the one mapping to an answer.
- `src/gateway/agentStack.ts` - a backend's stack as everything above it reaches it (`AgentStack`): its route, its relay and its commands; `composeAgents` holds a map of them, and the workflow dispatch, the host frame routing and the awareness roster read that map
- `src/gateway/agentService.ts` / `agentApply.ts` / `agentReducers.ts` / `agentCommands.ts` / `agentRelay.ts` / `agentRoute.ts` / `agentTypes.ts` - the generic stack, one instance per backend: catalog transitions; daemon receipts and events folded into the stored agent; the pure decisions (`decideAcceptance`, `withTerminal`, `commandFor`); commit then dispatch; a backend's port into the relay; what a session posts and reads back; the intent types
  - **A requested operation is placed by the turn its receipt names, whatever its event id:** a receipt held for reconciliation replays after later frames moved the fence, and `laterFence` never moves the mark back.
  - **Cannot be placed yet reconciles; can never be placed is uncertain:** `decideAcceptance` answers `reconcile` for an order problem and `refuse` for a wrong session, target or turn, which marks the operation `indeterminate`. A receipt naming a turn reconciliation adopted binds its operation to that turn, unless another operation opened it.
  - **An event that can never be placed is ignored, never held:** one from an older generation of the stream the agent follows (`retiredGeneration`), or one naming a turn the record already ended, whatever stream it came on. Held, it would be retried and asked about for good, and the daemon would carry it on every connect.
  - **Only a write known to be on disk lets its operation be sent:** `AgentService.commit` switches on the write's kind. An `unconfirmed` one is held in memory, so its operation is given up, or the agent would refuse the next message and the next register would send the stale one. A `conflict` or a `failed` write held nothing.
- `src/gateway/agentFrameLedger.ts` - a daemon frame's life at the Gateway, pure: its ticket from arrival, its hold, its decision, and each stream's acknowledgement mark
  - **The ledger takes a frame before its agent's queue does:** `receive` runs at arrival, so no acknowledgement passes a frame that is here and undecided. A reducer that throws holds its frame as `failed`, so only commentary dropped at the cap is ever acknowledged unapplied.
  - **A replay is told by where its first copy stands:** held, it retries the held copy; still queued, it is dropped; decided, an event is not judged, and its acknowledgement is repeated once nothing below it is open. A receipt is judged every time, since it is placed by its operation whatever its event id.
  - **A held frame is one per stream and event id, and only commentary is dropped:** another generation reuses event ids, and an outcome evicted at the cap would be acknowledged unapplied. A ticket keeps its first hold time and whether its counter was counted for its whole life.
- `src/gateway/agentRelayCore.ts` - the relay every backend runs: the reducers per agent, what a hold asks and when it ends, the register pass and the catalog resend; `agentRelay.ts` is its port, one per backend
  - **A held frame is retried after every frame applied to its agent:** `retryHeld` replays them in event order, and one that still cannot be placed is held again, unacknowledged. No answer is matched to release one, since any applied frame may be what places it.
  - **A held event is applied whatever moved the fence since:** the frame that lets it be placed carries a later event id, so a retry skips the duplicate check in `applyEvent`, or a turn's terminal is dropped and acknowledged.
  - **A frame from a socket that is no longer the host's is dropped unacknowledged:** the daemon's outbox holds it and replays it after its next hello. `queueHostFrame` judges the socket the frame arrived on, never the one registered since.
  - **A change listener's throw is caught where it is called:** thrown through `settle`, it skipped the retry of held frames and could queue a decided one again.
  - **A frame nothing places is asked about every guard and given up at ten minutes:** `watch` arms the next ask or the close for an agent holding `reconcile` or `failed` frames, `RECONCILE_GUARD_MS` apart, and `HELD_FRAME_LIMIT_MS` runs from the later of the first hold and the daemon's last hello, only while a daemon is live. A frame awaiting its write has no limit.
  - **A close settles the record first, then the frames:** the daemon's last reconciliation is applied at its word (`applyReceipt` with `closing`), which ends a turn it contradicts and adopts the one it reports running under that receipt's fence. `closeHeld` then ends the open turn as interrupted with `AGENT_TURN_UNACCOUNTED_REASON` unless that reconciliation says it is the one running. Each held frame is tried again; one still unplaced is given up, a receipt's requested operation going `indeterminate` first.
  - **A close takes no stale word and ends no fresh turn:** a reconciliation counts only if it came after the record's open turn did and from the live daemon, and the open turn is ended only if the daemon was asked since it opened. A daemon whose hello has not come, or that no ask reached since the hold began, is given nothing up to; a close that gave nothing up asks again.
  - **A close fails closed:** a write the record refuses leaves the frames held and the close is tried again a guard later, and frames with a stream await a write that is unconfirmed. A frame placed during a close retries no other: the close tries each unplaced frame itself, so every one it decides waits on the close's own unwritten step. `stop` clears every watch at the Gateway's close, and a step queued before it asks about nothing and closes nothing.
  - **A hello that names evicted frames asks about every working agent on that target:** the daemon counts what its outbox dropped per stream, and a count the relay has not seen asks inside the guard, since an agent whose fence names the live daemon is otherwise never asked. A count is marked seen only once its asks went out. An agent still starting at such a hello has no target yet: it is remembered (`lossPending`) and asked about once, when its acceptance opens its turn.
  - **An applied terminal outranks a later report:** a reconciliation naming a turn the record already ended leaves the agent idle.
- `src/shared/agent-recovery.ts` - the recovery decisions every backend takes: whether an op is stale under the live daemon, and whether a reconcile loses, keeps or adopts a turn
  - **Every turn and every op ends:** an op not stamped with the live daemon is abandoned at the next register, a turn the daemon's process lost settles `interrupted`, and a stale agent is asked again on every hello and persist tick. A child that reports a settled turn is believed and its terminal awaited. `agent-recovery-vectors.json` runs through the decisions and the stack's appliers. `docs/agents.md` holds the rules.
- `src/gateway/agentCatalogPersistence.ts` - one owner's agent catalog for one backend: reads, the strict agent lookup, commits, daemon-change applies, durable checks, and replay
  - **One write, five kinds, and changed is never read as unchanged:** `write` answers `landed`, `unconfirmed`, `conflict`, `failed` or `owner_missing`. `unconfirmed` is in the record and on disk unless a crash undoes it; the last three changed nothing, and `apply` and `retire` fold those three together. `AgentService.commit` keeps all five apart: a session hears `not_found` for `owner_missing` and `persistence_failed` for the rest that are not `landed`.
  - **A daemon change whose write is unconfirmed is `unconfirmed` to the relay, never `reconcile`:** the record holds it, so listeners hear it and held frames are retried, and a frame with a stream stays unacknowledged until `confirmation` answers `confirmed`. Asked about instead, its retry read as a duplicate and was acknowledged with its durability still open.
  - **A frame awaiting its write blocks its whole stream, so anything that can confirm it retries it:** one stream carries every agent on a target, and acknowledgements are cumulative. `retryAwaiting` runs when any agent's write lands and on each `reconcileStale`, with one write attempt per owner per pass, since each is the whole snapshot. `confirmation` answers `gone` once the owner's catalog no longer reaches the revision, and the frame is let go.
  - **A mark whose write is unconfirmed is still made:** a collect hands over the turns it marked. A second pass would find them already collected and hand over none.
- `src/gateway/agentExecutionTarget.ts` - where an owner's agent runs, for every backend
- `src/gateway/router/` - Router WS client; `pinnedSocket.ts` owns certificate pinning
- `src/gateway/router/inboxDeliveryPump.ts` / `inboxClaims.ts` / `sessionRegistryReporter.ts` - inbox drain with durable claims, and session registry reporting that keeps a refused write pending and retries it
  - **A claim file with no claims is no file:** the last ack removes it, and `InboxClaims.sweep` drops a claim a week past its row's lifetime, hourly.
  - **A claim leaves with its own ack, at a session's end too:** the end deletes no claim file. `settleAddress` acks every claim not being dispatched (`failed` `session_forgotten` for one still `waking`, else its own outcome), ends the retries and key waits of that address, and stops a frame part way through it, whose remaining rows are answered `session_forgotten` unstarted. A dispatch in flight answers for itself, then is settled the same way (`outlived`), so the op that ends a session still delivers its own result. `deliver` ignores a redelivery of a row it is still dispatching. `InboxClaims.forget` is the purge sweep's alone (`inbox-claims-residue.test.ts`).
  - **One forget per name is in flight, and its upsert waits on it:** a forget landing after the upsert would take the new session's registry row.
  - **A Router-fired schedule lands as an ordinary send:** `landScheduled` parses the sealed body (`ScheduledBodySchema`: `text`, optional `messageId`, `files`), maps its files through `scheduledWireFile`, and dispatches a console `send` under the row's conversation and op id, so the reply route is the ordinary send's (`isFiredSchedule` in `src/shared/scheduled-body.ts` names the row). A retryable outcome (no dispatcher, a `SendRefusedError` with `retryable`, an untyped throw) is retried by the pump itself on `FIRE_RETRY_MS`, then acked `failed` `delivery_unavailable` once; a claim found `waking` on a fired schedule is dispatched again, and `firedDeliveryId` makes the second dispatch a duplicate. `tests/fixtures/scheduled-body/vectors.json` and the phone-encoded case pin the body's shape for both runtimes.
- `src/gateway/router/presenceReporter.ts` / `presenceProtocol.ts` - presence pump and pure protocol; `applyAnswer` cannot reach the sender, so answers do not start frames
- `src/gateway/router/shareAttestor.ts` - share liveness attestation, coalesced
- `src/gateway/router/boardClient.ts` - sole sealer of board text and sole local-key mapper; CAS writes
- `src/gateway/router/blobUploader.ts` - stages this Gateway's bytes on the Router as sealed chunks, resuming from the Router's cursor, and holds relayed bytes under this Gateway's name
- `src/gateway/router/routerBlobReader.ts` - the Router range read a session's `/blob/get` falls through to once local staging is gone
- `src/gateway/console/` - Android OwnerOp dispatch and capability store
  - **A send the Router fired writes no `sent` mirror:** the handler takes the row's origin and mirrors only a console send, since the Router wrote that result, and a refusal reaches the pump as a `SendRefusedError` carrying its `retryable`.
- `src/gateway/console/consoleTypes.ts` `NotServedError` / `src/shared/wire-vocabulary.ts` `OP_REASON_NOT_SERVED` - a value op this build cannot serve
  - **An op a build lacks is refused by token, never by prose:** `composeRouterFrames` answers `not_served` for a kind no schema here names, and for a stage guard's `NotServedError`, so a phone tells an older build from a refusal without inferring it from another field. A Gateway from before the token still answers schema prose.
- `src/gateway/console/consoleTargets.ts` - every console target, `domain.gateway.spawn[.session]` by contract; the bare-name and foreign-Gateway refusals live here alone
- `src/gateway/console/consoleCrossDomain.ts` - the console's link, unlink and untrust handlers
- `src/gateway/console/consoleSessionLifecycle.ts` - create, wake, close, forget, and rename
- `src/gateway/console/consoleTerminal.ts` - pane peek, key send, directory listing, and plugin reload
- `src/gateway/consolePushOps.ts` - phone-bound rows, `deliverToOwner`, and durable `OwnerRowOutbox`
  - **The Router holds every byte a row names before the row lands:** the drain stages each blob
    and only then appends; a `blob_missing` refusal re-stages. Local bytes are staging for that
    row, retired once no queued row or held delivery names them. A blob that left staging before
    the row went leaves its name only.
- S8 retained endpoints: `/capabilities`, `/discover`, `/task-board`
- `android/.../ChatRepository.kt` - console process singleton and OwnerOp client
- `android/.../GatewayRegistry.kt` - the Router's roster as the phone holds it: provenance, per-Gateway answers, and the reads the views use; `docs/console.md` holds the rules
- `android/.../PhoneIdentity.kt` / `PhoneBootstrap.kt` / `PhoneAmbient.kt` - the one door for identity facts, the boot value it publishes, and the ambient record (clock, entropy, ids, timer)
- `android/.../SandboxSeeder.kt` / `SandboxGateways.kt` / `SandboxModules.kt` / `SandboxFacets.kt` /
  `SandboxFacetRules.kt` - the emulator build's seam: `isSandbox`, the identity facts a sandbox boot
  needs, the canned state it publishes, the Gateway answers as ports rather than sockets, one canned
  module per path, and the invented drill-in data and the rules that turn it into answers.
  `docs/testing.md` holds the case table and what it cannot show
  - **The drill-in rules are the plugin's, pinned by `tests/fixtures/workspace-facets/vectors.json`:**
    `scripts/gen-facet-vectors.ts` runs `src/mcp/workspace/facets.ts` over invented inputs and writes the
    corpus, `workspace-facet-vectors.test.ts` replays it against the plugin, `SandboxFacetVectorsTest` runs
    the same inputs through `SandboxFacetRules`, and `check:facets` catches an input edited without
    regenerating. A hand-written sandbox drifted from the plugin twice on the counts before this existed.
    The data in `SandboxFacets.kt` stays invented; only a rule is pinned, and a rule takes explicit input
    so a vector can drive it.
  - **A reference row's order is the index's, module then line then character, so no list is authored
    into it:** `SandboxFacetRules` sorts before it pages, since the sandbox has no daemon to order for
    it. A page is what the index answered; truncating one refuses the drill-in whole, names the served
    rows the page held, opens no file and answers no counts.
  - **A count is derived from the rows it names, never declared beside them:** `SandboxFacetsTest`
    asserts every count equals what its drill-in lists, so no screen claims a number the next contradicts.
    `HubRegistry` is the one exception, since a too-large drill-in lists nothing to count.
- `android/.../RepositoryPorts.kt` / `RepositoryCollaborators.kt` - role ports for the ops classes and their repository adapters
- `android/.../Message.kt` / `MessageFile.kt` / `MessageText.kt` / `Draft.kt` / `ThreadOps.kt` / `ReadAnchor.kt` / `ChatState.kt` / `FederationTypes.kt` / `ScheduledSend.kt` - repository value types and pure helpers
- `android/.../ProvisionFence.kt` - the repository's one re-provision fence
  - **Work captures the term as it begins and lands through the fence:** `clearAll` closes the
    fence as its first step, before the identity goes, and moves the term as its last, so work
    begun before the wipe or during it lands nothing and the roster's order decides nothing. The
    wipe is never cancelled part way and runs one at a time (`wipes`), since a wipe cut short would
    move the term over a phone half wiped, and it clears the provisioning keys again at its end for
    a write that was still out when the identity went. The
    workspace classes, `RunbookOps`, `ScheduledSendOps` (one term per `pass`), `TrustOps.untrustOwner`
    and a vault answer's record land through it. The board and vault managers keep their own
    generation, which a lineage change also moves, take it as a required argument captured before
    the await, and land nothing while the fence is closed. A holder that re-bases itself inside the
    wipe, or a showing minted inside it, takes `upcoming`. `reprovision-fence-residue.test.ts`
    holds the order in `clearAll`, the one mover, the one fence and the undefaulted generation.
  - **What follows a wipe runs with the wipe, never from the screen that asked:** that screen
    leaves composition as `provisioned` falls, before the wipe answers, and the window itself can
    be gone. Forget and Delete run on the repository's scope; `clearAll` calls `onWiped`, which
    `Repo` installs, for the plugins' wipe handlers and the notification sweep; `App` resets the
    shell when `provisioned` falls; and a Domain delete that could not confirm its purge says so
    in `ChatState.wipeUnconfirmed`, which the overlay host draws.
- `android/.../ChatPersistence.kt` - JSON codec between repository state and AppStateStore
  - **A slot is written from the live state, never a caller's snapshot:** every `persist*` but the
    assistant home takes no argument and reads `live` under one lock, so a write that lands late
    cannot put an older state back. The home's one writer is `AssistantHomeFence`.
- `android/.../PollDrain.kt` - owner-inbox tick, four plane cursors, and drain-gate subscribers
- `android/.../DrainGate.kt` / `DrainHost.kt` / `SessionHost.kt` / `PresenceHost.kt` - the re-entrant drain gate and one host interface per ops class, each with its repository adapter beside it
- `android/.../ReportReadCompose.kt` / `CapabilitiesCompose.kt` - pure phone composers
- `android/.../PlaybackOps.kt` / `PlaybackReadModels.kt` - playback serialization and lock-free read models
  - **A head speaks only under its ticket:** `PlaybackQueue.setHead`, the one head writer, ends the held claim and mints a fresh `HeadTicket` on every assignment. A body claims through `admit` with its ticket, and a terminal moves the queue only when it carries the claimed generation, so a stale post, gap callback or terminal cannot touch the head that replaced it.
- `android/.../BoardOps.kt` - repository board operations
  - **The board is one Router-held board, so no read and no write names a Gateway:** entries, the
    read time and every intent are owner-scoped. An attachment's bytes are the Router's, uploaded
    through the blob owner ops before the intent that names them is posted.
- `android/.../VaultOps.kt` - repository vault operations: refresh, save, delete, reveal, answer, grants
- `android/.../RunbookOps.kt` - the gateway calls, `pushDecision`, and the refusal a save answers with
  - **A save is pushed before it answers:** stored takes it into the library and closes the editor,
    refused leaves the library alone and keeps the editor open, and no Gateway reached means the
    copy is local. `keep` decides the last part by whether the library actually took the candidate,
    so a save the merge would drop is refused rather than silent.
  - **One word for a turned-down save, and one producer per side:** `SaveRefusal` is the value,
    `gatewayRefusal` reads one out of a gateway answer, `libraryRefusal` builds one when the phone's
    own library declines, `refusalsAfterPut` folds them, and `refusalFor` reads the standing one.
  - **`standingRefusal` withdraws a spent offer:** below the draft's revision, rebasing onto the
    held one would mint a revision `merge` discards. It filters only the leftover refusal; one the
    current save earned outranks it, which `RunbookEditor` names rather than nests.
  - **The phone adopts the revision, it does not mint one:** `save` sends the revision the editor was
    opened at and keeps whatever record the gateway answers with.
  - **An edit in progress lives in `RunbookOps.edits`, not the screen:** the repository outlives an
    activity and saved instance state is a parcel, which a runbook body is not bounded to fit.
  - **A save begun before a re-provision writes nothing after it:** saves run on the repository's
    scope, so every library write lands through the repository's `ProvisionFence` under the term the
    save began with (`written`). A delete's confirmation names the routines that pin the runbook, and
    says so when this Gateway's routines are unread (`runbookDeleteLine`).
  - **Every method names its gateway, and none of them defaults it:** a call that does not say which
    machine it means does not compile, so the compiler enumerates the call sites rather than a
    reviewer. Drafts, refusals and `synced` are all keyed by gateway and id, since `"new"` and any
    runbook id are shared across gateways.
- `android/.../runbooks/RunbookManager.kt` - the phone-held library and its persistence, beside `BoardManager`
  - **On disk before it is shown:** a refused write leaves the owner the library they still have.
    `clearInMemory` is the exception, since a re-provision takes the previous owner's writing out of
    memory whether or not the disk cooperates.
  - **One copy per gateway, because a revision describes one gateway's record:** a single library
    carried one gateway's numbers into another, so two gateways at the same revision with different
    content lost a branch by arrival order. Every read and write names the gateway.
- `android/.../runbooks/RunbookDraft.kt` / `RunbookGrammar.kt` / `RunbookEditor.kt` - the editor's model, its recognition twin, and the screen
  - **The parameter list is derived, and settings are keyed by placeholder name:** a deleted
    placeholder keeps its settings while editing and `toRunbook` prunes them. `RunbookGrammar` is
    the Kotlin twin of `placeholdersOf`, pinned by `tests/fixtures/runbook-grammar/vectors.json`,
    and recognises names without rendering.
- `android/.../runbooks/RunbooksScreen.kt` / `RunbookFireSheet.kt` - the view with Fire per row, and the fire sheet
  - **The preview is the gateway's render, never the phone's:** the sheet calls `runbook_preview`, so
    one implementation of the grammar serves both it and the fire. An edit marks the shown text
    stale rather than blanking it, and Fire waits for a preview whose revision matches the runbook.
- `android/.../runbooks/RunbookPreview.kt` / `PickMenu.kt` - the one preview fold, and the one field for a closed-set pick
  - **`settledPreview` is the road from values to a `PreviewState`, and both screens take it:** the
    fire sheet and the routine editor key their own effects, but the debounce, the gateway call, the
    standing-refusal reading and the fold live here, where `previewOf` is a JVM test away.
  - **`PickMenu` shows one label in the field and the rows:** a target, a spawn point and a runbook
    all pick through it, so the field cannot read as one name while the open menu reads as another.
  - **`FireSheetState` holds two lifetimes:** the values and the preview belong to a runbook at a
    revision and `adopt` resets them; the target and a fire in flight belong to the sheet.
  - **A runbook fires on the Gateway that holds it, so the sheet picks no Gateway:** one call names
    both where the record is read and where the session lands, and another Gateway's copy of that id
    is another runbook.
- `android/.../runbooks/RunbookText.kt` - the one-line form an option and a body are shown in, and
  the trim a typed option passes through
  - **A cut chip says it was cut:** `chipLabel` takes the first line to a character cap and marks
    what it dropped, since `maxLines` alone shows a short first line as if it were the whole value.
    The cut never ends on half a surrogate pair. The Kotlin gate reads this rule; no gate here reads
    a Compose layout.
  - **A typed option keeps its indent:** `trimmedOption` drops blank edge lines, and trims fully only
    when one line is left, so a pasted block does not lose the indentation of its first line alone.
- `android/.../RoutineOps.kt` / `routines/RoutinesScreen.kt` / `RoutineEditor.kt` / `RoutineText.kt` /
  `GrantSecretsSheet.kt` / `RoutineNotices.kt` - the gateway calls, the view, the editor, the pure lines
  each row shows, the sheet a routine's secrets are granted through, and `routineNoticePlan`, what the
  shade should hold for routines
  - **A Gateway that has not answered says nothing about its notifications:** each one names its
    Gateway, and `routineNoticePlan` sweeps only those of a Gateway whose list is read or that left
    a current roster. An unread list is not an empty one.
  - **The phone caches, it never owns:** a routine's record, its next run, its misses and its
    reviews are the gateway's, so a change re-reads rather than guessing. `GatewayEntry` holds the
    displayed copy per gateway for routines, policies and automations alike, each a `GatewayList`,
    and reconciles only by rereading.
    Runbooks are the exception that keeps a durable library, which can disagree until a sync.
  - **The editor picks from what the Gateway offers, through the builders New session and Fire use:**
    `spawnChoices` for the spawn point, the library for the runbook. A held value the Gateway no
    longer offers stays first and marked (`spawnMenu`, `runbookMenu`), since a registry answering
    nothing is not the owner asking to retarget. Picking a runbook retires the previous one's
    answers (`RoutineDraft.pickRunbook`), and the preview under the parameters is the same fold the
    fire sheet reads. The time is picked on a clock, not typed; `clockOf` and `clockText` are the
    two roads between the picker and the `HH:MM` the schema reads. The list row alone owns
    enabling; the editor has no switch.
  - **The grant sheet's Done returns the checked tiles, and only those:** `grantedAfter` keeps held
    order, appends new picks in vault order, and drops an id a read vault no longer holds; a vault
    never read drops none. `grantedLine`
    names that id as missing before the sheet is opened, so the drop is never a surprise. The sheet
    offers only entries with a value that are allowed on this Gateway, the rule `PolicyEditor` keeps.
  - **Every gateway is asked, concurrently, and one that cannot be read leaves the rest drawn:**
    `refreshAll` fans out over the roster, and an answer for a Gateway the roster no longer names
    is dropped at the write.
  - **A roster landing copies the prior entry:** `GatewayRegistry.landed` builds each entry from the one it held for the same incarnation and overrides only what the projection says, so a per-Gateway answer (`automationServes`, a list, the assistant's word) is carried without being named. A restarted Gateway starts fresh, keeping its peers and the stored runbooks.
  - **`ChatState.gateways` is the ONE authority on membership, and `PresenceOps.landProjection`
    its only writer:** the Router's roster, with a provenance. A refresh takes no list, since a
    list passed in is a second source that disagrees with the published one. `withEntry` is the one
    write for an answer and refuses a Gateway the roster does not name, so a read that lands after
    a revocation draws nothing. The stored runbook library is never pruned; a lapsed entry is not a
    reason to lose what the owner wrote.
  - **A zone belongs to the rule, and an instant belongs to the owner:** a saved routine keeps the
    zone it was written in and a new one takes the phone's (`keptZoneOf`), which is what the editor
    converts a typed time into. The Gateway holds none. The rows show instants, so they read in the
    owner's own zone.
  - **The per-gateway reads are `GatewayRegistry` methods, not screen expressions:** `runbookOn`,
    `routineOn`, `policyOn`, `reachable` and `soonestRoutineAt` are what stops a screen reaching
    past its own group, so they sit where a JVM test can call them.
  - **Run and Run missed are different acts, and the row says which:** Run opens a fresh occurrence
    at the moment it is pressed, on every row including a disabled one. The miss panel's button runs
    the slot the rule named. Neither refuses while a run is already working.
- `android/.../PolicyOps.kt` / `policies/PolicyDraft.kt` / `policies/PoliciesScreen.kt` / `policies/PolicyEditor.kt` /
  `ConsoleClientPolicies.kt` - the gateway calls, the editor's model and its pure refusal, the view, the editor
  - **Nothing is held on the phone, and every method names its gateway,** as routines do. A
    Gateway that refuses `policy_list` is drawn as nothing; one that cannot be reached keeps what it
    drew. `GatewayReads.kt` holds the answer and its fold.
  - **A gateway answer is never flattened to a Boolean before the screen sees it:** `save`,
    `delete` and `setEnabled` answer `PolicySaved` or `PolicyDeleted` with the reason, and a
    refused toggle's reason sits on the row in `ToggleFence.refusals` until a toggle of it lands. A
    refused save or delete says its refusal in the phone's own words (`policyRefusalLine` in
    `Reasons.kt`, an `else`-less `when` over the generated `PolicyRefusalCode`), falling back to the
    Gateway's `reason` for an older Gateway, a code this build does not know or a missing fact. The
    routine toggle follows the same rule, and carries the revision the row was drawn at. Routines,
    policies and automations share the one `ToggleFence`, so an older toggle's answer never
    overwrites a newer one's.
  - **A refusal marks the chip it names:** `policyRefusalMarks` answers the typed `example` of `same_command` or `no_command`, `PolicySaved.Refused` carries it as `marks`, `SaveSaid.marks` reaches the edit session, and `PolicyEditor` draws that chip in the error colors.
  - **A save refusal naming a newer revision offers a save over it:** `PolicyDraft.over` rebases
    the draft onto the newer record, and only an owner tap reaches it. Enabling is the row's, so
    the rebase takes it from the record, or a save over would turn a disabled policy back on.
  - **Examples go as typed; the gateway keeps keys.** `PolicyDraft` adopts the record the gateway
    answers with, so the phone holds no twin of the key rule. The editor offers only entries
    `allowedOn` that Gateway, and names a binding it cannot resolve.
- `android/.../GatewayPick.kt` - the button a new record starts from
  - **A new record has no Gateway yet:** one is taken without asking, several are asked, and none
    draws no button. Nothing else on these views chooses a Gateway, since every row belongs to one.
    Inside a conversation only that session's Gateway is offered (`ViewScope.newOn`); Automations
    take no filter, so their New offers every Gateway that could start one (`newAutomationGateways`).
    The sheet that asks is the screen's own, so the lock takes it with the screen.
- `android/.../GatewayReads.kt` - `GatewayReadFence`, the one freshness rule for per-gateway reads, cleared at a re-provision so a read still out lands nothing; `ListAnswer`, `listAnswer` over `listAnswerOf`, and `after`, the one decoder and fold of a Gateway's list; `gatewayAttempt`, `refreshEach` and `ToggleFence`
  - **A Gateway's list keeps its answers apart, in the entry and on the wire:** `GatewayList` is
    unread, listed, not served or unreachable, and `ListAnswer` is rows, not served or unreachable.
    `after` is the only fold: rows replace, not served says so, silence keeps what was drawn, and a
    first read that fails is unreachable, no longer unread. Routines, runbooks, policies and
    automations all read through `listAnswer` and `GatewayReadFence.list`, which answers nothing for
    a read a newer one superseded; a runbook list keeps its rows through a failed read and through a not-served answer
    (`runbooksAfter`), since its library is durable, and says not served only with nothing drawn; peers are `TrustOps`' own read.
  - **No reader turns an answer that has not arrived into a definite one:** `GatewayRegistry` offers
    `listOn` (a Gateway's list; off the roster it is unread before the roster loads and unreachable
    after), `lookup` (found, gone, reading, unreachable or not served, which `editStanding` and
    `openingDraft` read), `listedGroups` (what a view draws) and `groupedView` (a view's whole line, drawn
    only while no Gateway in scope is listed, so it never says none; a listed Gateway with nothing
    says so under its own name, and groups are named whenever more than one Gateway is in scope). Anything else folds every answer in a `when` with no `else`, as
    `runbookDeleteLine`, `removeSensorLine`, `usedBy` and `canShareTo` do. Main sources hold no
    accessor that flattens: `found()` and `listedRows()` live in test sources alone.
    A Gateway's peers alone outlive its restart on the entry, since pairings do.
  - **The gate reads every reader** (`gateway-list-residue.test.ts`): no member on a read type, no
    cast to a variant and no import of one, no `is` test of a variant outside a `when` branch label,
    no `else` in a `when` over these types (its subject read with balanced parentheses), the six
    deleted flattening reads stay gone, and `automationServes` is read only in `assistant/AutomationContext.kt`. Each
    rule has a sample it refuses and one it accepts, and its allowlist is empty.
  - **Only the token says not served:** `OP_REASON_NOT_SERVED` always reads so (`listAnswerOf`). A
    refusal in prose is a fault, so what was drawn stays.
  - **The later read of a gateway wins, and only of that gateway:** the drain loop and a tap both
    start reads, so an older answer can land after a newer one and put back what the owner just
    settled. One counter per gateway, or a slow read of one discards a fresh read of another. Each
    ops class holds its own fence, since a routine read and a runbook read are different reads, and
    the rule lives here rather than being written out once per class.
  - **A fenced read answers `Fresh` or `Stale`, never a null that means two things:** the body's
    own null (a failed call) rides inside `Fresh`, so a caller that leaves the group alone on a
    failure and one that hides it on a refusal both read the same answer without guessing.
  - **A key names the SLOT a read fills, not merely the holder:** two reads sharing a key cancel each
    other. `WindowOps` passes a sealed `ReadSlot`, one per span, so no string reaches this from there;
    the other callers still pass one. A read that fills a per-module cache is not fenced at all, since
    nothing an older answer could overwrite exists. A read a screen draws takes no `GatewayReadFence`
    either: its order is its `PublishedViews` ticket, minted before it awaits.
- `android/.../WindowOps.kt` / `WindowRules.kt` / `WindowRequests.kt` / `SymbolViews.kt` / `KnowledgeRules.kt` /
  `ComposedRequests.kt` / `RawFileOps.kt` / `RawFileRules.kt` / `WorkspaceFileOps.kt` / `FileOpRules.kt` /
  `FacetText.kt` / `FacetStateRules.kt` / `FacetFactsRules.kt` / `FacetUseRules.kt` / `FacetStructureRules.kt` /
  `FacetHistoryRules.kt` /
  `FacetDetailRules.kt` / `CodePaint.kt` / `HeldEdits.kt` / `PublishedViews.kt` /
  `WorkspaceDraftStore.kt` / `WorkspacePorts.kt` / `WorkspaceFileTable.kt` / `WorkspaceNav.kt` / `workspace/` - a
  conversation's Files: the open windows, the raw files being edited, the file operations, their drafts, the
  drill-ins and their paint, every rule the surface applies, the place rules, and the screens.
  `docs/console.md` holds the whole of it
  - **One drill-in screen, three bodies:** `workspace/FacetScreen.kt` is the frame (back line, title,
    subtitle, notices) and dispatches on the answer's class to `FacetUses.kt` (References, Used by, Uses)
    or `FacetLists.kt` (members, hierarchy, comments, history, and the outline's file-history strip).
  - **A facet's showing lives while its place is on the Files stack:** kept by `WorkspaceScreen` for each
    distinct `Facet` place rather than by the screen that draws it, so Back returns to drawn rows. The
    screen state beside it, the grouping, the chosen chip and the scroll, is held by a
    `SaveableStateHolder` keyed by `placeKey`, since a place that leaves composition loses a
    `rememberSaveable` and two places drawn by one branch would otherwise share one.
  - **Every drill-in decision sits outside a Composable, one file per domain:** `FacetFactsRules` the fact
    rows, `FacetUseRules` the use listings with their grouping, keys and role chips,
    `FacetStructureRules` the members, the hierarchy column and the comments inside a declaration,
    `FacetHistoryRules` the commit items, the file stats and the cap, `FacetDetailRules` what opens a
    detail and the order of its items. What the drill-ins share with the rest of the surface sits apart:
    `FacetStateRules` holds the state an answer reads as, the unit each facet counts
    in (`facetUnit`, `facetOf`) and the notices they draw, and `FacetText` holds `countText`, `whereText`,
    `plural` and the ages, one reading of a count, of `module : line` and of a span, so two screens cannot
    group digits or name a line differently.
  - **`CodePaint` owns the wire's tokens and the mocks' palette:** `CodeToken`'s ordinal is the contract,
    pinned by `tests/fixtures/code-spans/vectors.json`, and `styleOf` has no else branch, so a token added
    to the wire is a compile error. `USE_ROW_COLUMNS` sits under what a phone row draws, or the ellipsis
    eats the underlined name the row exists to show.
  - **A message the phone composes for a session goes through `ComposedRequests`:** claimed by address,
    kind and subject before it is sent, so a repeat tap sends nothing while one is out. Agent Apply, a
    window ask and a file mention all take it; a new composed message is a `RequestKind`, not a new guard.
    - **Admission is decided with the claim, in the road, and nowhere else:** a caller takes a
      `RequestAdmission` when its work begins, and no site reads the generation itself. The road's ledger
      carries the generation it was cleared into, and one CAS reads it with the claim, so the clear refuses
      a claim or a landing outright; a check beside either has a gap, and a key claimed through it stays
      `SENDING` with nothing left to settle it. An admission older than the ledger is refused before its
      key is read and writes nothing; one that
      claimed before the clear has its message in flight, and only its landing is refused. The claim, the
      send and the settle are one non-cancellable step, so a cancelled caller merely discards what it answers.
    - **A `RequestAdmission` names the one hold its work may write,** so a replacement is never mistaken
      for what it replaced. No site mints its own.
    - **A site writes before the send and hands the road a `RequestHold` naming how the write comes back
      out, what it replaced included; the road alone says when:** `Sent` and `Unknown` keep it, `Failed`
      and `AlreadySending` take it back out. An `Unknown` publishes `FAILED`, so the row offers a retry
      while the write stays. The road takes the written hold rather than writing it.
    - **Each site reads the outcome as its own word through one function,** `appliedOf` and
      `windowsAskNotice`, so no surface spells the mapping twice.
  - **A symbol's note is read only, and `KnowledgeRules` decides its badges:** `NoteSection` only
    renders. The plugin reduces every ref to its label before the note leaves, since a ref can name a
    withheld module.
  - **Keyed by SESSION, never by Gateway:** two sessions of one Gateway hold different workspaces, so
    a Gateway-keyed map serves one session's span for the other. The fence, the draft filenames and
    the held maps all take the qualified session address.
  - **Held edits have ONE road in, `HeldEdits`, shared by windows and raw files:** `apply` hands a
    transform what is held NOW, for a change to the set or an edit made without waiting. An edit carries
    an incarnation minted at open, because a symbol id or a path names which text and not which OPENING
    of it.
  - **An awaited answer lands only through `HeldEdits.land`, and names how:** `OverUntouched` over exactly
    the edit it was computed from, or `Folded` over the same opening still bound to the same `version`,
    folding in what arrived since, so no road chooses its own fields to compare. `HeldEditsTest` pins both.
  - **The disk follows the value, so the pair cannot drift:** `HeldEdits` diffs the winning before and
    after by incarnation and tells the store what each file should hold, under the same monitor as the
    state write. No caller names a file.
  - **A draft is one file, written then renamed, and carries the hash it was typed over:** a combined file
    would rewrite every draft on every keystroke batch, which is what `RunbookManager` pays. A reopen over
    moved text comes back stale with that base, so a save is refused rather than landing old typing. The
    store drains its own queue, reads included, and performs the newest intent per file. Every road
    reports a refusal rather than reading as a success.
  - **The foreground sweep is unfenced, and lands `Folded` instead:** the fence gives a key to whoever
    claimed last, so a sweep would discard the Refresh the owner just tapped.
  - **A re-provision is the repository's ONE `ProvisionFence`:** `WorkspaceHost.generation` is that
    fence, read by every workspace ops class, where each once kept its own epoch and one kept none. It
    recalls work that has not started and refuses what lands after, never a message already in flight.
  - **A view map beside `HeldEdits` is a `PublishedViews`:** its `Showing` is the key's token and the
    generation. The raw editor's and the tree's maps each hand-wrote this guard and each missed a case of it.
    A screen shown while composed goes through `keep`, and every token, keeper count, landing order and drawn
    view changes under its one lock: split across three structures, they disagreed three different ways. A
    showing's read belongs to the key, under a job of its own: one keeper of two leaving must not take the
    read with it, and only `show` answering as the starter may begin one, or two keepers each read the same key.
  - **An awaited answer lands only through a `ReadTicket`, taken BEFORE the read awaits:** `update` and
    `claim` take one, and refuse it once the showing has ended or a later ticket of the same slot landed.
    `keep` mints its own and hands it to `load`, so a keeper cannot forget. A showing orders a read against a
    leave, a reshow and a re-provision; the ticket orders it against another read of the same key, so no ops
    class builds its own read fence. A ticket that landed may land again, which is one op redrawing its own view.
  - **A slot names what an answer FILLS, so two halves of one view land apart:** a detail's source and
    knowledge, a ref's span and file, a folder's tree and its op. No slot means the view one read fills.
    Sharing one slot makes the half that lands first refuse the other.
  - **A change that awaited nothing goes through `now`, which takes the KEY:** a tap has no read to order.
    Anything that awaited must name the ticket it began with, and cannot honestly reach for a key instead.
  - **`SlotViews` types the slot:** a `Slot` lens reads and writes one part of a view, a ticket carries its
    slot, and a landing takes that part alone, so a cross-slot write does not compile and a slot that no longer
    owns its part (a removed plug, a re-added one at a new incarnation) lands nothing. `DeviceOps` holds only a
    `SlotViews`; `device-ops-residue.test.ts` refuses a fence, a counter or a raw flow there.
  - **A file operation is armed from a state read, confirmed once, and read back rather than resent:**
    `WorkspaceFileOps` builds the mutation only from the facts the confirmation showed, a folder's claim is
    taken once, and `settledOf` decides an unanswered one.
  - **The sandbox and the test fakes answer through `WorkspaceFileTable`:** the plugin's logical rules,
    pinned to the plugin by `tests/fixtures/workspace-file-ops/vectors.json`, which both runtimes run. A
    hand-written sandbox drifted from the plugin twice before it existed.
  - **Nothing decides inside a Composable**, since there is no instrumentation source set. The screens
    render and call; `WindowRules`, `RawFileRules` and `WorkspaceNav` hold the decisions, and
    `RawFileOps.views` holds what a raw file's screen draws.
  - **`WorkspaceOpenBus` HOLDS a request rather than emitting one**, since the roster may not have
    answered yet. The shell reads it by `standingOf`, takes it off the bus as it routes it, and lands
    it as `ShellNav.arrive` with `Arrival.FILES_ASKED` and the place, so no screen consumes a request
    and a roster tick cannot route it twice.
- `android/.../ShellNav.kt` / `DrawerNav.kt` / `ViewScope.kt` / `SideDrawer.kt` / `ScopedViews.kt` /
  `RootScreen.kt` / `ViewSwitch.kt` / `ShellOverlays.kt` - where the shell stands, the one menu, a
  session's view switch, a view filtered to a session, and what the shell draws over a screen
  (`Modals`, `OverlayRequests`). `docs/console.md` holds the whole of it
  - **Where the shell stands is one `ShellNav` value, read only through `drawn`:** a private
    constructor, every transition a member (the assistant's enter and follow, the summon and the page
    resolve included). It holds the root view beneath, the open conversation (its view, its Files
    stack, whether it arrived as the assistant's, and a menu pick over it), settings, the page stack
    and the re-snap generation. `drawn(ShellFacts)` answers one `Drawn` value, which the render, Back,
    the summon, the menu and the home read take; `heldTeam` is the one raw read, for the facts
    `drawn` needs. `arrive` decides the view and the re-snap together from an `Arrival`, so no road
    can land a conversation without deciding both.
  - **Pages are a stack, top last:** `push` ignores a repeat of the top, `replaceTop` swaps it, Back
    pops, and an arrival or `toRoot` clears it. `resolvePages` resolves each page, drops the gone and
    collapses adjacent repeats. No editor is a page.
  - **One menu, and `pick` is its one transition:** `MenuSheet` draws `RootView` in its order from
    every screen with a drawer. A session keeps only how it is shown (`ConversationView`: Chat,
    Terminal, Files), switched in its bar. A pick inside a session lands `over` it and Back returns
    to the session; Sessions and Assistant leave it.
  - **The menu's picks and its button run on the shell's scope:** a pick can swap the screen under
    the drawer, and a close launched by the screen that left would stop half way.
  - **Back is ordered by what is drawn over what, never by when a handler composed:** `drawn` is
    the one order the render and `backLayer` both read, and `App` holds the only shell `BackHandler`.
    Nothing draws over the lock: `ShellOverlays` draws everything the shell composes over a screen
    (the queue, the viewer, the link, row and forget dialogues, the entry dialogues, the request
    sheets, the fire sheet and the shown editor) and returns first while locked, and Back reads the
    lock before an open editor. The modals are one `Modals` value an arrival resets whole, and a
    close takes only the modal it was built for (`without`), so a late close leaves its successor.
    `shell-overlay-residue.test.ts` refuses an overlay composed in `MainActivity.kt` and anything
    but the host after its screens.
    `back-handler-residue.test.ts` refuses one anywhere else but the full screens it names with a reason.
    The drawer is one state, closed by every arrival and whenever a screen without it shows, so a
    drawer left open never reappears open.
  - **A filtered view is the root's view with a `ViewScope.Session`:** its Gateway for Runbooks and
    Policies, its spawn point for Routines, its own requests and grants for Vault. A pick over a
    session arrives filtered and `FilterRow` clears it; `Over` is the one rule for whether it filters
    and its scope. Sources, Automations and the assistant's session take no filter, and the first two
    list the session's Gateway first (`leading`). The filters are pure functions in `ViewScope.kt`,
    tested there; a screen takes the scope and asks.
- `android/.../AttachmentOps.kt` - attachment fetch-and-sweep state, and `deleteWhenDurable`, the one road a file is deleted by
  - **Committed first, then only what nothing names:** `commitFileOwners` writes threads, anchors,
    drafts and scheduled sends in one commit, and a failed commit keeps the files. A reference added
    between the check and the delete is not seen.
- `android/.../ThreadCut.kt` / `RowMenu.kt` - Clear above, and the Compact and clear above that runs it: `rowAbove`, `threadCut`, the cut's id floor and swallowed echoes, the confirmation's lines; the row menu and its confirmation. `docs/console.md` holds the rules
  - **A cut tells the plugins what it took:** once the cut is on disk, `clearThrough` hands the rows cleared and the rows left to every `ThreadCutSubscriber`, and the plugin bridge fans them to `threadCutHandlers`. A handler's `claims` and `onCut` read one rule, so the confirmation counts what the cut drops. The Designer's is `cardsAfterCut`.
- `android/.../ScheduledSend.kt` / `ScheduledSendOps.kt` - scheduled sends as Router-held intents: the record and its pure settle rules, the drain, the cancel intent, and the Router's result rows, all under one mutex
  - **The Router fires; the phone intends:** a record is pending until `schedule_send` is accepted,
    a cancel of an accepted record is pending until `schedule_cancel` is, and a reschedule is a
    fresh intent naming the version it replaces. `drainPending`, `cancelNow`, `rescheduleNow` and
    `applyRouterResult` are the only transitions, so a JVM test drives every one.
  - **A refusal is read against what the Router holds, never assumed to leave it empty:** a conflict
    adopts the armed record before handing the local text back, or the phone shows nothing scheduled
    while a send it cannot reach is still armed. `mirror` adopts only an `armed` or `firing` record,
    since a settled one is no dock.
  - **A record past its time settles from the Router's record, row or not:** `settlePastDue` runs in
    the pass for a held record with a `routerVersion` once `SETTLE_GRACE_MS` has passed its fire time,
    asks `schedule_list` on a backoff to `SETTLE_BACKOFF_MAX_MS` (`firstSettleAsk`, `nextSettleAsk`,
    kept in memory so a restart asks at once), and `settleFromRouter` answers a `Settle`: wait, sent,
    failed with the record's reason, cancelled, or gone. An unread list (`routerRecordsRead` null) is
    wait, never gone. The dock's tick (`nextDockTick`, `settleDue`) asks the repository for a pass, and
    no decision sits in the composable.
  - **One road settles a record, whichever order the evidence comes in:** `settle` is the only one. A
    send appends the message stamped with its fire time. A failed send lands in the thread as "Not
    delivered" under `failedSendOpId` (`<opId>.retry`), never back in the composer, and `echoRouter`
    echoes a send this phone no longer holds once per thread, the thread's own op ids gating it since
    `ChatRepository.append` dedupes nothing. A single consumer applies the Router's result rows in row
    order, so `sent` and `failed` of one schedule end the same either way round.
- `android/.../GoalOps.kt` / `Goal.kt` - armed goals and `/goal` line production
- `android/.../PresenceOps.kt` - team presence and read-anchor reporting
- `android/.../SessionOps.kt` - terminal and session controls
- `android/.../ChatRepositorySend.kt` / `ChatRepositoryThreads.kt` / `ChatRepositoryDomainLink.kt` / `ChatRepositoryInbox.kt` / `ChatRepositoryMigration.kt` / `ChatRepositoryStts.kt` / `ChatRepositoryDrafts.kt` - stateless repository extensions
- `android/.../RouterLink.kt` / `LinkView.kt` / `RouterSetup.kt` - the phone's standing with the Router: the record, its events and the typed reading of a failure, a status and a refusal reason; `linkView`, the one reading every surface draws; the setup steps owed before the phone is usable. `docs/console.md` holds the rules
  - **Nothing stores a connection fact but `ChatState.router`,** and only `RouterLink.Writer` folds one. `ChatRepository.noteRouter` is its one caller, fed by the Router's doors (`ConsoleRouterTransport`, `ConsoleSocketDriver`) and by setup. `router-link-residue.test.ts` holds the feed to them and refuses the old flag names.
  - **A door tells the link where the round trip happens:** a path that proves the Router answers cannot skip it, and a path that saw nothing has no event to send. `ChatState.notices` holds dismissible failures; the link never reads one or clears one for a cause of its own.
  - **Setup is level-triggered:** `RouterSetup.settle` runs at the top of every poll pass while anything is owed, so a failed attempt cannot leave the phone stuck. A fault is never a refusal: the setup calls throw the status of a response that is not the op's own answer. `ChatRepository.linkChanged` is the one road for a blob that changed or went, and a run begun before it lands nothing.
  - **A reason is read by type or token, never from prose:** an exception's class, a status code, `OP_REASON_*`. A new `LinkView` state does not compile until every surface draws it.
- `android/.../Notices.kt` / `Reasons.kt` / `NoticeFrame.kt` / `ThreadDocks.kt` (`NoticeStack`) - the phone's dismissible failures: `ChatState.notices`, its raise and clear rules and the host each screen draws them in; every sentence a notice or a failed row shows; the strip laid out above the whole app; the stack in a conversation's Chat view. `docs/console.md` (Notices) holds the rules
  - **Every sentence comes from `Reasons.kt`, the link lines from `LinkView.kt`:** a writer passes an `Act` and a reason, never prose, and `reasonSentence` maps a token in `REASONS` or falls back to the act and the token. `thrownSentence` never names a class, and `ReasonsTest` prints the whole table to `build/reports/error-prose.md`.
  - **A key is cleared by the same act succeeding, and nothing else clears a notice:** `raiseNotice` replaces the notice holding a key (an unkeyed notice, its own repeat), `withoutNoticeKey` is the success path, and only the owner's X or Clear all (`dismissNotice`, `clearNotices`) removes one otherwise.
  - **Outside Chat the notices are a strip, not an overlay:** `NoticeFrame` wraps `App` and lays `NoticeStack` above the screen, which is pushed down and has the status bar consumed; in a conversation's Chat view the stack sits with the docks. `noticeAt` (`noticeHost`) decides the host from what is drawn, and `notice-residue.test.ts` refuses the retired one-line error and the snackbar queue.
- `android/.../RouterReach.kt` / `ConsoleRouterTransport.kt` / `ConsoleSocketMode` - Router addresses, the OwnerOp post with reach failover and pinning, socket mode
- `android/.../OwnerFacts.kt` / `GatewayEnrollment.kt` / `EnrollCeremonyOps.kt` / `DeviceApprovalOps.kt` / `DomainAdminOps.kt` / `TrustOps.kt` - federation delegates
- `android/.../PendingEnroll.kt` / `PendingEnrollOps.kt` - a Gateway's unfinished setup on the phone: the record, `gatewayScanOf`, `bootstrapPickupId`, `gatewayCardState`, `pendingStep`; the record store and the pass the drain calls on its visible and background paths
  - **The phone keeps the frame and the Router only holds it:** the pass reads
    `gateway_bootstrap_status` on a backoff from 5 to 60 seconds and hands in again when the Router
    does not hold the frame.
  - **A record retires on a registration that follows the admission:** `registeredSince` wants the
    roster's entry connected under another incarnation than the one held at admission, so a stale
    roster retires nothing. The card reads the same rule, so a Gateway with no sessions reads online.
  - **`pendingStep` also retires a Gateway the keyring stops admitting,** so a revoke from any
    screen or device needs no second write. `ownerOpResult` in `ConsoleClient.kt` reads an owner
    op's answer for this client and the hold's.
  - **A pairing is a Gateway's, and `TrustOps` holds the one in flight:** the wizard names the
    Gateway at listen or request; every poll, confirm, retry and cancel reads the held `Pairing`,
    nonce included. No pairing call defaults its Gateway.
  - **A share is the Router's record:** `TrustOps` posts and lists shares as owner ops, offers every
    shareable session on every Gateway, and lets a session be shared to a Domain only when its own
    Gateway's `peers` projection holds that Domain; peers not yet read allow the attempt
    (`canShareTo`). The linked Domains are what each Gateway last answered (`linkedOwners`), and a
    Gateway that restarts keeps its last answer until it gives another. A friend Domain's sessions
    are pruned only once every Gateway's peers have answered without it (`peersLanded`); an untrust
    whose revokes landed drops them itself (`withoutOwner`), whatever is still unread. An untrust revokes the
    Router edges first and keeps the owner trusted and pending until every one landed.
- `android/.../SasExchange.kt` / `EnrollCeremony.kt` - shared SAS exchange and commitment core for FLOW-1 and FLOW-2
- `android/.../crypto/ContentKeyring.kt` - phone keyring, classify then commit
- `android/.../crypto/ContentAadKinds.kt` - sole AAD kind builders, twins of `content-envelope.ts`; `aad-kinds-residue.test.ts` pins both to one vector each
- `android/.../MainActivity.kt` - `Repo`, activity, and `App` navigation shell
- `android/.../EditorSessions.kt` / `RecordMenu.kt` / `EditorScaffold.kt` - an edit in progress, a record page's removal, and the one full-screen editor frame with its leave dialogue and `rememberEdit`
  - **One model for the four editors:** `EditorSessions` holds one `EditState` per editor kind: each edit as an `EditSession` (the draft, what it opened as, its opening, what the last send said, busy), the key a page draws (`shown`) and a Back that asked (`leaving`). `open` is the only mint, and only for the shown key; `edit`, `discard` and `send` take the opening, so nothing from a page that left touches a later one. A send runs on the repository's scope (`repo.command`) and settles only its own opening, so Back loses no answer.
  - **Back asks before discarding an edit:** `askLeave` leaves at once on an unchanged draft or a send in flight, else sets `leaving`, and `EditorScaffold` draws "Leave and discard changes?" from it (`EditState.asks`). The shell's one `BackHandler` and every editor's back arrow call it, and no editor has another way out.
  - **The model alone says which editor is open:** `Editors` shows one at a time across the kinds, the shell derives the `ShownEditor` from their states (`shownEditorOf`) and `ShellOverlays` draws it. A page that leaves composition ends nothing, so the lock, a rotation and a second activity are not a Back, and a save that lands drops its edit and unshows it in one update. `hide` is every other exit: an arrival, a window that finishes, or an editor that may not stay (`editorStands`: the vault for a policy, its home for an event automation); it drops an untouched edit, keeps a touched or busy one for the next showing, and tells a refusal it takes off the screen, once. `editor-owner-residue.test.ts` refuses a page that ends its edit on disposal, a second holder of an edit key, and a mint outside `rememberEdit`.
  - **A go-ahead belongs to the draft it was asked about:** an edit that changes the draft drops a said its owner names (`clears`), so a dismissed confirm is not raised again for a draft the owner was not asked about. A refusal line stays.
  - **An editor stands on what is stored, never on what is typed:** `AutomationOps.editsEvent` reads the session's `draft.original`, else the listed row, so a draft switched to an event and kept through a home move can still be opened and discarded.
  - **A send that stays with no editor showing it is told:** its refusal reaches the owner as a transient message (`leftLine`), so a save or delete that failed after Back does not fail silently. An untouched edit is dropped once told.
  - **Typing stays in the screen:** the runbook, routine and policy editors hold what is typed in a `MirroredDraft`, which writes each change through to the session as it is made, since a text field fed from a flow lags a frame.
  - **What an edit must remember is held in the edit:** a page can leave and return under the lock while its list goes unread, so the routine editor reads the kept zone and whether the rule moved from the record its draft was made from (`RoutineDraft.base`), and a title and Delete read whether the editor was opened on an id.
  - **An editor opens once its record is read:** `rememberEdit` opens on `EditStanding.READY`; a held record whose list is still being read draws a waiting page, and one whose list failed, is not served or lacks it says so (`waitingLine`), never a blank draft under "Edit".
  - **A record is removed from its top bar's menu:** `RemoveMenu` then `ConfirmDialog`, on the runbook, routine, policy and automation editors, a device's page and a service's entry. `delete-affordance-residue.test.ts` refuses a delete button drawn anywhere else.
- `android/.../SessionsScreen.kt` / `SettingsScreen.kt` / `ThreadScreen.kt` / `ComposerField.kt` / `Onboarding.kt` / `SessionDialogs.kt` / `ReorderableTabRow.kt` / `TabDragMath.kt` / `TimeText.kt` - screen siblings and tab geometry
  - **One composer field for the panel and the thread:** `ComposerField` wraps the text field; while `working` it dims the border and draws the comet from `cometSpans`, the one span rule.
- `android/.../RendererPoolBindings.kt` / `AppOverlays.kt` / `LinkMenu.kt` - WebView pool, overlays, and link actions
- `android/.../SettingsSections.kt` / `SettingsSystem.kt` / `SettingsVoice.kt` - settings leaf screens
- `android/.../SessionsHeaders.kt` / `SessionCard.kt` / `SessionCardPreview.kt` / `SessionsEmptyState.kt` - the Sessions view's headers, cards, rules, and empty-state machine
- `android/.../SessionWord.kt` / `SessionForget.kt` / `ForgetRules.kt` - the one status word a conversation and a card show, the one forget every surface calls, and what a forget asks first (`forgetAsk`: a stopped container, or a Gateway a current roster says is offline) with how a forget held on a container start settles (`containerSettle`) and what it then does (`heldForgetStep`: nothing for a session forgotten meanwhile)
  - **The forget is the gate, whole:** the shell's `requestForget` asks, then `SessionForget.forget` runs the state drop, the plugin handlers, the notification cancels and `onForgotten`, which leaves the conversation. A held forget commits later, so nothing a surface owes runs before it.
- `android/.../LaunchStatus.kt` - a session's launch as the thread docks it: `startingDock`, and a failed launch held per session (`launchErrorOf`, `holdLaunchError`, `launchErrorsAfter`)
  - **A launch threads no row:** one that comes up posts nothing, and a failed one's `notice` row (`launch: "failed"`) is held as a dismissible dock, the card's headline and its own notification.
  - **The drain writes a held failure before its cursor moves,** or a crash between them loses the row for good. Every other change is persisted by one collector in `ChatRepository`, and the service cancels a launch's notification from the same map (`staleLaunchNotifications`), so no site cancels one itself.
  - **A name off the wire is checked, never asserted:** `teamInfoToTeam` and `addressableContainers` drop a row that is no address, so one bad name cannot lose a roster update.
- `android/.../ContainerOps.kt` / `ContainerRules.kt` / `SpawnChoices.kt` / `SandboxContainers.kt` - a devcontainer's Start and Stop; its header's buttons, `containerAt` and `containerStartLine`; a Gateway's spawn points (`spawnChoices`) and what a pick of one means (`spawnReadiness`, `initialChoice`); the emulator's Gateway for a start, a stop and a create. `docs/console.md` holds the rules
  - **One readiness, every picker:** New session, a fire's "Start on" and a container header's Create read `spawnReadiness`, so a state added there shows in each. A container whose state word this build cannot read is listed and cannot be picked.
  - **A stopped container is one press from a build:** a create starts it, so a remembered project preselects only a ready one and the list marks the rest.
- `android/.../vault/` - `VaultSealing.kt` / `VaultManager.kt` / `VaultRouterWriter.kt` / `VaultDraft.kt` / `ApprovalGate.kt` / `VaultScreen.kt` / `VaultEntryDialog.kt` / `VaultRequestSheet.kt` / `VaultRequestTile.kt` / `TypedRequestRules.kt` / `VaultPrompt.kt` / `PresenceActivity.kt` / `VaultRequestText.kt` / `VaultState.kt` - the sealing door, the held entry set with pending requests and the retry count, the owner-op writer, the draft-to-sealed rule, the one owner-presence gate, the view, the editor, the tile that shows a waiting request in the conversation it came from, the request card with its in-app sheet and, for a typed request, the card's every rule (what it says, the secrets it offers, the remember plan, the refusal lines), the overlay that draws the same card, the see-through activity the overlay's presence prompt runs on, its pure text rules (title, requester, countdown, repeat line), and the held request shapes
  - **The overlay draws the sheet's card, never its own:** `VaultPrompt` hosts `VaultRequestCard` in a `ComposeView` it owns the lifecycle of, so the two surfaces cannot drift. Its entry approvals pass `ApprovalGate` through `PresenceActivity`, since a service has no activity to prompt on.
  - **The presence gate is an argument of every road that approves with an entry, and its answer is typed:** `VaultOps.saveTyped`, `answerWithEntry` and `saveAndAnswer` take `presence` and call it before any match or release, and `ownerPresent` is the same gate for the rest. `ApprovalGate.require` answers a `Presence` (`Asked` with a receipt, `NotOwed`, `CouldNotAsk`, `Refused`), and only the gate's file says `Asked` or `NotOwed` (`notOwed()` is what the overlay asks before it steps aside). `cardPresence` is the one reading of it, as `Passed`, `Declined` or a `Fault` with its line, and the overlay's bridge (`PresencePrompt`, `PresenceActivity`) carries the value whole and settles one answer per ask. The prompt under it answers an `OwnerPrompt`, and `passes` is the one rule for who gets through: a pass, or a phone with no screen lock at all (`promptWithout`, from the keyguard's `isDeviceSecure`). A prompt the phone could not show refuses and reads "Problem reading biometrics.": on the card for every card road (`PlainAnswered.Fault`, `TypedSave.Refused`, `EntryAnswered.Stays`, `SavedAnswer.NotSaved`, a reveal), `AppLock.fault` on the lock screen, and a keyed notice for a caller with no card (`MutableStateFlow<ChatState>.asked`, `VaultOps.present`), which only a prompt that was shown and passed clears: an act that asked nothing (a lock that is off, a tightened approvals setting) answers null and leaves it. No activity to prompt on, a prompt activity that never opens and a gate that throws are could-not-ask, never the owner backing out. Turning the app lock on asks first (`ChatRepository.lockAsks`), so a phone that cannot ask is never locked. `biometric-gate-residue.test.ts` holds who may ask, who may say a prompt passed, and who may mint or spend the carry. A saved value is matched against the held secrets first, so a match lands on that secret and no match opens the new-entry form with both ids minted once.
  - **A match's presence covers the Approve that follows, once, and only the gate can mint it:** `ApprovalGate` holds at most one `MatchPresenceProof` (request, entry and its revision as matched, the lock epoch, a monotonic time). `grantMatch` takes the receipt of an `Asked` answer, which nothing outside the gate's file can construct, and writes a carry only when "Every approval" with the app unlocked held when the prompt was asked and still does after the match; a receipt mints one, and its minute runs from the prompt. `spendMatch` is its one reader, through `consumeMatchPresenceProof`: the same request, entry, revision and lock epoch within `MATCH_PRESENCE_WINDOW_MS` skips the prompt, and any read spends it. `VaultOps` passes the facts and can drop the carry (`clearMatchProof`), never build one. The window and the carry age on the gate's one monotonic clock. Another secret picked, another request, a settle, a takeover, a change of the approvals setting and a re-provision drop it, the last two ending the window too (`forget`); a relock moves the epoch synchronously, so no observer has to notice it. `answeringOf` is the one reading of a request's answering secrets, and honours them for sudo alone whatever the Gateway's build.
  - **A vault save's busy flag clears on every exit:** `withBusyState` in `vault/VaultBusy.kt` wraps the form's Save and Delete and the card's operations, clears in `finally` and rethrows a cancellation. The sandbox answers the vault's own owner ops (`sandboxVaultOwnerOp`), so the form's save finishes in the emulator.
  - **A request a policy took over is followed by its replacement:** `takeoverOf` reads the entry request whose `replaces` names a card's id, `shownRequest` is what a card on that id draws, and the service's collector reads it before it treats the id as gone. `SandboxVault.kt` is the emulator's Gateway answer, with a refusal by request id (`SANDBOX_VAULT_REFUSALS`).
- `android/.../crypto/ContentSealing.kt` - the one sealing door the board and the vault subclass; only the AAD builder differs
- `android/.../plugins/vault/VaultPlugin.kt` - claims `vault:request`, forget, and wipe
- `android/.../board/` - board reducers and durable `BoardManager`, which writes before it publishes, as `VaultManager` and `RunbookManager` do
- `android/.../board/BoardSealing.kt` / `BoardRender.kt` / `BoardIntent.kt` / `BoardOptimistic.kt` / `BoardRouterWriter.kt` - board text sealing, render with cached fallback, edits held as intent, optimistic apply, and the CAS drain
- `android/.../ConsoleTransportCoordinator.kt` / `ConsoleSocketDriver.kt` - one Router consumer across two transports, and generation-fenced frame routing
- `android/.../Federation.kt` / `FederationManager.kt` / `CrossDomainLink.kt` / `ConsoleClientCrossDomain.kt` / `CrossDomainPresenceUi.kt` - cross-Gateway routing, identity, allowlist, sealing, replay, and presence
- `src/mcp/` - Claude Code tools
- `src/shared/system-reminder.ts` - sole builder of the reminder tag, `neutralizeMarkup` and `oneLine` for model-bound text, and the files, reminder, body order; never for phone-bound text
- `src/mcp/toolGuard.ts` / `everyTool.ts` / `scripts/check-tool-definitions.ts` - the wrap every tool registers through: its definition checked, its results and thrown errors neutralized; every tool group with every capability on; the build's run of the two
  - **A definition a GPT host refuses never registers:** `guardTools` throws at registration when a description, or any field's, passes `TOOL_DESCRIPTION_LIMIT` (1024). A Copilot or Codex host sends every tool with every request, so one long tool fails every message. `bun run build` registers `registerEveryTool` through the guard before it versions anything, and `tool-description-budget.test.ts` checks that list against every registrar `index.ts` calls.
- `src/mcp/bridge/` / `channel/` / `references/` / `board/` / `designer/` / `connector/` - bridge, channel, reference, board, designer, and connector tools
  - **A pushed row reaches the session once per delivery id:** `channelPushDelivery.ts` acks a repeat
    it already emitted, across reconnects. A restart forgets, so delivery stays at least once.
  - **A CLI whose delivery is typed gets channel tags typed into its pane:** `channelNotify.ts` builds shared content and metadata; `helpers.ts` holds one transport per delivery kind, and the typed one serializes pushes, retries busy panes, and acks after typing.
- `src/mcp/vault/vaultTools.ts` / `vaultRun.ts` - vault tools over the gateway's loopback routes, and the child run that injects a value and scrubs it from the output
- `src/mcp/routines/routineTools.ts` - `get_session_routine` and `report_session_routine`, registered for any token-bound session and behind no capability
- `src/shared/workspace-op.ts` - the workspace plane's wire vocabulary, beside `host-op.ts` and for the same reason: Gateway to an MCP-side process, never to Kotlin
- `src/shared/host-op.ts` / `src/mcp/devcontainer/hostOpRunner.ts` / `tmuxCore.ts` / `hostDaemon.ts` - `typeIntoPane` wire, dispatch, composer polling, bracketed paste, and host handler
  - **A delivery types mid-turn, an `/exit` waits for idle:** `/session/type` sends `midTurn`, so a channel tag lands once the composer is ready and empty while a turn runs. The assistant's restart sends none. No test here runs a live Copilot pane; the working-screen fixtures only show its composer stays drawn and empty.
  - **Enter waits behind typed keys:** every Enter the daemon presses after text, a paste or a menu's cursor moves is held `ENTER_PAUSE_MS` (`pressEnter` in `tmuxCore.ts`). A CLI reads keys that arrive together as one paste, where the Enter is a newline and the line is never submitted. The phone's goal typing gets the same gap by sending Enter as its own op.
  - **`WORKSPACE_BOUNDS` owns every wait on one op:** each class's plane wait and handler budget sit
    inside the phone's read timeout, `CONSOLE_ANSWER_WAIT_MS` in `console-protocol.ts`, generated into
    `Protocol.kt` and diffed by the Kotlin gate. `workspace-bounds.test.ts` pins the order. A save's
    bounds exceed a read's.
  - **Only a refusal is known to have written nothing:** `answerForConsole` answers any other failure of a
    write, a span save or a file mutation, as `unknown`, and the phone reads back. A retried write is safe,
    since the hash refuses the second one and a read-back of the owner's own text is adopted.
  - **Every file mutation is one op, `mutateFile`, carrying a strict `FileMutationSchema` variant:** a new
    operation is a variant with its own preconditions, not a new op, and a reader that does not know a
    precondition refuses the mutation rather than stripping it.
- `src/gateway/workspacePlane.ts` / `workspaceOpCoordinator.ts` - the Gateway's end of the plane, and the correlation it settles on
  - **A socket IS its generation, and a reply from a replaced one settles nothing:** the generation lives
    in a `WeakMap` keyed by the socket object rather than on `WsData`, since a generation is the plane's
    business. `failGeneration` settles only what one dropped socket carried, so another session's waits
    are untouched, and `close` calls it BEFORE its stale return, or a replaced socket's requests wait out
    the full timeout for an answer that can never come.
  - **One socket per session, chosen by `resolveLiveIncarnation`:** a session can hold several plugin
    sockets keyed team then `subId`. Nothing broadcasts, and no second selector exists.
- `src/mcp/workspace/plane.ts` / `handlers.ts` / `handlerKit.ts` / `mutateFile.ts` - the plugin's end: the frame it answers, the reads, the shared deadline, confinement and size rule, the span save, and the file mutations; at-most-once through `src/shared/op-dedupe.ts`, which the assistant's action dispatcher takes too
  - **`withinCap` is the one size rule:** every answer is measured as serialised UTF-8 and refused whole
    with `rows` and `bytes`. `answerForConsole` types that refusal for the drill-ins alone, since an older
    phone decodes an older read as its own answer.
- `src/mcp/workspace/facets.ts` / `history.ts` - the drill-ins: a symbol's uses, uses from, members, hierarchy, comments and line history, and a file's history
  - **A withheld row is dropped before any read** and counts nowhere, so no count reveals it existed. So
    is a row whose file or line has left the disk, since the index can be behind it, and every count is
    taken after that filtering.
  - **EVERY id an answer carries is gated, never only the op's subject:** a holder, a top level, a target,
    a member, a hierarchy node and an outline symbol each name their OWN module, which
    need not be the module of the row that led to it. `servedGate` is the one rule, and a summary is shown
    only when its module and its id both pass.
  - **A use is gated on the row's own module, not its target's:** a reference written in a served file
    whose target is withheld reads as unresolved under its written name, or a symbol's own uses vanish
    for pointing somewhere this plane does not serve.
  - **The comment page is this plugin's, not the daemon's promise:** the answer slices to its own cap and
    sets `truncated` when Lexicon hands back more, and `total` says how many there are so the row and the
    list agree. A comment is its raw text, as Lexicon's own `find_comments` shows it.
- `src/mcp/workspace/answerGate.ts` - the last check before an answer leaves: every field the answer schemas declare as a path or a symbol id is read against `servedGate`
  - **An answer is gated on what came BACK, not on what was asked:** the requested id being served says
    nothing about the module Lexicon answers with, so the fields come off the schemas rather than a hand
    list, and a field added later is covered without anyone remembering. A write refuses as a failure,
    never as a refusal, since a refusal tells the phone nothing was written.
- `src/mcp/workspace/paint.ts` - code spans painted from Lexicon's own facts (declaration kinds, reference roles, literal kinds) onto `CODE_TOKENS`, with no second parser; `tests/fixtures/code-spans/vectors.json` pins the tokens
  - **No grammar ships in the plugin:** paint reads Lexicon's facts, so a highlighter's language set cannot be bundled by mistake, and the bundle has no size ceiling.
  - **A file write is plain file work, never Lexicon:** `writeOf` compares the sha256 of the bytes on disk,
    fills a sibling temp through `writeFileAtomic`, hashes the file again, confines the resolved path again,
    and renames. The gap between that hash and the rename is not closed, and the rename gives the path a new
    inode. A write refuses what a read would not offer (`readOnlyReason`).
  - **Each mutation lands only while what the phone named still holds, and places atomically:** delete and
    move bind the source's identity as well as its hash, and re-check it last; create links a temp into
    place, so a taken name refuses; a move to a free name links then unlinks, and a filesystem without links
    refuses rather than risk replacing a name taken meanwhile; a copy hashes its temp against the confirmed
    bytes before placing it; a replace names the file it replaces. A folder is refused as a source and a
    destination, and another name for the same file is refused as a destination. `fileStateOf` answers
    what a phone arms from. Every check then its landing leaves a gap only a lock every writer honours
    would close.
  - **The plugin answers off the agent's turn:** the socket callback and the agent's work share a process
    but not a thread of control, which is what makes an op cost no tokens.
  - **An op this build cannot read is refused at once:** silence would hold the Gateway to its full wait.
  - **The save is Lexicon's compare-and-swap:** `saveSpanOf` reindexes the module, previews a
    `replaceSpan` step, applies its guard with `settle: "own"`, and answers the span as it now stands. An
    apply refuses stale only before writing, so it previews once more, still under the owner's span hash.
    A preview writes nothing, so its refusal is `rejected` or `stale`. Any other apply failure, answered
    or not, may have written, and answers `unknown`. `gone` is only the index saying the span no longer
    resolves; a read back that failed says neither. A module whose bytes a UTF-8 decode would change, or
    text holding a lone surrogate, is refused with its reason.
  - **At-most-once is defined HERE, because nothing upstream defines it:** the plane is neither a transient
    value op nor the Router's delivery ledger. `createOpDedupe` replays a settled answer for a repeated key
    AND joins a flight already open, since a replay arriving before the first answer would otherwise do the
    work twice. A thrown op is not held: nothing was answered, so a retry must run.
  - **A symbol id is confined too, not just a path:** an id EMBEDS its module, and Lexicon checks only
    lexical containment. Without `confinedModule` an indexed `.env` would answer through `symbolSource`.
  - **ONE deadline per op, never a budget per call:** two calls each given the full budget outlast the
    plane's wait and reinstate the blind timeout the budget exists to prevent. `boundedSession` hands
    each read what is left as Lexicon's `gateWaitMs`, so a read held behind an index write past it
    never runs; a write keeps no bound.
- `src/mcp/workspace/loadFile.ts` - the one reader of a workspace file: regular files only, sized before the read, text or nothing, with the hash of its bytes and whether it was transcoded. Shared by the refs snapshot road and the phone's file road; containment is the caller's.
- `src/mcp/workspace/confine.ts` - which project files the phone's file road may reach, `fileIdentity` for a mutation that must bind a file rather than bytes, and `namesOneFile` for two names of one file. A caller's `Withhold` runs where `withheld` runs, which is how the assistant gate refuses its own instruction files
  - **Every rule runs against what a path RESOLVES to, never its spelling:** a link defeated containment
    once and exclusion once, both by being checked as written. `withheld` is therefore ONE function run
    over the written segments and the resolved ones, so a rule added to it cannot reappear in only one
    pass. `resolveTarget` answers the real path, existence and directoryness from a single resolution,
    since two calls deciding one fact left a window where a link created between them was admitted.
  - **Not a security boundary, and it must not be described as one:** the session it runs in can already
    run commands. It buys a tree that cannot wander and a refused mis-tap. A read does not compare inode
    identity, so a hardlink to an outside inode is admitted; `realpath` cannot see one and `nlink` would
    refuse legitimate links.
  - **The Windows rules are platform-gated:** the plugin serves its OWN filesystem, so no path here
    describes another machine. Ungated they refused `aux.ts` and any name holding a colon, both legal
    elsewhere. A short name, a trailing dot and a junction are not refused at all, since each resolves.
  - **`.git` is withheld; `node_modules` is only unlisted.** Bulk is hidden from a tree and served when
    named, secrets are served to nobody. A directory is judged by what it is: `.env.d` as a directory is
    listable, the same name as a file is not.
  - **Filing a report is what narrows a run's authority, and the window only moves earlier:**
    `noteReport` floors `workUntil` with `Math.min`, so a second filing replaces the words and buys
    no time. Otherwise a session holds its routine's secrets open one report at a time. A run that
    is over answers `not_working` rather than accepting silently.
- `src/mcp/devcontainer/` - host daemon plumbing and per-session tools
- `src/mcp/devcontainer/hostResolve.ts` - pure host/workdir/watch-target resolution and tmux command construction
- `src/mcp/devcontainer/windowsSpawn.ts` - Windows PowerShell probing, WSL path translation, and native directory listing
- `src/mcp/devcontainer/buildTranscript.ts` - latest `devcontainer up` transcript and pane-less terminal fallback
- `src/mcp/devcontainer/agentTargets.ts` / `codexTargets.ts` / `copilotTargets.ts` / `opencodeTargets.ts` - one supervised child per execution target for every backend (`ExecutionTargetManager`), the child env scrub and the one process adoption (`adoptProcess`); each backend's launcher
- `src/mcp/devcontainer/claudeRunner.ts` - `claude -p`, pidfiles, TERM/KILL cancellation state, replayable result outbox
- `src/mcp/devcontainer/codexAppServer.ts` - JSONL transport and fail-closed App Server client
- `src/mcp/devcontainer/copilotHeadless.ts` - Content-Length JSON-RPC transport, the headless Copilot client (protocol version 3, allow-all mode at create) and `HeadlessTurn`, the one fold of a turn's events
- `src/mcp/devcontainer/codexThreadLifecycle.ts` - one queue per thread record, so a record `started()` replaces gets a fresh one; settled-turn archival; bounded retirement
- `src/mcp/devcontainer/codexTurns.ts` - a Codex turn from its first frame to its end (`CodexTurns`): its output, the promise its handle waits on, its hold deadline, and the one decision of how it ended; sole `answerOf` reader
  - **A turn it holds ends in one place, whoever saw it first:** a frame, a read, a deadline and the thread's own published terminal all go through `end`, which resolves the handle and remembers the terminal. A child's exit fails every turn it holds. `CodexBackendSession` holds no per-turn state.
  - **A handle registered after its turn ended is already resolved,** from the last 256 ended turns, so a terminal that beats its own start reply or an adopt's read is not lost.
  - **A hold is never left without a deadline:** a completed turn with no answer is `holding` with a timer or `checking` with a read in flight. A read that still says running arms the next deadline, and the third ends the turn on what was witnessed.
- `src/mcp/devcontainer/agentDaemonCore.ts` - shared daemon registry, generation fence, serialization, numbering, outbox, the once-per-id op ledger, and retire-before-remove
  - **An acknowledgement naming another daemon is ignored:** every daemon numbers its targets' generations and events from the same start, so one meant for a replaced daemon's stream would drop this one's frames.
- `src/mcp/agents/backendSession.ts` / `drivers.ts` / `codexSession.ts` / `copilotSession.ts` / `opencodeSession.ts` - the driver a backend is to the daemon and to local mode alike (`AgentBackendSession`: open a thread, resume one, start a turn that answers its id now and its outcome later, steer, interrupt, inspect, list models); the table pairing each backend with its launcher and its session; Codex's, over its App Server client; Copilot's; OpenCode's
  - **A steer says what it knows:** `taken` when the driver knows the turn holds the prompt, taken or queued for its next step, nothing when it only sent it. A sent-only steer is given again as a new turn when its turn has ended.
  - **A prompt has a key, the operation's id:** a driver that can tell lands a repeat under one key once.
- `src/mcp/devcontainer/agentDaemonRuntime.ts` - the daemon's agent runtime: a target manager and service per backend, connection hello and replay, command and acknowledgement routing, model listing
  - **The fake host and `hostDaemon.ts` build the same runtime:** a frame order or a recovery rule cannot differ between the shipping daemon and the tests. The fake host swaps only the drivers.
  - **A scripted session offers what its real session offers:** the service picks recovery branches by which driver methods exist, so `REAL_SESSION` in `scriptedAgents.ts` names each backend's set and `agent-daemon-runtime.test.ts` holds it to the real classes. Only OpenCode's keys a prompt, so only its scripted session drops a repeated start.
- `src/mcp/agents/turnRunner.ts` - one driver session's turns, run the same way by the daemon and by local mode: the start with its adopt, the message with its steer, the stop, the hold of what a child says early, thread memory, and the silent-turn watch
  - **A rule of a turn is written once, here:** `AgentDaemonService` publishes what the runner tells it and `LocalAgentHandlers` records it. What a record alone knows stays with the record's owner: a pending interrupt and not-found are the Gateway's `AgentService` and `LocalAgentHandlers`.
  - **Its side hears a turn before anything said about it:** `accepted` runs when the turn is known, and what a child reported for a turn not yet announced is held (`whenAnnounced`) and told after it. The daemon sends its `accepted` receipt there; local mode writes its turn record there.
  - **A steer names the turn its sender believes is running** (`expectedTurnId`), and no other is steered. The daemon passes the command's; local mode passes its record's.
  - **A steer whose turn ended under it opens a new turn with the prompt,** so the message is never reported steered into a turn that is over. Whether it ended is asked of the turn's own promise (`settledNow`), never read after a count of promise hops, and both posts carry the operation's id as their `key`, so a driver that can tell lands one prompt. A refused steer also asks the driver's `inspectTurn`, since a driver may hold a finished turn's terminal: Codex waits up to ten seconds for a final item, and reads a turn it holds as running until the answer is in the read, so no empty answer is published.
  - **A turn found running after a failed start is adopted once:** `begin` adopts what `adoptTurn` answers unless the runner already told of that turn, which is another prompt's.
  - **A thread the session does not hold is resumed before its turn,** and a driver that cannot resume one answers that the agent ended with its process. `begin` holds a turn's thread, so no caller does. The runner forgets the least recently used idle threads past 256, only where the driver can resume one.
  - **The runner remembers how its last 256 turns ended,** and `inspect` answers one of them from that memory before it asks the driver. A reconcile about a turn whose terminal the outbox dropped is therefore answered on a driver that cannot inspect, where the agent would otherwise stay `recovering`.
  - **A silent turn is read, then interrupted, then given up:** only for a driver that reports life (`onProgress`). After 600 seconds `watch` inspects the turn, tells of one that settled, interrupts any other, and gives its session up when it stays silent. `live-turns-residue.test.ts` holds that state to this file.
- `src/mcp/devcontainer/agentDaemonService.ts` - the generic daemon service: a backend's commands run through a session's `TurnRunner` and answered on the daemon wire, with the reconcile, the sweep and the model listing
  - **A driver that closes retires its session,** whether or not its child is still alive, and its running turns end as lost.
  - **A reconcile rebinds a running turn to the owner it names,** since a session handover renames the owner while the turn runs.
  - **An idle child is reaped only when its threads can be resumed** (`threadsResumable`) and its driver is not `busy`. A child that cannot be reaped and was opened only to list models is given up when the listing ends, and listings of one target share one read.
  - **A reconcile adopts a running turn only on a thread the session holds** (`adoptTurn`). One about an earlier turn while a later one runs inspects the earlier and settles it.
- `src/mcp/local/` - daemonless agent backend
- `src/mcp/local/localAgentRuntime.ts` - the lease, the operation claim, one message or stop per agent at a time, the shared model listing, and the dispatch to a request kind
- `src/mcp/local/localAgentHandlers.ts` - local mode's agent records over a `TurnRunner` per child: what a request answers, and what the runner tells it
  - **A child that closes ends the turns it ran as lost,** by a reap, a drop or on its own, as the daemon's retirement does.
  - **A plugin that exits deletes the threads it holds** (`LocalAgentRuntime.shutdown`), a running turn's once interrupted, within `LOCAL_THREAD_END_MS` of the plugin's exit wait. The child ends either way, and none opens after it.
- `src/mcp/local/localChildSession.ts` - the one child: open, idle reap, drop, shutdown
- `src/mcp/local/localOperationLedger.ts` - operation identity claim and release
- `src/mcp/agentDispatch.ts` - agent tool serving seam
- `src/mcp/agentRequest.ts` - every backend's request body (`agentRequestBody`), its per-invocation replay ids, the Gateway dispatch, and the posted answer
- `src/mcp/agents/agentTools.ts` - one shared `agentStart`, `agentMessage`, `agentCollect`, `agentStop`, `agentDelete`, `agentList`, and `agentListModels` tool set; an option a backend's row does not take is refused by name, and a start names its backend unless one is enabled
- `src/shared/agent-turn-marks.ts` / `agent-collect.ts` - which of an agent's turns were collected and told, kept on the agent; the list row and collect answer every backend and local mode share, and `threadExpired`, the one rule for a thread's 24 hours
  - **A thread's clock is its record's `updatedAt`:** a collect that hands turns over moves it, and the hourly age pass reads it on the Gateway and in local mode. The Gateway's pass is one catalog write per session and backend (`expireAll`), since each write is the whole snapshot. A record with an uncollected turn stays, threadless and `expiredAt`, until collected. `docs/agents.md` holds the rules.
- `src/mcp/capabilities.ts` / `capabilitiesTool.ts` - capability gating and guidance
- `src/federation-server/` - live self-hosted federation Router
- `src/federation-server/routerServer.ts` - public `handle(Request)` over `preflight` and `dispatch`; sole `serve()` adapter and sole owner of the node HTTP types; residue-tested
- `src/federation-server/routerBody.ts` - body cap, the too-large, aborted and bodyless-method refusals, and the request both surfaces settle into
- `src/federation-server/ownerOpRegistry.ts` - the owner-op catalog: kind, value schema, mutation class, answer schema; sole kind list for the codegen and the fences
- `src/federation-server/routerDomainBootstrap.ts` - what the Router constructor builds, assembled once
- `src/federation-server/fileSecretStore.ts` - durable federation state and bounded atomic CAS
  - **A Domain change publishes once written; a revocation denies at once:** the enrollment coordinator
    commits a clone through `mutateDomain`, and holds pending revocations and edge removals in a deny
    overlay that authorization reads. A failed write keeps the denial in this process, and a retry
    writes again because its duplicate check reads committed state only.
- `src/federation-server/owner/` - per-owner state layer: fsync'd journal, CAS records, per-address rows, quarantine, lock, Domain quota
  - **Every write copies the whole store:** `OwnerStateStore.commit` clones the state before it applies a line. A sweep that touches many records takes one `batch`, never a write per record, and reads through `pick` when it only needs a few fields.
- `src/federation-server/inbox/` - inbox service, op ledger, consumer and session registries, gateway incarnation, OwnerOp intake
- `src/federation-server/inbox/inboxAppend.ts` / `inboxRetire.ts` / `inboxSweep.ts` / `inboxOpResult.ts` / `inboxCore.ts` - row append and admission, row retirement, the expiry sweep, router-authored result rows, and shared primitives (`recordId`, `guarded`, `ledgerTransaction`, `ownerAddress`, `floorOf`) behind `InboxService`
  - **A landed owner row is announced once and pushed from one place:** `InboxService.onRowAppended` tells a listener of every row that lands (an append, `appendRouterRow`, a retirement's result row, never a replay), a listener's throw is caught where it is called, and the one listener in `ownerServices.ts` pushes owner-address rows through `pushOwnerRow`. `owner-row-push-residue.test.ts` refuses another caller. Session-address delivery keeps its own callers.
- `src/federation-server/inbox/inboxCustody.ts` - who holds a pushed row: the Gateway incarnation it was handed to, until its ack, that incarnation's end or `INBOX_HOLD_MS`; and the `heldOver` marks an address record keeps for a forgotten life's held rows
  - **A pushed row is its holder's to settle, and a forget does not take it:** `GatewayBridge.pushInboxRows` is the one place a row is handed out (`inbox-push-residue.test.ts`) and records the hold. `forgetSession` fails the rows nobody holds, mints the new delivery epoch at once, and marks each held row with the epoch it was pushed under. A marked row is never redelivered, is acked under its own epoch, and is failed `session_forgotten` when handed back `waking` or once its bound passes. So the op that forgets a session is answered by its Gateway, and two lives of one name never share a row.
  - **An answered op gets no second word:** `retireRow` over a `complete` ledger removes the row and writes no result, a `waking` ack leaves a `complete` ledger as it is, and a Gateway's result is taken over a `waking` ledger as over an `accepted` one. The expiry sweep leaves a held row to its holder.
  - **A share revocation overrides custody:** it retires a friend's rows at once, held or not, and the holder's late ack answers `gone`.
  - **The inbox sweep is one of the owner services' sweepers:** `ownerServices.ts` registers it first, per Domain, so a migration window holds it with every other writer, and `RouterServer.sweep` calls nothing else. Custody's prune writes nothing and runs with it.
- `src/federation-server/console/consoleSockets.ts` - the console sockets: hello, the owner-row drain and the push
  - **A push never lets a console skip a row:** `Bound.sent` is the highest seq sent on a consumer socket, set at the welcome to the consumer's cursor, and `pushOwnerRow` drains from it, so rows no writer pushed go out with the next push. An ack drains from its own cursor, so a phone that dropped frames gets them again; a row may be sent twice and the phone tolerates it. A planes-only socket keeps the key-row rule.
- `src/federation-server/blobs/referenceHeldStore.ts` - the one blob holder: staged bytes under a lease, reference sets in the owner journal, `publish` binding a record write and its references in one line, the staged sweep, and boot reconcile
- `src/federation-server/blobs/blobService.ts` - the four blob owner ops and the four gateway blob frames over the held store, with the per-process chunk ledger
- `src/federation-server/ownerServices.ts` / `ownerServiceHooks.ts` - the owner-state services behind one hook surface: OwnerOp kinds, gateway frames, register and drop listeners, and the sweepers the fence holds
- `src/federation-server/presence/` - presence rows per gateway incarnation, resync, roster, owner and friend projections. The owner projection states the owner's facts. `refresh` recomputes a Domain and every Domain that embeds it.
- `src/federation-server/share/` - share records, generations, attestations, sweep, unlink, and per-Gateway mirror revisions
  - **A share names a session its Gateway reported:** `share` refuses `session` otherwise, so the
    phone retries rather than believing a record for a session the Router never heard of. `ok`
    says the line landed; an uncertain write answers `ok: false` with its outcome.
- `src/federation-server/board/` - board records with sealed text, authority and cascade on the clear envelope, observation rows
- `src/federation-server/vault/` - vault entries: sealed fields, revision CAS, phone writes, gateway creates, unopened fields
- `src/shared/schemasVault.ts` - vault wire truth: entries, puts, results, requests, grants, console answers
- `src/shared/schemasRunbook.ts` - runbook wire truth and `runbookRefusal`, the rules a stored record passes
  - **A body's placeholders ARE its parameter list:** `runbookRefusal` refuses either without the
    other, so no stored runbook carries a blank nothing can fill or a parameter nothing uses. It
    bounds nothing by size; a record is refused for what it means.
- `src/shared/schemasRoutine.ts` - routine wire truth and `routineRefusal`
- `src/shared/schemasPolicy.ts` - authorization policy wire truth: the record, its bounds, the three console answers, `canonicalPolicy` and `policyRefusal`
  - **Examples in, keys stored:** the phone sends typed examples and adopts the stored record.
    `canonicalPolicy` derives every key first, `policyRefusal` refuses anything that is not a key
    or is named twice, so no stored policy holds an example and the phone needs no twin of the rule.
  - **A write's refusal is a code with its facts:** `POLICY_REFUSAL_CODES` and `PolicyRefusalSchema` ride `policy_put` and `policy_delete` as `refusal`, and `examplesRefusal` reads the typed examples before `canonicalPolicy` drops them, so a collision names the command the owner typed. `refusalReason` writes the `reason` sentence from the same facts for an older phone.
  - **Every mutation carries the base revision it read**, delete and enable included.
  - **A schedule is refused by asking the calculator:** whether a rule can ever come around is not
    something reading its fields answers, so `routineRefusal` calls `nextOccurrence` from the start
    date rather than judging the weekday set and interval by eye.
- `src/shared/routine-recurrence.ts` - the next instant a rule names, read in the rule's own zone
  - **Both sides of a transition are considered, never just the probe's:** a wall time probed as if
    it were UTC lands on whichever side of an overlap that instant falls, which is the earlier one in
    Los Angeles and the later one in London. A gap answers the moment it ends, found by searching for
    where the offset changes.
  - **The walk is bounded by the rule's interval, and starts at the start date:** a fixed window
    would answer "never" for a routine beginning past it.
- `src/shared/runbook-grammar.ts` - the `{{name}}` grammar and the render, shared by the store and the fire
  - **One parse owns the grammar:** `parseBody` refuses a `{{` that opens no placeholder, so text
    shaped like one is a parse decision rather than a guard beside the scan. A lone `}}` stays
    literal, since prose about JSON closes nested braces.
  - **`renderRunbook` reads its own output:** a value and the literals around it can each be
    innocent and compose a placeholder only after substitution, which no check on the body can see.
  - **The whitespace class is written out longhand:** JavaScript `\s` matches U+00A0 and JVM `\s`
    does not, so `RunbookGrammar.kt` could not agree with a shorthand. `tests/fixtures/runbook-grammar/vectors.json` pins both.
  - **A Kotlin `Regex` must be written for ICU, not for the desktop JVM:** Android compiles patterns
    with ICU, which refuses a bare `}` that OpenJDK accepts as a literal. `testDebugUnitTest` runs on
    OpenJDK and cannot see the difference, and there is no `androidTest` source set, so a pattern
    that crashes on the phone can pass every gate. `icu-regex-residue.test.ts` now reads every phone
    `Regex` literal for it, since nothing that runs Kotlin can.
- `src/federation-server/scheduled/` - scheduled sends: versioned records, timers, fire through the op ledger, result rows
  - **A settled record keeps the slot for its opId echo, not for the owner's intent:** a fresh
    schedule over it names no version, and the write is still a CAS over it. The phone has no
    version to name once a cancel or a fire lands. Deleting settled records instead would break
    the echo a send retried after a crash relies on.
  - **A fired row carries the scheduling device, and its failure is told once:** more than `CHANNEL_FILES_MAX` files is refused `too_many_files` at `schedule_send`. A fired row that is refused, expires or is revoked (`rowRetired`, the inbox's retire listener) writes one `failed` `scheduled_result` with a reason from `SCHEDULED_FAILURE_REASONS` and moves the record to `error`, keeping that reason on `ScheduledRecord.reason`, which `schedule_list` answers; a send the Router gives up on itself reads `delivery_failed`. A cancel or a reschedule naming a version against a terminal record answers `settled` with its `state`.
- `src/federation-server/tier1/` - capability fold and read anchors
- `src/federation-server/migration/` - leases, serve gate, and cursor translation
- `src/shared/board-authority.ts` / `board-cascade.ts` / `board-structure.ts` / `board-observations.ts` - pure board rules shared by the gateway and the Router
- `src/shared/share-rules.ts` / `presence-projection.ts` / `presence-identity.ts` / `read-anchor-rules.ts` / `capability-fold.ts` - pure state rules shared by the gateway and the Router
- `src/shared/versioned-list.ts` - the fold every Router-held list consumer applies (a full list replaces, a delta merges, a stale answer restarts or is ignored); `android/.../VersionedList.kt` is the twin, pinned by `tests/fixtures/versioned-list/vectors.json`
- `src/shared/versioned-slot.ts` - the fold every reader of a Router-held plane applies over a `PlaneLineage { epoch, version }`: within a lineage the version orders, across lineages the reader's observation order does, a durable value takes any other lineage; `android/.../VersionedSlot.kt` is the twin, pinned by `tests/fixtures/versioned-slot/vectors.json`; `docs/console.md` holds the rule
  - **A plane is compared nowhere else:** `PollDrain` holds the in-memory cursor and stamps
    arrivals as they enter the process; `PresenceOps.applyOwnerProjection` lands what the cursor
    took; `revisionPlaneDecision` (`RevisionPlane.kt`) folds a board or vault plane against the
    manager's durable lineage, and another lineage drops the held list, fetches at once whatever
    the throttle says, and bumps the manager's generation so an answer begun under the old
    lineage lands nothing.
  - **A mailbox epoch is a random tag, never a counter:** `mintEpoch` draws it. Compare epochs for
    EQUALITY only. Sequence orders rows within an epoch. Across epochs, the later report wins. The
    receiver stamps `at`; it decides cross-epoch merges. `ReadAnchor.kt` is the phone twin and
    resolves by row position.
- `src/federation-server/gatewayBridge.ts` / `gatewayTransport.ts` - connection registry and frame dispatch; four trust callbacks required
- `src/federation-server/bridge/registrationHandler.ts` / `relayRouter.ts` / `inboxFrames.ts` / `frameDispatch.ts` - gateway registration; cross-gateway relay and cross-Domain handshake; incarnation-gated inbox, blob, and value frames; the gateway-frame catalog, one descriptor per frame the bridge dispatches, built-in or service, with its mutation class, its incarnation policy, and its handler; the migration fence holds every class but `read`, as the owner-op intake does
- `src/federation-server/consoleSurface.ts` / `publicApproval.ts` / `publicLimiter.ts` - token-gated operations, device approval's token-exempt routes, and the limiter class every token-exempt route holds
- `src/federation-server/enroll/gatewayBootstrapService.ts` / `src/shared/gateway-bootstrap.ts` / `schemasGatewayBootstrap.ts` - sealed bootstrap frames a phone left for a Gateway to collect: the two owner ops and the public ask; the pickup id and the ask's signing bytes; the wire
  - **The Router never sees the code:** a frame is named by `bootstrapPickupId`, a hash of it,
    pinned for both runtimes by `tests/fixtures/gateway-bootstrap/vectors.json`.
  - **An ask answers the frame or nothing:** an unknown id, another key and a bad signature read
    alike. A hand-in is taken only from an admitted console of the Domain that admits that Gateway
    key, within a size cap and a per-Domain count. The ask checks that admission again, so a Gateway
    revoked since the hand-in collects nothing.
  - **Held in memory:** a frame leaves when that Gateway registers, at 30 minutes, and on a restart.
- `src/federation-server/routerTls.ts` - persistent self-signed certificate; rotation re-provisions clients
- `src/federation-server/*Coordinator.ts` - in-memory flow windows; restart loses and re-arms them
- `src/shared/agent-binary.ts` - uncached backend CLI presence check: PATH, then the row's `binaryHomeDir` under the probed env's own home
- `src/shared/capabilities.ts` - capability ids, guidance, daemon declarations, and bundle folding
- `src/shared/schemas.ts` / `schemas*.ts` - sole Zod wire truth; `.meta({id})` names generated Kotlin classes
- `src/shared/schemasWireFixture.ts` - shared wire fixture schema for both runtimes
- `src/shared/sealed-blob.ts` - per-chunk blob AEAD, twinned by `crypto/SealedBlob.kt` over a shared fixture corpus
- `src/shared/content-envelope.ts` - content key derivation, content envelope, key envelope, join signing bytes
  - **Board text binds its entry id into the AAD kind:** `boardTextAadKind` is the sole builder. A
    bare board kind does not typecheck. `BoardSealing.aad` is its Kotlin twin and must match byte for
    byte. The revision is absent. An untouched title or body keeps its envelope across edits. A device
    missing the epoch cannot re-seal it.
- `src/shared/schemasContentKey.ts` - content key wire shapes
- `src/shared/codex-app-server.ts` - the Codex App Server messages its driver reads; no Gateway wire
- `src/shared/channel-file.ts` - declared ChannelFile metadata; receivers do not infer it from bytes or position
  - **The producer parses what it emits with the consumer's schema:** `buildArtifacts` drops a ref key
    the schema would refuse rather than sending it, since one refused key fails the WHOLE file and costs
    every other ref in that message its snapshot, where a dropped key leaves its own link behaving as an
    ordinary one. A canonical key carries an arbitrary matcher and has no bound of its own.
  - **A ref's `spanHash` is of the LINES it resolved to**, so an edit elsewhere in the file is not a
    change to what the reader was shown. Same function as a window descriptor's hash, different span;
    the two are never compared to each other.
- `src/shared/session-id.ts` - sole address grammar owner
  - **One segment rule, `SLUG_RE`:** lowercase letters and digits, then also `-` and `_`. A pane name, a console target's project and a conversation id read the same rule (`host-op.ts`); a second character set beside it is how a name the catalog offered got refused at the console. A project folder whose name is no segment is left out of the catalog, and the daemon logs it.
- `src/shared/session-commands.ts` - what a session can be told to call: one entry per command, holding the tool name, the gateway path and both schemas; `ASSISTANT_COMMANDS` holds the assistant's commands
  - **A nudge names a command, never a tool:** the prose renders the catalogue's name, the gateway
    serves its path and the MCP registers it, so words cannot ask for something nothing answers.
    `check:boot` runs the real `main-mcp` and proves the tool is there, and that `host.assistant`
    lists every tool its scope names.
- `src/shared/host-spawn.ts` - sole host-shell spawn-segment and command owner
- `src/shared/session-harness.ts` / `android/.../proto/HarnessRegistry.kt` / `src/mcp/sessionCli.ts` - the table of session CLIs (`HARNESS`, one row each), its generated Kotlin twin, and the plugin's one resolution of its own CLI. `docs/architecture.md` holds the rules
  - **Nothing decides by a CLI's name:** a difference is a row field, and behavior that lives in one process is a table keyed by that field's value (`LAUNCH`, `ROADS`, `TRANSPORTS`, `RESTART_SIGNALS`, `PROMPT_ANSWERERS`), so a new CLI or a new value stops the build until each is handled.
  - **A CLI word off a wire or a file is read through `readHarness`:** named, unnamed, unpicked or unknown, and `foldHarness` makes each reader state all four. Unnamed is an older sender, read as `UNNAMED_HARNESS` until its dated removal. Unpicked is a blank word, the place's only CLI once it reports. Unknown is a newer build's CLI and is never treated as Claude.
  - **A stored record naming an unknown CLI is held unread** by `SessionStore.restore` and written back untouched, so a Gateway rolled back over a newer build erases nothing.
  - **The row owns a session id's shape and mint** (`sessionId`), and `launchRefusal` is the one rule for where a CLI may launch.
  - **`road` says who reads and drives a CLI:** the daemon through its pane, or the plugin through the CLI's own server. Pane-only facts sit under the pane road, so code that reads one narrows through `paneRoad` first.
- `src/mcp/devcontainer/sessionLaunch.ts` - the one launch road, for a wake and a create: the pane road's reattach and repair, the launcher road's status wait, the greeting
- `src/mcp/devcontainer/launchLane.ts` - the daemon's launch lane: one queue per physical pane, both doors through it, Stop and kill ordered on it
  - **A host name is one pane on every host spawn point:** they share one tmux server, so the lane keys `host:<session>` and the store refuses a second owner (`SessionStore.paneTaken`). A random mint re-rolls; a chosen name resumes its own record or is refused.
  - **Only the lane launches:** `launch-lane-residue.test.ts` holds `createSessionLaunch` and the tmux create primitives to the lane's construction.
  - **Readiness is a table by road:** a screen read, or the launcher's status file.
  - **A wake keeps a live launcher:** no registration there is a plugin reconnecting, and the launcher restarts a dead plugin itself.
  - **A launch status is only as live as its pid:** the launcher writes `starting`, `ready`, `failed` or `exited` with its pid, `failed` the moment its server goes and `exited` when its UI leaves, and removes only a status it still owns. A dead pid, `failed` or `exited` relaunches.
  - **`existing` says what a launch does with a pane already there:** a host wake repairs it, a devcontainer wake reads a pane's screen, a create touches nothing. A launcher-run pane is read only on repair.
- `src/shared/opencode.ts` / `src/opencode-launch/launcher.ts` / `src/main-opencode-launch.ts` / `src/mcp/opencode/client.ts` / `follower.ts` / `session.ts` - OpenCode as a session CLI: the pure rules over its events and snapshot, the launcher behind its ports and its entry point, and the plugin's client, state follower and session. `docs/architecture.md` holds the roads
  - **The launcher mints the password and the server picks the port,** so the daemon holds neither and no secret is on a command line. The plugin reads both from the launcher's file.
  - **Working is read from a step, never an execution:** a repeated prompt id opens an execution with no step, and reading that as a turn would tell the owner one finished. `viewFromSnapshot` is the exception: a rebuilt view reads any running execution as working.
  - **Every stream connection rebuilds before it reports:** the stream is volatile and nothing replays, so the follower buffers events from `server.connected` until its three reads land, then replays them through the live path.
  - **The plugin posts its own baseline, once per compaction id:** the follower names each finished compaction, and the session posts the baseline as synthetic input under an id derived from it, which OpenCode itself lands once. No edge memory exists in any process, and a failed compaction gets none.
  - **A presence report is erased only by the socket that wrote it:** a refused or nested socket of the same session closing leaves it, and the daemon may not write a session whose own plugin reports.
- `src/shared/opencode-agent.ts` / `src/opencode-agent/bridge.ts` / `src/main-opencode-agent.ts` / `src/mcp/agents/opencodeSession.ts` / `src/mcp/devcontainer/opencodeTargets.ts` / `src/opencode-launch/serverProcess.ts` - OpenCode as an agent backend: the bridge's JSON-lines protocol, the bridge behind its ports, its entry point, the driver, the launcher, and the one `opencode serve` child the session launcher shares. `docs/agents.md` holds the rules
  - **The driver's child is a bridge, because the server is HTTP on a loopback the daemon cannot reach in a container:** the bridge runs beside the server, mints its password, and ends it with its own stdin. Neither the URL nor the password crosses the pipe.
  - **A bundled entry runs with a project's bun settings and env shut out** (`bundledEntryArgs` in `src/shared/launcher-spec.ts`): the bridge's working directory in a container is the project, whose `.env` bun would otherwise load into the server.
  - **The daemon places the runtime before a bridge launches in a container:** `ownRuntime` on the driver row asks for it, and `prepareTarget` on the daemon service runs it once per session open.
  - **A steer is accepted only where its turn will take it:** the bridge posts it, then reads the inbox and the rows in that order (`standingOf`). A prompt in the running turn's rows is taken. One still in the inbox is accepted while the server runs that turn and a step runs or is owed (`stepAhead`), since the server reads its inbox when a step ends, and `queued` holds it against its turn. The driver returns `taken`, so the service reports `steered`. Behind a turn's last step the bridge reads again until the turn takes the prompt, steps, or ends, and accepts after ten seconds of a turn still running.
  - **Before any refusal the prompt comes out, and one more read decides:** a prompt the turn took meanwhile is accepted, and the turn's own end rows are the last word on whether it took the prompt. A prompt left behind an ended turn is refused after that turn's terminal, one that opened its own turn is adopted, and `startTurn` under the same key opens or adopts exactly one turn. A start under a key that an ended turn already took answers that turn's terminal.
  - **A turn answers the steers it accepted, or fails:** `conclude` is the one end of a turn. A failed or interrupted turn asks the server to withdraw its `queued` steers. A completed turn whose rows hold no steer it accepted ends failed, never completed on an answer that ignored it. Every start, steer, stop and end, and an inspect of a held turn, runs whole in its thread's `ending` chain and reads the server there. A start or a steer answers within a minute of arrival (`bounded`): past that the outcome is told as unknown, nothing new is posted, and a steer not yet taken comes back out.
  - **Unread is never read as known:** `call` throws when a body does not arrive, and `readActive`, `readPage` and `readInbox` throw on a payload they cannot read, so no turn is read as lost from one. `readRows` throws past its page cap. Rows that hold a prompt prove it taken with the inbox unread. OpenCode answers a withdrawal alike for a prompt it never held, so a refusal says "withdrawn" only after a read shows the prompt nowhere. A repeated start that cannot read the server keeps a turn the bridge holds, and a start whose post got no answer reads the rows to learn whether its turn began. A turn start refuses over an inbox it cannot read or a stale prompt it cannot withdraw, since the server would deliver that prompt first.
  - **An end event names no turn, so only the held turn's own rows end it:** every stream connection reconciles running turns, queued steers and tool counters before it trusts the stream. An end event while the server still runs the turn ends nothing. One whose reads fail is read again until it can be (`recheck`), and so is a thread a reconnect could not read.
- `src/shared/launcher-spec.ts` - the bundled entry points a launch names: each API server's launcher (`LAUNCHERS`), each driver's own child (`AGENT_BRIDGES`), and the bun arguments both run under
- `src/shared/session-control.ts` / `src/gateway/sessionControlPlane.ts` - the frames between the Gateway and a session's own plugin: its presence report and the control op a prompt answer rides; the Gateway's end, on the coordinator the workspace plane uses (`PlaneCoordinator`)
- `src/shared/crypto.ts` / `admission.ts` / `router-protocol.ts` / `federation-lifecycle.ts` - federation trust wire vocabulary
- `src/shared/notice.ts` - shared notice tiers
- `src/shared/wire-vocabulary.ts` - sole TS declaration of Router paths, the console header, signing tags, the bridge's refusals, nonce lengths; generated into `Protocol.Wire` beside the owner-op kinds the registry catalogues; residue-fenced on both runtimes
- `src/shared/fixture-identity.ts` - the committed test signing keys; shipping entry points refuse them without `ALLOW_FIXTURE_IDENTITY=1`
- `src/shared/skew-windows.ts` - every window an older build is tolerated through: who still writes the old shape, where the tolerance lives, the date it closes and what closing does; each site carries `skew:<id>`, and `skew-window-residue.test.ts` holds the sites and the dates to the table
- `src/shared/ambient.ts` - the clock, entropy, ids, and timers as one injected record; `processAmbient` is the sole reader of the globals and unrefs every timer it hands back. `composeGateway` and `RouterServerParams` take one and thread it everywhere; `ambient-residue.test.ts` fences the three directories and names the reason for each allowed file. Vocabulary shared with the phone's `PhoneAmbient`, not a type
- `src/shared/atomic-write.ts` - sole write-then-rename and temp-suffix owner, and the exclusive create and inode-keeping move beside it; residue-tested
- `src/shared/keyed-fifo.ts` - every per-key promise chain; `drain` waits only for what was queued when asked, so a caller fences admission first
- `src/shared/single-flight.ts` - every "join the call in flight for this key"; a settled or failed flight releases its key, and `createOpDedupe` adds the settled-answer cache on top
- `src/shared/durable-store.ts` - atomic snapshots, per-file quarantine boundaries, and `commitChecked`, every store's checked write: the file first, memory only once it landed, a hook after; `checked-commit-residue.test.ts` names the snapshot writers allowed to call `saveChecked` directly, counts the raw file writes allowed under `src/gateway`, and keeps `DurableStoreInstalledError` read only here
  - **A restore that reads an older form rewrites the file until a write lands:** `restoreHeld` holds the value its `decode` answers (`{ value, stale }`), writes a stale one at once, and again on every persist pass (`restore-repairs`, the one `createRestoreRepairs` in `composeStores`) until a write lands; any landed commit clears it. `/health` names what is still pending (`pendingRepairs`), so a skew window closes on evidence. The source state, the policies, the routines and the automation state restore through it. A file that will not parse stays `openDurable`'s quarantine.
- `src/shared/write-result.ts` - the two readings of an owner-store write: `landed` before anything irreversible, `appliedOrUncertain` before anything a caller retries; no site spells the pair
  - **An uncertain write is not a landed one:** a `durability_uncertain` line may or may not be on
    disk. Bytes and holds wait for `landed`; a record write a caller can
    repeat idempotently takes `appliedOrUncertain` and passes the word on in its answer.
- `src/shared/session-store.ts` - authoritative gateway sessions keyed by `spawn.id`
  - **A session is the conversation it launched with:** switching conversations inside a CLI is unsupported, and nothing chases the one it moved to. `docs/architecture.md` holds the rule.
  - **An agent catalog is parsed once per held value and read as one frozen view:** the relay's register and hello passes look every agent up, so a read that parsed cost a whole catalog per agent and stalled a start for over a minute at a thousand agents. A reader that writes to a view throws.
- `src/shared/session-sanitize.ts` / `session-tokens.ts` - normalization, session ids, and bind tokens
- `src/shared/board-order.ts` - sibling order: a rank is a position among live siblings, and only the Router numbers; `BoardOrder.kt` is the twin
- `src/shared/agent-screen.ts` / `pane-trim.ts` - pure tmux-pane reads with Kotlin twins and shared fixtures
  - **A rule is a RUN, not a LINE, and `afterRuleRun` owns it:** `-J` welds rows. Windows panes weld composer rules to adjacent rows. Readers use `footerRegion`.
  - **Two rule notions are distinct:** `TOOLBAR_RUN_RE` is U+2500 only; `ANY_RULE_RUN_RE` spans U+2500-U+259F.
  - **`limitNotice` searches in two passes:** whole-line matches precede welded-rule matches.
  - **The composer glyph has two members:** Linux uses U+276F; Windows uses U+003E. Whitespace is explicit because JS and JVM `\s` differ for U+00A0.
  - **The last-two-lines fallback is uniform:** readers scope it to the final region.
  - **Typed delivery needs an empty composer:** `isAgentComposerEmpty` checks the prompt between toolbar rules.
- `src/shared/schemasConsoleOp.ts` - ConsoleOp schema, `DELIVERY_OP_KINDS`, and `VALUE_OP_KINDS`
- `src/shared/pending-job-store.ts` / `plane-registry.ts` / `reconnect.ts` / `process-guards.ts` - shared jobs, planes, reconnect, and process guards
- `android/` - Gradle/Kotlin console app; `proto/Protocol.kt` generated
- `scripts/` - build, Kotlin codegen, leaf sync, setup, federation start, residue checks, and voice import
- `scripts/setup-opencode.ts` / `scripts/lib/opencodeVersion.ts` - setup's "Install OpenCode": this machine's version against `OPENCODE_PIN`, and the install; it runs `OPENCODE_INSTALL_CMD`, the command the phone's shell macro runs in a container
- `scripts/lib/routerStart.ts` - sole Router `.env` and startup owner
- `src/shared/vault-askpass-wrapper.ts` - the `~/.local/bin/vault-askpass` wrapper; the host daemon lays it down at boot and removes the exact text it wrote on exit, the plugin lays it down inside a container, and `host-spawn.ts` exports its path into every bash session it spawns
- `scripts/lib/verifyChecks.ts` - setup verification checks
- `android/.../SelfMigration.kt` / `CursorTranslationOps.kt` - phone self-migration and consumer cursor translation
- `android/.../ConsoleSocketClient.kt` - `ConsoleSocketMode`
- **Migration window reader:** `readRouterMigrationWindow`. A present null epoch means an unreadable file
- `tests/fixtures/` - shared golden wire and signing fixtures; manifests drive both runtimes
- `tests/fixtures/identity/set.json` - the one fixed identity set every harness and fixture generator reads; `scripts/gen-identity-set.ts` mints it
- `tests/fixtures/automation-state/` - the state a flat-only build wrote (`flat-8.14.87`) and the one this build writes with functions (`functions`), each restored by this build with nothing dropped; `automation-fit`, `automation-carry` and `automation-walk` hold the vectors both runtimes replay
- `tests/fixtures/wire/ts/` / `wire/kotlin/` - minted wire fixtures, each runtime's real composers under the set; `scripts/gen-wire-fixtures.ts` and `WireFixtureGenerator.kt` write them, `check:fixtures` and `kotlin-gate.sh` diff them
- `src/testing/` - federation harness with `fixtureWorld.ts`, in-process Router and Gateway, linked friend Domains, fake host and session sockets, daemon runtime with scripted backends (`scriptedAgents.ts`), TS phone driver and console socket; `docs/testing.md`
- `src/testing/fakeAmbient.ts` - the harness ambient: a clock offset on the harness `now`, entropy seeded per instance so two peers never collide, and timers on either drive. "real" (the default) rides the process timers so every scenario makes progress unchanged; "manual" holds them until `advance(ms)` reaches each deadline, yielding to the event loop between firings, and, given no `now`, its clock moves only by `advance`, so a deadline one millisecond away stays one millisecond away under load
- `scripts/check-boot-runtime.ts` - the real entry points under Bun, one console op through a fake host
- `skills/crosstalk/SKILL.md` - agent-facing tool reference

## Architecture

**Every Gateway is an equal, and the Router is the node between them.** The phone holds no home
Gateway: every call takes a gateway id, and `home-gateway-residue.test.ts` refuses the old words.
A phone target is qualified, `domain.gateway.spawn` or `domain.gateway.spawn.session`, because
equal gateways make a bare name genuinely ambiguous, and the gateway's console handler refuses
anything shorter. An identity default is never a permission: no screen reads one to decide what it
may SHOW. The Router's protocol floor equals its version; a Gateway behind it is refused at
registration and its client stops with the floor in the log.

**`main-mcp.ts`** MCP plugin, user process.
**`main-gateway.ts`** Docker gateway and central router.
**`main-host-daemon.ts`** host `host` WS slot, devcontainer wake, session spawn, terminal view.
**`main-federation.ts`** self-hosted federation relay.
**`main-vault-askpass.ts`** askpass helper in a session, host or container; asks the phone through the gateway as that session, falls back to the tty.
**`main-session-hook.ts`** compact hook, printing the session's baseline as hook context; with `capabilities`, its capability guidance; with `gate`, the assistant's PreToolUse gate.
**`main-opencode-launch.ts`** an OpenCode session's launcher, in its pane: its own server, then its terminal UI.
**`main-opencode-agent.ts`** an OpenCode agent's bridge, beside its own server on the host or in a container; stdin and stdout are its protocol.

| Port | Service |
|---|---|
| 20000 | Gateway HTTP and WS, loopback only |
| 20001 | Federation Router TLS |
| 20002 | MCP connector WS |

How each subsystem works lives in `docs/`:

| File | Covers |
|---|---|
| `docs/architecture.md` | Addressing, host spawn points, sessions and wake, identity binding, state planes |
| `docs/federation.md` | Router, reach failover, Gateway enrollment, TLS pinning, trust |
| `docs/console.md` | Console OwnerOp client, terminal view, armed goals, capability union, Android app |
| `docs/agents.md` | Agent delegation on every backend, local agent mode |
| `docs/task-board.md` | Board, attachments, awareness |
| `docs/vault.md` | Vault client, grants, request road, loopback routes |
| `docs/policies.md` | The policy record, the selector key, the store's rules, the askpass resolver, what a qualified grant covers |
| `docs/runbooks.md` | The `{{name}}` grammar, the gateway store, the fire, the view, the editor, a refused push |
| `docs/routines.md` | The routine record, its targets, recurrence in a recorded zone, the console operations, what a session asks back, and the manual pass no gate here can reach |
| `docs/assistant.md` | Assistant session, notes, gate, actions, sources, automations, delivery and check-ins |
| `docs/devices.md` | The device record and store, the driver contract, the Kasa driver, the road, the scan, the assistant's device tool |
| `docs/fields.md` | The field table, owner records, expressions, computed fields, automations, their action catalogue and outbox, Unknown decoding |
| `docs/console-live.md` | Live console grammar, engine, registry, audience rules and read boundaries |
| `docs/references.md` | `ref://` grammar and matchers |
| `docs/testing.md` | The federation harness, the minted wire fixtures, the identity set, the gates |
| `docs/environment.md` | Every environment variable |

## Development

### Commands

- `bun run lint` - Biome and `tsc`.
- `bun run test [path]` - Vitest.
- `bun run gen:fixtures` - regenerate the TS wire fixtures.
- `bun run check:fixtures` - regenerate the TS wire fixtures and diff.
- `bun run build patch|minor|major` - release build and commit.
- `bun run build --build-only` - bundle without versioning.
- `bun scripts/codegen-kotlin.ts` - regenerate Kotlin protocol types. A `src/shared/schemas*.ts`
  change must carry the regenerated `Protocol.kt` in the SAME commit. `lint` and `test` both pass
  with it stale, so run `./scripts/kotlin-gate.sh`, which diffs it. CI is the only other check.
  Kotlin constants matching `src/shared` exports read `Protocol` or have a named exemption.
  `cross-runtime-twin-residue.test.ts` checks both conditions, by name: a phone constant under
  another name is not seen, so a bound the phone needs is generated (`wireConstants` and the enum
  blocks in the codegen) rather than copied. The codegen refuses a generated `*_PATTERN` holding a
  `}` Android's regex engine would reject (`unescapedBrace` in `src/shared/icu-pattern.ts`).
- `bun scripts/check-module-residue.ts` - verify `node_modules` against `bun.lock`.
- `bun scripts/import-stts-voices.ts` - regenerate the committed TTS catalog.
- `bun scripts/sync-leaf.ts <path>` or `--all` - synchronize a leaf.

### Push straight to `main`

Commit and push to `main`. Do not open a branch or a PR for ordinary work, and do not leave one
open: an unmerged PR is work the owner will forget.

Nothing BLOCKS a push, so run the local gates first. CI does run: `.github/workflows/ci.yml` repeats
lint, tests, `check:boot`, `check:pinning` and the drift checks on every push to `main`, and
`main-push.yml` builds Android. They report after the fact, so a red run is found only by looking.
Check `gh run list` after a push.

A gate that CI does not run is a gate nobody runs. `check:boot` sat outside the workflow for months
while `AGENTS.md` called it the shipping-composition gate.

Run `gitFetch` and `gitPull` before every follow-up edit after a push. A non-empty
`git log main..origin/main` is a hard stop. Scripted edits must assert their match before writing.

`gitPushNewBranch` resets local `main` to `origin/main`, taking the commit with it, so the work then
lives only on the branch until the PR merges.

### Verify locally before pushing, especially Android

CI does not compile Kotlin before merge. Run:

```bash
./scripts/kotlin-gate.sh
```

Resolves the repo root and sources the SDK env itself, so it runs from any directory.

Regenerate Kotlin wire fixtures with `./gradlew :app:generateWireFixtures` from `android/`.

`testDebugUnitTest` is un-minified. Both debug and release are R8-minified, so verify reflective
Android and JavaScript bridge entry points with `assembleRelease` or on-device. The
`@JavascriptInterface` keep rule in `app/proguard-rules.pro` is load-bearing.

The sibling **evie-bot** repo must be checked inside its devcontainer:

```bash
bun run lint && bun run test
```

### Debug APK to the phone

The phone runs the CI build, signed with the stable key kept in `~/android-dev/secrets/`. `env.sh`
exports that key as the `ANDROID_KEYSTORE_*` variables the Gradle signing config reads, so a local
build installs straight over it. Without those exports the build signs with the default debug key
and the phone refuses the install.

```bash
scripts/phone-install.sh          # debug
scripts/phone-install.sh release
```

The phone stays on wireless adb; `adb devices` lists it. No push or CI round trip is needed.

**One version code sequence, two writers:** CI stamps `github.run_number` plus the repository
variable `ANDROID_VERSION_OFFSET`, once per run so both APKs share it. The script stamps one past
both the installed build and the newest run's code, and raises the offset before it builds so that
the newest run, even one still in flight, stamps one above it. CI's `GITHUB_TOKEN` cannot write a variable, so only the script does.
Never build for the phone with a hand-picked `ANDROID_VERSION_CODE`.

**Every phone iteration goes over adb, never through CI.** Two minutes, against ten for the
Android release, and there is always more to do than watch a workflow. Push when the work settles,
not per tweak. `assembleRelease` reads the same keystore env, so the phone can stay on the
production variant; `assembleDebug` is for when the ingest log stream is wanted.

### Emulator build

Use the `emulator` variant for visual inspection without onboarding or a real Gateway:

```bash
source ~/android-dev/env.sh
cd android && ./gradlew :app:assembleEmulator
adb install -r app/build/outputs/apk/emulator/switchboard-emulator.apk
adb shell pm grant com.atelier_nyaarium.switchboard.sandbox android.permission.POST_NOTIFICATIONS
adb shell am start -n com.atelier_nyaarium.switchboard.sandbox/com.atelier_nyaarium.switchboard.MainActivity
adb exec-out screencap -p > /tmp/shot.png
```

It installs beside the real app. Emulator seeding bypasses mailbox draining, so handler-created
state must be seeded directly. Run `adb emu kill` when finished.

Start the emulator with `-no-window` from a session with no display, or it dies on the Qt platform
plugin and reads as a broken emulator rather than a missing one:

```bash
emulator -avd <name> -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect &
```

`SandboxGateways.kt` answers the runbook and routine calls as a Gateway would, which is what makes a
screen that only appears on a refusal reachable at all. They are ports, not sockets.

**The workspace sandbox answers after a round trip, never at once:** the tree screen keyed its load
effect on the view its own load published, which cancelled every real read, and passed every
emulator walk while the sandbox answered without suspending.

**Each seeded Gateway answers differently, or a grouping bug has nowhere to show.** One holds the
full set, one holds the same record ids as different records in another zone, and one answers empty,
which is not the same as a Gateway that could not be read. Answering all three alike is what made the
tabs' single-Gateway defect invisible here for as long as it was.

The sandbox renders nothing until the boot is Ready, and it reaches no Router at all. Both are held
by `SandboxSeeder.kt`:

- **`Need` cannot grow without the sandbox growing with it:** `seedSandboxIdentity` writes every
  identity fact `PhoneBootstrap.assemble` asks for, and `SandboxIdentityTest` asserts the boot it
  produces is Ready. A `Need` added without it leaves the build on the onboarding screen, which no
  other gate can see.
- **`isSandbox` closes every network door, not the caller in front of it:** the guards sit in
  `SwitchboardService.start`, `ConsoleSocketDriver.connect`, and the transport's `postOwnerOp` and
  `apiReachable`, because four receivers and the activity all start the service. An owner op
  cancels its own caller rather than throwing, since the scopes that launch one do not all handle a
  failure, and the socket does not open at all, since its failure lands on OkHttp's dispatcher where
  no caller's `runCatching` reaches it. A screen waiting on a Gateway stays on its pending state
  here, which is the honest answer. `sandbox-network-residue.test.ts` reads every `newCall` and
  `newWebSocket` on the phone and refuses a file that opens one without asking, so a new door is a
  decision rather than an oversight. Its allowlist names why each exempt file is exempt.

### Dependencies

Exact pins only. After a manifest change:

```bash
rm -rf node_modules && bun install --frozen-lockfile
bun scripts/check-module-residue.ts
```

Bun leaves unsanctioned nested `node_modules` copies that can shadow the lockfile version.

**The image installs no OS package.** The `Dockerfile` is `oven/bun` pinned by digest,
`bun install --production` and `src/`. A firewall that filters plain HTTP stops `apt`, and the
Gateway and Router run nothing an install would add: the base carries the `openssl` the Router mints
its certificate with. `bun-floor.test.ts` holds the pin at or above `BUN_FLOOR`, and CI runs the
same Bun.

### OpenCode pin

`OPENCODE_PIN` is the version this build was tested with and the one setup installs. It refuses nothing: any installed version runs, and a failure on another version names both (`untestedVersionNote` in `src/shared/session-harness.ts`).

On any work in this repo, compare `OPENCODE_PIN` with the newest OpenCode release at least 7 days old.
- Compatible: bump `OPENCODE_PIN`, reinstall it on the host (setup's "Install OpenCode"), bump `docker-workspace`'s `OPENCODE_VERSION`, run the gates, and say so in the report.
- Needs work: ask the owner whether to handle it first, naming what breaks.

The agent bridge marks a failure `unexpected` when OpenCode answered a shape it cannot read or a route refused (HTTP 400, 404, 405, 415, 422), and only those carry the line. `opencodeFailureCode` must not classify by the word "version", or every noted failure reads as `protocol_incompatible`.

### Synced leaves

| Source | Copy |
|--------|------|
| `src/shared/notice.ts` | `nyaaskills/src/shared/notice.ts` |

CI enforces the `SYNC-HASH` and the copy. Always use `sync-leaf.ts`: format, restamp, then copy.

### Code style

Biome: tabs, double quotes, semicolons, 120-character width.

**I don't trust you with comments, so always fan out a couple Workflow edits to Luna to clean your
pollution:** If `switchboard_capabilities` list **Codex**, use Sonnet to verbatim relay to Codex
Luna. Otherwise, audit with Sonnet.
1. Violators of /coding guidelines. Especially overly long comments (keep to 4 words or less, unless
   CRITICAL), narrative comments. Anything listed in `## Documentation Style`.
2. Units that test plain internal states instead of behavior. They report, you fix if real.

**Hand the change itself to an auditor too, and tell it to read /architecture:** Name the skill in
the prompt, because an auditor that is only shown a diff reviews the lines in it and reports nits. It
has to look wider than the diff: what class does this change belong to, where else does that class
live, and did the change leave a sibling instance behind. Ask for defect classes, not line notes.

**Same bug twice is a design bug:** Note which mechanism each fix lands in. The second or third time
you patch the same defect class in the same mechanism, that is a /architecture violation, not bad
luck. Land the smallest patch that keeps it green, then record the mechanism, the defect class, and
what each round patched. Inside a nyaaskills cycle that goes under a `### Bug Classes` heading in the
current phase's section of the plan file. Everywhere else it goes on the Task Board, claimed.

**A test that fails sometimes is a defect until it is proved otherwise:** Calling it a flake is a
diagnosis, and it needs the same evidence as any other. `8e0c3bf5` was dismissed as load-sensitive
three times before CI showed a plain TypeError.

**A decision the phone makes lives beside its ops class, never in the screen:** there is no
`androidTest` source set, so nothing can call into a `@Composable`, and a rule written inside one is
invisible to every gate. State lives in the screen, so rules drift there. `overwriteRevision` began
as an expression inside `RunbookEditor` and was wrong twice before it was moved out and covered.
Extract it, name it, and test it beside `standingConflict` and `pushDecision`.

**A gate that cannot see a failure is not covering it:** Before calling a path done, ask what would
have caught it. The phone compiles regexes ICU refuses and the desktop JVM accepts, and the harness
attaches its fake session on a timing that made a real wake race impossible to reproduce. Both
passed every gate. Run the path where it actually runs, or fence what the gate cannot reach.

**Do not sanitize invisible characters in display strings:** `oneLine` collapses ASCII whitespace,
which is the whole of it. No category strip, no bidi rule, no Unicode whitespace set.

**A control character belongs in source as an escape, never as the byte:** an editing tool given a
unicode escape writes the byte itself, which compiles and passes every gate while making the file
binary to `grep`, invisible in a diff, and unindexable by Lexicon. Construct it instead, as
`Char(0x1e)` does for the window key separator. `control-byte-residue.test.ts` reads every tracked
Kotlin and TypeScript file; its two exemptions are the files that assert on terminal escapes. It also
refuses zero-width characters, em dashes and smart quotes in Kotlin, TypeScript and markdown. The
same tools turn a `\u` escape typed into an edit into the character, and `biome check --write`
rewrites an escaped `RegExp` string into a literal, so restore such a line from git rather than retyping it.

**A catch around a suspend call rethrows cancellation:** raw `runCatching` is refused everywhere on the
phone. Use `runCatchingCancellable` for coroutine work and `runIsolated` for non-coroutine work or
boundaries that must not throw. A `runIsolated` around a suspend call must chain
`rethrowCancellation` after cleanup; the residue test reads it.

**A long-lived coroutine scope on the phone carries a `CoroutineExceptionHandler`:** it outlives the
call that made it, so a throw inside has no caller to catch it, and a `SupervisorJob` only spares
the siblings. These scopes reach the Router, where a dead network throws, and the process goes down.
`coroutine-scope-residue.test.ts` reads every one, since no gate here runs the phone.

### Testing

Vitest runs under Node. The gateway, Router, and daemon run under Bun. `ws` and WebSocket behavior
therefore differ. `bun run check:pinning` is the shipping-runtime gate. `bun run check:boot` is the
shipping-composition gate: it boots the real Router and gateway under Bun and runs one console op
through a fake host. The in-process harness and the fixture corpora are in `docs/testing.md`.

### Debugging the console on-device

Debug APK logs flush to the Router's `/ingest`; release does not. Logs are not private. Never log
bearer credentials, invite nonces, or minted secrets.

```bash
docker logs switchboard-federation --since 15m 2>&1 | grep '\[console-ingest\]'
```

### Restart ritual

`./start-all.sh` is `./down.sh`'s counterpart, starting all three in order. Each component script
stays independently usable; a Gateway-only machine runs `./start-gateway.sh` alone.

```bash
./start-all.sh
```

`start-federation.sh` rebuilds the Router image on every start.
`start-host-daemon.sh` restarts the daemon. Declining a restart leaves the running build serving.
`./setup.sh --verify` checks Router reachability and Gateway registration.

The Router certificate is not rotatable without re-provisioning enrolled Gateways and phones.
Clock drift breaks signed proofs and invite expiry.

### Starting a host session by hand

A bare `claude --resume` loses the host identity and channel subscription. Use:

```bash
PROJECT_NAME=host.<id> claude --resume <transcript-uuid> \
  --dangerously-skip-permissions --dangerously-load-development-channels plugin:switchboard@atelier-nyaarium
```

Not for `host.assistant`: it launches with its own permission flags (`assistantPermissionArgs`), so
wake it from the phone.

The MCP and harness diagnostics are in
`~/.cache/claude-cli-nodejs/<project-dir>/mcp-logs-plugin-switchboard-switchboard/`.

## Deploying

### The four components update on SEPARATE triggers

| Component | Updates when |
|-----------|--------------|
| MCP plugin | marketplace pull or session restart under autoUpdate; an OpenCode session's runs from the daemon checkout's `dist/` |
| Gateway | manual restart |
| Host daemon | `./start-host-daemon.sh` |
| Console | app update |

New wire fields OPTIONAL at the gateway and tolerated by both peers. Deploy gateway first, then push the version bump. The plugin can update before the other components.

A new VALUE on a required enum deploys every reader before the emitter: a phone reason the Gateway and the plugin parse strictly (`UNAVAILABLE_REASONS`) ships in the Gateway and the plugin release before the app that answers it, or the answer is refused as malformed and the call lapses to `timeout`. A release alone moves no running MCP server: the assistant's picks up the new build only after `claude plugin update switchboard@atelier-nyaarium` and a restart of its Claude (`/exit` in its pane, then a message wakes it). A new tool on the assistant's allowlist (`ASSISTANT_SWITCHBOARD_TOOLS`) also needs `./start-host-daemon.sh` before that restart, since the daemon builds the launch's `--tools` from its own copy.

A field that is optional only to cross that gap, and should be required once every part has updated, carries a `skew:<id>` comment naming its row in `src/shared/skew-windows.ts`, which holds the date it becomes required, about two weeks out, who still writes the old shape and what closing does. Tag every other shim kept for an older build the same way; the test sees only dated comments, so an untagged shim is found by reading. A field that is optional by meaning carries no tag. `skew-window-residue.test.ts` fails on a dated comment with no tag, a tag with no row, a row with no site and a row past its date: close it, or move its date and say why in `moved`.

That order covers fields the gateway EMITS. A change to what the Router ANSWERS deploys the Router first, since a gateway reads the answer it is given.

A change to a bundled entry (`dist/`) is built before the daemon restarts. The daemon places a container's runtime under the version it read at its own start, so a daemon started before the build leaves the container on the old bundle until its next restart.

### Plugin

1. Commit source work.
2. Run `bun run build patch|minor|major`.
3. Push.
4. Reload target containers with `reload_plugins`.

The build derives versions, bundles `dist/`, and commits the release. Do not hand-edit version fields. Bun 1.4.0 or newer required.

### The lexicon submodule

`lexicon/` supplies the client at build and test time. `postinstall` links its packages into `node_modules/@nyaa-lexicon/`; runtime uses the bundled client.

- Fresh clone: `git submodule update --init` before `bun install`.
- `lexicon.json` keeps the shipped `android/app/src/main/assets/**` bundles out of this repo's index.
- Pin moves require a committed submodule change before release.
- Never install inside `lexicon/`. Nested `node_modules` shadow root dependency pins and produce duplicate packages.
- A real `node_modules/@nyaa-lexicon` directory is invalid. It must link into `lexicon/`.
- **The version is in `package.json`, never from `git describe`.** Tags there stopped at `v3.0.2`, so
  `describe` answers `v3.0.2-119-g7077be2` for a 3.7.0 checkout and reads as years of drift. Compare package
  versions, and use a revision only to name the pin. Two auditors and one plan misread a seven-commit gap as
  two minor versions from that tag.
- The packages link as symlinks, so moving the pin needs no reinstall. Verify with `bun run lint`, then
  `bun run test` and `bun run check:boot`, since a Lexicon behaviour change is invisible to `tsc`.

### Installing

```bash
claude plugin marketplace add atelier-nyaarium/claude-marketplace
claude plugin install switchboard@atelier-nyaarium
```

### Federation

The gateway-to-Router WS is admission-only. No bearer fallback.

Run `./setup.sh` first. Admin Provision starts the Router, writes `.env`, and emits a direct transport blob containing the Router URL, `/health` fingerprint, and app token. An unreadable Router state must abort provisioning. An empty read can stage a new Domain over an existing rooted one.

Gateway Setup starts the Gateway, arms it over loopback with the Router's address, and waits on one screen while the Gateway collects the phone's sealed bundle from the Router. Every read on that screen goes through `readKeyWhile`, whose poll is the status read that makes the Gateway ask; `prompt()` would stop it. `readKeyWhile` uses raw mode and restores cooked mode on every exit. The screen prints the fingerprint of the payload's signing key, which the phone shows too. A setup that armed and did not finish reads `1) Resume Gateway Setup` in the menu, found from `enroll-pending.json` with the Gateway up or down, and a resume asks no address, never restarts a running Gateway and keeps its code.

Purge Gateway removes only gateway state and gateway-owned `.env` keys. Purge Federation removes this owner's Domain slice first, then performs the gateway purge and removes the Domain id and setup code. The Domain id may come from `.env` or the Router's admin-Domain mark.

**Purge Gateway retires itself when reachable:** it asks the Router to accept a self-signed revocation for this Gateway only. If retirement fails or the Router is older, purge continues and the owner must use Revoke in the app.

**`.env` is shared by the gateway and Router:** Purges must preserve the file.

**The phone's half of Purge Federation is Forget this Domain:** Revoke and Delete is app-only because it purges the Domain server-side.

`scripts/lib/routerState.ts` keeps Bun `$` templates on one line. Bun treats a backslash-newline as an argument split, not continuation.
