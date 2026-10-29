# Questionaire

Goal: "where the assistant lives" becomes one Router-owned fact, so the phone never asks every Gateway whether it holds the assistant, and a Gateway that was offline during a move corrects itself when it returns.

Today each Gateway keeps its own placement (the `host.assistant` session record that `assistant_place` mints and `assistant_release` forgets), and `AssistantOps.move` asks every Gateway through the Router, places on the target, then releases the rest. Precedents: the task board and the vault are Router-held owner records; the share mirror (`CrossDomainShareState`) is Router-owned state a Gateway follows by snapshot then deltas.

## Question 1 - Who writes the home record?

Q: The phone writes it on the Router and the Gateways follow, or the target Gateway places itself and then claims it on the Router?
A: The phone writes it; the Gateways follow.

Recommended: one owner-signed CAS write, the same authority model as the board and the vault, and its one gap ("chosen, not yet running") is visible rather than silent. A Gateway claim needs two writes with a gap where a Gateway runs the assistant while the Router names another home, and a new rule letting a Gateway write owner state.

## Question 2 - Per person?

Q: If each person has their own assistant, is the record per user?
A: Yes. A Router keeps owner state per Domain, keyed by the Domain owner's signing key (`OwnerStoreRegistry.ownerKey`), so each person's Domain holds its own home record, and a friend's Domain never sees it (`friendProjection` already drops the assistant's presence row).

## Question 3 - Rollout: clean break or gentle migration?

Q: Raise the Router's protocol floor so a Gateway that does not follow the record cannot register until updated, or keep the phone's ask-every-Gateway path for older Gateways with a dated removal?
A: Clean break.

The floor is `FEDERATION_PROTOCOL_FLOOR`, refused in `RegistrationHandler.handle`. A record never written must not read as "released", or Sakura drops its live assistant on upgrade.

## Question 4 - Who writes the first record?

Q: The phone, once (finding "never written", it asks the Gateways one last time and writes the holder it finds), or the Router adopting the first Gateway whose presence says "assistant"?
A: The phone, once.

Recommended: presence is a Gateway's report, not the owner's decision; arrival order would pick the home; presence carries no folder, and the Router cannot seal one. The phone seals the folder with the content key. It seeds only when every Gateway answered and exactly one holds: silence never becomes "none". Otherwise it writes nothing, and Set up picks among several holders. Two phones: the first CAS wins and the other adopts it.

> "I released from Sakura. So no migration even needed."

No Gateway holds it now, so on this Domain the first Set up writes the record.

