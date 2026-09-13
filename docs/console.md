# Console

The Android console reaches the Router through signed OwnerOps.

## OwnerOps

`ConsoleClient` sends protocol version 3 operations with one `conversationId` and `opId`.

**The version is a documented floor, not a negotiated one.** No console sends it and no gateway
checks it. Adding a wire field stays optional and degrades field by field. Removing an accepted kind
is not additive: it bumps `CONSOLE_PROTOCOL_VERSION`, this file records what went, and a console
built before the bump gets the gateway's existing "not allowed" refusal until it updates. A kind
that must keep working for one more console build goes into `TOLERATED_DELIVERY_OP_KINDS` with a
`Remove-by` line instead.

- 3: removed the nine `board_*` delivery kinds (the board lives on the Router) and `peek` as a
  delivery op (it is a value op).

- `deliver` carries a `console_op` row. Delivery kinds are `DELIVERY_OP_KINDS` in
  `src/shared/schemasConsoleOp.ts`. The answer is an `op_result` row sealed under
  `opResultAadKind`.
- `gateway_value` carries a VALUE kind from `VALUE_OP_KINDS`. The Router forwards it as a
  `value_op` frame. The answer is sealed under `valueResultAadKind`. Results use typed `unreachable`
  or `timeout` outcomes.
- Other OwnerOps are `consumer_register`, `inbox_read`, `inbox_advance`, `planes_read`, `report_read`,
  `capabilities_report`, and the vault's `vault_list`, `vault_put`, and `vault_delete`. The value
  kinds `vault_answer`, `vault_grants`, and `vault_revoke` are answered by the Gateway's vault stage
  (`docs/vault.md`); a request to approve arrives as a `plugin_action` row with `pluginId`
  `vault`. Sharing a session with a friend Domain is the Router's `cross_domain_share` owner op;
  `cross_domain_unshare` and `cross_domain_list_shares` are the other two. No Gateway is named. The
  session's Gateway learns the record by revision (`docs/federation.md`).
- The phone socket uses `ConsoleSocketMode.INBOX`.
- `PollDrain.drainTick` calls `inbox_read` and `planes_read`. It sends one `inbox_advance` after
  rows drain.
- `OwnerOps` signs every op from its injected identity, clock, nonce, and op id. The bodies of
  `report_read` and `capabilities_report` come from the pure composers `composeReportRead` and
  `composeCapabilitiesReport`.

**Identity:** `PhoneIdentity` is the one door for identity facts (the provisioning blob, the
conversation id, the Domain id, the owner identity, the Domain snapshot, the content keys, the
admission latches). Each write is serialized and re-assembles `PhoneBootstrap`, published as
`bootState`; `Ready` carries the credentials, the console identity, the owner sign pub, the Domain
id, and the content keyring. `ConsoleCredentials` is the credential blob, every field named and
required; `ConsoleCredentials.parse` is its one builder over the `Provisioning` wire shape and
writes nothing, so the door is what resolves and persists the conversation id for a written blob.
The Domain id is the stored one, else an invite's pending tenant. A fact a connect learns names the
blob it was learned for, and a later blob refuses it. The boot's `ContentKeyring` is the key
authority of its generation; a replaced boot refuses a late install. `phone-identity-residue`
fences the store setters and the FederationManager's writes to the door. `PhoneAmbient` carries the
clock, nonces, op ids, wrap entropy, and the missing-epoch timer.

