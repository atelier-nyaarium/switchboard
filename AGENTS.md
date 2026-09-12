# Agents

Cross-team communication and devcontainer coordination. This file is a map, not history.

## Layout

- `src/main-mcp.ts` / `main-gateway.ts` / `main-host-daemon.ts` / `main-federation.ts` / `main-vault-askpass.ts` - five entry points
- `src/vault-askpass/askpass.ts` - the askpass helper's decision over gateway, tty, and clock ports; the tty race and the no-tty hold
- `src/gateway/` - Docker-side HTTP and WS router
- `src/gateway/composeGateway.ts` - the compose stages in order, fault port, and cycles; `index.ts` is the Bun adapter
- `src/gateway/compose/gatewayTypes.ts` - `GatewayConfig`, `GatewayDeps`, `GatewayGraph`, and the `GatewayFaultPort` the harness drives
- `src/gateway/compose/federationContext.ts` - the one federation reader; activation publishes boot, Domain id, and slice together
- `src/gateway/compose/composeBootstrap.ts` - directories, identity, keyring, boot decision, schema wipe
- `src/gateway/compose/composeStores.ts` - every durable writer and the restored session-resume payload
- `src/gateway/compose/composeSessions.ts` - registries, `SessionStore`, planes, presence, session authority
- `src/gateway/compose/composePersistence.ts` - the flush every writer takes part in, and its tick
- `src/gateway/compose/composeHost.ts` - the host socket, wake service, host relay, presence watch
- `src/gateway/compose/composeAgents.ts` - Codex and Copilot services, relays, and HTTP routes
- `src/gateway/compose/composeAwareness.ts` - the awareness bank and its tick
- `src/gateway/compose/composeFederation.ts` - `buildSlice`, the Router client, and the share mirror's registration read and delta apply
- `src/gateway/compose/composeEnrollment.ts` - the enrollment window, its TLS door, and the install
- `src/gateway/compose/composeWebSockets.ts` - session sockets and held-delivery handover
- `src/gateway/compose/composeRoutes.ts` - the route surface, built once a Domain is active and rebuilt when federation activates; null before, so no route mints an address
- `src/gateway/compose/composeRouterFrames.ts` - Router frame dispatch and the console dispatcher
- `src/gateway/compose/composeRouterPresence.ts` - the Router presence dirty hook, unlink and untrust teardown
- `src/gateway/compose/composeListener.ts` - the HTTP entry point and the shutdown flush
- `src/gateway/compose/composeFaults.ts` - the fault port's construction
- `src/gateway/httpRouter.ts` - HTTP dispatch, the enrollment routes, and the blob routes; before a Domain it answers health and enrollment alone
- `src/gateway/routes.ts` - `RoutesDeps`, `RoutesCarryOver`, and the composer that wires the route modules
- `src/gateway/routes/addressing.ts` / `callerGuards.ts` / `relay.ts` - local address minting, the refusal gates, cross-Gateway relay
- `src/gateway/routes/routesStatus.ts` / `routesCapabilities.ts` / `routesPresence.ts` - health, pending and teams; the capability fold; discovery
- `src/gateway/routes/routesSend.ts` / `routesRespond.ts` / `routesBoard.ts` - the send, the reply and its poll, the task board
- `src/gateway/routes/routesHumanNotify.ts` / `routesBlob.ts` - console push, and the local-then-Router blob read
- `src/gateway/boot.ts` - `GatewayBootstrap.resolve`, the boot phase decision, the federation slice types, and `RouterHandlers` split into frames and presence
- `src/gateway/router/registerAuth.ts` / `valueResult.ts` - the `gateway_register` frame and the `value_result` settlement, pure
- `src/gateway/wake.ts` - container/session wake decisions
- `src/gateway/wakeService.ts` - one launch per team, whichever door it came through
  - **A joiner gets the launch, not a second one:** `joinCreate` hands the first caller a release
    closure and every later one `null`, so a create cannot be wired to join without being able to
    end, and presence starts and ends once however many callers arrive. A launch that failed is not
    waited on for registration, which would otherwise hold the team for the whole wake timeout and
    refuse close and forget for that long.
- `src/gateway/sessionAuthority.ts` - sole owner of credential-field access; residue-tested
- `src/gateway/presence.ts` / `readAnchors.ts` / `hostOpCoordinator.ts` - presence, read anchors, host RPC correlation
- `src/gateway/router/boardClient.ts` - Router-held task board client
- `src/gateway/router/vaultClient.ts` - vault sealing/opening, delta-held Router list, approval-gated values, and the gateway write
- `src/gateway/vault/decisions.ts` / `requests.ts` / `vaultRoutes.ts` - grants and `displayShape`; request rows that settle once, admit a joining caller, and cap open requests per target; loopback routes, each resolving the one principal, a session by its token
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
    request. Nothing else builds a qualified scope, which is what lets `covers` trust the scope's
    revision. A capture creates an entry and never a policy.
