# Questionaire

## Question 1 - What goes in this round?

Q: Walk fixes, next-slice features, or both?
A: Both: the walk fixes, then one next-slice feature.

> Both

## Question 2 - Is the Assistant tab the conversation?

Q: Embed the assistant's conversation in the Assistant view, open it without session tabs, or leave it?
A: Embed it. The drawer's Assistant shows the transcript and composer, titled "Assistant", with the watcher chips and gear on top. Chat only; Back goes to Sessions; notifications and queue jumps for the assistant land there.

Recommended because it matches the first plan's Assistant tab, saves a tap, and gives a later power-button or lock-screen summon one place to land.

> A. yes.

## Question 3 - Who can reach the assistant over crosstalk?

Q: Today any session can discover, message and wake the assistant. Close it, or keep it?
A: Keep sessions able to talk to it, asymmetrically. The assistant can see and message every session. No session can see the assistant unless the assistant messaged it first.

> And interesting point that any session can message assistant. that's pretty cool idea for me to say, relay to X this task. So don't kill it. Make assistant be able to see all of them. but none of them can see assistant unless assistant messaged first.

A session the assistant wrote to replies in that conversation through `channel_reply`; a fresh `crosstalk_send` to the assistant stays refused. Friend Domains never see it; it sees only friend sessions already shared.

## Question 4 - How are the assistant's sends guarded?

Q: Approve each send on the phone, free when the owner's message woke it, a target list, or no gate?
A: A Safety section in Assistant settings with an "Approve every send" option, on by default. On: every send waits on a phone card showing the target and exact text. Ticked off: a send goes without asking when the newest input delivered to the assistant is the owner's own message, and asks otherwise. Every send is recorded in the assistant's conversation either way.

Approval per send was recommended as the only guard that checks the text before it lands.

> Opus and Claude harness pretty strong combo. I trust B, but get A.
>
> make a settings section called Safety and have it as an option you can tick off

> or Security. whatever is the better word

Named Safety: it guards against a mistaken send as much as an injected one, and Security reads as locks and credentials, which the app's vault unlock already means.

## Question 5 - Which new feature joins this round?

Q: Summon, check-ins, timed compaction, or Gmail?
A: Summon and check-ins. Summon: the power button or lock screen lands on the Assistant view. Check-ins: routines aimed at the assistant, like a morning briefing over chosen watchers.

Summon was recommended because replacing Gemini on the phone is the assistant's point.

> A & B

## Question 6 - Where does a check-in live?

Q: A routine aimed at the assistant, or its own list in Assistant settings?
A: A routine aimed at the assistant. The Routines view offers "Assistant" as a target beside spawn points, keeping the schedule, runbook text, misses, Run and history. For that target: no session reserved or cleaned up, no routine secrets granted, an optional pick of watchers. It lands in the assistant's conversation at its time, even mid-task; the routine runner's `waiting_idle` hold does not apply to it.

> just directly onto the Assistant. even if it was in the middle of something. it's good at multitasking and noticing that

> A

A was recommended because a separate check-in list would be a second scheduler with its own fence and miss handling.

## Question 7 - Summon while locked? [Superseded]

Q: Unlock first, or a limited screen over the lock screen?

Answered "make it an option" (a toggle, off by default), then superseded by Question 8: with replies held until unlock, the lock-screen screen shows nothing private, so it needs no opt-in.

> but back to last question "option", that feels superceded by this A2.

## Question 8 - What can the lock-screen screen do?

Q: Talk while locked, read only, or draft until unlock? Under talk: replies shown locked, or held until unlock?
A: No typing while locked. The assistant's `channel_reply` and `notify_human` title is its non-sensitive tier, a rule in its instructions. While the phone is locked, an assistant notification shows only its title, and read-aloud speaks only the title, until unlock. This covers everything the assistant sends, check-ins included; other sessions are unchanged.

> A2.

> new direction: we could solve it by instructinf it to use channel reply title tier as the non sensitive notification. and while locked, user only sees that until they unlock. Cannot type until unlocked.

Superseded talk-while-locked (A2, replies held until unlock). No typing removes the active threat, anyone holding the phone asking the assistant something; a title on the lock screen is passive exposure, the same as any notification. Talk while locked was technically sound: `AppStateStore`'s master key has no unlock requirement, the foreground service holds the Router link while the screen is off, and a keyboard shows over a `showWhenLocked` activity.

Found while settling it: the app sets no lock-screen visibility on any notification, so with Android's sensitive content setting on, a reply shows in full on the lock screen, and autoplay reads it aloud.

## Question 9 - Summon while locked?

Q: Unlock first, or the assistant's recent titles over the keyguard?
A: Unlock first. Long-press power while locked brings up the unlock prompt, then the Assistant view. Nothing from the app draws over the keyguard; no `showWhenLocked` anywhere.

> A

Recommended because the titles already sit on the lock screen as notifications, so a screen over the keyguard would show them twice and need its own guarding.

## Question 10 - What happens when summon lands?

Q: Keyboard up, start listening, or just land?
A: Keyboard up. Summon focuses the Assistant view's composer with the keyboard open; Gboard's mic key dictates. No speech-to-text and no `RECORD_AUDIO` in the app.

> A

Recommended because Gboard's mic is one tap away, and listening at once would add the app's first microphone permission to save that tap.

## Question 11 - Assistant settings: page or sheet?

Q: A full page, or keep the sheets at full height?
A: Full page. The gear opens Assistant settings as a page with Back: Lives on, Safety, Watchers. A watcher's Rules opens its own page; the rule editor opens full height. No sheet on a sheet.

> A

Recommended because the view is becoming the conversation, so settings get their own place rather than a sheet over the chat.

## Question 12 - Does a check-in count as the owner's message?

Q: With "Approve every send" off, does a check-in's crosstalk send go straight through?
A: Yes. A check-in counts as the owner's message for the send guard. With "Approve every send" on, which stays the default, every crosstalk send waits for approval either way. The guard covers `crosstalk_send` alone; the assistant's replies and notifications to the owner never ask.

> check-in counts as my message. but if the cross talk gate is on, it will wait for approval either way.

## Question 13 - Rule values: pick or type?

Q: Choices declared by the watcher, or readable words with free text?
A: Choices from the watcher. A watcher declares a label per field and, where the source's set is closed, its values with labels; GitHub's `reason` and `type` pick from a menu, `repository` and `title` stay typed. Rows read in labels ("Reason is Review requested"). The Gateway owns the lists; the phone holds no GitHub knowledge.

> A

Recommended because a mistyped value is a rule that silently never matches.

> follow NyaaDot shema strictness when modeling watcher dynamically.

Modeled on NyaaDot's `FrameworkSchema`: a watcher declares each field as a strict schema (a closed set as an enumeration with labels, open text with bounds), the editor builds one widget per field kind from that declaration, and a rule is parsed strictly against it at put and preview, so an unknown field, a value outside the set or a test the kind does not take is refused; at load a rule that no longer fits is kept and marked invalid (Question 16).

## Question 14 - What stays reachable besides the chat?

Q: Terminal and Notes on the settings page, Terminal only, or chat only?
A: Reuse the real session conversation screen, so the Terminal view stays. The Assistant opens it in the shell's conversation slot, marked as the assistant: titled "Assistant", no tab row, the watcher chips under the title, the gear in place of the overflow menu (no Rename, Close tab or Forget). The drawer offers Chat and Terminal. Back goes Terminal, Chat, Sessions. Replies autoplay as if its tab were open, and notifications, queue jumps and summon land through one assistant-aware arrival. No Notes entry; the assistant keeps its notes on its own for now. This replaces Question 2's embed.

> 14. what if you make it reuse the session conversation component so we don't lose terminal view? and hold off on notes. let it write on it's own for now

> I meant for you to bring the actual session conversation along. so reuse what we have, don't made a dumb text message app.

> in that case, if it was just mock oversimplification, then sure. go for what we discussed so far

## Question 15 - Type: closed menu or open?

Q: GitHub documents no list for `subject.type`. Menu with Other, typed text, or a strict menu?
A: Strict menu, like Reason. A watcher reports any event value outside a declared set: the field and value show under that watcher in Assistant settings, so the Gateway's list can be extended. Such an event still flows through the rules by its real value; it matches no `is` choice.

> Strict list. I'll add more if the module reports an unexpected value

## Question 16 - A stored rule that no longer fits its watcher?

