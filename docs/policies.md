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

`src/shared/selector-key.ts` is the one rule, and both ends of the askpass seam walk it. One parse
of a sudo line, `parseSudo`, reads sudo's options once: flag letters, a valued flag's value
attached or the next word, long options with or without `=`, `--`, then the command. The askpass
flag goes as a letter, never out of a value, so `sudo -uAlice bash` keeps its user.
`withoutAskpassFlags`, `selectorKey` and the warning (`sudoCommand`) all read it.

1. `withoutAskpassFlags` drops sudo's `-A` and `--askpass`, as the helper's brief does.
2. `selectorKey` also drops sudo's end-of-options `--`, which the brief keeps, since the brief
   shows the owner what ran and the key says what was meant. It keeps it before a dash-led command,
   where the next read would take that word as an option. A `--` that is the program sudo runs,
   past any assignments, stays, so `sudo -- -- bash` keys as its whole line; later ones go.
   So a key reads back as itself, which `schemas-policy.test.ts` pins over every line of up to four
   words from a set of awkward tokens.
3. After `sudo`, once the askpass flags are gone and no option of sudo's own leads, leading
   `VAR=value` words are dropped and the wrappers in `shared/command-wrappers.ts` peeled, the table
   a window grant peels with. Whatever does not peel to a program keys its whole line: a wrapper
   left running a string, such as `env -S`, and assignments with no command or a flag after them.
4. `shapeFrom` keeps the program's basename and its first argument; when that argument is a flag,
   the whole line, since a flag's value could hide the target. Case is kept.

So `sudo -A apt install foo` keys as `sudo apt`, and so does the helper's brief of it, and
`sudo env DEBIAN_FRONTEND=noninteractive apt-get install foo` keys as `sudo apt-get`. A shell is
not a wrapper: `sudo sh -c …` keys as `sudo sh`. The phone
sends examples as the owner typed them; `canonicalPolicy` derives the keys and the stored record
holds keys only. `policyRefusal` expects keys: it refuses an empty list, a key that names no
command, a key that is not canonical, and a key named twice. A put reads the typed examples with `examplesRefusal` before it canonicalizes, since the
keys no longer say which command collided, then canonicalizes, so only a restore meets a
non-canonical key. `schemas-policy.test.ts` pins
`selectorKey(askpassBrief(line)) === selectorKey(line)`.

## The store

`createPolicyStore` in `gateway/policies/store.ts`. Frozen records; `list` sorted by name then id;
`get`; `byKey`, the one enabled policy naming a key, unique by construction.