- `src/gateway/vault/operationSet.ts` - the wrapper table read from each program's help, and the set a window grant covers
- `src/shared/selector-key.ts` - the one shape rule, `shapeFrom`; `selectorKey`, what askpass presents and what a policy stores; `withoutAskpassFlags`, the one walk the helper's brief and a policy's keys both take, so `sudo -A apt` keys as `sudo apt`
- `src/gateway/compose/composeVault.ts` - vault client, decisions, requests, routes, and console operations
- `src/gateway/runbooks/store.ts` - gateway-held runbooks; sole writer, so a stored record has passed the rules
- `src/gateway/routines/store.ts` - gateway-held routines; sole writer, and it publishes `onChanged` so the runner cannot be left armed for what the store no longer says
- `src/gateway/routines/memory.ts` - what a routine remembers between runs, keyed by its incarnation
  - **The incarnation, not the id:** minted once and carried across edits, so memory survives a
    rename and dies with the routine. An id reused after a delete gets a new one, which is what stops
    a fresh routine inheriting a dead one's history. `sameContent` excludes it, or a save would read
    as an edit because the gateway owns a field.
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
  - **Restore refuses what a put refuses:** a file with a duplicate id, a non-canonical key, two
    enabled holders of one key, or more than the cap starts the store fresh, as an unparseable file
    does. The gateway is the only writer, so such a file is a hand edit or a bug, and fewer policies
    is the safe direction. The runbook and routine stores restore on the schema alone.
  - **The policy commits first, then the vault prunes:** `onChanged` fires after the write is on
    disk and reaches `onPolicyMoved`, which retracts the policy's requests and prunes its grants.
    Reversed, a failed write would destroy valid grants. Entry-wide authority stays broader than a
    policy's: an entry-wide grant covers a policy scope, and a qualified grant never covers a bare
    use. `docs/policies.md` holds the whole of it.
- `src/gateway/compose/composePolicies.ts` - the policy store, its console operations, and the `onPolicyMoved` seam the vault reads
- `src/gateway/routines/store.ts` / `occurrences.ts` / `runner.ts` - routines, their occurrences, and
  the loop that walks one; `compose/composeRoutines.ts` arms it from federation activation
  - **`advance` is the only door:** the timer, the reconcile tick, Run missed and a pressed Run all
    enter there, so none of them can walk an occurrence another is already walking.
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
    which is right only because `routineTeam` gives one session to exactly one routine.
- `src/gateway/console/consoleRunbookFire.ts` - renders a stored runbook and lands it in a session, creating one first
  - **A preview and a fire reach the same words:** `textOf` is the one road from an id and values to
    text, so `runbook_preview` cannot answer something a `runbook_fire` would not send. A fire may
    name the revision it previewed, and a stored record that has moved past it is refused.
  - **A durable in-flight record is a crash, not a fire in flight:** `consoleHandler` keeps its own
    set of fires this process started. A completion on disk replays, a held key refuses, and
    anything else runs. The key is released only once the completion is durable, or a success the
    migration fence refused to record could be delivered twice.
- `src/gateway/boardAwareness.ts` - board awareness recipients and net-change classification
- `src/gateway/awarenessBank.ts` - subscriber state, deadlines, and liveness reads
- `src/gateway/daemonCapabilities.ts` - daemon capability answer
- `src/gateway/federation/crossDomainShareState.ts` - this Gateway's copy of the Router's shares for its own sessions; a snapshot replaces it, a delta moves it one revision
  - **The Router writes; this reads, and reads nothing until a snapshot of this registration
    lands:** the file may predate a withdrawal the Gateway was not connected to hear, so every read
    answers nothing shared until `replace` runs, and `unready` on a disconnect or a gap closes them
    again. No sweep, no touch, no drop lives here.
- `src/gateway/federation/contentKeyStore.ts` - gateway keyring, sole rule owner, sole writer of `content-keys.json`
- `src/gateway/federation/bootstrapInstall.ts` - staged bootstrap install and re-enrollment merge
- `src/gateway/codexAgentService.ts` / `codexRelay.ts` / `codexRoute.ts` - Codex catalog orchestration, relay folding, authenticated route
- `src/gateway/codexAgentReducers.ts` - Codex pure decision functions: acceptance verdicts, activity and terminal folds
- `src/gateway/codexAgentApply.ts` - Codex daemon event and receipt folding, with its fence checks
- `src/gateway/codexAgentPersistence.ts` - Codex catalog reads, replay, and commits
- `src/gateway/codexAgentTypes.ts` - Codex service deps, transition results, and the application union
- `src/gateway/copilotAgentService.ts` / `copilotRelay.ts` / `copilotRoute.ts` - Copilot catalog orchestration, relay folding, authenticated route
- `src/gateway/copilotAgentReducers.ts` - Copilot pure decision functions: target matching, activity append
- `src/gateway/copilotAgentApply.ts` - Copilot daemon event and receipt folding, with its fence checks
- `src/gateway/copilotAgentPersistence.ts` - Copilot catalog reads, replay, and commits
- `src/gateway/copilotAgentTypes.ts` - Copilot service deps, transition results, and the application union
- `src/gateway/router/` - Router WS client; `pinnedSocket.ts` owns certificate pinning
- `src/gateway/router/inboxDeliveryPump.ts` / `inboxClaims.ts` / `sessionRegistryReporter.ts` - inbox drain with durable claims, and session registry reporting that keeps a refused write pending and retries it
- `src/gateway/router/presenceReporter.ts` / `presenceProtocol.ts` - presence pump and pure protocol; `applyAnswer` cannot reach the sender, so answers do not start frames
- `src/gateway/router/shareAttestor.ts` - share liveness attestation, coalesced
- `src/gateway/router/boardClient.ts` - sole sealer of board text and sole local-key mapper; CAS writes
- `src/gateway/router/blobUploader.ts` - stages this Gateway's bytes on the Router as sealed chunks, resuming from the Router's cursor, and holds relayed bytes under this Gateway's name
- `src/gateway/router/routerBlobReader.ts` - the Router range read a session's `/blob/get` falls through to once local staging is gone
- `src/gateway/console/` - Android OwnerOp dispatch and capability store
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
- `android/.../GatewayRegistry.kt` - the Router's roster as the phone holds it: provenance, per-Gateway answers, and the reads the tabs use; `docs/console.md` holds the rules
- `android/.../PhoneIdentity.kt` / `PhoneBootstrap.kt` / `PhoneAmbient.kt` - the one door for identity facts, the boot value it publishes, and the ambient record (clock, entropy, ids, timer)
- `android/.../SandboxSeeder.kt` - the emulator build's seam: `isSandbox`, the identity facts a
  sandbox boot needs, and the canned state it publishes
