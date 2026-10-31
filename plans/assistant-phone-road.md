# Questionaire

Context the owner settled before the questionaire (2026-10-30, from `temp/assistant-integrations/`):

- The assistant asks the phone the turn came from. "Which phone? The one I am in the summon panel for obviously." Not an "Assistant knows always" situation: no standing mirror of contacts or calendar.
- Catalog what the phone answers (contacts, calendar, notifications), what the phone handles ("navigate me home" launches Maps), and what the Gateway or the network holds (IFTTT, GitHub). `FINDINGS.md` holds the catalog and the permission tiers.
- The summon keeps sharing the app's foreground lease and the one silence clock. `LIVENESS.md` holds the measurements.
- Verified on the wire: an owner send names the phone's device id as `from` (`consoleHandler` passes `ctx.device`; the channel push carries it). The panel and the app on one phone look the same to a session.
- The panel opens the socket while shown and closes it on hide. After that the phone polls: every minute for ten minutes, then the deeper tiers.

## Question 1 - How does the assistant reach the phone the turn came from?

Q: Over what road does an ask reach the phone, given the socket is live only while the panel or the app shows?
A: A Gateway-held phone request addressed to the device, on the owner-request lifecycle the vault and the send guard share. With the panel open it rides the socket; closed, it lands on the next poll, bounded by a deadline the assistant sees.

Recommendation taken: one mechanism, `ownerRequests.ts`, and a closed panel degrades to a bounded wait rather than a dropped question. The rows must be device-addressed; today every owner row reaches every phone, and the Router is where the filter belongs.

> lets suppose I say A. That implies: I summoned it on Phone B. Phone A will not get dragged in.

## Question 2 - When does the assistant lose the phone?

Q: When does the assistant gain and lose the bound phone?
A: The write lock's shape. The bound phone is the device of the owner's last message. The bind is open while the owner prompted last or spoke within `WRITE_IDLE_MS`, and lapses after that. A single message from the summon panel or the in-app Assistant tab binds that phone again. Not tied to the turn's reply, so a background task inside the window keeps the phone.

Superseded in part by questions 3 to 5 and decision 2 under "# Plan": the bind is the hold, a Router-held record, with a 10-minute window and no "prompted last" clause.

> it's hard to say turn end, because it could do a background task. But that might be ok. Much like how Assistent write locks simply require messaging a confirmation one more time, a single message from me in summon panel OR in-app Assistant tab should bind my phone again.

The act-while-nothing-shows case is settled under "# Plan", Refinements: a launch runs only while the panel or the app shows on an interactive, unlocked screen, and otherwise fails out as `not_showing` for the assistant to relay; reads and silent acts run in the background.

## Question 3 - The device status

Q: How do the phones decide which one the assistant uses, which alerts, and which speaks?
A: The owner's design, not one of the three offered. A new Router-held record the phones compete for, a hold that says "Assistant use me". The mailbox delivers every row to every phone; only the holder alerts. Autoplay runs on every active device with autoplay on until one claims the hold; foregrounding a conversation claims it, the Router relays the change, and the other devices stop. The assistant's bound phone (Q2) is the holder, so a message from the panel or the tab is a claim.

> what if we included a new type of record? The phones compete for them. To say: *Assistant use me*. A token? hold? lock? whatever you call it? Similar to a Google Home, but we wont do live audio transfers, only typed chat: When you move from a Google Home hub device to a Phone, the assistant just resumes uninturrupted. For us, thats the mailbox delivering messages to all phones, but only alerting the one that holds this thing. As for conversation autoreads, thats a different line of concern. Perhaps we have it auto speak on all active devices, until one has claimed this thing? So if all devices were inactive, it autoplays on all devices that has autoplay on for that device. Then if I pick it up and jump to the Session, the foregrounding tells the router, "I'm the phone who holds the thing now." and the router relays to the other active devices and stops them.

Mechanism: a Router-held owner plane holding one versioned slot (`{ holder, claimedAt, version }`), on the `versioned-slot.ts` fold with its `VersionedSlot.kt` twin; a claim is a CAS owner op, last claim wins; the Router pushes the plane to bound sockets (`pushPlane`) and serves it to a polling phone through `planes_read`; the phone lands it in `applyPlane`; the Gateway reads it through the registration read as it reads the assistant home. A foreground phone sees a change at once; a backgrounded phone at its next poll, within a minute in the minute tier.

## Question 4 - When does the hold lapse?

Q: Does the hold survive the holder leaving the foreground, and what ends it?
A: Decay only. The hold stands for a window after the last claim, then lapses to no holder. Backgrounding and locking change nothing; a locked holder still alerts. The window is 10 minutes (set with decision 3a below). Since the hold replaces the write lock (decision 2), file writes lock after the same 10 minutes of owner silence, and a message from the panel or the Assistant tab reopens them.

> A. If i turn off the screen and still hold it, i wouldnt mind it still ring my one phone. I think decay is safest.

> I think A with a 10 minute window for forgetting a hold might be good. But of course, if I want to respond, I have to unlock and summon again.

## Question 5 - Who is the authority of the hold?

