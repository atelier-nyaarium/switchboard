# Questionaire

## Starting state, verified before question 1

Two roads consume a vault value, both in `vaultRoutes`:

- **`use`**, the `vault_run` road. The caller names `entryId` and `operation`. `usable` checks only
  that the entry exists, holds a value, and this Gateway is in its allowlist. No title match. So one
  entry already serves any number of distinct commands. `federation-harness-vault-requests` proves
  it: an entry titled "Deploy key" answers `ssh deploy@prod uptime` and others.
- **`askpass`**, the sudo, ssh and git road. The helper sends only a command line, so it has no way
  to name an entry. The route infers one by matching `publicTitle` against `displayShape`,
  case-insensitively, and requires exactly one match. Zero or two fall back to `typed`, and a typed
  answer always settles as `once`, so a typed road can never leave a grant.

Every grant tier in `createVaultDecisions` is keyed on `entryId`: `window` covers the shapes
`operationSet` named, `session` covers every shape of one entry for one session, `standing` covers
every shape while its routine is live.

**So the owner's pain is real but narrower than "two systems are tangled".** The duplication is
askpass-only, and its cause is that sudo gives the helper no entry selector, so `publicTitle` was
pressed into service as one. That is the double duty: a label to read and a matcher to compare.

### What the title match quietly provides today

An automatically selected entry can answer only the shape equal to its title. That means a secret
cannot become askpass-eligible for an unrelated command merely by holding a value, an unexpected
shape falls back to typed, and duplicate matches fail closed rather than picking one. Any
replacement has to keep exact matching, unique matching, and fail-closed behaviour, or it trades a
narrow equality check for a broad policy language.

### Migration hazard, verified

`sealDraft` constructs `VaultEntrySealed` naming every field explicitly, and a put replaces the
whole sealed record. An old phone build therefore cannot preserve a field it does not know, so any
new sealed field is silently dropped when an old phone edits an entry. The usual "gateway first,
then plugin, phone on its own cadence" order is not sufficient here: the Router has to understand
and retain the field before a new phone writes it, and the generated Kotlin protocol moves in the
same commit as the schema.

## Question 1 - Selector, or first-class policy?

Q: Should one secret entry simply be selectable by several askpass command shapes, or should command
authorization become a first-class record that can exist independently of a secret?

A: A first-class record. The selector field was rejected as a tactical patch.

> B. I want it fleshed out better like you just described.

So the record has to carry what a selector field could not express: a different command set per
Gateway, one policy covering two entries through a credential rotation, revoking a host's automatic
use while the secret stays usable by hand, and naming which entry wins when two could match.

## Question 2 - Where does an authorization record live?

Q: Router-held and sealed like the vault, or gateway-held like runbooks and routines?

A: Gateway-held, a durable store on each Gateway's own disk, like runbooks and routines.

### Research, verified, awaiting a Sol duck-check

**The gateway holds no vault state across a restart.** `createVaultClient` keeps `held` in memory
only, and its own comment says a restart lists from zero. So a Router-held authorization record is
unreadable after a gateway restart until the Router answers. An unattended routine firing in that
window has no policy at all and fails closed.

**A gateway-held record survives it.** Both `createRunbookStore` and the routine store open through
`openDurable` and read from disk, so they answer immediately with no Router.

**Per-Gateway command sets come free from gateway-held storage,** since each gateway holds its own.
Router-held would need a gateway-to-shapes structure inside the record, because the vault's
`gateways` allowlist is entry-wide. Per-Gateway sets were one of the four reasons B was chosen.

**Sealing is the Router-held cost.** The Router stores vault fields without opening them, so fields
register in `VAULT_FIELD_NAMES`, and a sealed field needs an AAD kind in `content-envelope`, its
Kotlin twin in `ContentAadKinds`, and a fixture vector, with `aad-kinds-residue` fencing both. A
gateway-held record is stored in the clear and needs none of it. A list of command shapes is not a
secret, so sealing buys little here.

**The `sealDraft` hazard does not follow a separate record type.** It is specific to a phone rewriting
a whole `VaultEntrySealed`. A gateway-held record avoids it; a Router-held sealed record inherits it.

**The decision happens inside the gateway,** in the askpass handler and `createVaultDecisions`, which
is where a gateway-held store already sits.

**The gateway-held pattern is proven and its defect classes are already fenced:** one copy per
gateway, every read and write naming its gateway, and `GatewayReadFence` deciding which read wins.

### Sol's duck-check, verified. Decision stands, on a different leg.

**The restart argument was overstated.** Every `use` and `askpass` request calls `ready`, which
refreshes the Router-held vault before resolving an entry. A Router-held policy would hydrate in
that same step, and when the Router is unreachable the vault already fails before any value can be
obtained. So restart availability does not distinguish the two. Gateway-held is right because the
policy is per-Gateway enforcement state and belongs durably beside the authority applying it.

**What the gateway does persist:** `composeVault` opens `vault-decisions` and `vault-helper` through
`openDurable`. Standing grants survive a restart; `covers` then asks `routineHolding` to prove the
asking session belongs to a working occurrence. Nothing rebuilds grants from routines at startup.