- `android/.../RepositoryPorts.kt` / `RepositoryCollaborators.kt` - role ports for the ops classes and their repository adapters
- `android/.../Message.kt` / `MessageFile.kt` / `MessageText.kt` / `Draft.kt` / `ThreadOps.kt` / `ReadAnchor.kt` / `ChatState.kt` / `ConnError.kt` / `FederationTypes.kt` / `ScheduledSend.kt` - repository value types and pure helpers
- `android/.../ChatPersistence.kt` - JSON codec between repository state and AppStateStore
- `android/.../PollDrain.kt` - owner-inbox tick, four plane cursors, and drain-gate subscribers
- `android/.../DrainGate.kt` / `DrainHost.kt` / `SessionHost.kt` / `PresenceHost.kt` - the re-entrant drain gate and one host interface per ops class, each with its repository adapter beside it
- `android/.../ReportReadCompose.kt` / `CapabilitiesCompose.kt` - pure phone composers
- `android/.../PlaybackOps.kt` / `PlaybackReadModels.kt` - playback serialization and lock-free read models
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
  - **An edit in progress lives in `RunbookOps`, not the screen:** the repository outlives an
    activity and saved instance state is a parcel, which a runbook body is not bounded to fit.
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
- `android/.../runbooks/RunbooksScreen.kt` / `RunbookFireSheet.kt` - the tab with Fire per row, and the fire sheet
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
  `GrantSecretsSheet.kt` - the gateway calls, the tab, the editor, the pure lines each row shows, and
  the sheet a routine's secrets are granted through
  - **The phone caches, it never owns:** a routine's record, its next run, its misses and its
    reviews are the gateway's, so a change re-reads rather than guessing. `GatewayEntry` holds the
    displayed copy per gateway for routines and policies alike, and reconciles only by rereading.
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
    order, appends new picks in vault order, and drops an id the vault no longer holds. `grantedLine`
    names that id as missing before the sheet is opened, so the drop is never a surprise. The sheet
    offers only entries with a value that are allowed on this Gateway, the rule `PolicyEditor` keeps.
  - **Every gateway is asked, concurrently, and one that cannot be read leaves the rest drawn:**
    `refreshAll` fans out over the roster, and an answer for a Gateway the roster no longer names
    is dropped at the write.
  - **`ChatState.gateways` is the ONE authority on membership, and `PresenceOps.landProjection`
    its only writer:** the Router's roster, with a provenance. A refresh takes no list, since a
    list passed in is a second source that disagrees with the published one. `withEntry` is the one
    write for an answer and refuses a Gateway the roster does not name, so a read that lands after
    a revocation draws nothing. The stored runbook library is never pruned; a lapsed entry is not a
    reason to lose what the owner wrote.
  - **A zone belongs to its gateway, and an instant belongs to the owner:** each group carries the
    zone its gateway keeps schedules in, which is what the editor converts a typed time into. The
    rows show instants, so they read in the owner's own zone.
  - **The per-gateway reads are `GatewayRegistry` methods, not screen expressions:** `runbookOn`,
    `routineOn`, `policyOn`, `reachable` and `soonestRoutineAt` are what stops a screen reaching
    past its own group, so they sit where a JVM test can call them.
  - **Run and Run missed are different acts, and the row says which:** Run opens a fresh occurrence
    at the moment it is pressed, on every row including a disabled one. The miss panel's button runs
    the slot the rule named. Neither refuses while a run is already working.