**Repository seams:** `OwnerOps`, `KeyDeliveryOps`, `ConsoleClient`, `BoardSealing`, and
`CursorTranslationOps` take the boot and the ambient. `PollDrain`, `SessionOps`, `PresenceOps`, and
`RenameOps` take one host interface each (`DrainHost`, `SessionHost`, `PresenceHost`, `RenameHost`);
a host declares only what no port covers, so the roster refresh and republish a drain or a session
action asks for come from `PresencePort`. The nine other ops classes take the role ports
(`ClientPort`, `IdentityPort`, `PresencePort`, `PlaybackPort`) plus a per-class collaborator record,
adapted in `RepositoryCollaborators.kt`, so a JVM test constructs them over shared fakes.
`ConnectCoordinator` owns the connect sequence over the door and the Router preflight
(`ConsoleReach`), with `ConnectHost` for the rest. The one held `ConsoleClient` lives behind
`RepositoryProvisioningHost`, read through `client()` or `clientOrNull()` and dropped through
`invalidateClient()`. `DrainGate` is the repository's one re-entrant drain mutex. Sealing takes an entropy hook (`Crypto.seal`, `ContentKeyring.wrapFor`,
`KeyDeliveryOps.wrapEntropy`, `PhoneAmbient.newNonceBytes`); a null hook draws from `SecureRandom`.

Phone-bound rows are appended by the Gateway through `deliverToOwner`.
`src/gateway/consolePushOps.ts` owns the durable `OwnerRowOutbox` for disconnected or uncertain
appends.

**A reply reaches the owner once.** `routesRespond` answers an owner-anchored reply with one `reply`
row, and mirrors a thread as `peer` rows only when the asker is a session, which `LocalReply`
names. The phone threads a drained row by its store key: a conv row under its own address, a
notice row under its sender. Nothing on either side compares an address to the phone's own.

### No Gateway is the phone's own

The phone holds no home Gateway and no default for one. Every console call names its Gateway, a
cross-Domain pairing names the Gateway the wizard picked, and the runbook library is a map keyed by
Gateway, so a library stored as one list decodes as empty. A phone target is
`domain.gateway.spawn` or `domain.gateway.spawn.session`, parsed by `parseQualifiedTarget`, and the
gateway's console handler refuses anything shorter. `home-gateway-residue.test.ts` refuses the old
words on the phone.

**No screen reads an identity default to decide what to draw.** The Routines, Runbooks and
Policies tabs read `ChatState.gateways` and group by Gateway. The Policies tab rides the vault
plugin, since a policy binds a secret. A Gateway that refuses `policy_list` is drawn as nothing,
since an older build refuses an unknown op.

A join bundle sealed for a freshly approved device carries `version: 2`; `parseConsoleTransport`
refuses any other version, and the new device tells the owner to update the held one.

### `GatewayRegistry`, the one owner of membership

The Router's presence projection carries the Domain's roster, and `PresenceOps.landProjection` is
the only writer of `ChatState.gateways`. The keyring says who may sign; the roster says who is a
Gateway on this phone, and no screen reads the keyring. Each entry carries what the Router said
(`connected`, `incarnation`, `lastRegisteredAt`, `hostSpawns`) and what that Gateway answered
(`routines`, `runbooks`, `policies`), written through `withEntry`, which drops an answer for a
Gateway the roster does not name. A restarted Gateway is re-asked: `landed` keeps answers only at
the same incarnation, and the tabs key their re-read on `incarnations()`.

The registry has a provenance. `NeverLoaded` is not an empty roster; `Cached` is the last slot on
disk, landed once before the first poll and drawn with a stale mark; `Current` is a live
projection. `offersSpawn(id)` is the Sessions tab's Create rule: the roster is loaded, the Router
holds that Gateway's connection, and the Gateway projected its spawn points (`hostSpawns` is null
until it does). `standing(id)` answers `Unknown`, `NeverSeen`, `Offline` or `Online` for the
section header. `reachable(id)` says the roster is `Current` and the connection is held; the
new-record button reads it. Board assignment targets and a journaled forget read membership
alone (`owns`), since an assignment is intent the Router holds and the journal exists for what
cannot be delivered now. A vault revoke and deleting the own Domain wait for a `Current` roster.
`PollDrain`'s plane cursor decides what lands (below); `applyOwnerProjection` lands and rewrites
the slot without comparing, so an unchanged Router's plane after a restart promotes the restore and
repairs a slot the phone could not read. `clearProvisioning` drops the Router slots with the Domain.

