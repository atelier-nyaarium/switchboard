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

## Question 60 - How is a failure handled in script?

Q: Which form: the classic try and catch, a whole-script catch alone, or undo as you go?
A: Classic. `try { ... } catch (e) { ... }` in its traditional meaning: the first failure inside the try jumps to the catch and the rest of the try is skipped, `e` names what failed and how, and after the catch the script carries on. A `stop` statement ends the run. This refines Question 53: ending the run after a failure is written, not implied, and cards write it by default. A failure outside any try is still noted and the run carries on. The answer came after three takes, recorded below.

> A

The takes that led there:

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

Put back as a method on the call taking a block (`devices.set(...).failure { ... }`, recommended), a plain `if` over the call's result, or the floating words. The owner declined all three and asked for the try and catch family:

> hmm. I don't like that either. What about a try catch style? think about multiple languages and see what variants you can think of

Variants shown, each as a sketch in this language:

1. **Classic** (JavaScript, Java, C#): `try { ... } catch (e) { ... }`. The first failure inside jumps to the catch and the rest of the try is skipped. `e` names what failed and its word. After the catch the script carries on; a `stop` statement ends the run.
2. **Catch by kind** (Java, Python): `catch (unreachable) { ... } catch (refused) { ... }`, the four words as the kinds.
3. **With `else` and `finally`** (Python): a block for "nothing failed" and one that runs either way.
4. **Mark the calls that matter** (Swift's `try x`, Rust's `x?`): inside a block, only a marked call jumps to the catch.
5. **One handler for the whole script** (shell `trap`, Visual Basic `On Error`, Ruby's method `rescue`): a trailing `catch (e) { ... }` with the whole script as the try. This is the fallback on the automation the owner first described in Question 48.
6. **Undo as you go** (Zig's `errdefer`, Go's `defer`): `undo { ... }` after a step; when something later fails, the undos registered so far run, newest first. Rollback for what cannot roll itself back, in the spirit of NyaaDot's transactions.

Two places where the earlier answers part from tradition, named to the owner: Question 53 ends the run after a failure branch, where a traditional catch carries on (a written `stop` covers it); and a failure outside any try is logged and the run carries on, where JavaScript would abort.

Asked: the classic form with `e`, its traditional meaning and a `stop` (recommended; 2 and 3 fit it later, 5 is a script whose whole body is one try); the whole-script catch alone; or undo as you go. The owner took the first.

What follows from it, told to the owner: a failure slot on one action in cards is a try around that action, and a try around several is a group card; a condition that cannot be read is a failure, so inside a try it jumps to the catch; a called automation reports failed when a failure in it went uncaught, which narrows what Question 59 was told ("handled or not").

## Question 63 - Is a `stop` needed, and what does `e` hold?

Taken as settled on 2026-11-18 and told to the owner, since the words were theirs and nine later answers built on it: no `stop`, `exit` bails out, `e.code` and `e.message`, a Try card, and a `throw` outside any `try` ends that function as failed. Theirs to change.

> Do we even need a stop when the language becomes centered around braces like if statements?
> Maybe an exit for an early bail in deeper code?
>
> e.word? singular? like a .code? or a .message?

Put back to the owner:

- **No `stop` in the core.** What should not run after a failure goes inside the `try`, as in any brace language, so the catch needs no word to end the run. This drops the "then stop" default told under Question 60, and Question 53's "the branch ends the run" becomes a matter of where the lines sit.
- **`exit` as the early bail,** the owner's word: it ends this automation's run from any depth, without failure, and a caller carries on.
- **`e.code` and `e.message`.** "Word" was the drafter's own term. `e.code` is the short fixed value to branch on (`refused`, `unreachable`, `no_answer`, and `unread` for a condition); `e.message` is a sentence for people, and a bare `{e}` prints it.
- **In cards,** a Try card beside the If card, each with two slots, and no failure slot per action.

## Question 67 - What happens to called functions when the assistant moves Gateways?

An outside-event automation lives where the assistant lives and moves with it; a sensor or clock automation stays with its Gateway; a called automation has no trigger tying it anywhere, and a call works only when both sit on one Gateway.

Asked as: functions follow what calls them, and one that something staying also calls stops the move first and names it (recommended); a copy lands on the new Gateway when both sides call it; or nothing follows and a call that lost its function is marked broken. Under every answer a call that lost its function reads broken on its row and is never bound to another automation holding that id.

A: Functions follow what uses them, "sort of": the answer came with a larger model. A function is a reusable block, as a data-block is in Blender. A trigger points at a function, several may point at one, and a device may point at any function it is compatible with. The editor shows how many things use the function, so an edit's reach is known, and offers a copy that is this user's alone. A function with no users is deleted. The design is mocked in the Designer before anything else.

> A. sort of.
> Functions as a reusable. Devices uses functions. You can point 2 thermostats at a function. Can point a device at a function as long as it's compatible.
> We can potentially show a count on the editor so you know how many you are going to impact. Or copy off to be unique.
> Kinda like Bledner and "users" where you can point multiple nodes to the same data block.
>
> functions with 0 uses are deleted.
>
> Designer first

Read as, and mocked in the Designer dock (`functions-automations-list.html`, `functions-editor.html`, `functions-picker.html`, group "Phase 2.7e Functions"):

- An automation is a trigger pointing at a function. The common case is one function with one user, drawn as today.
- A function's signature is the values it takes, each with a type. A trigger fits a function when it can fill every one, by name and type; a function that takes nothing fits anything.
- The editor's "Runs" block names the function, shows "Used by N", lists who else an edit reaches, and offers "Make unique". Its arrow points the automation at another function, from a list split into what fits and what does not, with the reason.
- The Automations list shows each row's function and its user count when above one.
- The "only when another automation runs it" trigger of Question 51 falls away: a function used only by callers is simply a function.
- On a move, a function goes with its users that move; where users stay too, the mover takes a copy.

## Question 68 - On a move, what of a function with users on both sides?

Q: Do the automations that move take a copy, or does the move stop and ask?
A: They take a copy, as "Make unique" would give them. Nothing blocks.

As built, one thing does: a carry whose derived id cannot be claimed is refused whole (`no_key`, `no_free_id`).

> Compare a blink and GitHub trigger side by side.
>
> and A.

The picker card, as the owner reworded it: no "Fits this trigger" label; the second group reads "Incompatible triggers"; a reason reads "Requires event." or "Requires lamp, times."; nothing more is said on the row.

> get rid of label "Fits this trigger"
>
> And change the other one:
> - to "Incompatible triggers"
> - "This trigger gives none." remove it
> - "Needs" -> "Requires"
>
> Explain "Only another function can pass those." in programming terms. like TypeScript

Explained to the owner as structural typing: a trigger is a call site nobody writes, passing one fixed object type, and a function fits when that type is assignable to its parameters. Compared side by side on request: a function taking a GitHub `event` takes a value that can only be received, from a GitHub trigger or from a caller that was itself given one; a function taking `lamp` and `times` takes values no trigger gives but any code can write. Asked from it: whether an automation may fill a function's remaining values itself, so a device can point at such a function (Question 69).

## Question 69 - May an automation fill a function's values itself?

Asked as: the "Runs" block lists each value the function takes with its source, "from the trigger" or a value the owner sets there, so any function whose leftover values can be written is pointable (recommended; routines already keep a runbook's answers this way, and the Run button asks for the same values); or a trigger only ever passes what it gives, and such functions are reached by calls alone.

A: Yes. Each value the function takes shows its source in the "Runs" block: from the trigger, or a value set on the automation. The values set there belong to the automation, not to the function. In the picker, a function that takes another source's event, such as a GitHub event, is not listed at all.

> A.
>
> And looks good. If it is a source like GitHub, don't show it where Incompatible.

Following from the two answers, the picker's "Incompatible triggers" group has nothing left to list: a value the trigger does not give is set on the automation, and a function bound to another source is hidden. The group leaves the card and would return only for a value that can be neither given nor written. Mocked: the picker and the editor updated, and `functions-runs-block.html` showing the block with every value from the trigger, with values set on the automation (one still to set, which Save waits for), and one function shared by two thermometers with a room each.

As built, the group's cases are hidden rather than gone: a function reading a name the trigger lacks, such as `{value}` under a clock, and a declared value the trigger gives as another type, are left out of the picker as another source's event is.

## Question 70 - What happens to the rest of a run the Gateway's downtime interrupted?

Set apart from "Keep trying for", which is about a device that does not answer and is settled. The case put: fan on, `wait(10)`, fan off, and the machine goes down for three hours during the wait.

Asked as: resume everything however late; late means failed, jumping to a `catch` inside a `try` and skipped outside one; or by what the action is (recommended): an action that sets a state still runs late, a one-shot action (a toggle, an IFTTT event, a message to the assistant) fails with `e.code == "late"`, and a `catch` runs however late under the same two rules. A trigger that should have fired while the Gateway was down is a separate matter and still does not fire.

A: Part resume, part by the action's nature, judged on the step that was in progress when the Gateway went down. A step that is not idempotent is an error, thrown from that action, so a `catch` around it takes it. An idempotent step resumes while it is still inside its "Keep trying for"; past that it fails too, as a Gateway timeout.

> Part A/C.
> If the step in progress is not idempotent, it issues an error case. If there was a catch, it be thrown from that action or w/e.
> If good to resume, will just resumes assuming within the timeout period for that action. Else issues a fail as well for some sort of Gateway timeout.

Read as, and told to the owner:

- The codes: an interrupted one-shot step ends `no_answer`, the code a sent command with no word back already has, since nobody can say whether it happened. An idempotent step past its wait ends `timeout`.
- After that step the run goes on by the ordinary rules: a caught failure carries on after its `catch`, an uncaught one is noted and the run carries on.
- A step that had not started is not judged. It starts when its turn comes, with its own wait, however late that is.
- A `wait` whose time passed while the Gateway was down is over, and the run carries on from it. Taken as the default; the owner may say otherwise.

## Question 62 - What else belongs in the script's first version?

The language as it stood when asked: a statement is one doing call, an `if (cond) { } else if (cond) { } else { }`, a `try { } catch (e) { }`, or `stop`. Conditions are the console's reading language with `and`, `or` and `sensors.value`. Text takes `{ }` holes. `e.word` is refused, unreachable or no answer, and a bare `{e}` prints a sentence.

Asked as a pick of any: names held across statements (`cold = ...`, then `if (cold)`), a `wait(...)` between steps, comments (which need a place in the stored steps), `throw`, a `parallel` block, loops, the owner's own functions. Recommended: names and `wait` now, the rest when use asks for them.

A: Variables, typed as NyaaDot's are, so highlighting, completions and hint cards follow a variable into its members. `wait`. Comments. `throw` (the owner wrote "catch yep" under the `throw` example; read as yes to `throw`, and told so). Parallel work comes as built-ins on a first-party manager, designed next (Question 64). Loops and functions were not picked.

> Names? you mean like Variables?
> If we do it, it's got to be like NyaaDot where the variable understands it's types. So you get syntax and cards even down the body.
>
> wait is good.
>
> Yeah comments
>
> catch yep
>
> Parallel will have to come as a few built-ins.
> Let's think. Node provides Promises as a manager object. should we build ours in first party?
> Promise has all(), some() I think, and some other things. What would we need for parallel handling?

## Question 64 - How is parallel work written?

Q: Tasks with `start`, `await`, `all` and `any` plus a `parallel { }` block as the short form; the block alone; or built-ins on a manager?
A: Tasks, with the block as the short form. Built in two steps after the one-at-a-time core works: the block first, since it is the subset and what cards draw, then tasks. The answer came on the second take, below.

> A

First take, put to the owner. JavaScript's `Promise` holds `all`, `allSettled`, `any` and `race` (no `some`). Ours is first party by necessity, since the language has no functions to build one from, and simpler: every line already waits, so no promise value has to exist. A built-in takes calls unevaluated, as the lazy `if(...)` does today, and starts them together. Each argument is one call; a sequence run beside another goes in an automation and is run by it.

- `parallel.all(a, b, c)`: start together, wait for every one to finish, then fail if any failed. It does not bail at the first failure as JavaScript's does, since a command already sent cannot be unsent. Hands back the results in order.
- `parallel.settled(a, b, c)`: the same, never fails, hands back each result to inspect.
- `parallel.any(a, b)`: done once one succeeds, failed only when all fail.
- No `race`: a device command cannot be cancelled, so dropping the losers would be a lie.
- Possibly `parallel.start(a)`: start and do not wait.

What it needs. Language: a doing call hands back a typed result; built-ins that take calls unevaluated; an `e` that can hold several failures (`e.errors`). Engine: several steps in flight in one run and several effects at once on the Gateway, under a cap; each branch with its own wait, outcome, log line and place on the map; two calls to one device in a group run in listed order; each branch claimed alone, so a restart resends nothing.

Asked: `all` and `settled` (recommended, built after the one-at-a-time core works, with the stored shape and the types allowing for it from the start); those plus `any`; or real task values, started now and joined later.

The owner set JavaScript aside as the model:

> I suppose it's also bad to look at JavaScript and might be more appropriate to compare to other languages that came with parallelism. Tasks, await all, awaiting at least one, etc. Propose another style

Second take, from languages built with parallelism (Go's `go` and wait groups, C#'s tasks with `WhenAll` and `WhenAny`, Swift's `async let`, Kotlin's `async` and `awaitAll`, Occam's `PAR`, SystemVerilog's `fork` and `join`, Home Assistant's `parallel`):

- Everything still waits by default. `start` begins a call or a block and moves on, handing back a task. `await` waits for a task and hands back its result.
- `all(a, b)` is a task done when every one is; `any(a, b)` is a task done with the first, and awaiting it hands back that first task. The rest keep running, since a device command cannot be cancelled.
- A task is a typed value: `done`, `failed`, `result`, `error`, with completions and hint cards.
- **Nothing is left behind** (Kotlin, Swift, Python's trio): a script does not end, at its last line or at `exit`, while something it started still runs.
- A failure surfaces where the task is awaited and follows the ordinary rule there: inside a `try` it jumps to the catch, outside it is noted. `all` waits for every task before failing, with `e.errors`. A failed task nobody awaited is noted.
- A time limit falls out: start the slow thing and a `wait`, await `any` of the two, and test which came first.
- `parallel { ... }` as the short form: start each line and await all. It is what cards draw, as a card beside If and Try.

Asked: tasks with `start`, `await`, `all` and `any`, plus the block as short form (recommended, the block built first since it is the subset); the block alone; or the manager built-ins of the first take. The owner took the first.

## Question 65 - Is the trigger written in the script?

Q: Does the trigger stay a form above the script, or is it the script's opening line?
A: It stays outside, and for a reason of its own: an automation is a function, the trigger is its signature, and the script is its body. The trigger decides which parameters the body gets and their types, so the editor's hints follow from it.

> Think about an automation as a function. We never wrote the parameters though. So the trigger is outside, and initializes what types and language hints we even get for parameters. Then we can write the body.
>
> Thoughts?

Put back to the owner, as what the framing settles and opens:

- It is half built already: each trigger kind offers names to a message's holes (`event` and `source`; `value`, `device`, `measure`, `threshold`; `time`). Those are the parameters. The script gives each a type: `event` a record typed from its source's declared fields, `value` a number with its unit, `time` a time.
- The "only when another automation runs it" trigger is the signature the owner writes: its parameters, each with a name and a type. "Your own functions" stops being a separate feature and becomes a called automation with parameters.
- The call rule restated: a call supplies every parameter that has no value of its own. A crossing's or a clock's parameters can be read at the moment of the call; an event's cannot, so its caller passes one or cannot call it. This replaces "the caller's words never pass": passing is explicit and typed, and outside text passed along falls under the same outside-words warning.
- The Run button asks for the parameters, as a runbook's fire sheet does.
- The script page heads with the signature, shown and not typed.
- Still open inside it: whether a called automation hands a value back.

Asked next: whether called automations take declared parameters from the first version of calls or after it (Question 66).

## Question 66 - Do called automations take parameters from the start?

Q: Does the "called" trigger hold a parameter list from the start, with parameters built together with calls, or do calls ship with no arguments first?
A: From the start. The "only when another automation runs it" trigger holds declared parameters, each a name and a type, and they are built with calls.

> A

## Question 61 - What goes first: installing what 2.7c built, or building flows?

Asked as: install and walk what is built, then build flows (recommended); build flows in cards first and install together; or build everything, script and map included, then install. The reasons given: the app on the phone (8.14.82) strips a message from an automation on a toggle, so the newer app must be installed before a flow can be stored safely; what exists gets used and corrected before more sits on it; real use finds what an audit does not.

A: Install what is finished and walk it with the owner, then build the new design on top. The owner asked which quick patches should ride along with the update and restart.

> A. any quick patches you want to hitchhike in with this update and restart?

## Question 71 - Which quick patches ride along with the install?

Offered: the host token read by the daemon's own script and replaced with a fresh one; two message editor fixes (the "Names here" row clipping an event's value, a picked completion leaving its hole open); the op store's eviction line said once a minute; a notice when every sensor on a Gateway's radio falls silent.

Q: The three small ones today with the notice right after as its own update, all four together a day later, or the three alone?
A: The three small ones today, then the sensor notice as its own update. The owner gave the go-ahead for the checks, the plugin release and the Gateway and daemon restarts. The phone waits for a separate word.

> Go ahead
> A.
> all fixes sound good

Told with it, as defaults the owner may change: an automation that triggers again while running waits its turn; Run pressed on a switched-off automation runs it once while a call still respects off; an edit in the middle of a run stops that run and the row says what did not run; a script writes a device by its name when unique and by its id otherwise; an If keeps the unit its condition was typed in.

## Question 72 - How does OpenCode work again on a version other than the pinned one?

Q: The host holds OpenCode 2.3.0 and the build accepted 2.2.5 alone, so every OpenCode session and agent was refused. Move the pin, accept a range, or drop the check?
A: Drop the check. OpenCode runs on whatever version is installed. The pin stays as the version this build was tested with, which setup installs, and a real failure on another version names both versions.

> cut out the exactness check. Just have a warning if a feature provably errors out.

Told with it: 2.3 runs subagents in the background, which may misbehave against one turn per prompt without any error, so no warning would show. The version pin on a Claude session's cut is left as it is, since it guards a file rewrite.

## Question 73 - What happens to a run that is in the middle of a function when the function is edited?

Q: The run finishes on the version it started with, or it stops at the save with its row saying what did not run?
A: It finishes on the version it started with. New runs use the new version. A run is stopped by switching its automation off.

> A

Recommended: most bodies that wait are "on, wait, off", and stopping halfway leaves the device on. It costs keeping the steps a run started with until it ends. This replaces the default told with Question 71, that an edit in the middle of a run stops it.

## Question 74 - May a step run another automation, or only call a function?

Q: Both kinds of step, or functions only for now?
A: Functions only. "Run an automation" can come later as one more step kind, with nothing stored changing. This replaces Question 51's "any automation, off means off" and the default told with Question 71 that a call respects an off switch.

> B it is

Recommended: it is the smaller language, with one kind of step and one kind of "used by". What it gives up: switching one automation off does not stop another that points at the same function.

## Question 75 - Where does a function get its name?

Q: In the Runs block, or does the picker ask for one?
A: In the Runs block. Every automation shows the block. An automation's own steps show an empty name field reading "Name"; typing a name and saving makes it a function others can point at. "+ New function" in the picker gives a fresh empty body, unnamed until named. Tapping the name renames. Nothing asks for a name. Mocked as `functions-naming-a.html`, group "Phase 2.7e Functions".

> demonstratw A again > "Name"
>
> looks good

Recommended: one place to name and rename, no dialog, the five live automations look the same until one is named, and it matches the stored form (named is a function record, unnamed is the automation's own steps).

## Question 76 - How are a function's own values declared?

Q: In the Runs block, or not on the phone until the script view?
A: In the Runs block. A named function shows "+ Add value" under its value rows: a name, and a type from Device, Text and Number. The name and type belong to the function, and each automation using it sets its own value. On a shared function, adding a value the other users' triggers do not give is blocked with "Make unique first", since the Gateway would refuse the save as unfit for them. Mocked as `functions-values-a.html`, group "Phase 2.7e Functions".

> A

Recommended: without it nothing that needs a value set on the automation can be made, and two thermometers sharing one Notify with their own rooms is the case the owner asked for. The shared rule is the Gateway's own refusal shown early.

## Question 77 - How does a step use a declared value?

Q: Do a step's own fields offer the function's values, or text holes only for now?
A: The step's own fields offer them. A plug menu lists the function's Device values above the real plugs, shown by name; a number field offers the Number values the same way; a text field takes `{name}` as a hole, as it already does. The step stores the value's name as an expression argument, which the Gateway resolves to that automation's own value when the step's turn comes.

No action parameter is a number in this build, so a Number value is used through a text hole only.

> A

Recommended: a declared value no step can use is dead weight, and the Gateway already resolves a step argument that names a value.

## Question 78 - A typed password matches a saved secret: answer at once, or show first?

Q: With Save on, a typed password matches a secret already held. Does that secret answer at once, remembered, or does the card show what Approve will do first?
A: Show first. The card lands on that secret with Remember on and its cost line ("Adds to Sakura Sudo. Ends 1 approval."), and the owner taps Approve. Supersedes the first decision that the matched secret answers by itself.

> A

Recommended: a tap does what the card says. The matched answer would add a command to a policy and end its timed approvals with nothing shown.

## Question 79 - Which requests get a secret pre-picked with Remember on?

Q: Any program whose first word a secret already answers, or sudo only?
A: Sudo only. A sudo request pre-picks the secret that already answers sudo on that Gateway. Every other program opens with nothing picked.

> A

Recommended: one password answers every sudo command on a machine, which is not true of other programs (a password saved for one ssh host would be offered, Remember on, for another). A wrong suggestion with Remember on is one tap from binding the wrong secret to a command.

## Question 80 - App lock on "Every approval": one approval, two presence prompts?

Found by the emulator walk: a typed password with Save on asks for presence before it is compared with the held secrets, the card lands on the matched secret (Question 78), and Approve asks again.

Q: One prompt for both, or keep both?
A: One prompt covers both. The presence given for the match also covers the Approve that follows, for that request and that secret only, for one minute. Picking another secret, or waiting longer, asks again.

> A

Recommended: it is one approval, and "Every approval" should mean one prompt each. The carry is narrow: the same request, the same secret, one minute.

## Question 81 - What is a unique copy called?

Found by the emulator walk: "Make unique" keeps the name, so a save leaves two functions called "Too warm" that neither the list nor the picker can tell apart.

Q: A numbered name, the word "copy", or the same name as built?
A: A numbered name, as Blender does it. Make unique renames this automation's copy "Too warm.001", then ".002" for the next free one on that Gateway. The name sits in the field and can be changed before Save.

> A

Recommended: the copy is the owner's to rename either way, and a numbered name never leaves two rows that cannot be told apart. A plain number after the name would read as the list's user count.

## Question 82 - Do steps with no name have "Keep trying for" and "Cool down"?

Found by the alignment read: slice 3 stores both settings only on a pointer to a named function. An automation with its own steps always waits ten minutes and has no cool-down, against Questions 48 and 52, and the phone draws neither setting yet.

Q: Every automation, or named only?
A: Every automation has both, named or not, stored on the automation itself. The cost is accepted: an app build older than this one would drop them if it edited that automation.
The slice 5 ruling puts `coolDownSec` on the trigger.

> A

Recommended: it is what Questions 48 and 52 already answered, and how long a run keeps trying has nothing to do with whether its steps have a name.

Follows from it, for the tree slices: the automation record gains `keepTryingMin`, an event trigger gains `coolDownSec` (zero by default, as Question 52 said), and `run_function` loses both while no function is stored anywhere. This is a second accepted exception to the wire rule.

## Question 83 - Is "outside words leave the machine" still named at the save?

Question 52's "Words" rule (a hole reading outside words inside something that leaves the machine is named at save) is built in no slice. Only IFTTT leaves the machine today, and an event automation that gains an IFTTT step already confirms once with "Send to IFTTT".

Q: Add it to that confirm, or drop the rule?
A: Add it to the confirm. When an IFTTT value reads the event's own words, the confirm's line says so ("Send to IFTTT, with the event's title"). No new dialog. It rides the tree slice on the Gateway.

> A

Recommended: a few lines on a confirm that already exists, at the one moment it matters that someone else's words are about to leave.

## Question 84 - In what order do the architecture audit's changes land?

The audit after 2.7e.2 ranked seven changes. Four bug classes were closed only by patches: the phone judging a draft against facts it does not hold (three rounds), the walk reading a pointer as a step, a function's checks living on separate roads, and the checker and evaluator resolving names separately.

Q: Follow the audit's order, ship phone N first, or do the engine changes only?
A: The audit's order. The Gateway checks a draft before it is saved, now, while phone N is unshipped. Then the closed walk, one body check and one name resolver before the tree's engine slice. Vault presence as a typed answer and the Router's inbox sweep behind the migration fence alongside. Screens taking computed views with the tree's phone slice.

> 84 A it is.

Recommended: the draft check is the only class that recurred three times, its newest instance is in code that has not shipped, and it deletes phone code where the alternative adds a grammar to the phone later.

## Question 85 - How does phone N learn that a Gateway can check a save?

The check is a new op, `automation_check`: a save's payload, judged by the Gateway's real save rules, with nothing written. A Gateway on an older build does not know it.

Q: Part of the existing functions capability, or a separate capability with a fallback?
A: Part of the existing functions capability. A Gateway that says it serves functions also checks. The phone keeps no fallback. It relies on the order already kept: a Gateway is updated before phone N is installed.

> A

Recommended: no Gateway has ever served functions to a phone without this op, since N is unshipped, and a fallback would keep the guessing code this change exists to delete.

## Question 86 - A function changes elsewhere while its editor is open. What happens?

A shared function's steps are changed from another automation, another phone or the assistant while this editor shows the old ones. A save that touched only the automation went through, and the automation ran steps the screen never showed.

Q: Block and reload, merge automatically, or save anyway?
A: Block Save and offer Reload. A line says the function changed elsewhere, and what was typed stays on screen. Reload shows the new steps: edits to the automation itself (its trigger, its values) are kept where they still apply, and edits made to the function's steps are dropped, with a line saying so.

> A

Recommended: the owner should see the steps they are about to run, and it costs one extra tap in a rare case.

## Question 87 - Does the Save button wait for the Gateway's check?

The check runs after typing settles: a short pause, then one round trip.

Q: Save stays available, or Save waits for the answer?
A: Save stays available. A refusal from the check shows on its field and blocks Save until the draft changes. A tap before the answer lands, or with the Gateway slow, sends the save to be judged as before. The button has no checking state.

> A

Recommended: the save is judged again either way, so a waiting button promises only slightly more, and it would leave a dead button whenever the Gateway is slow or out of reach.

## Question 88 - The phone cannot show the fingerprint or PIN prompt. What happens?

The prompt is the one the app lock and vault approvals show. With the app lock on, any reason Android gives for not showing it counted as passed.

Q: Pass only with no screen lock, keep passing on any reason, or always refuse?
A: Pass only when the phone has no screen lock at all. Any other reason refuses and says why. The line reads "Problem reading biometrics."

> A. And the error: Problem reading biometrics or something

Recommended: with no screen lock the phone is already open to whoever holds it, and every other reason is a moment where the lock should hold.

## Question 89 - How does a step's position read once steps nest?

A position shows in the console's run rows, in a save refusal and in a run's stored state. Today it reads `0.1`: the automation's action 0, the function's step 1.

Q: Numbers with a side letter (`0.2t.1`), numbers only (`0.2.0.1`), or words (`0.2.then.1`)?
A: Numbers only. The first side of an If or a Try is `0`, the second (else, catch) is `1`.

> B sounds simple.

## Question 90 - One Fable block, or two?

The owner runs this work on the Fable tier and wants to switch to Opus for what does not need it. About a third of what is left is hard engine or language work (tells as steps, the nested editor model, the Calls engine, the script's Gateway slice, side by side and tasks); the rest is phone screens, ripples, checks and docs.

Standing instruction, 2026-11-26: run the Fable work back to back, then pause and tell the owner to switch tiers; keep the Fable items consecutive where possible.

> kool. pause and inform me to switch tiers when all fable slices end. try to keep them consecutive where possible, so I'm not flip flopping 10 times.

Q: One Fable block with one switch (A: every engine phase before any phone work), or two blocks with three switches (B: tells as steps, the nested editor model and the Calls engine now; Opus for the tree and Calls on the phone, the run log, checks, audits and an install; Fable again for the script's Gateway slice and side by side; Opus to the end)?
A: Two blocks. No handoff file: the session keeps its knowledge across the model switch.

> 2 is fine.
>
> ohh well you don't need to leave a file handoff. You will take on all knowledge to the /model switch

Recommended: the script and side by side stand on the tree and calls, and using those from the phone first catches a wrong shape cheaply.

The order that follows:

1. **Fable, now:** Question 82, tells as steps, the nested editor model's design (slice 5), the Calls engine (slice 6, Gateway half), and the unnamed function's Gateway half (Question 91, which arrived inside this block). Then pause and message the owner to switch.
2. **Opus:** the Opus-tier leftovers of slice 4 (the run log rework and the last run served, the judge's tree checks and the condition preview, comment clean-up, the phase audits), the tree on the phone with the unnamed function's phone half (slice 5), Calls on the phone and the Run button (slice 6), an install on the owner's word. Then pause and message the owner to switch back.
3. **Fable:** the script's Gateway slice (2.7f), side by side and tasks (2.7g, Gateway). Then pause and message the owner.
4. **Opus:** the script and the flow map on the phone, the walk-through and cleanup.

At each pause: every gate green and pushed, both Gateways on the last commit, then the message.

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
- **Functions with users** (group "Phase 2.7e Functions" in the dock; owner: "looking good!", then "nice. Lock it in"):
  - **The Automations list:** each row is a trigger with its function beneath it, a small the function mark and the function's name. A count sits beside the name only when more than one thing uses the function. The List and Map switch and the row's switch stay.
  - **The editor:** "Do" becomes "Runs". It opens with the function as a block: its name, "Used by N" when above one, and an arrow that points the automation at another function. Under the block, one row per value the function takes: its name, its type and its source, either "from the trigger" or a value set on the automation (a menu for a device, a field for a text or a number). A value still to set reads "Set a value" and Save waits for it. When the function is shared, a panel reads "Changes here also apply to:" with the other users and "Make unique". Then the Cards and Script switch and the body. Removal stays in the top-right menu.
  - **The values set on an automation are the automation's own.** Only the function's body is shared, and "Used by N" speaks of the body.
  - **The picker, "Run a function":** the subtitle is the trigger's sentence alone. "+ New function", a thin line, then every function this automation could run, each with its signature and its count. No "Fits this trigger" label. A function that takes another source's event, such as a GitHub event, is not listed. The "Incompatible triggers" group, with reasons worded "Requires event.", has nothing left to list and is off the card. Owner: "If it is a source like GitHub, don't show it where Incompatible." As built, a function reading a name the trigger lacks, or a declared value given as another type, is hidden the same way.
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
- **An unread list folded into a definite answer** (readers of `GatewayList`, `Lookup` and `UsedBy` on the phone): first audit, a source's page spun or said "none" for an unread list; second audit, a delete of a row its list no longer held was refused as a moved home; red team, the remove dialogue said nothing watches a sensor whose list was unread, and an unread list let a put skip the move lock. Each patched at its reader; the lock reads no automation list. A function write does read its listed row's `moves`; it read an absent row as not moving (`saveWithFunction`), the same class again, and now takes the move lock at the assistant's home when the row is missing (`functionWriteMoves`). `gateway-list-residue.test.ts` refuses `.orEmpty()` on a list but not a cast with a default. For the architecture step: every reader folds the answers in a `when` with no else, and the gate refuses the cast. **Closed by the architecture step:** the flattening accessors left main sources and `gateway-list-residue.test.ts` holds five rules with an empty allowlist. The red team on it still found four readers the rules could not see (a nullable `workdirOf` read as "must move", a failed read left as reading, unread peers mapped to none, an `is` test in an `any`); each was patched and the gate gained the `is` rule. What stays beyond a source gate: a function that names every case and returns the same definite value for two of them.
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

## Phase 2.7e - Functions: reusable bodies, ordered steps, branches and calls (Q48 to Q71)

Fourth draft. The third was audited from five lenses (`plan-27e-v3-audit-synthesis.md` in the session scratchpad, 21 changes kept, every high finding checked against the code); they are folded in here. Slices 1 to 3 are built. Builds named below: 8.14.87, the last release and the flat build the restore fixture is named for (`flat-8.14.87`); 8.14.83, the phone's last recorded install, whose `editable` rule the gates replay; N (functions, bodies still a list) and N+1 (the tree). The Gateway and the host daemon were restarted from the checkout on 2026-11-21, so they run slice 3's committed Gateway half while still reporting 8.14.87.

The model, in the owner's words where they gave them:

- **An automation is a trigger pointing at a function.** The trigger is the signature, the function is the body (Q65). Several triggers may point at one function, and a device may point at any function it fits (Q67).
- **A function** holds a name, the values it takes with their types, and its steps.
- **Users:** every automation pointing at a function and every function calling it. The editor shows the count and who else an edit reaches, and "Make unique" gives a user its own copy. A function with no users is deleted (Q67).
- **Fit** is by name and type for a declared value. A value read off the body fits by name only, since `functionReads` gives names; typing those waits for the script's typing. The trigger fills what it gives; the automation sets the rest, and those values are the automation's own (Q69). A function that takes another source's event is not offered at all.
- **The values a trigger gives:** an event gives `event`, typed from its source's declared fields, and `source`; a crossing gives `value`, `device`, `measure`, `threshold`; a value trigger gives `value` and `field`; a clock and an interval give `time`. A function's own values for these are read off its body (Q65). A value a caller or an automation supplies is declared, a name and a type: a device, a text or a number at first, a closed generated set.
- **No "called" trigger.** A function used only by callers is a function (Q67).

The language of a body (Q53 to Q64). Cards and script are two views of it (Q57):

- **Statements:** a doing call, `if (cond) { } else if (cond) { } else { }`, `try { } catch (e) { }`, `exit`, `throw`, a variable assignment, `wait(minutes)`, a comment. Later: `parallel { }`, then tasks (Q64). No loops.
- **A doing call** is a whole statement, or the right side of one assignment. The save refuses one nested in a condition, an argument or any other expression, with its span, since a step is what the engine claims, retries and judges.
- **Order:** top to bottom, each statement waiting for the one above (Q53). A call to another function waits for it (Q59).
- **Failure**, as a table with vectors, not prose:
  - Outside any `try`, a failure is noted, the frame remembers its first, and the body carries on.
  - Inside one it jumps to the `catch` and the rest of the `try` is skipped; after the `catch` the body carries on (Q60).
  - `throw` unwinds to the nearest `try` in its frame; with none it ends the frame failed.
  - A frame that ends with a remembered failure, or by a `throw`, fails its caller's call step with `call_failed`, carrying that first error. One it caught is not remembered.
  - `exit` ends the frame without adding a failure; a failure noted before it still counts.
  - `e.code` is `refused`, `unreachable`, `no_answer`, `unread`, `timeout`, `thrown`, `call_failed` or `loop`; `e.message` is a sentence, and a bare `{e}` prints it (Q63).
  - A run whose top frame ends failed says so on its run row.
- **A condition that cannot be read** is a failure with `unread` (Q56).
- **Variables are typed** and hold bounded JSON alone: finite numbers, texts, lists and records. Assigning an entity is refused at the save. They live for the run.
- **A comment** is a stored step, so cards keep it as a label line (Q62).
- **Natures:** an action declares `sets`, `sends` or `nudges` where it is defined (Q54). "Keep trying for" is the automation's setting, ten minutes by default, each action its own; a called function's steps use the setting of the automation that started the run.
- **Downtime** (Q70): in progress means an attempt claimed with no answer landed. Such a step fails `no_answer` unless it is idempotent, which resumes inside its wait and fails `timeout` past it. A step between attempts resumes whatever its nature. A tell is atomic and never judged, `if` and an assignment read again, a call is judged by its innermost step, and a `wait` that ran out is over.
- **Outside reach** is asked once per automation: when an event-triggered automation comes to reach, through its function and what that calls, anything beyond telling the assistant. That includes an automation with another trigger becoming event-triggered while it reaches more than a tell. A function's own edit asks it for every such automation it newly reaches, and asks the danger confirm for every user (Q52). Outside words reaching something that leaves the machine are named in the IFTTT confirm (Question 83), which rides the tree slice; nothing builds it before then.
- **A move** carries a function with its users that move; where users stay too, the movers take a copy (Q68).

Design held for the phase:

- **The wire rule:** a record or a kind a build re-encodes never gains a key that build does not know. What an older build cannot hold lives in a kind or a record it does not know. An answer may grow, since phones ignore keys they do not read. One accepted exception: the home record's `carried.functions`, which an 8.14.83 phone drops when it re-seals `opened.carried` while the home is not placed; the older-phone ruling covers what follows.
- **Stored shape:**
  - Functions and automations are rows of one owner-record store, told apart by kind, with a cap per kind. One write lands both or neither, and a refusal sees both. An 8.14.83 Gateway keeps rows of a kind it does not know unread and untouched.
  - **The flat form stays legal.** An automation with its own list of plain actions is stored as today and read as an implicit private function. A function record and `run_function { function, values, keepTryingMin?, coolDownSec? }` are written only when one is needed: a shared body, a tree, a call, a named function. Nothing is converted at a start, so 8.14.83 keeps editing what it can draw, and a rollback silences only what was stored in the new form.
  - The judge refuses a flat put over a held `run_function`, with "Edit this in the newer app", and a body mixing `run_function` with other actions. `run_function` is served with a label and a parameter kind 8.14.83 cannot draw, so that phone labels the row and never offers the kind.
  - A function: `name`, `params`, `steps`. A param is `{ name, type }`, strict. A declared number has no unit in N. A measure, if one comes, is a new `type` value, which round-trips since the Kotlin field is a String, and never a new key, since phone N re-encodes the param.
  - A preserve root `Step`: `do { action, args, as? }` (`kind` is the discriminator) whose arguments are each a literal or an expression, read when the step starts, so a step can act on a value the automation set; `if { when, then?, else? }`; `try { steps, catch }`; `exit`; `throw { text? }`; `let { name, value }`; `wait { minutes }`; `note { text }`. A later statement is a new step kind with its own future-kind fixture, checked at every depth.
  - A function named on the phone takes a phone-minted id (`fn-<uuid>`), as "+ New function" does. The Gateway's key derives only a copy's id (`copyIdOf`) and a carried function's (`carryIdOf`), so a rerun carry lands the same row and no one else can guess it.
- **One Save is one op** carrying the automation and the function, a copy or a new one, each with the revision it was read at. It lands as one batch, and a refusal says which of the two moved. An older Gateway answers that it does not serve it.
- **One walk** over every action an automation reaches, across its function and what that calls, in `src/shared`, given a way to read a function. Its callers: the fire, the lane's `decide` and `fireEvents`, validity, the danger confirm, outside reach, the home rule, `rulesOfAutomations`, the console's entity, and the phone's warnings. `run_function` is never an effect and has no runner. A residue test on both runtimes refuses a direct read of `actions` or `steps` outside it. It lands before any function is stored.
- **The delete at none** is one rule in the judge, for the owner's intents: after an intent's own writes, every function left with no user is removed, repeating until nothing changes, and no function ever lands without one. A let-go and a carry delete no function; one they leave without users is kept unlisted for a fixed time before a sweep.
- **Graph checks** (a call closing a loop, a pointer to a function that is gone, a change that stops a user fitting) live in the judge, for an owner's put alone, as a change against the held rows. A toggle never asks, and goes through whatever state its function is in, gone or unread included, landing as unfit. A carry never refuses on the graph; what did not come with it lands unfit with its own line.
- **A carry** takes functions by value, the pointers rewritten. A carried function keeps its own id. It moves to a `carryIdOf` id only when the destination's id is held by an automation, by a function a staying or unread automation runs, or by another carried function, the same way on a rerun. A function at the destination that only moving automations run, or that nobody runs, is written over. The source keeps its own record for its staying users, so Question 68's outcome holds. A carry is refused whole only when a derived id cannot be claimed (`no_key`, `no_free_id`); that is not a graph check. Before a move the phone checks that the destination serves functions and every step kind carried, and refuses otherwise.
- **A function write holds the move lock** when any of its users moves with the home.
- **The engine:** a run holds frames keyed by step path, each with the function, incarnation and revision it runs and the steps of that revision, its variables, its first uncaught failure, and per step the word, the verdict, the attempts, the time and the side an If took; and a set of active steps, one in this phase, so side-by-side work later needs no new shape. A run is started once its active list is not empty, as 2.7e.1 decided; a started run is never evicted, at most one per automation is started, and waiting event fires are capped per automation. Frames, variables and step records are bounded per run.
- **An edit and the runs in flight** (Q73): a run finishes on the version it started with. Each frame holds the steps it entered with, so an edit, a repoint or a delete of a function changes nothing under a run, and a frame entered after the save reads the new version. Switching the automation off stops its run. Slice 3 logs one row, "it was switched off"; the row saying what did not run, computed from the frames the run holds, comes with slice 4's last run served.
- **An attempt** has its own short bound, retries back off, and the runner takes whichever step fell due first. The device answers map to the words by one table keyed on the refusal code and the effect, with a vector per code; a hold that is no attempt sits beside them.
- **A tell is a step.** From slice 4's "tells as steps", the lane tells only an event automation's leading tells with no message, for a run the lane caused. In slice 3, `laneTellWhen` takes every message-less tell of a flat list, leading or not, and never a function's tell; every function tell goes through the outbox, with `event` sent as its title only. So naming a live event automation such as gh-mentions changes its wake from the GitHub event to an "Automations" event carrying only the title, and the GitHub event lands quietly in its inbox. The owner was told on 2026-11-25 not to name the steps of a live GitHub automation until then. Every other tell goes through the outbox under a member built from the automation, its incarnation, the key and the call-site path of every frame, so one function called twice tells twice. A tell with no room counts against "Keep trying for" and then fails `timeout`.
- **Loops:** a function may not call itself, directly or through others: refused at the save, held at the run by the chain every frame carries (`loop`), with a generated budget of calls per run.
- **Served with the list:** an automation list answers the functions too, each row `{ id, revision, function, users, moves, reads, invalid? }`, and `serves.functions` is `{ max, steps, paramTypes }`. One fenced read lands both, so a count never disagrees with its rows.
- **Fit** is one pure rule in `src/shared` with a Kotlin twin, both replaying one vector file; trigger names and their types are generated.
- **Previews are their own ops:** a body's text with its values and the draft's trigger, and a condition's "true right now". A hole's address is a step path; the old index stays beside it for older phones.
- **Cards** draw one level: a list, an If with two sides, a Try with its catch, Wait, Exit. A body past that opens read-only with a line saying so, until the script exists.
- **What the map reads:** per automation its last run's steps and the step in flight, served on the row, cleared when the body changes and never by a toggle.

Built as four phases below (2.7e.1 to 2.7e.4), six slices in all, each ending green and each restoring the state the one before wrote, the Gateway's part deployed before the phone's.

Gates that must exist: a restore test per slice over the previous slice's state; the walk residue test; the fit corpus on both runtimes; a fair-runner test with a held fake plug; phone-encoded nested unknown steps re-encoded byte-equal; a JVM test of the rule 8.14.83's `editable`, `canRemove` and `actionLine` apply to an action kind they cannot draw; a restore of the five live automations by this build, from the state the flat build (8.14.87) wrote; after a function is stored, the four live wakes and the crossing still tell, and an IFTTT step inside a function still asks. No gate here sees the owner's real phone on a new row, the deploy order across real Gateways, or a real rollback.

Size: about 6,000 to 8,000 lines over both sides with tests.

Decided here and told to the owner, theirs to change: an automation that fires again while its run is live waits its turn; Run pressed on a switched-off automation runs it once; a script writes a device or a function by its name when exactly one holds it; a called function hands nothing back in the first version; a function's edit that widens what an outside-triggered automation reaches asks once for it.

A step calls a function and never an automation (Q74), so a function has no switch and an automation is used by nothing.

## Phase 2.7e.1 - Engine prep and the one walk (slices 1 and 2) ✅

Design: Phase 2.7e above. Nothing on the wire. One answer a phone sees changes: a tap on a plug that never accepts a connection answers `unreachable` in about five seconds, where it waited out the lease and answered `timeout`.

1. ✅ **Engine prep** (Gateway, M). The words and the hold beside them with the decline table, the attempt bound, the backoff and the fair runner, natures, every restart rule, an outcome kept per step, runs keyed by step path with one started per automation, "Keep trying for" as ten minutes per action. Effects of a flat list run in order. A fire of a shape this build cannot read is dropped and logged `uncertain`.
2. ✅ **The walk** (Gateway and phone, S). The one walk over today's flat actions and its residue test on both runtimes, so every reader is ready before a function exists.

Gates, all in the suite: a restore of the state 8.14.84 wrote, and of the state the build before the version table wrote; a runner test with a held fake plug; a vector per decline of the device road; the walk residue test.

Decided while building slice 1:

- **An attempt is bounded at 15 seconds,** a bound each caller hands the device road; the road knows no surface. A connect has its own bound of five seconds in the Kasa transport and ends `unreachable` for every caller, so a Toggle to a dead plug ends at once and an On retries. A bound that passes while the op waits in the device queue, or before a connect gave up, is a hold; one that passes after the command was written is `no_answer`. An IFTTT attempt has the same 15 seconds, its vault read counted.
- **Retries back off** from 5 to 60 seconds, counted from each answer. A hold takes its attempt back.
- **Natures sit beside the runners** on the Gateway until the slice where the phone reads them, when they move to the action table.
- **A step that only ever held** and runs out of its ten minutes ends `unreachable`. `timeout` is the word after a restart, and for a tell that found no room within its window. A step that never began an attempt forgets its start at a restart.
- **At most 8 event fires not yet started per automation.** The newcomer past that has its run dropped and logged `suppressed` ("too many of its runs are waiting"), once until a run comes between. Its tell still goes, as a fire with no steps, while the queue has room.
- **Each ended step logs one fixed phrase per word.** A stored fire that cannot be read logs one `uncertain` row, none when its automation id cannot be read, and the restore that dropped it writes once.
- **A throw before anything was sent** (the engine itself, a hole read) is a hold. A throw from an action's port is `no_answer`, judged by nature like any attempt with no word back.
- **A rollback to 8.14.84 drops every fire stored in the new shape** in memory, with one console line and no run row, so the outcome of a step that was in flight is lost without a trace in the log. The file keeps them until that build next writes its state, so going forward again before then reads them back and runs an unbegun step late, under Question 70's "however late". The automations themselves are untouched.
- **A fire reads the body it fired with.** The state holds each automation body a held fire refers to, keyed by automation, incarnation and revision. The state write is its one writer: it keeps what held fires refer to, takes a missing one from the live record while that record is still at the fire's revision, and drops the rest. Every question about a step after the fire is asked of that body: its nature, the kind on its log row, the switch a landed set names, the runner and the tell's text. A fire with no body retires as "the automation changed"; what may have landed is told by its steps' own rows, not by that row. A build before this ignores the table and drops it at its next write; this build, given a state without it, pins each fire whose record still matches and retires the rest.
- **A newer setting of a switch ends an older one still waiting.** When a set lands, every older open set of the same device, from any automation, ends refused ("a newer setting of this switch landed first"), so a retried On cannot land after the Off that followed it. A Toggle is a nudge, so a Toggle never ends an older Toggle: two automations that each flip a lamp flip it twice. Steps of one run are never touched. A switch flipped by hand between retries is not seen. The device is read from the body the landed fire fired with, so an edit of the newer automation during its attempt hides nothing.
- **A run is started once a step's turn has come,** read from the fire's active list and from no step field, whether or not an attempt went out. A newer fire cannot replace it and renew its ten minutes, and a restart that erases a held step's clock leaves it started.
- **The runner takes whichever step fell due first:** a first attempt is due at its turn, a retry at its last answer plus its gap, and fire order breaks a tie. A retry before its gap is no candidate. Neither a stream of new runs nor a row of dead plugs can starve the other.
- **An IFTTT post is not retried on a failure today**, since its client cannot yet tell a post that never left from one that left with no word, and answers both as `no_answer`. The word table already retries `unreachable` for it, for the day the client can. On the board.

### Bug Classes

Mechanisms patched for the same class in more than one audit round of this phase, for the architecture step:

- **What counts as a started run** (`started`, `unstarted`, `live` in `automationFires.ts`, read by `admit` and `victimOf`). Class: a run that has begun is read as not begun, so a newer fire replaces or evicts it. The predicate is inferred from several step fields, and each round found a field it missed: the first alignment pass patched a restored step that an older build had finished (`verdict` with no attempt); the red team patched a step whose turn had come but that only held (`startedAt` with no attempt). A run that says it has begun once, in one field set when its first step's turn comes, would not need the inference.
- **Whether a device attempt sent anything** (`declineFrom`, `CONNECTING` and `tooLateToConnect` in `road.ts`, `deviceAttempt` in `automationActions.ts`). Class: an attempt that reached nobody is read as a hold, or a hold as a failure, so a Toggle is retried or dropped wrongly. The first pass patched a connect that never opened (a hold where a failure was meant, by surface); the second patched a turn with too little of its bound left (a failure where a hold was meant) and a default argument that would have brought the first back. The road answers "not started" for several distinct facts, and the automation surface needs them apart.
- **The runner's order** (`nextEffect`, `overdue` and `dueSince`). Class: a fixed priority starves the other side. First attempts always first starved a due retry (first red team); overdue retries first starved a healthy first attempt (second red team). It now takes whichever has waited longest once anything is overdue. One ordering by waiting time from the start would have had no sides.
- **What a landed effect did** (`landClaims`, the `spent` entry, `outdatedSets`). Class: the engine asks the stored record what an effect was after it ran, and the record has moved. The newer-setting rule read the device from the record and missed a set whose automation was edited mid-attempt; the same pass found it treated a toggle as a setting because it never read the nature. The answer now carries the device and the nature of the effect that ran. Anything else the engine reads about a finished attempt (its kind for the row, its home rule) still comes from the record.
- **The walk's residue test** (`automation-walk-residue.test.ts`). Class: a textual gate that misses a way of reading `actions`. Each pass widened a regex or added a rule (member reads through `!.` and brackets, destructured parameters, a spread of a body, an exemption that proved nothing). A check on the type, such as a branded body that only the walk can open, would end the list of shapes.

### Architecture pass

Built, one change per bug class above, each leaving the tree green. The audit behind it is `architecture-27e1-synthesis.md` in the session scratchpad.

1. **A run is started when its active list is not empty.** `started` reads the one field `advance` sets, never a step's fields, and the fire's schema refuses an active path that names no step. A fire the 8.14.84 build stored reads started only when one of its effects was claimed or done. Ends the first class.
2. **One due time orders the runner** (`dueAt`, `nextEffect` over a list of runnable steps). The two-tier rule, the overdue bound that copied the device road's 15 seconds, and the side set are gone, and a step is named by its path as text. Ends the third class.
3. **A fire reads the version it fired** (`versions` in the state, `bodyOf` and `stepAt`). `commit` is the one writer. The answer of an attempt no longer carries the nature or the switch of what ran, since the body holds them. Ends the fourth class, and is the table Question 73 needs: the functions phase pins a function's revision in it.
4. **The transport says when a plug never accepted** (`KASA_CONNECT_MS`, `connectBy`). The road has one decline rule and takes a bound, with the table of bounds in `composeDevices.ts`; `attemptOf` maps the road's outcome for the automation port, beside the IFTTT mapping; the IFTTT client takes a bound. Ends the second class.

Also renamed: the runner's map of kind to nature is `KIND_NATURES`, apart from the `NATURES` tuple of the three words.

Moved to the first step of 2.7e.2, where the record shapes are rewritten anyway: sealing `actions` in the type so only the walk can open it (the fifth class). The widened residue test holds until then.

Red team of the pass (five lenses and a verifying synthesis, `redteam-27e1-arch-synthesis.md` in the session scratchpad). The active list and the one due time held under every trace. What it found, and the rule each fix lands as:

- **A fire that retires is never resumed or retried.** Its steps are judged with no nature, so a claim a restart found on an edited automation ends `no_answer` with an `uncertain` row, where the version table had let it resume silently and be dropped as `suppressed`. Retirement is decided before recovery and before answers land. A run that finished in the same pass logs no retire row. A second read found the sibling the first fix missed, a step between attempts whose last word was `no_answer`, so the rule is whole: a retiring fire ends every step it began with what is known, a claim as `no_answer` and a waiting step with the last word it heard. Two rounds in one mechanism (what a retiring fire says of an attempt that may have landed), so it counts as a sixth bug class; the frame walk of 2.7e.3 should end a run in one place.
- **The effect latch alone says whether an effect's command went out.** A timeout with the latch unmarked is not started, whatever an earlier read of the same operation wrote. Before this, our own deadline cutting the identify read ended a Toggle as "could not be reached" with nothing sent to the relay. Third round of the second bug class: the first patched a connect that never opened, the second a turn with too little bound left, and the pass itself removed the floor that guarded the second.
- **No effect starts with under about two seconds of its bound left,** for every caller, in the road.
- **An IFTTT attempt whose bound is gone when its vault read returns is a hold.**
- **The assistant's plug read waits longer than a connect,** so a dead plug reads `unreachable`.

## Phase 2.7e.2 - Functions as records (slice 3) ✅

Design: Phase 2.7e above. Gateway L, phone L, the first app update (N).

Built, committed and on Sakura and Mikan (e15e1eb1); the phone holds the build of 59a12c41. Left for the owner's phone, since no gate here reaches them: a function stored on a live Gateway and run, the overlay's presence prompt, a fingerprint, and the fault line.

First steps, carried from the 2.7e.1 architecture pass:

- **Seal `actions`, and `steps` as it is defined, in the type,** so a direct read does not compile on either runtime and the residue test shrinks to compiler-checked samples. Two probes first: whether a Kotlin data class's destructuring inherits a property's opt-in, and whether the schema's meta survives into the generated Kotlin. The seal landed in a8364263: the meta survives, and the codegen marks a sealed list `@property:OpensWalk`, an error-level opt-in.
- **Pin a function's version in the fire's version table,** and make the retire rule Question 73's: a gone record retires, switching the automation off retires, a revision change retires only an unstarted fire.
- **Split the reader:** `reached` follows calls; a one-level `written` serves the editor and hole addresses, which read syntax, not reach.
- **Rename the log row** away from "run", which will mean a pinned run. Not done here: carried to the tree's engine slice with the log's rework.

3. ✅ **Functions as records.** The kinds in one store with a cap each, `run_function`, the Save op, users and the delete at none, fit and the values an automation sets, the judge's graph checks, outside reach and the danger confirm across users, the carry, the list answering functions, a run pinned to the steps it started with (Q73). Bodies are still a list of `do` steps. Phone N: the "Runs" block, the picker, "Make unique", the count on the list, as locked in the Designer. Pure rules, a JUnit each: `valueRows`, `valueIssue`, `runsIssue`, `functionLine`, `usersCount`, `reachLine`, `automationDeleteTakes`; their sentences are `usedByLine` and `deleteTakesLine`.

Gates: the fit corpus on both runtimes, all 13 cases; `UnreadableActionKindTest`, which replays the rule 8.14.83's `editable`, `canRemove` and `actionLine` applied, with this build's code on an invented kind, since 8.14.83's own code cannot run here, and no test yet pins this build's `drawn` false for the `function` and `values` param kinds; this build restoring both `flat-8.14.87` and the functions state, the flat build's read of the new state checked only as a key set; after a function is stored, four fake-source event automations and the crossing still tell (`federation-harness-functions.test.ts`), and an IFTTT step inside a function asks at the save (`automation-functions.test.ts`); the carry vectors, `pick` on both runtimes and `land` on the Gateway.

### Decided while building slice 3

The lead's rulings on the wire proposal's questions, and what the build found:

- **A revision change retires only an unstarted fire**, and that is the automation's own revision. A function frame is pinned when it is entered. A started run finishes on the body and frame it pinned. Switching the automation off, deleting it, or another incarnation stops a started run. The owner is told this in plain words, since it is theirs to change.
- **A function gone or unreadable when its frame would be entered** ends that step refused with a fixed reason, never a throw.
- **Caps:** 64 records across kinds, functions at most 32, 8 steps and 8 params a function.
- **`call` is its own step kind in slice 6.** A `do` step never names `run_function`, which stays the automation's pointer.
- **A `do` step declares an optional `as`** now, named as a param is, since a kind may not gain a key later. The step check refuses a step that carries one ("a step cannot keep its result yet") until the tree slice. Built.
- **`run_function.values` are literals only** in this slice, a text or a number. A step's literal argument also takes a boolean. A device value is an id checked against the offered switches at the save.
- **`keepTryingMin`** is each step's own window, default 10. **`coolDownSec`** is the automation's cool-down only where the trigger carries none; beside a trigger's own it is refused `cool_down_twice`. Both keys are declared now, since a kind may not gain a key later. The phone draws neither in this slice. Both live only on `run_function`, and an event trigger has no `coolDownSec`, so a flat event automation has no cool-down at all, against Question 52's "Rate". Question 82 settles it: both settings belong to every automation and move onto the automation record in the tree slice.
- **An older phone's home move** carries a `run_function` automation without its function. Functions left behind stay unlisted for a named constant of 7 days, so a move back binds to the function the let-go kept and the automation is fit. It lands unfit with its own line (`FUNCTION_LEFT`) only when nothing was kept.
- **The copy id's key** is in its own file, never logged or answered. The Gateway names a "Make unique" copy (`copyIdOf`) and the save answers the row.
- **One id space across kinds:** an automation id held by a function, or the reverse, is refused `invalid`.
- **Every save refusal is a code** (`AUTOMATION_SAVE_REFUSALS`), prose beside it for an older phone. Every refusal carries a `line`, the judge's or the store's own sentence where the code has no specific one (built). Phone N shows `line` for a code it does not know, since it is the older phone for every code later slices add.
- **A function from a newer build** is held unread, counted in the caps, and its automation reads invalid with its own line (`FUNCTION_UNREAD`) and never fires.
- **Outside reach asks for a flat automation too:** a new event-triggered automation that reaches more than a tell answers `confirm` once, and so does one whose trigger becomes an event while it reaches more than a tell (built). 8.14.83 already handles `confirm`.
- **A toggle goes through whatever state its function is in:** the judge skips the pointer checks for it and puts it unfit, so an automation a move left without its function can still be switched off. Built.
- **The function list row carries `reads`,** since the phone has no grammar to compute them; the phone twins `triggerGiven` and `fitOf` only.

Built: all seven Gateway steps (the store, `run_function` and the walk, fit, the judge, the engine with frames and `functionVersions`, the `automation_save` op and the list answer, the carry) and phone N, all committed (b1fc3698, 999f4b23, cd294022, e482787e). The `as` key, the refusal `line`, the reach asked on a trigger becoming an event and the toggle are built and not yet committed.

Phone N, as built:

- **Clearing a function's name:** on a shared function it blocks Save with "Used by N. Make unique first."; on an unshared one the automation runs its own steps again.
- **The picker** lists the current function first. A function reading a name the trigger lacks (`{value}` under a clock, or one answering `requires: ["event"]`), or a declared value the trigger gives as another type (`wrong`), is hidden, as another source's event is.
- **The picker has no subtitle** for a new automation or an edited trigger: `pickerSubtitle` answers the stored sentence only while the trigger is the one opened, and the preview answer carries no sentence. Left as a gap.

Phone N, built after the alignment read and not yet committed:

- **A named function being edited is always the pointer form,** its id minted once when the name is first typed, so a retried save echoes under the create-echo rule. Clearing the name of an unshared function with no values and no value references returns it to its own steps.
- **The phone shows a refusal's `line`** for a code it does not know.
- **"+ Add value"** declares Device, Text and Number values in the Runs block (Question 76). A name is checked against the generated `PARAM_NAME` pattern and length, and an edit of a shared function's values checks every other user's own values.
- **A plug parameter inside a function** offers the function's Device values, stored as an expression argument naming the value (Question 77). Any other expression, and a step with `as`, is kept as it was sent.
- **No action parameter is a number** in this build, so a Number value is used through a text hole only.
- **The preview op gains optional `params` and `values`,** so a text naming a declared value previews filled, and "Names here" lists the function's values after the trigger's names.
- **"Make unique" names its copy** with the lowest free three-digit suffix on that Gateway (`uniqueFunctionName`, Question 81): "Too warm.001". The name sits in the field and can be changed before Save.
- **A function write whose listed row is missing** takes the move lock at the assistant's home.

Closed by the architecture pass below, not carried: `enter` refuses a call whose function has a step issue or whose bindings do not fit, with that issue's line. It matters once `as` means something: a fire queued across a rollback from a build that stores `as` would otherwise enter such a function and drop the result.

Carried to slice 6: `enter` deletes the call step's record, which `call_failed` will need back; frames and step records are bounded only by construction; `carriedFunctionsOf` follows only an automation's own pointer and must widen to the functions it calls.

### Bug Classes

From the adversarial read of the Gateway half (six lenses and a verifying synthesis, sixteen confirmed findings, each with a probe). None changes what the five live flat automations do, none loses data on a rollback, and no function can exist on the live Gateway until phone N ships.

- **A. Write order against an in-order cap.** Mechanism: `planPut` counts caps as each write of a batch is planned; `judgeCarry` and `judgeSave` list creates before removals, so a carry or a repoint near the cap is refused as full. One change: `batch` checks the batch's final row count.
- **B. A derived id assumed free.** Mechanism: the copy branch of `judgeSave`, the carry's landing loop and the `repointed` fallback each write at a deterministic HMAC id at whatever revision is held there. A carry could write over a function a staying automation runs; "Make unique" could write over another automation's copy, could not mint again after a buried copy, and a retry answered `gone`. One change: one helper claims a derived id, walking to the first one that is free for this intent.
- **C. Unread rows ignored as users.** Mechanism: `unused`, `free` and the sweep each read who runs a function; only the sweep guards unread rows, so removing the last readable user deleted a function an unread automation ran. One change: one `usersOf` reader, unknown meaning used.
- **E. The function form lacks the flat form's checks.** Mechanism: validity and the save check different subsets, and fit's event names differ from the fire's. A carried function with a refused hole armed; a device value was never checked against the switches (a ruling not built); a hole in a device arg filled with the shown name; `event.url` and `event.id` read as hidden; a crossing's `device`, a sensor name, was typed as a switch. One change: one `stepIssue` read at the save and on every read, and one table of what an event gives. The architecture pass below folds it and the flat checks into one assessment (`argsIssue`, `assessBody`).
- **Slips:** a newer set did not end an older function step not yet resolved (high); a move in place treated the home's own event automations as arriving; the call's cool-down measured from the last finished run; store refusals guessing their code; the function key minted inside the preflight and written over when unreadable; the console entity not following the function; the danger key differing between flat and step forms; no restore test for the plan's cross-build gate.

All sixteen are fixed and committed. A second read of the fix round found the in-place move's bypass writing the carried body over a function a staying automation runs (class B again, through the fix); fixed with three smaller items.

From the adversarial read of the phone half (four lenses and a verifying synthesis, fifteen confirmed). For a Gateway that does not serve functions nothing changed; every finding is behind `offer.functions` or carried functions.

- **Phone A. An unread list read as a decision, with nothing reading it.** Mechanism: `functionsServed` on the move road, a page that never refreshes the automation list, so a move carrying functions was refused "Still reading" for ever. One change: the move gate reads its target itself.
- **Phone B. Inner-page state outside the mirror's keys.** Mechanism: the editor's `MirroredDraft` keys against what `inner` closes; the message page was keyed by hand and the picker was not, so system Back did not close it. One change: one projection of what `inner` closes, used as the key.
- **Phone C. The draft carries facts that belong to the listing.** Mechanism: `RunsDraft.Pointing` freezing a function's users and reads when minted. An edit could change another automation without the block showing it; the fit check judged edited steps by the stored ones. One change: read users from the live row, and trust the row's reads only over unedited steps.
- **Phone D. Refusal sentences that ignore their facts.** Mechanism: `automationSaveLine` mapping by code alone. One change: it takes the automation's id and the refusal's record and path.

All four are fixed in e482787e.

From the second alignment read, after the values build (seven lenses and a verifying synthesis, eighteen confirmed). The first read's eight misalignments are closed in code.

- **Phone C a second time: the draft against the listing's facts.** Mechanism: `pointingIssue` judging the other users of a shared function by the listing row's reads after a step edit, while its own fit already used the edited steps. Second patch at the same mechanism. For the architecture step: one place answers "what does this body read", from the draft's steps when they are edited and from the row only when they are not, and every check takes it from there.
- **Phone E. A value identified by its name.** Mechanism: `withFunctionParam` renaming an automation's set values and its steps' references by name on every keystroke. A name that passes through another row's name, or two rows blank at once, merges their references and overwrites a value. One change: a value row has its own key, values and references hold the key, and names are resolved where the draft is drawn and saved.
- **Gateway: a pointer that cannot be followed read as a step.** Mechanism: `asksOf` deciding prior reach from `reached`, which yields an unfollowable `run_function` pointer as an entry. First patch (first read): a trigger becoming an event. Second patch: a held pointer whose function is gone counted as reach, so the confirm was skipped. For the architecture step: the walk says which entries are resolved steps and which are pointers it could not follow, in the type, so no reader counts a pointer as a step.
- **Brief error, mine:** the values brief had a declared value named like a trigger name block Save. Fit fills such a value from the trigger by design (Question 69), and the picker listed functions the Runs block then refused. The block is removed.
- **Slips:** the text page's preview sent no function values; the shared-user check skipped a Device value's switch and blocked on a user already unfit; a save could newly point at a function whose own checks fail; "Make unique" named a copy from a cleared name and from the listing as it stood when the editor opened; two decisions sat inside composables.

From the adversarial read of the second lap (six lenses and a verifying synthesis; the vault lens was triaged by hand, its report having been written under another name).

- **The phone judges a draft against facts it does not hold (Phone C, a third time).** Mechanism: `functionBodyReadsOf` answering "reads nothing" for edited steps, since the phone has no grammar to compute reads, so the Runs block shows a clean fit for a save the Gateway refuses `unfit`; and a draft minted once, so a function changed elsewhere is saved under the screen that showed its old steps when only the automation was edited. Nothing is lost or skipped, since the Gateway judges the live body. For the architecture step, one change: the Gateway answers what a body reads and whether a save would land (a dry run of the save op), the phone reads that where it guesses today, and a draft whose function's revision moved is rebased or blocked. Built in the architecture pass below: `automation_check`, `functionBase`, Reload.
- **The checker and the evaluator read a name in opposite orders.** Mechanism: `unreadable` in `holes.ts` let a name in scope shadow an entity, while `evaluate.ts` resolves the entity first, so a function's value named `sensors` passed the save and read the entity at the fire. Closed: the checker resolves the entity first too, and a value named like one is refused where it is used. **Closed by the architecture step:** `resolveName` is the one answer to what a bare name means, read by the checker, the evaluator and the fill (whose `shown` shortcut was a third order), and `holeScope` builds a function step's scope once for the fire, the preview and the save check. `hole-name-residue.test.ts` holds both.
- **A proof that a boolean could mint (vault card).** Mechanism: the match's presence proof was written from `presence()` answering true, which is also what "no prompt was owed" answers; it named an entry id and wall time, and was dropped on a relock by an observer of a conflated flag. Closed: it is written only when "Every approval" stood before the prompt and after the match, and names the entry's revision, the app lock's epoch and a monotonic time.
- **A newer phone trusting a field an older Gateway fills differently.** A Gateway before Question 79 offers `answering` for any program, and the card pre-picked that secret with Remember on. Closed on the phone too: `answeringOf` honours it for sudo alone.
- **Left as they are:** a vault entry's delete and a grant's revoke take no presence prompt, as `docs/vault.md` states the gate's scope; a double Save inside one frame is not guarded beyond the disabled button; a phone on a Gateway still on the committed build draws a declared-value hole as refused in the preview until that Gateway is updated.

Carried to slice 5: the phone's check of a function it would write never reads `servedSteps`, and passes a kept step holding `as`; the Gateway refuses both. Not reachable until a build stores `as`.

### Architecture pass, after the second lap

Eight lenses and a synthesis ranked seven changes. Questions 84 to 88 settled the order and the open choices. What each change makes inexpressible:

1. **The Gateway checks a draft** (Phone C's mechanism, three instances). `automation_check` answers what a save would get and writes nothing, through `assess`, which the save shares, so the two cannot disagree on the same rows. A pointer-only save names `functionBase`. The phone asks after typing settles, draws the answer, offers Reload for a function that moved, and holds no fit rule beyond the picker's hints.
2. **A closed walk** (the unfollowable pointer read as a step, patched twice). `reached` answers `action`, `step` by its kind, or `unfollowedCall` with why, and `visit` takes a handler per case, so a reader that ignores a case does not compile. The step path's decode and order live in the walk beside its encode. A typed path with its stored form lands with slice 4.
3. **One body check** (class E, the function form lacking the flat form's checks). `argsIssue` is the one check of an action's values, flat or a step's. `assessBody` yields every issue and each boundary applies a policy over it: read, write, retire, frame entry, and before an effect. `enter` now refuses a call whose function has a step issue or whose bindings do not fit, which closes the item carried to slice 4.
4. **One name resolver and one scope builder.** Done in f7b2d21f.
5. **Vault presence as a typed answer** (a proof that a boolean could mint). The prompt answers `PASSED`, `REFUSED`, `NO_SCREEN_LOCK` or `COULD_NOT_ASK`, and the gate answers `Asked` with a receipt, `NotOwed`, `CouldNotAsk` or `Refused`. The carry lives in the gate, which alone can mint it from a receipt, on one monotonic clock with the window. A prompt the phone cannot show refuses with "Problem reading biometrics." unless the phone has no screen lock at all (Question 88): on the card for an approval, on the lock screen for the app lock, as a notice elsewhere.
6. **The Router's inbox sweep behind the migration fence.** Done in f7b2d21f.
7. **Composables take projections.** With slice 5, which redraws those screens.

Ranks 1 to 3 are in e0fe9324 (the Gateway half of 1 in 3b921a51), on Sakura and Mikan. The emulator walk of rank 1 passed: the moved line and Reload, the reload drawing the new steps, a refusal drawn with Save disabled, and its clearing.

From the adversarial reads of this pass (one of the Gateway's ranks 2 and 3, one of the phone half), fixed before the commit:

- **A said that outlives what it was about.** Mechanism: the editor's `session.said` is kept across edits, and "function moved" was a bare flag, so after a refused save, picking another function still showed Reload and blocked Save. One change: the said names its function and `movedFor` applies it only while the draft still points there.
- **A read that failed read as an answer.** Mechanism: Reload re-reads the list and takes the listed row, and an unreachable read keeps the old rows by design, so Reload reported success over the stale body. One change: a reload lands only when a newer revision was read.
- **Slips:** two phone readers of the walk missed by a search and caught by the compile; Reload offered for a function not yet stored; the check's keep-last-answer rule written inside a composable; a cast could narrow a walk entry around the visitor (now refused by the residue test).

Left as it is: a function step with both an unknown action and `as` now reads "a step does what this Gateway cannot run" rather than the `as` line, so an automation's write still refuses on it.

From the adversarial read of rank 5, which found no road through without an owed prompt, fixed before its commit:

- **A fault told where the owner cannot see it.** Mechanism: one card road (`VaultOps.answer`, the policy-selected sudo card, and a reveal) answered a Boolean, so "could not ask" became a notice the overlay never draws. One change: every card road reads the gate's answer through `cardPresence` and returns the fault as its own line (`PlainAnswered.Fault` beside the three typed answers).
- **"Could not ask" told as the owner backing out.** Four places answered refused for a prompt that never showed: no activity, a prompt activity that failed to start or was blocked, a gate that threw. All answer could-not-ask now, and a prompt's timeout is the owner not answering.
- **A lock a phone could not get out of.** Turning the app lock on asked nothing, and on a phone that cannot show the prompt it could not be turned off again. Enabling asks first, and "no screen lock" is read from the keyguard, not from one biometric status code.
- **The carry judged by what held at the match, not at the prompt.** The receipt now records whether "Every approval" with the app unlocked held when the prompt was asked, and when; the carry's minute runs from the prompt. A change of the approvals setting and a re-provision end the 30-minute window as well as the carry.
- **Tests that could not fail.** Added: the app lock's answers, the one prompt road for a caller with no card, a cancelled loosening, a relock or a setting change during the prompt, the fault's line on each card road, and that a card lets through exactly what `passes` does. `biometric-gate-residue.test.ts` holds who may ask, who may say a prompt passed, and who may mint or spend the carry.

Walked in the emulator against the system's own PIN prompt (a device PIN set, no fingerprint), all passing: with no screen lock the app lock turns on unasked, the app opens and an approval passes unasked; with a PIN, turning the lock on asks first and a cancel leaves it off with no fault line; the lock screen stays locked on a cancel and opens on the PIN; an approval asks ("Approve request"), a cancel keeps the card, the PIN answers it; a typed password that matches a secret asks once and Approve asks nothing more; picking another secret and back asks again; loosening approvals and turning the lock off both ask. Not reached: the fault line itself (five wrong PINs made the system lock the device, which the app read as a cancel), a fingerprint, and the overlay's prompt activity over another app (board, under the vault card).

### Compliance pass

Five lenses (access control, data handling and logging, audit trail, retention, the presence change) and a synthesis that verified each finding against the code. Scoped to what a single-owner system owes: the owner's data staying where expected, a run reviewable afterwards, nothing outliving what it belonged to, nothing sensitive in a log or an answer.

Fixed:

- **A step's row did not say which step.** A run row held the action kind alone, so two `device_set` steps of one function read alike, and two steps refused for one reason logged one row. A row now names the step's path and the function it ran in; a call refused at entry names the call and its function; a standing refusal is logged once per automation, action and step.
- **One busy function could push every other automation out of the run log.** Past its 64 rows the log now drops the oldest row of the automation holding the most.
- **The Gateway called its own key file unrecognized at every boot** ("nothing in this build opens it"), since the automation stores open under a name passed in and the inventory test read literals only. The file is listed, the stores' names are one list, and the test refuses another opener of that shape.
- **A dropped carried automation was logged with its issue's sentence,** which can quote a stored value. The log prints a fixed word.
- **A tightened approvals setting cleared the "Problem reading biometrics." notice** though nothing was asked. An act that asks nothing now answers that, and leaves the notice.

From the adversarial read of these fixes, closed before the commit:

- **A key that two writers of one fact did not share.** The refusal logged for a tell step held by a full outbox carried no step, while that step's ended row did, so after the first refusal and its telling a second refusal read as already logged. Both go through `whereAt` now.
- **A fair cap with nothing that ever leaves.** Under "the largest holder loses its oldest", a deleted automation's few rows would never be the largest and never leave, and enough deletions would starve the live ones. A row whose automation is gone is dropped at each write of the state.
- **Slips:** the cap was a recursion that copied the log per row dropped (a loop now); the inventory test also names every module that constructs a store under a subdirectory, the shape that would slip past it next.

Known and accepted: a build before this one reads the run log row by row under a strict schema, so a rollback loses the rows that name a step, which is nearly all of them. Fires, checkpoints and the outbox are untouched.

Left as they are, with the reason: the key file's mode (a salt for derived ids in the owner's own volume, not a credential); a refusal line that can quote a stored choice value (it goes to the owner's phone alone); function step arguments readable in the live console by host sessions (flat actions already were).

Deferred as a design item (board): nothing records a save, an edit, a copy, a sweep or a carry of an automation or a function, nor that a danger confirm was given. The store keeps a revision per record and no more. Out of scope here and pre-existing: a vault approval or refusal leaves no durable record.

Checked and sound: the four automation ops arrive only as signed owner ops; `automation_check` writes nothing and mints no key; an edit of a shared function asks the danger confirm for every user; the assistant's allowlist names no automation op and the live console gained only a read; pinned bodies do not outlive their fires; a let-go empties the outbox; the phone persists no function, check answer or edit; the presence gate fails closed on a throw, a cancel, a null activity and a timeout.

## Phase 2.7e.3 - The tree (slices 4 and 5) ✅

Design: Phase 2.7e above. The second app update (N+1).

4. **The tree, engine** (Gateway, L). `if`, `try` and `catch`, `exit`, `throw`, `wait`, the frame walk, the failure table, tells as steps, the last run served.
5. **The tree, phone** (phone N+1, L). Steps addressed by path, `cardsDraw`, the If, Try, Wait and Exit cards, the condition editor with "true right now".

Gates: the failure table's vectors; each phone-encoded nested unknown step's JSON matches after re-encoding; a run in a `wait` survives 64 newer fires; one function reached twice tells twice.

### How slice 4 is being built

Written before the code, so a restart of the work reads it here. Each line is a ruling until the code says otherwise.

- **The pass is a module** (`automationPass.ts`, `createPass(ports)`): `pass(input)` reads the state, the answers that came back, the clock and read-only lookups, and answers the next state with the one effect, read and fill to start. `pump()` commits and starts them. The move is byte for byte first; the tree changes it afterwards.
- **The frame walk is its own pure module** (`automationFrames.ts`): given a function's steps, a frame (the path whose turn it is, its variables, its first uncaught failure, the error a catch holds) and how the current step ended, it answers the next path or how the frame ended. The failure table's vectors drive this function alone, with no pump. Inside a function frame, `fire.active` names the step whose turn it is; no scan finds it. `turn` finds the top-level step by path.
- **A step's record is made when its turn comes,** so a side not taken and steps skipped by a jump hold no record, and "what did not run" is the body minus the records.
- **Built so far:** the pass moved out byte for byte (`automationPass.ts`, with `withMessage` as one more port, and `untold` and `droppedRows` exported for `dropOwned` and `watchSensors`); the frame walk and its sixteen vectors (`automationFrames.ts`, `moved` and `entered`), not yet called by the pass.
- **The path is built, numbers only (Question 89):** `within`, `siteAmong`, `below`, `byPath` and `STEP_PATH_RE` in the walk, `siteIn` for a fire, `addressIn` in the frames module to name the sides against a body, `step-path.test.ts`. A string alone no longer says which call a step runs under, so every reader asks the fire's frames or the walk entry's `site`. The stored shape is what it was before sides. Its Kotlin twin and shared vectors come with the phone slice.
- **The kinds are declared, and nothing runs them yet:** `FunctionStepSchema` holds `if`, `try`, `exit`, `throw`, `let`, `wait` and `note`, recursive, with `FUNCTION_STEPS_TOTAL_MAX` (32) across depths and `FUNCTION_DEPTH_MAX` (4). `reached` yields every step at every depth with its `address`, and `steering(answer)` gives a reader one answer for the seven kinds that act on nothing themselves (a kind added later joins `STEERING` by hand, so its readers stop compiling). Each kind's entry in `STEPS` answers "cannot run" until its engine part lands, so a save refuses a tree and an entry refuses a call into one. `serves.functions.steps` lists the actions a `do` step may name, not statement kinds; the phone learns which statements a Gateway runs from a key of its own, to be added with the engine.
- **Frames run through the walk now, for today's flat functions:** `enter` opens the frame on its first step and the call's record stays open; `turn` in the pass moves past an ended step by asking `moved`; a frame keeps `failed`; a frame that ends failed ends its call refused with `CALL_FAILED`, one more row after its steps' own. `hasOpenSteps` is "any record not ended", which also reads a fire stored while a call's record was still replaced by its steps. The engine opens a function's tree through `written` (`frameBody`), which the walk's residue test now names. 
- **The steering kinds run** (as the list below says, with these choices): one read slot reads a condition, a `let`'s value, a `wait`'s minutes and a `throw`'s text, literal or not, and its landing ends the step or stores `until`; no per-path read map was needed. A step record gained `code`, `message`, `side` and `until`; a frame gained `caught` and `vars`. `e` is in scope at the save everywhere and at the run only inside a catch. Tests drive each kind through the engine, a wait across a restart, and a run in a wait through 65 newer fires.
- **An adversarial read of the engine (Sol, with probes) found six things; five are fixed, one is by design:**
  - A set after a wait lost to another automation's set that landed during the wait. A run's sets are now dated by `intentAt` (its fire, or the end of the last wait it passed). This settles the carried 2.7e.1 note below for waits; whose fire a set inside a called function belongs to is unchanged (the calling fire's).
  - A condition read that landed after its run was replaced steered the replacement. A read now lands only on the run it was read for (`sameRun`), and a read whose run is over pumps again.
  - An expression was checked by wrapping it in braces as a text, so `true} ignored {false` saved. An expression now has its own check (`expressionIssue`, the port's `expression`), for a `do` step's arguments too.
  - A refused save named a nested step by its top-level index. The refusal now carries `step`, the walk's numbers under the function, read by `stepPlaceOf`; the three hand-written tree walks in the save checks and fit became the walk's `stepsOf`.
  - A variable's size cap counted UTF-16 units. It counts UTF-8 bytes.
  - By design: a wait is woken by the persist tick, as a retry is, so it ends up to three seconds late. An exact wake is one timer for the pump's next due time, covering retries and waits alike; noted on the board.
- **`as` and the statements key are in:** a `do` step's `as` is refused while its action's row has no `gives` (`GIVES_NOTHING`), and a row gaining one stops the build until a step's end stores its result. `serves.functions.statements` lists the step kinds a Gateway runs, required from 2026-12-10; absent means `do` alone.
- **Question 83 is in on the Gateway:** a confirm's label for a dangerous step names the event's words its own values read (`askLabel`): "Send to IFTTT, with the event's title and reason". A bare `event` reads its title. Not named: a word that reaches the value through a `let`; that would need following values through variables.
- **Question 82 is in on the Gateway:** the automation record holds `keepTryingMin` (every step's window), an event trigger holds an optional `coolDownSec`, and `run_function` holds neither; `cool_down_twice` and the catalogue's `undrawn` are gone. No Gateway stored a function when it landed (checked on Sakura and Mikan), and the installed app never wrote either key on a pointer. An event's cool-down counts from its last admitted match, or from a match the lane alone tells, and covers the lane too: `eventsOf` answers `cooling`, and a cooling automation wakes nobody. The phone draws both settings in slice 5.
- **Tells as steps, as it is being built** (from a map of today's two roads, the fire's aggregate tell and a function step's tell):
  - Every `tell_assistant` action holds a step record at its own path and is told at its turn under `stepMember(member, path)`, with its own `when`, its message, and `note` when the written message had holes. Two tells are two events. A tell after an effect waits for it.
  - A top-level tell whose message has holes is filled at its turn through the read slot into `fire.resolved`, as a frame's `do` step is. The fill slot (`filling`, `nextFill`, `startFill`, `fill`), `tellPlan` and the fire's aggregate `tell` go.
  - The lane keeps an event automation's leading tells with no message, through a pointer into its function's leading top-level steps (`laneTells(body, functionOf)`). Those hold no record at the top level and are passed over inside a frame.
  - A run whose every step is a top-level tell is light: every light run advances each pass, does not count in an event automation's waiting cap, is not replaced by a newer fire, and is the first to go at the fire limit. An event fire past the waiting cap keeps its top-level tell steps and is light. This keeps what a tell-only fire meant before, read from the body and not from a shape.
  - Away from the home a tell step ends refused at its turn. With no room it waits, logged once, until its window passes, then `timeout`.
  - A fire stored with an aggregate `tell` by the build before is told as it stands by a dated reader; one still waiting on its fill is told without its message.
- **Tells as steps is built** as designed above, with these choices: lightness is a flag on the fire (`light`), set at admission and by the strip, so `admit` and `mayRun` stay pure; away from the home a tell is refused before its message is read; the dated reader keeps the old branch in the pass and tells a fire still waiting on its fill without its message, logging it once. Six tests that pinned a tell going ahead of an effect, or two tells merged, were rewritten to the new order. Not tested: the dated reader's fill case (one restart wide).
- **An adversarial read of tells as steps (Sol, with probes) found four things; three are fixed with a test each:** a message that filled to nothing made the stored run unreadable (it is now told with no message); a function's leading tell was passed over on the pinned body alone, so an edit that moved a tell to the front while a run waited lost it (the fire now records the paths the lane told, `Fire.lane`); a tell past its window was still told when room came before the next pass (the window is checked first). By design: a restart starts a waiting tell's window again, as a held effect's. Not from this change, on the board: an event admitted again after it left the 256-member `fired` list is told again.
- **Still open in slice 4 (Opus tier, Question 90):** the log row's kind and the last run served; the judge's tree checks and the condition preview; comment clean-up; the phase audits. The failure of a call inside a function (`call_failed` beyond the top frame) comes with calls.
- **How the pass will run a tree** (in `advance`):
  - The automation's own list is the top frame and stays as it is: its records are made at admission, its turn is its first unended step, and a call's record stays open while its frame runs (today `enter` replaces it with the function's steps; it will keep it and end it when the frame ends, `done` or failed `call_failed` with the frame's first error).
  - Inside a function frame `fire.active` names the step whose turn it is; no scan finds it. `turn` finds the top-level step by path. A step's record is made at its turn. When a step ends, `moved(body, address, how, memory)` answers the next address, a catch entered, or the frame's end, and the frame keeps `failed` (first uncaught), `caught` by try address (what `e` reads), and `vars`.
  - What each kind does at its turn: `if` reads its condition through the read slot and takes a side (a result that is not true or false is `unread`); `try` enters its guarded side; `exit` and `throw` end or unwind; `let` reads its value into `vars`; `wait` reads its minutes, stores when it ends on its record and is over once that passes; `note` is done; `do` is today's step.
  - An `if` side and a wait deadline are stored on the step record, a `let` value in the frame's `vars`, and a `do` step's read action in `resolved`. A restart reuses these stored results.
  - Names in scope: the trigger's, the function's values, the frame's `vars`, and `e` inside a catch (the innermost enclosing one, by `catchOf`).
  - Rows: a `do` step logs as today; a steering step logs only when it fails (`unread`, a `throw`); a run whose top frame ends failed logs one row saying so. The per-step record of the last run carries the rest.
  - A step record gains the side an `if` took and when a `wait` ends. Both are new keys of a strict record, so a build before this drops a fire that holds them; such a fire can only exist once a tree was saved.
- **`functionReads` reads every step at every depth** through the walk's `stepsOf`: a `do` step's arguments, a condition, a `let` value, a `wait`'s minutes and a `throw`'s text.
- **A step is named by its path:** `BodyIssue` carries the walk's `path`, and a save refusal carries `step`, the numbers under the function.
- **Key names:** an `if` is stored `{ when, steps?, else? }`, not `then`: an object literal that defines `then` trips the linter's thenable rule at every place a step is written, and `steps` is already a `try`'s guarded side. The side is still called "then" in an address. `when`, `else` and `catch` are Kotlin keywords, which the codegen backticks.
- **The failure table is a Gateway-only corpus** (`tests/fixtures/automation-frames/failure-table.json`), named so that the cross-runtime vectors inventory, which forces every `vectors.json` through Kotlin, does not claim it.
- **Step kinds** in `FunctionStepSchema`, recursive: `if { when, then?, else? }` (`when` is one expression), `try { steps, catch }`, `exit`, `throw { text? }`, `let { name, value }`, `wait { minutes }`, `note { text }`. A list holds at most `FUNCTION_STEPS_MAX`; a function holds at most a generated total across depths and a generated depth. Unknown kinds stay preserved at every depth.
- **The path** is numbers alone (Question 89). In code a step's place in its body is an `Address` of indexes and named sides; the walk spells it under its call, and reading one back needs the fire's frames (which call) and the body (which side).
- **What a failure is:** `{ code, message }` with `code` one of `refused`, `unreachable`, `no_answer`, `unread`, `timeout`, `thrown`, `call_failed`, `loop`. A step's ended word maps to a code by one table. Outside a `try` it is noted on the frame (the first one stays) and the body carries on; inside one the walk jumps to the `catch` with `e` bound; a failure inside a `catch` is judged by what encloses the `try`. `throw` outside any `try` ends the frame failed. `exit` ends it with whatever was noted.
- **Reads are steps of the read slot:** an `if`'s condition, a `let`'s value, a `wait`'s minutes and a `do` step's arguments are each read once when the step's turn comes, through the one async read the pump already has. A condition or value that cannot be read is the failure `unread`.
- **`as`** keeps what an action gives. None of today's three actions gives anything, so the catalogue row says so (`gives` absent) and a save refuses `as` on them with its own line; the key and the frame's variable slot exist for the action that will.
- **`wait`** ends at a stored time on the step's record; the persist tick wakes it, as it wakes a retry. A run in a wait is started, so it is never evicted.
- **A tell is a step** for every automation: its message is read at its turn through the read slot and told through the outbox under the member of its call-site path. The lane keeps only an event automation's leading tells with no message. The fire's own `tell` and the fill slot go; a fire stored with one is told as it stands by a dated reader.
- **The log row** gets a `kind` (`step`, `tell`, `lost`, `trigger`) that names its own key, and standing refusals are a small state map beside the log, so no call site assembles a key. The row type is renamed away from "run" here.
- **The last run** is served on the automation's row from the run's own step records: per step its path, kind, outcome and reason, and the step in flight. It is kept after the fire ends until the next run or an edit of the body.
- **Built on 2026-11-26 (Opus block):** the row's kind is one of `step`, `tell`, `lost`, `trigger`, each with its own builder, and the old positional `fireRow` is gone, so no call site can build a row without its key. What stands is state (`Log.standing`, by automation then key), so dropping old rows for room no longer re-arms a standing refusal. The 8.14.87 row list is read once, each row given its kind and what stood read back (dated 2026-12-24). The last run carries the side an `if` took and the function each step ran in, and whether it still runs; it is recorded only while the run is on what its automation runs now, so a run kept going on an edited version writes none. The console's `automations.runs` became `automations.log`, and `automations.last(id)` reads a last run. Not done: a record of changes (board) is still only a candidate.
- **Sol's read of it found seven things, all fixed with a test each:** a graceful stop landed a run's last step without recording it (settle records now); a clear written after an edit could fail and leave old steps shown (a stamp of what the run ran is checked when read instead, and the clear is gone); a rollback would have read the new log object as empty (rows stay in 8.14.87's shape on disk, `standing` beside them); two runs at one instant could swap (ties go by admission order); a run's own name spelled like a value previewed as true (it reads as a run value now); one bad stored row lost the whole log (each row is read alone); a step's own reason, such as not home, was lost from its last run (a failed step keeps it). Its second read found three more, fixed with a test each: a function entered at two versions kept only one in the stamp (every frame is stamped), a later admission at the same instant could not replace a run whose fire had gone (each admitted fire gets a place, `State.order`), and one bad standing value lost its automation's others (each is read alone).

First step, carried from the 2.7e.1 architecture pass: take the pump's pass out as a pure function of the state, the answers and the clock, with the active list as the authority for whose turn it is, and drop the fill slot.

Order of work for slice 4, each a child of its board card (`bd_57a7ad81b206819572775b4c9ba5682d`):

1. The pump's pass as a pure function; the active list decides whose turn it is; no fill slot.
2. The step path with sides: one typed path in the walk, numbers only per Question 89 (`0.2.0.1`), a Kotlin twin, shared vectors.
3. The step kinds `if`, `try`, `exit`, `throw`, `let`, `wait`, `note` in the schema, a future-kind fixture at every depth.
4. The frame walk and the failure table with its vectors; conditions, variables, `as`, `wait`.
5. Tells as steps.
6. The log row with a declared kind and its own key; the last run served.
7. Questions 82 and 83.
8. The judge's tree checks and the condition preview op.

   Built 2026-11-26 (Opus block). The tree's checks were already the save's: a condition, a `let` value and a wait's minutes go through `expressionIssue`, which refuses a name not in scope, an assignment, a second statement, a method left uncalled and a slow one; tests now name the assignment and the second statement. No step can hold a doing call yet; that check comes with the script's doing methods (2.7f). The condition preview rides `automation_preview` as `condition` with the run's names (`runNames`), and the op now takes one request instead of four positional values.

Carried from 2.7e.2:

- **The log row gets a declared kind that carries its own key,** and "this refusal is standing" becomes state, not a comparison with the last row (Painpoints: the dedupe's seventh patch). Rename the row away from "run" in the same change, since a run will mean a pinned run here.
- **The stored step path once branches nest** is still to be asked, with the walk's typed path.
- **A record of changes** to an automation or a function (board) is a candidate to ride "the last run served".

Carried from Questions 82 and 83, both riding slice 4 on the Gateway and slice 5 on the phone:

- **"Keep trying for" and "Cool down" belong to every automation** (Question 82). The automation record gains `keepTryingMin`, an event trigger gains `coolDownSec` (zero by default), and `run_function` loses both, while no function is stored on any live Gateway. The phone draws both settings for an automation with its own steps and for a named one alike. An app build older than this one drops them if it edits that automation; that cost is accepted.
- **Outside words are named in the IFTTT confirm** (Question 83). When an IFTTT value reads the event's own words, the confirm's line says so ("Send to IFTTT, with the event's title"). No new dialogue.

Carried from the 2.7e.1 red team, to decide when `wait` and branches arrive: the newer-setting rule ends any open set of an older fire, including one whose turn has not come. With only immediate steps that window is short. Behind a `wait` an older run's later set can sit for a long time, so "on, wait 30, off" must not lose its Off to another automation's On: the rule then has to compare when a step's turn comes, not when its fire began, and say whose fire a set inside a called function belongs to. Also: a pre-send path that can throw repeatedly should log once, and the full-queue refusal needs revisiting if one live run per automation ever changes.

### How slice 5 is to be built: the editor's model for a tree

Written on the Fable tier before the phone work (Question 90). The build is Opus-tier and follows this; each line is a ruling until the code says otherwise.

- **The draft is a tree whose every card holds a key minted once.** `StepDraft` is `Do` (today's `ActionDraft`), `If` (a condition, a `then` list, an `otherwise` list), `Try` (a body, a `catch` list), `Wait` (minutes as typed), `Exit`, `Note`, and `Kept` (a `FunctionStep` cards do not draw: `let`, `throw`, a kind this build does not know, or a field a card cannot hold, such as a wait whose minutes is an expression). The key comes from the phone's ids when the draft is made from a record or a card is added, and is never a position, as a declared value's key already is. Every edit, every said-at and every text page names a card by key.
- **Edits are pure functions over the tree, by key** (`assistant/StepTree.kt`): find, replace, remove, insert at a slot, move to a slot. Each answers the new list, or null where a cap refuses (`FUNCTION_STEPS_MAX` per list, `FUNCTION_STEPS_TOTAL_MAX`, `FUNCTION_DEPTH_MAX`, all generated). The caps only grey out "Add"; the Gateway judges the save.
- **Cards draw one level**, as the phase design says: the list, an If with its two sides, a Try with its catch, Wait, Exit, a Note as a label line. A side that itself holds an If or a Try opens the whole body read-only with a line saying so, until the script exists (`cardsStanding`). A `Kept` card is listed, removable and saved as sent, at any depth, as a kept action is today.
- **What cards draw is one projection:** `cardsDraw(steps, said, lastRun)` answers a flat list of rows, each with its own row key and depth: a step row (the card, its path, its issue, its last outcome), a side label ("Otherwise", "If it fails"), and an add slot naming where a new card lands. The composable draws rows and decides nothing.
- **A card's path is derived, never stored:** `pathsOf(steps)` walks in the Gateway's order (an index, then side 0 or 1) and answers path by key. A refusal's `step` and `param`, a check's refusal, a hole's span and the last run's rows all arrive by path and are mapped to a key there. The Kotlin twin of the walk's path functions (`spelled`, `addressIn`, `byPath`) replays vectors generated from the TypeScript ones (`tests/fixtures/step-path/vectors.json`).
- **Undrawn steps:** `Kept` holds the decoded step; the generated preserve root keeps an unknown kind at every depth. The gate compares each kept step's JSON after decode and re-encode, normalized, not raw file bytes; a sibling edit leaves it unchanged.
- **The stored form is chosen at the save:** every card a `Do` and no name is the flat list, as today. Anything else is a function record and a pointer. What a tree with no name is stored as is Question 91.
- **"Changed" compares wire forms,** never drafts, since keys differ between two drafts of one record.
- **Which cards are offered** is `serves.functions.statements` met with what cards draw. A Gateway that answers none offers `do` alone, and a body holding more opens read-only there.
- **A condition** is one expression, edited on the text page in an expression mode (no braces, the Console's completions over the names in scope) with "true right now" from the condition preview op.
- **Both settings** (Question 82) sit on the draft: "Keep trying for" for every automation, "Cool down" on the trigger form, an event's included.
- **JVM tests:** tree edits keep every other key and refuse at each cap; `cardsDraw` over a body with both sides, a catch and a kept card; the path vectors; the byte-equal case; the save's choice of flat or function.

Built on 2026-11-26 (Opus block) as written, with these changes. Cards draw every depth, not one: an If or a Try in a side indents under it, so `cardsStanding` is not used to lock a body. The byte-equal gate is a JVM test over the shared `function-tree-future-kind.json`: it compares each kept step's JSON after decode and re-encode, normalized, not raw file bytes. The Gateway schema refuses an unknown kind, and the phone-encoded corpus is parsed by it. A card moves up or down its own list (`shiftedSlot`); moving into or out of a side waits for the script. The sandbox serves statements and unnamed functions and holds one unnamed tree with a last run, so the emulator shows both. Walked in the emulator: nested sides, "False right now", the last run per card, the add menu with statements, the condition page with bare names, and the list row of an unnamed function.

Sol's architecture read found six, each fixed with a test that fails without it: a flatten sent no function revision, so an edit made elsewhere was lost (the save names the function it held, and the judge checks it with no pointer left); values were still refused on an unnamed function, against Question 91's second rule; "who else runs it" read automations and not calling functions, on the phone's copy, reach line and delete line, and the Gateway made a function unnamed while unread rows left its users unknown; a fresh body kept the old minted id; a last run could be drawn over cards an editor opened at an older revision; and a trimmed condition put the Gateway's offsets in the wrong place. Not taken: binding a check's `reads` to the exact op, since the last answer is closer to the draft than the stored row's and the next check replaces it.

## Question 91 - What is a tree with no name stored as?

An automation's own steps are stored flat, with no function record, and a flat list cannot hold an If. A function record's name must be at least one character. Question 75 said nothing asks for a name.

Q: When the owner adds an If, a Try, a Wait or an Exit to steps that have no name, what is stored?

- **A) A function with an empty name.** The Gateway lets a function's name be empty; such a function is private: never listed in the picker, never shared. The name field still reads "Name", and typing one makes it shareable, as today.
- B) A name is asked for when the first such card is added.
- C) The phone names it after the automation's sentence.

Recommended A: it keeps "nothing asks for a name" and "unnamed is the automation's own steps", and B and C put names in the picker the owner never chose.

The owner, 2026-11-26, leaning to A and asking for a second opinion before it is settled:

> A. is essentially a lambda function?
> rubber duck with Sol if so. might be the way.

Yes: an anonymous function, the same record minus its name, owned by one automation. Sol was consulted on A against storing the tree inline on the automation with no function record (A2).

Sol's answer, checked against the code: A2 makes ownership a property of storage (an inline tree cannot gain a second user, needs no sweep and no function slot), but costs a second executable-body form in the engine's frames, the walk, the judge and both phones, and an installed phone that re-encodes an automation would drop the inline tree. A fits the frames and the walk as they are. Its risk is treating it as a one-character schema change: nothing today stops a second automation pointing at such a function, a carry can recreate sharing, and the installed phone flattens a blank-named body it can draw.

A: A, as an ownership rule the Gateway enforces, told to the owner as taken unless they say otherwise. The three rules written first:

1. **One private body, one owner, one entrance.** A name that is empty after trimming means anonymous. The judge refuses a save or copy that adds a second pointer or any caller. A carry can land a second pointer or caller; the affected row reads invalid (`FUNCTION_PRIVATE`). While users are unknown, ownership changes do not land. The function stays listed for its automation's editor and for a carry, but not in pickers or calls.
2. **Naming keeps the id and the contents.** Typing a name makes it an ordinary function under the same id. Clearing the name of a function only its automation uses keeps the tree, its values and its bindings as the anonymous function; a shared or called one is copied first. A body is flattened to plain actions only when it is exactly a list of `do` steps with no values.
3. **Readers before writers.** Only the tree-capable app writes one. A move to a Gateway that cannot hold one is refused before anything is touched, as an unheld step kind is. A rollback to a build that requires a name leaves the record stored and its automation invalid until the build returns.

It counts toward the 32-function cap, and "Make unique" on an anonymous body gives another anonymous body, never a name.

**How the Gateway half is to be built** (Fable block 1, after the Calls engine):

- **A name may be empty.** `FunctionSchema` takes a name of no characters and refuses a name of spaces; `unnamed(fn)` is an empty name, and is the one test of it on the Gateway. (First built as "empty after trimming"; Sol's read showed a name of spaces would pass an older build's check on a rollback and run shared.)
- **Ownership is judged at the write, with ids.** After a save, an anonymous function has at most one automation pointing at it and no function calling it. The judge checks every function the save writes or newly points at, in both directions (a written body calling an anonymous function, and an anonymous function gaining a pointer or a caller), and refuses with the code `private` naming the function. Clearing a shared or called function's name is the same refusal: it is copied first.
- **And read at every read, as validity is.** A call that names an anonymous function, and a pointer to an anonymous function more than one held automation points at, read invalid (`FUNCTION_PRIVATE`) and never run. This is what covers a carry and any road that is not a save: rows land and say why, as an unfit carry does.
- **A copy of one is one.** "Make unique" sends a body with no name; it lands under the derived id as today.
- **Its end:** an automation that stops pointing at its anonymous function, or is removed, deletes it in the same write, as the delete at none does today.
- **`serves.functions.unnamed`** tells a phone this Gateway holds one, so the tree's Save is offered only where it can land.
- **Rollback:** a build that requires a name holds the record unread, its automation reads invalid, and a run inside it is dropped. Stated, not engineered around.

Built on 2026-11-26 as written. For the phone half: a new unnamed function takes a fresh id every time (a removed id is buried and a save under it is refused `gone`), the picker leaves out rows whose names are blank, and `private` has its line. The Call picker and its unnamed-row filter come with the Call card (slice 6).


## Phase 2.7e.4 - Calls (slice 6)

Design: Phase 2.7e above.

6. **Calls** (Gateway M, phone M). A function calling another, the loop guards, the Run button under a call id, where a function used only by callers is edited.

Gates: a loop refused at the save and held at the run; a callee failing outside a `try` while its caller sits inside one; an edit of a callee while a run waits inside it.

### How the Calls engine is being built (slice 6, Gateway half)

Written before the code (Fable block 1, Question 90). Each line is a ruling until the code says otherwise.

- **A call is its own step kind:** `call { function, values? }`, the values keyed by the callee's value names, each a literal or an expression read in the caller's scope when the call's turn comes. It is not a `do` step: a `do` step's arguments are flat and capped at `STEP_ARGS_MAX`, and a call is never an effect. A future-kind fixture covers it at every depth, as each statement before it.
- **The walk follows calls.** `reached(automation, functionOf)` descends through a `call` into its function's steps, each under its call's path, so the step path already names every call site and `stepMember` tells a function reached twice as two events. The descent carries the chain of function ids above it: a function already on the chain is answered as a call not followed, reason `loop`, and never entered. A cap on entries bounds a walk whatever the records hold.
- **Frames nest by path.** `fire.frames` is keyed by call path already, and `siteAmong` picks the longest site above a step. A `call` at its turn reads its values through the read slot, then `enter` opens a frame at the call's own path, pinned as a pointer's frame is, holding the values it was given (`frame.values`). A pointer's literal values are copied into its frame the same way, so `scopeOf` reads a frame's values in one place.
- **A callee's end is its call step's end.** `turn` ends the call's record `done`, or failed `call_failed` carrying the frame's first uncaught failure, and the caller's frame moves on through `moved` like any step: inside a `try` it jumps to the catch with `e.code` `call_failed`; outside it is remembered and the body carries on. The top frame's rule (the automation's own list) is unchanged.
- **Loops are held twice.** At the save, the judge refuses a function whose calls reach itself through the held and incoming rows (`loop`, naming the function that closes it). At the run, entering a function whose id is already on the frames above fails the call `loop`, since a frame pins the version it entered and a later edit could close a loop the save never saw. A run holds at most `RUN_FRAMES_MAX` frames; one past that fails `loop` too.
- **Scope:** a callee reads the trigger's names, its own declared values and its own variables. It reads nothing of its caller's but what the call passes. A call's values are checked as a pointer's are: every declared value is given by the call or by the trigger, by name and type for a literal; an expression is checked to parse against the caller's names.
- **Users** are every automation pointing at a function and every function calling it (`usersOf`). A function only callers use is listed, kept and carried: the sweep, the delete at none, `moves`, a carry's choice and the outside-reach and danger asks all read users and reach through calls.
- **The lane's leading tells stop at a call.** Only an automation's own leading tells and its pointed function's leading top-level steps are the lane's.
- **An edit of a callee while a run waits inside it** changes nothing for that run: the frame pinned its version at entry. A run that has not yet entered takes the new one.
- **Keep trying** is the setting of the automation that started the run, for every frame (already so since Question 82).
- **Order of work:** the step kind with its fixture and the Kotlin ripple (compile only); the walk's descent with the chain; frames with values and the nested end; the run's loop guard and frame cap; the judge's loop and fit checks and `usersOf` through calls; tests for the three gates; then an adversarial read.
- **Left for the Opus tier:** the Run button's op (`automation_run` under a call id, an automation fired once by hand with the names readable at any moment), and everything on the phone.

Built on 2026-11-26 as written, with these additions the code asked for:

- **One save writes a called function too.** `automation_save` takes `called`: the functions the automation's calls reach, each an id, a body and a base (0 adds it), landed in the same batch as the automation and its own function. Each must be reached by the automation as the save leaves it. This is where a function used only by callers is edited: from the automation that reaches it. The answer holds their rows (`called`), and a stale one is refused `moved` naming its id.
- **Reach, not pointers, decides who is asked.** Every automation that reaches a written function (`reachOf`) is checked for fit and for what it would newly do. A call that would stop fitting, a call cut by the write, and a loop are refused even when the automation's own row is unchanged.
- **The list** answers `callers` on a function's row, and `moves` and `reads` follow calls. A function no automation reaches is unlisted and swept after a week, with what it called once nothing reaches that either.
- **A move** carries every function its automations reach (`carriedFunctionsOf`, both runtimes, shared vectors), maps each carried body's calls to where the callee landed, binds a call whose function did not come to no staying function, and keeps a move in place's callees as held.
- **The phone's call walk:** it follows calls with the chain and budget, and Android replays the shared vectors, including nested, loop and missing cases. The Call card remains deferred to slice 6.

### How Calls are to be built on the phone, and the Run button (slice 6, Opus block)

Written before the code. Each line is a ruling until the code says otherwise.

- **A call is a card:** `StepDraft.Call(key, function, values)`, each value a `Typed` literal as the callee's value type reads it, or a `Read` expression in the caller's scope. The card offers a name in scope (the trigger's, the caller's values, kept values, `e` in a catch) as a `Read`; any other stored expression is shown as written and can be cleared, never edited in place.
- **The call picker** lists named functions only, leaves out any whose calls reach the function being edited (a loop), and shows each one's values as the pointer picker does. "New" makes a named function with no steps, written with base 0.
- **A callee is edited from inside the automation's edit:** the Call card opens its page, a stack of function ids on the draft (`inside`), drawing the callee's cards with `CardsSection`, its name read-only and who else runs it. Its edits sit on the draft (`callees`, by id, with the base and body it was read at) and every key is unique across the draft, so a text page, a said-at and a refusal find their card wherever it sits. A refusal naming a called function by `id` maps its `step` path under that function's cards.
- **The save sends `called`:** every callee whose body differs from what it was read at, with its base; an unchanged callee is not sent. A callee nothing reaches any more is dropped from the draft before the op is built, so the Gateway's "the automation does not run it" is never earned by the phone.
- **No last run on a callee's page:** a callee reached from two sites has two paths. The Call card itself shows how its call ended.
- **The walk's twin:** follows calls as the TypeScript one does, through `if` and `try` sides and into callees under the call's path, with `loop`, `missing` and `budget` outcomes. Android replays the shared vectors, including call, loop, missing and nested cases. The phone reads reach through it, never its own descent.
- **The Run button** fires an automation once by hand: `automation_run { automationId, callId }`, deduped by the call id, admitted as a fire of its own (`manual`), its names read from what the trigger would give now (a crossing's reading, a clock's time), and a name it cannot give reads unread, as a hole that cannot be filled does. It is refused for a disabled automation and away from the home for an event automation, and logs as any run, so the last run shows it. The button sits in the editor's menu and is offered only when the draft is unchanged.

Built on 2026-11-26 as written, with these notes. The call picker is a menu on the card, not a page. A callee's name and values are read-only on its page; its cards are what the edit changes. The check op now carries `called` too, which it lacked, so a check judges the same payload a save sends. Texts and conditions on a callee's cards preview with the callee's values, none set. A `moved` refusal was read as the pointed function moving whatever `id` it named, so Reload would have re-read the wrong function; it now follows the `id`, and a callee's Reload replaces that callee alone, saying when its step edits were dropped. The alignment audit found five more, each now held by a test: a callee the automation no longer called still blocked Save; the Gateway named no function in a hole or step refusal inside a callee, so it landed on the automation's own cards (it now names an id the phone sent, never a copy's derived one); a nested callee that moved blocked Save with no line; a value the trigger gives drew an input its run would ignore; and the callee page did not say who else its edits reach. Its re-audit found three more, each held by a test: a moved callee the automation no longer called still blocked Save; reach was read against the list as it stood when the editor opened, not the fresh one; and a callee the Gateway lists as invalid drew no line on its Call card. A Reload of the pointed function still leaves the draft changed (Run now hides until the editor reopens); that waits on a rebase that keeps value keys. An adversarial read (on Opus, Codex being out of quota) found the stale callee copy below and eight smaller defects, each now held by a test where a test can reach it: a value typed then erased counted as an edit and resent an unchanged callee; Run now could fire twice after an unanswered tap and showed an old answer in a later opening (a retry now keeps the unanswered call id, and an answer shows only for the opening that asked); a value the callee no longer declares was kept unseen (now drawn with Clear and blocking Save); re-picking the same function cleared its values; the new-function name had no cap; a refusal by path lost its function; a Call card's refusal was said twice; and two navigation controls ignored a send in flight. The Gateway also names a sent callee on `gone`, `spent` and `bad_id`. Walked in the emulator: Run now with the last run updating, a Call card picking Blink with one value read from `value`, Blink's page with its plug read from a value, an edit there saved through `called`, and the row reading "If · Try · Call".

### Bug Classes

From Sol's adversarial read of the Calls engine (five findings, each traced against the code and each now held by a test that fails without its fix).

- **B, a third time: where a carried reference lands.** Mechanism: `judgeCarry` decides a landing id through predicates applied in claim order (`takeable`, `claimedBy`, `inPlace`, and now `vacant`). Round one (2.7e.2) made a derived id free only for its own source; round two closed the in-place bypass writing over a stayer's function; this round found a call or pointer whose function did not come binding to a function a let-go kept, and a claim made before a kept callee's own taking its id. Patched: such a reference lands where nothing is held (an older phone's move back excepted, which a shared vector needs), a carried function a move in place keeps holds its id first, and the plan is refused when two sources share a landing. Sol's second read found both patches leaking through the in-place exception (an arriving call bound to a kept callee that did not come; a carried function landing on a kept callee that was not carried), and its third read found the fourth patch substituting a kept body for an arriving function. That was the mechanism failing a fourth time, so the landing was rewritten instead of patched again, as three rules: an automation already here keeps the function it holds and nothing lands on that function or on what it calls; only what an arriving automation needs is landed, on its own id when only movers run it and else on a derived one; a reference whose function did not come lands where nothing is held (an older phone's own id excepted, when only movers use it). In-place sources no longer bypass claims, a carried function nothing needs is written nowhere, and one landing has one source. Every shared vector holds unchanged, the retry among them. Sol's read of the rewrite found no overwrite, substitution or shared landing, and two smaller cases, both fixed with a test: a rerun moved a pointer that shared a missing function with a kept body's call, and an unread automation row at a pointer's id was read as an unread function.
- **A user set read before the write it judges.** Mechanism: `unused` read who runs a function from the held rows, so a save whose new function calls the old one deleted it. Same shape as class C (2.7e.2). Patched: it reads the save's own writes. `usersOf` over the rows as the write leaves them is the one reader that would end it.
- **A recursion over callers.** `moves` walked every path through callers; a stored graph of 32 functions calling each other many ways made a move's judgment take without end. Now a least fixed point.
- **A call checked less than a pointer.** Mechanism: the pointer's fit went through `fitOf`, a call's through a hand copy that knew no types for the trigger's names and none at entry. Now one `boundIssue` for the pointer, the call at the save, and the call at its entry.

### Bug Classes (phone half)

- **A stale callee copy of the function the automation runs.** Mechanism: `AutomationDraft.callees` keeps an opened callee after the automation is pointed at that same function (`pointedTo`), so every reader that asks the callee map first reads a body no page shows. Round one: `reached` walked the copy, so the picker judged loops on it. Round two: a Reload re-read the copy instead of the pointer. Round three: a refusal on the pointed function landed on the copy's card, blocking Save with no line. Each round was patched where it read (own body first in `reached`, the pointer first in `reloadFunction`); the third closed it at the source: pointing at a function drops its callee copy, its page and a text open on it, so no reader can meet one. The architecture audit then found the wider form: any untouched callee copy was read as the truth (for reach, params, the picker, the card's line and what a save sends) while the Gateway judged its stored body, and the editor and the save each walked reach their own way. Now one reader, `functionSource`, answers a function's params and calls (its cards while edited, else the listed row), `reachOver` is the one walk, and the second walk and both defaulted resolvers are gone. Its adversarial read found that a page could still draw an untouched copy the reader no longer trusted, which let a save drop a callee's edits with no word, and that "changed" read reach from the list the editor opened with. A list that lands now re-reads every untouched copy whose row moved, edits nothing calls any more are said to be left behind, "changed" counts any held callee edit (an empty new function aside), pointing at an edited callee carries its edits, and a Call card draws its own value issue.

### How Calls on the phone is to be built (slice 6, phone half)

Written on the Fable tier for the Opus-tier build; each line is a ruling until the code says otherwise.

- **A Call card** is a `StepDraft` of its own: the function it names by id, and one row per value the callee declares, as a pointer's value rows are today (a typed literal, or a name in scope picked from "Names here"). A value the trigger gives shows as given and holds no row.
- **The picker** lists the listed functions that have a name, never the automation's own function and never one whose `callers` chain reaches it (`row.callers`, walked on the phone only to grey out a pick; the Gateway refuses a loop by code `loop`).
- **Opening the callee** from the card edits it inside the automation's own edit, as a text is edited on its own page: the draft holds a map of opened callee drafts by function id, each with the revision it was opened at. Save sends one `automation_save` whose `called` holds every callee whose wire form changed, base its opened revision, and a new function made from the picker's "New function" with base 0 and an id the phone mints.
- **The check** sends the same `called`, so a refusal inside a callee arrives by `record: "function"`, `id` and `step`, and is drawn on that callee's page, with a line on the Call card that it holds one.
- **A `moved` refusal with an `id`** names the callee that changed elsewhere: Reload re-reads that one, as the pointed function's Reload does.
- **The walk's twin:** follows calls with the chain and budget and replays `tests/fixtures/automation-walk/vectors.json`, including call, loop, missing and nested cases. `usedBy`, the confirm labels and `carryRefusal` read it.
- **The Run button** is the last piece: its op is the Gateway's to add first (an automation fired once by hand, admitted as a run of its own with the trigger's names read as they stand), then a button on the editor's bar.

## Phase 2.7f - The script (Q57, Q58, Q60 to Q63, Q65)

Stands on 2.7e.

- **The script is a view of a function's steps, and the steps alone.** The trigger and the automation's settings stay in their forms; the page heads with the signature, shown and not typed (Q65).
- **A line scanner of its own,** with a Kotlin twin and a vector file: it strips a comment outside a string, ends a statement at a newline unless a bracket is open, and reserves the statement words, the later ones included (`parallel`, `start`, `await`, `all`, `any`). The console's lexer, where `/` is one operator and a newline is space, stays as it is, and every console vector and hole fixture is unchanged.
- **Expressions** go through the console's parser, exported for one expression, bounded per expression with a cap on the script. An escaped brace stays escaped.
- **Doing methods** are built from the action table under an audience of their own and are never called by the evaluator: the parser lifts each into a step. The fence test proves a doing member answers refused through the console and through a hole.
- **One rule for names:** declared values, variables and `e` shadow entities, in a body and in a hole alike. A save refuses a name that collides with an entity, a trigger's name or a reserved word.
- **Types** are a closed vocabulary with member tables, an error type among them, so a variable's completions have something to read.
- **Round trip:** `parse(print(f))` equals the canonical function, pinned by a corpus over a fixed table of devices and functions, with the printer's own number and string encoders.
- **The phone holds no parser.** It paints structure from the line scanner's twin and asks the Gateway for the tree, the issues and what is in scope where.

Slices:

1. **The script on the Gateway, read-only on the phone** (Gateway L, phone M).
2. **Script editing** (phone L). Typed completions and hints through a variable's members.

Size: about 2,500 to 3,500 lines.

## Phase 2.7g - Side by side, and the map (Q50, Q64)

Stands on 2.7e and 2.7f.

1. **`parallel { }`** (Gateway L, phone M). Several active steps in one run under a cap, each with its own wait, outcome and claim; two calls to one device run in the order written; `e.errors`. A "Together" card.
2. **Tasks** (Gateway M, phone S). `start`, `await`, `all`, `any`, typed. A run does not end while something it started still runs. Script only.
3. **The flow map** (phone L), after a Designer pass for function nodes and call edges. The styling locked in Question 50, replay per automation.

Size: about 2,500 to 3,500 lines.

## Phase 2.7d - Walk-through and cleanup

Installed 2026-11-18 as 8.14.83, on the owner's word (Questions 61 and 71): the plugin release, the Gateway and the host daemon restarted with a fresh host token, then the app over adb. Riding along: the Copilot delivery typed mid-turn, the host token read by the daemon's own script, the op store's eviction line said once a minute, and two message editor fixes. Every gate passed first, and emulator walk 16 passed.

On start the Gateway turned the four stored GitHub rules into event automations and the stored "Outside below 2 °C" threshold into a crossing. Five automations, all enabled.

Walked on the owner's phone against the real Gateway, with the phone lent for it: Sessions, the menu, Sources with live readings, a sensor's page, both editors, the message editor with a live preview, the leave dialogue, a save and a delete of a test automation, and a Console read. Nothing of the owner's was changed. Not walked: Routines, Runbooks, Vault and Policies, a crossing reaching the assistant, the Copilot typing change. Four small things seen are on the board.

Still owed here: the owner's own use of it, and the list below.

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

- **The start scripts deploy the working tree, not a commit.** `start-gateway.sh` and `start-federation.sh` build whatever is on disk, so a deploy while a teammate has unfinished work in the tree means stashing it, telling them to stop, and popping it after. It happened twice in one night, and once a Router went live on uncommitted code that an independent read then found a regression in. A deploy from a clean worktree at a named commit would end both.
- **A row the Router writes was only as visible as its writer remembered to make it.** Each writer pushed its own owner rows (`deliver`'s owner branch, the bridge's hook) and the scheduled service pushed none, and `pushOwnerRow` in `consoleSockets.ts` sent the new row alone, so the next push let the phone ack past every row it was never sent. No test held a console socket open through a scheduled fire, since the harness phone reads by owner op. Found only by putting log lines in a debug build on the real phone.
- **The release app keeps no log I can read.** `DebugLog` streams to the Router's ingest only in the debug variant, so a defect seen on the release build takes a debug install to observe and a release install to put back, each closing the owner's app.
- **A store's refusal is a string.** `policies/store.ts` answered ten refusals as prose and the phone printed them; the policy family is codes now, and `runbooks/store.ts`, `routines/store.ts` and the automation judge still answer prose the phone shows as it comes.
- **A field that takes a command lets the keyboard rewrite it.** `PolicyEditor.kt`'s Command field set no `KeyboardOptions`; only the console and the vault entry dialog turn autocorrect off, each on its own.
- **Saving a typed secret makes a twin and no policy.** `VaultOps.answer` with `saveTyped` stores a new entry titled with the request's shape every time, and nothing binds it to the command, so the next request for the same command asks again and a second save makes a second entry of the same title.
- **The phone's wireless adb port moves.** A serial of the form address and port died mid-session when the phone re-advertised; the mDNS name (`adb devices` lists it) held. `scripts/phone-install.sh` takes whatever `ANDROID_SERIAL` says.
- **A plugin update renamed the cycle's steps under a running cycle.** `red-team-fan-out` became `adversarial-fan-out`; a jump to the old name left the tracker on a step with no section, and a jump to the new one skipped it, since the run's kept step list named the old one.
- **Messages to a teammate cross with its reports.** A go-ahead sent while a report was in flight was answered by a second request for the same go-ahead, four times in one night. A teammate's report carries no mark of which of my messages it had read.
- **A fix written from one sequence closes the way out.** Three fixes of one round each refused on an unknown state and, with it, the owner's recovery: `AssistantLocationPage` lost the move off an unreachable home, `issueOf` in `assistant/AutomationActions.kt` blocked the save that would remove a home-only action, and `peersLanded` in `TrustOps.kt` held an untrust behind an offline Gateway. Each was correct for the sequence its finding named. Nothing in the repo lists, per page, the states an answer can be in against the acts the page offers, so every such fix is checked by hand and the audit brief had to grow a "name the recovery path first" line.
- **The phone drops what it does not know, except an action's kind.** `wireJson` ignores unknown keys, a toggle sends `row.automation.copy(enabled = ...)` in `AutomationOps.kt`, and `toAutomation` in `assistant/AutomationDraft.kt` rebuilds the record from the fields this build has. A new optional field on a record or on a known action is therefore lost by any older phone on a toggle, an edit or a home move, silently, which forces every later feature to arrive as a new kind. A raw passthrough for record fields would end that constraint.
- **Time is the wall clock everywhere in the fire road.** `Sighting.since` and `retryAt`, `EFFECT_LATE_MS`, a clock's stored slot and the outbox's retention all compare `deps.now()`. Each clock-step finding took its own patch (`retryDue`, `skip` on a slot, the restart from now), and a forward step still refuses pending effects. `Ambient` offers no monotonic reading, so every new deadline repeats the class.
- **The run log's dedupe has been patched seven times.** `logged` in `automationLog.ts` keeps one 64-row ring for every automation and decides by comparing the last row under a key; each key hid a row the next finding wanted (per automation, per action, standing reasons, lost runs, and now per step). The seventh patch broke at once: the key's parts are optional positional arguments of `fireRow`, so the one call site that logs a tell step's refusal compiled without its step and stopped being logged after the first time. It wants rows with a declared kind that carries its own key, and "is this refusal standing" kept as state instead of inferred from the last row. Carried to the tree's engine slice, which reworks what a run records.
- **A fair share with no exit for the departed.** "The holder of the most loses its oldest" is the rule for fires, the outbox and now the run log. In the log it would have kept a deleted automation's few rows for good, since a small holder is never the largest; it needed a prune at each write. The outbox and the fires each have their own exit (`dropOwned`, `retireOf`). A fourth use of the rule will need a fourth.
- **`records.get` answers null where most lookups answer undefined.** A filter written `!== undefined` over it compiled, kept every row, and only a behaviour test said so. The two absent values mix across the store's readers (`records.get`, `own`, `Map.get`).
- **Each test file builds its own world.** `fullQueue` lives in `automations.test.ts` and the function runs have another `world()`, so a stage-level case that needs a full outbox and a function copies one into the other.
- **`automations.ts` grew through every fix round** to about 1,150 lines with the pump, restore, validity, wording and the store door in one closure. The pure rules moved out (`automationFires.ts`, `automationOutbox.ts`, `automationLog.ts`); the state, validity and wording moves and one builder for the automation pair are still owed, and each round that lands first makes the move larger.
- **A working day's load takes the host down.** One Gradle gate (test workers and the Kotlin daemon), the Android emulator, Lexicon's TypeScript provider for this repo (7.6 GB at its peak) and several agent sessions exceeded 30 GB, and the kernel's OOM killer took the desktop session with a 6.7 GB `bun`. `scripts/kotlin-gate.sh` neither caps Gradle's workers nor stops its daemon, and the emulator is started and stopped by hand. A walk script that refuses to start beside a Gradle run, and a gate that stops its daemon, would have prevented it.
- **The emulator's Gateways are uneven, and the list of what they cannot show lives outside the repo.** `SandboxRoutineGateway` answers a fixed list and forgets a save, `SandboxAutomationGateway` keeps one, the Users page reads a Router the sandbox never reaches, and whether `parsing` reads as an older build depends on which answers the phone happens to read. Each cost a walk finding to rule out. The walk guide with its known gaps is a scratch file; `docs/testing.md` should hold it.
- **A dated shim classifies before its reader can.** `listAnswerOf` folds a prose refusal into `NotServed` under `ProseRefusal.OLDER_BUILD`, so `AutomationOps.refresh` could not tell the permanent token from the shim's prose and needed a side flag (`AutomationListing.prose`) to apply the rule only to prose. The first attempt demoted the token too.
- **A new console answer is registered in four places.** A result schema goes in `schemasConsoleResults.ts`'s list, the codegen's schema lists (`scripts/codegen-kotlin.ts`, twice), the TypeScript fixture map in `src/__tests__/protocol-fixtures.test.ts` and the Kotlin `when` in `ProtocolFixturesTest.kt`; missing one fails late or not at all (the run op's answer was not generated until a grep found it missing). One registry the codegen and both fixture tests read would make it one entry.
- **A wire word the phone reads has to be generated before it can be read.** `RUN_OUTCOMES` was a TypeScript enum the codegen did not emit, so `lastStepLine` first spelled "refused" by hand and the wire-vocabulary residue test caught it. Every `z.enum` the phone switches on could be emitted as a `Protocol.Wire` enum by the schema walk rather than listed by hand.
- **The draft's card operations assume one tree.** `AutomationDraft.withStep`, `plusStep`, `minusStep` and the move menu work on `draft.steps`; a callee's cards (slice 6) need the same operations over another tree, so they either learn a tree id or every caller passes its list.