- `android/.../PolicyOps.kt` / `policies/PolicyDraft.kt` / `policies/PoliciesScreen.kt` / `policies/PolicyEditor.kt` /
  `ConsoleClientPolicies.kt` - the gateway calls, the editor's model and its pure refusal, the tab, the editor
  - **Nothing is held on the phone, and every method names its gateway,** as routines do. A
    Gateway that refuses `policy_list` is drawn as nothing, since an older build refuses an unknown
    op with no stable code; one that cannot be reached keeps what it drew. `ConsoleClient.sendValueAnswer`
    tells the gateway's own refusal from the Router's and from silence, and `policyList` answers
    listed, refused or unreachable, so the ops class never reads a null for two things.
  - **A gateway answer is never flattened to a Boolean before the screen sees it:** `save`,
    `delete` and `setEnabled` answer `PolicySaved` or `PolicyDeleted` with the reason, and a
    refused toggle's reason sits on the row in `toggleRefusals` until a toggle of it lands. The
    routine toggle follows the same rule, and carries the revision the row was drawn at. Both
    toggles are fenced per row, so an older toggle's answer never overwrites a newer one's.
  - **A save refusal naming a newer revision offers a save over it:** `PolicyDraft.over` rebases
    the draft onto the revision the gateway named, and only an owner tap reaches it.
  - **Examples go as typed; the gateway keeps keys.** `PolicyDraft` adopts the record the gateway
    answers with, so the phone holds no twin of the key rule. The editor offers only entries
    `allowedOn` that Gateway, and names a binding it cannot resolve.
- `android/.../GatewayPick.kt` - the button a new record starts from
  - **A new record has no Gateway yet:** one is taken without asking, several are asked, and none
    draws no button. Nothing else on these tabs chooses a Gateway, since every row belongs to one.
- `android/.../GatewayReads.kt` - `GatewayReadFence`, the one freshness rule for per-gateway reads
  - **The later read of a gateway wins, and only of that gateway:** the drain loop and a tap both
    start reads, so an older answer can land after a newer one and put back what the owner just
    settled. One counter per gateway, or a slow read of one discards a fresh read of another. Each
    ops class holds its own fence, since a routine read and a runbook read are different reads, and
    the rule lives here rather than being written out once per class.
  - **A fenced read answers `Fresh` or `Stale`, never a null that means two things:** the body's
    own null (a failed call) rides inside `Fresh`, so a caller that leaves the group alone on a
    failure and one that hides it on a refusal both read the same answer without guessing.
  - **A key names the SLOT a read fills, not merely the holder:** one key per session made a symbol's
    source and its knowledge cancel each other. `WindowOps` passes a sealed `ReadSlot`, so no string
    reaches this from there; the other callers still pass one. A read that fills a per-module cache is
    not fenced at all, since nothing an older answer could overwrite exists.
- `android/.../WindowOps.kt` / `WindowRules.kt` / `WorkspaceNav.kt` / `WindowDraftStore.kt` /
  `workspace/` - the Files tab: the open windows and their drafts, every rule the surface applies, the
  Back stack, and the four screens. `docs/console.md` holds the whole of it
  - **Keyed by SESSION, never by Gateway:** two sessions of one Gateway hold different workspaces, so
    a Gateway-keyed map serves one session's span for the other. The fence, the draft filenames and
    the window map all take the qualified session address.
  - **Held state has ONE road in, `apply`, which hands a transform what is held NOW:** a caller that
    captured a window, awaited the gateway and then wrote its decision has nowhere to write it. Not
    enough on its own: a window carries an incarnation minted at open and the set an epoch that moves
    on every close and on a re-provision, because a symbol id names which span and not which OPENING
    of it. Work reads one at the start and lands nothing if it moved.
  - **A draft is one file, written then renamed:** a combined file would rewrite every draft on every
    keystroke batch, which is what `RunbookManager` pays. A failed rename leaves the previous draft;
    deleting first to make room is the one order with a window holding neither copy.
  - **Nothing decides inside a Composable**, since there is no instrumentation source set. The screens
    render and call; `WindowRules` and `WorkspaceNav` hold the decisions and carry the tests.
- `android/.../AttachmentOps.kt` - attachment fetch-and-sweep state
- `android/.../ScheduledSendOps.kt` - scheduled sends as Router-held intents: the drain, the cancel intent, and the Router's result rows, all under one mutex
  - **The Router fires; the phone intends:** a record is pending until `schedule_send` is accepted,
    a cancel of an accepted record is pending until `schedule_cancel` is, and a reschedule is a
    fresh intent naming the version it replaces. `drainPending`, `cancelNow`, `rescheduleNow` and
    `applyRouterResult` are the only transitions, so a JVM test drives every one.