**Refusals.** A write's refusal is a code with its facts, never prose alone: `POLICY_REFUSAL_CODES`
(`same_command`, `taken`, `no_command`, `none`, `full`, `too_many_commands`, `command_too_long`,
`invalid`, `moved`, `gone`, `deleted`, `spent`, `unwritten`) and `PolicyRefusalSchema`, whose
optional facts are `example` (as typed), `key`, `policy` (the other policy's name) and `max`. `put`
and `remove` answer it as `refusal` beside `reason`, and `refusalReason` writes that `reason` from
the same facts for a phone that reads no code. `examplesRefusal` names the typed example that
repeats a key or names no command; `policyRefusal` on the record guards the store; then
`shapeRefusal` parses the candidate through `AuthorizationPolicySchema`, as restore will, so
nothing a put takes can fail restore: more than `MAX_SELECTORS_PER_POLICY` keys is
`too_many_commands`, a key over `MAX_SELECTOR_LEN` is `command_too_long`, anything else that does not
parse is `invalid`. The vault's remember hands the store records no op schema parsed, which is why
the store checks for itself. Then `contextRefusal`: over the cap (`full`), or an
enabled policy whose keys another enabled policy already holds (`taken`), naming the holder. Overlap is
unrepresentable, so the resolver never meets one. A disabled policy may hold anything; enabling it
over a taken key is refused on the toggle with the holder's name.

**The base rule.** Every mutation carries the revision the phone read: `put` optionally, `remove`
and `setEnabled` always. A put with no base creates; one with a base on an id nothing holds is
refused. A base that is not the held revision is refused with what is held. A repeat of the stored
content is a lost answer and answers stored: at the stored base, or as a base-less first write
while revision 1 is held. A deleted id is buried for the process's life, so a delayed put cannot
land it back; the fence is not durable, and the Router sends a value op once. `setEnabled` is a
whole-record put at the base the phone read, so a stale toggle is refused like a stale put.

**Commit.** On disk before reported, through `commitChecked`: the file, then memory, then
`onChanged`. A `DurableStoreInstalledError` is success. A failed write leaves memory as it was and
answers "could not be written". A throwing `onChanged` is logged; the write stands. Restore drops a
key it cannot hold, one that is no longer its own `selectorKey` or is over `MAX_SELECTOR_LEN`, from
its policy, with one log line naming the policy and the count, and drops a policy left with none,
since a record holds at least one key. It never re-keys one, which could select lines the owner never
approved. A pruned policy takes the next revision, so a phone saving over the revision it read
gets `moved` and re-reads rather than putting a dropped key back; one already at the ceiling keeps
it, since every put to it is `spent` anyway. The cleaned file is written back. So a change to the key rule narrows: those lines ask
again with a typed card. Anything else a put could not have written (a duplicate id, two enabled
holders of one key, more than the cap) starts the store fresh, as an unparseable file does, since
fewer policies is the safe direction.

## The resolver

`/vault/askpass` in `gateway/vault/vaultRoutes.ts`. **A policy selects; a title is a label.**

1. The line's selector key is looked up with `byKey`.
2. The bound entry must exist, hold a value and be allowed on this Gateway (`usable`).
3. Then an entry request opens carrying `{ policyId, policyRevision }` at the revision held now.
   A grant that covers it answers at once.
4. Anything else opens a typed request: no policy, a disabled one, a binding this Gateway cannot
   use. It says which as `why` (`no_policy`, `policy_off` with the policy, `binding_unusable` with
   the policy, its entry and `unusable`), and carries `runsAnything` when the key runs a shell or
   `su`, or sudo's own options ask for one (`-s`, `-i`, `--shell`, `--login`), read past the options
   that take a value. It sees through what the key sees through, assignments, wrappers and a
   nested sudo (`runsAnything` in `gateway/vault/decisions.ts`). A warning, never a block.

A capture creates an entry and never a policy. A session's line becomes a selector only through
the owner's tap on a card that prints the key.

## Remember

`vault_answer_entry` answers an open typed request from a held entry, and with `remember` writes
the request's key into a policy. `answerEntry` in `gateway/compose/composeVault.ts`, after
`use.ready()`, synchronous from there, so a refusal leaves everything as it was:

1. The request is live and typed, else `expired`, `answered` or `not_typed`, and it is claimed
   (`claimTyped`): its life is read this once, so what is written after is answered, never refused
   `expired` by a deadline passing meanwhile. Every refusal below gives the claim back (`unclaim`),
   and the request then lapses on its own deadline as before.
2. The entry is `usable` here, else `unusable` with its code.
3. With `remember`, the key is the request's own `displayShape`, and it must be what the store
   would hold: its own `selectorKey` fixed point and within `MAX_SELECTOR_LEN` (`rememberable`), else
   `cannot_remember`, with `max` when it is too long. The key stored is the key shown.
4. `rememberedPolicy` (`gateway/vault/remember.ts`): a `name` creates a policy under the phone's
   id, bound to the entry; no `name` adds the key to that policy at the revision held at the tap,
   since an append needs nothing the card's revision protects. It never enables, rebinds, or
   touches a policy bound to another entry (`bound_elsewhere`, `target_off`); an add to a policy
   gone is the policy refusal `gone`. A policy that already names the key, enabled and bound to the
   entry, is not written: that is the retry. A create over another held id is the store's `moved`.
   The store's put follows, and its refusal answers as `policyRefusal`.
5. The request settles approved from the entry, qualified by the policy at its new revision, so
   `window` and `session` grant as on an entry request. Without `remember` only `once` is taken.

The write ends that policy's other approvals, as any landed write does, and the reconcile below
keeps every open entry request it still selects.

**What the card offers:** a typed request carries `answering`, one row per usable entry bound by an
enabled policy whose keys share the request key's program, with that entry's first such policy in
name order and its revision, which is what remember adds to (`answeringOf` in
`gateway/vault/decisions.ts`). A key's program is its first word (`keyProgram` in
`src/shared/selector-key.ts`), so every sudo key shares `sudo`. A single row is the suggestion, and
a hand pick starts remember on when its entry has a row. None is sent for `binding_unusable`, since
the key's enabled holder would refuse remember as `taken`, nor for a key that is not `rememberable`.

