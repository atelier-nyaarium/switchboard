# Authorization policies

A policy names the vault entry that answers a command shape on one Gateway. Each use still takes
an owner approval or a covering grant. The vault itself, the grants and the request road are in
`docs/vault.md`; this file is the policy record, its store, and what the resolver does with it.

## The record

`src/shared/schemasPolicy.ts`, `AuthorizationPolicy`:

| Field | Meaning |
|---|---|
| `id` | The owner's handle, at most 64 characters, no slash or line break |
| `name` | A label, at most 128 characters; it selects nothing |
| `binding` | `{ kind: "entry", entryId }`, the secret it answers from |
| `selectorKeys` | One to 64 canonical keys, each a command shape this policy answers |
| `enabled` | A disabled policy answers nothing and keeps its keys |
| `revision` | Named by the Gateway on every write |

A policy lives on one Gateway, in `DATA_DIR/policies.json`, written only by
`gateway/policies/store.ts`. A Gateway holds at most 256. The store does not validate the binding:
an entry that is missing, empty or shut to this Gateway makes askpass open a typed request, and a
save is never refused for it, since the vault and the policy store are written on different days.

## The selector key, one pipeline

`src/shared/selector-key.ts` is the one rule, and both ends of the askpass seam walk it:

1. `withoutAskpassFlags` drops sudo's `-A` and `--askpass`, as the helper's brief does.
2. `selectorKey` also drops sudo's end-of-options `--`, which the brief keeps, since the brief
   shows the owner what ran and the key says what was meant.
3. `shapeFrom` keeps the program's basename and its first argument; when that argument is a flag,
   the whole line, since a flag's value could hide the target. Case is kept.

So `sudo -A apt install foo` keys as `sudo apt`, and so does the helper's brief of it. The phone
sends examples as the owner typed them; `canonicalPolicy` derives the keys and the stored record
holds keys only. `policyRefusal` expects keys: it refuses an empty list, a key that names no
command, a key that is not canonical, and a key named twice. A put canonicalizes first, so only a
restore meets a non-canonical one. `schemas-policy.test.ts` pins
`selectorKey(askpassBrief(line)) === selectorKey(line)`.

## The store

`createPolicyStore` in `gateway/policies/store.ts`. Frozen records; `list` sorted by name then id;
`get`; `byKey`, the one enabled policy naming a key, unique by construction.

**Refusals.** `policyRefusal` on the record; then `contextRefusal`: over the cap, or an enabled
policy whose keys another enabled policy already holds, refused naming the holder. Overlap is
unrepresentable, so the resolver never meets one. A disabled policy may hold anything; enabling it
over a taken key is refused on the toggle with the holder's name.

**The base rule.** Every mutation carries the revision the phone read: `put` optionally, `remove`
and `setEnabled` always. A put with no base creates; one with a base on an id nothing holds is
refused. A base that is not the held revision is refused with what is held. A repeat of the stored
content is a lost answer and answers stored: at the stored base, or as a base-less first write
while revision 1 is held. A deleted id is buried for the process's life, so a delayed put cannot
land it back; the fence is not durable, and the Router sends a value op once. `setEnabled` is a
whole-record put at the base the phone read, so a stale toggle is refused like a stale put.

**Commit.** On disk before reported: `saveChecked`, then `onChanged`. A `DurableStoreInstalledError`
is success. A failed write rolls the memory back and answers "could not be written". Restore
refuses anything a put could not have written, and a file that fails it starts the store fresh, as
an unparseable one does, since fewer policies is the safe direction.

## The resolver

`/vault/askpass` in `gateway/vault/vaultRoutes.ts`. **A policy selects; a title is a label.**

1. The line's selector key is looked up with `byKey`.
2. The bound entry must exist, hold a value and be allowed on this Gateway (`usable`).
3. Then an entry request opens carrying `{ policyId, policyRevision }` at the revision held now.
   A grant that covers it answers at once.
4. Anything else opens a typed request: no policy, a disabled one, a binding this Gateway cannot
   use. The owner types a value that is handed over once, and nothing is recorded.

A capture creates an entry and never a policy. Nothing a session writes can become a selector.

## What a grant carries

A grant and an entry request carry one optional `PolicyRef` on the wire, and a scope carries it in
memory, so half a qualification cannot exist.

- **`covers` checks the policy before the holder.** A qualified grant covers only a scope the same
  policy resolved at the same revision, never a bare `vault_run`. A window under a policy covers
  only the one key it was given for, whatever else the line ran. An entry-wide grant covers a
  policy scope as it covers any other, so entry-wide is the broader authority.
- **Only a session holds a qualified grant.** `policyGrantIsSessionHeld` in `schemasVault.ts`
  refuses a standing grant with a policy; a routine's grant is entry-wide.
- **`qualificationRefusal` is the one reading of why a policy stops answering:** gone, disabled,
  rebound to another entry, no longer naming the selector, or at another revision. `requests.answer`
  runs it at the tap before any grant is minted, and a refused request carries the reason to the
  phone. `policyMoved` prunes the grants and retracts the requests a policy qualified;
  `policiesListed` does the same at startup over the store's whole list. `vault_grants` shows what
  is stored, so a prune that failed to write is visible.
- **The value is read as it leaves.** `release` runs `usable` again at settlement, so an entry
  rotated, emptied or shut while the request waited answers with the current value or a refusal.

## The write order

The store commits the new revision to disk, then `onChanged` reaches `onPolicyMoved`, and the
vault retracts the policy's pending requests and prunes its grants. The vault is told only after
the write is on disk, so a failed write prunes nothing. A crash between the two leaves grants at
the old revision, which no scope the moved policy resolves will match in `covers`, and
`policiesListed` prunes them at the next start.

Every landed write moves the revision, a rename included, and ends the approvals that named the
one before it. One counter, the one the base rule already needs, and no second semantic revision
to misclassify.

## What "This session" means

On a request a policy resolved, the sheet's session tier records a grant qualified by that
policy: the session may run anything the policy answers, until the session ends, eight hours pass,
or the policy moves. It never covers a bare `vault_run` on the entry. A helper's session tap is
recorded as a window, which under a policy covers only the one key, since every process on the
host shares the helper's token.

## Console operations

`policy_list`, `policy_put` (base optional), `policy_delete` and `policy_enable` (base required),
dispatched in `gateway/console/consoleHandler.ts`. A put or enable answers `stored`, the held
revision, the record to adopt, or a reason; a delete answers `deleted` or a reason. The phone's
view and editor are in `docs/console.md` under Android app.

## File map

- `src/shared/schemasPolicy.ts` - the record, its bounds, the three console answers, `canonicalPolicy`, `policyRefusal`.
- `src/shared/selector-key.ts` - the key pipeline the helper's brief and a policy's keys both take.
- `src/gateway/policies/store.ts` - the store: refusals, the base rule, the buried set, the commit.
- `src/gateway/compose/composePolicies.ts` - the stage, its console operations, `onPolicyMoved` and `onPoliciesListed`.
- `src/gateway/vault/vaultRoutes.ts` - the askpass resolver.
- `src/gateway/vault/decisions.ts`, `requests.ts` - `covers`, `qualificationRefusal`, `policyMoved`, the tap validation.
- `src/__tests__/policy-store.test.ts`, `schemas-policy.test.ts`, `vault-decisions.test.ts`, `federation-harness-vault-requests.test.ts`, `federation-harness-policies.test.ts` - the gates.
- `android/.../PolicyOps.kt`, `policies/` - the phone's view, editor and draft.