- `android/.../GoalOps.kt` / `Goal.kt` - armed goals and `/goal` line production
- `android/.../PresenceOps.kt` - team presence and read-anchor reporting
- `android/.../SessionOps.kt` - terminal and session controls
- `android/.../ChatRepositorySend.kt` / `ChatRepositoryThreads.kt` / `ChatRepositoryDomainLink.kt` / `ChatRepositoryInbox.kt` / `ChatRepositoryMigration.kt` / `ChatRepositoryStts.kt` / `ChatRepositoryDrafts.kt` - stateless repository extensions
- `android/.../ConnectCoordinator.kt` - the connect sequence over the identity door and the Router reach; `ChatRepository.connect()` delegates to it
- `android/.../RouterReach.kt` / `ConsoleRouterTransport.kt` / `ConsoleSocketMode` - Router addresses, the OwnerOp post with reach failover and pinning, socket mode
- `android/.../OwnerFacts.kt` / `GatewayEnrollment.kt` / `EnrollCeremonyOps.kt` / `DeviceApprovalOps.kt` / `DomainAdminOps.kt` / `TrustOps.kt` - federation delegates
  - **A pairing is a Gateway's, and `TrustOps` holds the one in flight:** the wizard names the
    Gateway at listen or request; every poll, confirm, retry and cancel reads the held `Pairing`,
    nonce included. No pairing call defaults its Gateway.
  - **A share is the Router's record:** `TrustOps` posts and lists shares as owner ops, offers every
    shareable session on every Gateway, and lets a session be shared to a Domain only when its own
    Gateway's `peers` projection holds that Domain. An untrust revokes the Router edges first and
    keeps the owner trusted and pending until every one landed.
- `android/.../SasExchange.kt` / `EnrollCeremony.kt` - shared SAS exchange and commitment core for FLOW-1 and FLOW-2
- `android/.../crypto/ContentKeyring.kt` - phone keyring, classify then commit
- `android/.../crypto/ContentAadKinds.kt` - sole AAD kind builders, twins of `content-envelope.ts`; `aad-kinds-residue.test.ts` pins both to one vector each
- `android/.../MainActivity.kt` - `Repo`, activity, and `App` navigation shell
- `android/.../SessionsScreen.kt` / `SettingsScreen.kt` / `ThreadScreen.kt` / `Onboarding.kt` / `SessionDialogs.kt` / `ReorderableTabRow.kt` / `TabDragMath.kt` / `TimeText.kt` - screen siblings and tab geometry
- `android/.../RendererPoolBindings.kt` / `AppOverlays.kt` / `LinkMenu.kt` - WebView pool, overlays, and link actions
- `android/.../SettingsSections.kt` / `SettingsSystem.kt` / `SettingsVoice.kt` - settings leaf screens
- `android/.../MainTabsScreen.kt` / `SessionsHeaders.kt` / `SessionCard.kt` / `SessionCardPreview.kt` / `SessionsEmptyState.kt` - sessions tab shell, cards, rules, and empty-state machine
- `android/.../vault/` - `VaultSealing.kt` / `VaultManager.kt` / `VaultRouterWriter.kt` / `VaultDraft.kt` / `ApprovalGate.kt` / `VaultScreen.kt` / `VaultEntryDialog.kt` / `VaultRequestSheet.kt` / `VaultRequestText.kt` / `VaultState.kt` - the sealing door, the held entry set with pending requests and the retry count, the owner-op writer, the draft-to-sealed rule, the one owner-presence gate, the tab, the editor, the request sheet, its pure text rules (title, requester, countdown, repeat line), and the held request shapes
- `android/.../crypto/ContentSealing.kt` - the one sealing door the board and the vault subclass; only the AAD builder differs
- `android/.../plugins/vault/VaultPlugin.kt` - claims `vault:request`, forget, and wipe
- `android/.../board/` - board reducers and durable `BoardManager`
- `android/.../board/BoardSealing.kt` / `BoardRender.kt` / `BoardIntent.kt` / `BoardOptimistic.kt` / `BoardRouterWriter.kt` - board text sealing, render with cached fallback, edits held as intent, optimistic apply, and the CAS drain
- `android/.../ConsoleTransportCoordinator.kt` / `ConsoleSocketDriver.kt` - one Router consumer across two transports, and generation-fenced frame routing
- `android/.../Federation.kt` / `FederationManager.kt` / `CrossDomainLink.kt` / `ConsoleClientCrossDomain.kt` / `CrossDomainPresenceUi.kt` - cross-Gateway routing, identity, allowlist, sealing, replay, and presence
- `src/mcp/` - Claude Code tools
- `src/mcp/bridge/` / `channel/` / `references/` / `board/` / `designer/` / `connector/` - bridge, channel, reference, board, designer, and connector tools
- `src/mcp/vault/vaultTools.ts` / `vaultRun.ts` - vault tools over the gateway's loopback routes, and the child run that injects a value and scrubs it from the output
- `src/mcp/routines/routineTools.ts` - `get_session_routine` and `report_session_routine`, registered for any token-bound session and behind no capability
- `src/shared/workspace-op.ts` - the workspace plane's wire vocabulary, beside `host-op.ts` and for the same reason: Gateway to an MCP-side process, never to Kotlin
- `src/gateway/workspacePlane.ts` / `workspaceOpCoordinator.ts` - the Gateway's end of the plane, and the correlation it settles on
  - **A socket IS its generation, and a reply from a replaced one settles nothing:** the generation lives
    in a `WeakMap` keyed by the socket object rather than on `WsData`, since a generation is the plane's
    business. `failGeneration` settles only what one dropped socket carried, so another session's waits
    are untouched, and `close` calls it BEFORE its stale return, or a replaced socket's requests wait out
    the full timeout for an answer that can never come.
  - **One socket per session, chosen by `resolveLiveIncarnation`:** a session can hold several plugin
    sockets keyed team then `subId`. Nothing broadcasts, and no second selector exists.
