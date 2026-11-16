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

## Question 7 - What is the unit the assistant asks the phone in? [Superseded]

Q: One tool per capability, one generic ask, or a tool list the phone advertises?
A: A typed capability registry, one tool per key, in the shape of the watcher actions (`ASSISTANT_ACTIONS`): request and answer schemas, read or act, the phone permission it needs. The keys spread into the assistant's tool set so the gate, the launch permissions and `check:boot` follow the registry. One handler per key on the phone. A phone that cannot serve a key answers a typed `unavailable` with its reason. The App Actions and shortcuts other apps advertise are one typed act whose parameter is the enumerated capability id. The permission tiers from `FINDINGS.md` are a registry column.

> A sounds good

Superseded by Question 7b: the registry stays; the one-tool-per-key exposure goes.

## Question 7b - How does the assistant reach actions and capabilities?

Q: One tool per key (the launch-time allowlist refuses a key added by a release until the assistant relaunches, and the names do not scale), one tool per key allowed by server prefix, or two fixed tools?
A: Two fixed tools in front of both registries. `list_actions` answers what is available now: each capability and watcher action under a namespaced id (`phone/torch`, `watcher/github_done`), its description, kind (read, act, guarded), the permission it needs and whether it is granted when known, and its parameter schema rendered from the same Zod object the dispatcher parses. `run_action` runs one by id with parameters, validated against that object, and hands the call to the family's existing dispatcher with the same call id. The allowlist names the two tools and never grows; a new key is a registry entry and a handler. The channel's `reply_schema` and `channel_reply_structured` are the same pattern (a schema carried with the request, a tool that answers in its shape) but hold no reusable code: the handshake schema is a hand-written string with an ad hoc check.

> tbh I hate both names, blah_torch or otherwise. It's totally non-scalable

> A. Exactly that.

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

## Question 10 - What does securely local mean for a plug?

Q: The HS103's local protocol is obfuscated, not authenticated. Isolate the plugs on a network segment only Sakura reaches, or settle for cutting the plug off its cloud?
A: Cut it off the cloud; no network isolation.

> ok we won't worry about vlan. but having the disconnect from cloud is enough

## Question 11 - Who scans the network for plugs?

Q: The Gateway cannot broadcast from its Docker network. The host daemon on Sakura, the phone on the home WiFi, or no scanning with addresses typed by hand?
A: The host daemon. One typed `HostOp` to scan for Kasa plugs; the Integrations page shows Scan and lists what Sakura found with an Add button each; works away from home.

> A.
>
> and once more, that destructive disconnect is a brand/model specific config. So we would have a generic smart device layer, and the brand Kasa for this plug layer. The Kasa plug layer does this specific disconnect.

The layering is fixed by that: a generic device layer the assistant and the app call against, a driver per brand beneath it, and brand-specific acts such as the Kasa cloud disconnect living in the driver's own configuration, never in the generic surface.

## Question 12 - What vocabulary does the generic layer speak?

Q: Typed device kinds with fixed verbs, a flat feature list each driver declares, or switches only until a second brand?
A: Typed kinds. A device has a kind (`switch` now; `light` and `sensor` when they come), each kind has fixed verbs the generic layer defines (a switch: on, off, toggle, state, a weekly schedule), a driver implements the kinds it supports, and brand extras (the LED, the cloud disconnect, the clock) are driver settings on the device's page. The assistant sees one `devices` and one `device_set` that read the same for every brand; a small driver-settings map is the escape hatch for what no kind models.

> A

Decided alongside, not asked: a switch's weekly schedule is written to the device when its driver can hold one (Kasa can) and read back from it; a driver without on-device schedules answers the verb unsupported until a Gateway-held runner exists. The IFTTT action keeps its id; only its row moves to the new category.

## Question 13 - Is the Integrations page also a remote?

Q: Live state and a switch on each device row, or configuration only with control through the assistant?
A: A remote too. Each row shows live state with a switch; the device page holds the schedule, rename and the driver's settings; state is read on open and on pull through a device read kept apart from the assistant's own state.

> A.

Decided alongside, not asked: a device is keyed by its MAC with the address a mutable field a scan refreshes, so a plug that moves is re-matched rather than lost; `device_set` is an act with no owner card, as the torch is; the cloud disconnect is the owner's from the device page and never an assistant action; a device action runs on the Gateway with no phone hold, as the IFTTT action does; an unreachable plug answers `unreachable`, a new unavailable reason that ships to every reader before the Gateway emits it; devices belong to one Gateway and the assistant's actions see its home Gateway's list.

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

## Question 14 - Where does a Bluetooth device pair?

Q: A Bluetooth device is heard by whichever radio is near it: a Gateway's host, or the phone. Which one owns it?
A: Either. Scan runs on every Gateway and on the phone, results are deduped per device, and choosing one asks where to pair: the Gateways that heard it, sorted by signal strength where a reading exists, then This Phone last.

> I'm thinking of 2 ways Bluetooth can pair. Either to the Console in question, or to the Gateway. So when scanning for devices, it needs to scan on both ends. Dedup and when choosing to pair with the device, you ask a dialogue
> Pair with
> [ Sakura ]      <-- Gateways sorted by signal strength if metric is possible
> [ Other gateway that saw it ]
> [ This Phone ]  <-- Shown last

## Question 15 - What is a device paired to This Phone?

Q: The phone holds no records of its own, and the assistant reaches it only through the hold. Where does a phone-paired device's record live?
A: B. On the assistant's home Gateway, with the owner's phones as its radio. Any owner phone that hears it posts the raw reading, coalesced (on change, or every few minutes); the Gateway decodes it and keeps the last reading with its age. The assistant, check-ins, rules and the other phone read it with no hold; with no phone near it reads stale, with its age.

Recommended because a sensor is mostly an input to the assistant and to rules, which run on the Gateway without the hold. One device list, survives a lost phone, either phone feeds it. This Phone picks which radio listens; the record lives with the assistant. Dropped: phone-only (invisible to the other phone, assistant only under the hold, a second device vocabulary) and a Router-held record (most cost, readings still only from the owning phone).

> B

## Question 16 - Who sees a device paired to a Gateway that is not the assistant's home?

Q: The app sees every Gateway's devices (scanning spans them). Does the assistant see only its home's, also reach other Gateways through home, or does every Bluetooth record live on home with other Gateways as radios?
A: A. The app sees every Gateway, the assistant its home only. Integrations groups devices per Gateway, labelled "the assistant sees these" (home) or "app only"; the Pair with dialogue marks which picks the assistant will see; a device paired on one Gateway cannot be paired on another. A device belongs to the radio it paired with.

Recommended because it is the cheapest, adds nothing between Gateways, keeps one ownership rule, and the assistant reaching other Gateways (B, over the sealed `gateway_relay` with a new `FederatedOp` kind) can be added later without undoing it. Named follow-up: B, for the first remote device the assistant must reach; its hard part is a danger act's approval crossing Gateways. Guards from the review: device pages unwind when the roster drops their Gateway, not when it is not home; a device's capability (radio, drivers) rides `device_list`'s answer per Gateway, not `assistant_state`; a declined Gateway's group hides rather than drawing red; a This Phone record lands on the home at pairing time, and phones post readings to the Gateway that holds the record. Open, to ask on its own: a home move leaves every device on the old home.

> A

## Question 17 - What are readings for in this phase, beyond the last one?

Q: Last reading with a 24-hour low and high and a stale reason (A), plus threshold alerts into the assistant's inbox (B), or plus a 14-day hourly history and chart (C)? B and C stack on A.
A: B, on top of A. Per sensor, the owner's thresholds (temperature low and high, humidity low, battery low) with a dead zone so a value at the line does not flap; a crossing raises an event in the assistant's inbox through one sensors watcher, routed by the owner's rules. Slices may split. History (C) and a plug switched by a threshold with no model are later.

> B, but you can split the slices.

Settled alongside, all three reviews agreeing: the reading lives off the device record (no record write per advertisement; best-effort on the persist tick). Sakura never runs a standing discovery, since its Bluetooth shares the AX211 with WiFi: LE only, in short windows, or an offloaded AdvertisementMonitor if its BlueZ supports one. The Govee value's bit 23 is its sign (`0x800000`), and company id `0x0001` is Nokia's, so recognition keys on the `GVH5110_` name prefix and the payload length. A reading carries the radio that heard it and its capture time; the newest capture wins across radios.

## Question 18 - How much of the field schema is built now?

The foundation, from NyaaDot's `FrameworkSchema` and `SchemaForm` and the watcher plan's Question 6: one field declaration held as data (name, label, type, optional, default, description, constraints typed per type), one type table in TS (`satisfies Record<FieldType, ...>`: rule tests and labels, parse, format with unit) generated into Kotlin, and one reader per surface (the Gateway's `parseFieldValue` answering a value or an issue as path + message + code, the assistant's text renderer, the phone's per-type field widget). Improved on NyaaDot: one table instead of a type switch written five times, one renderer instead of two form classes copying each other, constraints typed per type instead of a string bag.

Q: Build the core and move the rule editor, GitHub's specs and the Kasa section onto it now (A), or the core now with sensors on it and those moves later (C)?
A: C.
1. Codegen gains an Unknown member for every generated union, on both phones before any Gateway emits a new kind (today one new `AssistantFieldSpec` member makes an older phone fail to decode the whole assistant state).
2. The core keeps the wire words `enumeration` and `text` and adds `number`. The type table is generated into Kotlin, replacing `RuleDraft.kt`'s hand-copied `RULE_TESTS`, `CHOICE_TESTS` and `testLabel`. One number grammar written longhand (ICU-safe) and pinned by vectors; fit is twinned, compare stays in TS. Values print with units on the Gateway, since the plugin's `eventLines` holds no specs.
3. The phone: one field widget per type, and a reading row around it (age, 24-hour low and high, stale reason). The edit seam is value in, issue out; commit stays with each ops class, so no fourth freshness mechanism appears.
4. Thresholds are Number fields, with low below high and the dead zone checked across fields. The sensors watcher routes on Choice fields (sensor, measure, crossing); rules gain no number tests this phase.
5. The Kasa section moves when a second brand with settings arrives (Tapo), with its typed put, `samePut`, the danger fence and a declared act precondition replacing `actOffered`.

Recommended by both reviews: A's migration rebuilds the danger-fenced settings wire across four components to gain one Boolean (the LED); cloud is a one-way act and the clock a composite.

> Sure C.

Owner's direction with the answer, for the next question:

> also keep in mind schema could be used to drive integrations. Like we have data , schema as data, that uses schema to render. you're covering that.
>
> But what if:
> - you could in app, configure like as if your programming, a field that is the result of (if greater 30, return "Hot!") except in a visual way?
> - you could customize a custom widget and have it render that custom built field thing
> - you could create a integration called "Throw ice bucket!" that fires once when it becomes "Hot!"
>
> nice. use NyaaDot for inspiration of schema as data and such, and we do a very dead simple vibes version based on the things you are researching
>
> something I low-key want as well is NyaaDot's live console in. that way we can live debug in app, instead of needing to rebuild and push a debug build every time you want to do some instrumtation.
>
> and especially, it allows us to type the name of a schema, and literally see the card on it so we can understand if we made this Tapo schema correct. just overall a good idea. we should definitely flesh it out when we get to the phase. Steal from my NyaaDot.

NyaaDot's console (`docs/Framework Console.md`, `addons/game_framework/schema/console/`) is a sandboxed expression language (lexer, recursive-descent parser to an AST, tree-walk evaluator) over a registry of typed entities, methods and properties, with schema-driven autocomplete and parameter hints. A computed field's expression is the same kind of thing, stored as an AST instead of typed as text.

## Question 19 - How much of the owner-built layer does Phase 2.6 carry?

The model, from Home Assistant (a computed field is a level, an automation is an edge on it), CEL (type-checked at save, unknown as a value, cost bounded by structure), Node-RED (flat node tables, typed literals), NyaaDot (the AST and its type inference), and the repo's routines (at-most-once, incarnations):

- **A computed field is the only home for an expression.** `{ id, revision, incarnation, label, nodes }`, `nodes` a flat table (codegen has no recursive path) of closed node kinds generated into Kotlin with the Unknown member: field, literal (typed, in the Q18 grammars), compare (ops from the type table), all, any, not, choose, and band (low, ok, high with a dead zone, its side persisted). Checked on put and on every read (validity read, never stored); a put refuses with the Q18 issue shape. Branches that are all Text literals infer a Choice of those literals. No loops, calls or clock; capped at 64 nodes, computed-on-computed as a DAG at most 4 deep. Re-evaluated only when a field it names changes, on one evaluator lane per Gateway. Its declaration is a Q18 field derived on read, so rules, the assistant's renderer and the phone's widget read it as any field.
- **A value is known (value, at) or unknown (reason).** A stale input is unknown; all and any short-circuit past it. Unknown is never a transition; recovery compares against the last known value.
- **An automation is "when [field] becomes [value], do [one action]".** `{ id, revision, incarnation, label, enabled, trigger { field, becomes }, action, coolDownSec }`. It fires on a change only, never at startup for a value already held. A create, an edit of it or of its field's expression, a re-enable and a new placement take the current value as the baseline without firing. `handledSeq` commits before dispatch (the routines' at-most-once); the action carries the call id `automation:<id>:<incarnation>:<seq>` through `createOpDedupe`. Actions are a closed union: tell the assistant, device on or off (never toggle), IFTTT. A danger act is refused at save. Each run lands in a bounded log as ran, refused, uncertain or suppressed, never retried.
- **A widget is layout only:** containers (column, row, grid) and leaves (a value, gauge or age; text; a button bound to a device act), visibility and tone naming Boolean computed fields.
- **The phone never evaluates.** Builders are pure models beside their ops class (`ExprDraft` with typed holes, `fitsHole`, `replaceAt`, `issueOf`), an outline of rows, never a canvas, with a Gateway preview as `runbook_preview` does.
- **Every record lives on the one Gateway that holds its inputs**; a reference to another Gateway's field is refused at save until Q16's follow-up B.

Q: Carry the core (computed fields with band nodes, durable field state, automations with the tell-the-assistant action) in 2.6, with the builder, other actions and widgets later (A), or the engine and builder too (D)?
A: A. Q17's thresholds are a band field per measure plus one automation each, edited from the sensor page's rows. One owner-record store is extracted first from the discipline the rules, runbook, policy and device stores each copy (phone-minted id, Gateway-named revision, buried ids, invalid on read, `commitChecked`, `onChanged` after the write). Later phases on the same records: the row builder and the other node kinds with previews, device and IFTTT actions with the save-time tier refusal and a Gateway fire cap, widgets, the live console.

Recommended as the dead simple version that is still the real model: the thermometer alerts through the field and automation an ice bucket will use. Dropped: thresholds as a special case rebuilt later, and a watcher holding its own fire-once logic, both writing one defect class twice.

> A

Settled by Questions 18 and 19, not asked: the generic layer has one `sensor` kind whose readings are declared fields (Number with a unit), not a kind per sensor type.

## Question 20 - What does a Bluetooth scan list, and how is one device matched across radios?

Q: Only what a driver reads, recognized by declared data and matched by address (A), or every advertiser with Pair only where a driver serves (B)?
A: A, with a looser match. A catalogue entry recognizes a maker's family, not one model, so an untested model is listed too, with a warning that it was not tested. The owner can add it anyway, drive the builder to see what sensors or controls it has, and make their own schema against it. That opens communal device cataloguing. Matched across radios by address; a device whose address rotates cannot pair. Neighbours' devices of no catalogued maker never leave the radio.

> I don't want to buy every version of a GVHxxxx, so maybe we have a looser manufacturer match instead. But we do have a warning on something we didn't officially test. Let's them add it themselves and drive the builder to see what sensors or controls it has and then make their own schema against it. Could open up communal devices catalogging

