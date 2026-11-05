# Questionaire

## Question 1 - Split watchers off run_action?

Q: Before adding more watchers, should watchers leave `run_action`, as devices did?
A: Yes.

Recommended for what the split enables rather than a duplicate removed, since `ASSISTANT_ACTIONS` is already one registry:

1. Standing rules that name no watcher: every kind declares one generic `clear`, so the Done rule stops naming `watcher/github_done` and a new watcher touches no instructions.
2. Read and act on one source in one tool: `list` (today's `inbox`), `clear`, per-kind acts, the schema in the tool rather than behind `list_actions`.
3. Kind versus instance before there are many.
4. `run_action` down to phone and Gateway capabilities.

> before we expand watchers with a bunch more, should we also split that off?

## Question 2 - Several instances per kind?

Q: Should a watcher kind be able to have several instances, such as two GitHub accounts or many RSS feeds?
A: Yes. Kind is code (source client, field specs, actions); instance is config (id, label, credentials, rules, enabled). Actions are keyed by kind and addressed to the instance an event or listing names.

Recommended because keying code by kind and config by instance is the change that gets more expensive with every watcher added.

## Question 3 - Where is a watcher added?

Q: Integrations gains a Watchers section (A), Add from Integrations with the Watchers page kept (B), or the Watchers page gets its own Add (C)?
A: A. Integrations shows Plugs, Watchers, Services; one Add covers everything; the separate Watchers page goes, and a watcher row opens today's watcher page (rules, secret, check). A watcher kind is a catalogue entry yielding events.

Recommended for one Add and one list, the same shape as plugs and IFTTT.

## Question 4 - Which kinds come next?

Q: RSS/Atom (A), Gmail (B), Google Calendar (C), webhook in (D), other (E)?
A: A, D and B. Gmail through a token, not a Google sign-in: an IMAP app password from the vault (personal account, 2-Step Verification on), which reads, archives as clear, and marks read; IMAP IDLE pushes new mail.

With GitHub these cover the contract's axes: clear remote (GitHub, Gmail) or Gateway-side (RSS, webhook); credential none (RSS) or a vault secret (GitHub, Gmail, webhook's own secret); arrival polled (GitHub, RSS) or pushed (webhook, IDLE).

> A D and B. but I think we can use token for Gmail?

## Question 5 - Who calls the webhook?

Q: Things on the LAN only (A), cloud services too (B), or both with the LAN first (C)?
A: C. A LAN listener now, shaped so a public door on the Router can front it later. No certificate UX yet.

> C. Shape it. but don't actually put the UX for certs part yet

## Question 6 - The webhook's schema and its inbox