- `src/mcp/workspace/plane.ts` / `handlers.ts` / `opDedupe.ts` - the plugin's end: the frame it answers, the five reads, and at-most-once
  - **The plugin answers off the agent's turn:** the socket callback and the agent's work share a process
    but not a thread of control, which is what makes a read cost no tokens.
  - **At-most-once is defined HERE, because nothing upstream defines it:** the plane is neither a transient
    value op nor the Router's delivery ledger. `createOpDedupe` replays a settled answer for a repeated key
    AND joins a flight already open, since a replay arriving before the first answer would otherwise do the
    work twice. A thrown op is not held: nothing was answered, so a retry must run.
  - **A symbol id is confined too, not just a path:** an id EMBEDS its module, and Lexicon checks only
    lexical containment. Without `confinedModule` an indexed `.env` would answer through `symbolSource`.
  - **ONE deadline per op, never a budget per call:** two calls each given the full budget outlast the
    plane's wait and reinstate the blind timeout the budget exists to prevent.
- `src/mcp/workspace/loadFile.ts` - the one reader of a workspace file: regular files only, sized before the read, text or nothing. Shared by the refs snapshot road and the phone's file road; containment is the caller's.
- `src/mcp/workspace/confine.ts` - which project files the phone's file road may reach, and the identity a mutation compares
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
- `src/mcp/devcontainer/codexTargets.ts` - one supervised Codex App Server per execution target
- `src/mcp/devcontainer/codexAppServer.ts` - JSONL transport and fail-closed App Server client
- `src/mcp/devcontainer/codexThreadLifecycle.ts` - per-thread queues, settled-turn archival, bounded retirement
- `src/mcp/devcontainer/codexTurnTracker.ts` - turn output; sole `answerOf` reader
- `src/mcp/devcontainer/codexLiveTurns.ts` - live-turn bindings, clocks, and warnings
- `src/mcp/devcontainer/agentDaemonCore.ts` - shared daemon registry, generation fence, serialization, numbering, and outbox
- `src/mcp/devcontainer/codexDaemonService.ts` / `copilotDaemonService.ts` - daemon relay services
- `src/mcp/devcontainer/codexCommandDispatch.ts` - one command kind per run: session acquire, turn start and steer
- `src/mcp/devcontainer/codexSessionLifecycle.ts` - session open, retire, and held-terminal deadlines
- `src/mcp/devcontainer/codexWatchdog.ts` - silent-turn interrupt and idle-target reap
- `src/mcp/local/` - daemonless agent backend
- `src/mcp/local/localAgentRuntime.ts` - the lease, the operation claim, and the dispatch to a request kind
- `src/mcp/local/localAgentHandlers.ts` - per-kind request handlers and turn bookkeeping
- `src/mcp/local/localChildSession.ts` - the one child: open, idle reap, shutdown
- `src/mcp/local/localOperationLedger.ts` - operation identity claim and release
- `src/mcp/agentDispatch.ts` - agent tool serving seam
- `src/mcp/codex/codexTools.ts` - five Codex tools and per-invocation replay ids
- `src/mcp/capabilities.ts` / `capabilitiesTool.ts` - capability gating and guidance
- `src/federation-server/` - live self-hosted federation Router
- `src/federation-server/routerServer.ts` - public `handle(Request)` over `preflight` and `dispatch`; sole `serve()` adapter and sole owner of the node HTTP types; residue-tested
- `src/federation-server/routerBody.ts` - body cap, the too-large, aborted and bodyless-method refusals, and the request both surfaces settle into
- `src/federation-server/ownerOpRegistry.ts` - the owner-op catalog: kind, value schema, mutation class, answer schema; sole kind list for the codegen and the fences
- `src/federation-server/routerDomainBootstrap.ts` - what the Router constructor builds, assembled once
- `src/federation-server/fileSecretStore.ts` - durable federation state and bounded atomic CAS
- `src/federation-server/owner/` - per-owner state layer: fsync'd journal, CAS records, per-address rows, quarantine, lock, Domain quota
- `src/federation-server/inbox/` - inbox service, op ledger, consumer and session registries, gateway incarnation, OwnerOp intake
- `src/federation-server/inbox/inboxAppend.ts` / `inboxRetire.ts` / `inboxSweep.ts` / `inboxOpResult.ts` / `inboxCore.ts` - row append and admission, row retirement, the expiry sweep, router-authored result rows, and shared primitives (`recordId`, `guarded`, `ledgerTransaction`, `ownerAddress`, `floorOf`) behind `InboxService`
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
  - **Every mutation carries the base revision it read**, delete and enable included. A routine's
    enable carries none, and a stale toggle wins there; a policy's does not.
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
- `src/federation-server/consoleSurface.ts` / `publicApproval.ts` - token-gated operations and token-exempt nonce routes
- `src/federation-server/routerTls.ts` - persistent self-signed certificate; rotation re-provisions clients
- `src/federation-server/*Coordinator.ts` - in-memory flow windows; restart loses and re-arms them
- `src/shared/agent-binary.ts` - uncached backend CLI presence check
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
- `src/shared/codex-agent.ts` / `codexAgent*.ts` - Codex delegation wire truth; excluded from Kotlin codegen
- `src/shared/copilot-agent.ts` / `copilotAgent*.ts` - Copilot delegation wire truth; excluded from Kotlin codegen
- `src/shared/channel-file.ts` - declared ChannelFile metadata; receivers do not infer it from bytes or position
- `src/shared/session-id.ts` - sole address grammar owner
- `src/shared/session-commands.ts` - what a session can be told to call: one entry per command, holding the tool name, the gateway path and both schemas
  - **A nudge names a command, never a tool:** the prose renders the catalogue's name, the gateway
    serves its path and the MCP registers it, so words cannot ask for something nothing answers.
    `check:boot` runs the real `main-mcp` and proves the tool is there.