Q: Keep it marked invalid, refuse the whole file, or drop it at load?
A: Keep it, marked invalid. The rules file loads and every other rule works. The stale rule stays stored, never matches, and shows on the Rules page with why, to fix or delete.

> A

Recommended because it matches NyaaDot, where a strict schema refuses to load a record but leaves it on disk; refusing the file loses every rule for one, and dropping it loses the owner's rule silently.

## Question 17 - Files for the assistant?

Q: Files over its own folder, read-only repos the owner picks, or neither?
A: Neither, for now. Chat and Terminal stay its only views. Read-only repos, so it can talk code, goes to the next slice.

> ohh maybe we should give assistant the file view. so we can have it talk code too when needed

> ohh nvm. that would require touching Lexicon right? I take it back for now.

Files alone shows only its notes: the gate confines its reads to its folder and the files the owner sends, and refuses a ref outside it. Talking code needs read access to chosen repos, a multi-root Files view, and a bound index per repo for the drill-ins.

## Question 18 - What counts as locked?

Q: Smart Lock counts as unlocked (`isDeviceLocked`), or any lock screen on a secure phone (`isKeyguardLocked`)?
A: Smart Lock counts as unlocked. A phone kept open by a trusted device, such as the car's Bluetooth, reads the assistant's replies in full.

> A

Recommended because Smart Lock lets anyone swipe the phone open, so hiding speech then protects nothing, and driving is when read-aloud matters most.

## Question 19 - What does a paired watch get from the assistant?

Q: Leave it, bridge a title-only form, or keep assistant notifications on the phone?
A: Bridge a title-only form. A paired watch shows the assistant's locked form, never its summary or body; the full text stays on the phone. No watch is in use today.

> I don't, but do add that in. sounds fun

> yeah hold on rich watch. just get basic.

## Question 20 - Build a check-in's watcher pick now?

Q: Defer the pick until a second watcher exists, or build it now?
A: Defer it. GitHub is the only watcher, so the runbook text says what to read. This narrows Question 6's optional pick of watchers.

> sure

Recommended because a pick from one watcher picks nothing, and deferring drops an inbox filter, an editor picker and their tests.

# Walk

Emulator walk of the Assistant view, 2026-10-22, after the storage location heading came off (`a45a364e`, not pushed).

- **Assistant in session tabs:** `SessionsScreen` filters `ASSISTANT_ROLE` out of the Sessions list, but a thread's tab row does not. The assistant's conversation shows a `Sandbox | assistant` tab row, and every other session on that host spawn shows an `assistant` tab. The filter lives in one screen, so other session pickers likely leak it too.
- **Empty view:** the tab is a button, a gear and a chip over a blank screen. Question 19 of the first plan had the tab hold the conversation itself; today it opens an ordinary thread with a back arrow and a lowercase `assistant` title.
- **Raw GitHub values in rules:** rows read `reason is review_requested`; the Value field is free text with no list of GitHub's reasons.
- **Settings order:** "None granted." and Assign secret sit below the actions list, away from the secret box they answer.
- **Stacked sheets:** settings, rules and a rule editor open as three sheets on top of each other. The editor opens half height with Save under the gesture bar until dragged up.
- **Chip against health:** the chip says "needs a secret" while settings says "Checked 2m ago · 3 unread". A grant removed after a poll gives both.

# Research

**Leak survey (Luna, 2026-10-22):** only `SessionsScreen`'s `localSessions` filters `ASSISTANT_ROLE`.
- **Tab row:** `openThread` adds the assistant to `openTabs`, and `ThreadScreen` draws those keys wholesale.
- **Cached thread fallback:** `ChatState.sessions` synthesizes a role-less `Team` from a cached thread while presence is missing, and persistence keeps no role, so that row passes the filter.
- **Share picker:** `TrustOps` and `Sharing` offer every loose session, the assistant included. A shared assistant reaches a friend's phone with its role dropped by `toCrossDomainPresenceSession`.
- **Board assignment picker:** `BoardOps` offers it as an assignee; it has no board tools.
- **Crosstalk:** `/discover` returns the assistant's row, `crosstalk_discover` hides only the literal `host`, and the send route refuses only `host`, so any session can discover, message and wake the assistant.
- **Rightly inclusive:** vault requests and grants, notifications, unread totals, the queue, scheduled sends, the Gateway session count.
- **Proposed home:** one `ordinarySessions` read beside `SessionOps`, with the role carried on cached rows.

**Tab as the conversation (Luna):** keep `RootView.ASSISTANT` on the root screen and embed thread content extracted from `ThreadScreen`, rather than reusing the whole conversation screen. Chat only; Back goes to Sessions through `BackLayer.ROOT_VIEW`; the drawer keeps Assistant selected. Notifications, queue jumps and workspace requests resolve the assistant to the Assistant view, never `nav.arrive`. Side effects of leaving `openTabs`: `RendererPoolBindings` pruning, `PollDrain` autoplay follow, `PlaybackOps.enqueueForPlay`. About 7 to 10 files and 150 to 250 lines, plus about 200 lines moved out of `ThreadScreen`.

**One-way crosstalk (Luna):** add `crosstalk_discover`, `crosstalk_send` and `crosstalk_wait` to `ASSISTANT_SWITCHBOARD_TOOLS` as their own constant; `crosstalk_send` joins the gate's `UPLOADING_TOOLS`, since it reads attachment paths itself. Hide the assistant by the Gateway-stamped role (set only through `isAssistantRecord`) in `/discover`, the unauthenticated `GET /teams`, and `crosstalk_discover`; drop it in the Router's `friendProjection` before `toCrossDomainPresenceSession` strips the role. The send route refuses a target that is the assistant, on the receiving Gateway too, since a relayed send carries no role. A session the assistant wrote to already replies through `channel_reply` and `/respond` without seeing it, so a fresh `crosstalk_send` to the assistant can stay refused; `PendingJobStore` rows lack the provenance a fresh-send grant would need. Only `localSessions` is pinned today, by `AssistantOpsTest`. About 8 to 10 files, 100 to 180 lines.

**Send guard (Luna):** only a per-send approval checks the text before it reaches a session. "Newest input was the owner" is unsound: an ack means the plugin emitted a notification, not that the model read it, and an earlier event stays in context after an owner message. A target allowlist bounds destinations, not content. A record after the send is audit only. Approval reuses the vault request pattern (a Gateway-held request, a phone card, a signed answer, 230-second waits with a collect), but as a one-shot decision bound to the canonical target and exact text, never a window. Vault requests live in memory, so a restart must fail the held send closed and retract its card.

**Conversation component for the assistant (Luna, 2026-10-23):**
- **Shape:** an assistant kind on `ShellNav`'s conversation slot. `RootView.ASSISTANT` transitions into it and `root` stays `ASSISTANT` while it is open, so `shellScreen` draws the conversation. A root-rendered `ThreadScreen` would need view state and Back rules outside the conversation slot and nest two scaffolds.
- **Views and Back:** a pure `assistantConversationViews` in `DrawerNav` offers Chat and Terminal. `ThreadScreen` takes assistant presentation: "Assistant", no tab row, a header slot for chips, the gear, no Close tab or Forget. `backLayer` already sends Terminal to Chat; Back from Chat clears the conversation to Sessions, and the top-bar arrow takes the same transition. Settings pages and `assistantPageBack` live in `ShellNav`, drawn by `shellScreen` above the conversation.
- **State:** never `openThread`, which adds to `openTabs`. `RendererPoolBindings` retains the assistant beside `openTabs`; `PollDrain`'s followed check and `PlaybackOps.enqueueForPlay`'s `requireFollowed` need the assistant counted, or its replies never autoplay. Read anchors, unread counts and drafts are keyed by team and keep working.
- **Arrivals:** notifications, queue jumps (with `revealAt`) and an assist intent go through one assistant-aware transition instead of `openTeamRequest`'s `openThread`.
- **Size:** 12 to 16 files, 250 to 400 lines including the settings pages, against the embed plan's 7 to 10 files plus about 200 lines moved out of `ThreadScreen`.
- **Bug classes:** a generic `arrive` dropping the assistant marker, the assistant reaching `openTabs`, Close or Forget left reachable.