**Stale grants already fail closed.** A full refresh calls `entriesListed`, which drops grants for
entries absent from the Router list; incremental loss calls `entryDeleted`.

**Gateway-held is not phone-invisible.** No AAD kind or sealed-field migration, but the phone still
needs wire schemas, owner operations, and generated Kotlin types to author and read the record.

### What option B breaks, from Sol, to carry into the design

- **A soft cross-store reference.** The policy names a Router-held entry the phone can delete or
  re-scope at any time. Effective authorization is always: policy permits the shape, AND the entry
  exists, AND it holds a value, AND `allowedHere`, AND a grant covers it. `allowedHere` stays the
  secret owner's ceiling; policy is narrower automatic-use authority beneath it.
- **Deletion must not delete the policy,** or independence is a lie. Keep it, mark the binding
  unresolved, refuse automatic use, surface it, let the owner rebind.
- **An allowlist change is not `onEntryGone`.** Re-run `allowedHere` on every use. Never cache
  "authorized entry X".
- **An unordered set of entry ids is not a rotation model.** "First usable" silently falls back to
  the old credential when the new one is revoked, turning a revocation into continued authority.
  Rejected outright. The real choices are one active entry plus a staged successor, an ordered
  fallback list with named failure classes, or a stable credential identity the vault does not have.
- **Overlapping policies recreate the duplicate-title ambiguity one layer up.** Fail closed on
  overlap, or precedence is owner-authored and visible. Never insertion order.

## Question 3 - Intent guard, or security boundary?

Q: The helper receives a command line the calling process reports about itself, and answers with a
reusable credential. `docs/vault.md` already says it does not authenticate the caller. Is the shape
list an intent guard that keeps cooperative tools from using a credential by accident, or must it be
a security boundary against a hostile same-user process?

A: Intent guard. A hostile same-user process is the compromised-machine case and out of scope.
Shapes stay the selector. The helper keeps answering with the value.

> A

Recommendation reason, adopted: the design already declares itself an intent guard in
`docs/vault.md`, application-level controls cannot reach a hostile process on the owner's own
machine, and a security boundary would be a different road where no value ever leaves the vault
for sudo, changing what every askpass entry, grant tier, and routine link means.

## Question 4 - How does a policy bind to a secret across a rotation?

Q: One entry id edited in place, one active entry plus a staged successor, an ordered fallback
list with named failure classes, or a stable credential identity the vault would have to grow?

A: One entry, edited in place. An entry id denotes one logical credential across value revisions.
Grants, routine links and open requests ride through a value change. A clean break is a new entry
plus revocation. Nothing to build.

> A

Recommendation reason, adopted: covers sudo outright and one-key-at-a-time ssh; the vault already
provides the stable id, revision-checked replacement, and grants that survive presence. A staged
successor is unused lifecycle machinery unless a credential rolls across machines gradually, and
the record's `binding` shape keeps that door open without building it.

## Question 5 - What does a grant on the askpass road authorize?

Q: When the owner approves an askpass request that a policy resolved, does the resulting `window`
or `session` grant name the entry, as every grant does today, or the policy?

A: The entry, qualified by the policy. A grant keeps `entryId` and gains an optional `policyId`.
A policy-resolved approval stays inside that policy. Entry-wide grants stay broader and still
cover askpass. A policy grant never covers a bare `vault_run`.

> Recommended it is

Recommendation reason, adopted: the only shape where splitting into policies has an approval
consequence and routines keep working.

## Question 6 - What happens to the title match?

Q: Clean break, a one-shot migration then break, or keep the title match as a fallback when no
policy matches?

A: Clean break. The `publicTitle === displayShape` road in the askpass handler is removed. An entry
titled after a command is just an entry with that title.

> clean break.

### What decided it, verified

- The owner holds zero live entries. Nothing to migrate.
- The phone never told the owner to title an entry after a command. Only the docs line and two
  harness tests know the road exists.
- **The title road is a hole, not just a coupling.** `capture` needs only a session principal and
  notifies the owner after the entry exists. `createVaultClient.create` seals no `gateways` field,
  and `allowlistOf` answers everyone when that field is absent. So a session can capture an entry
  titled `sudo systemctl` and become the automatic askpass answer for that shape on every Gateway,
  before the owner sees the notification. The duplicate rule protects only shapes the owner already
  titled. In scope for an intent guard, since a confused cooperative agent can do it. Owner-authored
  policies close it: nothing a session writes can become a selector.

### Two corrections from Sol, verified

- **Capture seeds the selector; it does not release the value.** A captured entry has a fresh id,
  `covers` keys on `entryId`, so no grant names it and its first use is an entry request the owner
  must tap. The defect is that a session can create the command-to-secret binding that decides
  which credential the owner is asked to approve, on every Gateway. Still an ownership-boundary
  violation, narrower than first stated.
- **The phone does rely on the title match.** "Send and save" on `VaultRequestSheet` stores a
  typed value under `request.displayShape` as its title, and its own comment says that is what the
  helper matches next time. The earlier claim that the phone never promised it was wrong.