### Plane lineage, the one reader rule

Every Router-held plane the console reads (`presence`, `taskBoard`, `vault`) stands at a
`PlaneLineage { epoch, version }`: the epoch is a random tag minted once per Domain slice and
compared for equality only, the version orders inside it. It travels on `planes_read`'s `known`,
on each `PlaneRead`, on the socket welcome's `versions`, and on the `plane` frame. The Router serves
a plane unless the console holds that lineage at that version or past it.

`foldVersionedSlot` (`src/shared/versioned-slot.ts`, `VersionedSlot.kt`, pinned by
`tests/fixtures/versioned-slot/vectors.json`) is the one comparison on the phone: within a lineage
the Router's version orders; across lineages the reader's own observation order does, since a random
epoch cannot be ranked; a durable value carries no observation, so it takes any other lineage.
`PollDrain` holds the in-memory cursor for every plane, stamps each arrival as it enters the process,
and never persists it, so a cold boot re-reads every plane; behind it, the presence slot and the
board and vault managers hold their own durable lineage. A board or vault plane past the manager's
list fetches, at most once a minute within a lineage; one held or behind is acknowledged. Another
lineage drops the held list and fetches from zero at once, and bumps the manager's generation so an
answer begun under the old lineage lands nothing; the first lineage a manager sees keeps its entries
and fetches from zero. Pull-to-refresh asks the Router for every plane and lets the fold decide, so
nothing is re-landed that the phone already holds.

What the fold assumes, and nothing checks: an epoch is 31 random bits, so a collision on a
re-provision returns that one lineage to a bare version compare; the Router's durable state never
rolls back, so a restored backup is a new provision, not an older version of the same epoch; the
observation stamp is taken when an answer is decoded, so a socket frame that lands inside the
dispatch gap of an HTTP answer orders before it, and the next welcome or pull repairs it; the
presence payload's own `plane` equals the `PlaneRead` lineage around it because `readPlanes`
computes both in one synchronous pass. A removed Domain's console sockets are refused and its
owner store leaves the Router's cache, so nothing serves its old lineage.

No screen filters by a home Gateway. `TrustOps.shareableSessions` offers every shareable session on
every Gateway, and a session can be shared to a Domain only when its own Gateway's `peers` projection
holds a pairing with that Domain; a Gateway whose peers were never read is drawn as stale, not as
having none. A pairing is a Gateway's: the wizard names one at listen or request, `TrustOps` holds
that `Pairing` with its link nonce for the pairing's lifetime, and every poll, confirm, retry and
cancel reads it. A pairing does not survive the process; the Gateway's rendezvous window is the
authority and a fresh wizard starts a fresh one. Untrust revokes the Router edge for each of the
owner's Domains first, then asks every Gateway whose peers name the owner to forget them, then drops
local trust; with the Router unreachable nothing is revoked, trust stays, and the owner is marked
pending until the next welcome retries.

A Gateway below protocol 3 is refused at registration, so the roster shows it offline until it is
restarted on a current build.

## Add Device

The device signs `approvalId`, `nonce`, `newSignPub`, and `newBoxPub`. The held device refuses an unsigned or mis-signed join before admission or key sealing.

The install writes the transport, the latches, the Domain snapshot, and the content keys in one store commit.

An owner backup restore replaces a key that rooted nothing and refuses a key that differs from the Domain root. Epoch 1 regenerates once the Domain id is known.

## Terminal view

Terminal operations reach the host through correlated `host_op` RPCs. `hostOpRunner.ts` owns peek
single-flight, cadence and concurrency limits, and mutating-op deduplication.

- `tmuxCore.ts` builds spawn argv without a shell. Exact tmux lookup uses `-t =<name>`; prefix lookup
  would let `story` select `story-2`.