**Watcher field declarations (Luna, 2026-10-23):**
- **Wire:** keep `fields` and add an optional `fieldSpecs` on the console answer in `schemasAssistant`: a discriminated union, defined beside the rule schemas, of `enumeration` (field, label, value and label pairs) and `text` (field, label, max length capped by `ASSISTANT_RULE_VALUE_MAX`), every object strict. Declared on `Watcher`; GitHub's lists live in `createGithubWatcher`. Enumeration takes `is` and `is_not`; text takes all three tests. The rule and condition objects go strict too.
- **Parse:** one `parseRuleForFields` refuses an undeclared field, a value outside the set, a test the kind does not take, a blank value, and text past its bound. It runs at put and preview and in front of `decideEvent`, where an invalid rule never matches; restore parses structure only and derives each rule's validity on read (Question 16).
- **Restore:** refusing the snapshot on one bad rule makes `openDurable` quarantine it and start empty, losing every rule when a declaration drops a value. Settled by Question 16: the rule is kept and marked invalid.
- **GitHub sets (verified, GitHub REST docs, 2026-10-23):** reasons are a documented closed table of 16: `agent_session_finished`, `approval_requested`, `assign`, `author`, `ci_activity`, `comment`, `invitation`, `manual`, `member_feature_requested`, `mention`, `review_requested`, `security_advisory_credit`, `security_alert`, `state_change`, `subscribed`, `team_mention`. `subject.type` is a plain string with no documented values; `Issue`, `PullRequest`, `Commit`, `Release`, `Discussion`, `CheckSuite` and `RepositoryVulnerabilityAlert` are observed, not promised; Question 15 makes `type` a strict menu of them, with any other value reported as unexpected.
- **Phone:** labels, field-kind tests and draft checks as pure helpers beside `RuleDraft`; `RuleEditorPage` renders them. The codegen needs the union in `ROOTS` and `SEALED_ROOTS`. An older phone ignores `fieldSpecs` and keeps typing; a new phone falls back to text against an older Gateway.
- **Size:** 12 to 14 files, 250 to 400 lines plus 40 to 60 generated. Re-estimated at 16 to 19 files after the Phase 4 audit, with the restore contract, persisted unexpected values and the older-phone path.

**Summon, codebase (Luna, 2026-10-23):**
- **Entry:** `MainActivity` is `singleTop` with only a launcher filter. `consume()` runs from `onCreate` and `onNewIntent` and reads team, queue and vault extras, never `intent.action`. An assist request belongs there, held like `WorkspaceOpenBus` until boot is Ready, then landed by clearing any open conversation and settings and showing `RootView.ASSISTANT`; `showRoot` alone loses to an open conversation in `shellScreen`.
- **Notifications and queue jumps:** `openTeamRequest` goes through `openThread` and `nav.arrive` today. The assistant's must land on the Assistant view and carry the queue's `revealAt` into the embedded transcript.
- **Lock:** no `showWhenLocked`, `turnScreenOn` or `requestDismissKeyguard` anywhere. The app's own biometric lock draws `LockScreen` from `shellScreen`; `ApprovalGate` guards vault actions only. Over the keyguard, the full shell would reach Sessions, Vault and Settings through the drawer.
- **Voice:** no speech-to-text and no `RECORD_AUDIO`; `Stts` is text-to-speech. Dictation on summon would need a recognizer, the permission, and a one-shot start request into the embedded composer.
- **Gates:** `back-handler-residue` allows a `BackHandler` only in `MainActivity`, `AttachmentViewer` and `Onboarding`. Nothing fences a new intent filter or component. The sandbox build inherits the manifest, so `am start -a android.intent.action.ASSIST -n <sandbox>/...MainActivity` tests it.
- **Size:** routing and landing 4 to 6 files, 70 to 130 lines. A `VoiceInteractionService` 2 to 3 files, 80 to 140. Unlock-first 2 to 3 files, 30 to 70; a locked-mode surface 3 to 5 files, 80 to 160. Dictation 4 to 6 files, 90 to 160.

**Summon, platform (Opus web research, framework source to `android17-release`):**
- **Qualifying:** an exported activity handling `android.intent.action.ASSIST` with `category.DEFAULT` is enough for the Digital assistant picker. A `VoiceInteractionService` is optional. The role is not requestable; open Settings (`ManageAssistActivity`, falling back to default apps), or `adb shell cmd role add-role-holder` for development.
- **Pixel:** long-press power and the corner swipe both reach SystemUI's `startAssist`, which starts the `ACTION_ASSIST` activity as a new task when no voice service is set. Home Assistant shipped this way for two years; ChatGPT on a Pixel 9 opens from power. Press and hold power must be set to Digital assistant.
- **Trap:** a voice service without `recognitionService` empties the assistant setting on every update (claude-code issue 41696 on a Pixel 10 Pro Fold). If one is ever added, declare a stub recognizer.
- **Lock screen:** nothing is special to the assistant. Without `showWhenLocked` the activity starts behind the keyguard and no unlock prompt appears unless the app calls `requestDismissKeyguard`. With it, the activity draws over the keyguard at once and is usable locked. `showWhenLocked` never goes on `MainActivity`, or a conversation open at lock time stays visible over the keyguard. Gemini's July 2026 lock-screen bypass is the risk case.
- **Recommended:** no voice service. Either the assist filter routes into the shell with unlock-first, or a dedicated assist activity carries `showWhenLocked` and gates everything sensitive.

**Check-ins, codebase (Luna):**
- **Routines today:** a routine targets a spawn point; `routineTeam` derives one session per routine, which `reserveRoutineSession` reuses or recreates. The runner snapshots the rendered runbook, writes `dispatched` before delivery (at most once), and nudges the session to call `get_session_routine` then `report_session_routine`. History lives per incarnation; filing narrows the vault window.
- **What refuses the assistant:** no target kind names it; `routineOwns` expects `routine:<id>:reserve` provenance and the assistant carries `assistant:reserve`; routine idle cleanup would try to forget it; `workingRoutine` and routine vault grants assume one routine per session. The two routine tools are registered for the assistant's process but absent from `ASSISTANT_SWITCHBOARD_TOOLS`, so scope, launch allowlist and gate all drop them.
- **Watchers:** the `inbox` tool lists every enabled watcher, with no filter and no watcher id in its headings. A pick of watchers needs a filter on the listing request. A `new` read advances that watcher's mark.
- **Voice:** a routine nudge goes through `sendFromOwner`, trusted owner ingress with the routine's name as the visible `from`. A send guard keyed on owner ingress would read a check-in as the owner's message. The senderless `deliverEvent` road exists for watcher events.
- **Designs:** (a) an assistant target kind on routines reuses `advance`, the occurrence fence, deadlines, misses, snapshots and history; it must skip reservation and cleanup, check the assistant's provenance and placement, and grant no routine secrets. (b) a separate check-in record under Assistant settings needs its own durable fence and miss handling, since `advance` is coupled to `Routine`. Luna recommends (a), edited from the Assistant view, with picked watcher ids and a filtered live `inbox` read. About 15 to 20 files, 650 to 1,000 lines.

# Mockups

Design cards in `plans/assistant-refinements/`, sent to the dock 2026-10-23: drawer, settings page, rules page, rule editor with the reason menu. The chat card was removed: the Assistant draws the real conversation screen, not a new chat.

# Next slice

From the deleted first plan, on the board as bd_0d2b09c4: check-ins, summon from the power button or lock screen, a ping flag per row, the winning rule on a wake, approval cards with Undo, timed compaction, Gmail, phone events. From Question 17: read-only repos for the assistant, with Files, so it can talk code. From Question 20: a check-in's watcher pick, once a second watcher exists.
# Plan

Implementation steps: implementation-phase, align-fan-out, align-fix, red-team-fan-out, red-team-fix, implementation-commit, architecture-fan-out, architecture-fix, architecture-commit, documentation, crust-collection, plan-completeness. The compliance steps are skipped.

Wire changes follow the repo's rule: new fields optional at the Gateway, tolerated by older peers, with a dated comment where a field becomes required.

## Phase 1 - Assistant visibility ✅

Hides the assistant from every session and friend. Gives the assistant no new tool: crosstalk lands with its guard in Phase 5. Deploys the Router before the Gateway: an older Router keeps projecting an existing share of the assistant to a friend.