Q: Which party holds the record, arbitrates claims and decides a lapse?
A: The Router, end to end. It holds the record and numbers its versions; a claim is unconditional and the owner-op intake order arbitrates, last claim wins; it stamps the claim time with its own clock; its sweep clears a lapsed hold durably and pushes the change. Phones claim and read, a phone's own claim provisional until the plane echoes it. The Gateway reads, as it reads the assistant home.

Recommendation taken: the three rules the codebase keeps already. The Router writes and the Gateway reads; only the Router numbers; placement is the Router's record and its report.

Assumed from the owner's words, not asked: one hold per owner, not per conversation. A claim is a conversation screen or the panel coming to the foreground, and every send. The Sessions list alone claims nothing.

## Question 6 - How does a phone request find the holder?

Q: What turns "the holder" into one phone on a row every phone drains, and stops the others answering?
A: The Router resolves the holder at append. The Gateway's row names the holder symbolically; the Router stamps the device as it appends, refuses an answer from any other device, and answers the Gateway `no_holder` at once when nobody holds. Every phone drains the row; a non-target ignores it by the stamp.

Recommendation taken: the stamp is made where the hold is true at that instant; the refusal rides an answer road the Router already guards; no holder is a fast typed refusal, not a timeout.

## Question 7 - What is the unit the assistant asks the phone in?

Q: One tool per capability, one generic ask, or a tool list the phone advertises?
A: A typed capability registry, one tool per key, in the shape of the watcher actions (`ASSISTANT_ACTIONS`): request and answer schemas, read or act, the phone permission it needs. The keys spread into the assistant's tool set so the gate, the launch permissions and `check:boot` follow the registry. One handler per key on the phone. A phone that cannot serve a key answers a typed `unavailable` with its reason. The App Actions and shortcuts other apps advertise are one typed act whose parameter is the enumerated capability id. The permission tiers from `FINDINGS.md` are a registry column.

> A sounds good

## Question 8 - What does an act need before it runs?

Q: Which acts run, which leave a trace, which wait for a tap?
A: Three classes as a registry column: read, act, guarded act. The action type alone decides the class. A read runs; an act runs and leaves a trace line on the phone; a guarded act lands as a card on the holder on the owner-request lifecycle the send guard uses. The torch and IFTTT are plain acts. No fine-grained controls: the one global toggle, `approveEverySend` in the assistant safety store, governs guarded acts as it governs sends. Off means a guarded act skips the card and carries `unasked`, as a send does.

> A. So the action type would define whether an action would be guarded or not. I dont need permission to toggle a torch or IFTTT. And eventualyl we can revisit and have toggles that changes which is guarded by what fine-grained conditions. But for now, leave out fine-grained controls. It's just the global "Approve every send" toggle. Off means guarded act skips the card.

## Question 9 - What is in the first slice?

Q: Which capabilities does the plan build?
A: Everything the survey found workable: the phone reads (contacts, calendar, notifications, screen), the plain acts (maps, torch, app launch with App Actions and shortcuts, alarm and timer, SMS compose and dial), the guarded acts (inline notification reply, silent SMS and call under `SEND_SMS` and `CALL_PHONE`), and the Gateway's IFTTT webhook under a vault standing grant. Phases condensed so similar work is not looped; the implementation fans out Lunas against the spec.

The action base is modelled on evie-bot's Actions and its base action: type-strict so an action and its MCP tool schema cannot disagree and a handler cannot misuse its params. Adapted: no Discord UX generator; adds "what permission would this need" and "is that permission granted on this phone", and whatever else the base turns up.

> C. As you build the plan, condense the slices and phases together to be less in total, so we arent looping similar work too many times. With this, you would just fan out a lot of Lunas against the spec you create. And as you research the baseline spec for this, look to Evie-bot Actions and it's base action. I designed it to be very typestrict and allows for zero schema typing mistakes between action and mcp tool schema. Eliminates coding mistakes as well with like, params.blah typing misuse. We will be building so many actions, that you NEED a solid base to catch development mistakes before it reaches build. Our use will be different though, so modify as needed. Like to skip the Discord UX generator and to include the check for "What permission would be needed?" and "Do we even have permission enabled for this action?" and anytyhing else here that comes up.

### The base action, read from evie-bot (`app/actions/ActionSchema.ts`, `ActionRegistry.ts`, `actionSchemaToTool.ts`, `ActionDecorator.ts`)

What makes it strict:
- One Zod `aiSchema` per action is the only source: `actionSchemaToTool` derives the tool's JSON schema from it (`z.toJSONSchema`, `additionalProperties: false`), and the handler takes `ActionExecutionParams<z.infer<typeof Schema>>`, so a handler cannot read a field the schema does not declare.
- `returnSchema: z.ZodType<TReturn>` ties the class generic to the return, so the handler's return is checked against the declared answer.
- `ActionTypeMap` keys `registry.execute(key, params)`: an unknown key or wrong params is a compile error. It is filled by hand, one `declare module` augmentation per family (`discord/action-types.ts`), naming each key's params and return beside the class that already names them, so the key is typed twice. Switchboard's registry object is the key map (`typeof REGISTRY`, `satisfies`), one list.
- `canBeInitiatedBy` and `can(context)` run before execute, and `actionSchemaToTool` injects the initiation rule into the tool description.
- Input is validated at the boundary (`getActionInputData` safeParse, `InputValidationError`).
- `@RegisterAction` discovers classes; the registry imports every action file explicitly.