### Settled beneath the break: typed stays

No matching policy opens a typed request exactly as today. Typed carries no stored-entry selector,
the owner types the value, the sheet offers no window or session tier for it, and `requests.answer`
forces `once`. An agent can make the phone ask; it cannot choose the secret, bind an entry, mint a
grant, or get anything from a habitual tap. Refusing instead would make policy configuration a
prerequisite for every novel prompt and kill the one-shot road for nothing.

### Why not a migration

`displayShape` is permissive: it splits words and shapes anything, so "Deploy key" shapes too.
Automatic synthesis could not tell a deliberate legacy selector from a coincidental label or a
session-captured title, and would mint durable authorization an old phone cannot yet show or
revoke. An owner-confirmed import would be the only defensible form, and with zero entries there
is nothing to import.

### The whole residue the break takes with it

- **Askpass handler:** remove the `matches` block. Three outcomes replace it: exactly one policy
  wins, an entry request carrying `policyId`; no policy, a typed request; an ambiguous policy
  state, fail closed by the resolver's rule, never a title fallback.
- **Harness tests, `federation-harness-vault-requests`:** the "no matching title" case at 262
  becomes "no matching policy"; the entry titled `ssh deploy@prod` at 324 proves a matching title
  alone selects nothing; the capture at 373 proves capture does not alter policy resolution. Add
  unique match, overlap, disabled policy, missing entry, and `allowedHere` cases for policies.
- **`docs/vault.md`:** lines 39 to 41 on what a saved typed value is titled, 108 to 112 on
  public-title selection, 229 to 230 on Send and save storing under the shape. Titles are labels,
  policies select entries, capture never creates a policy.
- **Phone, `VaultRequestSheet.answer`:** the comment at 93 goes. Send and save may keep creating
  an entry and may keep suggesting the shape as a title, but must not imply future selection and
  must not create a policy. A "Send, save and authorize" would be a separate explicit owner choice.
- **`decisions.ts` line 40:** the comment on what a saved typed value is titled.
- **Unchanged:** `vault-askpass.test.ts` tests helper transport and tty racing, not selection.
  `federation-harness-vault.test.ts` tests capture and storage. `VaultEntryDialog`, the entry list,
  `capabilities.ts` and the MCP capture description never promised title matching.

## Question 7 - Two enabled policies on one Gateway name the same shape

Q: Refuse the overlap at the store so it is unrepresentable, allow it with owner-authored
precedence, or allow it and fail closed to typed at askpass?

A: Refuse it at the store. For every canonical selector key, at most one enabled policy holds it.
A save or enable that would overlap is refused naming the holder. Case is preserved. The refusal
on a toggle lands on the toggle with its reason.

> A

Recommendation reason, adopted: the resolver is unique by construction and never meets an
overlap; precedence solves no demonstrated need since a broad policy is just one with more keys;
failing closed at askpass lets the store persist a state the resolver cannot act on.

### Research, Sol, verified where marked

**A category error in the draft, corrected.** `displayShape` is the one-shape askpass selector:
`sudo apt install` shapes as `sudo apt`. `operationSet` is the many-shape coverage set a window
grant records after parsing pipelines and peeling wrappers: the same line yields `apt install`.
The existing askpass handler selects on the first and computes the second afterwards for the grant.
Policies replace the title selector, so they select on one canonical `displayShape` key. A policy
naming `apt install` does not match `sudo apt install` merely because the wrapper table peeled
`sudo`. A pipeline has one selector; its stages matter to the window grant, not to choosing the
credential.

**The store invariant, exact:** for every canonical selector key, at most one enabled policy
contains it. One shared `selectorKey` function serves both the store's normalization and the
askpass lookup. A proposed enabled policy is refused when its keys intersect the union of every
other enabled policy's keys, naming the conflicting policy and shapes. Duplicates inside one policy
are refused after canonicalization. The field is `selectorKeys`, never `shapes`, so the next
implementer cannot merge it with `operationSet`.

**Case is preserved.** Verified: the old title matcher lowercased both sides; `shapeFrom` does not.
Linux command names and arguments are case-sensitive, so the selector key inherits `shapeFrom`'s
rule, not the title matcher's convenience.

**Precedence solves no demonstrated need.** With exact membership a broad policy is just one with
more keys, and the owner can store a disjoint partition directly. Rank becomes useful only with
wildcards, prefixes, inheritance, or a default-with-overrides, none of which exist. A future ssh
key hint becomes part of the selector key, so those policies do not overlap either. Failing closed
at askpass is worse: it lets the store persist a state the resolver cannot execute, which is
today's duplicate-title behaviour one layer up.

**The store needs optimistic concurrency, not distributed CAS.** Gateway-assigned revisions, every
edit, enable and delete carrying the revision the phone read, a stale base refused with the held
record, lost-answer repeats idempotent, and a deletion fence so an old editor cannot recreate a
deleted policy. This is `createRunbookStore.put` and `createRoutineStore.put` with
`routineRefusal` plus a context refusal. Validation and durable commit run in the one synchronous
writer with no await between them, so two phones claiming one selector settle first-wins.