- **One role value:** a role constant exported from TypeScript is used by `TeamInfoSchema` and the stamp in `presence.ts`, and is generated into `Protocol`. `AssistantOps`'s `ASSISTANT_ROLE` reads it from there.
- **Phone pickers:** `ordinarySessions` is a role predicate beside `SessionOps`. It applies over each picker's own candidates: `localSessions`, `TrustOps.shareableSessions` and `BoardOps.boardAssignTargets`. Counts, vault, notifications, unread totals, the queue and scheduled sends stay inclusive.
- **Cached role:** the stamped role is persisted beside the threads, keyed by canonical address. It is applied to `ChatState.sessions`'s fallback rows synchronously at load, so an assistant thread with no presence row stays out of the pickers.
- **Gateway listings:** one role-filtered read serves `GET /teams` and the local half of `/discover`, and `/discover` filters the remote rows it merges. `crosstalk_discover` reads `/discover`. The cross-Domain gate reads the filtered list through `localKind`, so it refuses the assistant. The owner projection keeps the assistant for the phone.
- **`/pending`:** answers a caller only the rows it sent or receives. No plugin tool reads it.
- **Router:** `friendProjection` drops a row marked assistant before `toCrossDomainPresenceSession`. `ShareService.share` refuses a session reported as the assistant, and an existing share of it is withdrawn.
- **Sends:** `send` refuses a target that is the assistant for `session` and `gateway` ingress, beside the `host` check and before `reach`, so nothing wakes it. Owner ingress (chat, runbook fires, routine delivery) and `deliverEvent` pass. A session the assistant wrote to replies through `channel_reply` and `/respond`. Jobs already waiting on the assistant are left to settle.
- **Tests:**
  - A harness test covers `/teams`, `/discover` with local and remote rows, `/pending`, and a local and a relayed send refused before wake. It also checks that an owner send and a `channel_reply` pass.
  - `router-presence.test.ts`: a marked assistant is dropped from a friend's projection even when shared, and a share of it is refused.
  - Kotlin: `ordinarySessions` over the three pickers, and an assistant thread reloaded with no presence staying out.

## Phase 2 - The assistant's conversation ✅

Reuses the session conversation screen for the assistant. Lands in one commit with Phase 3, since the gear opens Phase 3's pages.

- **Identity:** one predicate, `isAssistant`, says a team is the assistant: from Phase 1's role (presence or the persisted cache), or the address a Gateway answers as its assistant, which marks a fresh placement before any presence row. Never the name. `ShellNav` stores no kind: the open conversation is the assistant's when the predicate says so, and `BackFacts` carries it.
- **Arrival:** one arrival operation reads the predicate before anything opens.
  - The assistant's road sets `root` to `ASSISTANT` and never calls `openThread`.
  - The ordinary road keeps `openThread`, and sets `root` to `SESSIONS` when it replaces the assistant's conversation.
  - Notifications, queue jumps with `revealAt`, `WorkspaceOpenBus` requests and summon all take it. `openThread` refuses the assistant.
  - Every arrival closes what draws above the shell: editors, sheets and dialogs. `RoutineEditor`'s draft moves beside `RoutineOps` first, as `RunbookOps` and `PolicyOps` hold theirs, so nothing typed is lost.
- **Assistant root:** a resolver, replacing `AssistantScreen`'s button view.
  - Placed: enter the conversation.
  - Confirmed unplaced: Configure. Placing enters the conversation.
  - Not yet read: a loading state.
  - Its Gateway unreachable, or a Gateway that may hold it unread and none still loading: unavailable, with Retry. When every unread Gateway refused rather than went unreached, Configure shows beside Retry, since an older build refuses the op and never holds it.
- **Refresh:** the shell refreshes assistant state, keyed on Gateway incarnations, while the Assistant root or its conversation shows. `AssistantScreen` was its only caller.
- **Presentation:** one pure value beside `ThreadScreenState`. The status chip and every other Chat surface stay.
  - "Assistant" in the top bar, the empty state and the conversation drawer header.
  - No tab row, whatever `openTabs` holds.
  - The watcher chips (`watcherChip`) under the title.
  - The gear in place of the overflow menu, so Rename, Close tab and Forget go.
  - Offered views from `assistantConversationViews`: Chat, plus Terminal when `terminalEligible`. Both `MainActivity` sites read it.
- **Back:** Terminal, Chat, Sessions. Leaving the assistant's Chat clears the conversation and sets `root` to `SESSIONS`. The top-bar arrow takes the same step.
- **Followed:** one followed-teams read beside `ThreadOps`: the open tabs plus the assistant, whether or not it shows. `PollDrain`, `PlaybackOps.enqueueForPlay`, `RendererPoolBindings`' retain and its `queueRevision` repaint take it.
- **Refs:** a ref in the assistant's reply opens its snapshot without the Open File and Open Window exits. The assistant never reaches Files.
- **Move and release:** the open conversation follows the assistant's current home.
  - A completed move retargets it.
  - `StillOn` prefers the target just placed.
  - A release returns to the Assistant root, even while another Gateway has not answered. Only the open conversation's own Gateway answering with no folder, or a current roster without it, is a release. A refusal, or no answer from a Gateway the roster still names, is not.
  - The old Gateway's transcript stays under its old address, unreachable.
- **Tests:**
  - JVM cases: the root on assistant arrival and exit, Terminal to Chat to Sessions with the arrow, the offered views, `openThread` refusing the assistant, the followed read, the presentation value, and retargeting on a move.
  - `SandboxFixtures` seeds a role-marked `host.assistant` with a transcript, kept out of `openTabs`, asserted in `SandboxSeederTest`.

### Bug Classes

- **Mechanism:** `followAssistant` and the effect in `MainActivity.App` that decides the open assistant conversation is gone. **Class:** an unknown answer read as a release. **Rounds:** the align pass left the conversation open while another Gateway was unanswered, and was patched with a "was placed, no home known" check. The red team found that check fired on every Gateway re-registration, which discards the held answer, and it was patched to leave only when the held home answers with no folder (`assistantReleased`). The architecture audit found a third: `AssistantOps.refresh` turned any refusal, transient ones included, into a made-up "holds none" answer, and `followAssistant` left on `Unplaced` alone; the held home lived in composable state, so a cold arrival never read its release. The red team then found the same reading in two sibling readers: `AssistantOps.move` counted a refused state read as holding none, so it neither released that Gateway nor named it, and `assistantRoot` offered Configure beside a refused Gateway. **Ended by:** `GatewayEntry.assistant` is an `AssistantWord`, `Answered` or `Refused`, and only `Answered` speaks to placement. `assistantReleased` reads only an `Answered` word with no folder, or a current roster without that Gateway. `followAssistant` acts only under the Assistant root, reads the open conversation's own Gateway, retargets on `Placed`, and otherwise leaves only on that release. `assistantRoot` counts a refused Gateway as unread, answering Unavailable with Retry, plus Configure when refusals are all that is unread. Once placed, `move` names in `StillOn` every other Gateway that did not answer with its state. `AssistantOps.landed` draws an op's own state answer through the fence, so a confirmed release stands even when the read after it is refused. Still open: a re-registration drops the word, so chips blank until the refresh answers.

## Phase 3 - Assistant settings pages ✅

Lands with Phase 2. `GrantSecretsSheet` stays a sheet, one over a page.

- **Route:** one Assistant page field on `ShellNav`, apart from `SettingsRoute`: `Settings`, `Rules(gatewayId, watcherId)` and `Editor(gatewayId, watcherId, RuleSlot)`. `shellScreen` draws it in its own slot below BOOT and above CONVERSATION and ROOT, with its own `BackLayer`. `ShellNavSaver` carries it.
- **Back:** `assistantPageBack` serves system Back on every page and the top-bar arrow on Settings and Rules: Editor, Rules, Settings, then what lies beneath. The Editor's bar has Cancel in place of the arrow: it discards the draft (`cancelRule`) and returns to Rules, while Back keeps the draft.
- **Transitions:**
  - `arrive` clears the pages. `enterAssistant` enters the conversation beneath an open page, so placing from Configure keeps Settings.
  - A completed move keeps Settings and closes the old Gateway's Rules and Editor.
  - A release keeps Settings, and the conversation beneath clears to the Assistant root, so Back lands there.
  - A route whose Gateway or watcher no longer resolves unwinds to Settings (`AssistantPage.resolved`). Only an answer unwinds: a released Gateway, a current roster without it, or an answer lacking the watcher or its rules (`rulesOf` null, as from an older Gateway). An unanswered or refused Gateway keeps the page.