Adapted for Switchboard:
- `defineCapability({ key, request, answer, kind, where, needs, describe, run })`: the handler's parameter and return types derive from the schema literals, so the tie is enforced, not conventional. The abstract-method-with-`unknown` shape is the one soft spot in evie-bot's base, since TypeScript lets a subclass narrow a method parameter unchecked.
- No Discord flow router, slash entries, `_ai` meta, or initiator decider. The assistant's own gate and the send guard's `approveEverySend` are the policy layer.
- `needs` answers "what permission would this need" (a registry column, injected into the tool description as evie-bot injects initiation). The phone's `permissionState(key)` answers "is it granted here" at dispatch, as a typed `unavailable` reason, and a `phone_status` read lists every key's availability on the holder.
- The registry is pinned across runtimes by a generated fixture (`tests/fixtures/phone-capabilities/registry.json`: keys, kind, where, needs) that a TS test and a Kotlin test both replay, so a handler map missing a key or disagreeing on `needs` fails before build, as the facet and grammar vectors do.

### Research notes (superseded design)

The owner put the owner-wide row under the magnifying glass:

> Suppose P.A happened to wake and poll at the same time for mailboxes. Could it drain and race P.B? Is it "First to check wins"? If so, we want to draft an official device *idle/background* status.

Cases: P.A awake on another app; P.B on the summon screen; P.C on a conversation screen, foreground, no interaction for a while; P.D on a conversation screen driving a session. To be thought through as audio autoplay and summon focus are.

Verified so far:
- The Router keys an inbox consumer by the phone's signing key (`InboxService`, `consumer:<signerSignPub>`), so every phone holds its own cursor and sees every owner row. A drain consumes nothing for another phone.
- An owner request moves waiting, claimed, settled (`ownerRequests.ts`); an answer against a claimed or settled request is refused. First to answer wins, never first to check.
- An automatic answer would make first drain first answer. Question 1's rows must therefore be device-addressed, filtered on the Router.
- Per-device facts today: the foreground lease (ACTIVITY, PANEL, none), the idle tier and its silence clock, `currentFocus`, all phone-local. Read anchors are reported. The summon reports nothing.

Luna's map, verified where it changes the design:
- Owner rows have no device target. `RowOrigin.device` is origin metadata; `key_grant` filters by recipient on the receiving phone, the row still reaches every phone.
- Both request kinds reach every phone as `plugin_action` rows with retractions queued for every console. A second tap lands a refusal; the phone settles the card, stores the refusal in `state.error`, and the sheet closes when the request disappears. No non-human answer path exists today.
- Nothing about attention leaves a phone: `currentFocus` (written by `declareFocus`, read only to kick a poll), `visible`, the foreground lease, followed tabs, the idle tier and silence age, lock state, the playback queue. The Router sees a bound console socket and a per-signer cursor, which are transport facts.
- Read anchors are dead on both sides: `reportLocalReadAdvances`, `applyReadAnchors` and the Gateway's `ReadAnchors.report` have no callers. Filed on the board.
- Autoplay: `PollDrain.processEntries` speaks a new inbound row when the team is in `followedTeams`, STTS is ready and an autoplay tier is set. No visibility check, no cross-device check, so a phone on another app with the tab followed speaks, and two phones that both qualify both speak.
- Alerts: `NotificationGate` posts a message burst only when `!isVisible`, so two foreground phones post nothing, two backgrounded phones both post. Vault and assistant request notifications bypass that gate and reach every phone.
- The panel shares the process's repository, socket, drain and cursor; it only takes the PANEL lease. `watchedWorking` is passed as false by the transport planner, so the cap is dead. Filed on the board.
- Key grants: each owner phone dedupes locally, so two phones can both grant one recipient.

# Plan

## Refinements found while mapping the seams