**Re-enabling is refused visibly, on the toggle.** Disable X, enable Y over X's former selector,
re-enable X: refused, X stays disabled, and the phone shows which policy holds the selector. Never a
Boolean that snaps the switch back in silence.

**A live sibling defect, verified.** `RoutineStore.setEnabled` returns a `RoutinePutResult` with a
refusal reason; `RoutineOps.setEnabled` collapses it to `answer?.stored == true`; `RoutinesScreen`
launches it and ignores even that. So a refused routine toggle already explains nothing. Second
instance of the class on the board as the disabled Save; filed beside it. The policy toggle must
not copy that API shape.

## Question 8 - What does a policy edit do to grants that already name it?

Q: Pin the policy revision so an edit invalidates old approvals, pin nothing so an edit widens or
narrows live approvals at once, or revoke every grant on any edit with no revision at all?

A: Pin the one gateway-assigned revision. Any edit ends the approvals that named the policy, a
rename included. Held loosely; revisit once the phone UI exists.

> A I guess. hard to say without feeling it

The safe direction is the one chosen: everything invalidates now, and if a rename turning out to
sting is what "feeling it" reveals, exempting renames later narrows invalidation, which is a small
change. The reverse, tightening after grants have been widened silently, is not. Loop back after
the phone phase.

Recommendation reason, adopted: one counter, the one optimistic concurrency already needs; a
second semantic revision creates a standing classification duty where a mistake is a security
defect; a runbook rename already ends a routine's pin today.

### Research, Sol attacking its own recommendation, verified where marked

**Pinning is warranted, and the exposure is `session`.** Editing a policy says which operations
are eligible for approval; granting a session says which authority one holder received. Under no
pin, one edit silently widens every active session grant naming the policy, and the owner never
revisits those holders. A `window` grant keeps its original `coveredShapes`, so it is not the
problem; a policy-scoped session grant would read the policy's current shape set.

**Revoke-on-edit alone is insufficient.** Policy and grant stores are durable but not committed
together. A crash after the policy write and before the grant prune leaves stale grants durable.
Revision equality in `covers` is the invariant that survives that crash.

**One revision, not two.** Verified: `sameContent` in the runbook store compares `name`, so a
runbook rename bumps its revision; a routine pins `approvedRevision`; `pinIsHeld` rejects any
mismatch and the routine's standing grants drop. A runbook rename already invalidates a routine's
authorization. A policy rename invalidating approvals is the same rule, and a separate semantic
revision would create a standing classification duty for every present and future field, where a
misclassification is a security defect. Renames are rare; one extra approval is the price.

**Disable is dormancy, not death, without a pin.** The resolver refuses a disabled policy, so
`covers` is never reached through it; but re-enabling revives every unexpired grant. Disable
commits N+1 and enable N+2, so a grant at N covers neither. `covers` checks the revision itself
rather than trusting the resolver, since the authority gate defends its own invariant.

**Siblings the invariant needs:**
- `GrantScope` and policy-qualified `VaultGrant` carry `policyRevision`, following the dated
  optional-field convention the grant schema already uses for `holder`.
- A pending policy-resolved request carries `policyId` and `policyRevision`; `requests.find`
  includes both in request identity, or a retry after an edit joins a stale request.
- `requests.answer` re-resolves existence, enabled state, binding, selector ownership and exact
  revision before opening the value or minting a grant.
- A policy change or deletion retracts its pending requests and removes its policy-qualified
  grants, never entry-wide `vault_run` or routine grants.
- Startup: a `policiesListed(id -> revision)` counterpart to `entriesListed`. Runtime: a
  `policyMoved` and `policyDeleted` counterpart to `entryDeleted`.
- **Write order:** commit the new policy revision first, so old grants fail equality at once, then
  prune grants and retract requests. Reversed, a failed policy write destroys valid grants.

**What the owner sees:** only current active grants. A bump removes its old policy-qualified grants
eagerly, and `list` reconciles or filters mismatches before answering, so the tab never shows a
dead grant as live. Revision numbers stay out of the tab; history belongs in an audit, if ever.

### Research for Question 5, Luna then Sol, verified where marked

**How coverage leaks today.** Verified from `covers`: a `session` grant returns true on entry match
alone, so approving `sudo apt` through one policy answers every other policy on that entry for the
session. `window` checks `coveredBy` against the shapes `operationSet` named, so distinct shapes do
not leak. `standing` is entry-wide while the routine is live. `vault-decisions.test.ts` pins
"session covers every shape".

**Luna picked entry-keyed:** window already limits to the operation set, session is documented as
broad, policy-keying duplicates window. Sol rejected all three reasons.

**"Session is intentionally broad" is historical, not semantic.** Verified: `VaultRequestSheet`
offers one operation, one entry, and a tier labelled only "This session". Nothing tells the owner
that approving `sudo apt` unlocks every policy sharing the password. Once policies exist, that is
the exact surprise an intent guard prevents, and grouping commands into separate policies would
have no approval consequence whenever they share a credential.