- **State:** each page's screen state sits in a `SaveableStateHolder` keyed by `pageKey`. The rule draft and its conflict offer live in `AssistantOps.ruleDrafts`, keyed by `RuleDraftKey` (Gateway, watcher and slot). Only a landed Save or Delete (`sendRule`), or Cancel (`cancelRule`), clears it. Each held draft carries an `opening`, minted when it is first held, and an op settles only the opening it was sent from, so a save answered after Cancel, or after a reopen, writes nothing back. Move, release, grants, retry and a rule reorder run through `repo.command` and `runWork`, and their line lands in `work` under the page's `WorkKey`, so Back cannot cut a move in half or lose its line. A rule save or delete runs through `repo.command` too. The editor holds its opening before it sends (`holdRule`), so it knows the opening even when the op lands before a frame draws, and closes when that opening lands in `ruleLanded`. The grant sheet and release dialog are not saved state, so an arrival or leaving the page closes them.
- **Editor:** `RuleEditorPage` on `EditorScaffold`, Save in the top bar. Edit, save and delete availability is one pure function, `ruleEditing`, in `RuleDraft`. It does not use the EDITOR layer.
- **Sections:** Lives on and Watchers, in that order. Safety joins between them with Phase 5. One pure function beside `AssistantOps` says which sections show.
- **Watcher block:** health, the secret box, the grant line with Assign secret, the actions, a Rules link row with its count, then Retry when `canRetry`.
- **Status:** one pure `WatcherStatus` beside `AssistantOps` feeds the chip and the health line. "Needs a secret" (`secret` set, no grants) comes first and hides check time and unread. Then stopped, backoff, not checked yet, checked with unread. The chip folds backoff into its unread count, or into not checked yet before a first success; the health line names it. Phone only: `watcherOf` already sends grants, secret and health.
- **Tests:**
  - `ShellNavTest`: open each page, Back through the chain, an arrival clearing the pages, and every page surviving recreation.
  - `AssistantRootTest`: an open Rules page unwinding to Settings on a move, then Back to the retargeted conversation; an open Editor unwinding to Settings on a release, then Back to the root; a page kept while unanswered; and placing from Configure entering beneath Settings.
  - `AssistantOpsTest`: `WatcherStatus` with no grant, a prior success and unread, the section function, and a held draft surviving until it lands or is cancelled, including Cancel and a reopen while a save is out.
  - `RuleDraftTest`: availability while busy, deleted, valid and invalid.
  - The emulator walks the pages on `SandboxAssistantGateway`, which already answers the rule calls.
- **Unread:** a Rules or Editor page whose Gateway refused its read offers Retry (`UnreadPage`); one not yet answered waits.

### Bug Classes

- **Mechanism:** `AssistantOps.sendRule`'s settle, which writes an op's outcome back to `ruleDrafts`. **Class:** a late answer settles a draft it was not sent from. **Rounds:** the align pass found Cancel during a refused save brought the draft back, patched by skipping a key no longer held. The red team found Cancel then a reopen of the same slot let the late answer delete or overwrite the new draft, and clear its `busy`. **Ended by:** each held draft carries an `opening`, minted when it is first held, and a settle applies only to the opening it was sent from, as `HeldEdits` binds an edit to its incarnation. The re-audit added that `sendRule` sends the held draft rather than the page's snapshot, and `editRule` does nothing while its op is out.
- **Mechanism:** the rules pages reading a `repoScope` op's result through page-local state (`RuleEditorPage.send`'s `onClose`, `WatcherRulesPage`'s `said`). **Class:** a result that outlives the page lands nowhere once Back disposes the page. **Rounds:** the align pass moved the reorder into `repoScope` but kept its line in the page. The red team found a reopened editor stays open, blank for a new rule, after its save lands Done, and a reorder's refusal line is lost after Back. **Ended by:** every page reads its op's result from `AssistantOps`, never from its own coroutine. `runWork` holds each page's busy flag and line in `work`, keyed by `WorkKey` (`Settings`, `RuleList`), and Settings and the reorder both run through it in `repo.command`. A Save or Delete records its landed opening in `ruleLanded`, and the editor closes when the opening it showed landed (`editorLanded`), so a reopened editor closes too. The editor's close names the Rules page rather than stepping Back, so two closes land on the same page.

## Phase 4 - Watcher field declarations ✅

- **Declarations:** a strict `fieldSpecs` union beside the rule schemas: `enumeration` (field, label, value and label pairs) and `text` (field, label, a value of at most `ASSISTANT_RULE_VALUE_MAX`). `Watcher` declares the specs only, and must declare them; a watcher with no conditions passes `[]`. The wire `fields` and `fieldsOf` derive from them. `createGithubWatcher` holds GitHub's 16 reasons and the observed subject types. The union goes in codegen `ROOTS` and `SEALED_ROOTS`.
- **One parse:** `parseRuleForFields` refuses an undeclared field, a value outside the set, a test the kind does not take, and a blank value. An enumeration takes `is` and `is_not`; text takes all three. It answers a result, never throws.
- **One trim, pinned on both runtimes:** `trimRuleValue` takes ASCII whitespace off a value's edges and nothing else, in `schemasAssistantRules` and in `RuleDraft`, and every blank check on a rule value reads it. An option value with edge whitespace is refused, since it could never be picked. `tests/fixtures/assistant-rules/vectors.json` pins the phone's Save gate, `fittingRule`, to what the Gateway accepts of the value the phone sends, and asserts a blocked Save says why unless the value is blank. The sandbox's put answers through `fittingRule`, and the Save closure sends the rule `fittingRule` answers, so the gate and the send read one rule.
- **Put and preview:** the console input stays tolerant of unknown keys, so an older phone's write with `ping` still lands (`assistant-rules.test.ts` keeps that case). The field parse refuses what does not fit.
- **Restore:** after `decodedLegacy`, the snapshot parses strictly for structure, through strict on-disk copies of the rule shapes (`StoredRulesSchema`), so an undeclared key quarantines the file; only structural corruption quarantines. Validity is derived per rule against the current specs on every read and never stored, so a spec change moves no revision or position. A put repairs an invalid rule in place; delete and move work by id.
- **One match path:** a field-aware match takes the specs and skips invalid rules. Sort, the inbox listing and preview (including its `firstMatch`) all use it. The full held list stays the read for display and owner ops.
- **Matching:**
  - An enumeration compares the exact raw value; labels are display only. Text keeps case-insensitive `is` and `contains`.
  - A value outside the set flows by its real value: it matches no `is`, and matches `is_not` when it differs.
  - A missing field fails every condition on it, `is_not` included.
- **Invalid status on the wire:** an optional derived list of rule id and reason, beside `rules` on `AssistantWatcher` and `ConsoleAssistantRulesResult`, apart from the stored rule shape. Phase 3's availability function takes it: an invalid row can be edited and deleted, and its stale condition blocks Save until repicked.
- **Unexpected values:** `pollOnce` checks every event in the answer against the specs before the freshness filter, so the priming poll counts. A deduped set keyed by exact field and value, capped with an overflow flag, is kept in watcher state and committed with `settle`. An entry is pruned once the declaration lists it: the answer prunes on read (`unexpectedNow`), and every poll that settles writes the pruned set. Placement resets it with `FRESH_STATE`. An optional field on `AssistantWatcher` carries it; the watcher block shows it under the Rules row, one line per value in its field's label (`unexpectedLines`), and the Rules row counts the invalid rules (`rulesCountText`). A missing field is never reported. A Gateway rolled back to before this field quarantines watcher state, which re-primes the watcher.
- **Phone, on Phase 3's Rules and Editor pages:** pure helpers beside `RuleDraft`.
  - Labels for a field and a value; rows read in labels.
  - The menu for an enumeration, and the tests each kind takes.
  - A kind change clears the value, and keeps the test only if the new kind takes it. Reselecting the same field changes nothing; text to text keeps the value.
  - A value the menu no longer lists shows invalid until repicked.
  - An invalid row with its reason.
  - Typed text from `fields` when the Gateway sends no `fieldSpecs`. An older phone ignores `fieldSpecs` and keeps typing.
- **Tests:**
  - `assistant-rules.test.ts`: restore with a stale rule, preview with an invalid earlier rule, the match rules above, and the older phone's `ping` write.
  - Watcher state and GitHub watcher tests: unexpected values, priming poll included, pruning and the cap.
  - `RuleDraftTest`: per-kind menus and tests, a kind change, invalid rows, labels.
  - `assistant-rule-vectors.test.ts` and `AssistantRuleVectorsTest`: the shared fit corpus, registered in the vectors manifest.
  - `kotlin-gate.sh` for the codegen.