- **Sealed payloads refine question 6.** An owner row's payload and a value op are sealed; the Router reads only a row's clear envelope and cannot open an answer. The envelope is Gateway-signed (`rowEnvelopeSigningBytes`), so the Router cannot rewrite it either. So: `recipient: holder` is the Gateway's signed selector inside the envelope; the Router resolves it on the `inbox_append` frame path (`InboxFrames.appendRow`, before `InboxService.appendRow`; `OwnerOpIntake` sees console-origin ops only) and writes the device as Router-owned row metadata beside the envelope, as it stamps `seq` and `at`, refusing a producer-supplied stamp. The Gateway keeps the stamp on the request entry and refuses an answer whose signed device differs, since it is the only party that can open one. The Router stays the authority on who holds; the enforcement sits where the answer is readable. Deploy the Router first: an older Router strips the unknown envelope field before verifying the signature and refuses the row.
- **The append answer reaches the request.** `deliverToOwner` queues the row and returns before the Router answers (`appendOwnerRow` fires the outbox drain and returns true; `OwnerRequestsDeps.deliver` is a boolean). The drain's `tool_result` carries the stamp or `no_holder`; `consolePushOps` exposes a per-row completion keyed by the row's op id, the phone request adapter awaits it under the request deadline, and `no_holder` settles as `unavailable` at once. Only `blob_missing` stays retryable, as today.
- **Cards go to every phone**, as vault and send cards do, first answer wins; the hold decides which phone alerts for one. No new addressing for cards.
- **A plain act leaves a trace twice:** a local notification line on the phone that ran it, and a quiet record row on the assistant thread, the kind `AssistantRecordRules` already keeps out of the burst. On a locked screen the notification shows its generic line only, under the `AssistantLockedForm` rule: never an argument, a recipient or a result.
- **A launch on a phone showing nothing fails out, typed.** Acts that start an activity (maps, app launch, shortcut, alarm, timer, compose, dial) run only while the panel or the app is in front, the screen is interactive and the keyguard is unlocked, read before the attempt, since a blocked background start throws nothing. Otherwise the phone answers `unavailable(not_showing)` and the assistant relays it ("did you turn off your screen?"). `ActivityNotFoundException` answers `app_missing`, `SecurityException` answers `not_supported`. No notification fallback: a screen turned off after the ask is the owner's, not the app's. `startShortcut` runs under a fail-closed role check; `assistantRoleHeld` answers true when unreadable, so the handler takes a strict variant. Reads and silent acts (torch, silent SMS, call, inline reply) run in the background. This settles question 2's open point.

> Yeah if I literally turn off my phone after asking it to, thats a user-error, not the app's responsibiliity to handle edge cases. Assume the failure mode will happen, and gracefully catch and fail out. The agent might say something like "I got this error. did you turn off your screen?"
- **The hold replaces the write lock, clean break.** The write lock was the first owner-presence rule: open while the owner prompted last or spoke within 30 minutes, read off the send guard's origin marker, asked by the gate on every file write. The hold is the same idea with a real record behind it: the owner's message from the phone claims it, it lapses 10 minutes after the last claim on the Router's clock, and a message from the panel or the Assistant tab claims it again. So the gate asks the hold instead, for file writes and phone acts alike, and the "prompted last, however long ago" clause goes: 10 minutes of silence locks writes whatever the newest row is. `assistant-write-lock.ts`, its route and the marker-derived answer are deleted; `WRITE_IDLE_MS` goes with them, and `PHONE_HOLD_WINDOW_MS` is 10 minutes. The marker keeps its other role, `readsOwner` for the send guard. The phone's `isLapsed` reads the Router's stamp against its own clock for its own speech and alert decisions, never for another phone. Lessons kept from the lock: a hold the hook cannot read refuses; the owner's own message is the only key; one source of truth; and a denial states the situation and what to do, below.

> The write lock was our first invention of like permissions. Lets clean break and migrate that to this new hold or whatever style we are engineering. Take lessons from it though. If the hold or whatever it's called is released and the agent fails to write to AGENT.md, then what happens? Any write deny should give the correct assessment of the situation and prompt the user in a natural way.
- **Guarded acts take the questionnaire's rule, not `createSendGuard.asks()`:** `approveEverySend` off skips the card and marks the run `unasked`; on opens the card. The origin marker keeps its write-gate role untouched.
- **Background reads run under the app's biometric lock.** The lock gates what is shown, not what the holder answers; it re-arms when the activity finishes, not on a timer, so requiring it would lock out the ordinary pocket case. A guarded card still waits for the owner-present tap, and a launch still needs the screen shown and unlocked. The hold's 10-minute window bounds the exposure.

> I think A with a 10 minute window for forgetting a hold might be good. But of course, if I want to respond, I have to unlock and summon again.
- **Service alerts outside the mailbox burst** (scheduled-send failures, routine misses) are exempt from the hold and alert every phone, and every notification that can exist on more than one phone joins the acknowledgement journal below: a dismiss on one phone clears the others. Nothing in this class is local: a scheduled send fires on the Router and its failure is a Router result row every phone drains; a routine miss is the Gateway's, pushed as a row. A message alert raised on every phone because nobody holds joins the journal the same way.

> If you do A), then all notifications must join the journal/mailbox. A dismiss from one is a dismiss to all. Scheduled-send failures i think is local right? So in that case, only raise on the phone in question. But any router or gateway governed failures and everything must agree with the multi-device journal
- **Older phones:** the hold plane and the `phone` plugin rows are additive. An older phone neither claims nor respects the hold and ignores the plugin rows. `applyPlane` answers false for an unknown plane name today, so an older phone would be offered it every poll; Phase 1 acknowledges an unknown name and leaves a malformed known plane unacknowledged. Both of the owner's phones update together; no shim, no protocol floor bump.

## Pieces

### The hold