Q: (Owner's direction after the refinement lap.)
A: The webhook's field schema is buildable by the owner, defaulting to just `title`; NyaaDot's schema viewer and builder are the model, with per-type colors. A webhook receives and holds hits as soon as it exists, before setup is finished, until its inbox is consumed. One schema model serves every watcher, since typed fields will drive the automation layers to come.

The IFTTT service and a webhook watcher are opposite directions: the service sends events out to IFTTT; a webhook receives calls in from any sender, IFTTT among them.

> I think return schema has to be buildabe. Default to just a title field. And as always, look to NyaaDot. it had a schema viewer and schema could be built on. It had full blown colors in the console.
>
> You should be able to still receive webhook messages even if you didn't finish setting it up. As long as the inbox hasn't been consumed.
>
> Defining the schema will allow you to more easily drive layer automation pipelines we haven't gotten to.

### NyaaDot, read for this question

- **Taken:** a closed type set with a flat constraints bag and `optional`, `default`, `describe` as flags; a schema stored as data, the same shape whether a kind declares it in code or the owner builds it; one text grammar (`name?: Type = default`) and one type-to-color table every surface reads; issues as `path + message + code` with the full path; inference from a sample that proposes and lets the owner confirm, merging shapes and marking a key absent in some samples optional; tri-state presence (absent is not default); a removed field's data kept, not deleted.
- **Improved on:** NyaaDot colors only four types and its formatter none, its unions lose branch detail, its console trims the path to its first segment, and nothing checks that an extension only adds or tightens. Here every type has a color, and a built schema may only add fields to, or tighten, its kind's base.
- **Not taken:** Godot types, callables (`refine`, `transform`), the `$replace` merge DSL, shadow indexes, passthrough objects, a fluent code builder as the authoring surface.

## Question 7 - Flat fields or nested?

Q: Flat fields that each name a path into the payload (A), or nested objects mirroring it (B)?
A: A. `temp: Number` from `attributes.temp`; rules, colors, the assistant's text and automation see one level, and nested input still arrives through the path.

> looks good

# Plan

Defaults taken without a question, open to the owner:

- **Instance ids:** the phone mints the id from the label at Add (a slug the Gateway checks), so a retried Add is idempotent rather than "label taken". Ids never change and are never reused; labels are renameable and unique per Gateway.
- **Webhook payload:** any JSON; the instance's built schema (Question 6) picks fields out of it by path, starting as just `title`.
- **Libraries:** IMAP through a mature client rather than a hand-rolled one, and RSS/Atom through a small XML parser, each under the seven-day maturity rule and proved under Bun, not only Node.
- **The carried cap** rises from 16 within the 64 KiB seal. An estimated sealed size is checked at Add and at each rule put, so a move that cannot fit is refused before the owner is mid-move.
- **Docs move with each phase,** not at the end; every new shim carries its removal date.

## Phase 1 - Kinds and instances on the Gateway

- **One declaration per kind:** the catalogue entry (`yields: "events"`) is the kind's one declaration: label, needs, a bounded non-secret config schema (an RSS URL, a Gmail address), `arrival` (poll or push), freshness (source time or first seen), and its item-id grammar. The Gateway's implementations are a `Record<KindId, Impl>` that `satisfies` the catalogue, as the device tool's tables do, holding the client factory, `fieldSpecs`, `clear` and acts. `secret` text derives from `needs`.
- **The instance store:** id, kind (an open bounded string, so a mixed fleet parses), label, config. Durable through `commitChecked`; seeded with `{ id: "github", kind: "github" }` only when its file is absent, through one `seedInstances()` that boot, `apply(null)` and `letGo` share. An instance of a kind this build does not know is kept inert and carried, shown as unsupported, its rules marked invalid.
- **Ids are safe:** integration and kind ids are reserved, so a label "IFTTT" cannot mint `ifttt` into the shared vault-holder namespace. A removed id is tombstoned, so a re-add cannot inherit a surviving grant or emitted wake keys.
- **Lanes add and remove at runtime:** `add` and `remove(id)`, with membership checked in `live()` and `pushAll`. Removal bumps the generation, clears the id's timer and queues, ends its items and drains before any store clears; then the removal commits, the grant is revoked, and rules, enabled and state are reconciled at start, never swept against a store that restored fresh. Ops on a removed id answer a typed `removed`. Grant targets are read live, not computed once.
- **One source client per instance,** the GitHub rate limit keyed by token.
- **The instance ops,** modelled on the device ops: one atomic Add carrying id, kind, label, config and grant; rename; remove. Closed refusal codes (`label_taken`, `kind_unknown`, `limit`, `config_invalid`). `Protocol.kt` and a phone-driver scenario in the same phase. `apply` refuses a carried id with no kind other than `github` rather than guessing; a move by an app older than Phase 3 drops instances it cannot carry, which is accepted.
- **The assistant sees the instance:** events, listings, the baseline and records carry the instance id and label. `eventLines` reserves its header keys (`watcher`, `id`, `title`, `url`) so a source field cannot forge one. A record gains an optional `source`, Router first.
- **The harness:** an `assistantKinds` seam, seeded instances, an injected `fetch`, and a fake GitHub keyed by token. The overdue `evicted` field goes, with `Protocol.kt` regenerated.

## Phase 2 - The field schema

- **Types:** Text (min, max, pattern), Number (min, max, integer), Boolean, Choice (options with labels), Date, URL; each field has a name, a label, `optional`, `default` and a description, and on a built schema a `from` path into the payload. Flat, per Question 7. Today's `text` and `enumeration` specs become Text and Choice, so every stored rule stays valid.
- **One shape, two authors:** a kind declares its schema in code and a webhook instance's owner builds one on the phone; both are the same data, and a built schema may only add fields to, or tighten, its kind's base, checked on every put.
- **Rule tests per type:** Text is, is not, contains; Number equals, below, above; Boolean is; Choice is, is not; Date before, after; URL host is. `fittingRule` on the phone and `parseRuleForFields` replay one shared vector file, as today.
- **One grammar, one palette:** `name?: Type = default` and a type-to-color table, declared once in TS and generated into Kotlin, read by the phone's viewer and rendered as plain labels in the assistant's text.
- **Parsing:** an event's fields parse against the schema with tri-state presence (absent is not default) and issues as `path + message + code` with the full path. A field that does not parse is absent to rules and named in the issues; the event is still held.
- **Inference:** a sample proposes typed fields, merging shapes across samples, marking a key absent in some samples optional and widening an integer to a number; the owner confirms each.

## Phase 3 - The `watcher` tool

- **Ops:** `list` (today's `inbox`, addressed by instance id or across all, on its read route `/assistant/list`, one byte budget across instances with a count line per instance, the answer echoing the instance), `clear` (each kind's meaning, the optional `summary` and the record it writes), and per-kind acts, as one op union derived from the kind registry. Each kind's item ids follow its own grammar, at most 64 characters; a link that is not https stays out of the record.
- **The skew window, in this order:** Gateway, plugin, `./start-host-daemon.sh`, assistant restart. The old `/assistant/list` shape and `watcher/github_done` stay behind dated legacy doors that parse and dispatch but are never listed. The check-now nudge names the instance and flips to the new tool last.
- **Rules name no watcher:** the Done rule becomes a `clear` rule, the Inbox rule a `list` rule, and the event-text rule says mail, feeds and webhooks are written by anyone. A scope test proves `watcher` carries no add, remove or config op.
- **The baseline** sorts stopped instances first, clamps reasons, and folds healthy idle instances into one line, so a cut cannot drop a broken one.
- `ASSISTANT_SWITCHBOARD_TOOLS`, the gate, `check:boot`, the scope test and the docs follow.

## Phase 4 - The phone

- A watcher's page shows its schema in the shared grammar and palette, and a webhook's page builds it: Add field (name, type, from path, optional, default), Use as sample from a held hit, and the held hits that do not fit with their issues.
- Integrations gains a Watchers section between Plugs and Services; the Watchers page goes, and its back target, unwind, trouble warning and section count move to Integrations. A watcher row opens today's watcher page with rename and remove.
- Add lists watcher kinds; the form is generic over `needs`, with a new non-secret need kind beside `secret` (its Kotlin enum and exhaustive `when` in the same commit), and an exhaustive `when(yields)` so an events entry cannot draw blank.
- `arrival` reaches the phone, so a pushed kind shows its own health words rather than "checked ago" and Check now.
- The Add and Remove UI shows only for kinds the Gateway can run (`offered` filtered by what it serves). The sandbox seeds a Gateway with two instances, an empty one, and an older one offering nothing.

## Phase 5 - RSS and Atom

- No credential; the URL is config. Polled with a floor of about fifteen minutes and jitter; conditional GET.
- Fetches allow http and https only, follow redirects by hand, refuse loopback and the Gateway's own ports (LAN feeds stay allowed, since the owner enters the URL), and cap bytes, time and XML entities.
- Freshness is first seen: `at` is a persisted Gateway ordinal clamped to now, the feed's own date a field, so a future-dated item cannot silence the instance.
- Item ids are a hash of the guid, else the link. Items present at Add are marked cleared. The clear ledger is pruned by age and count, and written before `clear` answers done.
- Errors answer reasons from a closed set, never a thrown message that can carry a URL.

## Phase 6 - The push arm and webhook in

- **The push arm,** before any push kind: the registry's `open(instance, { poke })` returning a close, a prime policy, and a per-instance durable store with count and byte caps. Closed on remove, disable, grant clear and stop; the credential re-read at each connect. Proved with a fake pushing kind.
- **Held until consumed:** a webhook instance receives from the moment it exists, before its schema is built or it is switched on; switching on governs wakes, not receipt. Each hit is held raw until cleared, re-parsed whenever the schema changes, and listed with its issues. Nothing expires; at the cap a new hit is refused with a status the sender retries, never an old one dropped.
- **The listener:** its own `Bun.serve` behind an injected adapter, separate from port 20000, whose routes authorize by session binding and must stay loopback. One POST route, a uniform 404 otherwise, a small body cap, rate limits and a wake debounce; bound while any webhook instance exists. A compose port and an env var for the LAN host, recorded in the port table and the docs; `check:boot` posts to it.
- **The secret:** the phone mints at least 128 bits into the vault, granted to the instance. The Gateway keeps a SHA-256 digest of it, refreshed on grant change and on a miss at most once a minute, compares in constant time, and fails closed. Logs name the instance, never the path. Without TLS on the LAN the path crosses in cleartext, which the docs state.
- **A hit** answers 2xx only after a durable write; freshness is first seen.
- **Shaped for a Router door:** one transport-neutral `receive(instanceId, proof, bytes, hitId)`, no source-address trust. What the Router may see is decided when the door is built; no certificate UX now.

## Phase 7 - Gmail

- IMAP to a pinned `imap.gmail.com` over TLS with an app password from the vault, IDLE through the push arm, reconnects under the ambient clock.
- Unread is the inbox, as for GitHub. `clear` archives (removing the inbox label, never `\Deleted`) and marks seen; fetches are `PEEK`. Only search, fetch, `STORE \Seen` and archive are used. Item ids are `uidvalidity:uid`; a UIDVALIDITY change recounts. The event is sender plus subject. A partial clear maps to per-item outcomes.
- A fake IMAP server with IDLE in the harness, and a check that the client runs under Bun.

## Phase 8 - The GitHub kind's fields

Asked for by the assistant from running the GitHub watcher, most useful first. Each is a declared field on the GitHub kind, so rules can match it and the assistant reads it without a round trip:

1. **Author** of the PR or issue (login), for its `repo #n - Title (@author)` forwards.
2. **State:** a PR's open, draft, merged or closed; an issue's open or closed.
3. **Review:** the review decision, whether the owner is a requested reviewer, and whether the owner already approved.
4. **The new activity:** comment, review, push, state change, label, assignment, with who did it.
5. **Comment text** for comment activity (author plus a snippet), and whether it mentions the owner or replies to one of the owner's comments, untagged replies included.

From running it:

- **Repeats:** an active PR wakes 3 to 6 times an hour as one thread returns. Collapse repeats of a thread inside a short window; item 4 tells a push from a comment.
- **`github_done` batches:** about 40 ids ran out of time partway (`not_attempted`, `uncertain`), about 25 finish. Raise the limit or finish the rest in the background.

## Phase 9 - Acceptance

Two GitHub accounts side by side, a feed, a webhook from the LAN, Gmail; the assistant reads, clears and is woken by each; a live run, with the docs and `AGENTS.md` already current from each phase.

## Settled by the code map

- **The existing account keeps instance id `github`.** Its state, off set, rules, vault grant holder, carried home entry and wake member keys all stay valid; an absent `kind` reads as kind equals id. Renaming it would orphan every one of them.
- **Live instance config is a Gateway store, carried on a move,** as rules, enabled and grants are today. The carried watcher gains `kind` and `label`; its cap of 16 rises.
- **One source client per instance:** the GitHub client's token read and its rate limit (`limitedUntil`) are per instance, so one account's 429 does not stop another.
- **Lanes, state, rules, enabled, grants and the inbox mark are already keyed by the id string,** so they become instance-keyed by meaning, not by rewrite. `fieldSpecs`, `secret`, actions and the client factory move to a kind registry; `createSourceLanes` takes a registry that can add and remove at runtime.
- **The assistant must see the instance:** today only the label reaches it, so two accounts would be indistinguishable. Events, listings, the baseline and records carry the instance id, and labels are unique per Gateway.
- **Watcher actions are kind-keyed and name their instance.** `ASSISTANT_ACTIONS`' fixed `watcherId` goes; dispatch resolves instance to lane and client. Item ids follow each kind's own grammar, not GitHub's digits.
- **Deploy order:** Gateway first with new fields optional; phone after, its Add and Remove gated on what the Gateway offers; the `watcher/github_done` id stays parseable through the skew window. Optional fields do not cross the plugin skew alone, since the plugin parses listings and action answers strictly; Phase 2's legacy doors carry the old shapes.

## Audit, lap 1

Seven angles (Sonnet, Luna rate-limited), synthesized by Opus, the top claims checked against the code. Folded in above: non-secret config per kind, the plugin skew and the tool-swap order, the instance id lifecycle, runtime lane add and remove, the push arm, first-seen freshness, id grammars and the record's `source`, a separate webhook listener, the instance ops in Phase 1, harness seams, unknown kinds and carried skew, one declaration per kind, the webhook secret check, the payload and header keys, the RSS fetch policy, Gmail semantics, listing across instances, health words for pushed kinds, `evicted`, the sandbox seeds, the size estimate, the Watchers page knock-ons, the untrusted-text rule, the baseline order, the Router door shape, docs per phase.

Not taken: a secret rotate op (editing the vault entry rotates it); deciding now what a Router door may see (decided with the door); refusing LAN feeds outright (the owner enters the URL; loopback and the Gateway's own ports are refused); learned webhook fields (replaced by `tag`).