- `peekWithFallback` returns the `devcontainer up` transcript, then Docker logs, before a pane
  exists. The result uses flat optional `kind` and `text`; a discriminated union does not work with
  the Kotlin wire model.
- A devcontainer launch ends in `exec bash` like the host launch, so a pane whose `claude` never
  started stays peekable with the error on screen.
- A wake with no capturable pane is reported as failed, so `/send` fails instead of waiting forever.
- The **Wake** button sends the `wake` delivery op to the session's own address. The gateway resolves
  it to the local `spawn.session`, bounds the launch like `create_session`, and answers `pending` past
  the bound. A session the gateway holds no record for is re-created under its own id, as
  `create_session` does with a typed `sessionName`; a wake that adopted the record and never comes
  up forgets it again.
- **Create** keeps its record whatever the launch does. The console is the authority: a launch that
  fails answers its error, the row lists as asleep, and only a forget removes it. A retry with the
  same op reattaches to the record instead of minting a second one.
- **Forget** journals the op under its opId in the phone's `MutationJournal` before the local drop,
  holds the row's tombstone until the Gateway confirms, then replays every unconfirmed forget at
  service start and after a failed send. The Gateway no-ops an absent session, so a replay is safe.
- The reserved `host` slot requires `HOST_WS_TOKEN`.

## Armed goals

Long-press **Goal** sends the message, then types `/goal <description>` into the session pane.
Console-only, over `send` and `tmux_send`.

- Waiting for the turn does not work: the message bypasses the composer, so the queued line runs
  after the turn.
- A single pasted `/goal` line does not work: the CLI reads the burst as paste. Use three tmux sends
  with Enter separate.
- Injection requires an empty composer and a ready pane. A draft or dialog consumes or joins the
  command.
- The live composer is the last prompt row. Earlier prompt rows may represent queued messages.
- Clear the pending record before the first keystroke. A partial sequence can be re-armed; a second
  injection can submit a duplicated goal.
- `sentAt` gates injection. Never type a goal for a message that did not send.

## Capability union

A session's tools use separate console and daemon capability sources. The MCP reads both before
creating `McpServer`. The console source has a 14-day TTL and 500-device cap; the daemon source has
no TTL.

- **`/capabilities` keeps sources separate:** `console` and `daemon` are disjoint sections, and the
  answer carries nothing beside them. `known: false` means no report; `known: true` with an empty
  list means affirmative none.
- A daemon declaration counts only after the `HOST_WS_TOKEN` gate.
- Offline fallback is the last answer that actually arrived. `GATED_CAPABILITY_IDS` drives both
  gates; the daemon id is pinned separately.
- **Always-on instructions carry names, not guidance:** The harness caps `capabilityInstructions` and
  silently truncates long guidance; `switchboard_capabilities` serves guidance per call.
- That tool answers from the startup snapshot. A fresh read may warn about drift but must not
  describe tools absent from the session.
- A running session's tools do not change until its next start.

**File map:**

- `src/shared/capabilities.ts` - capability ids, guidance, daemon declarations, source folding.
- `src/gateway/console/capabilityStore.ts` - durable console capability reports.
- `src/gateway/daemonCapabilities.ts` - daemon capability reports.
- `src/mcp/capabilities.ts`, `capabilitiesTool.ts` - startup gating and guidance serving.

## Android app

- **Plugin framework** (`android/.../plugins/`): the registry owns plugin claims and sweeps them when
  a plugin is disabled. `threadDockSlots` stays outside the caught-dispatch path, because Compose
  values cannot cross a non-inline lambda.
- **Inbound pipeline:** handlers receive wire fields and file names, never file bytes. Subscribers
  run synchronously before persistence commit.
- **Plane acknowledgement** (`ChatRepository.applyPlane`): a plane version is noted only when the
  answer is true. The presence plane applies its payload; the board and vault planes carry a
  revision and answer true only once the held revision has reached it, so a list that failed is
  offered again; the fetch behind an unacknowledged plane runs at most once a minute.