- `src/shared/schemasPhoneHold.ts`: `PhoneHoldRecordSchema { holder, claimedAt, version }` (`.meta({ id: "PhoneHold" })`), `hold_claim` value and answer schemas, `PHONE_HOLD_WINDOW_MS = 10 * 60_000`, plane name `phoneHold`. Catalog entry in `ownerOpRegistry.ts`, mutation `value`; roots added to `codegen-kotlin.ts`.
- `src/federation-server/phone/phoneHoldService.ts`: one `OwnerStateStore` row, kind `phone.hold`, added to `RecordKind` in `ownerStateStore.ts`. `claim(domainId, device, now)` writes unconditionally at the next version, stamping the Router's `now`. `read(domainId, now)` answers no holder for a record past the window on the Router's clock, so an append between the lapse and the next sweep is never stamped to a lapsed holder. `planeVersion`. `onSweep("phone hold")` clears a lapsed hold durably at the next version and pushes. Registered in `ownerServices.ts`: `planeVersions`, `pushPlane("phoneHold", lineage, record)`, and `readPlane` answering the record as payload, so a phone needs no second op. Gateway frame `phone_hold` on change and `phone_hold_read` at registration, the `assistant_home` pattern. A friend Domain sees nothing of it.
- `src/gateway/phone/holdFollow.ts`: the Gateway's in-memory copy from the registration read and the frame. Read by the request road for the fast `no_holder` and by the baseline line; never an authority.
- Phone: `PhoneHoldOps.kt` with `OwnerOpHoldRouter` signing `hold_claim`; `applyPlane("phoneHold")` lands the record into `ChatState.phoneHold`, in the group `PollDrain` applies before inbox rows, so a poll carrying both a hold change and rows reads the rows under the new holder. Claims: a conversation opening or switching while shown, a team-keyed trigger in `ThreadScreen` wired through `MainActivity`, not the ACTIVITY lease edge alone; `AssistantPanelSession.onShow`; every send, which awaits the claim's result before the message goes, so the assistant's request cannot be stamped to the previous holder, and goes anyway when the claim fails, the claim retried; the Assistant tab. A phone that is already the holder re-claims only on a send.
- `PhoneHoldRules.kt` and `src/shared/phone-hold-rules.ts`, pinned by `tests/fixtures/phone-hold/vectors.json`, listed in `_signing-vectors-manifest.json`: `speaksFor(record, self, now, todayRule)`, `alertsFor(record, self, visible)`, `isLapsed`. No holder or lapsed: today's rule. Holder is self: speak, alert when not visible. Holder is another: silent, no alert. Applied in `PollDrain.processEntries`, in `PlaybackOps.enqueueForPlay` on every enqueue including a notification's Play action, in `NotificationGate`, in the vault and assistant pending-request notifications and `showVaultPrompt` in `SwitchboardService`, which bypass the burst gate today. A plane change to another holder clears queued and playing speech through the head-ticket road.

### The hold as the owner-presence authority

- `src/shared/assistant-hold.ts` replaces `assistant-write-lock.ts`: `ASSISTANT_HOLD_PATH = "/assistant/hold"`, `PHONE_HOLD_WINDOW_MS`, and `HoldAnswerSchema`: `held { holder, claimedAt, remainingMs }`, `lapsed { holder, lapsedMs }`, `none` (nothing claimed since the Gateway registered), `unreadable { reason }` on the hook side only, `not_assistant`, `unauthenticated`. The route in `assistantRoutes.ts` answers from `holdFollow`, judging the lapse from the Router's stamp with the Gateway's clock, so the sweep gap admits nothing.
- `gateHook.ts` asks the hold where it asked the lock: `held` allows; anything else denies. `phoneDispatch.ts` reads the same answer before opening a request, so a phone act and a file write refuse for one reason.
- `holdDenial(answer)` in `assistant-hold.ts` is the one text both roads hand the assistant, and the assistant's standing rules in `instructions.ts` say to relay it to the owner as it stands and stop retrying until the owner has written again. It states the situation, then the one way out:
  - lapsed: "Your phone's hold lapsed N minutes ago (last held by <phone>). I can't write files or act on your phone until you send me a message from the summon panel or the Assistant tab. Then ask me again."
  - none: "No phone holds me right now. Send me a message from the summon panel or the Assistant tab and ask me again."
  - unreadable: "I could not read the hold from the Gateway (<reason>), so writes stay refused. The Gateway may need a restart."
  - The phone's label comes from its device record if the Router keeps one; Phase 1 checks, and falls back to a short device id.
- The baseline after a compaction and the first line of a wake carry the hold's state, so the assistant knows before it tries.
- Deploy order: Gateway before plugin. A new hook against an old Gateway reads `unreadable` and refuses, which the denial text explains.
- Tests: the send guard's lock tests move to `holdFollow` and the route; `gate.test.ts` covers held, lapsed, none and unreadable, and that a denial carries the text.

### The acknowledgement journal