**Window and policy are orthogonal.** Window bounds shapes and time. Policy bounds which
owner-authored unit those shapes belong to. Session records no shape set, so a policy qualifier is
its only command boundary.

**Policy-only grants would break routines.** `linkedEntries` mints an entry-wide standing grant;
sudo inside that routine's session resolves through a policy; if an entry grant could not cover a
policy scope, the routine would stop answering. So the two scopes form a hierarchy, not two
mechanisms: an entry-wide grant may cover policy-resolved use of that entry, and a policy grant
never covers direct `vault_run`.

**The third shape.** Grants keep `entryId` and gain an optional `policyId`. `GrantScope` carries
it; `use` builds a scope without one, policy-resolved askpass with one; `grant` copies it into
window and session grants. `covers` adds one line after the entry check: a grant with a `policyId`
covers only a scope resolved through that policy. `setRoutineGrants` and `entriesListed` need no
change, since every grant still carries `entryId`.

**Siblings that move with it, all verified:**
- Pending requests carry `policyId`, because `composeVault.onApproved` mints the grant from the
  stored request and would otherwise lose the policy before approval.
- `requests.find` joins on kind, entry and session; it must compare `policyId` too, or a request
  under a re-resolved policy joins an old one's.
- Policy deletion needs the equivalent of `entryDeleted`, and startup reconciliation the equivalent
  of `entriesListed`.
- A pending request whose policy is deleted or no longer authorizes the operation must not mint a
  policy grant on approval. Fail closed.
- `GrantRow` on the phone keeps the entry title and must name the policy on a qualified grant.

**What "This session" then means:** every shape this policy names, for this session. A separate
"this credential for this session" choice can be offered explicitly if ever wanted, never smuggled
under the existing label.

### Research for Question 4, Luna then Sol, verified where marked

**In-place edit keeps the id.** Verified: `createVaultService.put` CASes on `expectedRevision`,
writes the same id, bumps the entry revision. `VaultOps.save` sends the draft's existing id and
`sealDraft` reseals under it.

**Every grant tier survives a value edit.** Verified from `createVaultClient.refresh`: `onEntryGone`
fires only when a live id disappears or tombstones, and `entriesListed` drops only absent ids. So
rotating a value does not revoke authority. Sol's reading: correct for an intent guard. A grant
authorizes a holder to use a credential, not one ciphertext or revision. If the old value leaked,
rotation invalidates it and trusted routines keep working. If a consumer is suspect, the owner
revokes the grant; rotating the password was never going to fix that. No re-approve-on-edit flag.
The escape hatch is a new entry id plus revocation.

**So A must mean something specific:** an entry id denotes one logical credential across value
revisions. The vault's own AAD already binds every sealed field to the entry id, which supports
that reading. This is authorization semantics, stated in the record's docs, not a vault rule.

**Open requests are a sibling.** A pending request records only `entryId`, and `collect` refreshes
and opens the latest value, so an approval opened before a rotation delivers the new value after
it. Consistent with the reading above; any value-bound alternative would have to bind requests too.

**Sudo never needs two live values.** A covers it fully.

**SSH two-key overlap is not unmodelable, it is unsent.** The helper receives the ssh prompt, which
usually carries the key path, but `GatewayPort.askpass` sends only the command line and the asker.
A credential hint in the request would let `(ssh host, key hint)` select an entry. That extends the
selector, not the binding; each rule still names one entry. Hint only, fail to typed when absent.

**What A closes:** staged cutover with both values live, and immediate rollback. Those matter only
if credentials roll across machines gradually. Several machines sharing one password, or each
holding its own entry, are both served by A. D is a vault redesign with no established need. C
stays rejected.

**Sol's warning, carried to the design:** do not pick A because grants happen to be keyed by entry
id; that preserves the coupling this record exists to remove. Decide whether a grant on the askpass
road authorizes the entry or the policy. If the policy, grants name a policy id and rebinding needs
no grant migration. Represent the target as `binding: { kind: "entry", entryId }`, an honest
extension point, never a bare `entryId`.

**Every binding that shares the rotation story:** grants, `Routine.linkedEntries` and the standing
grants `setRoutineGrants` mints from it, pending requests, a `vault_run` in flight, and routine
attention rows that name an entry a run could not obtain.

# Plan

Refined by one lap of `plan-refinement`: eight Luna angles, a collate, Sol refuting every
survivor, then triage against the code. Every phase ends green on `bun run lint`, `bun run test`,
`./scripts/kotlin-gate.sh`, `bun run check:boot` and `bun run check:fixtures`, and CI is checked
after the push.

**Deploy order and the wire rule, corrected in the lap.** Gateway first, plugin second, phone on
its own cadence. Fields on the new policy record and its operations are required: no older peer
ever reads them. `policyId` and `policyRevision` on a grant, a scope and a request are optional
by meaning and carry no date: they are permanently absent from a typed request, a bare `vault_run`
and every entry-wide grant, and present together or not at all. Nothing here changes what the
Router answers, so the Router does not deploy first. A phone whose Gateway answers `unsupported`
to a policy operation treats that as feature absence for that Gateway: draws nothing, refuses
nothing, keeps the Gateway's other groups.