- `src/shared/host-spawn.ts` - sole host-shell spawn-segment and command owner
- `src/shared/crypto.ts` / `admission.ts` / `router-protocol.ts` / `federation-lifecycle.ts` - federation trust wire vocabulary
- `src/shared/notice.ts` - shared notice tiers
- `src/shared/wire-vocabulary.ts` - sole TS declaration of Router paths, the console header, signing tags, the bridge's refusals, nonce lengths; generated into `Protocol.Wire` beside the owner-op kinds the registry catalogues; residue-fenced on both runtimes
- `src/shared/fixture-identity.ts` - the committed test signing keys; shipping entry points refuse them without `ALLOW_FIXTURE_IDENTITY=1`
- `src/shared/ambient.ts` - the clock, entropy, ids, and timers as one injected record; `processAmbient` is the sole reader of the globals and unrefs every timer it hands back. `composeGateway` and `RouterServerParams` take one and thread it everywhere; `ambient-residue.test.ts` fences the three directories and names the reason for each allowed file. Vocabulary shared with the phone's `PhoneAmbient`, not a type
- `src/shared/atomic-write.ts` - sole write-then-rename and temp-suffix owner; residue-tested
- `src/shared/durable-store.ts` - atomic snapshots and per-file quarantine boundaries
- `src/shared/write-result.ts` - the two readings of an owner-store write: `landed` before anything irreversible, `appliedOrUncertain` before anything a caller retries; no site spells the pair
  - **An uncertain write is not a landed one:** a `durability_uncertain` line may or may not be on
    disk. Bytes and holds wait for `landed`; a record write a caller can
    repeat idempotently takes `appliedOrUncertain` and passes the word on in its answer.
- `src/shared/session-store.ts` - authoritative gateway sessions keyed by `spawn.id`
- `src/shared/session-sanitize.ts` / `session-tokens.ts` - normalization, session ids, and bind tokens
- `src/shared/board-rank.ts` - sibling ordering and asserted fractional ranks
- `src/shared/agent-screen.ts` / `pane-trim.ts` - pure tmux-pane reads with Kotlin twins and shared fixtures
  - **A rule is a RUN, not a LINE, and `afterRuleRun` owns it:** `-J` welds rows. Windows panes weld composer rules to adjacent rows. Readers use `footerRegion`.
  - **Two rule notions are distinct:** `TOOLBAR_RUN_RE` is U+2500 only; `ANY_RULE_RUN_RE` spans U+2500-U+259F.
  - **`limitNotice` searches in two passes:** whole-line matches precede welded-rule matches.
  - **The composer glyph has two members:** Linux uses U+276F; Windows uses U+003E. Whitespace is explicit because JS and JVM `\s` differ for U+00A0.
  - **The last-two-lines fallback is uniform:** readers scope it to the final region.
- `src/shared/schemasConsoleOp.ts` - ConsoleOp schema, `DELIVERY_OP_KINDS`, and `VALUE_OP_KINDS`
- `src/shared/pending-job-store.ts` / `plane-registry.ts` / `reconnect.ts` / `process-guards.ts` - shared jobs, planes, reconnect, and process guards
- `android/` - Gradle/Kotlin console app; `proto/Protocol.kt` generated
- `scripts/` - build, Kotlin codegen, leaf sync, setup, federation start, residue checks, and voice import
- `scripts/lib/routerStart.ts` - sole Router `.env` and startup owner
- `src/shared/vault-askpass-wrapper.ts` - the `~/.local/bin/vault-askpass` wrapper; the host daemon lays it down at boot and removes the exact text it wrote on exit, the plugin lays it down inside a container, and `host-spawn.ts` exports its path into every bash session it spawns
- `scripts/lib/verifyChecks.ts` - setup verification checks
- `android/.../SelfMigration.kt` / `CursorTranslationOps.kt` - phone self-migration and consumer cursor translation
- `android/.../ConsoleSocketClient.kt` - `ConsoleSocketMode`
- **Migration window reader:** `readRouterMigrationWindow`. A present null epoch means an unreadable file
- `tests/fixtures/` - shared golden wire and signing fixtures; manifests drive both runtimes
- `tests/fixtures/identity/set.json` - the one fixed identity set every harness and fixture generator reads; `scripts/gen-identity-set.ts` mints it
- `tests/fixtures/wire/ts/` / `wire/kotlin/` - minted wire fixtures, each runtime's real composers under the set; `scripts/gen-wire-fixtures.ts` and `WireFixtureGenerator.kt` write them, `check:fixtures` and `kotlin-gate.sh` diff them
- `src/testing/` - the federation harness, `fixtureWorld.ts`, real Router and gateway graph in-process, friend Domains linked through the real handshake, fake host and session sockets with the fake Codex daemon, the TS phone driver, the console socket; `docs/testing.md`
- `src/testing/fakeAmbient.ts` - the harness ambient: a clock offset on the harness `now`, entropy seeded per instance so two peers never collide, and timers on either drive. "real" (the default) rides the process timers so every scenario makes progress unchanged; "manual" holds them until `advance(ms)` reaches each deadline, yielding to the event loop between firings
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