- **Plugin retract** (`PluginHost.onRetract`): a plugin that holds state outside the registries
  drops it here when it goes off; the vault clears its pending requests.
- **Row re-render** (`ThreadRenderer`): any changing row payload must enter its fingerprint. JS
  bridge state mutates in place and intentionally does not.
- **Presence authority** (`Presence.kt`): the gateway's own presence is pushed; other machines are
  discovered by `/discover`. A bare presence value does not reveal which channel produced it.
- **Owner facts** (`ChatState.owner`, `PresenceOps.applyOwnerFacts`): the Router states the owner's
  Domain id, display name, and admin Domain on the presence projection. No session row carries
  them. A live projection updates the stored display name. A restored cache shows the stored name.
  Renames arrive in projections. The phone does not write them locally. `canDeleteOwnDomain` is
  false until the facts arrive.
- **Presence residue** (`presence-authority-residue.test.ts`): `status` is private, `Presence`
  construction is private, and consumers use authority-bearing members such as `isLive`, `isOnline`,
  `mayHavePane`, `authoritative`. Do not restore writable status strings.
- **Action receipts** (`ActionReceipt`): local actions are receipts, not status overrides. Evidence
  retires a receipt; it never loses to an optimistic local value. Receipts are scoped by `opId`.
- **Presence TTL** (`PresenceTest`): must exceed one discovery interval, or a slow cold boot expires
  before discovery speaks.
- **Unreachable presence:** do not peek a row marked `UNREACHABLE`. Failed peeks repeat until
  `failCount` backs off.
- **Non-authoritative presence:** probe once per terminal mount. Polling is not evidence.
- **Working and needs-login** (`ChatState.working`): presence first, local peek only as fallback.
  Foreground re-declares screen focus so an open thread does not stay at background cadence.
- **Session card rungs** (`SessionCardPreview.kt`): the session's own reply supplies the headline;
  the owner's row never does. Each rung carries its own row time; ordering uses `lastActivity`.
- **Card board branch** (`cardBranchOf`): retain the root and a window around the current entry;
  collapse contiguous finished runs. A prefix of finished titles can hide the active entry.
- **Unfinished gateway enrollment** (`PendingEnroll.kt`): admission is persisted before POST and
  before delivery. Resume only with the saved bundle and the arming it was sealed against; a 404
  requires re-arm and re-scan.
- **Terminal copy** (`TerminalCopy.kt`, `TerminalAnsi.kt`): trim only trailing cells with neither
  background nor reverse. Painted trailing cells are content. Join only a single whitespace-free URL
  with a scheme.
- **Terminal padding** (`shared/pane-trim.ts`, `TerminalCopy.kt`): trimming occurs at capture and at
  render because daemon and console updates are independent. Keep `-J`; it preserves spaces and joins
  tmux-wrapped rows.
- **Designer plugin** (`plugins/designer/`): owns design cards, live content-keyed rendering, and
  per-team `DesignStore`.