- The dead read-anchor road, revived as the one multi-device acknowledgement: the Router already stores `report_read` anchors and answers `read_anchors_read` (`tier1/readAnchorsService.ts`); the phone's `PresenceOps.reportLocalReadAdvances` and `applyReadAnchors` have no callers (board entry bd_f817dbd2). An anchor is per owner, per stream (a conversation, the scheduled-send results, the routine notices), the newest row acknowledged on any phone.
- Router: `readAnchors` joins the owner planes in `ownerServices.ts`: `planeVersions`, `pushPlane` on report, `readPlane` answering the anchors as payload. The Gateway does not read it.
- Phone: opening a conversation, and dismissing a notification (its `deleteIntent`), report the anchor; `applyPlane("readAnchors")` lands another phone's anchors, and `ServiceNotifications` cancels every notification at or below the stream's anchor. Unread counts read the merged anchor, so two phones agree.
- The wire exists; the work is the plane, the two phone call sites, the cancel, and tests: a dismiss on one TS phone driver clears the other's notification in the harness, and `ReadAnchorTest.kt` covers the merge with the row-position resolution `ReadAnchor.kt` keeps.

### The capability registry

- `src/shared/schemasPhoneCapabilities.ts`: `PHONE_CAPABILITIES` as one object, `satisfies Record<string, CapabilityDeclaration>`, each entry `{ request: z.strictObject(...).meta({ id }), answer: ...meta({ id }), kind: "read" | "act" | "guarded", where: "phone" | "gateway", needs: PhonePermission[], label, describe }`. `PhonePermission` enum: `contacts`, `calendar`, `notifications`, `send_sms`, `call_phone`. Derived: `PHONE_CAPABILITY_KEYS`, `RequestOf<K>`, `AnswerOf<K>`, `PHONE_CAPABILITY_PATH`. One strict object per key is the request: the MCP tool takes its shape, the dispatcher parses the same object. The watcher actions keep a raw shape wrapped twice; this registry does not repeat that.
- The answer union: `ok { answer }`, `unavailable { reason: not_granted | not_showing | app_missing | not_supported | no_holder | timeout, needs? }`, `refused { reason }`, `not_assistant`, `unauthenticated`. A discriminated union, so codegen takes it as a sealed root.
- Codegen: every request and answer schema is a `ROOTS` entry in `codegen-kotlin.ts`; every nested object carries its own `.meta({ id })`; the keys generate `Protocol.Wire.PHONE_CAPABILITY_*` constants as the owner-op kinds do. The keys are disjoint from `ASSISTANT_ACTIONS` by a compile-time type and a test, since both registries register bare tool names.
- `screen_read` is a key: it answers the panel's last capture while the panel shows, else `unavailable(not_supported)`. Question 9 counts the screen among the reads.
- `scripts/gen-phone-capability-fixture.ts` writes `tests/fixtures/phone-capabilities/registry.json` (key, kind, where, needs, request and answer schema ids, tool description hash), listed in `_signing-vectors-manifest.json`; `check:capabilities` in `package.json` and `ci.yml` diffs it; `phone-capabilities.test.ts` replays it against the registry; `PhoneCapabilitiesTest.kt` replays it against the Kotlin handler map, so a missing handler, a `needs` that disagrees, or a handler bound to the wrong generated type fails before build.
- `src/mcp/assistant/phoneTools.ts`: one tool per key, as `actionTools.ts`, posting `{ key, callId, params }` to `PHONE_CAPABILITY_PATH`. `assistant-session.ts` spreads the keys into `ASSISTANT_SWITCHBOARD_TOOLS` and `ASSISTANT_ONLY_TOOLS`, so `scopeTools`, the gate, `assistantPermissionArgs` and both halves of `check:boot` follow: present for the assistant, absent for every other session. Each tool description ends with its `needs` and class, as evie-bot injects the initiation rule.
- `GatewayCapabilityRuns`: `{ [K in GatewayKey]: (params: RequestOf<K>) => Promise<AnswerOf<K>> }`, built in `composeAssistant.ts` beside `WatcherActions`, so a gateway-side key without a run does not compile.

### The request road

- `src/gateway/assistant/phoneDispatch.ts`, the one door: dedupe by `callId` (`createOpDedupe`), parse params with the key's object, then by `where` and `kind`. Gateway: run. Phone, guarded, with `approveEverySend` on: open a card (below), run on approve. Otherwise open a phone request carrying `guard: approved | unasked | none`.
- `src/gateway/assistant/phoneRequests.ts`: the third adapter on `ownerRequests.ts`, `sessionTarget: ASSISTANT_TEAM` for the request and its card. `requestId` is the `callId`, so the phone's dedupe covers a Gateway restart. Row `plugin_action` with `pluginId: "phone"`, `actionType: "capability"`, payload `{ requestId, key, params, guard }`, `recipient: { kind: "holder" }` in the signed envelope, volatile, queued through `deliverToOwner`. The adapter awaits the row's completion: the stamped device is kept on the entry, `no_holder` settles `unavailable` at once. Deadline `ASSISTANT_WAITS.phone` in `waits.ts`, nested inside the route's wait; the exact POST path joins `LONG_WAITS` and not `REPLAYED_LONG_WAITS`, with the route added to the serve-limits audit and `ROUTE_WAIT_MS`. Answer op `phone_capability_answer` added to `ConsoleOpSchema`, `VALUE_OP_KINDS`, `consoleHandler.dispatch` and the generated Kotlin `ConsoleOp`; `consoleHandler` passes the signed device; the adapter refuses a device other than the stamp, parses the answer with the key's schema, settles.
- Router: `schemasInbox.ts` gains the `recipient` envelope field and the Router-owned `stamp` beside it; `InboxFrames.appendRow` resolves `holder` through `phoneHoldService.read` with the Router's clock, writes the stamp, answers it in the append result, or refuses `no_holder`. The row still reaches every consumer.
- Restart: open stubs are retracted by `retractStale` as today; the answer promise and the dedupe map are process-local, so a tool call cut by a restart times out on the plugin side and a retry with the same `callId` opens a request with the same `requestId`, which the phone answers from its stored answer without running the act again.
- `src/gateway/assistant/actGuard.ts`: the guarded card adapter, sharing the send guard's `approveEverySend` and `unasked` word under the questionnaire's rule. Card row `assistant:act-request { requestId, key, label, summary }`, retraction `act-retract`, answer `assistant_act_answer`. Approve opens the phone request; deny answers `refused`. The card's `summary` is the capability's label and its human arguments, composed by the Gateway.
- Records: every run lands a quiet record row under the `callId`, as `actionDispatch` records, carrying only the key and the outcome: no query, result, recipient or notification text in `body`, `title`, `threadId` or `url`, since a quiet record's `threads` render on the phone. `schemasAssistantRecord.ts` gains `ran`, `unavailable`, `refused`, and `AssistantRecordRules.outcomeLabel` gains their labels.