- **Emulator and cards:** `SandboxAssistantGateway` declares `fieldSpecs`, one invalid rule and one unexpected value. The rules and settings cards show both.

## Phase 5 - Send guard ✅

The guard covers `crosstalk_send` alone. Replies and notifications to the owner never ask.

- **Tools:**
  - `ASSISTANT_SWITCHBOARD_TOOLS` gains `ASSISTANT_CROSSTALK_TOOLS`: `crosstalk_discover`, `crosstalk_send` and `crosstalk_wait`, plus the assistant-only `crosstalk_collect` and `crosstalk_withdraw`. `crosstalk_send` joins the gate's `UPLOADING_TOOLS`. The assistant's `crosstalk_send` is the same tool registered `guarded`, posting through `sendGuarded`.
  - `ASSISTANT_INSTRUCTIONS` teaches them, and the teaching test walks the new constant. `assistant-tool-scope.test.ts` stops using `crosstalk_send` as its refused example. `check:boot` proves the scope, and that `ASSISTANT_ONLY_TOOLS` reach neither a bound session nor a tokenless one.
  - The gate keys its uploading tools to the field their refs ride in: `full` for a reply or notice, `body` for a send. A field that is not text is refused.
- **Only a guarding Gateway sends:**
  - The assistant's `crosstalk_send` posts to `/assistant/send`, which only a guarding Gateway serves. An older Gateway answers a plain-text 404, which the tool reports as a refusal; the guard's own refusals are JSON.
  - A guarding Gateway's `/send` refuses a session-ingress send that presents the assistant's token, whatever `from` names, and one whose `from` is the assistant. The guard delivers through an `assistant` ingress only it builds (`sendFromAssistant`).
  - The phone shows Safety only when the Gateway's state answer carries the setting.
- **The decision runs first:** for an assistant caller it runs before any branch on the target, so local, cross-Gateway and cross-Domain sends all pass through it.
- **Safety:** joins Assistant settings between Lives on and Watchers, holding "Approve every send", on by default. It shows the Gateway the Lives on picker names, whether or not the assistant lives there.
- **Setting:** a durable Gateway-local store owned by `composeAssistant`. An absent value means on.
  - Read at every send decision; a failed read asks.
  - It survives release and placement. A move lands on the destination Gateway's own value, so a move fails toward asking.
  - An optional field on the state answer, and an owner-only ConsoleOp setter that answers the held value, wired through `AssistantOps`. Never in the assistant's tools.
- **Binding:** one immutable intent, delivered exactly as bound:
  - the canonical target, resolved before binding, naming a friend Domain when the target is in one
  - the exact body and the disposition
  - the `displayLabel`, and whether the send creates a session
  - each file's digest, name, type and size; a changed file breaks the binding. Binding refuses a file with no digest or whose staged blob is not that size, and the tap checks again before delivery.
  - `bindTarget` in the send road resolves the target; the guard (`createSendGuard`) binds it and joins by the intent's key.
  - Binding refuses a label or file name that spans lines, files to a friend Domain, and a card past the plugin action payload cap.
  - The tap binds the target again, and fails a send whose target moved, or is gone when the card did not say it creates one. A relay that lost its answer fails as possibly delivered.
- **Held send (on, or off and asking):**
  - `crosstalk_send` waits up to 230 seconds, then answers `pending` with a request id. Collect and withdraw continue it. `/assistant/send` joins `GATEWAY_LONG_WAIT_ROUTES`, since an unasked send waits on a wake; collect waits at most 230 seconds, under the 255-second cut, so `gateway-serve-limits.test.ts` classifies it short.
  - A repeat of the same bound intent joins the open request, before the off-mode decision, and its reply goes to the repeat's conversation.
  - A second tap answers "already answered", apart from an expired request.
  - The Gateway delivers once, at the owner's tap, and holds the settled outcome for later collects: sent with its `session_id`, denied with a note, expired, or failed. A withdraw before the tap cancels.
  - The deadline is the vault's.
- **Shared request lifecycle:** ids, deadline, the per-caller cap, join, settle, collect and retract are one core, `createOwnerRequests`, the vault and the send road both use. Shell shapes, grants and policies stay in the vault's adapter. The send's answer goes through the signed owner op `assistant_send_answer`, never through `VaultDecisions` or a value release. An answer that takes time `claim`s its request, which no deadline, withdraw or session end closes, and its settled outcome stays collectable for a grace past the deadline.
  - Each entry holds one phase: waiting or claimed with the adapter's payload, or settled with its answer, cause and `collectUntil`. `step` is the only mutator, `settleInto` the only resolve, `retire` the only delete, and one timer per entry re-arms when it fires early. Every read ticks the entry before it answers.
  - Retention is the adapter's `collectUntil`. The vault keeps an answer to its deadline and retires every lapse at once, so a session's end drops its requests. The send keeps every outcome but a withdraw through the grace. A claimed answer is held through the grace whatever the adapter says.
  - The send's files and conversation ride the entry as its payload, so a settled entry holds no blob reference. The vault route `take`s an answer it has read.
- **Restart:** a held send fails closed. Open request ids are written to a ledger (`vault-open-requests`, `assistant-open-sends`) before a card goes, and retracted on federation activation; a stub stays until its retraction is queued. This lands in the shared lifecycle, so vault cards gain it too.
- **Card:** a `plugin_action` row, `assistant` `send-request`, retracted by `send-retract`. Its own phone card: approve or deny, deny with the vault's optional note. Approve takes `ApprovalGate`, the same unlock a secret takes. The card shows the full text, scrolling, every bound field, each file's full digest and the countdown. Safety lists the Gateway's waiting cards, each opening its card in the app. Its text is a pure Kotlin helper, `assistantSendCardText`. The phone holds pending cards per Gateway (`AssistantSendManager`), claimed by core handlers (`AssistantPlugin`) that no toggle turns off. A re-provision clears them from memory whatever the disk says. Its notification posts on the assistant's own channel, created here with lock-screen visibility private and joined by its replies in Phase 6, with a public version that says only that the assistant asks to send. No notification action approves.
- **Off:** a per-assistant marker holds the origin of the newest input the plugin acknowledged emitting.
  - Each assistant delivery is stamped with its origin where it is accepted. Owner ingress covers chat, runbook fires, routine delivery and check-ins. The other origins are session or Gateway ingress, watcher events, and session replies (`response_push`).
  - The delivery store stamps each row's acceptance order (`seq`), and the marker moves only forward in it, so an older owner row acked after a newer event does not win. A reply moves the marker as it is pushed, ahead of every row accepted so far.
  - Every channel row reaches a session through the delivery queue, whose `observer` (`offered`, `acknowledged`) is required, as is the reply hook; the direct socket write is gone. An offer reads the held row, so the marker and the payload see one stamped row.
  - A row that is not the owner's moves the marker when it is offered, so a lost acknowledgement still asks. An owner row accepted before this process booted never reads owner.
  - A session's end settles its open sends and keeps their answers collectable through the hold. A session's end and a fresh placement clear the marker.
  - Only channel deliveries move the marker; tool results such as an `inbox` read do not.
  - A send goes without asking only while the marker reads owner. A missing marker asks, which covers a restart and rows from before the field.
  - `docs/assistant.md` records the accepted risk: an earlier event, or data read through a tool after the owner's message, stays in context.
- **Record:** every send is recorded where it is accepted, on every road (live, queued and relayed), through the existing `peer` mirror, keyed by the request id. A field marks whether it was approved or went without asking. A denied, expired or failed send comes back through the tool and is not recorded.
- **Tests:**
  - Pure (`assistant-send-guard.test.ts`): the marker's order, the off-mode decision, expiry under manual time, a claimed answer outliving a session's end, the ledger across a restart.
  - Harness (`federation-harness-assistant-send.test.ts`), on: approve once with its records, a joined repeat, withdraw, deny with a note, a changed attachment refused, a friend Domain's target (the harness has no second Gateway in one Domain), a queued target recorded once, restart with the card retracted.
  - Harness, off: sends after an owner message; asks after a watcher event, a session reply or a missing marker; sends after an event followed by an owner message. A check-in waits for Phase 8.
  - The older Gateway's 404 is pinned in `assistant-tool-scope.test.ts`, beside the tool's other answers.
  - `assistant-gate.test.ts`: `crosstalk_send` attachment paths.
  - Kotlin: the card text, the section function with an unsupported Gateway, the public notification.
  - `check:boot`: the scope.

