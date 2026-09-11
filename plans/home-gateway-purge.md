# Questionaire

Owner's direction, verbatim:

> Home Gateways are a relic of the past. It should have died when you completed the router plan.
> Still everywhere for some reason. All Gateways are now equals. The router needs to be the
> centralized node between them. Plan a very thorough purge of the old behavior. And while scoping
> the codebase out, also look for other anti-router non-centralized behavior that seem like legacy
> behavior. BTW I'm the only user, so clean break preferred. No legacy landmines for the legacy
> removals.

## Question 1 - When the Router is unreachable, what authority remains?

Q: When the Router is unreachable, what authority remains?
A: Central truth, cached read-only. The phone shows what it last saw, marked stale. Membership,
share and blob mutations wait; no Gateway takes them on. Gateways keep local sessions running and
hold produced attachments in retry staging until the Router returns.

> A.

Recommended because one authority survives an outage without erasing what the owner was looking
at, and because the alternative of temporary Gateway authority rebuilds the thing being purged.

## Question 2 - Which of the found classes ride this plan?

Q: Which of the found classes ride this plan?
A: The purge plus Router-held blobs plus Gateway-specific pairing, as two green tracks. Track one:
the membership registry, the relic's six jobs, owner facts off the Router, the Sessions tab, blobs
Router-first with a staging-then-publish contract, the two dated shims, the protocol floor, docs.
Track two: pairing on a Gateway the owner picks with the choice persisting for that pairing's life,
`requesterGatewayId` off the wire, the Router pushing share and unshare to Gateways, shares limited
to paired Gateways' sessions. Domain-level trust with Router-held content keys is its own later plan.

> A

Recommended because purge-only is not a clean break (deleting `homeGatewayId` forces the pairing
choice anyway, and attachments still need a holder rule), and everything-at-once is three plans.

## Question 3 - What happens to the bytes and state the old road holds?

Q: At cutover, what happens to Sakura's 204 held blobs (86 MB), the phone's stored home id, a
pre-split runbook store, and protocol-1 registrations?
A: Clean break with a one-time migration the agent runs at deploy. A script pushes Sakura's held
blobs into the Router before the Gateway blob road is deleted, then the script is deleted. Nothing
migration-shaped lives in the app. The phone wipes its home id and any list-form runbook store on
upgrade. Protocol-1 registrations refused.

> Clean break with one time migration that you do

## Question 4 - Do scheduled sends become Router-first at acceptance?

Q: The refinement lap found that a one-hour staged blob and a thirty-day local schedule cannot
coexist. Do scheduled sends become Router-first at acceptance, in this plan?
A: Yes. The local row is a pending intent until the Router accepts `schedule_send`.

> Yeah scheduled send would have to be Router first now doesn't it?

# Research log

Read by hand before the fan-out. Symbols by name. Hypotheses marked (H) are for the fan-out to
confirm or refute.

## Where `homeGatewayId` lives

Phone only. Not one hit under `src/`. Twenty four Kotlin files, eleven tests, three docs.

Selected by `ConnectCoordinator.adoptHomeGateway` and `selectHomeGateway`: keep the stored id while
the keyring admits it, else `admitted.firstOrNull()`. Persisted under `AppStateStore.KEY_GATEWAY_ID`.
First written by `OwnerFacts.admitGateway` (the first Gateway the owner admits) and on a joining
device by `DeviceApprovalOps` from `ConsoleTransport.gatewayId` in the sealed join bundle. Reset to
empty by `provision`. Sandbox picks it off the first seeded team.

The owner runs one Gateway today (`Sakura`). Every defect below that needs two Gateways is latent,
and goes live on the second.

## The six documented jobs, as the code actually does them

1. **Unqualified names.** `parseTarget(x, localDomain(), homeGatewayId)` in `canonicalTarget`,
   `fromCanonical`, `closeTab`, `SelfMigration.target`, `wakeTargetOf`, `relaunchSession`, `forget`,
   `RenameOps.rename`, `spawnTargetKey`, `ConsoleClient.sessionAddressOf`,
   `ConsoleRouterTransport.targetGatewayOf`. The phone MANUFACTURES the bare form itself:
   `CreateDialogTarget.targetFor` emits a bare project when `isLocal`, which is `key.gatewayId ==
   homeGatewayId`. Thread keys are canonical already. (H) The create dialog is the only producer of
   an arity 1 or 2 target on the phone. `RenameOps` treats only home as local (`setOf(home)`) while
   `forget` treats every keyring Gateway as local: two readers, two answers.