### The phone

- `plugins/phone/PhonePlugin.kt`, registered in `Plugins.build` beside `AssistantPlugin`, never in `PluginCatalog`: claims `phone:capability`. `PollDrain` carries the Router's `stamp` onto the decoded `MailboxEntry`, so the subscriber ignores a row stamped for another device. `onAction` validates and enqueues only; `PhoneCapabilityOps.kt` runs the work in a repository-owned scope: `permissionState(key)`, the handler, then `phone_capability_answer` through `sendValueOp` to the Gateway resolved from `action.team` and kept with the pending request, never the Gateway the UI shows. Side effects are at most once per `requestId`: the ran-marker is written durably before the handler runs, a redelivery answers from the stored answer, and a crash between the marker and the answer answers `unavailable(timeout)`. `plugins/assistant/AssistantPlugin.kt` gains `act-request` and `act-retract`; `AssistantActSheet.kt` and `AssistantActOps.kt` are their own card, since the send sheet renders send intents.
- `PhoneCapabilities.kt`: one `PhoneCapability<Req, Ans>` binding per key, typed to the generated request and answer classes, keyed by the generated kind constants, with its declared `needs`; `permissionState` reads `checkSelfPermission`, the listener grant and the strict role check. The manifest declares `READ_CONTACTS`, `READ_CALENDAR`, `SEND_SMS`, `CALL_PHONE` and the listener service; the sideloaded restricted pair may stay `not_granted` without installer allowlisting, and `status` says so.
- Handlers: contacts (`ContactsContract`: search, birthday), calendar (`CalendarContract`: next events, days until), notifications (`AssistantNotificationListener`, a `NotificationListenerService` holding a bounded in-memory ring; recent, by sender; inline reply through the notification's `RemoteInput` action; rebinding after an update verified on the Pixel, since `MY_PACKAGE_REPLACED` restarts `SwitchboardService` and says nothing of a listener), maps (`google.navigation:` and `geo:`), torch (`CameraManager.setTorchMode`), app launch, App Action and shortcut (`PackageManager`, `LauncherApps.startShortcut`; `app_action` takes an enumerated id from `status`), alarm and timer (`AlarmClock` intents, with `SET_TIMER` added to the manifest's `queries`), SMS compose and dial (intents), silent SMS and call (`SmsManager`, `ACTION_CALL`), `screen_read`, `status` (holder, per-key availability, enumerated App Actions and shortcuts). A launch act runs only while shown, interactive and unlocked, else `not_showing`. An act posts the trace notification on the "assistant acts" channel.
- Logging: the listener and `PhoneCapabilityOps` log through one seam, `CapabilityLog`, that takes a key, a count, a boolean or an enum and nothing else; `DebugLog.log` is refused in those files by a residue test, so no parameter, result, notification text or exception message can reach ingest.

### Gateway-side capability

- `ifttt_trigger`, `where: gateway`, `kind: act`: `src/gateway/assistant/iftttClient.ts` reads the webhook key through `readForWatcher` under the fixed grant scope `ifttt`, as `githubClient.ts` reads its token under `github`, and posts `maker.ifttt.com/trigger/{event}/with/key`. The setting stores the vault entry id only, chosen on the phone through the same grant road as the GitHub token; the key never sits in a setting.

## Phase 1 - Roads

The hold end to end, the write lock migrated onto it and deleted, the denial text and its relay rule; the acknowledgement journal on the revived read anchors, with the dismiss-clears-all behaviour on both phones; the registry with its fixture, tools, scope, gate and boot check; the request road with the recipient stamp, the row completion, the wrong-device refusal and `no_holder`; the card road; the phone plugin, dispatch, dedupe and `permissionState`; `status`, `contacts_search` and `torch` as the proofs of read and act; the hold rules in both runtimes with their vectors; the unknown-plane acknowledgement. Fixtures: the new owner op, answer and stamped-row cases in `gen-wire-fixtures.ts` `ownerEntries` and `WireFixtureGenerator.kt`, both manifests updated. The harness gains a second admitted console and drives a fake phone through a claim, an answer, a wrong-device answer, `no_holder` and a lapse. Deploy order: Router, Gateway, phones. Verified on the Pixel with both phones: claim, handoff, speak and alert; `status`; `contacts_search` with the grant on and off; the torch.