### Bug Classes

- **Mechanism:** `createOwnerRequests`' retention of a settled answer (`keepUntil`, `lapsedAt` and the deadline timer). **Class:** a request is forgotten before its answer's collect window ends, or kept past it. **Rounds:** the core refactor left an answered vault request collectable forever, patched with `keepUntil` armed at settle. The align pass found an expired send dropped at its deadline, so a late collect read 404, patched with `holdSettledMs`. The red team found the read path (`live`, `collect`) still settled an overdue request and forgot it at once, skipping the hold. Its re-audit found `sessionEnded` forgot a held answer at once too, and the read path skipped `onUnanswered`. The architecture audit found a fifth: the timer deleted only when `now >= keepUntil` and never re-armed, so a timer firing a hair early left a settled entry with no timer. **Ended by:** a redesign. Each entry holds one phase (waiting, claimed, settled), `step` is its only mutator, `settleInto` its only resolve, `retire` its only delete, and one timer re-arms on an early fire. Retention is the adapter's `collectUntil`, read once at settlement, so no special case is left for the vault. `owner-requests.test.ts` drives the transitions with a timer that fires before its instant.

## Phase 6 - Lock-screen title tier

Other sessions are unchanged. Code enforces where the title is used, never what it says.

- **Instructions:** `ASSISTANT_INSTRUCTIONS` says the title of `channel_reply` and `notify_human` is shown and spoken while the phone is locked, and to use a generic title such as "Assistant update" when nothing safe can be said. The teaching test checks the rule is present.
- **The locked form:** `AssistantLockedForm.kt` beside `AssistantOps` holds the decision: `spokenTier` takes the role, the lock state and the requested tier, and `lockedLine` the row. It never falls back to the summary or the body.
  - An assistant reply or notice: its title, on one line.
  - A notifying record: "Assistant finished N items", with no thread titles, since those are GitHub's.
  - Any other row: the generic line, "Assistant update".
- **Locked means:** `isDeviceLocked` (Question 18), so a Smart Lock reads as unlocked. `ChatRepository.deviceLocked` reads it through the service, and reads unlocked before the service starts, when nothing is spoken but what the owner taps in the app.
- **Notifications show the locked form everywhere:** a watch bridges what the phone shows and ignores a public version, so `assistantNotificationBuilder` carries only `lockedLine`, unlocked too, and no surface ever holds the body. It posts on the assistant channel, private with a public version, and its Play actions take `setAuthenticationRequired(true)`. The shade lost little, since it already showed an assistant reply by its title. This settles Question 19's mechanism with no research left: there is no full notification to bridge. A change in which threads read as the assistant redraws the team notifications.
- **Read-aloud:**
  - `SttsPlayer.Tier.LOCKED` speaks `lockedLine`, so the queue key, cache and positions stay consistent, and a locked line is never attributed with session labels. A run's boundary marker still names the assistant by the owner's label for it. A quiet row is never queued (`enqueueForPlay`), so no marker names the sessions on either side of a peer row.
  - `PlaybackQueue` mints a new head ticket whenever the head changes. `PlaybackOps` admits a body claim under that ticket, and terminals match the claimed request generation. A stale post, marker-gap callback or terminal cannot start, advance or stop a replacement head.
  - **No public lock listener:** `addKeyguardLockedStateListener` needs a role-gated permission. `DeviceLockWatch` starts at screen off, or at registration when the screen is already off, and checks once a second, reading the keyguard only while a lock would change what is said (`speaksUnlockedAssistant`); screen on and user present stop it after one last check.
  - On a lock, `relock` replaces the head ticket with its locked tier and ends the old claim. After unlock nothing replays; a row heard only as its locked line stays unread with Play.
- **Vault notifications:** `notifyVaultRequest` is private with a public version naming only that a secret is asked for. The channel needs no new id, since its visibility was never set.
- **Peer rows in its conversation:** `PollDrain` marks a peer row in the assistant's conversation `quiet` (`quietInConversation`), persisted with the thread. `isQuiet` replaces `isQuietRecord` and covers both kinds: shown in the conversation, no alert, no Play, no autoplay, not unread. The assistant reports replies in its own words. The stamp is taken at drain, and `drainTick` applies the presence plane before a tick's rows and every other plane after them, which read anchors need. A row can still arrive first (the socket path reads presence and rows independently, or a first drain after provisioning), so when a thread comes to read as the assistant, `withAssistantPeersQuiet` re-stamps its peer rows and the team notifications redraw. Any thread holding a record takes the locked builder, since only the assistant writes records.
- **Role for a new address:** `AssistantOps.move` seeds the destination's address as the assistant once the place lands and persists the roles; `rolesAfter` keeps a past address's role.
- **Tests:**
  - `AssistantLockedFormTest`: the line for each row kind, and the tier matrix.
  - `PlaybackOpsTest`: a locked run speaks the assistant at `LOCKED` and advances past it to another session at the tier asked; a lock mid-speech switches to `LOCKED` and an unlock replays nothing.
  - `AssistantRecordRulesTest`, `ChatPersistenceTest` and `AssistantOpsTest`: quiet peer rows, their persistence, and the seeded role.
  - The sandbox's assistant fixture carries title, summary and body markers and a quiet send record; the emulator shows the record with no Play.
### Bug Classes

- **Mechanism:** head equality and control-lane posts in `PlaybackOps`. **Class:** stale work acts on a replacement with the same `QueueEntry`. **Rounds:** the red team found a posted body could claim after `relock` rewrote the head and play the full text while locked, and that skip and pause had the same gap; patched with an after-claim check and movers advancing before they abandon. Its re-audit found a quick pause and resume left two posts for one equal entry, and the check's abandon dropped a paused position; patched with `bodyGen`. The architecture audit then found an old body terminal can park a resumed equal entry, an old marker-gap callback can clear a new run's markers, a cached body can reach `sound()` before its control-lane abandon, and the direct-play path was dead. The check, the ordering and `bodyGen` could not bind a post to one request. **Ended by:** the queue mints a fresh head ticket for each assignment. Admission claims under that ticket, terminals match the claimed generation, and the ticket makes the later check and mover ordering redundant.
- **Mechanism:** the quiet stamp taken in `PollDrain` from `isAssistant` at drain time. **Class:** a row classified before its team's role is known. **Rounds:** the align pass recorded the window as accepted. The red team found rows drain before planes in a tick, patched by applying the presence plane first. Its re-audit found the socket path reads presence and rows independently, patched by `withAssistantPeersQuiet` re-stamping when a thread comes to read as the assistant. **Ended by:** the re-stamp corrects stored rows after recognition, but cannot retract an emitted alert. Deferred board item: "carry the assistant origin on the row".

- **Manual pass on the phone:** the sandbox posts no notifications and holds no voice key, so these run on a device with a PIN and sensitive content shown: a notification posted before locking and one while locked, the lock-screen Play actions asking to unlock, speech across a lock (including after the service was revived with the screen off), and a paired watch showing only the title.

## Phase 7 - Summon

No `showWhenLocked` or `turnScreenOn` anywhere. No voice service, no speech-to-text, no `RECORD_AUDIO`.