- **Policies tab** (`PolicyOps.kt`, `policies/`): one group per Gateway, read on tab entry and
  after every mutation, never held. `policyList` answers listed, refused or unreachable; a refusal
  hides that Gateway's group, unreachable keeps what was drawn, and the fence drops a stale read.
  The editor's draft lives in `PolicyOps` keyed by gateway and id; `PolicyDraft` holds every
  decision the editor makes (the per-field refusals, a typed example, the id, the rebase a "Save
  over revision N" tap performs). The binding picker offers only entries with a value that
  `allowedOn` that Gateway. A row's toggle and a routine's carry the row's revision and show the
  gateway's refusal under the row until a toggle of that row lands.
- **Files tab** (`WindowOps.kt`, `WindowRules.kt`, `WorkspaceNav.kt`, `workspace/`): one session's
  workspace, read through the plugin that holds it. The tree, an outline, a symbol's detail and the
  open windows sit behind one Back stack in `WorkspaceNav`. Everything is keyed by SESSION, not by
  Gateway: two sessions of one Gateway hold different workspaces. Reads are re-read rather than
  cached, as the other per-Gateway tabs do; the exceptions are the open windows, their drafts, and
  one cached file per module for the lines around a window.
- **Window identity** (`Window.incarnation`, `WindowOps.apply`): held state has one road in, which
  hands a transform what is held NOW. A window carries an incarnation minted at open and the set
  carries an epoch that moves on every close and on a re-provision. Work that began before either
  reads it at the start and lands nothing if it moved, since a symbol id names which span and not
  which opening of it. Without this a foreground re-check begun before a close and reopen applied
  its answer to the window that replaced the one it read.
- **Read slots** (`ReadSlot`): a fence key names what a read FILLS. One key per session made a
  symbol's source and its knowledge cancel each other, and the sandbox could not show it because it
  never suspends. A read that fills a per-module cache is not fenced at all, since there is nothing
  an older answer could overwrite. `separated` escapes each half rather than refusing one holding
  the record separator, because a Lexicon symbol id can carry one and a workspace file does not get
  to decide whether the tab crashes.
- **The foreground sweep is not fenced** (`WindowOps.recheck`): the fence hands a key to whoever
  claimed last, so a sweep would discard the Refresh the owner just tapped and answer them nothing.
  Each window instead carries the hash it held when its read began, and an answer arriving at a
  window that has moved past it lands nothing. A content hash gives no ordering, so a sweep answer
  that was genuinely newer is dropped too; the next sweep picks it up.
- **Awaited answers land through `landUnmoved`** (`WindowStamp`): the window's incarnation and the span
  hash the work began from. The sweep and the save both land there, so a road added later cannot bring
  half the guard. The open keeps the epoch, and Refresh lands by incarnation alone, since the owner's tap
  is newer than anything.
- **Save** (`WindowOps.save`, `afterSave`, `saveNotice`): the right-hand button beside Agent Apply writes
  each edited span verbatim through `workspace_save_span`, which lands only while the span still hashes
  to what the owner was shown. Each window is read again at its turn, so one closed during an earlier
  span's save is not written. The answer lands by the refresh rule: saved takes the span as it now stands
  and keeps typing that arrived during the save, stale raises the banner with the typing kept, and a span
  the save deleted closes its window. `unknown`, which is any save that may have landed without saying
  so, and a save whose span was not read back, re-read their windows. A save into an agent's open
  refactor says so in the notice, since that session can still undo it.
- **Window drafts** (`WindowDraftStore.kt`): one file per draft under `filesDir`, write-then-rename,
  keyed by a hash of session and symbol id. Not the runbook store, which serialises a whole library
  into one preferences string on every commit. A failed rename leaves the previous draft; deleting
  first to make room is the one order with a window holding neither copy.

  **The disk follows the value, and no caller names a file.** `WindowOps.apply` diffs the winning
  before and after by incarnation and tells the store what each file should hold, under the same
  monitor as the state write. Callers used to save and clear for themselves and the two copies
  desynced twice.

  **The store owns its own ordering.** One worker drains one queue, reads included, so a clear asked
  for after a save cannot be overtaken by it whatever dispatcher it runs on. A job that throws is
  caught, since a dead worker would silently push every later write onto the caller, which for a
  keystroke is the main thread. A cancelled scope shuts the queue, and work handed over after that
  runs on the caller rather than waiting for a worker that has gone.

  **A refused write reaches the log.** Every road answers the same way: the write, the read, the
  clear and the re-provision wipe all report rather than reading as a success. The owner sees nothing
  on a release build, which is on the board.
- **A ref's exits into the Files tab** (`WorkspaceOpenBus`, `exitsFor`): a snapshot's viewer offers the
  outline and, when the ref resolved to a declaration, its editable span. The request is HELD rather
  than emitted, since a ref opens over a thread and the thread replaces the tab row, so nothing that
  acts on it is composed when it is made. Three readers take it as each mounts: the shell leaves the
  thread, the tab row scrolls, and the tab shows the place and clears it, naming the request it showed.
  A request waits while the roster is unknown, shows on the session it named, and is dropped once the
  roster says that session is gone, so it never rides the session picker's fallback into another
  project. `docs/references.md` holds what a ref carries.
- **Unread tracking** (`ReadAnchor.kt`, `thread.js`): anchors match inbox rows by epoch and
  sequence equality. Reads drain by scroll position.
- **Idle pushback** (`IdlePushbackManager.kt`): owns aligned `AlarmManager` wakeups.
- **Playback requests** (`PlaybackRequests.kt`, `SttsPlayer.kt`): registry state mints and queues
  each event under the same lock as its transition. `PlaybackResidueTest` owns the single-mint
  boundary. Warm-up holds no claim and purge reaches it through the epoch.
- **Playback queue** (`PlaybackQueue.kt`, `PlaybackOps.kt`): yielding requests stand down when sound
  is taken. `advance` installs the next head before returning it; declining that handoff strands the
  entry.
- **Spoken markers** (`ChatRepository`): chime, sentinel, and body remain separate requests. Match
  terminals by returned request identity, not by current queue entry. Cache by spoken words, not
  entry alone. Resume does not re-announce parked markers.
- **Playback surfaces** (`SttsTransport.kt`, `QueueBubble.kt`, `QueueSheet.kt`): read repository
  state after queue settlement, not raw playback events. The bubble stays on Views because a Service
  lacks Compose's ViewTree owners. The board header is the third access path when notification and
  transport permissions are denied.
- **Abandon semantics** (`SttsPlayer.abandon`): callers declare whether position survives; there is
  no default. Markers and settings samples are never resumable.
- **Audio focus** (`SpeechFocus.kt`): a focus-induced pause retains the request and duckable loss
  keeps speaking. A refused focus request registers no listener. Becoming noisy is a route change,
  not focus loss.
- **Transport pause** (`transportPaused`): normalize in the getter so an idle queue cannot expose
  paused state.
- **Attachment viewer** (`AttachmentDisplay.kt`, `AttachmentViewer.kt`): choose the viewer stage by
  actual decoder capability, not MIME prefix. WebView and `BitmapFactory` disagree in both
  directions.
- **Zoom math** (`ZoomMath.kt`): derive limits per image and sample size; the layer scale is not the
  displayed zoom percentage. Emulator coverage is required for the 100% one-to-one seam.
- **Text preview** (`TextPeek.kt`): classify with `CharsetDecoder`. `String(bytes)` substitutes
  U+FFFD and makes binary data look textual.
- **Save targets** (`SaveTarget.kt`): SAF and MediaStore are separate paths. Revalidate stored
  grants; only a missing folder returns to the picker.
- **Composer drafts** (`Draft.kt`, `DraftStrip.kt`): drafts are per-team store state. File tiles key
  by file, not position. `Draft.locations` preserves source metadata and every writer must copy it.
- **Thumbnail sizing** (`ImageThumbs.kt`): bound both short and long edges. Extreme aspect ratios
  otherwise decode at full size.
- **Scheduled send** (`ScheduledSend.kt`, `ScheduledSendOps.kt`): one record per team, held by the
  Router. The local record is an intent until the Router accepts it: the drain uploads its files,
  posts `schedule_send` under the record's own op id, and stamps the accepted version. The Router
  fires it and writes a `scheduled_result` row, which the phone echoes into the thread. A cancel of
  an accepted record is an intent too, re-posted until answered; a reschedule is a fresh intent
  naming the version it replaces. Every transition runs under one mutex beside the ops class.