2. **The phone's own address.** `thisDeviceAddress` = `Address.local(domain, home, ownerKeyId,
   claude)`. Read once, in `PollDrain.processEntries`, to decide whether a conv row is addressed to
   this device. The Router never uses it: the owner's inbox address is `owner:<domainId>/<ownerSignPub>`
   (`inboxCore.ownerAddress`). Each Gateway mints the owner's from-address with ITS OWN id
   (`addressing.consoleSelfAddress`, used by `routesSend` for owner ingress), so the owner has one
   address per Gateway on the wire and the phone recognises one of them. (H) A row minted by a second
   Gateway with the owner's self address as its conv address is misfiled.
3. **Domain id off the roster.** `rosterDomainId` runs after `reach.domainId` was already learned;
   the Router's `onReach` names the admitting Domain for any signed console. (H) Dead since
   `086d0bcc`. Beside it: `localDomain()` empty maps to `LOCAL_DOMAIN_SENTINEL` in `parseTarget`, and
   `teamInfoToTeam` falls back to the sentinel when `TeamInfo.domainId` is absent ("arming mode"). (H)
   Neither is reachable on the Router path any more.
4. **Cross-Domain trust.** `crossDomainRequest` sends `requesterGatewayId = homeGatewayId()` and
   routes the op through `defaultGatewayId()` = home, as do all eleven cross-Domain ops. The gateway's
   `crossDomainHandshake.request` stamps `this.self.gatewaySignPub` and `gatewayBoxPub` regardless, so
   (H) the field is redundant with the executing Gateway. The link itself is Gateway-pair keyed
   (`signMyLink` takes `peerGatewayId`, `peerSignPub`, `peerBoxPub`) while the Router holds an
   owner-signed Domain-to-Domain `XDomainLinkEdge`. Two trust systems. `shareableSessions` is the last
   visibility filter and it moves with the share op.
5. **Runbook library shim.** `RunbookManager.UNPLACED`, dated "Remove after 2026-11-01". Any
   `commit` writes the Map form, so (H) an owner who has synced since the split holds nothing under
   `UNPLACED`. Delete.
6. **Board blob destination.** `blobGatewayFor` falls back to `boardGatewayOf(null)` = home. Added by
   the last plan. See the blob finding below; the fallback dies with the holder concept.

## Other non-centralized legacy found

- **Blobs are Gateway-held.** The phone uploads through `BlobPut` value ops to `targetGateway ?:
  home`; message attachments always name home as holder (`ConsoleClient.send`, `ChannelFile.blobGateway`);
  board attachments record `BoardStateAttachment.blobGateway`; reads go to home with `fromGateway`,
  and the Gateway fetches across Gateways through the Router's `blob_fetch` (cache, then origin). The
  Router's held store exists (`referenceHeldStore`, `blobLease`, `routerBlobCache`) and
  `blobUploader.ts` is unwired; the doc says upload frames are refused "until blob sealing is
  designed", yet `sealed-blob.ts` and its Kotlin twin exist. Partial framework. The clean shape is
  Router-held sealed blobs and no holder id on any wire shape.
- **Cross-Domain trust is Gateway-pair keyed** while the Router holds Domain-level edges and the
  share records. Eleven console ops that the Router could answer as owner ops go phone, home Gateway,
  Router. A friend Domain with two Gateways a side means N by M links. Own plan or this one: a question.
- **Owner facts read off a Gateway's team row.** `refreshDisplayNameFromTeams` (display name),
  `isAdmin` (`isAdminDomain`), `rosterDomainId` (Domain id). The Router holds all three: Domain meta
  reaches the gateway through `onDomainMeta`, the admin Domain is `store.adminDomainId()`, and the
  reach answer names the Domain.
- **"Empty gatewayId means home", nine times.** `teamInfoToTeam`, `keepPriorRow`, `groupByGateway`,
  `rosterDomainId`, `refreshDisplayNameFromTeams`, `isAdmin`, `shareableSessions`, `boardGatewayOfKey`,
  `boardAssignTargets`. `TeamInfo.gatewayId` is `z.string()` "Always stamped by the gateway" and the
  Router keys every row by the registration's id. A defence against a wire state that cannot occur,
  copied by hand.
- **Membership has two sources.** `admittedGateways` comes from the phone's keyring parse
  (`Keyring.admittedGatewayIds`); the Router's presence roster and `onGateways` also name the set.
  The last plan made `state.admittedGateways` the authority for the tabs and recorded the defect
  class ("a model goes plural while a reader beside it stays singular") on the board without building
  the owner. `GatewayReadFence`, `GatewayPick`, `GatewayRoutines`, `GatewayRunbooks` are per-tab
  plumbing that a `GatewayRegistry` would own.
- **The Sessions tab draws home first and unlabeled**, and `isLocal` is what makes the create dialog
  emit a bare target. Equals means every group labeled and one sort rule.

## Legitimate and staying

Gateway-side bare-name resolution (`consoleTargets`, `addressing`): "bare means this Gateway" for a
session on that Gateway. Gateway-local, not home. Whether the gateway must still accept a bare target
FROM THE CONSOLE after the phone stops sending one is a clean-break question.

# Synthesis of the ten audits

Ten Codex Luna audits, 2026-09-09 22:03. Claims below were re-verified against the code where a
plan step depends on them. Hypotheses from the research log that the audits refuted are marked.

## What the audits refuted

- **Two-Gateway misfiling of owner rows (H, job 2).** Not on the local road: `consoleSelfAddress` is
  only ever a from-address, and sent echoes key on the target session. The one producer that can
  mint a conv row AT the owner's per-Gateway address is `routesRespond` mirroring a reply to an
  asker that was the owner's self address, which arises only when the owner sent through a Gateway
  to a foreign target. Unverified whether `consoleSender` suppresses it. Either way the phone-side
  equality dies; whether a `thread` discriminator replaces it is a phase decision, not a question.
- **`requesterGatewayId` is redundant (H, job 4).** No: the receiver commits it into the SAS and
  `confirm` compares the signed link against it, while the executing Gateway stamps ITS OWN keys and
  never checks the id against itself. A phone can name Gateway B while Gateway A's keys sign. That
  is a landmine, and the fix is the Gateway stamping its own id, not the phone sending one.
- **The Router refuses gateway blob uploads.** No: `gatewayBridge` registers `blob_begin` and
  `blob_chunk` as gated value frames. `docs/federation.md` and the comment in `blobUploader.ts` are
  stale. The phone already reads the Router cache first (`AttachmentOps.fromRouterCache`). What is
  missing is an OWNER-op upload and the Router as the sole store.
- **Empty `gatewayId` cannot occur (H).** Live writes cannot produce one (`ownedRow` overwrites it
  with the registration's), but `TeamInfoSchema.gatewayId` is `z.string()` without `.min(1)` and
  `rowsFor` re-serves persisted rows without reparsing. The nine `ifEmpty { home }` copies defend a
  state the schema permits. Fix the schema, then delete the copies.
- **`rosterDomainId` is dead (H).** Nearly: reach names the Domain for an admitted signer, and on
  the first connect the roster is empty anyway. It cannot answer where reach did not. Delete it and
  make reach's Domain answer required for an admitted console.
- **The create dialog is the only bare-target producer (H).** Confirmed. Stored keys are already
  filtered to arity 4 on load (`ChatPersistence.isAddressKey`), so no on-disk data is bare.

## Findings by class, ranked by what becomes inexpressible

**A. The relic itself.** `homeGatewayId`, `KEY_GATEWAY_ID`, `adoptHomeGateway`, `selectHomeGateway`,
`sandboxHomeGateway`, `ConsoleClient.defaultGatewayId`, `ConsoleTransport.gatewayId` in the join
bundle, the nine `ifEmpty { home }` readers, `thisDeviceAddress`, `rosterDomainId`,
`RunbookManager.UNPLACED`. Each job's replacement:

1. Names. `CreateDialogTarget.targetFor` always qualifies. Phone `parseTarget` loses its local
   context arguments and refuses arity 1 and 2, with the Kotlin twin and the shared vectors moved
   with it. `canonicalTarget`, `fromCanonical`, `closeTab`, `wakeTargetOf`, `relaunchSession`,
   `forget`, `SelfMigration.target`, `sessionAddressOf`, `targetGatewayOf`, `spawnTargetKey` take a
   qualified target. `RenameOps` locality reads the keyring set like `forget` does. The gateway's
   console door refuses an arity 1 or 2 target from the CONSOLE; the MCP door keeps gateway-local
   resolution.
2. Own address. Deleted with its one reader. See the refutation above for the residue.
3. Domain id. `rosterDomainId` deleted. Reach's Domain answer required for an admitted signer.
   `TeamInfo.domainId` and `GatewaySpawnPoints.domainId` required. `LOCAL_DOMAIN_SENTINEL` deleted
   on both runtimes: the gateway builds address-minting routes only on activation, and arming stays
   the enrollment window it is.
4. Cross-Domain. See C.
5. Runbook shim deleted. `LegacyCapabilitiesSchema` in `src/mcp/capabilities.ts` carries the same
   date and goes with it. Protocol floor raised to 2 and the `unsupported` road deleted.
6. Board blob destination dies with B.

**B. Gateway-held blobs.** Router-held sealed blobs, phone uploads by owner op, Gateways fetch from
the Router only and upload their own sessions' outputs through the frames the bridge already
accepts. One Router store, no `origin`. Dies: `ChannelFile.blobGateway`,
`BoardStateAttachment.blobGateway`, `fromGateway`, `stampBlobHolder`, the gateway `/blob/*` routes
for attachments, `BlobStat`, `BlobPut`, `BlobGet` value ops, the `blob_fetch` gateway frame and its
reply, `blobGatewayFor`, `boardGatewayOf`, `boardGatewayOfKey`, `BoardStore.loadGatewayId`.
`BoardRows.GroupKey` becomes the entry's own session triple. Router deploys first.

**C. Cross-Domain trust.** Two systems: Gateway-pair signed links holding Gateway keys, and the
Router's owner-signed Domain edge plus share records. In this plan: the Gateway stamps its own id
into the pairing and the wire field goes; the five pairing ops run on a Gateway the owner picks;
share and unshare and list-shares post to the Router's existing owner ops directly and Gateways
learn from the Router's push; untrust fans out; `shareableSessions` offers every admitted Gateway's
sessions. The redesign to Domain-level trust with Router-held content keys is its own plan and
depends on B.

**D. Owner facts off a Gateway row.** `displayName` and `isAdminDomain` leave `TeamInfo`;
`OwnerPresenceProjection.owner { domainId, displayName, isAdminDomain }` carries them. `isAdmin()`
reads state. `refreshDisplayNameFromTeams` deleted. `Users.kt` stops remembering `isAdmin()` once.

**E. Membership.** One repository-owned `GatewayRegistry`, fed by the Router's presence roster
(admitted, connected, incarnation, coverage), holding per-Gateway projections and read fences. The
keyring stays the cryptographic admission source that no screen reads. Replaces `admittedGateways`,
`connectedGateways`, `gatewaySpawnPoints`, `routines`, `runbooks`, `GatewayRoutines`,
`GatewayRunbooks`, the `*On` extensions, `soonestRoutineAt`, `refreshAll(ids)`,
`refreshConnectedGateways` and the phone's `/gateways` reader. This is the board item's fix.

**F. Sessions tab.** Every group labeled (own Domain by Gateway id, a peer by domain/gateway), one
sort (own Domain first, then id), `showCreate` = admitted, `isLocal` gone.

**G. Words.** `docs/console.md` six-jobs section deleted, `docs/architecture.md`, `docs/testing.md`,
`AGENTS.md`, the harness's `home: DomainPeer`, two test names, the `spawnTargetKey` comment block,
`docs/federation.md` blob line, `docs/task-board.md` holder paragraphs.

**H. Adjacent legacy, optional.** `sealTargetFor` bare-string fallback becomes a refusal. Undated
compat readers: `AppStateStore.loadRouterState` legacy slot, `ChatPersistence.loadPersistedDrafts`
pre-Draft rows, `SttsCache.purgeLegacyCacheOnce`, `channelDelivery` ack-less listeners,
`handshakeGate` textual claims.

## Sol's corrections, verified

- **Job 2 is a live bug, and the phone's home address is what hides it.** `routesRespond` runs the
  peer-mirror block for every reply, including an owner-anchored one (`reply.kind == "owner"`),
  where `deliverResult.from` is the owner key id. `tryLocalAddress` turns that into
  `domain.<gw>.<ownerId>.claude`, a session that does not exist, and `mirrorPeer` writes one or two
  `peer` rows keyed on it. `PollDrain` recognises the phantom only by comparing it with
  `thisDeviceAddress`. Same on a cross-Gateway response returning through `gatewayRelay`
  (`trustedInbound`, not `consoleSender`). Fix: run the mirror block only for
  `reply.kind == "conversation"`, then delete `thisDeviceAddress` and the comparison. No wire change.
- **`blobUploader` is wired**, not unwired: `routesHumanNotify` calls `uploadAll(blobIds, "cache")`
  through `cacheBlobs`. The comment is stale. And `deliverToOwner` queues the row BEFORE
  `cacheBlobs` runs, so a row can be visible before its blob is durable. With the Router as sole
  store that is the landmine: blob commit must precede or join publication.
- **The Router's `ReferenceHeldStore` refuses `beginBlob` without a reference**, so sole-store
  publication needs a reservation then commit: stage the upload under a lease, then publish the row
  and bind its refs atomically. Two retention states, one store: staged with a TTL, referenced until
  the last reference goes. The cache tier's defining behaviours (origin fallback, LRU eviction) die.
- **Owner uploads are their own owner ops**, never tunnelled through `gateway_value`, which selects
  a Gateway by definition.
- **`ShareService` pushes frames to Gateways only on unlink.** Share and unshare do not, so
  "Gateways learn shares from the Router" is new Router work, not a routing change.
- **C-small must not widen `shareableSessions` to every Gateway.** Peer keys live on the paired
  Gateway; a Router share record for a session on an unpaired Gateway cannot be transported. Shares
  stay restricted to sessions on paired Gateways, and the pairing choice persists for the whole
  listen, request, state, confirm, cancel lifetime. All-Gateway sharing waits for the redesign.
- **E's registry needs provenance, not just coverage:** `neverLoaded | cached | current`, and
  `admitted + neverSeen` (roster `incarnation` 0) distinct from `admitted + disconnected`.
  `showCreate = admitted` is too broad: create needs reachability and advertised spawn points.
- **E missed the Vault.** `VaultOps.refreshGrantsNow` and `revoke` fan out over
  `ChatRepositoryVaultCollaborators.admittedGateways`, which reads the keyring directly, and
  `VaultEntryDialog` draws scope chips from `state.admittedGateways`. All three move to the registry.
- **A splits.** A.1 is an addressing invariant that moves straight onto the registry. A.2 is the
  bug above. A.3 and D are the same projection change as E. A.5 is cutover hygiene, last. A.6 is B.
  F is a consumer of E.

## Amendments after the Policies work, 8.8.1 to 8.9.1

Another session landed the vault authorization split (`cfb4f591` through `8cf1693e`) while the
questionaire was open. Observed against this plan:

- **A third per-Gateway tab, built the same way.** `PolicyOps.refreshAll(gatewayIds)`,
  `PoliciesScreen` reading `state.admittedGateways` and passing it by hand, drafts and
  `toggleRefusals` keyed by `(gatewayId, id)`, one fence. The class E inventory grows by `PolicyOps`,
  `PolicyDraft` and the tab. Three hand-rolled copies of the membership pattern is the "same bug
  thrice" rule; the registry is now the recorded design fix, not a nicety.
- **Two pieces the registry keeps as they are.** `GatewayReadFence` now answers `Fresh` or `Stale`
  instead of a null that meant two things, and `ConsoleClient.sendValueAnswer` tells a Gateway's own
  refusal from the Router's and from silence (`Answered`, `Refused`, `Undelivered`, `Unreachable`).
  The registry's per-Gateway read outcome is that sealed type, not a new one.
- **The policy store is gateway-held and gateway-local.** A policy answers askpass for sessions on
  that Gateway and binds a Router-held entry `allowedOn` it. Same footing as runbooks and routines.
  Legitimate, stays.
- **No home reader was added.** Still twenty three files. No Router-side change. The askpass
  helper-token road is gone; nothing there named a Gateway by default.
- **One more sentence for G.** `GatewayPick` now says "The keyring leads with home."
- **A dev rule the plan's phases follow.** Every phone iteration goes over adb, never through CI;
  push when the work settles.

Question one is unaffected. Question two's options are unchanged; track one's registry gains the
Policies tab as a consumer.

## Scope sizing, three Codex evaluations

- **Purge plus blobs plus Gateway-specific pairing** is bounded only as two green tracks: the purge
  with Router-held blobs, and C-small on its own. B touches about twenty files across the Router,
  gateway, shared, MCP and phone plus the generated `Protocol.kt` (`ChannelFile`,
  `BoardStateAttachment`, `BlobPut`, `BlobGet`). `ReferenceHeldStore.begin` refuses an upload with
  no reference and its lease never expires, so a staged state with expiry is new. The gateway
  already posts share and unshare as owner ops (`FederationContext.postShareRecord`); the Router
  push of share and unshare to Gateways is the new C-small work, and the Gateway needs an inbound
  handler for it. The phone client has ten cross-Domain methods, not eleven.
- **Purge only** is not a clean break. Deleting `homeGatewayId` at all forces the pairing choice, so
  half of C-small comes anyway, and message and board attachments still need a "pick a holder
  Gateway" rule, which is jobs 4 and 6 under a new name. Refusing attachments on unassigned board
  entries is the only honest interim rule, and it is a restriction the owner would later lift.
- **Everything including Domain-level trust** is three plans. The Router has no Domain content-key
  authority, no capability for a friend Gateway to seal without a Gateway box key, and four
  security decision families are open: edge symmetry, key rotation, revocation reach, and what
  presence a friend sees. Router-held blobs are not a cryptographic prerequisite for it but are the
  dependency for friend-Gateway interchangeability.

## Dependency order

Router-outage semantics first (question one). Then E with A.3 and D as one presence projection
change, F and every home reader moved directly onto the registry, then A.1 and A.2, then B
Router-first with the staging contract, then C-small as Gateway-specific pairing and sharing, then
the dated shims and the protocol floor, then G.

# Plan

Two tracks. Track one is phases 0 to 5, then 7 and 8. Track two is phase 6. `homeGatewayId` dies
in phase 7, after both tracks have taken every reader off it. Every phase ships green on
`bun run lint`, `bun run test`, `./scripts/kotlin-gate.sh`, `bun run check:fixtures`,
`bun run check:boot`, `bun run check:pinning`. A wire change deploys the Router first, then the
gateway, then the phone over adb. Push when a phase settles.

## Decisions taken without a question

- The pairing Gateway is picked from the existing sheet (`NewOnGatewayFab`'s pattern).
- Sessions groups: own Domain labeled by Gateway id, a peer by `domain/gateway`; own Domain first,
  then id.
- Staged blob TTL one hour. A notice's attachment is referenced by its row, so it lives while the
  row does.
- Arming and standalone serve health and enroll only; no address-minting route exists before a
  Domain is active.
- The Router's `/gateways` listing stays only if a residue grep finds a consumer outside the phone.

## Phase 0 - The presence projection carries what the Router knows ✅

Wire, Router-first. Shipped.

- `TeamInfoSchema.gatewayId` `.min(1)`; `domainId` required, non-empty. `displayName` and
  `isAdminDomain` leave `TeamInfo`.
- `GatewaySpawnPointsSchema.domainId` required.
- `OwnerPresenceProjectionSchema` gains `owner { domainId, displayName, isAdminDomain }`.
  `createPresenceService` takes the enrollment display name and `store.adminDomainId()` from
  `ownerServices`. `ownerProjection` builds and versions `owner`. The Router calls
  `presence.refresh` after the first root, `set_display_name`, admission, or revocation. Renames
  and roster changes reach the phone without a Gateway.
- A friend Domain's label moves with it: `CrossDomainPresenceEntry` gains `displayName`, filled
  while `ownerProjection` assembles the linked entries; `CrossDomainLink.mergeLinkedDomains` and the
  Sessions friend header read it.
- `presenceService.rowsFor` runs `TeamInfoSchema.safeParse` on every persisted row before
  projecting. A failing row is dropped and logged with domain, record id, and issue. Quarantine
  handles store integrity, not row shape.
- Gateway: `PresenceFacade.snapshot` and `routesPresence.localSpawnPoints` stamp `domainId`
  unconditionally, and the presence reporter does not start until the federation slice is active.
- `RouterReachAnswer` keeps one shape. The invariant is stated and tested: an admitted signer gets
  a non-empty `domainId`; anonymous or unadmitted gets none.
- Every other `TeamInfo` reader moves with the schema: `presenceExchange`, `routesPresence`,
  `routesStatus`, `bridgeDiscover`, the relay consumers, and their tests. `bridgeDiscover` reads the
  object form of `/discover` only; the bare-array tolerance for an older gateway goes.
- The phone persists the owner's name from a live projection only. `restoreLastProjection` shows
  the stored name, so a cached slot cannot undo an accepted rename.
- `Protocol.kt` regenerated in the same commit; wire fixtures; `router-presence.test.ts` rejects
  empty ids, asserts the whole owner block, and asserts a rename bumps the plane.
- Mixed-version window: the new Router answers `resync` to a baseline or delta from a gateway
  older than the `domainId` stamp, which parks its reporter, and marks that gateway's rows
  unreachable until an upgraded baseline replaces them; a gateway that already stamps `domainId`
  is served, its obsolete fields stripped. An old phone ignores `owner`. Router, then gateway,
  then phone, minutes apart. No optional window.
- `cross_domain_unlink` may push a projection before the enrollment store saves. `rearm` at boot
  recomputes every projection, including links restored after a crash.
- `presence.refresh` is one seam: it recomputes the named Domain and every held Domain whose
  projection embeds it (`dependentsOf`, the reverse of `linkedDomains`, since links can be
  one-sided), and it skips a Domain the Router does not hold, so a revoke against a deleted Domain
  cannot throw after it persisted. The share service's `onChanged` names the Domain whose shares
  moved, on share, unshare, unlink and the expiry sweep. A removal refreshes the survivors that
  embedded the removed Domain. The owner-store registry enumerates Domains from the enrollment
  catalog, so a freshly rooted friend with no rows yet is a dependent, and no refresh reads the
  store directory.
- A plane the phone can read starts at version 1. `planes_read` treats 0 as absent. A fresh
  Domain's owner facts reach the phone before any Gateway registers.
- The phone fails closed on ownership: `canDeleteOwnDomain` is false until the Router has stated
  the Domain is not the admin one, and the Users header reads the name from state, so a rename
  that lands by projection redraws it.

Rules:

- A row the Router serves names its Gateway and its Domain, or it is not served.
- An owner fact is the Router's to state. No session row carries one.

### Bug Classes

- **Mechanism:** owner projection invalidation (`presenceService.pushIfChanged`).
  **Class:** an input to `ownerProjection` changes without recomputing the plane.
  **Rounds:** one, `presence.refresh` after admission and revocation; two, after link and
  revoke-link; three, `onChanged` on the share service; four, `pushIfChanged` recomputes the named
  Domain and every Domain that embeds it, so a trigger on either side reaches both projections.
  Gateway frames, enrollment branches, and share writes still call the seam directly, and a new
  projection input compiles with no trigger.
  **Follow-up, claimed on the board:** add a post-commit event on `OwnerStateStore` through
  `commit`. Dirty the Domain for `presence.row`, `presence.gateway`, and `share` records. Flush the
  dirty set at the end of a gateway frame, owner op, or enrollment op. Add events for display name,
  admin Domain, link edges, and registration.

## Phase 1 - One owner of membership on the phone ✅

- `GatewayRegistry` is one immutable value in `ChatState`, written only by
  `PresenceOps.landProjection` from the projection's roster. Per Gateway: `id`, `connected`,
  `incarnation`, `lastRegisteredAt`, `spawnPoints`, and the projections `routines` (with the zone
  the routine list answered), `runbooks`, `policies`, `peers` (phase 6). Whole-registry
  `provenance: NeverLoaded | Cached | Current` with the plane's epoch and version, and the
  projection's `coverage` copied, not remodelled. Mechanics stay in the ops classes: fences,
  drafts, toggle refusals.
- Transitions: no slot on disk is `NeverLoaded`; `restoreLastProjection` lands `Cached`; an
  accepted live projection lands `Current`. `Cached` draws with a stale mark; a mutation that needs
  membership waits for `Current`.
- The roster already carries an admitted-never-registered Gateway with `incarnation` 0, so
  `admitted + neverSeen` and `admitted + disconnected` are both drawn, and an action needing
  reachability is disabled for both. A freshly admitted Gateway appears with the next projection;
  the admit flow refreshes the plane rather than reading the keyring.
- Replaces `ChatState.admittedGateways`, `connectedGateways`, `gatewaySpawnPoints`, `routines`,
  `runbooks`, `policies`, `GatewayRoutines`, `GatewayRunbooks`, `GatewayPolicies`, `routinesOn`,
  `runbooksOn`, `policiesOn`, `routineOn`, `runbookOn`, `policyOn`, `soonestRoutineAt`.
- Readers that move: `RoutineOps`, `RunbookOps`, `PolicyOps` (`refreshAll()` takes no list, the
  prune reads the registry at prune time), `DrainHost.refreshRoutines` and `plan`,
  `ServiceNotifications.reconcileRoutineNotifications`, `RunbookTargets.spawnTargets`,
  `RoutineEditor`, `RunbookEditor`, `RunbookFireSheet`, `SessionsScreen`, the three tab screens,
  `VaultOps.refreshGrantsNow` and `revoke`, `ChatRepositoryVaultCollaborators.admittedGateways`,
  `VaultEntryDialog`, `SessionOps.forget` locality, `BoardOps.boardAssignTargets`,
  `ConnectCoordinator` and `RepositoryProvisioningHost.refreshAdmittedGateways` (which stop
  publishing membership at all), `ChatRepository` state construction, `MainActivity`.
- `PresenceOps.refreshConnectedGateways`, `PresenceHost.fetchConnectedGateways`,
  `ConsoleClient.fetchConnectedGateways`, and the `connectedGateways` transport fixture in
  `WireFixtureGenerator` deleted. Connectivity is `roster[*].connected` only.
- `Keyring.admittedGatewayIds` is read by nothing outside the keyring's own crypto;
  `SessionHost.keyringGateways` goes.
- Persistence: the registry is runtime state. Durable stays as it is: the runbook library and the
  presence slot.
- The owner's facts use the same provenance: `ChatState.displayName` goes, and `ChatState.owner`
  is the in-memory copy. `ChatRepository.displayName()` reads `owner?.displayName`, then the stored
  boot name, then the Domain id. `applyOwnerFacts` writes the stored name only from a live
  projection. Gates that need the admin fact (`isAdmin`, `canDeleteOwnDomain`) wait for `Current`,
  not `Cached`.
- `GatewayReadFence` (`Fresh` / `Stale`) and `ConsoleClient.ValueAnswer` are the read types;
  nothing new is minted for them.
- Sandbox: `SandboxSeeder` seeds a roster, the three Gateways as today plus a fourth admitted with
  `incarnation` 0 that no `SandboxGateways` port answers for. `SandboxSeederTest` asserts it.
- Tests: `GatewayScopedStateTest`, `RoutineOpsTest`, `RunbookOpsTest`, `PolicyOpsTest`,
  `RunbookTargetsTest`, `PresenceOpsTest`, `PresenceMergeTest`, `ConnectCoordinatorTest`,
  `SessionOpsTest` move onto the registry; a refresh cannot prune a newer membership; a revoked
  Gateway disappears only when a `Current` roster omits it; a never-registered Gateway draws as a
  group with create disabled; `Cached` draws and refuses a membership mutation.

- As built: `GatewayEntry` holds `id`, `connected`, `incarnation`, `lastRegisteredAt`,
  `hostSpawns`, and the nullable answers `routines` (with `routineZone`), `runbooks`, `policies`;
  null means the Gateway has not answered, so a tab still tells "could not be read" from "holds
  nothing". `GatewayRegistry.landed` builds the roster from the projection and keeps a staying
  Gateway's answers; `withEntry` is the one write for an answer, and it drops an answer for a
  Gateway the roster does not name. The stored runbook library fills a new entry through
  `PresenceHost.storedRunbooks`. `refreshAll()` takes no list on all three ops classes.
  `RepositoryProvisioningHost.refreshAdmittedGateways` became `adoptHomeGateway`, which keeps the
  home id only; `ChatRepository.keyringGateways` is read by it and by `ConnectCoordinator`.
  `hostSpawnChoices` takes one Gateway's `hostSpawns`. `GatewayRegistry.reachable` is the one
  rule for an action that needs membership: the roster is `Current` and the Router holds that
  Gateway's connection. Create on the Sessions tab, `NewOnGatewayFab` (which takes the registry),
  board assignment targets, and the journaled forget read it; `VaultOps.revoke` and
  `canDeleteOwnDomain` wait for `Current`; `GatewayHeader` marks `Cached` as stale. A record action
  on an answer already drawn (run, fire, save, toggle) names its Gateway and lets the Router refuse.
  An accepted owner fact pulls the presence plane. `landProjection` trusts the slot's version check
  and keeps no wall clock of its own. `ConsoleClient.fetchConnectedGateways` and its wire fixture
  are gone. The sandbox seeds a `GatewayRegistry` built by `sandboxRegistry`, with `shelved` as the
  never-registered one; the seed is the one write outside `landProjection`. `landed` keeps a
  Gateway's answers only at the same incarnation, and the three tabs key their re-ask on
  `incarnations()`, so a restarted Gateway is re-read. `keepPriorRow` takes the projection's
  Domain only: every own-Domain row is the projection's to drop, and a friend Domain's rows keep
  their last state. A tab on a `NeverLoaded` roster says so rather than "no Gateway could be
  read". `AppStateStore.clearProvisioning` drops the Router slots with the Domain, so a new Domain
  cannot restore the old one's roster as `Cached`. `applyOwnerProjection` compares nothing: the
  plane cursor in `PollDrain` decides through `foldVersionedSlot`, and the land rewrites the slot,
  so an unchanged Router's plane after a restart promotes the restore and repairs a slot the phone
  could not read. `restoreLastProjection` runs once per provisioning and every caller awaits it.

Rules:

- The keyring says who may sign. The Router's roster says who is a Gateway on this phone. No
  screen reads the first.
- A membership list is never a parameter.
- `NeverLoaded` is not an empty roster.

### Bug Classes

- **Mechanism:** the versioned presence plane's comparator, on both ends.
  **Class:** a plane the reader should land is hidden by a version compare that only asks "newer".
  **Rounds:** one, the Router's `projectionPlane` started at version 0, which `readPlanes` hides
  behind `version > known`, so a first projection never left the Router; two, the phone's
  `applyOwnerProjection` refused a live plane equal to the slot, so a restart on an unchanged Router
  held the roster at `Cached`; three, an unreadable slot was matched by version and never
  rewritten, so one schema change to the projection killed the cached roster on every later boot.
  Each round patched its own end. The comparator answers only "newer"; nothing says what a reader
  does with "same" or "unreadable", and `newerRouterState` answers true for any epoch difference
  in either direction, although an epoch is a random tag, so a plane from a lost epoch still in
  flight lands over the minted one as `Current`. A third reader of a versioned slot (the board and
  vault revision planes read the same shape) can repeat all of it.
  **Follow-up:** `architecture-fan-out`, whether a versioned-slot reader should be one fold on the
  phone (`versioned-list.ts` already names it for lists) that takes same, unreadable, and
  unrelated-epoch as inputs. In the same pass: `Current` is minted and never demoted, so
  `reachable` reads a roster the phone may not have verified since it lost its link; decide
  whether provenance expires on link loss or the consumers say "last known" instead.
  **Decided (architecture, lap 2):** the Router's console planes carried a bare integer, so
  every reader between the socket and the fold compared integers and "unrelated lineage" had no
  representation; the presence plane saw its epoch only because the payload repeats it, and the
  board and vault planes had none. The lineage `{epoch, version}` now crosses the wire on
  `planes_read`'s `known`, `PlaneRead`, the welcome's `versions` and the `plane` frame, one
  Domain epoch shared by the three planes. `foldVersionedSlot` (`src/shared/versioned-slot.ts`,
  `VersionedSlot.kt`, `tests/fixtures/versioned-slot/vectors.json`) is the one reader rule:
  within a lineage the Router's version orders, across lineages the reader's own observation order
  does, and a durable value carries none, so it takes any other lineage. `PollDrain` holds the
  in-memory cursor and stamps observations at receipt; `PresenceOps.applyOwnerProjection` lands
  and saves without comparing; `revisionPlaneDecision` folds a board or vault plane against the
  manager's durable lineage, and another lineage drops the held list and fetches from zero. The
  Router mints one epoch per Domain slice (`presenceService.lineageEpoch`) and serves no board or
  vault plane until it is durable. Deleted: `newerRouterState`, `sameRouterState`, the two
  open-coded copies of `mayApplyPlane`'s compare, `revisionPlane`'s `held >= version`, the `0`
  that meant "could not be built", `RouterStateSlotTest` (which asserted the cross-epoch defect as
  intended), and the `ConsoleTransportPlan` fields nothing read. Landed in the Phase 1 commit; the
  class is closed.
  **Deploy:** the wire is a clean break (`known`, `PlaneRead`, the welcome's `versions` and the
  `plane` frame all carry a lineage and nothing optional), as the owner asked. Router first, then
  the Gateway, then the APK over adb in the same sitting: a phone on the old build against the new
  Router loses its plane frames until it updates.
  **Sol's read (lap 3):** two of its four highs were the fence and the throttle above, already
  patched; the other two were a deleted Domain leaving its owner store cached and its console
  sockets bound, reachable only through a Domain id the product never reuses (ids are random and
  the Router refuses re-rooting), closed anyway by `ownerRegistry.evict` and
  `consoleSockets.forgetDomain` on removal. The mediums are recorded as the fold's assumptions in
  `docs/console.md`: 31-bit epochs, no durable rollback, decode-time observation stamps repaired by
  the next welcome or pull, and the presence payload's `plane` matching its `PlaneRead`.

- **Mechanism:** the board and vault managers' generation fence.
  **Class:** an answer begun before a reset lands after it and repopulates what the reset emptied.
  **Rounds:** one, `VaultManager.wipe` bumped `generation` and `applyList`/`applyWrite` refused an
  older one, with no twin on the board; two (Phase 2 lap red team), `adoptEpoch` emptied the list
  under a new lineage while a board read or CAS answer from the old one was in flight, and
  `landed(revision, entries)` re-applied it because the revision compare had been reset to zero,
  after which the phone held the old list under the new epoch and acknowledged the Router's
  version as behind. Patched by bumping the generation on another lineage in both managers,
  `BoardManager` gaining the fence, its `clearInMemory` bumping it as the vault's `wipe` does,
  and `BoardRouterWriter` capturing it before each Router call. The `GatewaySlot` follow-up
  (`bd_9784d356`) is where a per-Router-answer fence becomes one declaration instead of two
  hand-written ones.
- **Mechanism:** `revisionPlaneDecision`'s fetch throttle.
  **Class:** a throttle keyed by plane name alone outlived the lineage it was protecting, so a
  new epoch inside the window waited a minute before its first fetch. One round; the fold's
  `lineageChanged` now skips the window.

### Architecture findings carried forward

- **Per-Gateway answer slot** (`GatewayAnswer<T>` / `GatewaySlot`): `RoutineOps`, `RunbookOps`,
  `PolicyOps` write one read-model projection three times (fan-out, fence, `withEntry`,
  refusals, drafts, `attempt`, empty state) and have drifted (only `PolicyOps` hides a refusal;
  `RunbookOpsTest` has no fence case); vault grants bypass the registry and are never pruned;
  the mechanics keyed `(gateway, id)` outlive an incarnation. Lands before Phase 6, whose `peers`
  projection needs "with the read outcome". Board `bd_9784d356`, claimed.
- **`Current` promises liveness and delivers provenance:** consumers sort into three buckets:
  an action sends and lets the answer say, a display composes provenance with the Router link,
  membership reads `ids()`/`has()`. Needs a `RouterLink` folded by `ConsoleTransportCoordinator`
  from the reach outcomes both transports already produce and discard, published into
  `ChatState`, and a `GatewayStanding` read beside the registry. Lands with Phase 2's Sessions
  tab bullet, which already rewrites `showCreate` and the header's reachable flag. Board
  `bd_f81c19f3`, claimed. Until then `reachable` is documented as what it is.

## Phase 2 - Every home reader the projection or the registry makes redundant ✅

- `isAdmin()` reads `state.owner.isAdminDomain` and `Users.kt` observes it.
  `refreshDisplayNameFromTeams` and `rosterDomainId` deleted; display name and Domain id come from
  the projection and reach.
- `Team.gatewayId` and `Team.domainId` non-empty by decode. The nine `ifEmpty { home }` readers
  deleted. `keepPriorRow(row, planeDomain, covered)`.
- Sessions tab: every group labeled, sorted as decided. `showCreate` = the registry is `Current`
  or `Cached`, the Gateway is admitted and `connected`, and its spawn points are in the
  projection; `hostSpawnChoices` no longer invents `host` for a Gateway with no projection. A
  never-registered Gateway's group draws with its header saying never seen and no create. The
  header's reachable flag reads `connected` and the registry's provenance, so not-loaded and
  offline stay distinct. `isLocal` deleted, `CreateDialogTarget.targetFor` always
  `SpawnPoint.of(domainId, gatewayId, project)`; `GroupByGatewayTest` and `HostSpawnChoicesTest`
  rewritten to the qualified form.
- `RenameOps` and `SessionOps.forget` share one predicate, `registry.owns(target.gateway)`. The
  gateway's `requireLocalComposite` stays the authority; the phone predicate only decides
  optimism and journaling.
- `SandboxSeeder.sandboxHomeGateway` deleted.

- As built: `Team.domainId` is derived from the canonical name, as `gatewayId` already was, so
  no row carries a nullable Domain and `teamInfoToTeam` takes no home id. A thread keyed before
  the Domain was known still parses as the `local` sentinel and reads as own-Domain until Phase
  3. `keepPriorRow(row, planeDomain)` compares the row's Domain alone. `rosterDomainId` and the
  `learnDomainId` call it fed are gone; reach names the Domain, through the `learnDomainId` call
  that stays. The two home reads left in `BoardOps` (`boardGatewayOf`, `boardGatewayOfKey`) are
  job 5, the unassigned entry's blob Gateway, and go with the symbol in Phase 7. `groupByGateway(local, registry,
  adminDomainId)` sections every roster Gateway, own Domain first then by Domain and id.
  `GatewayRegistry.offersSpawn(id)` is the Create rule: the roster is loaded, the Router holds the
  connection, and the Gateway projected its spawn points (`GatewayEntry.hostSpawns` is null until
  it does, and `hostSpawnChoices(null)` offers nothing). `GatewayRegistry.standing(id)` answers
  `Unknown`, `NeverSeen`, `Offline` or `Online`; `GatewayHeader` takes it in place of the reachable
  flag and says "never seen" beside no Create. `CreateDialogTarget.of` keeps only projects that
  qualify on the Gateway and `targetFor` is always `SpawnPoint.of`. `GatewayRegistry.owns(target,
  domainId)` replaces `isLocalTo` for `RenameOps` and `SessionOps.forget`; the forget journals for
  any Gateway the roster names, cached or current. The sandbox seeds `homeGatewayId` from the
  roster's first id.

## Phase 3 - No unqualified name leaves the phone ✅

- The phone gets its own parser, `parseQualifiedTarget(wire)`: arity 3 or 4, nothing else, with
  its own vectors in `tests/fixtures/session-id/` and its own `SessionIdVectorsTest` cases. The
  gateway keeps `parseTarget(wire, localDomain, localGateway)` and its vectors. Two contracts, two
  names; the phone's `parseTarget` is deleted.
- Every phone caller takes a qualified target: `canonicalTarget`, `fromCanonical`, `closeTab`,
  `SelfMigration.target`, `wakeTargetOf`, `relaunchSession`, `forget`, `spawnTargetKey(target)`,
  `ConsoleClient.sessionAddressOf`, `ConsoleRouterTransport.targetGatewayOf` (becomes
  `gatewayOf(target)`, no default), `Team.localFieldOf`, `Team.gatewayOf`, `teamInfoToTeam`,
  `ChatState.sessionLeaf`, and the test callers. `ChatPersistence.isAddressKey` becomes a direct
  arity-4 check over the qualified parser.
- Indirect carriers audited and asserted qualified: notification extras (`ServiceNotifications`,
  `NotificationReceiver`, `MainActivity.consume`), `ScheduledSendOps`, `GoalOps`,
  `RunbookFireSheet` targets, `ThreadScreen` navigation.
- `Address.local` deleted from the phone twin; `SpawnPoint.of` and `Address.of` stay.
  `LOCAL_DOMAIN_SENTINEL` leaves the phone: `localDomain()` is `ready().domainId` or the caller
  does not run; `teamInfoToTeam` takes the required Domain from the row.
- Gateway: `createRoutes` takes a non-null `localDomainId`, the sentinel goes from
  `addressing.ts`, `consoleTargets.ts`, `routesSend.ts`. Before activation the listener serves
  health and enroll only; that is a new gate in `composeRoutes` or `httpRouter`, with a test that
  an arming gateway answers a session route with a refusal.
- `consoleTargets.parse` refuses an arity 1 or 2 target from the console with a named reason. The
  MCP door's gateway-local resolution is untouched; `console-targets.test.ts` keeps the local
  cases behind the MCP door and adds the console refusal.
- The harness follows: `check-boot-runtime.ts` (`target: "host"`) and eighteen literal bare targets
  across `federation-harness-boot`, `-vault-requests`, `-codex`, `-runbook-fire` (four),
  `-create` (two), `federation-harness.test.ts` (two), `-sessions` (five), `console-create-join`
  become qualified spawn points from the fixture identity set.

Rules:

- A phone target is `domain.gateway.spawn` or `domain.gateway.spawn.session`. Anything else is
  refused where it is made, not resolved.

- As built: `parseQualifiedTarget` exists on both runtimes, pinned by the `parseQualifiedTarget`
  and `parseQualifiedTargetReject` vectors; the phone's `parseTarget`, `Address.local`,
  `Address.remote` and `LOCAL_DOMAIN_SENTINEL` are gone, and so are the TS `Address.local`,
  `Address.remote` and the sentinel. The gateway's `parseTarget` fills a real Domain or throws.
  `consoleTargets.parse` is `parseQualifiedTarget`, so every console method refuses a bare name
  ahead of its own check; `console-target-residue.test.ts` bans `parseTarget` under `console/`
  outright. `consoleHandler.reserveRoutineSession` qualifies the routine's spawn on this Gateway
  before it reaches the lifecycle, the one gateway-internal caller of a console target.
  `GatewayConfig.localDomainId` is a string; `composeRoutes.current()` is null until a Domain is
  active and `httpRouter` answers `unenrolledHealth` on `/health` and `503 NOT_ENROLLED` on every
  other route, the enrollment posts excepted (`http-router.test.ts`). The roads that only run
  active read `FederationContext.activeDomainId()`, which throws rather than filling a blank.
  `sessionAuthority.localTeamKey` answers null with no Domain. `localSessions` with no admin
  Domain lists nothing. The harness gained `DomainPeer.target(team)`; every console op it sends
  is qualified, and a bare `tmux_send` is asserted refused. `check-boot-runtime` creates
  `${domain}.${gateway}.host`. Carriers: `RunbookTargets` offers qualified spawn points and
  `Team.name` addresses with the short label beside them, since the fire sheet sent bare ones;
  `canonicalTarget` and its fallback to the input are gone, `openThread` answers null for an
  unqualified key and `closeTab` ignores one, so a notification extra or deep link cannot open a
  tab on a bare name. Board entries keep the local session field beside `domainId` and
  `gatewayId` by design, and a vault request's `sessionTarget` is the gateway's local field.

## Phase 4 - The phantom mirror rows

- `routesRespond` runs the asker and replier mirror block only when `reply.kind == "conversation"`.
  `LocalReply` has exactly two kinds, so the gate is type-complete. The inbound-contract mirror
  above it (`localAddr = tryLocalAddress(deliverResult.to)`) mirrors the local replier's own side
  and stays; the plan names it so nobody deletes it by association. `provedLocalSession` stays as
  the authorization check.
- Harness: an owner-anchored reply yields exactly one `reply` row and zero `peer` rows in the owner
  inbox, both on the local road and on a cross-Gateway response returning through
  `gatewayRelay`; the runbook-fire test gains the zero-peer assertion.
- `ChatRepository.thisDeviceAddress`, `DrainHost.thisDeviceAddress` and the
  `PollDrain.processEntries` equality deleted; a conv row threads under its own address.
  `PollDrainTest` gains a `processEntries` case: a peer row at a local session address threads
  there.
- Order: gateway before phone, so no phantom row is minted once the phone stops recognising one.
  Rows already drained keep the thread they landed in.
- `addressing.consoleSelfAddress` stays: it is the owner's from-address as a session sees it, per
  Gateway, attribution only, never routing; a reply routes by `LocalReply` and the return route.

## Phase 5 - Router-held blobs

Router-first.

The Router half:

- One store. `ReferenceHeldStore` gains a `staged` state with the one-hour expiry, its lease and
  reference metadata moving into the per-owner `OwnerStateStore` journal beside the records that
  name blobs; sealed bytes stay in `BlobStore`. The staged sweep rides the owner-service tick.
  `RouterBlobCache`, `BlobFetchRoute`'s origin forwarding, and the `blob_fetch` and
  `blob_fetch_reply` gateway frames are deleted.
- One publish primitive, `ReferenceHeldStore.publishWithBlobRefs(domainId, sets, mutate)`, inside
  one `OwnerStateStore.batch`: refuses unless every named blob is complete-staged or referenced,
  runs the record mutation, replaces each reference's blob set, moves staged to referenced,
  releases emptied references, one journal line. Its callers, with no post-write `applyRefs` left
  on any acceptance path: inbox append (owner rows converge here), `boardService.write`,
  `scheduledService.schedule`, `scheduledService.fire`. Owner-addressed row retirement releases
  references too; today `inbox.onRowRetired` returns early for a non-session address. References
  are a set; bytes go when the last one goes.
- Owner ops in `ownerOpRegistry`: `blob_begin` and `blob_chunk` (mutation `value`) and
  `blob_upload_status` (`read`, answering `absent`, `staged { have, lease, size, ciphertextSize,
  ciphertextDigest, epoch }`, or `complete { ... }`). A chunk's value is immutable: lease id and
  generation, offset, ciphertext digest, bytes digest, finality; one stable namespaced `opId` per
  chunk so the ledger replays a repeat and refuses a different body; a later network attempt
  carries a fresh timestamp, nonce and signature. Storage is keyed by the plaintext `blobId`; the
  Router verifies the ciphertext digest; the lease carries the epoch a reader opens with.
  `blob_fetch` loses `origin`. Never through `gateway_value`.
- Gateway frames `blob_begin` and `blob_chunk` stay for Gateway-produced outputs and target the
  same staged state; the gateway publishes through the same primitive when its row is appended.

The gateway half:

- `deliverToOwner` becomes awaited: upload complete, then the row, in one publish. `cacheBlobs`
  and `humanNotify`'s fire-and-forget go. `routesSend` and `routesRespond` files publish the same
  way. `routes/relay.ts` stops warming a cache.
- Deleted: `stampBlobHolder`, `stripFileRefs`, `blobOps.ts`, `blobFetch.ts`, `routesBlob.ts`, the
  `/blob/*` routes in `httpRouter.ts`, the `BlobStat`, `BlobPut`, `BlobGet` console ops and their
  result schemas, `blobGateway` in `boardClient.clearAttachment` and `boardTools`. A Router-only
  range read replaces them before they go, keeping `epoch`, `offset`, `size` on the answer.
- `mcp/channel/channelFiles.ts` and `mcp/blobTransfer.ts` lose `blobGateway` and read through the
  gateway's Router fetch.
- Gateway-local staging is a lifecycle state, not a holder: bytes may sit only on the producing
  Gateway, only for that Gateway's own uncommitted delivery; the `blobs` dir serves its own
  sessions' pending deliveries and retry, and a local file is retired with its pending delivery
  or outbox item, never later. `dataDirInventory` keeps `blobs` under that meaning.

The phone half:

- `SealedBlob.kt` gains `sealBlobChunk`, pinned by the sealed-blob vectors, as the prerequisite.
- `uploadSealedBlob`: seal with the current content key, `blob_upload_status` first, resume from
  `have`, `blob_begin` and `blob_chunk` as owner ops. The phone `BlobStore` is plaintext staging
  only, deleted on Router acceptance.
- `routerBlobRange` loses `originGateway` and answers a typed `Absent`; `AttachmentOps` reads
  through it only (`fromRouterCache` renamed), no Gateway fallback. `BlobAbsent` is raised only on
  a proven Router absence; the board shows an absent state, retries only by tap, and
  `BOARD_FETCH_GIVE_UP` covers failures, not absence.
- `BoardOps.boardSetAttachmentsNow` uploads every new blob first and intends only once all are
  held; the staged source stays for retry. `BoardOptimistic.applyPending` is unchanged.
- Scheduled sends become Router-first at acceptance: the local row is a durable pending intent;
  the phone uploads the attachments, posts `schedule_send`, and the row is scheduled only when the
  Router accepts, which binds the references; during an outage it shows as waiting with its source
  files kept; cancel and reschedule stay pending the same way. `SelfMigration`'s upload road and
  the schedule-time upload in `ScheduledSendAlarmReceiver` go with it. (One-hour staged bytes and
  a thirty-day local schedule cannot coexist; this is the smallest honest shape.)
- `ConsoleClient.send` uploads then sends. `ChannelFile.blobGateway`,
  `BoardStateAttachment.blobGateway`, `MessageFile`'s holder, `fromGateway`, `targetGateway`
  deleted. `blobGatewayFor`, `boardGatewayOf`, `boardGatewayOfKey`, `BoardStore.loadGatewayId`
  deleted. `BoardRows.GroupKey` is the entry's `{domainId, gatewayId, sessionId}` and `cardBranch`
  takes it.
- Tests: `MessageFileRoundTripTest`, `AttachmentsTest`, `BoardIntentTest`, `BoardOptimisticTest`,
  `AttachmentOpsTest`, `ScheduledSendOpsTest`, `SelfMigrationTest`, `ConsoleClientOwnerOpsTest`,
  `SandboxFixtures`, the wire fixture generator; Router tests for upload before visibility, a row
  commit refused without its blob, a chunk retry replayed, a different body refused, reference
  release after inbox expiry, staged expiry across a restart and under the fence, migration
  restart.
- Schemas, `Protocol.kt`, fixture manifests, the `docs/federation.md` blob line, the
  `docs/task-board.md` holder paragraphs, the stale comment in `blobUploader.ts`.

The one-time migration, run by the agent at deploy and deleted in the same plan:

- A temporary loopback route on the gateway, `/migration/router-blobs`, behind a one-use deploy
  credential, so it runs inside Sakura with the live Router client. A temporary Router read frame
  `blob_migration_inventory` answers every live `BlobReference` the Router's board entries, inbox
  rows and scheduled records name.
- Per referenced local blob: stage through the live client, verify complete, bind the exact
  references through `publishWithBlobRefs`. Drain `owner-row-outbox.json` by uploading and
  appending each row. Keep live `pending-deliveries.json` files under the staging rule until
  delivered or expired; sweep the expired first. Drop only bytes named by neither.
- Restartable; ends by verifying every Router reference resolves. The route, the frame, the
  driver and the retired `board-attachments` dir go in the cleanup commit.

Rules:

- A blob has one holder, the Router. Nothing on the wire names a Gateway for a blob.
- A row that names a blob is not visible before the blob is held.
- Before publication, bytes live only on the producing Gateway and only for its own uncommitted
  delivery. After publication, the Router is the source and a local copy cannot rescue a Router
  absence.

## Phase 6 - Gateway-specific pairing and sharing (track two)

- `crossDomainHandshake.request` stamps `this.self.gatewayId`. `requesterGatewayId` leaves
  `cross_domain_request`, `consoleCrossDomain.request`, the handshake request type, `Protocol.kt`,
  the harness, the handshake and owner-op tests, and the wire fixtures. The SAS commitment preimage
  includes the Gateway id, so the handshake vectors are regenerated for the stamped id.
- The five pairing methods on `ConsoleClient` take an explicit `gatewayId`; `defaultGatewayId` is
  not a fallback. The phone picks the pairing Gateway from the sheet at listen or request;
  `TrustOps` holds a `Pairing(gatewayId, ...)` for the pairing's lifetime and every retry, poll,
  confirm and cancel reads it. A pairing does not survive process death; the Gateway's rendezvous
  TTL is the authority and a fresh wizard starts a fresh pairing.
- Shares, Router-first with replay. The phone posts `cross_domain_share`, `cross_domain_unshare`,
  `cross_domain_list_shares` as owner ops. The Router keeps one monotonic `shareMirrorRevision`
  per Gateway, bumped in the same owner-store batch as the record; every share or unshare pushes a
  delta carrying it to the session target's Gateway only (`ownSession` is why); on registration
  the Router pushes that Gateway's whole effective share set as one snapshot with its revision.
  The gateway replaces `CrossDomainShareState` wholesale on a snapshot at or above its held
  revision, applies a delta only at held plus one, and re-registers on a gap. Persist first, then
  `onChange` once, so attestation and presence recompute as today. The gateway's mirror-first
  write, its `share` and `unshare` console handlers, and the Gateway-to-Router share frames are
  deleted. The existing authorization generation is not reused; it moves only on revocation.
- The registry gains a `peers` projection per Gateway: `crossDomainListPeers` reads every
  Gateway concurrently and keeps `(gatewayId, friendDomainId, friendGatewayId, ownerSignPub)` with
  the read outcome; `LinkedDomain` and `CrossDomainLink.mergeLinkedDomains` stay Domain-level for
  presentation over that Gateway-keyed data.
- `shareableSessions` offers a session when its Gateway's `peers` projection holds a peer for the
  target Domain; a `Cached` or unreachable read draws as stale, never as no peers. The share sheet
  reads the registry, not one Gateway on every open.
- `crossDomainUntrust` takes a `gatewayId` and `TrustOps.untrustOwner` runs it per registry
  Gateway; with the Router reachable the edge is revoked first and Gateway cleanup is retryable;
  with the Router unreachable nothing claims revocation and the local trust stays, marked
  pending.
- `docs/console.md` last-filter paragraph; `docs/federation.md` shares bullet.

Rules:

- A pairing is a Gateway's. The owner names which, once, and it holds.
- A share is the Router's record. A Gateway learns it by revision and never writes it.

## Phase 7 - The symbol dies, and the shims with it

- `homeGatewayId` everywhere: `ChatRepository`, `ChatState`, `ConnectCoordinator.adoptHomeGateway`,
  `selectHomeGateway`, `ConsoleClient.defaultGatewayId`, `ConsoleClientCollaborators`,
  `ConsoleRouterTransport`, `DeviceApprovalOps` with `ConsoleTransport.gatewayId` and the
  `installApprovedDevice` parameter, `OwnerFacts.admitGateway`'s write, `AppStateStore.KEY_GATEWAY_ID`,
  `PresenceHost`, `SessionHost`, `RunbookHost`, and the tests that only covered them.
- `RunbookManager.UNPLACED` and the list-form decode (a list-form store decodes as empty and is
  overwritten on the next commit); `LegacyCapabilitiesSchema` (an old cache reads as
  `NOTHING_REPORTED` until the next report, tested); `FEDERATION_PROTOCOL_FLOOR` to 2 with the
  `unsupported` road, the admin bootstrap carve-out test raised to protocol 2, and a refused gateway
  stopping with a named error rather than staying connected unregistered; `sealTargetFor`'s
  bare-string fallback becomes a refusal, with `federation-pure-rules.test.ts` and the relay and
  presence-pull callers asserting a refusal, not a throw.
- The old state goes by a narrow one-off, not a grammar bump: `AppStateStore` removes
  `KEY_GATEWAY_ID` on first run of the new build and leaves every other key alone.
  `SCHEMA_WIPE_KEYS` is not touched; `GRAMMAR_VERSION` is not bumped.
- The join bundle carries a required `version: 2`; `DeviceApprovalOps.installApprovedDevice`
  refuses a bundle without it, tested with a pre-split bundle. `ignoreUnknownKeys` alone accepts
  the old form, which is why the marker exists.
- Residue test on the phone: no `homeGateway`, `KEY_GATEWAY_ID`, `blobGateway`, `fromGateway`,
  `requesterGatewayId`, `LOCAL_DOMAIN_SENTINEL`, `Address.local`.
- Existing residue tests reviewed with the phase, not left to fail: `console-target-residue`,
  `ambient-residue` (the staged sweep rides the owner-service tick), `aad-kinds-residue` (owner
  chunk uploads use the sealed-blob frame AAD and `opPayloadAadKind`, no new kind, asserted),
  `sandbox-network-residue`, `coroutine-scope-residue`, `fire-and-forget-residue`,
  `migration-fence-residue`, `wire-vocabulary-residue`, `protocol-fixtures`, `router-protocol`.

## Phase 8 - Words

- `docs/console.md` six-jobs section deleted; `docs/architecture.md` phone path;
  `docs/testing.md`; `AGENTS.md` ChatRepository entry, the Architecture paragraph, the RoutineOps
  and BoardOps entries; `docs/policies.md` where it names membership.
- `federationHarness.ts` `home: DomainPeer` renamed. Test names that go with their road:
  `aNewDomainClearsTheOldHomeGateway`, `sandboxSeedCarriesTheHomeGatewayFromTheTeamIntoStateInput`,
  `aLibraryWrittenBeforeTheCopiesWereSplitIsTheHomeGatewaysAndNobodyElses`,
  `HostSpawnChoicesTest`'s bare-target case. Comments: the `spawnTargetKey` block, `GatewayPick`'s
  "The keyring leads with home", `BoardOps.blobGatewayFor`'s "this phone's route". Classified and
  kept where they mean a Gateway's own locality: `SessionCard` and `Presence` "this device's own"
  (the phone's own action, correct), `session-id.ts`, `domain-id.ts`, `gateway-id.ts`,
  `schemasPresence.ts` "local Gateway" (gateway-side, correct).

## Painpoints

Collected after Phase 0. Not fixed here.

- **Gateway frames parse by hand.** `frameDispatch.ts` catalogues every gateway frame with its
  class and incarnation policy but not its params schema, so each handler calls `.parse` itself
  and a refused shape becomes a `tool_error` the caller retries. The presence frames had to grow a
  `safeParse` plus a `resync` answer by hand; `shareService` (`cross_domain_share` frame),
  `vaultService` and `boardService` still throw. `ownerOpRegistry.ts` already parses the value
  before the handler sees it. The frame catalog should do the same.
- **Plane version 0 was a silent convention.** `consoleSockets.readPlanes` (`known ?? 0`) and
  `PollDrain.mayApplyPlane` both read 0 as "nothing yet", while `presenceService.projectionPlane`
  minted 0 as the first real version. Closed in Phase 1: the lineage crosses the wire and
  `foldVersionedSlot` is the one reader.
- **A dead result schema and a hand-written twin.** `ConsoleListTeamsResultSchema` has no
  consumer outside the codegen and carries optional `coverage` and `spawnPoints` "absent from an
  older gateway". `presenceExchange.ListTeamsRelayResultSchema` is an optional-field twin of the
  discover answer for the gateway-to-gateway `list_teams` relay (`pullPresenceFromDomain`), the
  cross-Domain presence road that predates the Router projection. Both go when the cross-Domain
  presence road is retired (Phase 6 touches it).
- **Held-Domain enumeration lived in the file system.** `OwnerStoreRegistry.domains()` read the
  store directory, so a rooted Domain with no rows was invisible to the projection's link fan-out.
  The enrollment catalog is now passed in as `knownDomains`; the `readdirSync` fallback stays for
  tests that build a registry without one.
- **Kotlin projection fixtures are hand-built per test.** `PresenceOpsTest` and `PresenceMergeTest`
  each construct `OwnerPresenceProjection` with its own `OwnerFacts`, coverage, roster and spawn
  points. `TestTeams.kt` covers teams only. A projection builder beside it would have made the
  `owner` addition a one-line change.
- **The reach invariant is proved only by the harness.** `federation-router-surfaces.test.ts`
  stubs `onReach`, so the unit test cannot say what an unadmitted signer learns; the assertion sits
  in `federation-harness-boot.test.ts` alone.
- **`teamInfoToTeam` still reads the relic.** `Team.gatewayId.ifEmpty { homeGatewayId }` and the
  nullable `Team.domainId` survive Phase 0 by design (Phase 2), and every Kotlin fixture that
  builds a `Team` carries the nullable parameter with them.

Collected after Phase 1. Not fixed here.

- **`ChatRepository` extensions are out of every gate's reach.** `applyPlane` and `revisionPlane`
  are extensions on the whole repository, and `PollDrainTest` stubs `applyPlane` to `true`, so a
  plane that was never acknowledged passed every gate until the red team traced it by hand. The
  decision had to be lifted into `revisionPlaneDecision` to be pinned at all. Every extension file
  (`ChatRepositoryInbox`, `ChatRepositoryThreads`, `ChatRepositoryDomainLink`) has the same shape.
- **The tabs' empty state is written three ways inside composables.** `RoutinesScreen.emptyTitle`
  is file-private, `RunbooksScreen` spells it inline, `PoliciesScreen` drops the middle case. No
  JVM test can reach any of them. Goes with the per-Gateway answer slot (board `bd_9784d356`).
- **The sandbox seeds only `Current`.** The stale mark, the `NeverLoaded` copy and every gate
  refusal have no emulator route, so Phase 1 shipped UI states nothing here can draw.
- **A served lineage can trail its payload.** `readPlanes` calls `planeVersions` and then
  `readPlane`, which recomputes the presence projection; a delta between the two bumps the payload
  past the wrapper. The cursor stamps the wrapper, the slot saves the payload. Self-heals next
  tick; the two should be one computation.
- **Two lineage folds per plane.** The in-memory cursor decides delivery, and behind it the
  presence slot and the board and vault managers hold their own durable lineage and fold again
  with no observation. Right today, but "the one cursor" is only the in-memory half.
- **Records reach Kotlin as `JsonObject`.** The codegen cannot type `z.record`, so `known`,
  `versions` and every lineage map is decoded by hand (`PollDrain.lineageOf`); a record-valued
  field is a decode the compiler cannot check.
- **Two callers for a once-only restore.** `ChatRepository.init` and `PollDrain.start` both call
  `restoreLastProjection`; the idempotence sits inside `PresenceOps` behind a flag and a mutex
  rather than one owner.
- **Codex quota ran out mid-lap.** The Phase 1 architecture and red-team fan-outs ran on Opus and
  Sonnet, and Sol was not available for the checkpoint read; the drain-until time was not visible
  before the first refusal.

Collected after Phases 2 and 3. Not fixed here.

- **An owner op's failure is a string.** `OwnerOpAnswer(ok, result, error)` flattened every
  non-accepted Router outcome into `error`, and a reasonless outcome (`conflict`,
  `durability_uncertain`) read as "owner operation refused" on the phone. Nothing could tell a
  settled answer from a lost one, which is how three journaled forgets replayed on every connect
  for days. `OwnerOpFailure(outcome)` now carries the outcome, but the op-outcome vocabulary
  itself (`refused`, `conflict`, `durability_uncertain`, `migrating`) is declared nowhere shared:
  the residue test protects `refused` in Kotlin through the socket frame's constant, `conflict` is
  a bare literal in `SelfMigration`, `VaultOps` and `ConsoleClientTypes`, and TS spells `"refused"
  as const` in seven places. An `OP_OUTCOME_*` set beside `OP_OUTCOME_ACCEPTED` is the fix.
- **A replayed delivery op can never match its first row.** The journal replays a forget under its
  opId, but `ConsoleClient.sendDeliveryOp` re-seals the row with a fresh nonce, so the Router's
  `opHash` compare answers `conflict` forever. The replay contract wants the sealed row journaled,
  or the Router's `op_result` read on a conflict; retiring the journal on a settled answer is the
  patch, not the design.
- **Every repository port is declared four times.** `canonicalTarget` lived on `ChatRepository`,
  `SessionHost`, `ScheduledSendOpsCollaborators` and `RepositoryCollaborators`, plus every test
  fake. Removing one method touched seven files; adding one is the same walk. The ops classes'
  role ports are hand-copied slices of one object.
- **Seven compose stages take `routes: () => GatewayRoutes`.** Making the routes null before a
  Domain meant a throwing accessor rather than a nullable type, because the closure shape is
  repeated in every stage's deps and none of them can say when it may be called.
- **The harness wrote bare targets by hand in nine files.** `DomainPeer.target(team)` exists now,
  but `PhoneDriver.value({ kind: "create_session", target })` still takes any string; the driver
  could qualify a local field itself and refuse a bare one, as the console does.
- **Gradle cannot run in the background here.** The harness kills a backgrounded
  `kotlin-gate.sh` as "low memory" with twenty gigabytes free, so every Kotlin gate is a
  foreground wait of a minute or two, and a killed run corrupts the test results until they are
  deleted by hand.
- **A relayed Codex report can vanish.** The Sonnet relay that carried Sol's read finished and
  went idle without its result reaching the session; it had to be asked again by name. A relay
  should write its report to disk before it answers, which the later relays did.