The record is a **policy**; its selector field is `selectorKeys`, never `shapes`, so
`operationSet` is never mistaken for it. Where the word crosses vault or routine code, which
already use it for other things, qualify it: `authorizationPolicy`.

## Phase 0 - Wire truth

✅ Complete. `cfb4f591` the wire, `9a83899c` the map and docs. Every gate green, CI green.

- `src/shared/schemasPolicy.ts`: `id`, `name`, `binding: { kind: "entry", entryId }`,
  `selectorKeys`, `enabled`, `revision`. No `since`: nothing walks a policy's history. Bounds
  beside `RoutineSchema`'s and `VAULT_SHAPES_MAX`: id and name length, selector length and count,
  policies per Gateway.
- **One canonicalization pipeline.** The phone sends typed examples. The gateway derives each key
  through `selectorKey`, the `displayShape` of the example; refuses an empty or over-limit example;
  refuses duplicate keys after canonicalization; stores keys only. `policyRefusal` refuses a record
  for what it means: no shapes, an example that yields no key, duplicate keys. The phone adopts the
  stored record, so it needs no Kotlin twin of the key rule.
- **The key is what askpass presents.** The helper drops sudo's `-A` and `--askpass` before the
  gateway shapes a line, so an owner typing `sudo -A apt update` as they run it must key as
  `sudo apt`. `withoutAskpassFlags` in `selector-key.ts` is the one walk; `askpassBrief` and
  `selectorKey` both call it. `shapeFrom` and `basenameOf` moved there from the gateway for the
  same reason, and `displayShape` is now an alias of `selectorKey`, kept because it names the
  askpass side of the seam and is a wire field name.
- **Field ownership.** Create assigns revision 1. An edit increments from the held record. The
  incoming revision is a base to check, never a value to store. `REVISION_CEILING` refuses as the
  runbook store does.
- Console operations and result schemas, mirroring `RunbookConsoleHandlers` and
  `RoutineConsoleHandlers`: list, sorted by name then id under the stores' locale rule; put with a
  base revision, answering `{ stored, revision, policy?, reason? }`, the full record on success or
  an idempotent repeat and the held revision on refusal; delete with a base revision, answering
  `{ deleted, reason? }`, since a base can be stale and a routine's `{ deleted }` carries no base
  to be stale against; enable with a base revision, answering the full put result. Refusal reasons are
  phone-facing contracts: stale, overlap naming the holder, deletion fence. No operation answers a
  bare boolean, and none lacks a base revision.
- `Protocol.kt` in the same commit. The gate for a console operation's answer is
  `console-result-codegen.test.ts`, which refuses any answer in the result union without a
  generated Kotlin type, plus the Kotlin gate. The wire-fixture corpus covers Router composers,
  not console operations, and routines have none there; the lap's fixture line was over-specified
  and is withdrawn. `check:fixtures` still runs and stays green.

## Phase 1 - Gateway store

- `src/gateway/policies/store.ts`, sole writer through `openDurable`, modelled on the routine
  store. Gateway-assigned revision; stale base refused with the held record; a lost answer's repeat
  idempotent. **No overwrite**, as routines have none; a stale save is refused and the phone
  rebases.
- **Deletion fence copied from runbooks, not routines:** the deleted revision is remembered only
  after a successful commit, bounded at `MAX_BURIED`, not durable across a restart. Stated so
  nobody expects more.
- **Commit contract copied from the routine store:** rollback on an ordinary save failure;
  `DurableStoreInstalledError` treated as success; `onChanged` fires only after the snapshot is
  installed, and never on a failed save. Subscribers named: vault decisions prune that policy's
  qualified grants, then vault requests retract its pending requests.
- Context refusal: an enabled policy's keys may not intersect the union of every other enabled
  policy's keys, and the refusal names the holder. The binding stays a soft reference at save: a
  bound entry that is absent, valueless or not allowed here leaves the policy unresolved, never
  refused.
- **The migration fence does not reach this store.** The fence holds Router-bound writes while the
  Router moves. `saveChecked` writes the gateway's own disk at once, not through the fenced flush,
  which is the standing the runbook, routine and capability stores have in the residue test. No
  fence check on policy writes, nothing added to the residue test.
- **Composition.** `composePolicies.ts` builds the store and its console operations, and exposes
  `onPolicyMoved` as the seam the vault reads. Phase 1 leaves the seam unconnected. Phase 2 builds
  `policyMoved`, `policyDeleted` and `policiesListed` on the vault and owns the wiring:
  `composeGateway` hands `onPolicyMoved` to the vault through its late-bound stage pattern, and the
  initial `policiesListed` reconciliation runs once both exist and before the listener opens.
- Tests: overlap on save and on enable; disable, enable another over the freed key, re-enable
  refused; stale base on put, enable and delete; the deletion fence; canonicalization of typed
  examples. Key derivation, with its prefix, substring and case cases, is pinned by Phase 0's
  `schemas-policy.test.ts`; Phase 1 pins the resolver's exact-match lookup against stored keys.