### Progress

- Implemented, uncommitted, every gate green: four Luna slices (Router, Gateway and MCP, phone, fixtures), then comment and test cleanup.
- Align lap 1 (17 findings, 13 real) fixed by hand while Codex was rate-limited: phone dispatch reads the hold and refuses with `holdDenial`, rechecked when a card's approval opens the request; a phone row's op id is fresh per Gateway attempt and the phone resends a stored answer for a known request id, a Gateway refusal ending its retries; the hold plane keeps a lapsed holder until the sweep; a holder recipient is refused unless addressed to the appender's own owner mailbox (`recipient`); the denial names a short phone label; Kotlin keys come from `Protocol.Wire.PhoneCapabilityKey`; a late claim answer never replaces a newer hold row (`landsHold`); a row needs this phone's stamp (`stampedFor`); torch checks no camera permission; request cards (vault, send, act) wait for the app unlock; a swiped routine miss sends the Gateway's dismissal. Harness gains a lapse case and a cross-phone read-anchor case.
- Dismissed in lap 1: announcing on an uncertain write (matches the assistant home's rule); wire generators for the stamp and answer (the protocol corpus pins both runtimes); the registry fixture in the vectors manifest (not a vectors corpus); the fixture hash of the derived needs line.
- Next when Codex is back: re-audit (`align-fan-out`), then red-team, commit, architecture, docs, crust, completeness; Pixel verification after the commit, with the plugin released alongside the Gateway since the gate hook asks `/assistant/hold`.
- Committed `92b21bd6`, plugin 8.14.8 `d5939105`, Router and Gateway restarted, phone on 8.14.8 debug. Pixel, 18:29: the panel pops over Discord as a bottom sheet; showing it claimed the hold within the second; Share screen attached and the assistant described the screen exactly (text and image).

### Owner requests from the Pixel pass

1. **The hold keys on the phone's signing key, not its name.** Found live: a phone's `device` is its model name ("Pixel 10 Pro XL"), so two phones of one model share a hold, a stamp and the speak and alert rules. The holder is the console signing key the Router verifies on every owner op (`signerSignPub`); the record carries the device name as a `label` for the denial text. The stamp, the Gateway's answer check and the phone's own comparison all use the key.

> did you key holds by device display name? or thieir unique 12/16 or whatever digit ids??

2. **The send button becomes a spinner while the send is out**, in the panel.

> Would be nice if the send button was replaced with a spinny circle.

3. **Following a new message, in the panel and in the in-app thread.** Only when the list was already parked at the bottom. A new message whose height fits the viewport plus 8px tolerance: follow to the bottom. Taller: stop following and place the message's top at 5% of the viewport, so the last 5% of the previous message shows above it and the new one runs past the bottom, to be read top-down. The move slides over 0.3 s. A pure rule beside the thread's ops, tested.
4. **The panel's title bar is a drag handle that sizes it.** Every summon starts at today's size; sending a message grows it so its top sits about 5% from the top of the screen, giving the follow rule room.

> wait.. did it actually arrive but the message is below the bottom? [...] Dont just jump to the bottom, because you cant see the top lines for a long message. Rules: Must have already been parked at the bottom-most position. Test if the large new message's pixel height is equal or under the viewport + like 8px for tolerance. If pass, auto follow. If not, we stop auto follow and position it so the top of the message is at the 5% top of the view. This means the last message ~5% of it's bottom is visible on the top of the viewport, and the large new message directly follows, ending beyond the bottom of the viewport. This makes it so the user can see the whole messgage and follow it as they read. Slide effect 0.3 sec so it's apparent that it's moving and not teleporting. Assistant Summon panel gets a new bonus: The title bar "Assistant Open in App ->" is a draggable sizing bar. Starts at this current size by default every summon, but upon sending a message, it will resize taller so the top is abuot 5% of top of screen. Gives more room for auto follow to work it's magic.

## Phase 2 - Capabilities

Every remaining key, one Luna per family, each adding the declaration, the Kotlin handler, the fixture regen, tests and the tool description: contacts and calendar; notifications with the listener and inline reply; maps, apps, shortcuts, alarms; SMS and calls, compose and silent; IFTTT on the Gateway. Audits: comments, architecture, residue, Kotlin gate.

## Phase 3 - Acceptance and docs

The owner's three sentences on the Pixel through the summon panel, with the second phone showing the hold change, and a launch failing out as `not_showing` on a pocketed holder, relayed by the assistant. `docs/assistant.md` (the phone road, the registry, the card), `docs/console.md` (the hold, speak and alert), `docs/federation.md` (the plane and the stamp), `docs/testing.md` (the harness's second console; the emulator sandbox stays outside this feature's verification), AGENTS.md map lines. Painpoints to the board.