## One reconcile over the open requests

`createVaultReconcile` in `gateway/vault/reconcile.ts` looks at every open request against the
committed policies, after each policy write (and its grant prune) and on every persist tick.

- **An entry request a policy resolved** (`reviseEntries` in `gateway/vault/requests.ts`), at
  once, so no tap reads a stale revision: the same revision stays; a committed policy that is
  enabled, bound to the same entry and still naming the key restates the request at its new
  revision in place (`revise` in `ownerRequests.ts`, the same id, session and deadline, after a
  tick), so the phone's card stays valid. It is refused only on a reading: the policy gone, off,
  rebound or no longer naming the key, or the vault copy held now saying the entry is unusable. No
  vault copy decides nothing, since the release reads the entry again.
- **A typed request**, only when some waiting typed request's key has an enabled policy whose entry
  the held vault copy does not call unusable (with no copy, nothing is known, and it goes on), so a
  request that cannot be taken over costs no vault read on any tick. Any vault read landing elsewhere
  (`onRefreshed` on `use.ready()`) runs the reconcile again, so an entry that became usable is seen;
  its own read triggers nothing. Then after `use.ready()`, one pass at a
  time: a request whose key `byKey` answers, with a `usable` entry, is taken over (`takeOver`). A
  vault read is bounded (each Router call times out at 120 s, two calls at most), so a pass always
  ends. A grant that covers the
  policy resolves answers it at once, from the entry, and the grant is read again as the value
  leaves. Otherwise an entry request opens first, under the typed request's own deadline, naming it
  in `replaces` and not counting it against the per-session cap, then the typed request settles
  `moved`. The waiter's next answer is `pending` with the new id, which the askpass helper collects,
  and the phone gets the usual retract and a one-tap card. A withdraw of the moved id reaches its
  replacement. A request that could not be taken over, or a pass the vault was not ready for, is
  tried again on the tick.

A policy still only selects: nothing is approved that no grant or tap covers. The remember road's own
request is claimed when the typed pass reads, so no pass takes it over, and a throw in that section
gives the claim back. The Gateway's close stops the reconcile before the flushes (`stop`), so a pass
still reading takes nothing over and delivers no row after the stages drained.

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
the write is on disk, so a failed write prunes nothing. A crash between the two, or a prune that
throws, leaves grants at the old revision. No fresh lookup resolves the moved policy to them, and
`policiesListed` prunes them at the next start. A request already waiting re-checks the scope it
captured, so it can still be covered until then.

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

- `src/shared/schemasPolicy.ts` - the record, its bounds, the three console answers, `canonicalPolicy`, `policyRefusal`, `POLICY_REFUSAL_CODES`, `PolicyRefusalSchema`, `examplesRefusal`, `refusalReason`.
- `src/shared/selector-key.ts` - the key pipeline the helper's brief and a policy's keys both take.
- `src/gateway/policies/store.ts` - the store: refusals as codes, the base rule, the buried set, the commit.
- `android/.../Reasons.kt` - `policyRefusalLine`, the phone's sentence for a code, and `policyRefusalMarks`, the chip it names.
- `src/gateway/compose/composePolicies.ts` - the stage, its console operations, `onPolicyMoved` and `onPoliciesListed`.
- `src/gateway/vault/vaultRoutes.ts` - the askpass resolver.
- `src/gateway/vault/decisions.ts`, `requests.ts` - `covers`, `qualificationRefusal`, `policyMoved`, the tap validation.
- `src/__tests__/policy-store.test.ts`, `schemas-policy.test.ts`, `vault-decisions.test.ts`, `federation-harness-vault-requests.test.ts`, `federation-harness-policies.test.ts` - the gates.
- `android/.../PolicyOps.kt`, `policies/` - the phone's view, editor and draft.