Rules carried from the checks:
- `assistant_place` and `assistant_release` leave the console ops, so an older phone cannot fork the placement; its Move is refused until it updates. (Refined from "refused once a record exists": a Gateway cannot tell a phone's age.)
- A Gateway that reads a record naming another stops its watcher lanes at once and releases, so a returning stray never acts on GitHub beside the home.

## Question 5 - How does the phone learn a move landed?

Q: A report from the target plus presence, or presence alone?
A: A report from the target, plus presence.

Recommended: presence says online, asleep (`available`) or waking (`verifying`) but not which choice a row belongs to, and it cannot carry a refusal reason; a report alone cannot say awake. The named Gateway sends an incarnation-gated frame, "placed at revision N" or "refused: reason"; the Router keeps it only when the sender is the named Gateway and N is the current choice, apart from the owner CAS version so a report never moves the phone's write base. The phone shows moving, placed and asleep, running, refused with the reason, or offline and taking over on return.

Move order: every other Gateway lets go the moment it reads the new choice. The new home's first poll primes and wakes nothing, so a connected old home has a whole poll interval to stop: never two acting on GitHub at once. The one exception is a home moved away from while unreachable (Question 6), which acts until it returns.

## Question 6 - A Gateway cut off from the Router

Q: While cut off, does the home keep running on its last copy, pause, or keep running while the phone guards the move?
A: It keeps running; the phone guards the move by direction.

> "Depending on direction, I'm thinking
> "Sakura can't be reached. Moving now will abandon the assistant notes."
> or
> "Sakura can't be reached. Cannot setup assistant on the gateway.""

- **Away from an unreachable home:** the phone asks first, and moves on confirm. The old home keeps running until it reconnects, then lets go and deletes its settings; nothing traveled, so they are lost. Its notes folder stays on its disk. Reworded:

> "Sakura can't be reached. Moving now will abandon the assistant settings and notes."
- **To an unreachable Gateway:** refused, nothing written, with the second line. So no move leaves a choice waiting on an offline target; "Moving to..." lasts only while a reachable target applies.
- The phone reads reachability from the Router's roster, so a Router restart never pauses the assistant.

## Question 7 - What travels with the assistant on a move?

Q: Keep rules, Safety and secrets per Gateway as today, or carry them?
A: Carry the rules and settings when the old home is up; no files.

> "if a gateway is down, no move. if up, move all and clean up just the assistant settings files"
> "hmm. maybe just rules and settings for now. no bundle of files"

- **Old home up:** its watcher rules and Safety travel to the new home, and the old Gateway then deletes only its assistant settings files.
- **Old home down:** nothing travels; the move goes ahead only on the confirm above.
- **Notes folder:** never copied and never deleted; it stays on the old host's disk.

## Question 8 - How do the rules and settings travel?

Q: Inside the move, the phone copying them after, or Router-owned permanently?
A: Inside the move.

Recommended: the phone reads the old home's rules and Safety (asking only that Gateway), seals them with the content key, and puts them in the record it writes. The new home applies them as it places; the old home deletes its copies once it reads the record and lets go. One write, so a phone that dies mid-move loses nothing, and the Router sees only ciphertext. Copying after leaves the new home bare if the phone dies between steps.

Defaults, not objected to:
- The watcher's secret grant travels only when that vault entry is allowed on the new Gateway; otherwise it is dropped and shown as needing a secret.
- Watcher poll state does not travel; the new home starts a fresh poll whose first pass wakes nothing.
- What travels replaces the new home's own older rules from a past stint there.

## Question 9 - What does a plain Release do with the rules and settings?

Q: Into the record, so the next Place anywhere restores them, or left on that Gateway as today?
A: Neither. Release becomes Remove, and Remove wipes.

> "I don't know what release meant before, but it should be wiping. So there's move, which keeps, and remove which removes"

- **Move keeps:** the rules and settings travel in the record to the new home.
- **Remove wipes:** the record becomes "nobody" with nothing carried, the home (if reachable) deletes its assistant settings files, and the phone drops what it held. The next set up starts fresh. The notes folder is never deleted.

An earlier answer here (A, into the record) was superseded during the UI text review, when Release was renamed Remove.

> "Make the plan more concise this time by merging phases and slices so there's less back and forth. It's a clean break, not a careful haircut."

## Question 10 - Clear a conversation

> "we need a clear button. Perhaps long pressing a message will give a option to delete all messages above. (and artifacts will be deleted too if any is stored on phone or gateway) It won't actually delete from Claude history. just for our eyes. And I want this feature extended to regular conversation chats like here."

What the research found:
- **Messages are each phone's own:** `ChatState.threads`, persisted by `ChatPersistence`; there is no phone-to-phone sync of thread content, only shared read anchors. `Message.id` is reassigned on load, so a cut is by position, guarded by the row's `(epoch, seq)` or `opId`.
- **The Router keeps sealed copies:** owner-inbox rows and their blob references live up to 30 days, then expire. A re-enrolled phone could redrain what is still held.
- **Gateway staging is short-lived:** `OwnerRowOutbox` retires it once the Router accepts the row; a sweep clears the rest within a day.
- **Files already handed to a session** (`/tmp/switchboard-channel-files`) are the session's inputs, swept within an hour; a phone-only clear leaves them.
- **What a cut must also mind:** the read anchor (a removed anchor row would make everything read unread), local attachment files still named by a surviving row, a draft or a scheduled send; peer mirrors are separate rows in the other thread. The thread is drawn in a WebView with no long-press bridge yet.

### 10a - Does the pressed message go too?

A: Yes. Long-press offers "Clear and all above", and a confirmation spells it out with the count of messages and files.

> "A. but might want to keep it shorter "Clear and all above" with a confirmation that spells it out with count of messages and files."

### 10b - How far does a clear reach?

A: This phone only. The cleared rows and their local files go. Gateway staging is already gone: it is retired once the Router accepts a row, before any phone holds it. The Router's sealed copies expire on their own within 30 days; another phone keeps its own copy. A Router-held "cleared up to" marker can come later if a second phone appears.

## Question 11 - The assistant panel and integrations

> "I'd like the Assistant hold power thing to open a panel overlay like other assistants. Currently it just switches app to Switchboard. Should be accessible from both floating summon and Switchboard assistant tab (settings and stuff only in app though)."
> "Assistant integrations. what can it do? toggle flashlight? analyze screenshots? send a SMS message? IFTTT? Not really a programming task, but I want you to scope out as we debug live, what Switchboard sees and what it can access."

What the research found:
- **The panel:** a `VoiceInteractionService` with a session service (`supportsAssist`, a stub `RecognitionService`, no `RECORD_AUDIO`) gives a `TYPE_VOICE_INTERACTION` window over the current app; `onCreateContentView` hosts a `ComposeView`. Long-press power shows the session when the role holder has one, else falls back to `ACTION_ASSIST` on `MainActivity`. A translucent Activity only looks like a panel: it pauses the app beneath and gets no screen context.
- **Screen context comes with the session:** per summon, `AssistStructure` and a screenshot of the app beneath, removed by the "Use text from screen" and "Use screenshot" settings and empty for `FLAG_SECURE` windows.
- **Its traps:** the session window draws above the keyguard (`onPrepareShow` must hand a locked summon to `MainActivity` to keep the no-keyguard rule); Compose needs lifecycle, saved-state and back owners wired by hand; the pooled `ThreadWebView`s belong to `MainActivity`, so the panel needs its own renderer; the IME layering and Back need checking on the Pixel; the owner re-picks the digital assistant once after the update, since the role recorded an empty voice-interaction service.
- **What the app shares:** `Repo.get` is a process singleton, so a panel in the same process sees the same conversation and draft; `ThreadScreen` and its callbacks have to come out of `App`.
- **Integrations:** today the assistant has no road to act on the phone. Flashlight, alarms, media keys and confirmed intents (an SMS or a call the owner taps to send) need no special grant; silent SMS, notification reading and Accessibility are restricted settings for a sideloaded app and dangerous if an injected instruction reaches them. IFTTT is a Gateway-side action with its key in the vault, on the `github_done` model.

### 11a - How does the panel draw over the app?

A: A real assistant session (`VoiceInteractionService` and a session service, in the main process), with a Compose bottom panel. A summon while locked hands off to today's flow (unlock first, then the app), so nothing draws over the keyguard; `ACTION_ASSIST` on `MainActivity` stays as the fallback.

### 11b - When does the screen reach the assistant?

A: Only when the owner taps to share it. The capture (screenshot and `AssistStructure` text) stays in memory and is dropped when the panel closes; a tap attaches it to the next message.

> "A. That's how Gemini works too. it don't grab unless you tap the screen items and press an action."

### 11c - Build integrations now?

A: Scope only, plus a probe that gathers the data for a later integrations plan.

> "only scope. so like, if you know there's a dynamic enumeration of features you want to check for, add a debug ingest of enumerating what exists. Or small code for dry running a feature or something. That way when we start testing for real, we have data for the integrations plan."

## UI text

Run past the owner one at a time, or a few that belong together, starting with the landing screen.

Landing screen:
- **Home unreachable:** "Assistant on **sakura** could not be reached." (the owner's line) No button: it refreshes on its own when the Gateway returns.
- **Moving, until the home reports:** "Moving the assistant to **sakura**…" with a spinner.
- **Refused or failed:** "Error moving assistant: {caught error message}" [Settings]
- **Not on any Gateway:** "Visit Assistant Settings to set up." [Settings]
- **Router unreachable:** "Could not reach the Federation Router." No button: the screen updates on its own once Switchboard reconnects.
- **Cold start, before the first record:** nothing drawn. The phone keeps the last record it saw, so this lasts only until the first answer.
- **Top bar:** an "Assistant settings" gear on every landing but the cold start and Router unreachable, so a stuck move or an unreachable home can still be moved away from. Added in implementation; not yet run past the owner.

Assistant Settings:
- **Section label:** "Assistant location" (was "Lives on").
- **Gateway menu tags:** "now" for the current home, "offline" for an unreachable one.
- **Button:** [Move here], or [Set up here] when it lives nowhere. Grey while the fields are not filled or an error stands.
- **An offline Gateway picked:** "matrix-edward can't be reached." The button stays grey.
- **Moving away from an unreachable home:** title "Move the assistant to mikan?", the abandon line, [Cancel] [Move].
- **Remove:** button [Remove assistant]; dialog "Remove assistant" / "This will remove the assistant configuration from your phone and gateway (if reachable)." [Cancel] [Remove]

Check-ins:
- **Target menu:** "Assistant" first, then the spawn points, on the Gateway where it lives.
- **A check-in on a Gateway it left:** "Assistant" stays first, tagged "not set up" (a vanished spawn point keeps "not offered now"); under the menu, "The assistant isn't set up on this Gateway."
- **Rows:** the second line reads "Assistant"; a stopped one reads "Stopped at {time}: the assistant isn't set up on this Gateway." `UNPLACED_REASON` takes the same words.

Clear and all above (every conversation):
- **Long-press menu:** "Clear and all above".
- **Confirmation body:**

> "This will clear this message and all above it from this phone. Claude session will remain untouched.
> - 123 messages
> - 456 files
> - ~789 MB recovered"

  A line whose count is zero is left out. The size is the local files deleted, rounded.

Assistant panel (over another app):
- **Top:** "Assistant", and "Open in app ↗" opening the full Assistant view, where settings live.
- **Middle:** the recent conversation, the same thread as the app, scrollable.
- **Chip:** "Share screen" with a small thumbnail; once tapped, "Screen attached ✕", sent with the next message. No chip when there is nothing to share (`FLAG_SECURE`, or the Android settings off).
- **Composer:** "Message the assistant", focused with the keyboard up.
- **Closing:** a tap on the dimmed app above, Back or Home; the draft survives in the app. Replies arrive in the panel while it is open.
- **Gone:** the "Also placed on" warning; one record never names a second home.

# Plan

A clean break. Phases 1 and 2 ship together: the Router, then every Gateway, then the phone. The floor fences an older Gateway; dropping `assistant_place` and `assistant_release` fences an older phone, whose Move is refused until it updates. No Gateway holds the assistant on this Domain, so that gap costs nothing.

## Phase 1 - The Router-owned home and the Gateways that follow it ✅

- **The record:** two rows per Domain owner in `OwnerStateStore`, under a new `RecordKind`.
  - **The choice:** absent (never written), nobody, or a Gateway. The Gateway id and the CAS version are clear; the `workdirPath` and the carried settings are sealed with the content key under their own AAD kind (`content-envelope.ts`, its twin in `ContentAadKinds`, one vector each). The path is applied; the notes in it are never copied. Remove writes nobody, with nothing sealed; the row is never deleted.
  - **Carried settings:** each watcher's rules, its granted vault entry and Safety, or "none carried", which starts fresh. Bounded: the path at today's 1,024 characters, the sealed settings at 64 KiB, refused before the write.
  - **The report:** the named Gateway's apply result for one choice version, placed or refused with a reason (a missing content-key epoch is a refusal). Its own row, so a report never moves the phone's write base.
- **Owner ops (`ownerOpRegistry`):** a read (`read`) answering the choice and the report, and a CAS put (`value`) carrying the base version. A conflict answers the held record. A put naming a Gateway that is not routable now (admitted identity, current incarnation, live connection: what `pushFrameTo` needs) is refused and writes nothing. A new plane on the existing `pushPlane` and `readPlanes` road moves on a write to either row, and the phone rereads.
- **Router to Gateway:** the Gateway reads the record from its `onRegistered`, as it reads the share mirror; the Router pushes each later change through `pushFrameTo`, a new frame in `RouterInboundFrameSchema`. One small row, so no deltas; a missed push is recovered at the next registration.
- **The report frame:** incarnation-gated, catalogued `value` so the migration fence holds it, and accepted only from the named Gateway for the current choice version. One terminal report per version: applies run through the `ownerOps` FIFO, a retry is a new Move, and the Gateway resends its report at registration in case the first was lost.
- **Gateway follow (`composeAssistant`):** a durable home file (listed in `dataDirInventory`, apart from the session record that a forget deletes) holds the latest choice version seen, whether it names this Gateway, and whether this Gateway applied it. It is written first on every new choice, before anything is awaited. A version at or below it is ignored, so carried settings apply once and a restart never overwrites a rule edited on the home since.
  - **Boot:** lanes start at once only when the home file says this Gateway is home and applied; the record read at registration then corrects it. No wait, so a Router outage never pauses the assistant. Only a home moved away from while unreachable can act at boot, the exception Question 5 accepts.
  - **Never written, or no home file yet:** the local record stays as it is, and lanes follow it as today.
  - **Named:** with lanes stopped, place itself, run today's fresh-start block (origin marker, grants, poll state) whether or not a session is held, replace rules and Safety with what was carried (fresh when none), keep each carried grant only when its entry is `allowedHere` (else dropped, shown as needing a secret), save, then start lanes and report.
  - **Not named, or nobody:** the home file says so first, then lanes stop, so it acts on nothing more, and the assistant's routes answer `not_assistant` while the home file says it is not home. Then forget the session, retried until it lands, drop grants, and delete its rules and Safety. A late wake that registers after the forget is already refused: a host-spawn session must present the launch token of a record that still exists (`presentsOwnLaunchToken`). Today's `release` awaited the forget before stopping lanes; that order is reversed. The notes folder is never touched.
  - **Cut off:** keeps running on the home file.
  - **As built:** the decisions and their retries live in `createHomeFollow` (`homeFollow.ts`), the effects in `composeAssistant`. The mark is scoped to the active Domain, so a re-enrolled Gateway compares no version across Domains. A mark write that fails shuts lanes until one lands. The registration read and the share mirror's read share `createRegistrationRead`: one in flight, a stale registration's answer dropped, a failure retried while registered.
- **Console ops:** the Gateway refuses `assistant_place` and `assistant_release` with "update the app"; they leave `ConsoleOpSchema` in Phase 2 with their phone callers, so every commit keeps the Kotlin build green. A move reads the home's `assistant_state`, which already carries Safety and each watcher's rules and grant. The state read and rule and Safety edits stay. Local checks (`held`, `reserves`, `forgetRefusal`, `assistantPlaced`) keep reading the local record.
- **Check-ins:** a check-in stays on its Gateway. On one the assistant left, it stops with `UNPLACED_REASON`, reworded to the agreed "the assistant isn't set up on this Gateway".
- **Floor, codegen and docs:** `FEDERATION_PROTOCOL_FLOOR` and the version rise together. `Protocol.kt` and the version's golden wire fixtures regenerate in the same commit. `docs/assistant.md`, `docs/console.md` and `AGENTS.md` describe the Router-owned home.
- **Tests:** the record and ops (bounds, a target with no identity, a superseded or disconnected target, a conflict); the report fence (wrong sender, stale version, a resend); the Gateway follow (each state, apply once, settings before lanes, a forget refused while waking, a late wake registering after the let-go, boot from the home file); a harness Set up, Move to itself, Remove and refusal through one Gateway (the harness has no second Gateway in a Domain, so the not-named let-go is a unit test); `check:boot`; the Kotlin gate.

## Phase 2 - The phone reads one home ✅

Built and walked in the emulator; the Pixel acceptance (a Move between two Gateways, a Remove, a refused move) waits for the deploy at the end of the plan, since Phases 1 and 2 ship together.

- **Reads:** the home is the Router record, kept in `ChatPersistence` as the last seen and reread when its plane moves. `refreshAll`'s ask-every-Gateway effect goes: the phone reads `assistant_state` from the home alone, for Settings and the health lines. A pure status fold beside `AssistantOps` reads the record, the report, the held put result, Router reach, the roster and presence, and answers one landing state: not read yet (draw nothing), Router unreachable, set up (nobody or never written), moving, refused with the reason, home unreachable, or placed (draw the conversation).
- **The put's result:** `ChatState.homeFailure`, written only through `AssistantHomeFence`, until a newer choice lands. Its returned record applies at once. A conflict adopts the held record and follows the winner; only a failure shows "Error moving assistant". An unanswered or uncertain put is read back and counts only as that exact write.
- **Current home versus identity:** the current team is the record's Gateway and the fixed assistant address (`assistantGateway`, `assistantAddress`). Placement needs the report for the held choice (`placedGateway`, `placedAddress`): the Placed landing, the role stamp and the check-in target read it. The current-home readers: `assistantRoot`, `assistantLeft`, `followAssistant`, `assistantSpawnOn`, `summonLanding` and Settings. Identity comes from persisted `ChatState.roles` and team role stamps, so a past home's thread still reads as the assistant's: `isAssistant` and `assistantTeams` (which gains the persisted roles), and their callers (`ThreadOps`, `PollDrain`, `PlaybackOps`, `ServiceNotifications`, `MainActivity`, `AssistantRecordRules`, `SwitchboardService`, `ReferenceViewer`). The drain lands the home plane before rows. `GatewayRegistry.assistantHomes` and the "Also placed on" line are gone.
- **Writes:** Set up and Move are one put, behind one `writes` lock the seed shares. A placed, reachable home carries its fresh `assistant_state` (Safety, rules, grants); an unplaced one carries what the record sealed, opened on the phone; a placed home that cannot be reached carries none, only once the owner confirmed it. Remove puts nobody, sealing nothing, so it needs no key; an unreachable home keeps acting until it returns, while the landing already says to set up. An unreachable target greys the button, and the Router refuses one that slipped through. Sealing without a content key refuses the put.
- **Seeding:** only on never written, from the Assistant screen (never the drain), and only from answers fetched in the same pass from every registered Gateway on a current roster, never a cached answer, when exactly one holds: a Move to that holder carrying its own settings. It writes only if the roster it asked is still the roster and no owner choice landed meanwhile. Otherwise it writes nothing and the landing says to set up.
- **A re-provision:** `AssistantHomeFence.across` drops the held home and strands every ticket taken before it; the stored home is removed with the provisioning blob.
- **The rollout gap:** between the Gateways' update and the phone's, the old app's Move shows its refusal. Nothing is placed, so nothing is lost.
- **The old ops go:** `assistant_place` and `assistant_release` leave `ConsoleOpSchema`, the console handler, `AssistantOps` and `SandboxGateways`, with `Protocol.kt` regenerated in the same commit.
- **Sandbox:** `SandboxGateways` answers the record states (never written, nobody, a home, a conflict, a report placed or refused), resumes the phone's held record, and never reports for `idle-box`, so each record state, Moving included, is reachable in the emulator. Router and home reach come from the seeded roster, so their landings are JVM-tested only.
- **Tests:** the status fold, the put and seed decisions, and the identity readers in JVM tests; the AAD vector on both runtimes; the Kotlin gate; an emulator walk; on the Pixel, a Move between two Gateways, a Remove, and a refused move.

### Bug Classes

- **Mechanism:** `AssistantOps`' home state: the held record, the per-Gateway assistant words, `homeFailure`, the Settings work line and the persisted copy, each written by async work that started under an older choice.
- **Defect class:** an answer computed under one choice lands after a newer choice did, and repaints what the newer choice settled.
- **Rounds:** the alignment pass added `newerHome` for a stale read and cleared the Settings line on a new choice. The red team then found the same class four more times: a late Gateway answer repainting a dropped word (`show` now takes the choice it was asked under), a late put failure (`failed` drops one whose base moved), an older snapshot persisted last (persisted under one lock), and a seed write racing the owner's (one `writes` lock).
- **Round two:** a read begun before a re-provision landed over it, since `Unread` holds no version to compare. Patched with a `provisioned` generation that `landHome` and its persist check.
- **Closed by `AssistantHomeFence`:** the one writer of the home. Every effect takes a `HomeTicket` (the provisioning generation and the held home) before it awaits and lands through `land`, a pure `homeLanding` under one monitor. The failure moved into `ChatState` beside the record, and a re-provision runs inside `across`.

## Phase 3 - Clear and all above ✅

Phone only, in every conversation (Question 10). Pixel acceptance waits for the deploy.

- ✅ **Gesture:** `thread.js` listens for `contextmenu` outside a row's `.body`, links and buttons, so a long-press on the text still selects it. `ThreadRenderer.rowMenu` carries the row's `(id, at)` through `ThreadRendererPool` and `RendererPoolBindings` to `MainActivity`'s `RowPress`, and `RowMenuDialog` shows "Clear and all above", then the confirmation. An id is reassigned only on load, so `(id, at)` names the row; the cut keeps a per-thread id floor (`ChatState.idFloors`), so `append` never mints a cut row's id again.
- ✅ **The cut:** `threadCut` in `ThreadCut.kt`, pure, over the whole `ChatState`: the thread's rows from the top through the pressed one; the files they name that no surviving row, draft or scheduled send names (`namedSrcs`), with a pending send keeping its own; the read anchor, unchanged; and `silenced`, the `at`s no surviving row shares. `withCut` also records the op ids of cut sends whose echo has not landed (`clearedSends`), and `reconcileSent` drops that echo once (`swallowEcho`). The confirmation counts the freed files still on disk (`freedSize`), tied to the cut it measured, and Clear waits for it.
- ✅ **Apply:** `clearThrough` runs under the drain gate on IO: the cut lands in state, its rows leave the playback queue, and `AttachmentOps.deleteWhenDurable` commits threads, anchors, drafts and scheduled sends in one write before deleting only what nothing names. A late attachment landing deletes its bytes only when no row names them (`landedAttachment`).
- ✅ **What it does not reach:** the Router's sealed copies expire within 30 days. A redrain in the same cursor epoch keeps a cut row cut; a new mailbox epoch or another phone can see what the Router still holds.
- ✅ **Tests:** `ThreadCutTest` (anchor above and inside the cut, a file another thread or a draft or a scheduled send names, a pending send's files, a shared `at`, a full clear and the next id, a cut send's echo, a late landing, the confirmation's lines and measure); `AttachmentOpsTest` (a delete keeps what a draft names); emulator walks of a partial and a full clear and a send after one.

### Bug Classes

- **Mechanism:** `ChatPersistence`'s slot writes, each handed a snapshot its caller took from `ChatState`.
- **Defect class:** a snapshot taken before a newer state change is written after it, so disk holds the older state. Here an append's pre-clear snapshot would put cleared rows back with their files deleted. bd_751500bf is the same class for roles.
- **Patched, then redesigned:** red team fixed threads and read anchors first. The architecture pass then moved every slot but the assistant home to the same shape: each `persist*` takes no argument and writes its slot from `live` under one lock (`stateWrites`), so no caller can hand in a stale snapshot. That closes bd_751500bf. The home keeps its value write, since `AssistantHomeFence` is its one writer.
- **Sibling class, closed on the second pass:** files deleted after an `apply()` write rather than a committed one, in forget (`SessionOps`), removing a draft's attachment (`ChatRepositoryDrafts`), `reconcileSent`'s superseded files, and scheduled-send replace and cancel. Every delete now goes through `AttachmentOps.deleteWhenDurable`: `commitFileOwners` commits threads, anchors, drafts and scheduled sends in one write, then only what nothing names is deleted. The clear takes the same road. Not closed: a reference added between that check and the delete, which would need a lock every reference-adding write takes.
- **Accepted:** playback names a row by `(team, at)`, since ids are reassigned on load. A cut row sharing its `at` with a surviving row keeps its queued audio rather than silencing the survivor's.

## Phase 4 - The assistant panel

Long-press power opens the assistant as a panel over the current app (Question 11).

- **The session:** a `VoiceInteractionService`, a session service and a stub `RecognitionService` in the main process, with the voice-interaction XML (`supportsAssist`). No `RECORD_AUDIO`. The owner re-picks the digital assistant once after the update; Assistant settings' Digital assistant row says so while the session is not adopted.
- **App lock first:** the app lock moves out of `App` into one process-level holder both hosts read (the board's "Hold the app lock outside the composable"). A summon while the app lock would ask hands off to `MainActivity`, as a locked keyguard does.
- **One foreground lease:** `onForeground`, `onBackground` and renderer visibility become one lease with two keyed holders, the Activity and the session, each taking and releasing its own, so the panel keeps the socket live and closing one host never backgrounds the other. Composer focus goes to whichever host shows the summon; "Open in app" arrives through the Activity's assistant arrival road.
- **The panel:** a Compose bottom panel in the session window, with lifecycle, saved-state and back owners wired by hand and `imePadding`. The thread and composer come out of `App` into one assistant surface both hosts draw, each with its own renderer (the pooled `ThreadWebView`s belong to `MainActivity`). Closing: a tap above the panel, Back, Home, or "Open in app".
- **Locked:** `onPrepareShow` on a locked keyguard shows no UI and starts today's summon on `MainActivity`, so nothing draws over the keyguard; `summon-residue.test.ts` pins that. `ACTION_ASSIST` on `MainActivity` stays as the fallback.
- **Share screen:** a tap holds the screenshot and the screen text in memory, outside the persisted draft, and drops them on hide. Only a send writes them, as a PNG and a text file on the ordinary send road, kept like any sent attachment.
- **Screen text never speaks for the owner:** the files carry a `screen` role, through `OutgoingFile` admission and `ConsoleClient.send` (which writes `"attachment"` today) to a new `ChannelFileSchema` value. `createOriginMarker` reads the observed row's files, and a row holding a `screen` file is not the owner's own words, so a `crosstalk_send` after it asks a card even with approve-every-send off. An older Gateway would refuse the value, so the Gateway ships first.
- **Integration probe:** debug builds only, through `DebugLog`'s ingest, best-effort, at app start and at each panel show. It reports allowlisted counts and booleans, never a package, an activity, a Bundle key, text or an image: the role and whether the session was adopted, the assist settings, torch-capable cameras, which intents resolve (alarm, `SENDTO` SMS, dial, calendar insert, the IFTTT app), each candidate permission (declared, granted, restricted), notification-listener, Do Not Disturb and Accessibility access, and whether the app beneath was `FLAG_SECURE`. Narrow `<queries>` entries cover the probed intents and the IFTTT package, so package visibility does not filter the answer. Dry runs resolve an intent or check a capability without acting.
- **What "Use text from screen" carries, measured:** at each panel show, the shape of the assist data. `AssistStructure`: the window count, and per window its title presence and node count; across the `ViewNode` tree, how many nodes carry text, a hint, a content description, an id entry, a class name, autofill hints or values, a web domain or HTML info (Chrome and WebViews expose their page this way), and how many are password-typed and whether any of those still carried text. `AssistContent`: whether a web URI, an intent, structured data (JSON-LD) or clip data arrived. The app's own assist `Bundle`: its key count. The screenshot: present or not, and its size.
- **Tests:** the panel's decisions (the keyguard and app-lock handoffs, chip states, the foreground lease, the role kept through admission and send) and the probe's report shape in JVM tests; the origin marker on a `screen` row in a TypeScript test. Screen text extraction runs over a plain projection of the node tree, since a JVM test cannot build an `AssistStructure`; the real extraction is checked in the emulator walk (role set by `cmd role`) and on the Pixel, and probe delivery on a debug Pixel. The residue test.

## Painpoints

- **Codegen lists every schema twice by hand:** `scripts/codegen-kotlin.ts` imports each schema and lists it again in its emit array, and an anonymous nested object fails only when the script runs ("inline object without $defs id"). A schema file could export its own list.
- **A console op cannot leave in one commit:** `ConsoleOpSchema` generates `ConsoleOp` in `Protocol.kt`, so dropping an op breaks the phone's build until its callers go too. Phase 1 had to keep `assistant_place` and `assistant_release` as refusals.
- **The cancellation fence matches suspend names across the whole phone:** `src/__tests__/cancellation-residue.test.ts:offendersIn` treats any call whose name matches any `suspend fun` anywhere as suspending, and `priorCancellationCatch` reads the catch before it as the try body. Naming a new suspend function `remove` flagged an untouched catch in `ChatRepositorySend.kt:reconcilePending`. The fix was a rename, not a code change.
- **Outcome enums reach Kotlin as plain strings:** a Zod enum with `catalog: "outcome"` metadata generates `String`, so "applied", "conflict" and "placed" are typed by hand on the phone, and the wire-vocabulary fence forces "refused" through `Protocol.Wire.SocketFrame.REFUSED`, a socket frame's name. `VaultOps` and `ScheduledSendOps` carry the same literals. Generated outcome constants per enum would close it.
- **Emulator walks are hand-rolled shell:** every walk re-declares the same `tap` and `texts` helpers over `uiautomator dump`, the sandbox's app lock asks for the PIN on every launch, a text field is found by its current text because the Gateway picker is also an `EditText`, and select-all does not work, so clearing a field means counting backspaces. A shared `scripts/emu-walk.sh` with these helpers and an unlock step would save most of it.
- **Prose passes repeat themselves:** each Luna comment pass rewords the comments the last one shortened, and many proposals change what a comment says. Three passes over one diff cost more than the comments are worth; one pass per commit, scoped to new lines, is enough.
- **Two writers of `roles`:** closed in Phase 3, when every `ChatPersistence` slot moved to live-state writes (bd_751500bf done).
- **A row has no identity that survives a load:** `ChatPersistence.loadPersistedThreads` reassigns ids 0..n-1, so a row is named by `(id, at)` in one process and by `at` alone across loads. Clear needed an id floor (`ChatState.idFloors`) so a full clear does not reuse id 0, and playback keys by `(team, at)`, so a cut row sharing its `at` with a survivor keeps its audio (`ThreadCut.silenced`). A persisted row id would retire both.
- **The sandbox reseeds on every launch:** `ChatRepositorySandboxSeeder.seedSandbox` replaces threads and drafts each start, so no emulator walk can show that a clear or a draft survives a restart. Only the JVM codec tests can.
- **An unbounded Codex relay can hold a fan-out for hours:** the first Phase 3 red team waited about 2.4 hours on two Luna turns that never answered. Every relay prompt since stops the agent after eight timed-out waits.
- **The task board refuses a self-assigned create with `held`:** follow-ups that should have gone on the board landed in this plan's Bug Classes instead.
- **`AssistantOps.kt` holds two classes' worth:** the home lifecycle (read, move, remove, seed, the fence) sits beside rule drafts, page work and watcher chips. Extracting an `AssistantHomeOps` is a faithful move now that the fence is the only writer.

## Integrations scope

Not built in this plan; the probe gathers what the Pixel actually allows, for a later plan. Today the assistant has no road to act on the phone; each phone action needs one (the assistant through the Gateway and the Router to the phone, which acts and answers), and anything that sends or reads private data rides an owner-approval card, as `crosstalk_send` does.

| Integration | Where it plugs in | Grant | Risk if injected |
|---|---|---|---|
| Flashlight | Phone action | None (`setTorchMode`) | Low |
| Screen (screenshot, text) | The panel, by the owner's tap | Assistant role, Android's assist settings | Medium: screen text is model input |
| Alarms, timers | Phone action | `SET_ALARM` | Low |
| Media control | Phone action | None (media keys) | Low |
| SMS, call (confirmed) | Phone action, an intent the owner taps | None | Low |
| SMS, call (silent) | Phone action | `SEND_SMS`, `CALL_PHONE`; restricted for a sideloaded app | High |
| Do Not Disturb | Phone action | Do Not Disturb access | Medium |
| Notifications | Phone, read | Notification listener; restricted | High |
| Location, calendar | Phone, read | Runtime grants; background location is separate | High, Medium |
| IFTTT | Gateway action, key in the vault (the `github_done` model) | IFTTT account; webhooks need Pro | Whatever the applets do |