- **Filter:** `MainActivity` handles `android.intent.action.ASSIST` with the default category.
- **One summon ops class beside `AssistantOps`** holds the pure decisions: offer, hold through boot, the fresh-launch check, whether to request dismissal, and the focus token.
- **Read once:** `consume()` ignores the assist action when `savedInstanceState` is set or `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY` is set, and clears it once read. The pending summon sits in a process-lifetime `StateFlow` holder, as `WorkspaceOpenBus` does, so a rotation before routing keeps it and process death drops it.
- **Unlock prompt:** when the keyguard shows (`isKeyguardLocked`, not Phase 6's `isDeviceLocked`), `consume()` calls `requestDismissKeyguard` at once, before boot is Ready. An `onDismissError` while still locked retries once on the next resume. Smart Lock dismisses with no prompt.
- **Landing:** once boot is Ready, summon takes Phase 2's assistant arrival and the resolver decides. It lands at once, behind the keyguard; nothing private shows before unlock.
  - Before any Gateway answers placement, it lands on the last assistant conversation from Phase 1's persisted role; the answer then retargets it or returns it to the root under Phase 2's rules.
  - Unplaced: Configure, and the focus token drops.
- **Keyboard:** a summon focus token, decided beside `ThreadScreenState`, apart from `openNonce`. It fires once, when the assistant's Chat is drawn, the app lock is clear and the window has focus. A locked summon arms it on `onDismissSucceeded`; an unlocked one at once. `ThreadScreen` consumes it in an effect keyed on the token: request focus, show the IME. Nothing waits on `onDismissCancelled`, so a cancel lands the Assistant without the keyboard.
- **App lock:** a summon whose keyguard actually challenged (`isDeviceLocked` true at the request) also satisfies the app's biometric lock. A Smart Lock dismissal does not, so the app prompt still runs. The app-lock prompt waits for window focus, not first composition.
- **Setup:** Assistant settings shows a "Digital assistant" row while `RoleManager.isRoleHeld(ROLE_ASSISTANT)` is false. It opens the system's assistant picker, falls back to default apps, and names the Press and hold power setting. The role cannot be requested by the app.
- **Tests:**
  - JVM: held while boot is Missing, then routed; no replay on a restored or from-history launch; the resolver's outcomes; one focus per summon; dismissal requested only while the keyguard shows.
  - Residue: `ACTION_ASSIST` with `DEFAULT` pinned to `.MainActivity`; `showWhenLocked`, `setShowWhenLocked`, `turnScreenOn` and `RECORD_AUDIO` refused.
- **Device checks:**
  1. Filter smoke: `am start -a android.intent.action.ASSIST -c android.intent.category.DEFAULT -p com.atelier_nyaarium.switchboard.sandbox`.
  2. Real path on the emulator, PIN set: `cmd role add-role-holder --user 0 android.app.role.ASSISTANT <pkg>`, `settings put global power_button_long_press 5`, lock, `input keyevent --duration 1000 KEYCODE_POWER`. Expect the system prompt, then the Assistant with the keyboard up. Repeat with Back on the prompt, warm and cold, with the app lock on, across a rotation, with the screen off, and with an attachment picker open.
  3. Acceptance: the same steps on the owner's Pixel.

## Phase 8 - Check-ins

A check-in arrives as owner ingress through `sendFromOwner`, so Phase 5's marker reads it as the owner's message.

- **Target shape:** `RoutineTargetSchema` gains an optional `kind`, absent meaning spawn. An assistant target keeps `spawn` filled with the assistant's spawn, so an older phone still decodes the list.
  - The new phone always sends `kind`. The Gateway refuses a put without `kind` over a stored assistant routine, so an older phone cannot turn a check-in back into a spawn routine.
  - A dated comment marks when `kind` becomes required. A restore fixture with legacy rows proves the store still loads. `kotlin-gate.sh` regenerates `Protocol.kt`, and `docs/routines.md` loses its spawn-only wording.
- **One target resolver per kind:** team, the session-busy check, preparation (reserve, or the assistant's provenance and placement), cleanup and ownership. Every site that reads `routineTeam` or `target.spawn` takes it: `advance`, `forgetFinishedSessions`, `deliver`, `sessionTaken`, `reserves`, the console reserve, `contextRefusal`, and `sessionOwned` for `workingRoutine` and `openRuns`. The placement check sits in `prepare`, so scheduled runs, Run and Run missed all pass it.
- **Mid-task:** an assistant check-in skips the session-busy check. `waiting_idle` still holds for an unreachable host.
- **Occurrence id:** the routine id travels with the instant through the nudge, both session tools, the route lookups and the baseline's `openRuns`, so two check-ins at one instant never share a snapshot, report or memory. The 64-character bound is raised to fit. A bare instant is accepted only when it matches exactly one of the caller's rows, so nudges in flight keep working.
- **Placement:** a check-in stays on its own Gateway.
  - A save is refused while the assistant is not placed there, as `knowsSpawn` refuses an unknown spawn.
  - At fire, an unplaced assistant stops the occurrence for review with a new cause, `assistant_unplaced`, beside `session_taken`, with phone text for it.
- **No secrets:** `routineRefusal` refuses `linkedEntries` on an assistant target, so `settleGrants` clears them on a retarget. `workingRoutine` answers null for one. The draft drops the entries when the target becomes Assistant.
- **Tools:** the routine tools get their own constant in `ASSISTANT_SWITCHBOARD_TOOLS`. `ASSISTANT_INSTRUCTIONS` teaches them, and the teaching test walks the constant. `check:boot` checks the token-bound tools on a token-bound assistant probe.
- **Watcher pick:** deferred to the next slice (Question 20). The runbook text says what to read, `new` or `all`, and a check-in's `new` read moves the assistant's one mark per watcher.
- **Phone:** target-aware rules in `RoutineDraft` as pure functions.
  - "Assistant" beside spawn points in `RoutineEditor`, offered only on Gateways where the assistant is placed.
  - For it, the editor hides "Forget session after", the spawn point and "Grant secrets".
  - The row names "Assistant". `ViewScope.routinesOf` leaves check-ins out of session-scoped views.
- **Accepted risk:** Phase 5's line in `docs/assistant.md` widens to data read through tools after an owner input, which covers check-ins and owner chat alike.
- **Tests:**
  - `routine-store.test.ts`: legacy restore, the refused kindless put, the `linkedEntries` refusal.
  - `routine-runner.test.ts`: the busy bypass, `runFresh` and `runNow` through `prepare`, no cleanup of the assistant, `assistant_unplaced`.
  - `routine-session-tool.test.ts`: two check-ins at one instant, the bare-instant fallback.
  - Harness: delivery to the assistant, `openRuns` in its baseline, Phase 5 off-mode after a check-in, a Phase 6 locked title.
  - `RoutineOpsTest` and `RoutineTextTest`, `kotlin-gate.sh`, `check:boot`.
- **Size:** about 20 to 25 files.

## Painpoints

- **No same-Domain second Gateway in the harness:** `startFederationHarness` builds one Gateway per Domain, so a send relayed between two of the owner's Gateways, and `/discover`'s remote rows, cannot be driven end to end. Phase 1 covered the remote rows with a unit test of `createPresenceRoutes` and the relay through a friend Domain instead.
- **Lexicon's rename keeps an object-literal key:** renaming `actsFor` produced `actsFor: actsForBoundSession` in the guards' return value, so every destructuring caller needed a hand edit.
- **A console refusal carries no stable code:** `composeRouterFrames.ts` answers an unknown op, an envelope that does not parse, a missing content key and a thrown handler with the same bare refusal, and `ConsoleClientAssistant.kt` `assistantOp` passes each on as `AssistantAnswer.Refused`. The phone cannot tell an older build from a transient fault, so `AssistantWord.Refused` has to mean both, and `assistantRoot` shows Configure beside Retry as a compromise. Policies and routines make the same guess (AGENTS.md, "an older build refuses an unknown op with no stable code"). An `unknown_op` code on the refusal would let every reader decide.
- **A manual fake timer cannot fire early:** `fakeAmbient` in `src/testing/fakeAmbient.ts` fires a "manual" timer exactly on its instant, while AGENTS.md records that platform timers run a hair early (routines `rearm`). The owner-request timer that never re-armed passed every gate through four rounds, and only `owner-requests.test.ts`'s hand-rolled ambient could show it. A drive mode that fires a timer a millisecond before its instant would let every timer-owning module be tested the way it actually runs.
- **An optional hook a safety rule depends on fails open:** `onOffered`, `onAcknowledged` and `onReplyPushed` were optional deps, as was the delivery queue in `createSendRoutes`, so leaving one out compiled and silently let the assistant's origin marker read a stale owner. Many compose deps elsewhere are `?.`-called the same way. A hook whose absence changes a security decision should be required, and nothing marks which ones those are.
- **The send road grows by ingress branch:** `routesSend.ts` `send` decides origin, conversation, refusals and records by `Ingress` kind inside one long function, and the assistant ingress added branches at five points. Who may send through which door is spread across it, `assistantRoutes.ts`, `callerGuards.ts`, `gatewayRelay.ts` and `inboxDeliveryPump.ts` (board item: one typed send authority).
- **The sandbox assistant Gateway answers at once:** `SandboxAssistantGateway.call` and `rules` in `SandboxGateways.kt` return without suspending, so an op's busy window is near zero on the emulator. That hid the unedited-save editor that never closed until the red team read it. AGENTS.md already holds the rule for the workspace sandbox ("answers after a round trip, never at once"); the assistant's sandbox does not follow it, and a walk on it cannot show a page that misreads a quick answer.