Owner, on how the match reads: a catalogue entry declares its matchers per transport. Bluetooth: name patterns, the company codes the maker really sends, service and beacon ids, and address prefixes for public addresses. Home network: the discovery protocol that answers, a model pattern in its answer, the address prefix. Setup network: the name prefix of the network an unconfigured device broadcasts (2.5e's setup prefix). Any fingerprint names the maker; a definition's own models mean tested.

## Question 21 - How much of the device definition format does 2.6 build?

Research (govee-ble 1.5.2 parser and tests, Apache-2.0 with an MIT-derived parser, its vectors usable with attribution; Home Assistant's 31 Govee matchers; Theengs Decoder as a GPL design precedent only):

- Six of Govee's seven broadcast packings are plain byte reads, covered by take (offset, length, signed, endianness) and arithmetic (add, sub, mul, div, intdiv, mod, bit and, shift) with Q19's compare, all, any, not and choose. The seventh (key 0xEF88 buttons and motion: AES, a CRC, events not levels), GATT history, light control and AES-GCM sessions need coded drivers.
- Govee is matched on markers, not names: service UUID 0xEC88; manufacturer key 0xEC88; key 0x0001 with prefix `01 01` together with service EC88 (0x0001 alone is Nokia's); keys 0x8801, 0x8803, 0x8843 with a payload starting `ec 00`; the probe service UUIDs 8151 to 9851 and 5550; the `INTELLI_ROCKS_HW` iBeacon (Shenzhen Intellirocks, Govee's parent; not every unit sends it). Names are often missing or carried only in the scan response, so a name only reads the model code (its 4-hex suffix is the address's last two bytes). Lights excluded (`ihoment_`, `GBK_`, `Govee_H6`, H7, H1; 0x8843 with `ec 00 xx 02` or `03`). Every marker but a name fits a BlueZ or_pattern and an Android masked `ScanFilter`.
- A definition describes a format and lists its models: the H5106 shares the H5110's key, prefix and length but packs 32 bits (read as an H5110 it says 97.1 C), and the H5179 has two packings by firmware. Match length as at least n, since some units append the iBeacon.
- The H5110 decode corrected: battery is byte 5 `& 0x7F`, bit 7 an error flag; humidity comes from the masked value; temperature and humidity read unknown on the error flag or outside -40 to 100 C. Bit 23 is sign-magnitude, not two's complement. `010103bac864` reads 24.4 C, 42.4 %, battery 100; `010180d16c5a` reads -5.3 C, 61.2 %, battery 90; `0101817c86d8`-style frames pin the BigInt path.
- Six models (H5074, H5075, H5129, H5179, GV5179, H5130) send readings only in the scan response, so they need an active scan; the H5110 reads passively. Multiplexed broadcasts (H5112, H5178, paged probes) need a selector on the raw input, later.
- The raw input is the per-address union over a scan window (name, manufacturer key to bytes, service data, UUIDs, RSSI, time); a Bytes value is one key's manufacturer data without the key bytes, the same from BlueZ and Android.

Q: The H5110 as the first definition file with Bytes and two node kinds in the core and the mapping builder later (A), a coded decoder now (B), or definitions and the mapping builder in 2.6 (C)?
A: A. The H5110 ships as the first definition, in the shareable format; the repo is the first communal catalogue (one file per model under `src/shared/device-definitions/<family>/`, loaded through the schema and checker at boot, codegen and test, each file's examples replayed by the TS evaluator). The core gains the Bytes type (lower-case hex, capped at 64 bytes, no rule tests, shown as spaced hex with offsets), take and arithmetic nodes, and a typed unknown literal with a reason. An untested Govee device is listed with the warning, pairs, and shows its last distinct payloads live (held in memory per source); mapping waits for the builder phase.

Recommended: one model (the thermometer reads through the definition an owner will build), about 40 evaluator lines over the 2.6 core, and the same pick as Question 19.

> A

Settled alongside, from the review:
- **Definition shape:** `{ format, key, version, family, label, models, match { sources, name prefix, activeScan }, inputs, readings (Q19 computed fields over the inputs), examples }`, byte for byte the same shipped, built, imported or exported. The Gateway wraps an owner copy with id, revision, incarnation and provenance (shipped, built, imported); tested derives from provenance, never from a flag a shared file could forge.
- **Q19 amended:** a definition's readings are computed fields declared in a template and instantiated per paired device (`device:<mac>/<readingKey>`), never copied into the owner's store, so a shipped fix reaches devices already paired. A version bump re-baselines automations without firing. The node table is order-only (a node names only earlier nodes), so cycles cannot exist.
- **The evaluator:** integer operations over BigInt (JS `&` and `>>` are int32), one rounding rule for intdiv and mod pinned by vectors, each Number reading rounded to its declared decimals so float noise is never a change; division by zero, an out-of-range take or a short frame answers unknown and never throws. Bitwise and is not named `band`, which is Q19's threshold node.
- **An owner-built or imported definition never widens the radio filter:** its match must sit inside a shipped family match, so a new maker arrives only by a repo file and a release. Imports are data only, capped (32 KiB, strict objects), refuse address-shaped strings, keep names as prefixes cut at the last `_`, and pass labels through `neutralizeMarkup`. Import is an owner act, withheld from the assistant.
- **Two vector sets:** decode examples replayed by TS only (the phone never evaluates); recognition vectors in `tests/fixtures/ble-recognition/vectors.json` with a Kotlin twin, since both radios filter.
- **Acceptance:** pull the H5110's battery, rescan, and confirm the record re-matches its address.

## Question 22 - How does the host daemon talk to Bluetooth?

Checked on Sakura: BlueZ 5.72; no `AdvertisementMonitorManager1` (it needs bluetoothd's experimental flag), so listening is short active LE windows, which the six scan-response Govee models need anyway. A discovery session belongs to the D-Bus client that started it and ends when that client disconnects.

Q: `bluetoothctl` as a child per window (A), a small D-Bus client in the repo (B), or a pinned library (C)?
A: B. One long-lived client in the host daemon on the system bus: `SetDiscoveryFilter` (LE, duplicate data) and `StartDiscovery` for each window, `InterfacesAdded` and `PropertiesChanged` followed as structured values, and later `Device1.Connect`, `GattCharacteristic1.StartNotify` and `WriteValue` for devices that stay connected. No dependency. A daemon host with no BlueZ adapter or bus answers no radio, never an empty list (the Windows spawn point is PowerShell through WSL, not a second radio).

> We probably want our own client so we can also stay connected to the devices and continuously receive data right? Like how's the webcam going to work without our client?

The webcam is not Bluetooth: the Tapo camera is WiFi, its video an RTSP stream on the home network, a road of its own when Tapo comes.

## Question 23 - Which temperature unit does the owner see?

Q: Stored in Celsius and shown in the owner's unit (A), or Celsius everywhere with the assistant converting when asked (B)?
A: A. All data stays Celsius (readings, thresholds, literals in expressions), so a definition, a shared file and a computed field mean one thing. The owner picks the display unit once; the phone and the assistant's text use it. A value typed in Fahrenheit is converted on save and shown back in Fahrenheit. The conversion is declared once in the type table (a Celsius field may display as Fahrenheit) and generated into Kotlin.

Recommended because the plug is a US model and the phone's clock is Pacific, and one canonical unit keeps shared definitions and automations unambiguous.

> A

Decided alongside, open to the owner:
- **A crossing while the Gateway was down** fires once at boot, when the first fresh reading differs from the saved value; no change while down fires nothing.
- **The display unit** is an owner preference held with the assistant's settings on the home Gateway, answered to the phone with them and read by the assistant's text renderer.
- **Known-format models:** the H5110 definition lists the models govee-ble puts on its layout (H5100 to H5105, H5108, H5174, H5177, GV5179), with attribution. Those decode under the untested warning; a Govee device in no definition's model list shows raw bytes only.

## Question 24 - When does a phone listen for This Phone sensors?

Q: A filtered scan registered with Android that runs with the app closed (A), only while the app is open (B), or a constant scan in the app's foreground service (C)?
A: A. The phone registers a filtered low-power scan with Android (`BluetoothLeScanner.startScan` with a `PendingIntent`), filtered on the shipped families' markers (masked `ScanFilter`s from the generated recognition data), offloaded to the controller where it can be. Android wakes the app only when a paired address is heard; the app posts raw bytes coalesced (on change or every few minutes). Doze may delay delivery; the reading's age says so. No change to `SwitchboardService`'s foreground types. The "Nearby devices" permission (`BLUETOOTH_SCAN` with `neverForLocation`) is asked at the first scan, as a Features row like the other phone capabilities. Starts are throttled by Android (5 per 30 s), so re-registration happens only when the paired set changes.

Recommended as Android's own road for a sensor that broadcasts every few seconds: low battery cost, nothing new always on.

> A

## Question 25 - What happens to devices when the assistant's home moves?

"Home" is the Gateway the assistant runs on, the Router's placement record the owner sets from the app; not a network. A move carries the assistant's settings, watchers and integrations, never devices.

Q: Nothing moves, a known limit the Q16 follow-up removes (A), or This Phone devices and their automations travel with the carried home (B)?
A: A. Devices, computed fields and automations stay on their Gateway and keep working; the app shows them (Q16). Until the assistant can reach other Gateways, the device page names the Gateway that holds a device, and a tell-the-assistant action on a Gateway that is no longer home is refused with a reason in the run log, never lost silently.

Recommended: one home (Sakura), moves rare, and the cross-Gateway follow-up removes the cost for every device kind, not only This Phone ones.

> ok that's fine

## Question 26 - Where does the live console live, and who types into it?

Raised during the 2.6d walk, after inspection was done with ad-hoc scripts over the Gateway's state files.

> As part of the core plan, remember when I said I want it as good as NyaaDot? it has a live console that lets you debug easily. MCP tools that let you query and inspect with ease. We need this in core so you don't have to live in squalor.

Q: One engine on the Gateway with two doors, an MCP tool for sessions first and a phone Console page second (A); fixed MCP query tools with no language (B); or a phone-only console (C)?
A: A. NyaaDot's small expression language (lexer, recursive-descent parser, tree-walk evaluator) over a typed registry of what the Gateway holds, read-only to start. Door 1, an MCP `console` tool, ships first; door 2, a phone Console page with autocomplete and cards, second. Each Gateway answers for itself.

Recommended: one registry declared as data, as the field table is, serves the earlier ask (a schema's card in the app) and this one (agents inspecting without scripts); read-only adds no authority.

> A

> and the 2 doors are human console and agent MCP right?

Yes: the agent door is the MCP tool, the human door the app's Console page; both send the same expressions to the same engine.

## Question 27 - How far does the console language go in the first cut?

The first registry, from research: `devices.list`, `devices.get(id)`; `sensors.read`, `sensors.payloads`, `sensors.extremes` with readings in the owner's unit; `thresholds.of`; `fields.list`, `fields.state` (value, seq, transitions); `automations.list`, `automations.runs`, `automations.queue`; `watchers.list`, `watchers.rules`; `Definition.get` as a card, `Definition.decode(key, advert)`. Three read accessors are new (a sensor's readings and payloads off the road, `sensorThresholds.list`, an automation's checkpoint); the rest exist. The engine gets read seams only: no write seam, no vault, no tokens, keys or pane text.

Q: NyaaDot's read grammar without assignment (A); paths, calls and indexing only (B); or A plus filter lambdas (C)?
A: A. Paths, method calls, indexing, literals, `==` `!=` `!`, arithmetic, and list helpers (`count`, `first`, `take(n)`, `where(field, value)`). No assignment; variables arrive with the phone page. A tree-walk with step, node, source and answer caps, so one query cannot stall the Gateway's loop.

Recommended: parity with NyaaDot for reading, covers every read the 2.6d scripts did, and lambdas can be added later on the same base.

> A.

## Question 28 - Which sessions can use the agent door?

Q: Host sessions only (A); host and devcontainer sessions (B); or B plus the assistant (C)?
A: A, for now. Host sessions can already read the Gateway's state files, so the first cut adds no reach. The audience is a table keyed by entity (`satisfies Record<EntityId, readonly Audience[]>`), so containers or the assistant are a row each later. A container session and the assistant are answered `not_served`.

Recommended: zero new reach; the assistant's tool list is fixed on purpose and would need its own projection.

> A for now.

Decided without asking, with the reason: the agent door is a core tool bound by the session token, as the routine tools are, registered outside containers; a `SESSION_COMMANDS` tool cannot sit behind a capability without failing `check:boot`. The phone learns the vocabulary from a describe op cached per Gateway by a registry hash, never generated Kotlin, since each Gateway can run a different build and live ids cannot be generated.

## Question 29 - Does the console hear raw Bluetooth, beyond what definitions read?

Q: A read-only listen on the daemon for everything heard (A); keep `bluetoothctl` for unknown devices (B); or add it later (C)?
A: A, two minutes by default. `bluetooth.listen(seconds)` lists everything heard for the window: address, name, signal, raw maker data and services. A host op that writes nothing, unlike Scan, which updates plug addresses. Two minutes because the H5110 was heard about once a minute; the cap stays under the Gateway's 255-second idle cut.

Recommended: closes the last scripting gap of the 2.6d walk, and verifies a new definition.

> a. 30 is too short. you seen what happened with these sensors. do like 2 minutes.

## Question 30 - Which verbs name the console's members?

Raised on the Console page mockup, when the owner asked to agree on terminology and activities.

Q: `list` for all, `get(x)` for one record as stored, `read(x)` only for a live measurement, every name lowercase (A); keep today's names (B); or `get` everywhere (C)?
A: A. `thresholds.of` becomes `thresholds.get`; `Definition` becomes `definitions`, still listed as a catalogue.

Recommended: get versus read tells stored setup from a live reading, the distinction debugging turns on, and lowercase removes the one oddity.

> A it is. And get live value means value at the time? or living service that you need to .read from?

A value at the time: `read(x)` answers the reading as of the moment it runs, a copy, and running it again reads again. Nothing the console answers is a living handle; a refreshing card would rerun its expression.

## Question 31 - How does that rule land on each entity?

Q: Fetches are `list`, `get` and `read`, narrower views are nouns, computing verbs stay verbs, and the overlapping members merge (A); rename verbs only (B); or another mapping (C)?
A: A. `devices`: `list`, `get(device)`. `sensors`: `list`, `read(device)` (thresholds move out), `payloads(device)`, `extremes(device, key)`. `thresholds`: `list`, `get(device)`. `fields`: `list`, `get(id)` (record and invalid reason), `read(id)` (value or unknown reason, recent transitions). `automations`: `list`, `get(id)`, `read(id)` (checkpoint), `runs`, `queue`. `watchers`: `list`, `get(id)` (setup, rules, actions), `read(id)` (health), `test(id, fields)`. `bluetooth`: `listen(seconds)`. `definitions` (catalogue): `list`, `get(key)`, `match(advert)`, `decode(key, advert)`. `gateway` unchanged.

Recommended: each entity answers at most two questions, what was set up and what it is doing now, and the phone's completion lists shrink.

> A. Looks good.

## Question 32 - Do watchers and automations stay, or does a layered vocabulary replace them?

Today a watcher polls an outside source and routes each event to wake or inbox by its rules; an automation reacts to a computed field crossing and tells the assistant through a queue the Sensors watcher reads. Neither models a continuous feed such as a camera's video.

Q: Layered: sources (devices and services) produce values (fields) and events, automations turn events into actions (tell the assistant: wake or inbox, switch a device, notify the phone), feeds are streams a step can sample, and "watcher" retires (A); keep both words, sharper (B); or leave it for a later plan (C)?
A: A, and the watchers are rebuilt in this deployment rather than a later plan. Their configuration may be purged and re-entered through the new pages, which proves the pages.

Recommended: "automation" is the standard word for trigger plus action; "watcher" did two jobs (polling a service, routing into the inbox), the Sensors watcher was only the automations' outbox, and beside cameras the word reads as a camera.

> A it is. Feel free to purge my current watchers to over remote control and then rebuild them, as you do the update deployment. Then input my watchers manually yourself, proving the UX works.

The purge is permission, not a goal: stored configuration carries over where the format allows, and a clean break with re-entry is allowed only where it does not.

> ohh well the point of it was a clean break, if you needed to change the storage format. you don't need to purge them all if it cleanly updates

## Question 33 - What happens when several automations match one event?

Q: An ordered list per source, first match decides (A); every match fires, wake wins (B); or A for the assistant and B for other actions (C)?
A: B, in one form: every matching automation fires, with no order and no first match; an event that several automations wake about wakes once. The assistant action is "tell the assistant" with a `when` of now or quietly. A source that lists its own events (GitHub) needs no quiet automation, since its list is the inbox; a crossing or a timed reading has no list of its own, so quietly leaves it in the inbox. Exceptions that order used to express become an `is not` condition on the automation.

C was withdrawn: it keeps an ordered router for one action kind and a fan-out for the rest, which is two systems.

> I think C means 2 segregated systems? Maybe B.

## Question 34 - What is a threshold in the new system?

Q: One of three trigger kinds on an automation, an event arrives, a value crosses a line, a time comes (A); a separate sensor feature that emits events (B); or hardcoded as today with scheduled reads in Routines (C)?
A: A. A threshold becomes the value trigger, with its dead zone and cool-down; the sensor page's Alerts rows stay as a shortcut that writes such an automation. A time trigger covers "every hour, read the thermometer and pass it on": its action reads the value when it fires. Routines stay for starting a session on a schedule; whether a routine becomes an automation whose action starts a session is a later question.

> Will we still be able to do like, "Every hour, read the thermometer and pass it to blah"

## Question 35 - How are actions modelled?

Q: One catalogue of actions with typed parameters, shared by automations, the assistant and the console (A); hardcode each kind into automations (B); or automations only tell the assistant, which does the rest (C)?
A: A. An action is a catalogue row: its name, its parameters as typed fields, where it runs, whether it is dangerous. An automation holds a list of actions with parameter values, fixed or filled from the trigger. "Tell the assistant" is one action with a message and a `when`. Saving the automation is the consent; a dangerous action asks once at save.

Recommended: C puts a model in the loop for "turn on the plug at 2 C", which should be instant and never depend on the assistant being awake.

> A.

## Question 36 - How do values get into an action's text?

Raised by the owner: a thermometer's temperature told to the assistant would arrive as a bare "24.3".

Q: Text with holes, each hole an expression in the console's language (A); a `format()` function with every parameter a whole expression (B); or named placeholders picked from a list the trigger offers (C)?
A: A, with single braces. Any text parameter may hold `{expression}`; the trigger adds its own names (`value` and `device` for a crossing, `event.reason` for a GitHub event); a value prints as the app shows it, with its unit in the owner's unit; the editor previews the finished text. A literal brace is written `\{` or `\}`. Builtins (`round`, comparisons, `if`) are rows in the console's one builtin table, so the Console and automations gain them together, and a trigger's condition can be the same kind of expression answering yes or no.

Recommended: plain text stays plain, the Console's input with its completions is reused, and a read tested in the Console pastes into an automation.

> looks good. now would you simplify it to single instead of double? if they want it escapes, we build the language parser to recognize a /{{foo}\}

## Question 37 - Do runbooks take single braces too?

Q: Automations use single braces and runbooks stay on `{{name}}` (A); both go single, stored runbooks rewritten (B); or both accept either (C)?
A: A. A runbook body is a prompt and often carries code and JSON, where bare braces are everywhere. Runbooks follow when their machinery is upgraded.

> yeah Runbooks follow later. Finish up before we upgrade the runbook machinery.

Settled without asking, each with its reason, and told to the owner:

- **Console variables live on the phone** (recommended twice, then confirmed): snapshots sent with each read, capped. They belong to whoever evaluates: on the phone, to that console session, and they die with the app. An MCP call is one expression, so a variable there would live for one call; the agent's door keeps refusing `=` until a call can hold several statements.

> yeah variables are local to the thing that is evaluating it. So if I do it from phone, it's for me, for that consoles session. Killing the app will kill the vars. Same for you in MCP. bit I guess the session is literally just 1 call, so it's a short lifetime.
- **Event conditions keep today's picker** (field, `is` / `is not` / `contains`, value): built, pinned on both runtimes by `assistant-rules/vectors.json`, and easier on a phone than typing. Expression conditions arrive with the comparison builtins.
- **One vault holder for services**, GitHub and IFTTT alike, keyed by the service: the `watcher` holder rows are translated at restore, never dropped, since one unreadable row resets every grant.
- **The inbox stays a live listing** of every source plus what automations left quietly.
- **GitHub keeps the id `github`**, so a wake's member key is unchanged and nothing delivered wakes again.
- **Several instances per kind** (`plans/watcher-instances.md`) come after, rewritten on this vocabulary.

## Question 38 - Can one call hold several statements?

Raised when the owner learned the agent's tool took a single expression.

Q: Add several statements per call now, in 2.6f (A), or later with the automation holes (B)?
A: A, delimited by semicolons. `name = expression` saves for the rest of that call on either door; on the phone the value is also kept for the console session. Every statement that is not a save prints, in order. The limits (steps, answer size, one slow read) cover the whole call. A new line stays whitespace, so an expression still wraps.

Recommended: small while the grammar is open, and it gives the agent's door variables under the owner's rule, local to whoever evaluates and living for that call.

> sounds good. semicolon delimited language for multi statement commands

## Question 39 - Does an automation get a name the owner types?

Q: No name, the row written from the trigger (A), or an optional name shown instead of the sentence (B)?
A: A, as drawn. "GitHub: reason is review requested", "Outside thermometer temperature goes below 2.0 C".

Recommended: the row always says what the automation does and follows a rename of the device, one field fewer in the editor, and the thermometer alerts already read this way.

> And looks good. Lock it in and implement while the Lunas are out

## Question 40 - What does the menu icon open?

Raised by the owner while 2.7b was audited: the root menu and a session's menu are two lists behind one icon, the assistant's own menu is Chat and Terminal with everything else behind a gear, and Sources and Automations sit under the assistant's settings.

> the overall menu being split so weird. Or that everything we are doing is buried in under Assistant > Integration or adjacent or whatever.

Q: One menu, the same everywhere, with a session's Chat, Terminal and Files moved into its top bar and a pick made inside a session arriving filtered to it (A); one menu in two parts, "This session" above the full list (B); or keep both menus and only move Sources and Automations to the root list (C)?
A: A, firmed by Question 42. The list: Sessions, Assistant, Backlog; Sources, Automations, Routines, Runbooks; Vault, Policies, Console; Settings. The assistant's gear keeps Location, Features, Safety and Remove.

Recommended: a menu answers where to go and Chat, Terminal and Files answer how this session is shown; splitting them ends one icon opening two menus, and Sources and Automations are a Gateway's records as Runbooks, Routines and Policies are.

> maybe menu everywhere

Mocked in the Designer dock under "Menu arrangement". Its own phase, after 2.7b.

## Question 41 - Do Routines and Automations stay two lists?

Left open by Question 34. With one menu they sit side by side, and a time trigger lets both say "every day at 08:00".

Q: Two lists, told apart by what they make (A); one list, a routine becoming an automation whose action runs a runbook in a session (B); or two engines shown as one list (C)?
A: A. A routine starts a session on a schedule: an agent works, files a report, may hold secrets, and a missed run is tracked. An automation reacts at once. Revisit once the action catalogue exists, since starting a session could then be one more action.

Recommended: the two differ in what they leave behind, and B moves the routine engine's run history, missed-run recovery and granted secrets for a tidier menu.

> A

## Question 42 - When is the one menu built?

Q: Right after 2.7b ships and before 2.7c (A); after 2.7c and before the 2.7d walk-through (B); or after 2.7d as its own plan (C)?
A: A. It is phone-only, so 2.7c's pages are built into the arrangement that stays, and the walk-through happens in it.

Recommended: the smallest of the three pieces, it decides where every later page lives, and only the phone moves.

> interesting. A it is.

Taken with it, told to the owner and not objected to: Sources and Automations do not filter by session, since they are a Gateway's, and open whole with the session's Gateway group first.

## Question 45 - Do the sensor page's alerts stay a record of their own?

Raised by the owner over a screenshot of the Automations list, where the two alert rows sit greyed out.

Q: Question 34 made a threshold a trigger. Does the sensor page keep its own threshold record, projected into rows no one can edit in Automations?
A: No. The sensor page shows its readings and lists the automations that use it, each opening in the automation editor. Its Alerts section goes; there is one place to set a threshold. The separate threshold record, its projection and the sensor page's threshold call go, with a one-time conversion of the alerts a Gateway holds into plain automations. Taken as the last slice of 2.7c. Told to the owner and not objected to: a New beside that list opens the editor already set to "Value crosses" on that sensor.

> we agreed that this old threshold way of hardcoded is going right? in upgoming slices probably.

> I think the sensor page will just show all reading. And it will list automations using it. so you can jump to it quick. Should work hand in hand with automations, not be a parity

## Question 43 - What does Cancel do on an edit page?

The runbook, routine and policy editors drew a Cancel button beside Save that discarded the edit at once, while Back asks before discarding (the leave rule above) and the automation editor has no Cancel.

Q: Remove Cancel from those three so Back is the one way out and it asks, make Cancel ask too, or leave it?
A: Remove it. Back is the one way out of every editor, and it asks.

> A. yeah make editors all consistent and safe.

## Question 44 - What does a home move do when its automations do not fit under the cap?

A Gateway holds at most 64 automations (`AUTOMATIONS_MAX`), shared by the event automations a move carries and the crossings and clocks that stay on a Gateway.

Q: Refuse the move with the numbers and write nothing, move anyway and drop what does not fit, or count moved and local automations apart?
A: Refuse the move, as built.

> ohh we have a soft cap? Sure I guess.

## Question 46 - What does a list view say when one Gateway has none and another has not answered?

Raised by the red team on 2.7c's architecture step: the Routines, Runbooks, Policies and Automations views drew one whole-view "No routines" as soon as any Gateway answered with none, even while another in view was unread or unreachable.

Q: Only say "No routines" once every Gateway in view has answered, and otherwise name the ones still out?
A: Simpler. Each Gateway that answered keeps its own group and says "No routines" under its own name; no combined line. A Gateway that has not answered is not listed yet, as before, and the whole-view line stays for when none has answered.

> Let's just show each gateway as it does now and no routines under each. no need for a special renderer

## Question 47 - Does the vault approval card show over the app's own lock?

The vault's request card (`VaultPrompt`) is a system overlay drawn over whatever is in front, the app's own lock screen included. The card shows the session, the command and the entry's public title, and Deny works there; approving an entry still asks for the owner's presence, and a typed value is the owner's own act.

Q: Keep it, show a bare card until the app lock is passed, or draw no card while the app is locked?
A: Keep it as it is.

> A.

## Question 48 - How late may an automation's action still run?

An effect more than ten minutes after its trigger is refused unsent (`EFFECT_LATE_MS`), a number picked during the red team's fixes.

Q: Ten minutes as built, five like a clock's own grace, or no limit?
A: Neither fixed. The wait is set on the automation, ten minutes by default, and an automation gains a fallback: what to do when an action does not get done. The fallback's shape is asked next (Questions 49 on).

> Configurable on the automation. Default to 10 min of waiting. Fallback action as an escape hatch. Like:
> - turn on A
> - then turn on B
> - Oops B is not responding
> - Either configure it to do an action like turn off A & B, or configure it to trigger another automation like the whole off flow.

## Question 49 - Where does the fallback live?

Asked twice: first as one "If it fails" list per automation against a fallback per action, then, after the research, as "run another automation" against a list of its own actions.

Q: What does the fallback hang on, and what can it do?
A: The owner's own shape: each action has an optional failure branch that holds one or more actions, and "Run an automation" is an action, in a branch or in the main list. A branch is one level deep for now: an action in a failure branch has no branch of its own. Deeper nesting is wanted later.

> So with the whole language parsing system, we really have turned automations into a language right?
>
> I'm thinking Actions have an optional failure branch. You can slot in an action or more. An action could be an automation.

> For now, one level deep to kill the circular loops. But I do want that more real later.

Before it, on loops and an orchestrator:

> So triggering another automation is not something we had before. there exists the risk of circular triggers. Also makes us ask the question, wouldn't it be cool to also have a Action for the happy path to trigger an automation based on conditions anyways? Like an Orchastrator automation rather than a micromanaged automation.

## Question 51 - What can "Run an automation" point at?

Q: Any automation on the same Gateway (its own trigger and cool-down skipped, a switched-off one not run, and a helper made with a new When, "Only when another automation runs it"), helpers only, or any automation with off stopping only its own trigger?
A: Any automation on the same Gateway, off means off, and the new When for a helper. The limit proposed with it, that an event-triggered automation cannot be a target, is not accepted as stated: the owner wants the kinds of automation identified and reduced first.

> Sure, A.
> But lets talk about that.
> > GitHub-triggered automation cannot be a target
> Let's identity the different kinds of automations. And then reduce them.
>
> Some automations are sourced from us, and some external like GitHub. What does that mean for us?

## Question 52 - Which kinds of automation are there, and what does "outside" change?

Asked as: three families and a helper with one rule about texts and a guard for outside triggers; everything is a source; or the plain ban. The owner asked for the first to be thought through and for "trust" to be defined before answering.

> Think about answer A and refine more. then describe it in detail. what does trust even mean?

A: The first, as refined below, and the save asks once when an outside-triggered automation gains an action beyond telling the assistant. Once only: it does not ask again when the list of actions grows. Read as once per automation unless the owner says once ever.

> A. And just once. they probably realized what they are doing after the first notice

What was put to the owner and accepted:

- **Trust** is how much of what an automation does is decided by someone other than the owner: when it runs and how often, what words pass through it, and where those words end up. The clock is decided by nobody, a sensor by the room it sits in, an outside source by anyone who can make it notify the owner, with words they chose. "Outside" means someone else decides the first two.
- **Four ways to start,** each giving the actions only its names: Outside ("Event arrives": the event and its source), Ours ("Value crosses" with its sibling "value becomes": value, device, measure, threshold), Clock ("Time comes": the time), Called ("Only when another automation runs it": nothing). After the start every automation is the same list of actions with optional failure branches.
- **Run an automation:** the target runs as if its own trigger fired at that moment. Names readable at any moment still work (a sensor's value, the time); names that only exist when something arrives do not. So any automation can be a target unless one of its texts uses a name that would not exist, and the save points at that hole. It skips the target's trigger and cool-down and respects its off switch. The caller's words never pass to the target.
- **Rate:** an outside trigger gets the cool-down field the others have, zero by default.
- **Words:** a hole reading outside words inside something that leaves the machine is named at save.
- **Reach:** an outside-triggered automation that gains an action beyond telling the assistant (a plug, IFTTT, a run) asks once at save, listing what it would do, once and not again (the owner: "just once").
- A Run button on an automation follows from it: the owner as the caller.

## Question 53 - Do actions run in order, and what does a failure do to the rest?

Today the effects of one run are independent: a stuck one lets the next go ahead, and a failure stops nothing.

Q: Top to bottom with a failure branch as the new ending, top to bottom with the run always continuing, or as today?
A: Top to bottom, one at a time. An action waits for the one above it. An action that fails and has a failure branch runs the branch and the run stops there; one with no branch is logged and the run carries on.

> A.

## Question 54 - What does the wait measure, and what is a failure?

Asked as: one "Keep trying for" setting per automation with each action getting that long, one clock for the whole run, or a setting per action; with On and Off retried and a Toggle or an IFTTT post retried only while nothing was sent. The owner moved the retry rule to where the action is defined.

> let's think about the implications of this and assign the "wheres" it handled properly.
>
> - Actionable things like On, Off, Toggle, Turn to 87 degree rotation, Set temperature. Most things are idempotent and some are not. Perhaps that itself must define if it is retry able and what a failure is shaped as.
> - In all cases, failure to reach the devices should obviously count as a failure.
> - toggle for sure is not a retry able thing. Shaped by first point.

What was put back to the owner and accepted:

- An action declares its nature where it is defined (the device catalogue for a device's verbs, the action table for the rest), and the editor reads it:
  - **sets** a state (On, Off, set temperature, turn to 87 degrees): means the same whenever it lands, harmless to repeat, checkable by asking the device. Kept trying until it holds or time is up.
  - **sends** something out once (an IFTTT event): waits until it can be sent; once it has left, never again.
  - **nudges** from where it is now (Toggle, five degrees warmer): only meaningful now. One attempt, never resent, since a late toggle flips whatever state it then finds.
- One attempt answers one of four words, from the part that talks to the device: done, refused, unreachable (never got through), no answer (it left, nobody can say).
- The engine holds one table, nature against outcome, with no action names: sets retry while unreachable or no answer; sends retry while unreachable and are final once they left; nudges end on the first unreachable or no answer; refused ends any of them.
- How long to keep trying is the automation's setting (ten minutes by default). Not reaching the device is always a failure in the end; the nature only decides whether it is tried again first.
- The log and the map use the same four words.

A: The model below, with one "Keep trying for" setting on the automation, ten minutes by default, and each action given its own ten minutes.

> A.

## Question 55 - Where does a condition live?

Asked as an optional "Only if" on any action, only on "Run an automation", or a step that gates what is below it; then, after the owner asked what "only if" is, as an `if` on one action against a real block around several.

Q: What shape does the condition take?
A: It is called "If" and nothing else. It is a block of its own with a true side and a false side, each optional, and at least one of them filled. (Whether a condition that cannot be read runs neither side is asked next.)

> what's an only if? is it just an if block? if ( blah true )?

> just have it called if. Don't want to over complicate with an If and an Only If.
>
> should If block have an optional true and false component? meaning you must slot on at least 1 branch?

A side was first put as one level deep, like a failure branch. The owner reopened depth in Question 57. The condition is one expression in the console's language, read when the If's turn comes. `and(a, b)` and `or(a, b)` are added as builtins, since the language has no `&&` or `||`.

## Question 56 - What happens when an If's condition cannot be read?

Q: Neither side runs and it is logged as a failure with the list carrying on; treat it as false; or stop the run?
A: Neither side runs, logged as a failure, the list carries on. Taken as the default after four asks went unanswered while the owner settled depth and the script; the owner was told and may overrule it.

## Question 57 - How deep may blocks nest, and how do cards and script relate?

Q: One model with two views, cards only at any depth, or flat cards with every branch in script alone?
A: One model, two views, built in three steps: the tree model and engine with cards, script as a read-only view, script editing.

> A.
>
> What's the scripting language look like for the current language parser in the description blocks and such?

Shown to the owner in answer: the console's expression language as it stands (paths and calls, the comparison and arithmetic operators, literals, the list methods, `round` and `if`, `;` and a saved name) and a text's `{expression}` holes with each trigger's names. Corrected with it: the earlier sketches wrote `sensors.outside.temperature`, which is not the language. A reading today is `sensors.read("Outside").readings.where("key", "temperature").first().value`, too long for a condition typed on a phone, so a short read such as `sensors.value(device, key)` is added with this work.

> hmm. what if we DID allow them to do any level deep?
>
> You said 1 levels deep as a stopper for recursive automations. But this isn't about triggering in a cycle anymore. It's just a programming language of their design.
>
> Which raises the question, can the UX support what we want to do? or would you promote the experience from basic UX to the scripting language already there?
>
> Like the UX is only capable of basic levels of automation. but if you want more, you have to switch to power user mode, and you just get the automations converted to the scripting language. Adjust as you need from there.

What was put back to the owner:

- **Depth and loops are separate.** Nested blocks form a tree and always end. Only "Run an automation" can go in a circle, and that is refused at save and capped at run. The one-level limit protected nothing in the engine; it was about what a phone screen shows.
- **One model, two views.** The stored model is a tree with no depth limit, and the engine runs it. Cards draw a list, an If with its two sides and a failure branch, one level. Script shows any automation as text and is the only editor for one deeper than cards draw. No stored mode: Cards is offered whenever the automation fits it, Script always, and nothing is converted one way.
- **The language there today is read-only expressions:** no blocks, no statements, and a test proves it changes nothing. A condition uses it as it is. Script needs a statement layer above it (`if` and `else`, `on failure`, one statement per action kind from the action table), a parser and a printer on the Gateway, and keyword paint on the phone. The console stays read-only.
- **Build order put:** the tree model and engine with cards; script as a read-only view; script editing.

Asked: one model with two views in those steps (recommended); cards only, at any depth, a nested block opening as a page; or flat cards with every branch in script alone.

## Question 58 - How are actions written in script?

Q: As calls in the grammar that exists, as a word per action, or as calls plus an assignment for whatever sets a state?
A: As calls. The script continues NyaaDot's console language in spirit: the same style, everything declared by schema, and taken further than NyaaDot got.

> look at the scripting language on NyaaDot side. does it have more on the doing side?

> A.  I never did finish that one in NyaaDot either. But I would like you to continue it in spirit. Similar language style. Similar benefits of the schemaness of everything. But you will push it further.

Read from NyaaDot's console doc and evaluator: the same grammar family, with a doing side this console lacks. A method call may change things (`configs.set("key", "value")`), a property may be written (`player.gold = 100`, checked by its schema), each method declares `read_only` or counts as doing, and a line that does something runs in a transaction that rolls back on an error. It has no `if`, no blocks, no loops and no functions: a line is one assignment or one expression.

Put to the owner: write a script's actions as calls in the grammar that exists, one registered method per action kind from the action table (`devices.set("Desk lamp", "on")`, `assistant.tell("...")`, `ifttt.trigger(...)`, `automations.run("Heat on")`), each declaring its nature as NyaaDot declares `read_only`. Completions, hints and cards then cover actions with no new work, and the only new grammar is `if` and `else` and `on failure`. Not carried over: rollback, since a plug cannot be unswitched and the failure branch stands in its place; and doing from the Console page, since the agents' door reads the same registry and stays read-only by its test, so an action call is served to an automation's script alone.

Asked: calls (recommended); a word per action (`set "Desk lamp" on`); or calls plus an assignment for whatever sets a state (`devices.get("Desk lamp").on = true`).

## Question 59 - When an automation runs another, does it wait?

Q: Does it wait with a failure coming back, or start the other and move on?
A: It waits. Running things side by side would be a block of its own, later.

> Waits. unless we add some sort of Parallel block.
>
> is `on failure` a syntax you made? or a pseudo code just for illustration?

Under the answer, "failed" means anything in the called run failed, handled by its own branch or not; a target gone, switched off or edited while the caller waits is a failure too; and the caller is held for as long as the other runs.

Told with it, as a correction of the drafter's own detail and no question: "an automation may be run once per run" goes, since a reset at the start and the same automation again in a failure branch is a normal flow. The guard is that an automation cannot run itself, directly or through others, with a cap on how many one run may start.

## Question 60 - How is "if this fails" spelled in script? (open)

The owner asked whether `on failure` was real syntax. Answered: invented for the sketch, a proposal, nothing built; so was `when clock at 18:00`, and the audit advises keeping the trigger out of the script.

Asked as: `on failure { ... }` after a call (recommended, since it matches the cards one to one and borrows no meaning); `try { ... } catch { ... }` around one or more calls (misleading, since JavaScript carries on after a catch and a failure branch here ends the run; its one advantage, one branch for several actions, could come later as a group block under its own word); or a spelling of the owner's.

The owner's reply, which keeps the language open and asks for a slower pace:

> hmm. I kinda want it more traditional styled.
>
> if (cond) {
>   true part
> } else {
>   false part
> }
>
> which would make sense for NyaaDot and I think here too. You only have then and otherwise as a singular action. Can't we have multiple things happening back to back?
>
> what does the floating ` on failure ` modify? a scope? a automation specific call?
> Should we make it an event dot method? `.failure(...)` ?
>
> we aren't done with languages yet so don't run off too far too fast

Settled by it: an If is written `if (cond) { ... } else { ... }`, the condition in parentheses. Each side is a list of statements run top to bottom, as the tree already holds; the sketches had shown one statement per side. Still open: how a failure is written, now between a method on the call taking a block, a plain `if` over the call's result, and the floating words. The script phase, and with it the stored shape of a step, waits on the language.

## Question 61 - What goes first: installing what 2.7c built, or building flows? (open)

Asked as: install and walk what is built, then build flows (recommended); build flows in cards first and install together; or build everything, script and map included, then install. The reasons given: the app on the phone (8.14.82) strips a message from an automation on a toggle, so the newer app must be installed before a flow can be stored safely; what exists gets used and corrected before more sits on it; real use finds what an audit does not.

Told with it, as defaults the owner may change: an automation that triggers again while running waits its turn; Run pressed on a switched-off automation runs it once while a call still respects off; an edit in the middle of a run stops that run and the row says what did not run; a script writes a device by its name when unique and by its id otherwise; an If keeps the unit its condition was typed in.

## Question 50 - Where does the flow map live?

Q: A Map and List toggle at the top of Automations, its own menu entry, or only inside an automation's page?
A: The toggle on Automations. No replay of a whole day; a replay belongs to one automation and plays back its last run. Every styling choice must carry one meaning and feel like it.

> we don't need a replay day. Probably only replay automations really.
>
> A.
> And be sure observe how you choose colors,  solid/dotted/thick, and any other styling choice. Everything has a meaning. And the meaning should feel the vibes of the style.

The styling rules proposed to the owner, one meaning per channel (mocked as `automations-flow-map.html` in the Designer dock):

- Colour is how it ended: cool grey fine, amber held up, red not done, faint grey nothing there.
- Line pattern is whether it happened: solid ran, dashed still in progress (held or retried), sparse dots nothing flowing (off or never ran).
- Thickness is whether it wants the owner: thin normal, thick with a soft glow a failure.
- A diamond at a line's start is why it runs (only on failure); the line keeps its own colour and pattern.
- Shape is what it is: a dot is something outside (a source above, a device or the assistant below), a rounded pill is an automation.
- The primary colour is selection only. A pill on a line is the newest thing that happened on it, shown only where there is something to say.
- Motion is now: only something happening this moment moves (a waiting line, a replay pulse).
- Top to bottom is cause: when, the automation, what it acts on.

The reference screen (the owner's Current project) places sixteen fixed systems by hand and draws each line as one quadratic curve bowing away from the hub, with the pill at the curve's midpoint. Automations change, so this map lays out three rows from the Gateway's list instead; the curve, the trim to a node's edge, the arrowhead and the pill midpoint are plain geometry and carry over (`graph-scout-report.md` in the session scratchpad).

## Requested: a flow map over the automations

The owner sent a screenshot of an integrations map from another of their projects (systems as nodes, curved lines coloured by status with pill labels, a one-line summary, a replay, a legend, a Map and List toggle) and asked for the same kind of view here. A scout is reading how that screen is built; the shape for Switchboard is asked after it reports.

> Now ask a new teammate to fetch and pull on projects/current/ repo. And ask it to find the fancy UX that shows a web graph of integrations, the things they run, and all. It looks like this. I want a view of that over the automations list or something? good for diagnosing flow problems

## Design rulings, mocked in the Designer dock

- **Pair with** (a dialogue over the family's entry page after Scan): Found rows merged across every radio with signal bars from the strongest, untested rows marked "Not tested" (a known format) or "Not tested · raw only"; Paired rows below with their live value. The dialogue lists the Gateways that heard the device, strongest first, then This Phone last, each with a chip: "Assistant" (home, and This Phone) or "App only". Owner: "looks good".
- **The sensor page:** the name; brand, holding Gateway and the reading's age under it (a trouble line instead when stale); Readings, one row per declared field with value, unit and the 24-hour low and high with times; Alerts, one row per threshold with its value in the owner's unit and a switch, then the dead zone, with "Alerts go to the assistant's inbox"; Name with Rename. Remove device lives in the top-right menu, on every device page, the plug page included. Owner: "Move remove into the menu top right. most people aren't going to this page to remove."
- **An untested device:** Raw: the last distinct payloads, each with time and radio, bytes as hex with offsets under them, bytes that differ highlighted; Name. A known-format model shows the sensor page as any sensor. Owner: "looks good".
- **Integrations by Gateway:** one group per Gateway that offers devices; the home's group carries the "Assistant" chip, others carry none. Rows as in 2.5d (name, brand, a trouble line only when there is trouble); a plug keeps its switch, a sensor shows its main value, greyed when stale; a This Phone device sits in the home group with "This Phone" in its brand line. Services stay below. Owner: "remove the app only chip here."
- **Sources** (replaces Integrations and Watchers): per Gateway, Devices then Services, the temperature unit below. A service's row carries its health and inbox count.
- **A service source:** Enabled with its health line; Secret with Assign secret; Produces (the event and its fields); Inbox with its count; Commands; "N use this source", opening its automations. Rules leave this page. Owner: "4 uses this source is fine."
- **Automations:** one group per Gateway, each row the sentence written from its trigger, what it does, when it last ran or next runs, and the only on and off switch.
- **The automation editor:** When, with "Event arrives", "Value crosses", "Time comes" (owner: "Get rid of a/an for space"); an event takes a source and conditions; "Would have matched N of the last M" is a fold that opens to a list (owner: "make that a collapsible and when you open it, list of them instead of comma"); a crossing takes a value, a direction, a "Threshold" (owner: "Line > Threshold"), a dead zone and a cool-down. Do, a list of actions; "Tell the assistant" takes Now or Quietly and a "Message", words the assistant receives with the event, with its filled-in form in a box labelled "Preview"; a dangerous action says it asks once when saved. Owner: "kinda crowded, but I'll take it for now. figure out placement later."
- **Text with holes is a console surface.** Owner: "any system like this should fully support coloring like NyaaDot console. Full syntax highlight and cards to teach the user. That probably means we need to make the Message box switch to a full screen advanced editor when tapped, and a back arrow to get back here." The full-screen message editor: the text highlighted, its preview, a "Names here" card (the trigger's names with what they hold now, then the Console's entities), the parameter hint and completions above the keyboard. Its back arrow returns to the automation with the text kept.
- **Leaving an edit page.** Owner: "A back button on these types of edit pages should always prompt a Leave and discord changes dialogue with a Discard/Stay in case you double back by accedent". The dialogue reads "Leave and discard changes?" and "Changes have not been saved.", with Discard and Stay. It appears only when something changed. The rule covers every edit page; the existing editors are a board item outside this phase.
- **"Not tested" shows only where a device is added** (the Found rows and the Pair with dialogue), never on Integrations or a device page. Owner: "actually get rid of not tested from the devices view. that's going to get annoying. ot only needs to be on the device additscreen".

# Plan

## Phase 2.5 - Integrations

Owner, 01:50: "IFTTT should not be in Watchers. It should be a separate category next to watchers." and "lets make Switchboard handle local network IFTTT." The plugs are two Kasa HS103 (US). The IFTTT road costs credits per fire since IFTTT's credit pricing (the free plan's 1,000 a month would not cover a daily on and off), so the plugs are to be driven locally. Questionnaire in progress; the questions land under the questionnaire above as they are answered.

> I think I want to have a framework layer that is a smart device layer. Should promote configuring and calling against devices. And for specific models like Kasa, the ability to take it off the cloud and have it securely local. So Switchboard will be the controller of it.

Two facts told back: the local protocol can unbind the plug from its account and point its cloud server at nothing, so off the cloud is a Gateway act; the protocol is obfuscated, not authenticated, so securely local is a network segment only Sakura reaches.

### Spike

- Discovery from Sakura (python-kasa 0.11.0.1 in `~/.venvs/kasa`, outside the project): one plug answered, alias `Light`, HS103(US) hardware 3.0, firmware 1.0.3, at 192.168.1.151 on the same /24 as Sakura's `wlo1`, relay off, signal -44 dBm, cloud-connected, clock in PST. It speaks the plain local protocol on TCP 9999 with no credentials. Flickered on and off from Sakura; the owner saw it. The second plug was not plugged in.
- What the local protocol offers this hardware: state, on-since, signal, the status LED, the clock and zone, cloud state; switch, rename, LED, clock, reboot, countdown, weekly schedules stored on the plug, factory reset and WiFi provisioning. No energy metering on HS103.
- The on-device schedule means the owner's daily on and off can live in the plug, written once by Switchboard; Gateway routines stay for what a plug cannot hold.

### Research (three Luna angles)

- Protocol: JSON over TCP 9999 behind a four-byte length and an XOR autokey from 0xAB, the commands `get_sysinfo`, `set_relay_state`, `set_dev_alias`; about eighty lines of TypeScript. Discovery is a UDP broadcast on 9999 (legacy) and 20002 (newer). An HS103 on newer hardware or firmware can speak KLAP with the TP-Link login instead, and a firmware update through the Kasa app can move a plug there; this unit is legacy. The npm `tplink-smarthome-api` is Node-only with a 2023 release; `bun-kasa` is three commits under GPL. Neither is worth taking for two commands.
- Topology: the Gateway sits on two Docker bridge networks, reaches a LAN address by unicast TCP, and cannot broadcast. The host daemon runs on Sakura's own stack and already answers typed `HostOp` requests through `relayToHost` with a 20-second bound; a scan op is one more entry. The phone (target SDK 36) may use the local network without a runtime permission and could scan over WiFi. Host networking for the Gateway would drop the loopback-only bind of 20000 and both Docker networks: no.
- Settings: an Integrations peer page is an `assistantSections` row, an `AssistantPage` destination and the existing integration rows and grant sheet moved out of the Watchers page. A device list needs a Gateway store of `{ id, name, address, revision }` with runtime state kept apart from the record, console ops for add, rename and remove, and a device read separate from `assistant_state` so a slow plug cannot stall settings. The list belongs to one Gateway; it does not travel with the home.

### Plan

**The wire** (`src/shared/schemasDevices.ts`, codegen in the same commit):

- A device record: `id` (the MAC, normalized lower-case colon form), `name`, `kind` (`switch`), `driver` (`kasa`), `address`, `revision`. A live state apart from the record: `on`, `off`, `unknown` or `unreachable`, with the read time. A weekly schedule: rules of `{ id?, days, time, action, enabled }`, `time` as `HH:MM` in the plug's own clock zone, plus a module enable. A driver-settings map typed per driver; for Kasa: `led`, `clock` (read, with the zone), `cloud` (`bound` or `disconnected`).
- Console ops, each with its own answer schema in `VALUE_OP_KINDS` and `ownerOpRegistry`: `device_list` (records only, never a plug read), `device_read` (one device's live state and its schedule), `device_scan`, `device_add`, `device_rename`, `device_remove`, `device_set`, `device_schedule_put`, `device_setting_put`. Every record-backed write and the removal carry the revision read and answer the held record on refusal, as runbooks do; a repeat of a stored write at its base is a lost answer.
- A new unavailable reason `unreachable`. A plug that answers but rejects a command is `refused` with the plug's `err_code` in the reason, not `unreachable`. A command sent with no reply by the deadline answers `timeout` with a detail saying the outcome is unknown.

## Phase 2.5c - Acceptance and docs

- Both plugs plugged in and scanned, each MAC, hardware, firmware and protocol recorded; DHCP reservations set on the router. Light switched from the app and through the assistant; a weekly schedule written and read back; a plug moved to another address re-matched by a scan; the cloud disconnect run on Light with the owner confirming the Kasa app lost it, then the recovery text tried.
- `docs/assistant.md` (the device layer, the drivers, the actions and the instructions), `docs/architecture.md` (the host scan op), `docs/testing.md` (the loopback fake plug), AGENTS.md map lines.

### Acceptance (Gateway and phone on 8.14.26)

- ✅ Light scanned from the phone: HS103(US), hardware 3.0, firmware 1.0.3 Build 200804, legacy XOR on TCP 9999. Paired; its MAC is the record id in the Gateway's store.
- ✅ Light switched off and on from the Integrations page, each state confirmed on the plug by python-kasa.
- ✅ Light switched off and on by the assistant: `devices`, then `device_set` off and on by id, each answer typed.
- ✅ A daily 18:00 on rule saved from the device page, read back on the plug and on the page after a refresh, then deleted and the empty list read back.
- ✅ Docs: `docs/devices.md`, the scan op in `docs/architecture.md`, the fake plug in `docs/testing.md`, the map lines in AGENTS.md.
- ✅ On-Air Sign scanned and paired: HS103(US), hardware 3.0, firmware 1.0.3 Build 200804, legacy XOR on TCP 9999; live state matches the plug.
- Owner: DHCP reservations; Light moved to its reserved address and re-matched by a scan; the cloud disconnect on Light, confirmed lost in the Kasa app, then the recovery text tried.

**Rollout order,** reader first: the host daemon restarts with the scan op; the plugin updates and the assistant's MCP restarts on it, so its parser knows `unreachable` before any Gateway emits it; then the Gateway deploys, and only then the phone, since Phase 2.5b ships the device reader and sender in one APK and no older phone sends a device op. The Router needs nothing: a device op rides `gateway_value` sealed. Part 1 ships dormant: the listing shows `devices` and `device_set`, and `devices` answers an empty inventory until a plug is paired. No instructions release follows, since the listing carries the rules.

### Audit (six Luna angles, lap 1)

Folded in above: the rollout order, the operation context and the unknown-outcome timeout, the revision contract and address refresh, the separate `device_read`, the MAC check before every command, the Kasa schedule mapping and the clock and cloud settings, the typed target and the name rule for `device_set`, the read and act split, the authoritative `devices` and its instructions, the closed scan op and its failure states, the restore rules, the page lifecycle and the switch's pending states, the picker extraction and the plug's zone, the sandbox fake, the recovery text, the fake plug's cases and the gate lessons, and the dormant backend. Not taken: a KLAP driver, until a real plug needs one; scanning 20002, since the driver could not serve what it finds; an ACL on the plug's LAN side, which Question 10 settled.

## Phase 2.5d - The catalogue

The owner's UX critique of 2.5b on the Pixel, mocked in the Designer dock and settled there:

- Integrations is two sections, Devices then Services, each drawn only once it has a member, and an Add button in the bar. The loose Scan, "No plugs paired" and "Finds legacy Kasa plugs only" go.
- Add is a full page: a search field, then the catalogue in groups, Protocols, Services, Brands, in that order. Tapping an entry opens its page.
- An entry's page is decided by how it is discovered. A scan entry (Kasa) has Scan in the bar, a spinner while it runs, Found with Add per row, and Paired rows that open the device page. A service entry (IFTTT) is a form of what it needs, one secret from the vault; granting it adds the service, and the same page serves the added service with Remove.
- A device row is its name, the brand on the line under, and a trouble line below that only when there is trouble; the switch alone says the state. Tapping the row opens the device page.
- The device page: Power, Name with Rename, the plug's Schedule, then a section titled by the brand (status light, clock, cloud), then Remove device. The cloud disconnect and Remove device are red buttons behind a confirmation.
- The settings index line counts per type, trouble first: "2 plugs · 1 service".

### Progress

- Foundations cut in one pass: the catalogue, its codegen and gate, `offered`, the phone's rules and pages, the device page's brand section, counts per type, docs. All gates green. Pending: the Luna audit, the commit, and the Pixel walk when the owner is back (no phone pushes tonight).
- The owner chose a `device` tool over device actions: the console op table offered or withheld, its union the console's own request objects, answers through the assistant schemas, a danger put held on the owner's card and fenced on the surface. `phone/devices` and `phone/device_set` retired; `ifttt_trigger` lists as `gateway/`. Audited (Sonnet; Luna rate-limited): the transport-text address leak, the surface fence, the card's consent words and the older-Gateway 400 fixed. Pending: Gateway and daemon restart, assistant plugin update and restart, a live call.

The structure, from the NyaaDot and evie-bot reads: declare each integration once in TS (`src/shared/schemasIntegrations.ts`: group, label, blurb, discovery, needs, yields, capabilities, acts with a tier), generate the phone's `IntegrationRegistry.kt` from it as Kotlin enums and a list, so a group, a discovery mode, a need kind or a capability the phone cannot draw fails to compile. The Gateway answers the catalogue ids it serves (`offered` on the assistant state), so an older Gateway hides an entry rather than showing a dead page. Per-capability sections stay hand-written, one `when` branch each over the generated enum. A generic schema-to-form renderer is deferred until a provider arrives with a real settings surface. Device drivers and service ids derive from the catalogue, not from hand lists.

## Phase 2.6 - Bluetooth sensors, on the field and expression core

Owner's new gadgets, 2026-11-13: a Govee H5110 thermometer with its H5151 WiFi hub, a Tapo P105 plug, a Tapo camera (`Tapo_Cam_D5AB`). Questions 14 to 25 and the design rulings above settle it.

**Rollout, reader first:** the phones (Unknown decoding); the Gateways with tolerant device restore (the rollback floor); the plugin and the assistant's restart; the host daemon; the Gateways that emit new values; then the phone UI that sends new ops. Sensor writes stay off until the rollback floor runs on every Gateway.

### Audit, lap 1 (eight Luna angles, Opus synthesis)

Folded in above: tell-the-assistant through a durable sensors queue and watcher instead of a direct `deliverEvent` (which refuses on busy, full or migrating and would drop the alert, and would skip the rules, the dedupe and the inbox listing); a tolerant restore released first as the rollback floor (`PersistedDeviceRecordSchema` is a strict object, and a failed restore starts the store empty); Unknown decoding as a generated content-based serializer, with device kind, driver and address already open strings; the kind-gated road (`DeviceDriver` demands set, schedule and settings; the read result demands state and schedule; `device_add` always runs a Kasa identify); the watch frame, the advertisement frame and the reading write named; background scan filters on paired addresses, since family markers alone wake for every Govee nearby; the Fahrenheit round trip; number literals in codegen; the sandbox, the plug page's holding Gateway and the wider acceptance; 2.6a and 2.6b sliced; duplicate pairing as best effort; shipped examples passing the import rules. Dropped: sensor events taking the owner's send authority (the existing event policy), a trust policy for spoofable readings (nothing actuates in 2.6), danger tiers at fire time (Later), and wording nits.

### Audit, lap 2 (seven Luna angles on the changed parts, Opus synthesis)

Folded in above: the sensor read as a new discriminator and Bluetooth candidates in a new optional field, so a 2.6a phone decodes both (`ConsoleDeviceReadResult.Ok` requires state and schedule; `DeviceCandidate` requires the Kasa fields); `DeviceAddressSchema` widened to a MAC by kind (it refines on `isIpv4Literal`); `radio: gateway | phones` on the record, steering the watch frame and the phone's posts; the sensors queue's caps, clear, strictly increasing `at` and lane poke; unread rows inside the device store's invariants; forward-unknown bodies held unread in the owner-record store and the queue; Unknown roots named with fail-closed arms and per-runtime fixture expectations; `ingest` off the per-device FIFO with the residue fence and the current-socket check; definition binding moved to the slice that brings definitions; slice 4 split with one adapter coordinator and `no_radio` reader first; the 24-hour buckets; the receiver's pass lock. Dropped: a durable phone outbox and an at-most-once retry contract (a reading is newest-capture state and the sensor re-wakes the receiver within seconds; a repeated post changes nothing), one daemon serving several Gateways (each Gateway is its own machine with its own daemon), Unknown on every root at once, and items already in the plan or enforced by existing gates.

### Later, named

- The visual builder (rows with typed holes, previews) and its node kinds; device and IFTTT actions with the save-time tier refusal and a Gateway fire cap; widgets.
- The live console, from NyaaDot: an expression language over a typed registry, a schema typed by name showing its card.
- The assistant reaching other Gateways (Q16's follow-up B), which also makes a home move cost nothing.
- Tapo: a KLAP driver for the P105, the camera's RTSP road, and the Kasa section moving onto the field schema with a second brand.
- Sharing definitions (export, import, the repo as the communal catalogue), and the selector for multiplexed broadcasts.

### Facts found

- Sakura has an Intel AX211 (Bluetooth 5.3, `hci0`, central and peripheral), driven by BlueZ; the user's `bluetoothctl` scans without root. The Gateway in Docker sees no radio, so a Gateway's Bluetooth is its host daemon's.
- The H5110 broadcasts as `GVH5110_3C5D`, manufacturer key `0x0001`, bytes `01 01 03 ba c8 64`: bytes 2 to 4 as one 24-bit value, temperature its thousands over ten (24.4 C), humidity its remainder over ten (42.4%), byte 5 the battery (100%). No pairing and no hub needed. Home Assistant's `govee_ble` lists the model.
- The device layer is switch-only today: one kind, one driver, an IPv4 address, a driver contract of set, schedule and settings. The catalogue declares a `listen` discovery mode nothing uses yet.
- The Tapo plug and camera are not Bluetooth: KLAP over WiFi, and the camera's setup needs the Tapo app. Out of this phase.

## Phase 2.6a - The core ✅

No owner feature; everything later stands on it. Slices, each green on its own:

1. **Unknown decoding.** Codegen emits, per named sealed root, a content-based serializer that references its subclasses directly and decodes an unrecognized discriminator to `Unknown(kind, raw)`. Roots now: `AssistantFieldSpec` and `ConsoleDeviceReadResult`; expression nodes and automation actions get it as they arrive. Codegen holds one decode policy per sealed root (`strict` or `preserve`), refuses a discriminated root with none, and refuses a `preserve` root without its future-kind fixture. Each exhaustive `when` over them (`AssistantFieldSpec.field` and `.label` in `RuleDraft.kt`, the read-result matches in `DeviceSlots.kt`) gains a fail-closed `Unknown` arm in the same commit as the regenerated `Protocol.kt`. The protocol fixture manifest gains per-runtime expectations (`expect: { ts: fail, kotlin: unknown }`), and a future-kind fixture of each root is replayed by both runtimes. Device kind, driver and address are open strings in `Protocol.kt` and stay so; the Gateway's own validation is widened in 2.6b. Ships on both phones first.
2. **The field table (Q18).** Wire words `enumeration`, `text`, `number`, `bytes`. The table's data (words, tests and labels, unit factors) is generated, with its own number literal formatter, into `Protocol.kt`, so `kotlin-gate.sh` diffs it; it replaces `RuleDraft.kt`'s hand mirrors. Number, Bytes and Unknown have no rule tests, and `parseRuleForFields` refuses them. Parse, fit and format are twinned and pinned by vectors: the longhand number grammar, the display conversion, and the Fahrenheit round trip. A converted value is stored at the precision that round-trips (0.01 C), while readings round to their declared decimals. `parseFieldValue` and the one text renderer (`formatFieldValue`) on the Gateway, twinned on the phone (`FieldRules.kt`). The phone's per-type field widget, its reading row, the value-in issue-out edit seam and the owner's display unit (Q23: held with the assistant's settings, carried with the home, set by a console op) land in 2.6c with the first page that draws them.
3. **The owner-record store.** One store for the new records (computed fields, automations, owner definitions later): phone-minted id, Gateway-named revision, buried ids, invalid on read, `commitChecked`, `onChanged` after the write. Each record parses an envelope (`id`, `revision`, `incarnation`, kind) strictly and holds a body this build cannot parse unread, written back untouched, as `SessionStore` does, so a later node kind or action needs no second rollback floor. The existing rules, runbook, policy and device stores move onto it only where their contracts already match; none is forced over in this phase.
4. **Computed fields (Q19, Q21).** The order-only node table (field, literal, compare, all, any, not, choose, band, take, arithmetic, unknown), the checker, the evaluator (BigInt integers, results past 2^53 unknown, truncation toward zero, declared decimals, unknown never thrown), known and unknown values, the durable field state, one evaluator lane per Gateway. One input port answers a field's declaration and value together, and a known value off its declared type reads unknown (`conforms`). Each pass resolves one snapshot of types, order and validity that every read uses. A field's state holds a basis hash (expression plus input types), an `epoch` minted per fresh baseline, `seq`, and its last 16 transitions (previous, value, at), written in the same commit; an expression edit or an input declaration change starts a new epoch without telling. The first known value is a baseline. `start()` runs the first pass once listeners are wired, and `onCommit` wakes them after every landed write.
5. **Automations and the sensors watcher (Q17, Q19).** The record (with `coolDownSec` bounded in the schema), the edge engine (fire on change only; baseline on create, edit, re-enable, placement and a definition version change; a crossing during downtime fires once at boot), the bounded run log (ran, refused, uncertain, suppressed). The engine is one function, `drain()`, the only reader of field transitions: woken by the field commit, at construction, after a put, a remove and a clear. A checkpoint per automation names the record revision, the field epoch and `handledSeq`; a revision change baselines at the current `seq`, an epoch change at that epoch's seq 0. It walks the stored transitions above `handledSeq` in order, a crossing being `value === becomes && previous !== becomes`; transitions lost past the ring log one `uncertain` run. Cool-down reads the transition's own time. An invalid automation never fires. A baseline whose write failed is held in memory for the next drain; a drain whose write failed retries on the next put, clear or field commit. The one action, tell the assistant, appends an event to a durable sensors queue in the same `commitChecked` as `handledSeq`, which is the at-most-once commit. The queue holds at most N events and B bytes; at the cap the action logs `refused` once, the checkpoint holds that transition (`blockedSeq`), and a later clear fires it. Entries leave by the watcher's clear; the inbox read mark never deletes. An event's `at` is its append time, strictly increasing (`max(now, last + 1)`), since the lane's freshness test is `event.at > newest`. A landed append pokes the lane (`SourceLanes.poke`), and the scheduled poll is a slow fallback, since every poll writes watcher state. Queue events hold an unreadable body unread, as owner records do. One sensors watcher (text `fieldSpecs`: automation, field, value, since the set of automations is the owner's and changes; text takes `is`, `is_not` and `contains`) lists that queue, so the source lane brings the owner's rules, the busy retry, the inbox listing and the event dedupe (`memberKey` `automation:<id>:<incarnation>:<epoch>:<seq>`, the field epoch keeping two crossings apart across an edit). Re-enabling the watcher or a placement wakes no backlog, as `setWatcherEnabled` already rules; queued events stay listable. Missing field state baselines without firing. On a Gateway that is not home, the action logs `refused` with the reason (Q25).

### Bug Classes

- **The automation edge engine (`onFieldChange` and the field state's `seq`):** a crossing lost or invented when the field's count and an automation's `handledSeq` drift apart. Round 1 (align): an expression edit reset the count and the next real crossing was taken as the baseline; a crossing at boot reached no automation because the first evaluation ran in the constructor. Round 2 (align): a lost or invalid-then-valid field state restarted the count under the same identity, so crossings were skipped until the count passed the old checkpoint; a first known value after unknown fired with nothing to compare. Round 3 (red team): a crossing refused by a full queue or cut by a crash between the two writes was never retried. Patches: an `epoch` minted per fresh baseline, `start()`, the first known value as baseline, and `reconcile()` at construction and after a clear. Round 4 (architecture) found the inference also lost a refused crossing once a later change moved past it, and replaced it: the field state stores its transitions, and one `drain()` reads them in order behind a checkpoint keyed by record revision and field epoch. Round 5 (red team on the redesign) found three edges of the same mechanism, each patched in place: event ids reused across epochs (the epoch joins the id), an upstream computed field's type change not reaching a dependent's basis (computed reference types join the basis hash), and a baseline whose write failed being retaken later (held in memory until it lands).

## Phase 2.6b - Bluetooth on the Gateway ✅

2.6a's computed fields, automations and sensors watcher ship as modules with their tests; slice 5 composes them into the Gateway with the first readings (the sensors watcher joins the lanes and the watcher list then, and a clear action reaches the assistant). The order is fixed: read the home, build computed fields, build automations (which replays any sequence left unhandled, so it must see the home), then `fields.start()`; `typesChanged()` runs when a device or definition changes an input's declaration.

Slices:

1. ✅ **Tolerant device restore,** released alone, one deploy before any Gateway can write a sensor. A row this build cannot read is held as raw plus a parsed `{ id, revision }` envelope: it reserves its id against records and tombstones, counts toward `DEVICE_MAX_RECORDS`, obeys the revision checks, is carried through every commit, stays out of `list` and `get`, and refuses edits. A row whose envelope is corrupt fails the restore as today. This release is the rollback floor; no Gateway older than it is a rollback target once a sensor is written.
2. ✅ **The kind-gated road.** The driver contract split by kind (a sensor has read and record-only rename, no set, schedule or settings). `DeviceAddressSchema` accepts an IPv4 literal or a lower-case colon MAC, checked by kind (a `switch` takes IPv4, a `sensor` a MAC), with a Gateway add vector for each. The record carries `radio: gateway | phones` (which radio listens for it). A sensor read answers a new discriminator, `sensor` (readings, age, stale or unknown reason, 24-hour low and high), so `ok` keeps its shape and a 2.6a phone decodes it as Unknown; it flows through the assistant result, `assistantShape` and `deviceText`. Bluetooth scan candidates (radio, signal, raw input) ride a new optional field on the scan answer's `ok`, never inside `candidates`, which old phones parse strictly; `refreshAddress` stays Kasa only. An optional per-Gateway capability on `device_list`. A sensor-aware device tool description inside its 1024 characters.
3. ✅ **Matchers and definitions (Q20, Q21).** Per-transport matchers in the catalogue: Bluetooth markers, the home network's discovery answer and address prefix, the setup network's name prefix; the `govee` family with its markers and light exclusions (as built: the EC88 service and the maker-data markers; the probe service ids and the `INTELLI_ROCKS_HW` iBeacon wait for a model that needs them, and the home-network matcher waits for a second network brand, since Kasa's scan is its own host op), generated into Kotlin with recognition vectors both runtimes replay. The definition format and its loader; `govee-h5110` shipped with its model list and its examples (payload frames only, synthetic readings, govee-ble's vectors with attribution), passing the same import rules an owner file would. `device_add` for a sensor carries its definition binding and is checked against the scan match, with no Kasa identify. Pairing instantiates the definition's reading template per device as derived fields (`device:<mac>/<readingKey>`), never stored in the owner-record store; a definition version bump re-baselines.
4. ✅ **The host daemon's D-Bus client (Q22),** behind an injected transport so the harness drives a fake bus. Two slices:
   - **4a:** ✅ the system bus transport (EXTERNAL auth over the unix socket) and one adapter coordinator that unions the discovery filters, joins a foreground scan into the current window, and calls `StopDiscovery` only when the last user releases it. Bounded active LE windows, well under the 20 s host op bound, buffers capped; a closed scan op answering candidates with signal. `no_radio` when the daemon host has no BlueZ adapter or bus, added to `DEVICE_REFUSAL_CODES`, `scan.ts` and the phone's `DeviceOps.refusalLine` reader first.
   - **4b:** ✅ a bounded `device_watch` replacement-set frame of the `radio: gateway` records, pushed on register and on change and reapplied after a bus reconnect (the `presence_watch` pattern). A strict advertisement frame whose `websocket.ts` handler checks the frame came from the current host socket (`host.readLiveness().socket`) before ingesting. Advertisements are lossy observations, never replayed; a later window refreshes state and age. The listen cadence sets the stale threshold.
5. ✅ **Readings and thresholds.** The road gains `ingest(deviceId, reading)`: coalesced per device, newest capture wins, no lease, never in the per-device FIFO, persisted best effort on the tick; `device_read` stays on the normal road. The advertisement handler and the phone's post (a signed value op in `VALUE_OP_KINDS` with `DEVICE_TOOL_OFFERS: false`, Q15) both go through `ingest`, and the road residue fence extends to both handlers. The last distinct payloads per device in memory; the stale reason. The 24-hour low and high: per device and measure, 24 hourly buckets of `{ min, minAt, max, maxAt }`, persisted with the last reading on the tick and pruned by age, folded into the read. Thresholds as one durable record per measure (`sensor-thresholds` store, its own revision), edited through one owner act, `sensor_threshold_put`; the band field and an automation per side are derived from it (a fixed template's ids), re-derived at start and retried on the tick, with the stored thresholds on a sensor's read. The host's radio is remembered from its last Bluetooth scan: `bluetooth` on `device_list` and the scan answer, and a `gateway`-radio sensor add on a host without one refused `no_radio`.

### Bug Classes

- **The BlueZ coordinator's lifecycle (`createBluezCoordinator` in `bluez.ts`):** connection, adapter and discovery state held in separate flags (`initPromise`, `adapterPath`, `started`, `users`, the client and its generation), each reset on its own path, so a failure on one path left another flag wrong. Round 1 (red team): a failed setup or a dropped connection was never retried, an evicted device lost its address, a late `StartDiscovery` reply or a failed `StopDiscovery` wedged discovery, close-together watch frames leaked a hold, a `bluetoothd` restart was never noticed, and one bad message closed the connection. Round 2 (red team): the reconnect backoff reset before the new link proved stable. Round 3 (architecture): a stale stable timer still reset the backoff in a `bluetoothd` crash loop, a timed-out `StopDiscovery` left discovery assumed on, and the watch retried every second outside the coordinator's backoff. Resolved by design: desired holds plus one epoch-scoped link (`down`, `up` with `discovery: off | on | unknown`, `closed`), one `reconcile` loop as the only BlueZ caller, events that only edit state, one retry timer, a failure count reset only by a stable timer of the current epoch, and a watch that keeps one hold and updates it. Round 4 (red team after the redesign): a signal landing in the same read as the `GetManagedObjects` reply reached `handleSignal` before `connect` published the link and was dropped, so a power-on at boot left the hold inert; signals are now buffered while a connect is in flight and replayed once the link is up.

## Phase 2.6c - The phone ✅

- **Integrations by Gateway (Q16):** fanned out over the roster (`state.gateways.ids()`), each group from its Gateway's capability; pages unwind when the roster drops their Gateway, not when it is not home; a declined Gateway draws no group. A duplicate pairing across Gateways is refused best effort from the roster-wide lists; one that slips through shows in both groups.
- **Scan and Pair with (Q14):** every Gateway's scan and the phone's own foreground scan (family markers), merged by address; the dialogue as mocked.
- **The phone's radio (Q24):** `BLUETOOTH_SCAN` with `neverForLocation` in the manifest, wired through `manifestPermissionOf`, `needLabel` and the Features row as a local setting, not a `PhoneCapability`. The background `PendingIntent` scan filters on the addresses of `radio: phones` records within the family markers, so it wakes only for those devices; each address is bound to the `gatewayId` whose list named it, and the phone posts there, never to the current home. Registration is reconciled at start, when the paired set changes and when the roster changes. A non-exported receiver acquires the timed pass lock under its own `PassOwner` and revives the service before returning, as `PollAlarmReceiver` does, then hands off to a process-owned coalescer that posts under a handled scope (the coroutine and cancellation residue rules). No outbox: a reading lost to process death is replaced at the next wake.
- **The field widget and the display unit (Q23, moved from 2.6a):** the per-type field widget and reading row over `FieldRules.kt`, the value-in issue-out edit seam for threshold rows, and the owner's display unit held with the assistant's settings (the Safety store's pattern), carried with the home behind a dated optional field, set by a console op and answered in the assistant state.
- **Pages as mocked:** the sensor page, the untested raw view, Remove device in the top-right menu on every device page, and the holding Gateway named on every device page, the plug page included (Q25).
- **The sandbox:** `SandboxDeviceGateway` gains sensor records, readings and the post, varied per seeded Gateway.

As built, beyond the list above:
- **Gateway additions the pages needed:** the sensor read carries `payloads` (the held distinct payloads, each with the radio that heard it; a sensor with no definition holds them too), `model` (the definition's first model) and per reading `alerts` (the sides a definition offers; `sensor_threshold_put` refuses any other). The owner's `temperatureUnit` is a console op, `assistant_temperature_unit`, stored with the assistant's settings, carried with the home (required starting 2026-11-27) and used by the assistant's device text. `offered` now includes `listen` families.
- **The shipped definitions' matchers are generated into Kotlin** (`DeviceDefinitions.kt`), with `DefinitionMatch.kt` as the twin of `matches`, pinned by `tests/fixtures/definition-match/vectors.json`, so the phone tells tested from raw only.
- **Alert rows read "<Reading> above" and "<Reading> below"** rather than the mockup's "Too warm" and "Too cold", one dead zone per measure, and the temperature unit sits on the Integrations page as a °C/°F choice.
- **The per-device map is `HeldDevice`** (it was `Plug`), since it now holds sensors.
- **Deferred:** the "Not tested" known-format tier (Q23's model list) needs model-aware matching the definition format does not have yet, so a family member no definition identifies is raw only; and the raw view shows the first maker key of each payload, which is the only one a Govee sends.
- **A definition binds only to a named advert at pairing** (`identifies`), so a nameless H5106 cannot pair as an H5110; ingest still matches a paired device's nameless adverts by its address.

### Bug Classes

- **The phone radio's lifecycle state (`BleReadings`, `rewatch`, `bleWatching`, `BleScanReceiver`):** who holds the radio pass, whether the background scan is registered, and which bindings are current lived in separate places (the receiver, the coalescer, the repository's flags, a collector over a roster that starts empty), each changed on its own path. Round 1 (alignment): the receiver's release ran when a coalesced batch posted nothing, dropping the pass under another batch's post; patched with an in-flight count. Round 2 (red team): a stale idle could still release a newer receiver's pass, a cold start's empty roster wiped the saved bindings and stopped the scan, a Bluetooth toggle or a permission granted in Settings left `bleWatching` true with no scan, a failed post blocked reposting for five minutes. Patched: the coalescer takes and drops the pass under its own lock, bindings wait for a loaded roster, `rewatch(force)` on Bluetooth on, on resume and after a scan, an error intent clears `bleWatching`, a failed post rolls back its mark. Round 3 (architecture): a scan error still never re-registered, and two `rewatch` calls racing could persist an old map. Resolved by design: `PhoneRadio` owns the wanted bindings and the registered set, one consumer applies every event (roster, Bluetooth on or off, scan error, resume, scan), `watch` runs only when they differ or registration is unknown, with one retry timer; screens send events and cannot reach `watch`. Round 4 (red team after the redesign): the owner reconciled correctly but had no rate control, so a scan error intent re-registered at once and could loop, and a refused start retried on every resume. Patched in the owner: one start per `START_GAP_MS` (Android's five per 30 seconds), and while a retry is pending only a changed address set starts the radio. The design held.

## Phase 2.6d - Acceptance and docs

- The H5110 paired to Sakura, then re-paired to This Phone: readings, the 24-hour low and high, the stale reason with the phone away; delivery with the app closed; duplicate advertisements coalescing into one post; the scan registration surviving a phone restart; two radios hearing one device, deduped, the chooser ordered by signal with This Phone last; Nearby devices granted and denied; a threshold typed in Fahrenheit shown back unchanged; a crossing reaching the assistant's inbox once, and an edit that does not fire; a 24-hour low ageing out of the window; a home move after which phones still post to the Gateway holding the record; the battery pulled and the address re-matched.
- ✅ `docs/devices.md` (sensors, definitions, the matchers), `docs/assistant.md` (computed fields, automations, the sensors watcher), `docs/architecture.md` (the Bluetooth host op, the watch frame, the client), `docs/testing.md` (the fakes), the AGENTS.md map lines.

Walk so far: pairing on Sakura and as This Phone, live readings, the background scan surviving a swipe and matching with the screen off, and a crossing reaching the assistant's inbox once (both alerts, 14:35 and 14:37) pass. Fixed on the way: empty Gateway groups hidden, the H5151 hub listed as Not supported and refused at pairing, signal bars per radio, Start scan listening continuously in first-heard order, a live pair card under the Found row, This Phone sensors stale at 30 minutes, alert text naming the device and unit and following a rename, the assistant's sensor rows carrying `heardAt` and `stale` instead of a placeholder state.

## Phase 2.6e - The live console, agent door (Q26 to Q29) ✅

One engine on the Gateway, read-only, NyaaDot's read grammar over a typed registry. The tool is named `console`; the code lives under `liveConsole` beside the phone's existing `console` ops, so the names never collide.

Slices:

1. **The engine.** The grammar in `src/shared/live-console-grammar.ts`, pure, so the phone's tokenizer twin can be pinned by vectors later: identifiers, numbers, strings with a `closed` flag, `. ( ) [ ] { } , :`, `== != !`, `+ - * /`; a `-` is unary or binary by position, never inside a number token. Expressions only, `=` refused; every node carries a span, and an open call, index, member, list, dict or string carries `closed: false`. The evaluator in `src/gateway/liveConsole/`: a fresh instance per call over the registry and one builtin table (`count`, `first`, `take`, `skip`, `keys`, `where(field, value)`); no reflective calls; one error shape `{ code, start, end, message }`. Caps: source length, node count, steps and answer bytes, read from `Ambient` for time. Registry entries declare their members with Zod schemas as data, and a handler only reads: purity is a registration rule, not an AST walk. Values come back as projections or frozen copies, never live store objects.
2. **The registry and the stage.** `composeLiveConsole` after devices, computed fields and the assistant, taking late-bound readers as `composeBaseline` does. First entries: `devices`, `sensors` (`list`, `read`, `payloads`, `extremes`, readings' `value` and `shown` in the owner's unit), `thresholds`, `fields` (`list`, `get`, `value`, `state`, `invalid`), `automations` (`list`, `runs`, `invalid`, `queue`, `checkpoint`), `watchers` (`list`, `get` as an explicit view without its setup text or vault entry ids, `rules` as a list with the catch-all last, `test`), `bluetooth` (`listen`, host sessions only), `Definition` (`all`, `get`, `match`, `decode`), `gateway` (`id`, `version`, `router`, `temperatureUnit`). Four new read accessors: a sensor's answer off the road (`DeviceStage.sensorRead`, the same body `device_read` answers, so `device-road-residue` passes), `sensorThresholds.list`, an automation's `checkpoint`, and its `queued` events. The readers are `Pick`ed to the methods read. A member marked `slow` (the listen) runs once per expression. The stage test reads every registered member over real device, field, automation and threshold stores and asserts no byte, device snapshot or host op moved; the watcher grant read became a non-sweeping `standing()`, since the sweeping one wrote the vault file. Never readable: vault values and private text, session credentials and raw `SessionRecord`s, `HOST_WS_TOKEN`, keys and enrollment material, watcher credentials, the inbox page-token key, the assistant home's sealed parts, pane text and other sessions' prompts. Never registered because they look like reads and are not: Scan (writes addresses), `inbox.list("new")` (moves the mark), live GitHub fetches, a plug's network read.
3. **The agent door.** `SESSION_COMMANDS.console` (`/console/eval`, `{ expr?, limit? }`), auth through `resolveConfirmedManagedSession`, answering `ok { text, registryHash, cut? }`, `error`, `unauthenticated` or `not_served` per the audience table (Q28: host sessions only). No `expr` answers the describe text: entities, members, signatures with each parameter's description, one line per builtin, from the one `describe()` the phone reuses. Text renders as `key: value` lines in the style of `eventLines`, owner-named strings through `oneLine` and `neutralizeMarkup`, readings through `formatFieldValue` in the owner's unit, instants as an age and a time, unknown values with their reason, nesting cut at depth 3; 16 KiB by default, cut between items with a footer naming `.skip(n)`. The tool handles an older Gateway's 404 as "not served yet". Plugin release; `check:boot` proves it registers for a host session.
4. **Raw Bluetooth (Q29).** A read-only host op, `bleListen`, holding a discovery hold through the coordinator for a window (default 120 s, `CONSOLE_LISTEN_MAX_S` 180 s at most) and answering everything heard in that window only, never BlueZ's cache: address, name, signal, maker data, services. `bluetooth.listen(seconds)` in the registry, loudest first, `familyOf` and `unsupported` marked. The route's wait (window plus margin) stays under Bun's 255-second idle cut and fetch's 300 seconds, so it needs no long-wait lift.
5. **Shared helpers: mostly moved to 2.6f.** `bandToDisplay` in `field-types.ts` converts a threshold band (the dead zone scaled without the offset), used by `deviceTool.ts` and by `sensors.read`, whose thresholds show in the owner's unit with a `unit`. The agent door renders type labels and reads readings through `formatFieldValue`, so it is not yet a third copy of the JSON Schema inlining, `typeOf(spec)` or the reading conversion; the phone's describe and cards are where those copies would begin.
6. **Docs:** `docs/console-live.md` (the grammar, the registry, the audience, the caps, what is never readable), the AGENTS.md map lines.

## Phase 2.6f - The live console, human door ✅

- A describe op (`console_describe`) and an eval op (`console_eval`) through the same engine; the Gateway ships before the phone. Compose `liveConsole` before `routerFrames` and hand the console dispatcher one port, `answer("owner", expr?, limit?)`, so the ops cannot grow a second registry or evaluator.
- The engine answers structured values, not only text: one result per statement, and a describe projection (entities, members, parameter descriptions, returns, builtins). The MCP door renders them to text as now; the owner op gets the values under one byte cap. Phone-bound text is never neutralized on the Gateway; the phone collapses a value or a key to one line where it draws it.
- `registryHash` hashes that canonical describe projection. The projection carries type labels and parameter descriptions, not schemas: the hash covers what the phone draws, and a constraint the phone never shows cannot go stale on it. Live ids (devices, fields, sources) are not in it: completions read them from a separate uncached op, refreshed after every read.
- Owner evals cannot outlast the phone's answer wait: `bluetooth.listen` stays host-only unless the phone, the Router and the Gateway agree a long-wait contract for it.
- The phone's tokenizer twin, pinned by vectors generated from `grammar.ts`, for highlighting and the cursor's context; completions and hints come from the describe answer and the live-id op.
- Shared helpers the describe and cards need, so they are not third copies: one JSON Schema root-inline helper (`zodToCleanJsonSchema` and `paramsJsonSchema` each do it), `typeOf(spec)` moved to shared, one reading-in-the-display-unit helper (`deviceTool.ts` and the console's `readingOf` each convert; `bandToDisplay` already serves thresholds), and `formatFieldValue` covering a number with no `decimals`. As built: `readingInDisplay` and `bandToDisplay` are the shared helpers; the JSON Schema helper, `typeOf` and the `formatFieldValue` change were not needed, since the projection carries labels and field values render raw. `definitionRefusal` refuses a reading whose expression's type is not its spec's, so a boolean reading can no longer vanish at read time.
- The Console page: input with completions and parameter hints, results as cards (a schema card per entity, a reading card in the owner's unit), session variables (assignment returns here), history. Mocked in the Designer dock first.
- **The registry in the agreed words (Q30, Q31, Q32):** `list`, `get` and `read`; `thresholds.get`; `fields.read` merging value and state, `fields.get` carrying the invalid reason; `automations.get` and `automations.read`; `sources` (was `watchers`) with `get` holding setup and rules and `read` holding health; `definitions` (was `Definition`) with `list`.
- **Variables live on the phone:** `name = expression` saves the answered value; a read sends every saved value its text names, and the held set stays under `CONSOLE_VARIABLES_BYTES`. A re-provision drops the history and the saved values, and a read begun before it lands nothing.
- **Several statements per call (Q38):** `;` separates statements on both doors; a save lasts the call, every other statement prints in order, and the caps cover the whole call.
- **Walked on the owner's phone over adb (2026-11-14):** the sensor card, a list card, a saved value with its chip, two statements in one line, completions, the parameter hint and history draw right. Seven things looked off and were changed: the page opens on the assistant's Gateway when reachable, an older Gateway's refusal is one line, a tap that inserts focuses the input, a sensor read completes with sensors only (a `sensors` completes kind), the input turns autocorrect and capitals off, an error whose message opens with its code says it once, and the picker lists reachable Gateways. The changed build is installed and has not been looked at again, since the app asked for the owner's fingerprint after the reinstall.

### Bug Classes

- **`consoleAssist`'s replace range (`ConsoleAssist.kt`):** the range a completion replaces is worked out from the tokens before the cursor, and each round found another cursor position it got wrong. Round one: the cursor inside a name or a string left the token's tail behind. Round two: the cursor at the very start of a name duplicated it, and a typed prefix of a shared device name hid the choices. The range wants one definition, "the token the cursor touches, on either side", rather than a prefix and a following special case. Round three (architecture) found three more of the class: a method completed inside `count(1)` doubled the bracket, a completion just before an existing string left the old one behind, and `x = x.` read the statement being typed as an earlier save. Resolved by design: `slotAt` answers one slot, every branch replaces exactly it and only chooses candidates, and the context is the tokens before the slot. Round four (red team on the redesign) found three edges, each patched in place: a completion inserted against a number, a string prefix compared raw against decoded names, and a keyword field name never offered.
- **`LiveConsoleOps`'s own fence (`LiveConsoleOps.kt`):** it ordered its reads with a `GatewayReadFence`, a raw state flow and, after the first architecture pass, a hand-written owner epoch. Round one (architecture): no wipe on re-provision. Round two (red team): the epoch could not fence a wipe of an already empty map, and a row appended beside the epoch could stay Running for good. Resolved by design: it sits on `SlotViews` as `DeviceOps` does, with the vocabulary, the ids and each run as slots, and `device-ops-residue.test.ts` refuses a fence, a counter or a raw flow in it.
- **`variablesFor`'s reading of which names are references (`ConsoleRules.kt`):** it re-derives from tokens what the Gateway's parser already knows. Round one: members, dict keys and save targets were sent as references. Round two: a name an earlier statement saves was still sent. A statement-aware walk patched both. Resolved by design (architecture): the phone no longer reads references at all. It sends every held value whose name appears as a name token, a superset the Gateway narrows, so a wrong guess can only cost bytes; a parser twin was rejected as about 300 lines kept in step to save a few kilobytes. `CONSOLE_VARIABLES_BYTES` is the one cap both sides read.

## Phase 2.7a - Foundations for sources and automations, nothing visible (Q32) ✅

Deployed as 8.14.80 on 2026-11-14. Checked on Sakura after the restart: the vault grants file byte-identical, GitHub polling through its grant, both threshold automations in the new shape with their revisions kept.

- ✅ **The vault first.** A `service` holder kind beside `watcher`. As built, after the red team: every build from here reads `service`, and nothing emits it yet. `createVaultDecisions` holds a service's grants as `service` in memory and `legacyHolder` writes and answers them as `watcher` until 2026-11-28, so `vault-decisions.json` and the `vault_grants` answer are byte-compatible with the build before, on the Gateway and on the phone. A fixture of a mixed file (session, routine, GitHub, IFTTT) proves no grant is lost and that a write keeps the old shape. No deploy order is needed for this slice.
- ✅ **The plugin reads both vocabularies** (it deploys apart and first): `watcher/` and `source/` action ids, `sources` or `watchers` in the baseline, an inbox header of `source:` or `watcher:`, an unknown `decision` rendered as text. As built: `ActionIdSchema` reads `source/<key>` as `watcher/<key>`, which the Gateway still lists until 2.7b; the baseline takes `sources` beside an optional `watchers`; an inbox item is no longer strict and its `decision` is any short text or absent. The baseline's overdue `evicted` field goes with the 2.7b wire.
- ✅ **Gateway internals renamed** to Source and SourceEvent. As built, after the red team: the types, the five files under `src/gateway/assistant/` and their locals say source, and nothing stored or sent changed. The data files keep their names (`assistant-watchers.json`, `assistant-watcher-enabled.json`) and the state file keeps its `watchers` key, since a rename there is one way and a rolled-back Gateway would start every watcher fresh and on. Everything the phone or an older plugin reads keeps its word until 2.7b: `watchers` in the assistant state, the baseline and the carried home, the `assistant_watcher_*` ops and their `watcherId`, the `watcher/` action family, the `watchers-changed` push, the plugin's standing instructions. Storage names change in 2.7d, a release after a build that reads both. `rulesStore.ts` and the tests' local names are left for 2.7b, which replaces the rules.
- ✅ **The Sensors bridge becomes an explicit outbox port** feeding the same lane. As built: `createAutomations` answers `outbox` (`AutomationOutbox`: a revision and the readable events) in its own words and no longer imports the assistant's `Source`; `createOutboxSource` in `src/gateway/assistant/outboxSource.ts` adapts it, with the id, label and rule fields, and `composeGateway` registers that.

### Bug Classes

- **A rename or a new shape that something outside this build reads (`createVaultDecisions`, the source state and enabled files, `outbox.events()`):** the change is made where the compiler and the tests can see it, and a reader they cannot see takes the old shape. Round one (red team on 2.7a): the vault file rewritten as `service` would have emptied every grant on a rollback, since the previous schema refuses the row and a strict restore starts fresh; the two source data files renamed on first boot would have started a rolled-back Gateway with fresh state and every watcher on; and the outbox's new `when` field failed the lane's strict `SourceEventSchema`, so every Sensors event backed off for good, which no test saw because each called `poll()` past the lane's parse. Fixed: the vault writes and answers the old holder through a dated window, the data files and their key keep their names, the outbox source maps `when` to a typed `tell` the lane's sort honours, and the automation tests poll through `PollAnswerSchema`. The rule for the rest of 2.7: a build reads the new shape a release before any build writes it, on disk as on the wire, and a source is tested through the lane's own parse.

## Phase 2.7b - Sources and automations on the wire and the phone, same behaviour (Q32, Q33) ✅

- **Wire:** `sources` and `automations` replace `watchers` in the assistant state; `assistant_source_*` ops; automation list, put, delete and preview ops; `source/github_done`, with `watcher/*` parsed through a dated skew window.
- **One automation record** with a trigger and a list of actions. This phase ships the event trigger (a source plus today's conditions) and the action "tell the assistant" with `when` now or quietly. Every match fires; an event several automations wake about wakes once.
- **Storage carries over:** each GitHub rule becomes an automation (a rule that woke becomes `when: now`); the `otherwise` setting and rule order go. The Sensors rules are empty and are dropped.
- **Phone:** a Sources page (health, secret, enabled, commands), an Automations list and editor retargeted from `RuleDraft`, Integrations and the inbox strip renamed. Mocked in the Designer dock first.
- **Home move:** the carried payload holds sources and their event automations; an old sealed payload decodes through a one-shot reader.
- **As mocked:** the Sources, service source, Automations, editor, message editor and leave dialogue rulings under "Design rulings" above, and Question 39.

Slices, in deploy order (a reader ships before what it reads):

1. **The record.** `AutomationSchema` moves to `src/shared/schemasAutomation.ts` as wire truth: `enabled`, a `trigger` (`event`: a source id and conditions; `value`: today's field and `becomes`, with its cool-down), and `actions` (a list; `tell_assistant` with `when`). The row's sentence is derived by the Gateway and answered beside the record, never stored (Q39). Threshold automations are projections, so `sensorThresholds` rewrites them in the new shape at start; they tell quietly, as today.
2. **Event automations decide the lane.** The lane's sort reads the enabled event automations for the source: any match that tells `now` wakes, and an event several match wakes once. `rulesStore` retires. On first boot `assistant-rules.json` converts: each rule that woke becomes an automation; `otherwise`, the order and the Sensors rules go; an inbox rule that stood ahead of a wake rule is logged, since order no longer excepts. The file stays where it is at the home, with a mark beside it that the conversion ran, and is emptied when the home lets go.
3. **The phone reads both.** `sources` and `automations` beside `watchers` in the assistant state, `sources-changed` beside `watchers-changed`, the Sources page, a service's page, the Automations list and editor (retargeted from `RuleDraft`, with the leave dialogue), the inbox strip renamed. Installed before the Gateway that sends them.
4. **The Gateway sends the new words.** `sources` and `automations` in the state (`watchers` stays through a dated window for an older phone), `assistant_source_*` and `automation_list`, `automation_put`, `automation_delete`, `automation_preview` ops with the `assistant_watcher_*` kinds parsed through the same window, `source/` action ids, `sources` in the baseline, `source:` in the inbox header, the baseline's overdue `evicted` dropped.
5. **Home move.** The carried payload holds each source's `enabled` and grant and the event automations; an older sealed payload's rules convert through the same reader as slice 2.

Slice 1 landed first (`schemasAutomation.ts`, `createAutomations` with `eventsOf`, `sentenceOf`, the outbox's `when`, legacy bodies read and rewritten at open); the notes below record the rest as built.

Design held for slices 2 and 4, the Gateway half, decided while reading `composeAssistant`:

- **The lane's sort:** a source event that says how it tells (`tell`, set by the outbox source from the entry's `when`) decides itself; any other asks the automations: wake when an armed event automation of that source matches and tells `now`, else inbox. `conditionsMatch` is the one matcher.
- **The automations stage gets two late ports from the assistant:** `eventIssue` (the source is one this Gateway holds and the conditions fit its field specs, through `conditionsIssue`) and `eventSentence` (the source's label, then each condition as field label, test and option label; "every event" for none).
- **Automations do not sit in the assistant state.** They are per Gateway, like routines and policies, so the phone reads `automation_list` from each Gateway and counts a source's automations itself. The state gains `sources` only.
- **Ops:** `automation_list`, `automation_put` (id, automation, baseRevision), `automation_delete`, `automation_preview` (the event trigger over the source's live first page: matched, of, the newest matches with their times). A threshold's automation is listed with its `device` and refuses a put or delete here, since its sensor page owns it until 2.7c. `assistant_source_grants`, `assistant_source_enabled`, `assistant_source_check` take `sourceId`; the `assistant_watcher_*` kinds keep parsing through the window, and the four rule ops answer a refusal that says to update the app.
- **Rollback:** an automation body is stored in its new shape from slice 1 on (rewritten at open), which the build before cannot read: rolled back, it holds those rows as unread and its threshold alerts stop until it is redeployed. No byte is lost, and the vault and the source files are untouched; what wakes is then what `assistant-rules.json` held before the upgrade.
- **Rules to automations:** after the automations store opens, each stored rule that woke becomes an automation under the rule's own id; `assistant-rules-adopted.json` then marks the conversion, so nothing converts twice and a deleted automation stays deleted.
- **Home move:** apply replaces every event automation on this Gateway with the carried ones before the lanes start, and let-go removes them all and empties the rules file, where the rules store did both.
- **Inbox item:** `decision` is `now` when an automation tells now and is left out otherwise.

As built, the Gateway half (slices 2, 4 and the Gateway side of 5), tested and not yet committed or deployed:

- **The lane:** `composeAssistant`'s `decide` is `told(event)`, else wake when an armed event automation of the source matches and tells `now`. The lane reports the events whose wake landed (`woke`), and `noteEvents` stamps each waking automation, which the row answers as `lastRanAt`.
- **Rules to automations:** `src/gateway/assistant/rulesAdoption.ts` replaces `rulesStore.ts`. `assistant-rules.json` stays where it is, untouched, for a rollback; `assistant-rules-adopted.json` marks the conversion done, so an automation the owner deletes is not brought back. A fallback that woke becomes an automation for every event (`every-<source>`); a rule its source's fields no longer take is logged and dropped.
- **Sources:** the state answers `sources` (`AssistantSource`, with `triggers`) beside `watchers`, which an older phone reads with empty rules until 2026-11-28. A source whose events tell themselves (`selfTold`, the Sensors queue) refuses an event automation.
- **Ops:** `assistant_source_grants`, `assistant_source_enabled`, `assistant_source_check`, `automation_list`, `automation_put`, `automation_delete`, `automation_preview`. The `assistant_watcher_*` kinds still run; the four rule writes answer `stored: false` with "rules became automations; update the app", and the rule preview throws the same. An event automation is refused while the assistant lives elsewhere; a threshold's row refuses a put or delete.
- **Words:** action ids are `source/<key>` (a `watcher/` id still runs), the event header is `source:`, the baseline lists `sources` only, an inbox item's `decision` is `now` or absent and the plugin prints it as `tell:`. The quiet push is still `watchers-changed` with `watcherId`; the phone claims `sources-changed` too, and the Gateway flips on 2026-11-28.
- **Home move:** the carried payload takes `automations`; `rules` on a carried watcher is optional and converts through `automationsOfRules` when no automations are carried. A move made from an older phone carries empty rules and so drops the event automations. A carried automation this Gateway cannot run is dropped with a log, since a put takes no unfit body; one becomes `invalid` only when its source's fields change under it.
- **Codegen:** `AutomationTrigger` and `AutomationAction` are `preserve` roots with future-kind fixtures; `AutomationCondition` is its own strict class.

As built, the phone half (slice 3 and the phone side of 5), tested and not yet committed or installed. A Luna agent started it on a written brief and ran out of quota after the draft model and the ops skeleton; the rest was written here.

- **Sources:** `sourcesOf` in `AssistantOps.kt` is the one reader: `sources`, else an older Gateway's `watchers` converted. The watcher helpers, `WorkKey` and the inbox strip speak sources; the rule ops, drafts and pages are gone.
- **`AutomationOps`** on the `PolicyOps` model: per-Gateway list in `GatewayEntry.automations`, typed answers, the toggle fence, and the editor's held drafts with their `opening`. Every put and delete holds the move lock. Other Gateways in this Domain run older builds: one is told by its state answering no `sources` (`servesSources`), is drawn with no Automations row and no uses line, and is sent the `assistant_watcher_*` kinds.
- **Pages:** `AssistantPage.Sources`, `Source`, `Automations`, `AutomationEditor`. Sources is the Integrations page plus the home's service sources; a service source's page shows Produces, Inbox, Commands and "N use this source"; Automations lists per Gateway with the only switch; the editor shows the three trigger kinds with only "Event arrives" selectable, the preview fold, and Now or Quietly. An alert's row is read-only on the Automations list and opens nothing, since the page stack has one parent per page.
- **Leaving the editor:** `leaveAsks` and `AutomationOps.askLeave`; the shell's `leaveAssistantPage` serves both the system Back and the top-bar arrow, and the editor draws the dialogue from `leaving`.
- **Home move:** `carriedOf(state, automations)` carries the old home's event automations, or an older Gateway's rules when it refuses the list; an unreadable list, or one a current Gateway refuses, refuses the move, and a seed reads the list the same way. Until 2026-11-28 the payload also names rules for every source (`rulesOf`), which a Gateway on an older build requires; a round trip through one keeps only what wakes now, so a disabled or quiet automation is lost there.
- **Removal:** every record page removes from its top bar's menu (`RemoveMenu`, then `ConfirmDialog`): the automation, runbook, routine and policy editors, a device's page and a service's entry.
- **Sandbox:** `SandboxAutomations.kt`: the home lists four GitHub automations and one alert row and checks revisions after a round trip; the second Gateway refuses as an older build; the third lists none.
- **Console keyboard:** the field takes the password keyboard type so Gboard draws no suggestion strip.

Seen on the emulator's sandbox build (2026-11-15): the inbox strip, the settings index with Sources and Automations, the Sources page with the home's Devices and Services, a service source's page, the Automations list and its switch, the editor (preview fold with its list, Add condition, Now or Quietly, Save landing back on the list, New), the leave dialogue from the system Back and from the top-bar arrow with Stay and Discard, Delete from the top bar's menu with its confirmation (Cancel keeps the editor, Delete lands on the list without the row), the same menu on the runbook, routine and policy editors and a device's page, Discard left of Stay on the leave dialogue, "1 in its inbox" on a service's row, and the Console field without Gboard's suggestion strip. Not walked: a Gateway on an older build beside a real home. Delete first went through with no confirmation, unlike the runbook, routine and policy editors; it now asks. The first walk put the services after every Gateway's devices; they now sit inside the home's group, as mocked. The emulator needed `sudo -A setfacl -m u:nyaarium:rw /dev/kvm`, since KVM is granted to the seat's user and nobody was logged in at the desk.

Seen on the phone after 8.14.80 and `8e098817`: the Console opens on Sakura, a tap on an entity opens the keyboard, member and sensor completions are right, a refusal draws in one line. Gboard's suggestion strip still shows; the brief switches the field to the password keyboard type.

Alignment audit, lap 1 (eight angles on Opus and Sonnet, Opus synthesis, since Luna and OpenCode were out of quota). Fixed: the sealed payload's explicit nulls, which every Gateway refused; rules absent for an older destination; the source ops sent only in their new kinds; a seed that carried no automations; automation writes outside the move lock; a refused list read as empty; a refused save re-sending a stale `enabled`; a revived id showing its earlier run time; the leave dialogue's button order; "N in its inbox"; the baseline's overdue `evicted`; stale doc names; `parseRuleForFields`, which no production code called. Left as they are: "N use this source" opens every automation and Back skips the source page; the editor's preview is held in the page; Sensors is listed under Services; Produces reads "Events"; a partial rules adoption that fails a write and then loses a race with an owner delete.

Red-team audit, lap 1 (eight angles on Opus and Sonnet, Opus synthesis). Fixed: the leave dialogue outliving its opening; Discard during a save in flight; a refused delete leaving Back asking about changes nobody made; a phone on the build before being answered blank rules, which a move from it then carried; one unreadable carried automation or service refusing the whole move; a save queued behind a move landing on the old home; a carried id shaped like a sensor alert; an id spelling a prototype key; a null temperature unit in the payload; the plugin's reading of an older Gateway's `wake` and `inbox`. Left as they are, each for a reason:

- **A Gateway rolled back to the build before** decides from `assistant-rules.json` as it was before the upgrade, so edits made since do not wake, and one that became home only on this build wakes nothing there. The file stays read-only; writing it back would make this build a second writer of a file it retires.
- **A phone older than its Gateway drops fields it does not know** when it toggles, saves or carries a whole record. 2.7c ships its phone first, and a field added to a known kind needs a reader release.
- **The cap of 64 is shared with sensor alerts** and is checked late in an apply; a move to the same Gateway drops an automation its fields no longer take; a throw inside adoption would write the mark. None is reachable with the owner's configuration.
- **A preview reads a source that is off.** It is the owner's read; off gates what reaches the assistant.

Compliance review, lap 1 (four angles, scoped to a one-owner deployment). Fixed: a let-go left the old rules file on a Gateway the assistant had left, now emptied there as before automations; an event automation of a source the build no longer has survived a let-go and a move; the phone's `gateway call failed` log lines carried an unbounded message, now the error's class, in all seven ops classes. Left: a source's Enabled and grant ops carry no base revision, so the Router could replay one; older than this phase and on the board.

### Bug Classes

- **Editor state keyed to a slot, not an opening.** Mechanism: `AutomationOps.leaving`, `discard` and `opened`. First round: the ask now names its opening, a Back during a send leaves without discarding, and a delete's offer rebases `opened`.
- **A store rule enforced at one door.** Mechanism: `automations.ts` and `composeAssistant.ts`: the alert prefix, the cap, validity and `enabled` are each checked on some write or read roads and not on `replaceEvents`, `adoptEvent`, `carriedEvents` or `livePage`. First round patched the prefix on `replaceEvents` and `ownerRemove`; the rest are listed above.
- **An explicit null against an optional field, in the sealed home payload.** Mechanism: `sealedJson` (`encodeDefaults = true`) feeding hand-written `.optional()` fields in `schemasAssistantHome.ts`. Third occurrence: `integrations` was patched to `.nullish()` earlier, then `rules`, `automations`, `enabled`, `temperatureUnit` and a carried automation's `label` here. This round's patch is `.nullish()` on each plus `canonicalAutomation` dropping a null label. The gate that was missing now exists: a Kotlin test writes the phone's own encoding and a TypeScript test parses it. The design fix, done after the architecture review: the codegen marks each nullable field `@EncodeDefault(ALWAYS)` when required and `NEVER` when optional, `sealedJson` is gone, the corpus became `tests/fixtures/phone-encoded/cases.json` for any value the phone encodes, and `kotlin-null-encoding-residue.test.ts` refuses a field with no mode. It also closed the reverse case: the phone's status answer left out a required `holder: null`, which the Gateway refused, so a released hold was not cleared from its memo.
- **A skew window opened for the reader and not the writer.** Mechanism: each new shape got a tolerant reader while its writer went out at once: the phone's `assistant_source_*` ops, the carried payload without `rules`, the phone's `watchers-changed` claim dated before the Gateway's flip. Patched per site, with `servesSources` as the phone's one reading of a Gateway's build. Second round, from the red team: the Gateway's `watchers` view answered an older phone blank rules, now projected by `rulesOfAutomations`; the plugin read only the new `tell` word.
- **Refused read as empty or as older.** Mechanism: a nullable list flattened by `orEmpty()` (`automationsOn`), and `carriedFrom` reading any refusal as an older build. Patched by reading the build off the state instead of off the refusal.

Configuration held before the rebuild (2026-11-15), which the carry-over must reproduce:

- **GitHub notifications** (`github`): enabled; reads the vault entry "GitHub PAT - Development"; wakes when `reason` is `approval_requested`, `security_alert` or `mention`, or `type` is `PullRequest`; everything else to the inbox; offers Mark done.
- **Sensors** (`sensors`): enabled; no rules, everything to the inbox; offers Clear events.
- **Automations:** "Outside thermometer temperature below 2.0 C" tells the assistant; its "above" side is off.

## Phase 2.7m - One menu (Q40, Q41, Q42)

Runs after 2.7b ships and before 2.7c. Phone only.

- **One menu:** the root list everywhere, in the order of Question 40, with Sources and Automations as root views. The session's menu and the assistant's two-item menu go.
- **A session's bar:** the Terminal button becomes a three-way switch for Chat, Terminal and Files; the assistant's bar gets Chat and Terminal. Back, the name, the three dots and the tab row stay.
- **A pick made inside a session** arrives filtered to it, as the session's menu filtered it, with a chip that clears the filter and Back returning to the session. Sources and Automations open whole.
- **The assistant's gear** keeps Location, Features, Safety and Remove.
- **As mocked** in the Designer dock under "Menu arrangement": "Menu today", "A: one menu everywhere", "A: inside a session".
- **A Gateway's lists keep their three answers** (from the 2.7b architecture review, class "refused read as empty"): `GatewayEntry` holds each list as unread, listed or not served instead of a nullable list, one decoder and one fold serve the four ops classes, and their copied `attempt` and `refresh` go into `GatewayReads.kt`. The Gateway ships first with a `not served` reason token for an op kind or stage it does not have, so the phone stops inferring a build from an unrelated field.
- **One model for an edit in progress** (class "editor state keyed to a slot"): an opening minted only by `open`, every mutator taking it, saves on the repository's scope, and the leave dialogue drawn by `EditorScaffold`, shared by the runbook, routine, policy and automation editors. Today a Back during a save cancels it in the three older editors and their drafts outlive Back; what Cancel means there is asked first.

Slices:

1. **The Gateway says "not served".** ✅ `OP_REASON_NOT_SERVED` in `wire-vocabulary.ts`; `composeRouterFrames` answers it for a kind no schema names and for a stage guard's `NotServedError`.
2. **One menu.** ✅ built, not walked. `RootView` holds the ten views in Question 40's order and `MenuSheet` draws it from the root and from a session. `ConversationView` keeps Chat, Terminal and Files, switched by `ViewSwitch` in the session's bar. `ShellNav.pick` is the menu's one transition: inside a session it lands `over` it (`OverNav`), filtered where the view takes a session, with `FilterRow`'s two chips and Back returning to the session. Sources and Automations are root views (`SourcesView`, `AutomationsView`) that list the session's Gateway first; `AssistantPage` lost Sources, Automations and the automation editor, and a Source, a Device and Add close onto what opened them. The settings index keeps Location, Features, Safety and Remove. Everything the shell draws over a screen goes through `ShellOverlays`, which returns first while the lock shows.
3. **A Gateway's lists keep their answers apart.** ✅ `GatewayList` on `GatewayEntry` for routines, runbooks, policies, automations and peers: unread, listed, not served or unreachable, with rows on the listed answer alone. `ListAnswer`, `listAnswer`, `after`, `gatewayAttempt`, `refreshEach` and `ToggleFence` in `GatewayReads.kt`, with the four ops classes on them; `lookup`, `listedGroups`, `listEmpty` and `emptyLine` on the registry are what a reader takes. The phone reads the token now; a refusal in prose reads as not served only for automations, until 2026-11-29.
4. **One model for an edit in progress.** ✅ built, not walked. `EditorSessions` holds one `EditState` per editor kind: its edits by their opening, the one that is shown, and a Back that asked. `Editors` shows one editor at a time across the four kinds and the shell draws the `ShownEditor` it derives, so nothing but the model says an editor is open. Saves and deletes run on the repository's scope, Back asks through `askLeave`, and `EditorScaffold` draws the leave dialogue. Cancel is gone (Question 43): every editor has a back arrow, and Back is the one way out.

Dropped with the session's own menu: the "N windows" note beside Files and the "N open" note beside Backlog, and the settings index's count lines for Sources and Automations.

Not verified: the emulator would not run without KVM, so no screen of this phase has been seen.

Remaining, all waiting on the owner: the walk on a screen (the emulator needs the KVM grant, and the owner's phone is not unlocked by this session), then the build and the deploy, phone first (Question 43 is answered and built, and the walks moved to the emulator). The Gateway's `not served` token ships with that deploy and must be out before 2026-11-29.

**Alignment audit, lap 1** (eight angles on Opus and Sonnet, Opus synthesis). Fixed:

- An editor closed by an arrival, a plugin turned off or an unwinding answer kept its edit and its leave question for the next opening. `EditorSessions.park` drops an untouched edit, keeps a touched one and clears the question. The red team then moved the call from the shell into the page.
- A refused routine list read as not served, which emptied that Gateway's routines and cancelled a missed-run notification. `listAnswerOf` reads the `not_served` token itself; a refusal in prose keeps what was drawn for routines and runbooks. For automations it reads as not served until 2026-11-29 (`ProseRefusal`).
- The routine and policy editors opened a blank draft under "Edit" when their list was unread. `rememberEdit` waits for the record (`editStanding`) and says when it is gone.
- Typing reached the session a frame late, so a quick Back could leave unasked. `MirroredDraft` writes each change through as it is made.
- `summonShown` still read the root under a pick; the filter stayed on with no chip once a session proved to be the assistant's; a send kept the last refusal on screen; Sources put the home's services ahead of the session's Gateway (`sourceGroups`); Automations said "No automations" for a list that was unread or not served (`automationsEmpty`); Refresh and a change of view did not re-read what the two views draw.
- The phone hold is claimed from the assistant's root, its conversation, its own four pages, and any page opened over its conversation. A page opened from Sources or Automations elsewhere no longer claims it, since those views are no longer the assistant's.
- `refreshEach` and `gatewayAttempt` replace the five copied fan-outs and attempts.

Left as it is:

- An Entry's Back still leads to Add even when Sources opened it, and a Device opened from an Entry closes past it, as before this phase. Pages need a stack, which 2.7c builds for "N use this source".
- Text typed into the policy's command field or a runbook's option field and not yet added is not a change, so Back does not ask.
- A pick over a session is dropped when that session is left by something other than Back.
- The emulator can show a Gateway that does not serve a list only for Automations.
- The settings index's "A source needs configuration" warning went with its Sources row; the Sources view marks the row itself.

**Red team, lap 1** (six angles on Opus and Sonnet, Opus synthesis). Sixteen confirmed. Fixed:

- "Save over revision N" sent the stale draft's enabled state, so it could turn a disabled policy back on. `PolicyDraft.over` takes the newer record and its enabled state. Older than this phase.
- The shell parked an editor's session while its page was still drawn, which left the automation editor on screen with nothing behind it. A page now parks its own session when it leaves composition and closes when its session is gone (`editorShowing`); the shell parks nothing, and the `landed` map is gone.
- A save or delete still out when the owner pressed Back failed without a word. A parked session is `unattended`, and a send that stays tells the owner in a transient message.
- A runbook save still out at Forget wrote the previous owner's runbook into the wiped library, because saves now outlive the editor. `RunbookOps` holds a generation checked before every library write, and every ops class clears its read fences at a re-provision.
- A Gateway whose routines were unread had its missed-run notifications cancelled, then posted again with sound. Each notification names its Gateway and `routineNoticePlan` sweeps only what an answered or departed Gateway owns. Older than this phase.
- The runbook, routine and policy editors, the fire sheet and the board and vault entry dialogues drew over the app lock. They wait for it now, and Back reads the lock first. Older than this phase.
- A Gateway restart mid-edit changed a routine's kept zone and flipped the title to "New". The routine and policy editors read their title, Delete and kept zone from the record the edit opened on.
- A transient refusal read as "does not serve automations" beside an enabled New. A refusal from a Gateway whose state answers sources is a fault, and policies read every prose refusal as one.
- Automations said "No automations" and Sources said "Place the assistant first" before anything was read (`automationsEmpty`, `noHome`).
- Delete and "Save over" stay disabled while a save is out; the runbook's standing refusal hides while one is out; the drawer is one state that every arrival closes.

Left as it is:

- Two New records of one kind on one Gateway share a key, so a New opened while the last New is still saving joins it. Text typed while a save is out is lost when it lands, as before this phase.
- Two activities on one edit: the stale page's typing wins. Rare.
- A summon during a home move lands on the old thread and is then dropped. Older than this phase.
- `RunbookOps` keeps only rows and never folds a not-served answer, since its library is durable.

Plausible, to settle on screen: the session name squeezed by the switch on a 360dp phone; the switch's 38dp segments as touch targets; the root bar's title beside a full Button over a pick; one blank frame as an editor opens.

**Red team, lap 2** (three Opus angles on the lap-1 fixes, Opus synthesis). Thirteen confirmed, seven of them introduced by lap-1 fixes. Smallest patches:

- The runbook save at Forget still wrote: the library was wiped before `RunbookOps` moved its generation. `clearedOnReprovision` clears `runbookOps` first, and every library write checks the generation under the lock that clear takes (`written`).
- Back was swallowed over a kept edit no page draws. `askLeave` leaves an unattended edit at once.
- The attachment viewer and the link, row and forget dialogues still drew over the lock. Gated.
- Automations could spin forever. `automationsEmpty` says what the Routines and Runbooks views say: no roster, no Gateway read, not served, or none.
- Cancel during a save discarded the edit, so a refusal went unheard. Cancel waits while a save is out.
- A save that landed while the lock hid its editor reopened a blank form. An editor the lock hid returns only while its edit is held (`hiddenEditor`).
- The drawer's close on a screen change could stop half way. It snaps shut on the shell's scope.
- An untouched edit that settled unwatched was kept for good; it is dropped once told. A transient message waits until no editor covers it. `routineNoticePlan` no longer reads an empty roster as "every Gateway listed".

Left as it is: the lock drops page-local state the edit does not hold (the runbook's overwrite intent, a half-typed policy example, an open confirmation); a drawer drag cut off by a screen swap is unverified.

**Architecture review** (five Opus angles on the recorded classes and the shell, one Sonnet scan for duplication, Opus synthesis). Done:

- **Which editor is open has one owner.** The shell held three saveable pairs and a page for the automation editor while each ops class held the edit, and the two met only through a page's disposal, which the lock, a rotation and a second window also cause. `EditorSessions` now holds `shown` beside its edits, `Editors` keeps one shown across the kinds, the shell derives `ShownEditor` and draws it, and a page that leaves composition ends nothing. `park`, `unattended`, `hiddenEditor`, `editorShowing`, the three shell vars, the lock's prune effect and `AssistantPage.AutomationEditor` are gone. A refusal on an untouched draft now survives the lock, and the vault rule that closed a policy editor only while the root was drawn is one effect (`editorStands`). An editor is no longer restored after the process dies. Gate: `editor-owner-residue.test.ts`.
- **Only a listed answer has rows.** `GatewayList.rows` defaulted to empty on every answer, so the shortest read compiled and was wrong. Three more live defects came out with the readers: Policies said "No policies" with nothing read, a runbook's delete named no pinning routines when routines were unread, and a Gateway whose peers were unread dropped its linked Domains and pruned their sessions. A fourth answer, unreachable, tells a first read that failed from one still out. Gate: the compiler and `gateway-list-residue.test.ts`.
- **One re-provision fence.** `ProvisionFence` replaces the workspace's generation and the runbook's private lock. `clearAll` closes it first and moves its term last, so the roster's order decides nothing. It also closes three leaks older than this phase: a vault answer's record, a scheduled send's draft take-back, and a pending untrust, each written after its await with nothing to refuse it. The board and vault managers no longer default the generation they are checked against. Gate: `reprovision-fence-residue.test.ts`.
- **One host for what draws over a screen.** Fourteen lock guards written five ways became `ShellOverlays`, which returns first while locked, over one `Modals` value that an arrival resets whole; the forget dialogue an arrival used to skip goes with it. Gate: `shell-overlay-residue.test.ts`.
- **Smaller:** `ToggleFence` replaces three copies of the row-toggle guard; the grant sheet keeps ids an unread vault cannot name; a device page no longer closes on a cached roster; the remaining reads of `servesSources` carry the 2026-11-29 date.

**Red team on the rework** (four Opus angles, Opus synthesis). Fifteen confirmed, nine of them introduced by the rework. Fixed:

- The fence was closed only after the identity was wiped, and a term captured mid-wipe counted as the next owner's. It now closes as the first step and its term moves at the last, so work begun before or during the wipe lands nothing; the board and vault managers land nothing while it is closed; a vault answer's record goes through the fence, not the manager's lineage counter; the pending-untrust set is cleared with the rest.
- Keeping a Gateway's linked Domains while its peers were unread kept every unlinked Domain too. A Gateway's peers now outlive its restart on the entry, and the linked Domains are what each Gateway last answered (`linkedOwners`).
- A row tapped twice dropped the edit it had just opened and left an editor shown with nothing behind it (`Editors.show` no longer hides its own kind). The open editor outlived a finished window; `onDestroy` hides it. A refusal that settled while its editor was shown but unseen is told when an arrival hides it.
- A not-served list read as "Deleted elsewhere" on a live edit. `Lookup` and `EditStanding` now tell reading, unreachable and not served apart, the waiting page says which, and Refresh re-reads the Routines, Runbooks and Policies views. A scope with no Gateway no longer reads "No routines" (`ListEmpty.NoGateway`).
- A sheet's late close cleared the request that had replaced it; a close now takes only the modal it was built for (`Modals.without`). Older than this phase.
- Users showed 0 shared sessions for every trusted person: the count was keyed by Domain and read by owner (`sharedCountsOf`). Older than this phase.
- The four residue tests matched spellings. The shell's is now structural (nothing but the host after the screens, and the lock handed to it); the fence's reads the whole order of `clearAll`; the other two were widened.

Left as it is: two windows share one shown editor, so an arrival in one hides it in the other; `scheduleSend` and `untrustOwner` still answer success when a wipe refuses their write, which the wipe then removes; the runbook delete sentence can change under the finger while its routines are read.

**Red team on those fixes** (two Opus angles, Opus synthesis). Eleven confirmed, eight of them introduced by the round before. Fixed:

- A cancelled wipe still moved the term, which left every composed request and device view dead for the life of the process; two wipes at once reopened the fence mid-wipe. `clearAll` is never cancelled part way and runs one at a time (`wipes`).
- A write still out when the identity went could put the previous owner's data back on disk. The wipe clears the provisioning keys again as its last step.
- A showing minted inside the wipe died when the term moved. It takes the term after the wipe (`upcoming`).
- A routine edit redrawn under the lock while its list was unread forgot the record it opened on, so it saved into the phone's zone without asking. The draft now carries that record (`RoutineDraft.base`), and a title and Delete read whether the editor was opened on an id.
- A refusal was told again on every hide; it is told once (`EditSession.told`). The editors' refreshes run on the repository's scope. One owner's Domains count together in `sharedCountsOf`.
- The fence's residue test reads the wipe's whole shape: closed first under the lock, never cancelled, nothing detached, reopened in a `finally`, nothing after it but the link refresh.

Left as it is: a keeper that re-shows a view inside a wipe keeps its initial view until it leaves; a refused board write from before a wipe can still leave its notice; a message admitted between the fence closing and its class clearing is sent, though nothing it lands draws; linked Domains are unknown at a cold start until each Gateway's peers are read; the editor, list and overlay residue tests still match spellings in places.

No further round: each one now finds defects in the code the round before added.

**Compliance review** (four angles on Opus and Sonnet, Opus synthesis), judged against the system's own rules for a one-owner deployment. Fixed:

- After Forget or Delete, the clean-up that follows the wipe never ran: the Settings section that asked left composition as `provisioned` fell, which cancelled its coroutine before it could call back. The Designer's canvases stayed on disk, the previous owner's notifications stayed in the shade, and the "could not confirm the purge" warning never showed. Both now run on the repository's scope; the plugins' wipe handlers and the notification sweep run inside the wipe itself (`onWiped`), so a window swiped away mid-wipe skips nothing; the shell resets when `provisioned` falls; and the warning is held in the app state. Older than this phase; the rework had widened it. A delete that throws no longer leaves its dialogue stuck, and a second tap starts nothing.
- The notification sweep at a wipe skipped routine and session-prompt notifications. This phase had made the routine plan cancel only what an answered Gateway owns, so nothing else removed them.
- `TrustOps` did not clear its read fence at a re-provision.

Deferred: pruning a kept draft when its Gateway leaves or its record is deleted (memory only, and it goes at Forget); runbook and routine deletes carry no base revision, which is a wire change, Gateway first.

Rejected, with reasons in the review: the hold claimed from pages over the assistant's conversation (intended), a refused automation save rebasing the draft (an owner tap follows), raw Gateway refusal text on the owner's own screen, a Domain id in a debug log line.

Left for 2.7c's first phone slice, before the page stack:

- **`ShellNav` behind derived reads.** Fifteen raw reads of `root`, `over`, `conversation` and `assistantPage` sit outside `ShellNav.kt`, `root` doubles as the assistant's tag, and `assistantPageBack` is a table that is wrong for an Entry opened from Sources. The shape: a private constructor, every transition a member, `over` inside the conversation, one `Drawn` value the render, Back and the effects read, then `pages` as a stack with push and pop. No editor is a stack frame.
- **`AssistantWord` with three answers.** `assistantOn` still flattens unread and refused to null, which reads as "No source can trigger an automation" and hides Services. ✅ Closed in 2.7c's architecture step: the entry holds an `AssistantRead` and `assistantOn` is gone.
- **A fire the lock cuts off.** The fire sheet runs its fire on the composition's scope, so the lock cancels it after the request may have gone, and the sheet returns able to fire again as a new op. It needs the fire held per sheet opening in `RunbookOps`, as an edit is.

For the owner: the vault's request overlay (`VaultPrompt`) draws over the app's own lock screen. It passes its own presence gate for an entry approval, so this may be intended. ✅ Answered (Question 47): it stays.

### Bug Classes

- **An edit session's exits not tied to the page that shows it** (mechanism: `EditorSessions` with its pages). Ten red-team findings across two laps, each patched at the seam between the shell's record of the open editor and the ops class's edit. The architecture step gave the fact one owner: the model holds `shown`, the shell derives it, and disposal ends nothing. Its red team found two places where the fact's new lifetime, the process rather than the window, was not followed through: a second tap, and a finished window. Two windows on one process still share it.
- **Work begun before a re-provision landing after it** (mechanism: work on the repository's scope, with a fence per class). Lap 1 added a generation to `RunbookOps`; lap 2 showed the roster's order defeated it; the rework's one `ProvisionFence` still left the identity wipe outside it and counted a mid-wipe term as current, which its red team found. The fence now owns the whole wipe and the managers land nothing while it is closed. The next round found a fourth and fifth: a write with no fence at all (`ChatPersistence`) landing after the identity went, and the wipe's own cancellation. Patched once more, by clearing the keys again at the end and making the wipe whole. This class is past patching: the fence should be a required argument of every durable writer, so a write that never captures a term does not compile. On the board as its own design step.
- **Unread read as empty** (mechanism: `GatewayList.rows` defaulting to empty). The alignment round declared it closed, the red team found three more, and the review found three more again. Rows now exist on the listed answer alone. The rework's own readers then folded answers together in new ways (not served as gone, no Gateway as none, unread peers as authoritative), which its red team found: `Lookup` and `ListEmpty` now carry each answer through. The same class is still open in `AssistantWord`, left for 2.7c.
- **A reader that still assumes the old shape** (mechanism: a field whose meaning moved while its type stayed). `summonShown` read `nav.root` under a pick; `ServiceNotifications` read an unlisted Gateway's empty rows as "the routines are gone". The list half is closed by the type. The `ShellNav` half is left for 2.7c: raw fields are still public.
- **Something drawn over the lock** (mechanism: overlays composed one by one in `App`). Found in both red-team laps, eight guards added by hand. Now one host that returns first while locked.

## Phase 2.7c - Triggers and the action catalogue (Q34, Q35, Q36)

- **Value trigger:** a threshold becomes an automation whose trigger is "a value crosses a line", with its dead zone and cool-down; the sensor page's Alerts rows write such automations. The Sensors queue becomes the automations' outbox, listed in the inbox as its own section.
- **Time trigger:** an interval or a time of day in a recorded zone, on the routine recurrence calculator.
- **Action catalogue:** one table of actions with typed parameters, where each runs and whether it is dangerous; automations, the assistant's `run_action` and later the console read it. First rows: tell the assistant, switch a plug, send to IFTTT. A dangerous action asks once at save.
- **Holes:** a text parameter takes `{expression}` in the console's language, the trigger's names in scope, values printed with their unit; `\{` writes a brace. An invalid hole is refused at save with its span. The editor previews the finished text.
- **Builtins:** `round`, comparisons, `if`, as rows in the console's builtin table.
- **First slice, before any new write road** (from the 2.7b architecture review, class "a store rule enforced at one door"): the guards move out of `composeAssistant.ts` into their own file, then every automation write passes one judge with typed intents (owner, carry, adoption, projection) and commits its rows in one write, so the cap, the alert prefix, validity and the home rule cannot be skipped by a new road. Whether a carry over the cap is dropped or refused is asked first.
- **First phone slice, before the page stack** (from the 2.7m architecture review, class "a field whose meaning moved"): `ShellNav` gets a private constructor with every transition a member, `over` inside the conversation, and one `Drawn` value that the render, Back and the effects read; then `pages` as a stack with push and pop, which retires `assistantPageBack`, and "N use this source" pushes onto it. `AssistantWord` gets three answers. Each new editor is an `Editors` kind opened through `rememberEdit`, never a stack frame or a shell variable; each count, lookup and empty sentence takes a typed list read; each new write on the repository's scope lands through `ProvisionFence`; each new sheet is drawn by `ShellOverlays`.

Slices:

1. **One judge for every automation write.** ✅ `judgeAutomationWrite` in `automationJudge.ts` takes an intent (`owner_put`, `owner_remove`, `carry`, `adoption`, `projection`) and answers rows or a refusal, and `createAutomations.write` commits them through `createOwnerRecords.batch`, one write or none. `replaceEvents`, `adoptEvent` and the store's raw `put` and `remove` are gone; the carried filter and the adoption's issue check left `composeAssistant.ts`. A carry that is refused or whose write fails now leaves the store as it was, where it used to stop part way. A projection writes its sensor's fields first and then its whole alert set, so one failed alert write lands none of that sensor's alerts until the tick retries. Adoption takes no home rule, since the rules file exists only where the assistant lived, and it goes on 2026-11-28. Tested, not deployed.

2. **The crossing trigger.** ✅ `crossing` in `AutomationTriggerSchema` (`device`, `measure`, `direction`, `threshold`, `deadZone`, `coolDownSec`), generated into Kotlin with a wire fixture. `createComputedFields` takes derived fields (`derived`, `derivedChanged`, `check`), and `createAutomations.derivedFields` hands it one band per crossing, so `drain()` reads a crossing as it reads a value trigger. The sentence and the event's value come through a `reading` port that `composeDevices.watchedReading` fills: the device's name, the reading's label and the number in the owner's unit. A sensor's alerts now project one crossing per side that is set, with no label, and the stored band field is removed at the next start (dated 2027-01-15). The owner may write a crossing under any id that is not an alert's. Rolled back, the build before holds a crossing row as unread and its alerts stop until it is redeployed. Tested on the Gateway; the phone on 8.14.82 lists such a row read-only by its sentence.

3. **The action runner.** ✅ `device_set` and `ifttt_trigger` beside `tell_assistant` in `AutomationActionSchema`, with `AUTOMATION_ACTIONS` as the catalogue (label, where it runs, dangerous). A fire is recorded with the checkpoint (`drain()`) or after the poll's commit (the lane's new `arrived`, through `fireEvents`, once per event and automation), then `pump` runs its effects and logs each. Since the architecture step each effect is claimed alone before it runs, so an effect found claimed at a start is logged `uncertain` and never run again while the ones after it still run, and the tell is queued by `pump`, never behind an effect. `automationActions` in `src/gateway/compose` adapts the device road's assistant surface and the assistant's IFTTT client. An owner put that adds a dangerous action is refused with `confirm` until it carries `confirmed`. The federation harness switches a fake plug from a source event through the real composition. The phone names the two kinds in a row and keeps a row with one read-only until its editor lands. Decided here: effects use the assistant surface's sixty-second bound; `lastRanAt` is stamped when an effect ran.

4. **Holes and the message.** ✅ on the Gateway. The console's language gained `< > <= >=`, `round(x, places)` and a lazy `if(when, then, otherwise)` on both tokenizers (`93c455bb`). `scanHoles` (`src/shared/text-holes.ts`) and its Kotlin twin share `tests/fixtures/text-holes/vectors.json`. `tell_assistant` takes a `message`, and IFTTT's values take holes too. A put refuses an unreadable hole with its span (`hole` on the put result); the fire records the trigger's names and the run fills each text. A message with no hole is told with the firing; one with a hole, and every messaged tell of an event automation, is told by the run through the outbox, so the lane wakes for an event only on tells with no message. The live console now composes ahead of the automations, since its readers are lazy and a late hole reader would drop a checkpoint at every start. Left for the phone slice: the preview op with the names as they stand now, and the editor.

5. **Time and interval.** ✅ on the Gateway. `time` (`time`, `weekdays`, `zone`) and `interval` (`everyMin`) triggers, generated into Kotlin with wire fixtures. `automationClock.ts` holds the slot calculator, the validity and the sentence ("Every day at 18:00", "Every hour"). The drain's firing code became one `fire` helper that `drain()` and the clock's `tick()` share, so a clock tells, runs effects and fills messages as a crossing does, with `time` as its name. Slots sit in the automation state; a row answers `nextRunAt`. Decided here: a slot within five minutes is run late, an older one is counted in one `uncertain` run; an interval is anchored on the slot it last handled, so it does not drift; an edit or a switch back on restarts the clock.

6. **What the editor asks the Gateway.** ✅ `automation_preview` takes any trigger and an optional `text`: it answers the trigger's names as they stand now (an event's newest match, a crossing's current number, a clock's time), the text filled from them, or the hole a save would refuse. `automation_list` answers `serves`: the trigger kinds and the actions with their labels and danger flags. The outbox source's label is "Automations"; its id stays `sensors`. The plugin needs no change: a message is a field of the outbox event, which a wake and a listing already print.

7. **The shell's navigation behind one drawn value.** ✅ `ShellNav` has a private constructor and private fields, with every transition a member; the pick sits inside `ConversationNav` with an explicit assistant tag; `drawn(ShellFacts)` answers one `Drawn` value that the render, Back, the menu and the effects all read. `pages` is a stack with push, replace-top and pop, which retired `assistantPageBack`, and "N use this source" pushes a page that lists those automations' sentences. Done by an Opus agent in its own worktree to the review's spec, then brought onto main. `AssistantWord`'s half: the registry answers `assistantRead`, which keeps unread apart from refused, and the Sources view and a new automation's editor read it, where they read an unread home as an empty one. The other readers keep `assistantOn`, since each reads one setting with a sound default.

8. **The phone's editor.** ✅ The draft holds a typed trigger (`TriggerDraft`: event, crossing, time, interval) and a list of typed actions (`ActionDraft`: tell, switch a plug, send to IFTTT, and one kept raw for a kind this build cannot draw). `AutomationOffer` is what a Gateway's listing says it holds (`serves`, now with the numbers its sensors read and its switches), and the editor offers nothing else. A crossing is typed in the owner's unit. A trigger swapped away comes back as it was left. Away from the assistant's home no event, tell or IFTTT is offered, and only an event automation's write takes the move lock. A dangerous action asks once at save. A Message or an IFTTT value opens on its own page (`HoleTextEditor`): coloured as the Console colours an expression, with "Names here", the Console's hint and completions for the hole under the cursor, and the Gateway's preview. That page lives inside the automation's own edit, named on the draft, and Back closes it first; it is not a second `Editors` kind, because `Editors` shows one at a time and would hide the automation it belongs to. Walked on the emulator by a Sonnet tester from one guide (`emulator-guide.md` in the session scratchpad). The sensor page keeps its own threshold ops until slice 9.

9. **The sensor page lists its automations; the threshold record goes (Question 45).** On the Gateway: `sensor_threshold_put`, the `thresholds` on a sensor read, the row's `device`, the `projection` intent, the alert id rule and the console's `thresholds` entity are gone, and `sensorThresholds.ts` with them. An owner may now write, edit and delete an automation under any id. `thresholdConversion.ts` (until 2027-01-15) reads the thresholds an older build stored and rewrites each sensor's alerts once as crossings under the same ids through a dated `conversion` intent, which replaces only a row still in the stored `value` form, so an owner's edit stands if it runs twice; it removes the old band field unless another automation watches it, sweeps a removed sensor's rows, retries a failed write on the persist tick, and marks each sensor done in `sensor-thresholds-converted.json`. The thresholds file is never written, so a rolled-back build finds it as it left it; that build cannot read a crossing, so it runs none of the converted alerts until it is redeployed, and a threshold set while rolled back is not converted again. A removed sensor no longer takes its automations with it: they read invalid until the owner deletes them or pairs the sensor again. `thresholds.ts` became `crossingBand.ts`. A reading no longer serves its definition's `alerts` sides, which only the conversion reads, so the phone on 8.14.82 draws no Alerts section against this Gateway and its alerts can be changed only once it updates. On the phone: the Alerts section and its threshold op are gone; the sensor page lists the crossings that watch it, each opening in the editor, with a New that opens the editor set to "Value crosses" on that sensor. Walked on the emulator (walk 5, ten checks).

10. **A fallback and an orchestrator (Question 48 on).** Not built; being designed with the owner one question at a time. The owner asked for a wait set on the automation (ten minutes by default) and a fallback as an escape hatch (run actions, or run another automation such as "the whole off flow"), then for "Run an automation" on the happy path with conditions, an orchestrator. Research (`design-27c-fallback-synthesis.md` in the session scratchpad) found what constrains it:
    - Effects of a fire run one at a time across the Gateway and in no promised order; an effect's progress is `pending`, `claimed` or `done`, and `done` does not say whether it ran, so a fallback has nothing to read until each effect keeps its outcome.
    - Two fixed waits exist: an effect that sent nothing is given up after two minutes (`EFFECT_WAIT_MS`) and any effect is refused ten minutes after its trigger (`EFFECT_LATE_MS`). An unanswering plug is refused at once.
    - `admit` can evict a fire whose first effect already ran (`victimOf` falls back to any fire without a claim), which would lose a fallback.
    - A phone on any build keeps an action KIND it does not know as raw, and drops a FIELD it does not know on a toggle, an edit or a home move (`wireJson` ignores unknown keys; `toAutomation` rebuilds the record). New features must therefore arrive as new kinds, and a condition must be part of its kind from that kind's first release.
    - A condition cannot be read when a trigger fires: `drain`, `tick` and `pump` are synchronous and the console evaluator is not. The language has only `true` and `false`, no `&&` or `||`, and a missing reading throws in a comparison.
    - Validity is read from an automation's body alone (`automationIssue`, `armed`, `retireOf`); only the save's `refusal` sees the other automations.
    - The phone caps actions at eight in its own constant, so the cap cannot rise without a phone build.

    Decided so far (Question 49): a failure branch on each action, holding one or more actions, with "Run an automation" as an action. The branch must be stored where no phone build can drop it (a field on a known kind would be dropped), so it wants a shape of its own. Branches are one level deep for now. Still to ask: how an automation that only runs when called is made (recommended: a trigger kind "when another automation runs it"), where a condition lives (recommended: an optional "only if" on `run_automation`, one expression), what counts as not done, and where the wait is set. From the research, whatever the answers: a save check that refuses a cycle across the whole graph on every intent, with a depth cap of three and once-per-origin at run time; child fires charged to their target's share and timed from the origin's trigger. A fallback with its own inline actions, conditions on other actions and a wait field on the record are left for later.

Second alignment audit, over the first audit's fixes and slice 9 (six reads, one synthesis; `align-27c-relap-synthesis.md` in the session scratchpad). Eleven findings, none high. Changed:

- **The 8.14.82 phone against this Gateway.** It drew every alert switched off, since the thresholds were gone while the reading still served its `alerts` sides, and its save went to an op that no longer exists. The reading serves no sides now, so that phone draws no Alerts section.
- **A parameter the Gateway adds to a kind this build knows.** The phone drew the field and then dropped the typed value, since its own class lacks the key. `actionOf` now sends such an action raw. A stored value of such a parameter is still lost when that phone reopens and saves; left on the board.
- **A delete of a row its list no longer holds** was refused as "the assistant moved" away from the home. It now goes to the Gateway.
- **The sensor page** shows why a row cannot run, and removing a sensor says how many automations it leaves behind.
- **A refused hole** stays under its field only while that text is what was sent, so removing an earlier action no longer moves the mark onto another action's field.
- **The run reads the catalogue row.** An effect whose row says `home` is refused unsent away from the home, a text is clipped to its parameter's `max`, and validity checks every `switch` parameter, where each read the kind.
- **Tests added:** the stored form 8.14.82 wrote (both sides, the unset one switched off), a band another automation watches, a sensor left unswept, a crossing that reads invalid once its sensor is removed and valid once paired again, a new kind and a new parameter saved raw.
- **Records corrected:** the rollback sentence above, the Crossing bullet under Design held, Question 44's wording, and the docs the range left behind.

Corrected from the first audit's record: a text with holes is never told unread. An automation whose text has holes reads invalid while no hole reader is composed, so it does not fire; a test holds that.

Accepted, not changed: a text page whose parameter leaves the Gateway's row mid-edit takes one extra Back; an unread sensor record is marked converted with its rows left as they are; `home` on a row means both "refused away" on the Gateway and "not offered away" on the phone; a tell or IFTTT action already held on an away Gateway stays editable with no hint; a time trigger keeps its per-pass walk cap and catches up across passes; the sensor page lists crossings only, so it lists nothing against an 8.14.82 Gateway, which the deploy order rules out.

Red team over the phone editor, the generic actions, slice 9 and both audits' fixes (seven adversarial reads, one synthesis; `redteam-27c-synthesis.md` in the session scratchpad). Seventeen findings confirmed, two high, none reachable on Sakura since nothing of this phase is deployed. Changed:

- **High: a roster update dropped what a Gateway serves.** `landed` rebuilt each entry field by field and left `automationServes` out, so every presence projection sent the editor back to the bare offer and a save dropped a Message. `landed` now copies the prior entry of the same incarnation, and an action holding a value its row no longer names blocks the save with a reason.
- **High: a threshold was converted with the unit known at Save, not the one it was typed in.** The draft now carries its unit from its mint, and the editor waits while a connected home's word is unread.
- **One busy automation could starve the rest.** An automation holds one fire whose effects have not started; a newer one replaces it and the older still tells.
- **An effect was spent at boot.** An IFTTT effect waits unclaimed until the vault can answer, where it was logged refused and never sent.
- **Quiet tells could silence urgent ones.** A tell that does not fit drops the oldest quiet events, never a `now` one.
- **What a hole filled read as the owner's words.** A message with a hole is told with `note`, the owner's text unfilled, and the assistant's rules call `message` data.
- **Smaller, on the Gateway:** a baseline whose write failed twice no longer lets a drain pass a fire that was never recorded; a standing refusal is logged once per action; a graceful stop lands what it ran; the conversion never creates a row, so a converted alert the owner deleted stays deleted.
- **Smaller, on the phone:** an editor stands on what is stored, so a kept draft can be opened and discarded after a home move; the move lock follows the stored body the caller read, with no list read; a dismissed go-ahead is not raised again for an edited draft; a name inserted after a backslash is still a hole; a refused hole no field draws is said in the general line; removing a sensor says when it does not know what watches it, and re-reads the automations.

Re-audit of that fix commit (four adversarial reads; `redteam-27c-fixes-synthesis.md`). Nine findings, three of them regressions the fixes made:

- **A Router outage held a fire's plug and tell, with no limit.** The readiness check held the whole fire while any effect was unready. It now applies only for two minutes after a start; past that the effect is attempted and refused as before.
- **Replacement dropped a poll's earlier events.** Two matching events in one poll made the second replace the first, whose effect was lost. Only a fire left from an earlier pass is replaced now, and never an event's.
- **Every automation editor waited on the home's word and never asked for it.** The wait is back to a new automation at the home; the draft's own unit already keeps a save correct. The editor asks for the home's word itself, re-reads what its Gateway serves after a restart, and says what it is waiting on.
- **Replacement rows could fill the log.** A standing replacement is logged once.

Left from the re-audit, on the board: an IFTTT read that fails after the readiness check passed is still final; the row that says quiet events were dropped lands on the automation whose tell made room; an action holding a value its row no longer names blocks the save with no way to clear it in place; the outbox listing's page token counts positions, so a drop between two pages of one long listing can skip an event.

Rejected or left: a home move to an 8.14.82 Gateway drops carried rows it cannot read (the deploy order rules it out); a converted crossing's band starts with no side, which can cost one tell per side at the conversion; a clock stepped forward and back holds clocks and cool-downs until time passes it; the fire-time clip can split a surrogate pair.

Architecture step (five design reads, one ranked synthesis; `architecture-27c-synthesis.md` and one `architecture-27c-<angle>.md` per read in the session scratchpad). Ranked, with the order they land in:

1. ✅ **The grants page waits for the home's answer.** `NeedsEntryPage` builds its entry from an unread home as "no grants" and offers "Choose key", whose Done writes over grants the owner never saw. A pure `serviceEntryOf(read: AssistantRead, ...)` answers nothing until the home has answered. Phone, small.
2. ✅ **A crossing draft keeps the stored unit it was typed against.** `TriggerDraft.Crossing` gains the number's stored unit at its mint; `triggerOf` converts with it, where it read the offer's number live at save. Phone, small.
3. ✅ **Log and outbox move out of `automations.ts`,** as byte-identical moves, so the redesign lands in files of its own.
4. ✅ **The fires redesign.** Progress per effect (`pending`, `claimed`, `done`), so an unready or not-attempted effect waits alone while the fire's other effects and its tell go ahead and a restart knows which effects ran; one `admit` with a share per automation that never touches a claimed effect; `fit` for the outbox, dropping the largest holder's oldest quiet entry and naming each automation that lost one; an `ActionOutcome` of `not_started` for "nothing was sent"; pure rules in `automationFires.ts` and the outbox module, driven by the pump, as `agentFrameLedger.ts` is. `READY_GRACE_MS`, `effectsReady` and `replaceUnstarted` go. Kept from round 3: only a fire stored by an earlier pass is superseded. Closes the bounded-queue class.
5. ✅ **The outbox listing continues from the last item shown,** not a position.
6. ✅ **No phone reader flattens a Gateway's answer.** `listOn` tells off-roster-unread from unreachable; `found()`, `listedRows()` and `assistantOn()` leave main sources; the entry stores `AssistantRead`; one `automationContext(registry, home, gatewayId)` is the only reader of `automationServes`, its offer `Known` or `Unknown(why)`, and the draft carries an `EditContext`; the defaulted offer parameters go; `gateway-list-residue.test.ts` refuses a cast to a variant, an `else` in a `when` over these types, and the deleted names. Closes the unread-list class and the ambient-value class.
7. ✅ **The editor sends through `AutomationOps`,** as the other three editors do, so one save reads one context.
8. ✅ **A value its Gateway's row no longer names can be cleared in place.**
9. ✅ **`serves.triggers` becomes rows with each trigger's names,** before `serves` ships, so a new crossing's Message lists `{value}` before its threshold is typed. With it, the automation constants the phone copies by hand are generated.
10. ✅ **The rest of `automations.ts` moves** (state, validity, words) and one builder constructs the fields and automations pair for the composition and every fixture.

Shipped in the first pass (items 1 to 6), each gated and walked:

- **Gateway.** The log and the outbox moved to `automationLog.ts` and `automationOutbox.ts`; the pure rules of a fire's life are `automationFires.ts` (`nextWork`, split by the red team's fixes into `nextEffect` and `nextFill`; `claim`; `admit`), driven by the pump. A fire holds one state per effect. An effect that answers `not_started` waits alone, retried no sooner than five seconds apart for at most two minutes from when the process first saw it, then is refused (the rule was tightened by the red team's fixes below); the start grace, `effectsReady` and `replaceUnstarted` are gone. `admit` supersedes only a fire an earlier pass stored and never an event's, and when the queue is full the automation holding the most fires gives one up, never a claimed one. The outbox makes room by share (`roomFor`) and each automation that lost events gets its own row. A listing's page token names the last item shown. `automations.ts` went from 1136 lines to 1048, and back to about 1100 with the red team's fixes below; a fire stored in this phase's earlier shape is dropped at restore with one log line.
- **Phone.** The grants page builds its entry from an answer alone (`serviceEntryOf`). A crossing draft carries the stored unit of its number. `listOn` tells off-roster-unread from unreachable; `found()`, `listedRows()` and `assistantOn()` left main sources; the entry holds an `AssistantRead`, and each former reader says what it draws while reading and when refused. `automationContext` in `AutomationContext.kt` is the one reader of what a Gateway serves, its offer `Known` or `Unknown`, and the draft carries its `EditContext` through a Gateway restart. No offer parameter has a default. The gate refuses a member on a read type, a cast to a variant, an `else` in a `when` over these types, the deleted names, and a read of `automationServes` outside the context file; its allowlist is empty. A runbook list now says not served when the token does, where it folded that into unreachable.

Items 7 to 10 followed in the cleanup: the editor sends through `AutomationOps.commit` and `remove`, reading the draft's context once; a stray value is drawn with a Clear (`actionFields`, `withoutValue`, `canRemove`); `AUTOMATION_TRIGGERS` holds each trigger's names and `serves.triggers` serves them as rows, so "Names here" lists a new crossing's names before its threshold is typed (`namesHere`), with the action cap, the interval and cool-down bounds and the two enums generated into `Protocol.Wire`; `automationState.ts`, `automationValidity.ts` and `automationWords.ts` left `automations.ts` (899 lines) and `openAutomationPair` in `composeAutomations.ts` builds the pair for the composition and the fixtures. Walked on the emulator. Seen there and left: the "Names here" row for an event clips its sample value at the card's edge.

**Red team on that commit** (nine angles, 24 ranked findings; the synthesis is `redteam-27c-architecture-synthesis.md` in the session scratchpad). Fixed:

- **Gateway.** A waiting effect is refused only while its port says not ready or when an attempt after the wait again sends nothing, so one that became ready behind another effect still runs; a retry stored further ahead than the gap is due (a clock stepped back). An effect more than ten minutes after its trigger is refused unsent (`EFFECT_LATE_MS`), so a Gateway that was down a day does not switch yesterday's plug. The device road's own not-started waits like the others (`DeviceStage.automationSet`). A stored clock slot more than the grace ahead restarts from now. A fill has its own slot beside the effect in flight, and one that throws tells the unread text instead of spinning the pump. A replaced or crowded-out run is logged again once a run came between. An IFTTT key that is gone is refused at once. The outbox counts the asker in its share. A `new` listing that spans an action on its source leaves the mark, so a thread a mark-done shifted between GitHub's pages is shown again.
- **Phone.** Picking a crossing's own number back after it was absent converts the stored text to the owner's unit (it stored 2.0 °C as -16.7 °C). The Location page offers no folder and no move in place over an unread home, and still a move to another Gateway, the way off a home that cannot be reached. A first read that fails lands refused, so every page has a Retry and a New automation stops waiting. An unread peers list prunes no friend Domain. A home-only action held away from the home is an issue. The gate reads a `when` subject with nested parentheses and refuses an `is` test of a variant outside a branch label; it caught two more readers. The prose shim is applied where prose is classified, so the not-served token always reads not served. A drawn runbook library outlives a not-served answer.

Judged not real: an IFTTT read finishing exactly at its deadline (the race settles in order). Left on the board (`bd_f17107765542ad00c8b1140698f28145`): a retry timer in place of the persist tick; a slot or fire time outside the date range in a damaged file; the log keyed on the action index; stale fires counted at admission; a home off the roster; an existing row's editor minted before the unit arrives; and, for the owner, whether a view may say "No routines" while another Gateway in scope is unread (pinned deliberately today).

**Re-audit of the fix commit** (five angles, 17 findings, none high; `reaudit-27c-architecture-synthesis.md`). Five were regressions the fixes introduced, each cut back:

- The home-only line blocked every save of an automation a home move left behind; it is a warning now (`actionWarning`), and its row says so.
- A clock restarted after a step back fired the slot it had just handled again; the restart keeps that one instant as `skip`.
- An untrust left the friend drawn while any Gateway's peers were unread; `untrustOwner` drops it itself once its revokes landed.
- A standing refusal with no action was logged on every fire; only a lost run (`LOST_RUNS`) is compared with the row before it.
- A fill in flight put back a tell the pump had withdrawn; it patches only a tell still waiting on it.

Finished rather than regressed: a raw threshold cleared when another number is picked and drawn with its stored unit; one catch in `fillerOf` for a tell's and an effect's texts; a not-ready sighting ends when its port says ready; the folder reseed as a rule (`folderAfter`); a test that reaches the `acted` wiring; a sentence in the inbox tool's description. Left on the board with the rest: the late bound under a forward clock step, the prose shim for an older Gateway that is not the home (it ends 2026-11-29), and a second pass on the source gate (two casts it cannot see, `LocationBase` and `AssistantHome` as read types).

**Third pass, on the second fix commit** (four angles, eight findings, none high; `reaudit2-27c-architecture-synthesis.md`). One regression: a port that flapped restarted an attempted effect's wait, so a sighting now carries `attempted` and only one that never had an attempt ends when its port says ready. One fix that did not hold: a Gateway whose read failed kept a stale peers list that named an untrusted friend again, so an owner pending untrust is never named. Also: a slot passed over after a step back is logged; a standing refusal is compared with rows that are not lost runs; an untrust that reached no Gateway drops nothing yet; a threshold whose number is absent keeps its stored precision. With Question 46 each list view speaks per Gateway (`groupedView`): one that answered with nothing says so under its own name, and the whole-view line never says none. The loop stops here, on the pass's own verdict; what is left is on the board.

**Compliance review of the phase** (four angles, read only; `compliance-27c-synthesis.md`), judged for a one-owner deployment. Sound: only owner ops write or preview an automation; the IFTTT key leaves only in the fetch URL; an effect whose row says `home` is refused away from it; run rows hold fixed phrases, never filled text; friend Domains see no automation, outbox or sensor state; a purge wipes it all. Fixed: an untyped throw stored its raw message in the run log, and logs printed whole error objects; a queued tell outlived its automation's delete, the assistant's let-go, and its own seven-day retention on an idle Gateway. Noted in the docs: sensor adverts are unauthenticated. Asked of the owner: whether the assistant's own IFTTT posts (`gateway/ifttt_trigger`) want a trace or an approval, since granting the key is today the whole permission and automations share that grant. Left on the board: a dangerous action kept while its trigger widens asks nothing; holes and the console can read a device's address; host sessions can read the outbox through the console; the run log's one shared ring.

Cut by the synthesis: a fire pump extracted with a substitution proof (the redesign rewrites it), a second residue test for the context, a nullable offer, serving bounds or generating forms.

Audit of slices 1 to 6 (six adversarial reads of the Gateway range, then one synthesis; `audit-27c-synthesis.md` in the session scratchpad). 24 findings confirmed, two high, all dormant on Sakura because the phone on 8.14.82 cannot write a message, an effect, a clock or a crossing. What changed:

- **One fire road.** `fire()` no longer tells; it only records a fire, which now holds the record's revision, the fields it tells and its tell. `pump` is the one reader: it retires a fire whose automation changed or cannot run, runs effects after the claim, fills a message's holes and queues every ready tell in one write. A full outbox holds the tell and never the effects; a waiting fire gives up its place once 64 are held. `blockedSeq` is gone, so a transition is always handled in the commit that saw it, and a crossing's told number is the one read as its fire is recorded, which after a restart is the number as it stands then. The log dedupes a refusal that stands.
- **The outbox keeps its reader's bounds.** Title and fields are clipped to 1,000, a member past 256 is digested, and the reader hides an entry outside them. Two 600-character messages used to stall the lane for the queue's seven days.
- **A carry keeps what this Gateway cannot run.** The row is stored as it is and reads invalid, where it used to be dropped and then removed from the old home by its let-go. The record store takes an `unfit` put for it.
- **An event's fire is keyed by the lane's own member key**, so later activity on a thread fires again.
- **A queued fire is retired once its automation is edited, switched off or invalid.**
- **`stop()` waits out the run in flight and nothing starts after it**; `close` stops automations before the devices.
- **A clock walk whose write failed is retried in thirty seconds**, where it re-armed at zero.
- **Alerts:** the projection lands before the old band field is removed, so the first start keeps each alert's cool-down, and `lastRanAt` is read from one place that a restore folds old run times into. A threshold save asks the judge first (`refusalOf`) and answers `full` or `invalid`, where it counted by hand and answered ok for a projection that could not land. A band field another automation watches stays while its sensor does.
- **Smaller:** `round` past the scale's range answers the number; a hole's string is one line; the preview's hole message and filled text are clipped to their schema; the save check refuses a bare entity, an uncalled method, a method no value takes and an unknown member; an IFTTT key read that times out is `not_ready`, since nothing was sent; the stored `ifttt_trigger` has its own shape; a clock that fell more than 2,000 slots behind says so.

Not changed, each with its reason: validity does not read the IFTTT grant, which can change at run time, so a run without it logs refused; a disable restarts an alert's cool-down, as an owner's act; an event's effects still wait on the poll's commit (decided in slice 3).

Rollback note: a build before this drops `fires`, `fired` and `slots` from the automation state at its first write, so a waiting fire is lost and a clock starts over.

Left on the board: an older phone that edits an action drops a parameter added to that kind later. Closed by the alignment audit below: a refused carry no longer places the session, and the wire fixtures for the shapes the phone re-encodes are in.

Alignment audit of the whole phase against this plan (eight reads, one synthesis; `align-27c-synthesis.md` in the session scratchpad). 17 misalignments confirmed, none high. What changed:

- **The catalogue row carries its parameters.** `AUTOMATION_ACTIONS` rows hold `home` and `params` (name, label, kind `text`, `word`, `switch` or `choice`, `max`, `lines`, `optional`, `options`), a test holds each row to its action's schema, and `holeTexts` finds an action's texts by its row. The listing serves the rows whole. The phone draws an action from its Gateway's row (`ActionDraft.Filled` is a kind and its values by name), so a kind added to the catalogue needs no phone build, and an action it cannot draw whole is kept as sent and still saved. The Message field is drawn only where the Gateway's row names it, so a Gateway with no `serves` is sent none.
- **A refused carry writes nothing.** `apply` asks the judge (`refusalOf`) before the grants are cleared, the sources reset or the session placed.
- **The move lock follows the stored row.** A put locks when the held row or the new body is an event automation, and a delete reads the held row, so an event automation switched to a crossing in the editor still saves and deletes under the lock.
- **The assistant's standing rules name the Automations source.** `source/sensors_clear` clears its events, and a `message` is the owner's words while a filled hole stays data.
- **A clock that fell far behind walks its own grid.** `walkSlots` counts an interval's missed slots without a fresh clock read; the step cap is gone.
- **Holes:** the run marks each hole of a text it cannot read rather than sending it raw (unreachable while validity needs a hole reader; see the second audit). The save check refuses an entity named bare anywhere in a hole and a free builtin given the wrong number of arguments.
- **The phone's assist knows free builtins.** `round(` and `if(` are offered where an expression starts, hint their parameters with optional ones marked, and paint as functions. A hole's completions leave out slow members, which its save refuses.
- **A source's automations page keeps each list answer apart** (reading, unreachable, not served, none), where it spun for all but a listed one.
- **A cool-down keeps its seconds.** Minutes are typed with up to two decimals, so a stored 90 seconds opens as 1.5 and saves as 90.
- **Wire fixtures:** the real catalogue's `serves`, a put's `confirm` and `hole`, a preview's `names`, `filled` and `hole`, and a preview op with a `text`, decoded by both runtimes; the phone-encoded corpus gained a confirmed save and a preview with a text. `serves` is dated required from 2026-11-29.
- **Docs and wording** brought to the one fire road and the outbox; the sandbox's source is labelled "Automations".

Accepted as built, with the plan amended below: the IFTTT shape is declared by the live action and by the stored one, held equal by a test; `run_action` does not read the catalogue; holes read the host audience with slow members refused; `if` is lazy when it runs and checked on both branches at a save; a crossing replayed after a restart tells the number as it stands then; `editorSources` and `newAutomationGateways` read an unread home as having no sources, since the editor itself waits on `automationStanding`; the New-automation Gateway sheet is the screen's own.

Also seen, left: an interval's `{time}` prints in UTC; the sandbox's preview refuses any hole that is not one name.

### Bug Classes

- **One fire, several tell roads** (`fire`, `runFire`, `tick` in `automations.ts`): four findings, each a different outbox-full or field rule per road. Closed by the one road above, not by patching each.
- **A stop that covers the timer only** (`stop` in `automations.ts`): two instances, `pump` and `tick`. Closed by one `stopped` flag both read.
- **A run time kept in three places** (`checkpoint.firedAt`, `slot.firedAt`, `ran`): an edit, a move to a crossing and a clock edit each lost it differently. Closed by `ran` as the one place.
- **A writer that does not hold its reader's bounds** (the outbox against `SourceEventSchema`): one instance found, with two more on the same road. Closed in `told` and in the reader.
- **A bounded queue with no share per producer** (`admit` and `told` in `automations.ts`): round 1 (audit of slices 1 to 6) made a full outbox hold a tell and a waiting fire give up its place; round 2 (red team) found one busy automation filling the fires and quiet tells filling the outbox. Patched in place: one unstarted effects fire per automation, quiet events dropped for a `now` one. Round 3 (re-audit of those patches) found the patches themselves wrong three ways: the readiness hold stalled a whole fire through a Router outage, replacement ate a poll's earlier events, and its rows filled the log. Each was cut back to the smallest rule that holds (a start-only grace, a backlog-only replacement that spares events, a deduped row). This mechanism is not patched again here: the architecture step gets one admission rule for the fires and the outbox, with a share per automation, a priority, and per-effect progress so an unready effect can wait alone. **Closed by the architecture step:** `automationFires.ts` and `automationOutbox.ts` hold those rules as pure functions. The red team on it found timing gaps in the new wait (first round on that mechanism), not the share rule.
- **An unread list folded into a definite answer** (readers of `GatewayList`, `Lookup` and `UsedBy` on the phone): first audit, a source's page spun or said "none" for an unread list; second audit, a delete of a row its list no longer held was refused as a moved home; red team, the remove dialogue said nothing watches a sensor whose list was unread, and an unread list let a put skip the move lock. Each patched at its reader; the lock no longer reads a list at all. `gateway-list-residue.test.ts` refuses `.orEmpty()` on a list but not a cast with a default. For the architecture step: every reader folds the answers in a `when` with no else, and the gate refuses the cast. **Closed by the architecture step:** the flattening accessors left main sources and `gateway-list-residue.test.ts` holds five rules with an empty allowlist. The red team on it still found four readers the rules could not see (a nullable `workdirOf` read as "must move", a failed read left as reading, unread peers mapped to none, an `is` test in an `any`); each was patched and the gate gained the `is` rule. What stays beyond a source gate: a function that names every case and returns the same definite value for two of them.
- **A run log that dedupes on too coarse a key** (`logged`): once per automation hid a second action's refusal; once per automation and action then hid every later replaced or crowded-out run, since those rows carry no action. Patched each time at the key. The next patch (a row with no action compared with the automation's latest row) logged a standing refusal on every fire. The rule it wanted is two kinds of row, named: a standing refusal, once per automation and action; a lost run, again once anything came between (`LOST_RUNS`).
- **A guard on an unread or unusable state that also closes the owner's way out** (three fixes of one round, three mechanisms): the Location page hid the move to another Gateway with the in-place move; the home-only issue blocked the save that would remove the action; the peers prune waited on an offline Gateway and so held an untrust. Each cut back to refuse only the act the unknown makes unsafe. For any later fix of this kind: name the recovery path first and keep it.
- **A value read from ambient state when it is used, not when it was entered** (the display unit in the automation editor; `automationServes` in `landed`): one instance each, both closed by carrying the value with what it belongs to (the draft, the copied entry). The architecture step found a third (a crossing converted with its number's unit read at save) and closed all three the same way: the draft carries its display unit, its crossing's stored unit, and the context it was minted with.

Design held for the rest of the phase, decided from five maps of the code (saved as `map-27c-*.md` in the session scratchpad; the facts that matter are restated here):

- **Deploy order is plugin, Gateway, phone.** The Gateway's unions are strict, so it must parse a kind before a phone emits it. The deployed phone decodes a kind it does not know as `Unknown`, keeps its raw form, and draws the row read-only with the Gateway's sentence, so a Gateway may hold the new kinds first. The phone's editor offers only what the Gateway says it serves, as `offered` does for integrations, so nothing is sent to a Gateway that would refuse it. A message on `tell_assistant` is a field on a known kind, which the phone on 8.14.82 would drop on a toggle; that phone cannot write one, and the new phone ships before any automation holds one.
- **Crossing:** trigger kind `crossing` with `device`, `measure`, `direction` (above, below), `threshold`, `deadZone`, `coolDownSec`. The Gateway watches it through a band field it derives from the automation and hands to `createComputedFields` as a derived field: evaluated and kept in the field state like a stored one, never a record, so `drain()` stays the one reader of transitions and no second store is written. `value` stays for a choice or boolean field. Until slice 9 a sensor's alerts projected crossing automations from its own threshold record. From slice 9 a threshold is a crossing the owner writes, and `thresholdConversion.ts` rewrites the stored thresholds once, until 2027-01-15.
- **Time:** two kinds, flat so the preserve root needs no nested union: `time` (`time` HH:MM, `weekdays`, `zone`, on `nextOccurrence`) and `interval` (`everyMin`, anchored on the slot it last handled, first fire one interval after it is stored). The last slot is in the automation state and the next fire is computed from it, never from a fresh clock read. A slot more than five minutes late is not run; it logs one `uncertain` run. Neither moves with the home.
- **Actions run in a runner, after the claim:** `drain()` and the lane only record a fire (the automation, its member key and the trigger's captured names) in the same commit as the checkpoint. A serial runner then runs each action in order and logs its outcome. Each effect is claimed in its own write before it runs (one state per effect since the architecture step), and an effect found claimed at a start is logged `uncertain` and never run again; the fire's other effects and its tell go ahead. Telling the assistant appends to the outbox, which dedupes by member key downstream.
- **Action kinds:** `tell_assistant` (`when`, optional `message`), `device_set` (`device`, `verb`), `ifttt_trigger` (`event`, `value1` to `value3`). One catalogue row per kind in `src/shared`: label, parameters with their kinds (text with holes, a word, a switch, a choice), where it runs, whether it needs the home and whether it is dangerous. A test holds each row to the action union's member. The editor's form is the row itself, served on the listing and drawn generically, so no form is generated into Kotlin. `gateway/ifttt_trigger` keeps its own request shape, which a test holds the stored action inside. `run_action` and the phone and source registries do not read the catalogue in this phase, so the same IFTTT post asks at a save and not through `run_action`.
- **Dangerous at save:** a put whose actions include a dangerous row is refused with a typed reason unless it carries `confirmed`; the phone asks once and sends again. `ifttt_trigger` is the first dangerous row, since an applet can do anything; switching a plug is not.
- **Holes:** a shared scanner (TypeScript and a Kotlin twin on one vectors corpus) splits text into runs, `\{` and `\}` escapes and holes. A hole is one console expression: no assignment, no second statement. Names in scope are the trigger's (`value`, `device`, `measure`, `threshold` for a crossing; `event` with its fields and `source` for an event; `time` for a time) and the Console's entities as a host session reads them, with slow members refused (no `automation` audience was built; the two read the same today). A save refuses a syntax error, an unknown root name and a slow member, with the span. A hole that is one name with a shown form prints that form, so `{value}` reads "1.8 °C"; anything else prints as the Console prints a scalar. A hole that fails at fire time prints `{?}` and the run logs it.
- **Builtins:** `<`, `>`, `<=`, `>=` in the grammar on both runtimes, and free calls `round(x, n)` and `if(when, a, b)` with lazy branches, as rows in the builtin table with a new `none` receiver. A save checks both branches of an `if`.
- **The outbox** keeps the id `sensors` and takes the label "Automations".

Slices from here, each ending green: (2) the crossing trigger and alerts as crossings; (3) the action runner with `device_set`, `ifttt_trigger` and the confirm; (4) holes, the message, its preview, and the builtins; (5) time and interval; (6) the plugin's wake and inbox text; (7) the phone's `ShellNav`, page stack and `AssistantWord`; (8) the phone's draft, editor, message editor and sandbox; (9) the sensor page and the end of the threshold record (Question 45). The outbox's label landed in slice 6. Expression conditions were not taken by any slice and wait for a later phase.

Asked, unanswered:

- **Question 44 - A carry over the cap.** ✅ Answered: the refusal stays. The cap of 64 is shared by the event automations a move carries and the crossings, clocks and value automations that stay on a Gateway. The move is refused whole with the numbers before anything is written, and the home record keeps the sealed payload, which the phone carries onward at the next move.

## Phase 2.7e - Flows: ordered steps, branches and calls (Q48 to Q59)

Second draft, after one audit (five lenses, `plan-27e-audit-synthesis.md` in the session scratchpad; sized from `tree-impact-gateway.md` and `tree-impact-phone.md` there). Not built. Waits on the owner for the questions listed at the end.

Three phone builds are in play: 8.14.82 (deployed: event and value triggers, `tell_assistant { when }` alone, and its toggle already strips a message), N (this plan's 2.7c head, not yet installed) and N+1 (flows). Slice 2 deploys only once N is on the phone.

Design held for the phase:

- **One wire rule:** anything an older build cannot hold lives inside a kind it does not know. No new key on an existing kind or on the record. The rule covers durable state too: a new field on a stored fire or run row is optional, and each slice's restore reads the shape the slice before wrote. A new request shape is a new op kind, so an older Gateway answers `not_served` rather than dropping a key.
- **Shape:** the record keeps `label`, `enabled`, `trigger`, `actions`.
  - Trigger kind `called`, no fields, no names.
  - Action kind `run_automation { automation }`.
  - Action kind `flow { keepTryingMin?, coolDownSec?, steps }`. It is the record's only action when used, a refinement on the automation schema with a readable reason. `coolDownSec` is refused unless the trigger is an event, since a crossing and a value hold their own.
  - Preserve root `AutomationStep`: `do { action, onFailure? }` and `if { when, unit, then?, else? }` with at least one side filled. A later step feature is a new step kind with its own future-kind fixture.
  - Caps: a step cap over the whole tree and a depth cap for calls, both generated.
- **Two families of action kind.** Port effects (`device_set`, `ifttt_trigger`) keep their rows and their runners. `tell_assistant`, `flow` and `run_automation` are run by the engine. `flow` and `run_automation` take no row in what a Gateway serves as actions, or phone N would offer them; what the editor needs for them rides a served field N ignores.
- **One canonical form.** `canonicalAutomation` becomes the one shape rule: flat when the steps are a top-level list of plain actions with the default wait and no cool-down, defaults absent, empty sides absent, a label never null. It runs on every write intent and on the parse op's answer, and the phone adopts the stored row. Both runtimes replay one vector file, and the rule is idempotent.
- **One walk over a body's actions.** `stepsOf` in `src/shared`, beside the action table, is the only reader of the actions a body holds at any depth. Its callers: `dangerousActions`, the judge's `unconfirmed`, the outside-reach ask, `effectIssue`, the hole texts and their check, `tellWhen`, `rulesOfAutomations`, and the phone's `actionWarning` and `freshAction`. A residue test refuses a direct `.actions` read outside it.
- **Order:** a fire holds a cursor (a step path), when the cursor arrived, and per step its word, its verdict, its attempts, its time and the side an If took. One step per fire runs at a time. At most one started fire per automation: a newer one waits unstarted, a newer non-event one replaces a waiting one, and event fires wait in arrival order up to a small generated count. The fire queue holds more than the automation cap, so a full set of live runs still admits a crossing and a called run.
- **The four words** from the part that talks to the device: `done`, `refused`, `unreachable`, `no_answer`. A connect that times out with nothing written is `unreachable`. Beside them sits a hold that is no attempt for any nature: ports not ready, devices not loaded, a lease that ended before its turn, the close fence. It is waited inside the step's wait, so a Toggle at boot does not fail at once. The words ride a `word` field beside a run row's `outcome`, and a run row names its step path, which the standing-refusal rule keys on.
- **Natures:** `sets`, `sends`, `nudges`, declared beside the device verbs (the road's `DeviceEffect` derives from that table) and on the action row, served on the row and on each verb option. One pure table, nature against word, answers retry, ended well or ended failed, and what a claim found at a start means: `sets` goes back to pending, `sends` and `nudges` take `no_answer`. `nudges` is one attempt.
- **An attempt is short and the runner is fair.** Each attempt has its own bound of about ten seconds, wired through to the plug. Retries back off from five seconds to a minute. The runner takes any step's first attempt before a retry that is due.
- **Keep trying for:** 10 minutes by default, each step its own. Step k may start while the clock is before the fire's time plus the waits of steps 1 to k, its own included, and its attempts end at the earlier of its own start plus its wait and that sum. The start is the cursor's arrival, clamped to now so a clock stepped back stretches nothing. A step the bound skips ends failed. A tell waiting on a full outbox holds the cursor, adds no age and moves the bound of the steps below it by the time it waited.
- **A failure branch** runs when its action ends failed, and the run ends at the branch's end. Without one the failure is logged and the run carries on. A branch's steps take their own waits from when the branch is reached.
- **A tell is a step.** The lane tells only an event automation's leading tells with no message, before any other step, and only for a fire the lane caused. Every other tell, and every tell of a called or pressed run, goes through the outbox under a member built from the automation, its incarnation, the key and the step path, digested together. The lane's `decide` and the fire road read an event's cool-down through one function. The cool-down's last time lives in automation state beside `ran`.
- **If:** read in the async slot beside the fill, its answer and side stored on the fire before the cursor moves. Exactly true takes `then`, exactly false takes `else`, and a condition that cannot be read takes neither, logs a failure and carries on (Q56). `and(a, b)`, `or(a, b)` and `sensors.value(device, key)` join the console. An If holds the display unit its condition was written in and is read in it, so a later change of unit does not move a threshold.
- **Run an automation (Q59):** the caller waits. The called run is its own fire linked to the caller's step.
  - The caller's step is held on the child's member. The child's end lands the caller's word in the same commit: failed when any step of the child ended failed, whether or not the child handled it.
  - A child crowded out, retired or missing at a restart ends the caller's step failed. A target that is gone, off, unfit, or whose names cannot be read ends it `refused`. An edit of the caller lets the child finish, unlinked.
  - The child's bound is the caller's bound for the call step plus the child's own waits.
  - Every fire carries its call chain: the origin member, then each caller's id and step path. A run is refused when its target is already in its own chain. A child's member is the origin member plus the chain, so a restart replays nothing and two calls of one target stay distinct. A budget of children per origin and the depth cap bound the rest. The origin is an event's member, a crossing's or value's member, a clock's slot, or a pressed Run's call id.
  - A called or pressed run never replaces a waiting fire and is never replaced, never moves a crossing's last time and never counts against an event's cool-down.
  - A target fits when its trigger is `called`, or every hole and every condition in its steps names only names readable when called (`whenCalled` on each trigger name) or entities.
- **Graph checks live in the judge, for an owner's put alone, as a change against the held record:** refused when the put adds or changes a call that closes a loop, names a target that is gone, or makes this automation stop fitting while a caller holds it. A toggle or an edit that leaves the calls and the fit alone asks nothing, so a row in a loop can always be switched off. A carry, an adoption and a conversion never refuse on the graph. A graph problem is its own line on the row. Removing a target is allowed and its confirmation names its callers.
- **Outside reach** is asked once per automation: when the candidate has an event trigger and an action beyond telling the assistant, anywhere in its tree, and its incarnation has not been acknowledged. The acknowledged set lives in automation state, never on the wire. **Words** rides the same confirmation: a hole reading an event name inside a parameter of an action whose row says it leaves the Gateway is named with its span.
- **An edit in the middle of a run** retires the fire, as today. The log names the step it stopped on and the row says which steps did not run.
- **What the map reads:** per automation `lastRun { at, revision, steps }` with each step's word, verdict, attempts, time and side, and `current { path, since, attempts, state }` for a fire in flight, written from the landing that writes the log row and served on the row. Cleared when the steps change, never by a toggle.
- **Cards draw one level:** a list, an If with two sides, a failure branch on any action, a side's action included. An If inside a side or a branch, and a branch inside a branch, are past cards. `cardsDraw` is a pure rule over the stored automation and the Gateway's offer; past cards, or for any node holding a field cards do not draw, the steps are edited as script alone. A node of a kind this build does not know is kept and saved raw.
- **A move:** before one, the phone checks that the destination serves every trigger, action and step kind the carried set holds at any depth, and refuses with the reason when it does not. Unchecked, the destination drops what it cannot parse and the source's let-go then deletes it.

Slices, each ending green, the Gateway's part deployed before the phone's:

1. **Engine prep, no wire** (Gateway, M). The four words and the hold beside them, the road's split of not begun from unreachable, the attempt bound, the backoff and the fair runner, the nature table and the verb natures, the restart rule by nature, an outcome kept per step, one started fire per automation with the larger queue, the wait and its bound, the run row's `word` and step. Effects of a flat list run in order; tells stay merged and outside the order until slice 3, so a tell may precede its effect by the step's wait. Gates: a restore test over today's state file, a held fake plug retrying while a second automation's step starts within one attempt bound, 64 stuck runs still admitting a crossing, bound vectors for a late clock slot, a crossing, and downtime before, inside and after a failing step.
2. **The wire** (Gateway M, phone S). The schemas above with the canonical form and its vectors, `stepsOf` with its residue test, the two families, the served field, codegen for a recursive preserve root (failing on a cycle it does not resolve by id) with the future-kind fixtures, phone-encoded cases for a flow, a step and an unknown node at each depth re-encoded byte-equal. The judge refuses a put naming a new kind with a fixed reason until slice 3, and a carried row holding one reads invalid and never runs. The phone adopts the types and draws the new kinds as kept. Gate: every row phone N finds drawable builds a body the Gateway accepts.
3. **The tree engine** (Gateway, L). The cursor walk, the failure branch, a tell per step with the lane's rule and the outbox member, the cool-down through one function, `lastRun` and `current`, outside reach and Words, the mid-run edit's log line. Gate: a restore test over slice 1's state file.
4. **If** (Gateway, S to M). The step, the async slot, `and`, `or`, `sensors.value` with its row in the console's read-only test, the stored unit, and a condition preview as its own op answering true, false or why unread.
5. **The phone's model** (phone, M to L). Steps addressed by path, `cardsDraw`, the canonical twin, the check before a move. Pure rules with a JUnit each: the path edits (insert, remove, move), `canRemoveStep`, `addableAt`, `stepIssue`, `textAt`.
6. **The cards** (phone, M to L). The If card and the failure slot, the condition in the full-screen editor's expression mode with "true right now", the nature line, Keep trying for, an event's cool-down. Pure rules: `conditionPaint`, `conditionAssist`, `withBareName`, `truthPreviewOf`, `natureLine`.
7. **Calls** (Gateway M to L, phone S to M). The linked child fire, the chain, the budget, the judge's graph checks with their vectors, the fit both ways, a Run op carrying a call id through `createOpDedupe` with a `runnable` reason served per row; the target picker, the "Only when another automation runs it" choice, the Run button, the carry's rule for called helpers. Pure rules: `runTargets`, `runsStored`, `runLine`.

Size: about 3,000 to 4,000 lines over both sides with tests.

Decided here, to be told to the owner with the slice list and changed if they object:

- An automation that fires again while its run is live waits its turn; a clock or a sensor replaces whatever of its own is still waiting; outside events wait in order up to a small count.
- Run pressed on a switched-off automation runs it once, as a routine's Run does. A call from another automation still respects off.
- An edit in the middle of a run stops that run, and the row says what did not run.
- An IFTTT post that left and got no answer counts as failed, as accepted in Question 54.

Asked, unanswered:

- When the assistant moves to another Gateway, what happens to the automations its automations run. Recommended: they move with it, and one that something staying behind also runs blocks the move until fixed. Either way the destination lands a caller whose target did not come as unfit with a visible line, and never binds the call to another row holding that id.
- Whether a failure branch still runs when the Gateway was down past the step's wait. Recommended: yes, however late, since it is usually the safe state.
- Whether flows are built before or after what 2.7c already holds is installed and walked.

## Phase 2.7f - The script and the map (Q50, Q57, Q58)

Second draft with 2.7e. Stands on it.

Design held for the phase:

- **The script is a view of the steps, and the steps alone.** The trigger and the automation's own settings stay in their forms above it, and the script page heads with the Gateway's sentence for the trigger. The view is part of the draft (`AutomationDraft.view`: cards, or script with its text, its last parse and the text that parse was asked for), so the changed check, the inner page and the leave rule read one value.
- **An action is a call (Q58).** Each action kind is one registered method built from its row in the action table, with typed parameters, a description and its nature. A doing method is served to the script alone: the console's eval, the agents' door and a message hole refuse it, and the read-only fence test holds that.
- **A statement** is one call to a doing method with an optional failure block, or an If with its blocks. There are no expression statements. The spelling of the failure block is Question 60.
- **The console's lexer is untouched:** `lexConsole`, its keywords and its token vectors stay as they are, since `if` as a keyword there would turn the builtin `if(...)` and every stored hole using it into a literal. The script's words are read by their text at statement position alone. Gate: every console vector and every hole fixture through the script path yields identical tokens.
- **Round trip:** `parse(print(t))` equals `canonical(t)` for every tree the schema admits, pinned by a corpus over a fixed table of devices and automations. The printer has its own number encoder (no exponent, full precision) and string encoder (only `\\` and `\"`, so a hole's `\{` survives), each with vectors.
- **Names:** the tree holds ids. The printer writes a device's or an automation's name when exactly one holds it and the id otherwise, with a label for the phone to draw beside an id. The parser reads an id first, then a unique name, and a reference that resolves to nothing is an issue at its span.
- **Checked at save:** every call's arguments against its schema, a condition as a truth, every name, each with its span in script offsets, mapped through string escapes.
- **The phone holds no parser.** A pure `scriptRegions(tokens)` finds statement positions, the condition between `if` and its brace, and strings with an offset map through escapes, pinned by vectors generated from the Gateway's parser. `scriptPaint(tokens, offer)` paints the structural words, compiled in, and the action names, from the served rows. Completions come per region from `consoleAssist` or `holeAssist`. A parse is asked after typing settles and an answer for text that has since changed is dropped.
- **The map** draws from `lastRun` and `current` alone. `edgeStyle`'s spec names, for each styling channel the owner approved in Question 50, the field that feeds it, a skipped step and a step never reached included.

Slices:

1. **The script on the Gateway, read-only on the phone** (Gateway M to L, phone S to M). The grammar, the parser, the printer, the doing methods under their own audience, a print op and a parse op, the corpus; the phone's read-only script page. Pure rules: `scriptSpans`, `scriptRegions`, `scriptPaint`. The parser lands with the printer, or the corpus cannot run.
2. **Script editing** (phone, M to L). Pure rules: `viewsOffered`, `toScript` (refused while the draft is unfit), `toCards` (refused on an issue or a tree past cards, the text kept), `scriptChanged`, `parseAfter`.
3. **The flow map** (phone, L). `flowLayout`, `edgeStyle`, `replayFrames`, `mapChosen`, `pillOf`, the Map and List toggle, replay per automation.

Size: about 1,500 to 2,000 lines over both sides with tests.

Later, on the same footing: a block whose steps start together, a block that groups several steps under one failure branch, a name held across steps, a state written as an assignment, the owner running a doing call from the Console page, the assistant's own actions read from the action table.

## Phase 2.7d - Walk-through and cleanup

- With the owner: the Sources and Automations pages on the phone, GitHub's four wake automations checked or re-entered, one added and one edited, a real notification and a sensor crossing reaching the assistant.
- Remove the dated legacy readers; rewrite `plans/watcher-instances.md` on the new vocabulary; docs.
- **Dated shims become a table** (from the 2.7b architecture review, class "a skew window opened for the reader and not the writer"): one row per window naming its writer, its readers and its closing date, shim sites tagged with the row, and a residue test that fails on a passed date or a tag with no row. Six dates in `schemasAssistant.ts`, `schemasRoutine.ts` and `boardService.ts` have already passed and each needs tightening or a new date. The twins `rulesOf` and `rulesOfAutomations` go with the rules on 2026-11-28, and the sandbox stops composing a sentence.

## Painpoints

- **A read named `list` writes.** `createVaultDecisions`'s `list(now)` sweeps expired grants and saves the file, and `composeVault`'s `watcherGrants` reached it through every watcher state read, so a console read wrote the vault. Nothing in the name or the type says so; it took a red team to find. Other stores may sweep on read the same way, and the live console's fence only covers the stores it builds for real.
- **BlueZ readiness is a hand-paired call at every transition.** Each `link =` in `createBluezCoordinator` needs its own `settleReady()`, and the one after `SetDiscoveryFilter` was missing, so a hold that changed the filter mid-scan always timed out. Boarded as a commit helper.
- **Four components, no version handshake.** The Router ran `0b8cea42`, the Gateway a tree from before `2f2bc843`, the phone and the plugin HEAD, and the only symptom was `no_holder` from a tool. `setup.sh --verify` compares package versions, which every commit between releases shares, and `registerGateway` reads nothing of the Router's protocol version. Boarded: a Gateway-side Router minimum at register, a build sha in `/health`.
- **A refused console op decodes as a missing field.** The phone's `report_read` against the older Gateway logged `Field 'advanced' is required`, since the refusal object was decoded as the result type. `ConsoleClient.sendValueAnswer` keeps the refusal's reason out of its log too. The real cause (an unknown `stream` key) was found by dating containers against commits.
- **Three moving parts to move the assistant's plugin.** The marketplace cache (`claude plugin update`), the running MCP process (only a restart replaces it) and the assistant's launch (`/exit` in its tmux pane, then a message). A wake alone looks like a restart and is not one. The deploy section now says the order; a single script would be better.
- **`scripts/kotlin-gate.sh`'s tail says little.** "26 actionable tasks: 1 executed" after a source change reads as if nothing compiled; the compile ran in an earlier Gradle invocation of the same script. Confirming the new tests ran meant reading `build/test-results`.
- **Driving the Pixel over adb is hand-rolled.** `input text` breaks on a parenthesis, every walk is tap coordinates from a screenshot, and a chained sequence once landed in Calendar. On the board already: scripted emulator and phone walks.
- **`AssistantScreen.kt` attracts decisions.** Every page added this stretch began with a rule inside a Composable (the askable door, the gear target, the Required rows, the switch guard) and each had to be pulled out into `AssistantPermissions.kt` after an audit named it. The file is past 600 lines; a split by page is due.
- **No one gate script.** Every push this stretch ran a hand-typed chain (`gen:capabilities`, stage the fixture, `lint`, a named subset of `test`, `check:fixtures`, `check:capabilities`, `kotlin-gate`), and the chain varied by hand each time. The subsets missed `ifttt-client` once and the phone harness once, which cost four red CI runs; the whole suite is 22 seconds. A `bun run gate` that runs the lot, codegen included, would have made the subsets pointless.
- **The capability fixture has two gotchas for one file.** `gen:capabilities` renders JSON by hand, so a two-element array came out in a shape Biome refuses, and `check:capabilities` diffs against the git index, so the fixture must be staged before `lint` or the check fails on a file that is right.
- **No scripted CI watch.** `AGENTS.md` says to check `gh run list` after a push; the watch loops written for it used a `--commit` flag this `gh` lacks and silently never reported, so CI sat red for three pushes. A `scripts/ci-watch.sh <sha>` would be a line to call instead of a loop to write.
- **The assistant's resumed pane lies about what is done.** After `/exit`, the next wake resumes the transcript, so the pane shows the previous turn's "done" lines before the new turn starts; a wait keyed on "done" has to compare times. Boarded under the panel's missing test bed: the same blindness from the other side.
- **A workflow whose steps all fail still settles as succeeded.** Eight Luna steps hit the usage limit, each answered null, and the Opus join ran on nothing and improvised. A script gets null for a quota limit, a crash and a decline alike, so it cannot fall back to another backend for that step or stop. Nothing checks a backend's quota before a run starts; Luna and OpenCode Go ran dry within minutes of each other.
- **A scripted rename compiles past what it broke.** Renaming watcher to source by token over `src/gateway/assistant/` and `composeAssistant.ts` changed a push's `actionType` and payload key, a stored snapshot key, two data file names and an action family literal. `tsc` flagged the typed ones; the rest hid behind spreads (`...(options.watchers ? { watchers } : {})`), string literals and JSON written to disk, and were found by reading the diff line by line. Wire and stored names that live as bare literals beside the code that uses them are the cost.
- **A source's tests can skip the lane's parse.** `createSourceLanes` runs every poll answer through the strict `PollAnswerSchema`, but a test that calls `source.poll()` reads the raw object, so a field the schema refuses passes every test and backs the lane off for good in production. The outbox's `when` did exactly that. The automation tests now poll through the schema; nothing makes the next source's tests do it.
- **A new member in a stored union is a rollback hazard nobody is shown.** `createVaultDecisions` restores with one strict `GrantsSchema.parse`, so a row the previous build does not know makes it start empty, and the next write persists the empty store. The same holds for any strict snapshot. The rule "read a release before you write" is in the plan now, but no gate reads a store's schema against the build before.
- **`composeAssistant.ts` braids five concerns.** Rules, grants, the home's apply and let-go, the lanes and the console handlers share one 950-line closure, so replacing rules with automations touches `apply`, `letGo`, `state`, `sourceOf`, the inbox listing and four handlers. A split by concern is due before 2.7b lands in it.
- **A re-check on the phone needs the owner twice.** A reinstall brings the app's fingerprint prompt back, so the build that carries a screen fix cannot be looked at unattended. And in an adb chain joined by `;`, a command that fails (a bracket in `input text`) does not stop the taps after it: the Console got two junk reads that way.
- **A relay that dies mid-task leaves no ledger.** Luna hit its usage limit with eleven red-team fixes in the tree, one focused test red and no record of which items were landed, half-landed or untouched. Reconstructing that from the diff cost more than the fixes. A relay brief should ask for a per-item status line the moment each item lands, so a cut-off report is still a ledger.
- **A strict restore wipes a whole file.** `openDurable` quarantines a file whose consumer throws on restore, so one extra key in one row of a strict schema loses every row. Each new store rediscovers it: `SessionStore` holds unread records, `createOwnerRecords` holds unread bodies, `createAutomations` (`restore`) parses rows one at a time, and `computedFields.ts` loosened its row schema after a red team found it. No shared "restore rows alone, hold what you cannot read" helper exists, so the next store will write its own or forget.
- **A comment pass breaks exact-match edits.** The Luna comment passes reword comments between my edits, so a scripted replace anchored on a comment fails on the next round (it did, on `automations.ts`'s construction call). Anchoring on code, not comments, avoids it.
- **A test double's semantics lived nowhere.** `fakeKasaPlug.ts`'s `hold` applies the command and withholds only the reply, and `waitForHeldReply` answered at once while any earlier reply was still held. One test was written against the opposite reading of each and passed for the wrong reason until a second hold exposed it. A double's first lines should state what each behaviour does to its state.
- **A reserved string prefix nobody new knows about.** `refused: ` is the board authority's marker, fenced by `board-refusal-residue`, and a device refusal spelled with that prefix failed only in the whole suite. The fence is right; the surprise is that nothing near a new module says the prefix is taken.
- **Red team before architecture patched a class four times.** The first red team named the handler class (every handler open-coding the deadline, the queue, the fence and the failure map); the fix round, the re-audit and its fix round each patched instances, and the architecture step then deleted all of it for the road. When a round-one finding is a Bug Classes entry, the cycle should jump to the architecture step before any fix round.
- **No one place lists the per-surface waits.** The console answers inside `CONSOLE_ANSWER_WAIT_MS` minus a hop margin and the assistant inside `ASSISTANT_WAITS.action`; the first stage bound every console op at the assistant's sixty seconds because nothing a Gateway handler reads says which surface it serves. The road now picks per surface, but a new stage would make the same mistake.
- **The emulator variant compiles under no gate.** The Opus agent could not check its thread change on the sandbox because `SandboxFixtures.kt` passes a String rank where a Long is expected, broken on main for some time, and `kotlin-gate.sh` compiles only the debug unit tests. Boarded.
- **Luna cannot compile Kotlin.** Its sandbox refuses Gradle's wrapper lock under a read-only `~/.gradle` and refuses sockets, so the slot refactor arrived with eight compile errors it never saw, and every Kotlin delegation needs a compile round here. A repo-local `GRADLE_USER_HOME` in the brief, or a writable one in the sandbox, would close it.
- **No emulator without the seat's KVM grant.** `/dev/kvm` carries an ACL for the logged-in seat user only, so a session with nobody at the seat cannot start one. The sandbox build was walked on the owner's Pixel instead, beside the real app, where every reinstall raises a notification-permission dialog that only an adb grant clears.
- **Residue fences that match substrings fail on the wrong code.** The AAD fence read `switchboard.nameReady` as the board kind `board.name`, and the cancellation fence counted a new suspend `remove` as a call inside an unrelated `catch` because it matches suspend names phone-wide. Both cost a round of diagnosis for a correct change; a fence should match tokens in their syntactic position.
- **A new protocol fixture schema is three hand edits.** The manifest, the TS `SCHEMAS` map in `protocol-fixtures.test.ts` and the Kotlin `decodeAs` in `ProtocolFixturesTest.kt` must each learn the name, though codegen already knows every meta id.
- **Three freshness mechanisms for per-Gateway answers on the phone.** `GatewayReadFence` keys, `PublishedViews` tickets (and now `SlotViews`) and `GatewayEntry.withEntry` each answer "may this land", and a new ops class picks one by imitation. Two of the three are boarded for convergence.
- **`composeGateway` binds stages backwards through `let` slots.** `devices`, `fields`, `automations` and `sensorThresholds` are `let ... | undefined`, read from closures handed to stages composed earlier (`devices?.record(id) ?? null`, `sensorThresholds?.forget(device) ?? true`, `fields!`). A default like `?? true` or `?? []` silently answers for a stage that is not composed yet, and order bugs look like empty data. The sensors watcher needed a hand-copied proxy for exactly this reason until `registerWatcher` replaced it; the next stage added this way will meet the same choice.
- **The test phone speaks TypeScript.** The harness's phone driver encodes with the same Zod-shaped objects the Gateway parses, so 4650 green tests never ran the Kotlin encoder against a Gateway schema, and a move that every Gateway would have refused shipped as far as the audit. `tests/fixtures/phone-encoded/cases.json` now holds three schemas' worth; every other value the phone sends still has only the TypeScript phone behind it.
- **The harness's fresh placement undoes its own setup.** `placed()` in `assistant-automations.test.ts` follows a home with nothing carried, which turns every source off and wipes the event automations, so a test that seeds rules or needs a source enabled must do it after placement. It surprised two new tests in one night (a preview refused as "disabled", an adopted rule gone), each read first as a code defect.
- **The sandbox's older Gateway is kinder than a real one.** `SandboxAutomationGateway` answers an older build's put with `stored: false` and a reason, where the real client throws and the page reads "could not be reached"; its state also answers `sources`. The emulator walk therefore could not show what a phone does beside a Gateway on the build before, which is where three of the audit's findings were.
- **The three older editors are indented one level too deep with a brace that looks stray.** `RunbookEditor.kt`, `RoutineEditor.kt` and `PolicyEditor.kt` hold their content lambda's body at three tabs under a one-tab call, and each `if` closes at two. Removing one `if` block took three attempts and a brace count per file.
- **KVM access lapses each time the emulator stops.** The ACL on `/dev/kvm` is re-applied for the seat's user when the emulator exits, so each of three walks in one night needed the owner to approve `setfacl` again from the phone. Membership of the `kvm` group, or a udev rule, would hold.
- **Words kept for compatibility hide what is left to rename.** `assistant-watchers.json`, `assistant-watcher-enabled.json`, `watcherOf`, `watchers-changed` and the `assistant_watcher_*` kinds are all deliberate, so a search for a forgotten "watcher" returns mostly things that must stay, and 48 files carry a dated shim in prose that nothing reads. Six of those dates had passed unnoticed.
- **A comment pass sees nothing once the work is committed.** The cleanup prompt scopes itself by `git diff HEAD`, so the pass run after a commit found an empty diff and fell back to scanning whole files. Scoping it by a commit range would keep it on the lines that changed.
- **A Composable is where a rule goes to be skipped.** Three rules of this stretch lived in `App` or a Settings section and failed for the same reason: composition is not a lifetime. The app lock, a rotation and a second window dispose a page nobody left (`rememberEdit`'s old park); the Settings section that asks for a wipe leaves before the wipe answers (`DomainDangerSection`); and a swiped-away window never composes the effect that follows (`App`'s clean-up). Each was found by an audit, never by a gate, since nothing runs a Composable.
- **Every audit round found bugs in the round before.** Five rounds on this phase: 13, 16, 13, 15 and 11 confirmed. From the third on, more than half were defects in fixes made one round earlier, almost all at a seam between two holders of one fact. The rounds stopped paying once the facts had one owner each; the fence is the one that never got there.
- **"Does this land after a wipe" has no type.** `ProvisionFence`, the board and vault managers' own `generation`, `AssistantHomeFence`'s ticket, `GatewayReadFence`'s counter, `EditorSessions`' opening and `ChatPersistence`'s nothing at all each answer it differently, and `ChatRepository.clearAll` has to know all of them. A new durable write copies whichever neighbour it sees.
- **`ChatRepository.clearAll` wipes memory, and only some of the disk.** `identity.clear()` removes the provisioning keys, the holders' `clearInMemory` resets memory, `BoardManager.clearInMemory` never persists, and the state reset is never persisted, so "wiped" depends on which store a thing lives in and whether anything writes it back. The plugins' own stores (`DesignStore`) sit outside all of it and were only reached from a screen.
- **Tests that simulate a re-provision each wrote their own.** A dozen test classes called `generation.advance()` then a `clearInMemory`, in an order the app did not use, so the first change to the wipe's order hung the suite on a test waiting for a send that could no longer be admitted (`ComposedRequestsTest`). `reprovision` in `OpsTestSupport.kt` is now the one helper; the real `clearAll` is still not what they run.
- **A file write that says "created" can be an overwrite.** A new test was written over `DomainAdminOpsTest.kt`, which already existed, and the gates stayed green because the lost test simply stopped running. Nothing compares the set of tests before and after.
- **`App` in `MainActivity.kt` is one thousand lines of one function.** Every shell rule is a local `val` or an effect inside it, ordered by what must be declared first, so a new effect lands wherever its inputs happen to be in scope, and a reviewer has to read the whole function to know what runs while locked. `ShellOverlays` took the tail out; the rest is as it was.
- **The phone's residue tests read spellings.** Four were written this stretch and each was shown a bypass within the hour: `shell-overlay-residue` only matched names ending in Dialog or Sheet, `editor-owner-residue` missed the very declaration it replaced. The two rewritten to read structure (what follows the screens in `App`; the order of every step in `clearAll`) held; the other two still match text.
- **Peers are the one Gateway list that is not re-read by its view.** `TrustOps.refreshPeers` is called from the trust screens and at welcome, nothing persists the answer, and `linkedPeerOwners` is rebuilt from whatever is in memory, so after a cold start a Domain is unlinked on the phone until each Gateway's peers happen to be read.

- **A fix written from one sequence closes the way out.** Three fixes of one round each refused on an unknown state and, with it, the owner's recovery: `AssistantLocationPage` lost the move off an unreachable home, `issueOf` in `assistant/AutomationActions.kt` blocked the save that would remove a home-only action, and `peersLanded` in `TrustOps.kt` held an untrust behind an offline Gateway. Each was correct for the sequence its finding named. Nothing in the repo lists, per page, the states an answer can be in against the acts the page offers, so every such fix is checked by hand and the audit brief had to grow a "name the recovery path first" line.
- **The phone drops what it does not know, except an action's kind.** `wireJson` ignores unknown keys, a toggle sends `row.automation.copy(enabled = ...)` in `AutomationOps.kt`, and `toAutomation` in `assistant/AutomationDraft.kt` rebuilds the record from the fields this build has. A new optional field on a record or on a known action is therefore lost by any older phone on a toggle, an edit or a home move, silently, which forces every later feature to arrive as a new kind. A raw passthrough for record fields would end that constraint.
- **Time is the wall clock everywhere in the fire road.** `Sighting.since` and `retryAt`, `EFFECT_LATE_MS`, a clock's stored slot and the outbox's retention all compare `deps.now()`. Each clock-step finding took its own patch (`retryDue`, `skip` on a slot, the restart from now), and a forward step still refuses pending effects. `Ambient` offers no monotonic reading, so every new deadline repeats the class.
- **The run log's dedupe has been patched six times.** `logged` in `automationLog.ts` keeps one 64-row ring for every automation and decides by comparing the last row under a key; each key hid a row the next finding wanted (per automation, per action, standing reasons, lost runs). It wants rows with a declared kind and a ring per automation.
- **`automations.ts` grew through every fix round** to about 1,150 lines with the pump, restore, validity, wording and the store door in one closure. The pure rules moved out (`automationFires.ts`, `automationOutbox.ts`, `automationLog.ts`); the state, validity and wording moves and one builder for the automation pair are still owed, and each round that lands first makes the move larger.
- **A working day's load takes the host down.** One Gradle gate (test workers and the Kotlin daemon), the Android emulator, Lexicon's TypeScript provider for this repo (7.6 GB at its peak) and several agent sessions exceeded 30 GB, and the kernel's OOM killer took the desktop session with a 6.7 GB `bun`. `scripts/kotlin-gate.sh` neither caps Gradle's workers nor stops its daemon, and the emulator is started and stopped by hand. A walk script that refuses to start beside a Gradle run, and a gate that stops its daemon, would have prevented it.
- **The emulator's Gateways are uneven, and the list of what they cannot show lives outside the repo.** `SandboxRoutineGateway` answers a fixed list and forgets a save, `SandboxAutomationGateway` keeps one, the Users page reads a Router the sandbox never reaches, and whether `parsing` reads as an older build depends on which answers the phone happens to read. Each cost a walk finding to rule out. The walk guide with its known gaps is a scratch file; `docs/testing.md` should hold it.
- **A dated shim classifies before its reader can.** `listAnswerOf` folds a prose refusal into `NotServed` under `ProseRefusal.OLDER_BUILD`, so `AutomationOps.refresh` could not tell the permanent token from the shim's prose and needed a side flag (`AutomationListing.prose`) to apply the rule only to prose. The first attempt demoted the token too.