| Port | Service |
|---|---|
| 20000 | Gateway HTTP and WS, loopback only |
| 20001 | Federation Router TLS |
| 20002 | MCP connector WS |
| 20003 | Enrollment TLS, one-time nonce |

How each subsystem works lives in `docs/`:

| File | Covers |
|---|---|
| `docs/architecture.md` | Addressing, host spawn points, sessions and wake, identity binding, state planes |
| `docs/federation.md` | Router, reach failover, TLS pinning, trust |
| `docs/console.md` | Console OwnerOp client, terminal view, armed goals, capability union, Android app |
| `docs/agents.md` | Codex and Copilot delegation, local agent mode |
| `docs/task-board.md` | Board, attachments, awareness |
| `docs/vault.md` | Vault client, grants, request road, loopback routes |
| `docs/policies.md` | The policy record, the selector key, the store's rules, the askpass resolver, what a qualified grant covers |
| `docs/runbooks.md` | The `{{name}}` grammar, the gateway store, the fire, the tab, the editor, a refused push |
| `docs/routines.md` | The routine record, recurrence in a recorded zone, the console operations, what a session asks back, and the manual pass no gate here can reach |
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
debug build installs straight over it. Without those exports the build signs with the default debug
key and the phone refuses the install. The version code must exceed the installed one.

```bash
source ~/android-dev/env.sh
INSTALLED=$(adb shell dumpsys package com.atelier_nyaarium.switchboard | grep -o 'versionCode=[0-9]*' | cut -d= -f2)
cd android && ANDROID_VERSION_CODE=$((INSTALLED + 1)) ./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/switchboard-debug.apk
```

The phone stays on wireless adb; `adb devices` lists it. No push or CI round trip is needed.

**Every phone iteration goes over adb, never through CI.** Two minutes, against ten for the
Android release, and there is always more to do than watch a workflow. Push when the work settles,
not per tweak. `assembleRelease` reads the same keystore env, so the phone can stay on the
production variant; `assembleDebug` is for when the ingest log stream is wanted.

The CI release takes its version code from `github.run_number`, so local builds walk ahead of it
and a later release APK can read as a downgrade. Build that commit locally instead of waiting for
the run number to catch up.

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
Kotlin and TypeScript file; its two exemptions are the files that assert on terminal escapes.

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

## Deploying

### The four components update on SEPARATE triggers

| Component | Updates when |
|-----------|--------------|
| MCP plugin | marketplace pull or session restart under autoUpdate |
| Gateway | manual restart |
| Host daemon | `./start-host-daemon.sh` |
| Console | app update |

New wire fields OPTIONAL at the gateway and tolerated by both peers. Deploy gateway first, then push the version bump. The plugin can update before the other components.

A field that is optional only to cross that gap, and should be required once every part has updated, carries a comment above it naming the date it becomes required, about two weeks out. A field that is optional by meaning carries no date.

That order covers fields the gateway EMITS. A change to what the Router ANSWERS deploys the Router first, since a gateway reads the answer it is given.

### Plugin

1. Commit source work.
2. Run `bun run build patch|minor|major`.
3. Push.
4. Reload target containers with `reload_plugins`.

The build derives versions, bundles `dist/`, and commits the release. Do not hand-edit version fields. Bun 1.4.0 or newer required.

### The lexicon submodule

`lexicon/` supplies the client at build and test time. `postinstall` links its packages into `node_modules/@nyaa-lexicon/`; runtime uses the bundled client.

- Fresh clone: `git submodule update --init` before `bun install`.
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

Gateway Setup displays the admit payload and waits on the same screen for the phone's sealed bundle. `prompt()` blocks polling, so `readKeyWhile` uses raw mode and restores cooked mode on every exit. The screen prints the SAS from the admit payload. The countdown starts when `armGateway` returns, before health and payload waits. No LAN block means paste is the only enrollment route.

Purge Gateway removes only gateway state and gateway-owned `.env` keys. Purge Federation removes this owner's Domain slice first, then performs the gateway purge and removes the Domain id and setup code. The Domain id may come from `.env` or the Router's admin-Domain mark.

**Purge Gateway does not revoke the Gateway:** Only the phone holds the signing key. Use Revoke in the app.

**`.env` is shared by the gateway and Router:** Purges must preserve the file.

**The phone's half of Purge Federation is Forget this Domain:** Revoke and Delete is app-only because it purges the Domain server-side.

`scripts/lib/routerState.ts` keeps Bun `$` templates on one line. Bun treats a backslash-newline as an argument split, not continuation.