- **Restore validates what a put validates.** A file holding two enabled holders of one key, a
  duplicate id, a non-canonical shape or more than the cap loads as if it were unparseable: the
  store starts fresh and the next write heals the file. The runbook and routine stores load on the
  schema alone; that class is under Painpoints, not fixed here.
- **Set aside from the red team.** The deletion fence's non-durability needs the Router to redeliver
  a settled `value_op` after a gateway restart; `inboxFrames.ts` sends one once and times it out,
  so the delayed put cannot arrive. The stated limit stands. `selectorKey` and `askpassBrief` differ
  on a path-prefixed or multi-word line, and the gateway keys the brief with `displayShape`, which
  is `selectorKey`, so the resolver compares key against key. A test pins
  `selectorKey(askpassBrief(line)) === selectorKey(line)`.
- **From the architecture audit.** The field is `selectorKeys`; "shapes" sent every auditor to
  `operationSet`. `dispatch` in `consoleHandler.ts` ends in a `never` default. Set aside: a salvage
  restore that disables a poisoned file's conflicting records and keeps the rest, because the
  gateway is the sole writer and a fresh start is loud and safe; required console stage deps,
  because the harness builds partial ones; a typed moved-or-deleted event, because the vault reads
  the store back as routines read runbooks. On the board, claimed: the commit, echo and fence
  mechanism the three stores copy; restore validation for the runbook and routine stores, after the
  owner's live files are checked.

## Phase 2 - Grants and requests learn policies

- `GrantScope` and `VaultGrantSchema` gain `policyId` and `policyRevision`. **Holder invariant,
  enforced in the schema and in `covers`:** a policy-qualified grant is session-held and `window`
  or `session` tier; a routine's standing grant is entry-wide and never carries policy fields; the
  policy check runs before the holder branch.
- `covers`: after the entry check, a grant carrying a policy covers only a scope resolved through
  that policy at that revision. Entry-wide grants stay broader. A policy grant never covers a bare
  `vault_run`.
- **`composeVault.onApproved` copies both policy fields from the request into the scope**, with a
  test that the minted grant is still qualified.
- `VaultRequestSchema` gains both fields. `requests.find` includes both in identity. **A
  synchronous validation callback runs in `requests.answer` before `onApproved`:** the policy
  exists, is enabled, is bound to the same entry, owns the selector, and is at the exact revision.
  Otherwise fail closed with no grant. The store's `onChanged` reaches requests through
  `policyMoved` and `policyDeleted`, which retract that policy's pending requests.
- **`settle` re-resolves the entry through `usable` at settlement, as `collect` already does:**
  existence, value, `allowedHere`, opening the current envelope. `decide` loses its request-time
  value thunk so the stale road cannot return. This closes bd_58e0ecbe in passing.
- Decisions: `policiesListed(id -> revision)` at startup beside `entriesListed`; `policyMoved` and
  `policyDeleted` beside `entryDeleted`; each prunes only policy-qualified grants. `list` takes a
  current-policy resolver and excludes a qualified grant whose policy is gone, disabled, rebound or
  at another revision. Write order everywhere: policy first, then prune.
- Named tests in `vault-decisions.test.ts`: a policy grant excludes a bare `vault_run`; an entry
  grant covers a policy scope; a value revision preserves grants; a policy revision invalidates
  qualified grants and not entry-wide ones; rename, disable and re-enable each invalidate.
- **The crash window has a test.** A harness fault case commits a policy revision, dies before the
  prune, reopens the gateway, and proves the old qualified grant cannot cover. Its twin proves a
  failed policy commit leaves old grants intact.

### Bug Classes

- **A request-time snapshot used at settlement.** `settle` opens the envelope captured when the
  request opened, and never re-checks `allowedHere`. Shipped today as bd_58e0ecbe. Mechanism: a
  value thunk threaded through `decide`. Phase 2 removes the thunk rather than guarding it.

## Phase 3 - The resolver, and the clean break

- The askpass handler's `matches` block goes, with its comments at 261 and 273. In its place:
  exactly one enabled policy for the selector key, whose bound entry exists, holds a value and is
  `allowedHere`, opens an entry request carrying the policy and revision; no policy, a disabled
  policy, an unresolved binding, or any unreadable state opens a typed request. Never a title.
- `federation-harness-vault-requests`: 262 becomes no matching policy; 324 proves a matching title
  alone selects nothing; 373 proves capture changes nothing, with its comment at 365 rewritten.
  Add unique match, overlap, disabled, missing entry, `allowedHere` on a fresh use, and
  `allowedHere` re-checked when a pending request is answered after the allowlist changed.
- `docs/vault.md` 39 to 41, 108 to 112, 229 to 230; `docs/testing.md` 98; the `decisions.ts`
  comment at 40. Titles are labels, policies select, capture never creates a policy.

## Phase 4 - Phone

Prerequisite: fix bd_ee0449e2 first, both defects on the routine toggle, the refusal swallowed to
a Boolean and no base revision on enable, so the policy toggle copies a corrected pattern. Do not
repeat bd_26895814 in the policy editor; if the shared save-gate presentation is built here, adopt
it in all three editors.

