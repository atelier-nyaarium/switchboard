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

## Design rulings, mocked in the Designer dock

- **Pair with** (a dialogue over the family's entry page after Scan): Found rows merged across every radio with signal bars from the strongest, untested rows marked "Not tested" (a known format) or "Not tested · raw only"; Paired rows below with their live value. The dialogue lists the Gateways that heard the device, strongest first, then This Phone last, each with a chip: "Assistant" (home, and This Phone) or "App only". Owner: "looks good".
- **The sensor page:** the name; brand, holding Gateway and the reading's age under it (a trouble line instead when stale); Readings, one row per declared field with value, unit and the 24-hour low and high with times; Alerts, one row per threshold with its value in the owner's unit and a switch, then the dead zone, with "Alerts go to the assistant's inbox"; Name with Rename. Remove device lives in the top-right menu, on every device page, the plug page included. Owner: "Move remove into the menu top right. most people aren't going to this page to remove."
- **An untested device:** Raw: the last distinct payloads, each with time and radio, bytes as hex with offsets under them, bytes that differ highlighted; Name. A known-format model shows the sensor page as any sensor. Owner: "looks good".
- **Integrations by Gateway:** one group per Gateway that offers devices; the home's group carries the "Assistant" chip, others carry none. Rows as in 2.5d (name, brand, a trouble line only when there is trouble); a plug keeps its switch, a sensor shows its main value, greyed when stale; a This Phone device sits in the home group with "This Phone" in its brand line. Services stay below. Owner: "remove the app only chip here."
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

## Painpoints

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