- `ChatState`: `GatewayPolicies`, `state.policies`, `policiesOn(gatewayId)` and
  `policyOn(gatewayId, id)`, with JVM state tests beside the runbook and routine ones.
- Wiring, every piece named: `ConsoleClientPolicies.kt`; a `PolicyGateway` port in
  `RepositoryPorts` and its adapter in `RepositoryCollaborators`; `ChatRepositoryPolicyHost`;
  `ChatRepository.policyOps`. Refresh on tab entry and after every mutation. No background drain
  refresh, since a policy has no schedule the phone must watch.
- `PolicyOps.kt`: every method names its gateway; a `GatewayReadFence` per gateway; `refreshAll`
  fanning out and pruning against `state.admittedGateways` only. Any refusal of `policy_list` is
  feature absence for that Gateway, drawn as nothing and never as broken: an older gateway answers
  an unknown op kind with a raw parse refusal and no stable code, and the owner runs two Gateways
  that update on different days. Nothing held on the phone. JVM tests for every operation and
  state transition.
- `PolicyDraft.kt` beside the ops class holds the pure refusal, per the rule that a decision the
  phone makes never lives in a screen.
- **A pure `allowedOn(entry, gatewayId)` read beside the vault view model**, covering the everyone,
  listed and unreadable cases, feeds the editor's binding picker.
- `MainTabsScreen`: the Policies tab. `MainActivity`: policy edit state, back precedence, the
  editor route, open and close callbacks.
- `policies/PoliciesScreen.kt`: a Gateway heading per group when more than one, the enable toggle
  showing the gateway's reason on refusal, `NewOnGatewayFab` reused. `policies/PolicyEditor.kt`:
  name, the binding picker, selector shapes as chips from typed examples, enabled; the draft's
  refusal at the field, the gateway's in the editor as a runbook save's.
- `GrantRow` names the policy on a qualified grant. `VaultRequestSheet`: the comment at 93 goes;
  Send and save creates an entry only and says so.
- **Sandbox.** `SandboxGateways` answers the policy calls differently per seeded Gateway, and
  `SandboxApp` seeds vault entries with distinct allowlists, so the picker, an unresolved binding,
  an overlap refusal and a toggle refusal are all reachable.
- `./scripts/kotlin-gate.sh`, regenerated wire fixtures, a debug APK on the phone.

### Bug Classes

- **A gateway answer flattened to a Boolean before the screen sees it.** Two instances on the
  routine toggle (bd_ee0449e2) and one across the editors (bd_26895814). Mechanism: the phone ops
  class. Phase 4 must not add a third.

## Phase 5 - Docs and map

- `docs/policies.md`: the record, the selector key and its one pipeline, the store's refusals and
  commit contract, the resolver's outcomes, what a grant carries and the holder invariant, the
  write order, and what "This session" now means.
- `AGENTS.md` map entries for every new file, and the rules that hold: one policy per selector key;
  policy first, then prune; entry-wide over policy-scoped; a policy grant is session-held; capture
  never creates a policy; settlement re-resolves.
- Revisit Q8 with the phone in hand, on a provisioned device against the real Router: does a rename
  ending approvals sting?

## What the lap set aside

Sol's verdicts, adopted after checking: overwrite is not ambiguous, routines have none and policies
follow them; binding validation at save relitigates the soft reference; the compat rule does not
need capability negotiation, since the gateway deploys first; the emulator cannot reach the Q8
revisit, but the plan never proposed it; a cross-version CI matrix is not a gate this repo has;
list ordering follows from the model; a docs-phrase gate would test wording, not truth; the word
policy collides only locally. The Router-fence finding did not survive my own check either: the
fence contract says writers enforce it, and the durable writer does, so it is inherited.

## Painpoints

Collected as the phases land. Not fixed here.

- **The helper and the gateway agree by convention across the askpass seam.** The askpass flag walk
  now lives in `selector-key.ts`, shared by `askpassBrief` and `selectorKey`. The class remains: the
  `asker` format `askerOf` mints and `requests.ts` parses, and `secretPrompt`'s notion of which
  prompts reach the phone, are conventions the two sides keep in separate files with no shared
  declaration and no fixture pinning both.
- **`dispatch` in `consoleHandler.ts` is a switch with no exhaustiveness guard.** An op kind added to
  `ConsoleOpSchema` and `VALUE_OP_KINDS` with no case compiles, and the op answers `undefined`. The
  answer side is fenced by `console-result-codegen.test.ts`; the dispatch side is fenced by nothing.
  A `never` default would make the missing case a type error.
- **The runbook and routine stores restore on the wire schema alone.** A file with a duplicate id,
  or a record `runbookRefusal` or `routineRefusal` would refuse, loads, and an edit of a duplicated
  id rewrites every record that shares it. The policy store validates on restore; its siblings do
  not.
- **`routine_enable` carries no base revision**, so a stale toggle wins where a stale put is refused.
  On the board as bd_ee0449e2. The policy operations carry one.
