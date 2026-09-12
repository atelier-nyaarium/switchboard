# Questionaire

## Question 1 - What is the feature?

Q: What does the new Lexicon plugin do?
A: Two halves. Whole-file handling on the phone, and the symbol window.

> I want a new plugin for Lexicon stuff. Refs might actually be cannibalizd into it. It shall offer
> more features. Note that the repo is both your submodule and also officially in
> projects/nyaa-lexicon. This new feature will be both a Switchboard exclusive and anything code in
> Nyaa-Lexicon. New feature idea brings editing capabilities into my phone. A tie in via Gateway to
> the spawn point's filesystem. Scoped only to the project in question by default. Ideally I can
> much like a VSCode window browse the tree, open for raw manual edits, add files, delete, move,
> copy, etc. Normal VSCode behavior. But here's the cool one. Maybe a lexicon or switchboard
> Windowing feature that lets agent upon request show the target symbol in question. You know the
> Lexicon get/set content tool? It gets the raw text. So I could say "Show me the 3 API functions".
> And in my editing view, see all 3 scoped ONLY to the symbol on question. Read-only above and
> below. Then I may either direct edit through that window and don't need the AI to edit, or propose
> the change that the AI will interpret and act upon.

Half one, the ordinary half: tree browsing, raw whole-file edit, create, delete, move, copy. Scoped
to the spawn point's project by default. Phases 9 and 10 carry it; the audit caught that the raw editor
had no phase at all despite the tree's sheet offering it.

Half two, the point of it: the owner asks in prose for symbols, an agent resolves the prose to
symbols through Lexicon, and the phone draws each span editable with the surrounding file read-only.

## Question 2 - What launches a window?

Q: How does the owner get from a file they cannot read to a window?
A: A context menu on the file, carrying a prose request to the agent.

> Nice. Yeah so we do need real file handling for whole files alongside the Windowing feature. A
> convenient launch point would be the case of "This 1200 line file literally is impossible to see on
> my phone. *Context menu Open Window* -> [ Please give me the 3 prose lines. I wanna change it's
> text. ]". That prompts the agent with the request and it Lexicon MCPs to provide a triple window to
> the content source. the direct owner involvement is pretty clear of their choice. we just need to
> ensure it can't be abused.

Direct edit and proposal go through the same door: a direct edit is the owner sending the span, a proposal is
the owner sending words and the agent sending the span.

PARTLY SUPERSEDED by Question 16. The prose request is ONE entry point, not the only one; a symbol can also
be picked directly from a file's outline with no agent turn.

## Question 3 - What is the threat model?

Q: How much security work does phone-side writing need?
A: The compromised host is out of scope. Everything else is in.

> But that falls under the /security rule of if their computer was compromised, then it literally
> doesn't matter anyways. So identity with Sol. the REAL security implications for the non pwned case.

No new authority class: `tmux_send` already relays arbitrary text into a terminal, which is command
execution from the phone. A reachability change, not a power change. Four things are not free:

1. **Replay.** Delivery ops get a durable Router ledger, claims, target binding and host dedupe. Value ops
   get none. SUPERSEDED on the road: writes take neither, they take the bridge plane, so its at-most-once
   rule is defined in Phase 3 and its preconditions in Phase 10.
2. **View to write.** `refactor_replace` re-resolves fresh and binds the save to nothing the owner saw.
3. **Path confinement.** `isSpawnWorkdirPath` validates spelling only. `insideWorkspace` is better but
   check-then-use. SUPERSEDED on placement by Question 9 and on framing by Question 11. The mechanics
   survive, plus hardlinks, platform namespace escapes and special files from the audit.
4. **Shared transaction.** One per workspace, no owner, restart-surviving, revertible by any session. Phone
   saves are single-shot.

Medium: whole-file reads cache source and secrets into Android state, logs and backups. One-tap delete,
move and copy need hashes, destination checks, explicit overwrite and named atomicity.

## Question 4 - Can a symbol be named unambiguously?

Q: When a name appears more than once in a file, is there a guaranteed Lexicon way to say which?
A: Yes. The discriminator is the enclosing scope.

> I was thinking of something but I'll say it after you confirm. Open up some file with like repeat
> functions or something. Something where Foo appears multiple times and whether there's a guaranteed
> Lexicon way to identify which

Tested rather than assumed, against a phone source file holding two methods both named
`commitMailbox`. Lexicon gives each a distinct id and the discriminator is the enclosing scope, not a
count and not a line. Asking by bare name REFUSES and lists both candidates. The exact id round-trips
to one span.

CORRECTED after reading `composeSymbolId` and `withOccurrences`. An id is
`lexicon <language> <module> <descriptor path>`, and a descriptor carries an optional disambiguator
and an optional POSITIONAL occurrence ordinal. Methods get an arity and overload disambiguator, which
is durable. Everything else falls back to occurrence order, assigned in source order with the first
carrying no suffix and later ones `[2]`, `[3]`.

So the freebie holds for edits elsewhere in the file, and breaks in one case: inserting a same-named
sibling ABOVE an occurrence-numbered symbol renumbers it. Document headings are the least stable,
since they have no disambiguator at all.

## Question 5 - What does a window bind to?

Q: What must hold true for an edit submitted against a window to be accepted?
A: The span's content, not the file's.

> Ok. Windowing is a 2 way road in that the MCP gave me the window. it better damn well remember what
> it gave me when my edit submissions go through. If not, that's a Switch board fix or a Lexicon
> patch. And of course if the file is updated, it needs to invalidation my windows and if I need edit
> rights again, fix my windowing references. more often than not it's a freebie and won't invalidate
> me though.

Lexicon's current check is the WHOLE FILE hash, which is the wrong shape for the freebie: a typo
fixed 200 lines away would invalidate a window in a 1200 line file.

The fix is to bind on the SPAN. At save, re-resolve the symbol id, hash the text it now covers,
compare to the hash the window was drawn from. Same span text passes however much the rest of the
file moved. Different means stale, and the owner sees the new text rather than a silent rebase.

The span compare-and-swap belongs in LEXICON, because only Lexicon can re-resolve the id and hash the
span under its own writer lock in one step. Switchboard reading, comparing, then asking for a write
leaves exactly the race this closes.

Split: Lexicon grows a replace taking an expected span hash. Switchboard carries the window descriptor and
owns the phone surface, the plugin, and the filesystem operations.

REVISED by the audit lap on two points. The descriptor is not "minted" and carries no capability, since the
authority is the owner's signed console op; see Phase 8. And the Lexicon side is not a new argument on an
existing call: planning runs outside `WorkspaceGate.exclusive`, so the re-resolve and the hash have to move
inside it.

## Question 6 - When is a window validated? [superseded by Question 15]

Q: Is checking only at save good enough?

Asked again as Question 15 once the architecture was known, since the answer depends on where the
watch could live.

## Question 7 - Does this absorb the refs plugin?

Q: Is the references plugin cannibalised into this one?
A: No. It keeps its grammar and its snapshot, and the viewer gains two exits into the editing surface.

> ref shoud jump to the window or file or something. Propose something clean as a designer

Proposed in `ref-viewer.html` and accepted as the design direction:

- **Two exits at the foot.** `Open File` to the outline, `Open Window` to the editable span. Main action
  right, as everywhere else.
- **The snapshot stays.** It records what the agent meant when it sent the message, which keeps its value
  after the code moves. Deleting it would lose the only record of what a claim rested on.
- **A Sent against Now switch, shown only when they differ.** A ref that still matches draws no switch,
  since there is nothing to compare. Default is Sent, because the owner tapped a link in a message and
  what was meant is what they came for.

CORRECTED by the audit lap. The claim was that refs already compute the needed hash and merely discard it.
Wrong twice. `resolveOne` computes `snapshot = hashContent(text)` over the WHOLE decoded file, to reconcile
Lexicon's answer with the bytes, and `RefKeyMetaSchema` persists coordinates with no hash at all.

So the span hash is new work: slice the range and hash the slice, then carry it as one new optional field
on the ref metadata. Both primitives exist, `sliceRange` and `hashContent`, but nothing composes them
today and nothing keeps the result.

Still small, and it still makes ONE hash concept serve both features. The window's freebie rule and the
ref's changed-since-sent strip become the same comparison, so there is a single thing to get right rather
than two that can disagree.

## Question 8 - How does the code split across two repos?

Q: The feature is Switchboard-exclusive, but some of it belongs in Lexicon. How do the repos move?
A: Not a fork, a sequence. Only SAVING needs the Lexicon patch.

`nyaa-lexicon` is both a pinned submodule here and its own project at `projects/nyaa-lexicon`, and the
pin sits two minors behind the live copy.

Everything that READS runs on today's Lexicon untouched: the tree, the outline, the knowledge screen, the
ref viewer, and a read-only window. The span compare-and-swap is needed the moment Save is pressed and not
one step before it.

So the order is: move the pin to current Lexicon, which is debt already owed; build everything that reads;
patch Lexicon; pin again; then saving. The Lexicon patch is never on the critical path.

## Question 20 - Does the reading half ship on its own?

Q: Ship reads first, or hold for one release carrying saving?
A: Reads first.

> A

Recommended and taken. The owner's original complaint was that a large file is impossible to see on a
phone, and reading fixes exactly that, so half the value lands with none of the risk. It also proves the
plane, the tree, the confinement and the window rendering before anything can write, which is the cheapest
way to discover the reach was wrong. And if the Lexicon patch turns out hard, there is still a working code
browser on the phone.

Found while splitting the releases: **Agent Apply belongs in the first one.** The agent writes through its
own Lexicon tools, which already exist, so the phone only composes a message naming the window and carrying
the owner's text. No write plane, no token, no Lexicon change. Only the direct no-agent Save waits.

## Question 9 - Who holds the write authority?

Q: Which process reads and writes the files on the phone's behalf?
A: The session's own MCP plugin process, both for a raw edit and for an agent request.

> When I propose an edit, it can either be a direct no-agent edit. Me just doing raw coding. Or it can
> be submitted as an agent request. IE I type slop pseudo code into the raw body, and the agent
> figures it out.
>
> So I'm thinking some combination or both of A and C? Host agent cannot edit a file in a Devcontainer
> so that's out. Lexicon imported by Switchboard will have to manage that tunnel through the Gateway.

The host daemon is out, and the owner named the reason: a devcontainer's Lexicon daemon listens on
loopback inside that container with container paths, so the host daemon can neither reach it nor share
its index.

No new reach is needed. Every session's MCP plugin already dials OUT to the Gateway's bridge endpoint
and holds the socket, registering its session token and its project path, and the Gateway already
pushes down it. The tunnel is a new frame kind on a connection that exists.

The two roads differ only in whether the agent takes a turn, not in which process holds the files:

- **Raw edit:** the MCP process serves the frame through its own Lexicon client. No agent turn, no
  tokens. Costs one new plane on the bridge socket.
- **Agent request:** an ordinary message carrying the owner's pseudocode. Works today, costs nothing.

## Question 10 - How does a raw edit reach the agent?

Q: A raw edit the agent did not make leaves its model of the file stale. How is it told?
A: A banked awareness notice at `no_act`.

> and of course per switchboard style, there's a no-ack and no-act right? so any edits that I haven't
> told you yet, will come in as a no act. pretty much a *User edited X file. They will tell you if
> it's worth your attention.*

Both exist. A standalone `no_ack` push asks for no reply but still wakes the session. A `RidingAwareness`
at `act: "no_act"` hitches on the next message that was going to the session anyway, so it costs
nothing. `act_now` is the tier the Gateway pushes on its own when no message comes in time.

A raw edit is the banked kind.

## Question 11 - What is the file tree rooted at, and what happens outside it?

Q: Can the owner reach a file that Lexicon does not index?
A: Yes. Inside the workspace Lexicon serves the window; outside it the capability degrades.

> ohh right I forgot Lexicon needed a stable root. By default the same point as the workspace it is in.
>
> Raw edits don't need Lexicon so that's the easy way out. If it's within the workspace, use Lexicon.
> if it's out, no lexicon and just let the agent see the lines the user is commenting and pseudo
> coding in.

Lexicon's root is the session's workspace. So the workspace is the SYMBOL WINDOW's boundary, not the
file tree's. Outside it there is no index, no symbol window, and the fallback is the agent reading the
lines the owner wrote in. This mirrors the refs plugin, which already degrades rather than refusing
when Lexicon cannot answer.

Raw whole-file edits never touch Lexicon, which settles Question 13 before it was asked: Lexicon does
not grow whole-file operations.

Confinement therefore stops being a security boundary and becomes a mistake boundary. A session can
already run commands, so it can already write whatever its user can, and a path check adds no
authority. What it buys is that a mis-tap cannot write outside the project and that the tree tells the
truth about where it is. Default root is the workspace, wider is deliberate, and the real ceiling is
the OS user. Stated to the owner as a reading rather than a question.

## Question 12 - How does a save survive the one-open-transaction rule?

Q: Lexicon permits exactly one open refactor transaction per workspace, with no owner. What does a
phone save do about it?

A: Join whatever is open, against the recommendation of a transactionless write.

> A. Easy enough for the agent to get back if I order the revert

Corrected while asking: the common failure is not an agent reverting the owner's work, it is the save
being REFUSED because an unwatched session is mid-refactor. Joining avoids the refusal, and the owner
accepts the revert because the edit can simply be ordered again.

Two rules this forces:

- **Commit only what you opened.** Every refactor tool needs a transaction open, so a save with none
  open must start one. Committing one it merely joined would close an agent's work mid-refactor. Start
  if none, join if one, commit only in the first case. Same shape as `joinCreate` in the wake service,
  where the first caller gets the closure that ends it and every later one gets nothing.
- **A refused commit cannot be left open.** Commit refuses while issues are outstanding, and a prose
  edit can easily leave a name unresolved. A transaction the phone opened and cannot close blocks every
  agent on that workspace. So it forces the commit and reports the issues in the save's answer. The
  owner is the deliberate actor and should be told what broke, not blocked on it.

## Question 13 - Does Lexicon grow whole-file operations?

Q: Should create, delete, move and copy go through Lexicon so there is one confinement implementation?
A: No. Answered inside Question 11 before being asked.

## Question 14 - What must survive a restart?

Q: How does the feature behave when Switchboard is restarted for an update?
A: It degrades to a hash check, and nothing is lost but unsaved typing.

> another consideration is this need to be durable to resumes. so if you restarted switchboard to an
> update, shouldn't break down entirely.

This makes the stateless window token mandatory rather than merely tidy. Stored window state would
invalidate every open window on every restart, which is the breakdown named here. Three layers:

- **The token** survives because it is signed with a key from the Gateway's durable keyring, not
  stored as a record.
- **The plane** survives because each session's plugin already reconnects its own socket. Nothing to
  resume.
- **Unsaved typing does not survive today.** A draft lives in its ops class, which outlives the
  activity but dies with the app process; runbook drafts have the same hole. A window draft has to land
  on disk the way the runbook library does.

A file that moved during the restart fails the span hash, and the owner sees the new text.

## Question 15 - When does a window learn it went stale?

Q: At save only, also on foreground, or pushed live?
A: Save plus a foreground re-check.

> B

Reframed while asking: with a stateless token and a span hash, invalidation is not correctness.
Correctness is guaranteed at save. Invalidation is only a courtesy that saves wasted typing.

Recommended and taken, since a courtesy should be cheap and it buys the realistic case of opening a
window, locking the phone, and returning. The live push stays a clean later addition: it needs no Lexicon
protocol change, since the plugin process sits on that filesystem and already holds the socket, but it
costs a watch per open window and live state to re-register after a plugin restart.

## Question 16 - How is a window minted?

Q: Does the owner always ask in prose, or can they pick a symbol directly?
A: Both. A file's outline for picking, with a prose box above it.

> C

Clarified while asking: the plane is served by the plugin process, which lives as long as the session, so
a live session and an agent's attention are different things. A direct pick needs the session alive; a
prose request needs the agent to take a turn.

Recommended and taken, since the two are different jobs. Interpreting "the 3 describe lines" needs an
agent, naming one field does not, and charging a turn for the second would stop the owner using it. The
outline is one Lexicon call on the plane that already exists, and both paths land in the same window view.

## Question 17 - What does tapping a file in the tree do?

Q: Raw whole file, the outline, or decided by size?
A: The outline, which is also where windows are opened from. Raw edit and a symbol's Lexicon knowledge are
both options off it.

> probably outline which directly leads to opening windows easily. and options to edit whole raw or just
> looking at the Lexicon knowledge base on a symbol of the outline

Recommended the outline and taken, since it IS the readable view of a large file on a phone and should not
be the thing the owner goes looking for. A size threshold needs a line number that will be wrong for some
file and leaves the owner unsure which view a tap gives. Raw by default is the experience the owner called
impossible.

The owner added a third surface: a symbol's Lexicon knowledge, read from the outline. Read-only. It is
pull reads over the plane that already exists, so it carries no confinement or write concerns.

## Question 18 - Does this replace the Lexicon MCP plugin?

Q: If Switchboard supplies a rich Lexicon experience, is the separate Lexicon plugin still needed?
A: Yes, it stays. Two different consumers.

> just had a thought. if switch board supplies rich Lexicon experience, then I don't need the separate
> Lexicon plugin right?

The Lexicon plugin gives the AGENT tools for navigating code. This feature gives the OWNER a phone
surface. Neither covers the other.

One MCP plugin cannot call another, since they are separate processes, so Switchboard needs its own
Lexicon client regardless. It already has one for refs. Two clients against one daemon is not duplication;
that is what a server is. And if Switchboard owned the agent's Lexicon tools, the agent would be limited
to whatever Switchboard last shipped, so every Lexicon release would need a Switchboard release to reach
the owner.

CORRECTED by the audit lap. The pin gap was cited as evidence and the figure was wrong. Real numbers:

| | Revision | Package version |
|---|---|---|
| Pin | `7077be2` | 3.7.0 |
| Live | `6d451f7` | 3.7.1 |

Seven commits and one patch version, not the two minor versions claimed. The `v3.0.2-119` that `git
describe` answers is a stale TAG; tags stopped at v3.0.2 while the package version moved on. The
conclusion does not depend on the pin gap.

## Question 19 - What happens after Agent Apply?

Q: Does the agent write and the window refresh, or does it propose back for approval?
A: It writes. The window auto-refreshes when the refresh is free, and nothing is marked as the agent's.

> no need for marking as agent. but do autorefresh if freebie.

This is sharper than the three options offered, and it generalizes past Agent Apply into the one rule for
every refresh:

**Refresh silently whenever nothing of the owner's is lost. Show the stale banner only when a refresh
would discard their typing.**

- Span changed, nothing unsaved there: silent refresh, never seen.
- Span changed, unsaved text there: banner, the owner decides.
- File changed elsewhere, span untouched: nothing happens at all.

So the stale banner is never noise: on screen means something is at stake.

Proposing back was declined. Its cost, recorded in case it returns: a new phone-bound row kind naming a
window, carried on the durable `OwnerRowOutbox` road that already pushes to the phone.

# Mockups

Five accepted screens in `plans/lexicon-phone-editing/`. Self-contained design cards at phone width, on real
Lexicon answers and real directory listings.

| File | Screen |
|---|---|
| `file-tree.html` | The tree, with the long-press operations sheet open |
| `file-outline.html` | A file's declarations, where windows are opened from |
| `symbol-knowledge.html` | One symbol's source, documentation, and knowledge |
| `symbol-window.html` | The editable windows, one stale |
| `ref-viewer.html` | A `ref://` snapshot with its two exits, in the changed state |

The flow between them: tree, tap a file to its outline, tap a symbol to its detail, long-press or
`Open Window` to reach the window. A ref tapped in a thread enters the same flow at the viewer.

# Design Rulings

All accepted by the owner.

> that's pretty good.
>
> looks good.

## Terminology: Window

Each span the owner can edit is a Window. Their own word, used in the plural for one file:

> if the file is updated, it needs to invalidation my windows

Not "file", since the other cards stay savable while one is stale. Not "span", which is jargon the
owner never used.

## Every explanatory sentence comes out

A label plus data stays. A sentence telling the owner what a control does goes. Three were cut on sight: the
label above the prose request, the stale banner's paragraph, and the footer line explaining the buttons. The
stale banner is a bold title, one line, and an inline action.

## Save is the right-hand button

`Agent Apply` on the left, `Save` on the right, because the main action belongs on the right.

## No old-value preview

An edit is not reliably one clean sentence, so showing what a span used to say does not fit a phone
row. The `EDITED` pill moved into the card header rather than keeping a row for itself.

## One field, two buttons

The same text box serves both roads. Save writes the text verbatim; Ask sends the same text as a
request. No mode is chosen before typing, so the owner can start editing properly, give up halfway, and
turn it into pseudocode without losing what they wrote.

## Staleness is per span, not per window

Each span carries its own hash, so one going stale leaves the others live and savable. A window never
dies whole. The banner names it as the agent's change, since that is what the owner needs in order to
decide.

## The prose request stays on screen

Quoted under the filename. Three spans out of twelve hundred lines is meaningless without knowing why
those three, and the request is also the thing the owner amends when the window picked wrong.

## Three highlight colours, three jobs

Carried over from the refs viewer at the owner's request, which was the early attempt at this feature:

> now our refs attempt was an early day shot at this windowing by doing a primitive blue/yellow
> highlight. I think blue highlight is still good for line selections and yellow for symbols

They are not alternatives. `.line.in-range` takes the band and `mark.span` takes the amber, so a line-range
ref carries both.

- **Blue band**, `rgba(56, 139, 253, 0.20)` dark: these lines are the selection.
- **Amber mark**, `rgba(210, 153, 34, 0.38)` dark: this text is the symbol.
- **Purple accent**, the M3 primary: this is editable.

Three meanings, no overlap, and they compose. The amber also names which symbol a window card is on.

The refview document uses GitHub's palette because it was built standalone, while the rest of the app is
Material, and a foreign palette would read as a different app mid-flow once it renders windows. It moves
onto the app's surfaces, keeping only the band and the mark, since those are the two values carrying
meaning.

> alright

## Smaller rulings

- A symbol is labelled by its chain, not a path, matching how Lexicon identifies it.
- A skipped region shows its line count, so the file's shape stays legible.
- Read-only context is dimmed with no left accent; the editable span carries the accent.

## Outline screen

Proposed in `file-outline.html`, built on the real 49 declarations Lexicon answers for that file.

- **No checkboxes. Normal tap opens the detail, long tap opens a window.** The owner rejected checkboxes:

  > I don't know if I like the check boxes. Just accept a long tap open window to open more windows.
  > otherwise a normal tap lets me poke around and see that Symbol code

  So there is no selection mode. Each long tap adds a window, and a row that has one carries the same
  primary left accent the editable span uses, with the footer counting them.
- **Kind chips filter, not a text field.** 49 rows on a phone needs narrowing, and tapping beats a
  keyboard.
- **Members nest under their parent**, indented and on a darker ground.
- **Raw sits left of the main action**, matching Save on the right.

## Tree screen

Proposed in `file-tree.html`, on a real directory listing, with the long-press sheet drawn open because
the file operations are half the feature and a clean tree would not show them.

- **Folders first with child counts, files with line counts.** Lines are what tell the owner whether to
  open an outline or raw.
- **The path shows the workspace root in full and greys what is above it**, so leaving the workspace is
  visible rather than inferred.
- **The sheet leads with the two ways in**, outline and raw, then the file operations, with delete alone
  at the bottom. `Send to agent` is there because handing a whole file to the conversation costs nothing.
- **A folder containing an open window carries the windowed-row accent**, so the owner finds their way
  back without remembering a path.

## Symbol detail screen

Proposed in `symbol-knowledge.html`. The normal-tap destination, so it leads with the symbol's SOURCE
read-only, then its documentation, then knowledge. `Open Window` at the foot is what makes it editable.

> Details look pretty good.

Read-only, over Lexicon's six answer classes: describe, why, relate, contract, effects, usage.

- Each class is either recorded prose carrying a health grade, or a gap. THIN means the answer cites only
  the declaration, so it paraphrases what the reader can already see. STALE means the code under it moved.
- Facts below the answers are counts that drill in: members, references, uses, comments, type hierarchy,
  last changed.
- **Unvetted addition:** an Ask chip on a gap. Recording an answer needs fact ids the owner cannot type,
  so it must be agent work, but the chip is only the prose road pointed at one gap. Flagged to the owner
  as vetoable.

# Audit Findings

Six angles across both repos, each triaged against the code: transport, Lexicon correctness, confinement and
abuse, Android feasibility, Release 1 completeness, document consistency.

## Four dissolved by simplification

- **The window descriptor needs no signature.** Q5 said Switchboard mints the token and Q14 said it is
  signed with a Gateway keyring key, which contradicted each other and both conflicted with the plane being
  served by the plugin. The authority is the owner's already-signed console op, and a wrong descriptor
  simply fails the span-hash check or names a different symbol. So it carries no capability and needs no
  key, no issuer and no expiry. It is a `(symbolId, range, spanHash)` descriptor.
- **The window view uses no WebView.** Making a span editable inside the refs viewer's WebView was a real
  hole: `contenteditable` over syntax spans and marks wrecks text extraction, selection, undo and IME. But
  the window's read-only context is plain rows and its editable spans are small. Compose rows plus Compose
  text fields, and no WebView at all. The WebView stays where it already works, the ref viewer.
- **One session, one socket to pick.** `registry` is team then `subId`, so a session can hold several
  plugin sockets. `isMainOrLead` already rides the register message and `resolveLiveIncarnation` already
  picks a canonical one, so this is a read of existing machinery, not new machinery.
- **A prose edit rarely leaves an outstanding issue.** `impactOf` raises `UnboundReference` only for newly
  increased genuinely dangling references, excluding `ExternalDependency`, `NotIndexed` and
  `DynamicallyTyped`. So the forced-commit path is an edge case, not the common one.

## Accepted, and absorbed into the phases

1. **The plane is not "one frame kind".** The plugin handles only `channel_push`, `response_push`,
   handshake and registration. There is no session-request dispatch, no reply correlation on that socket,
   and no pending-request map or generation fence. Host ops and the connector both have correlation to copy
   from; the bridge does not.
2. **A request in flight is lost on reconnect,** with no ledger and no fence, so a retry can duplicate work
   or answer into a replacement session.
3. **The Lexicon span compare-and-swap needs the gate restructured.** Planning runs structurally outside
   `WorkspaceGate.exclusive`, which wraps only the staleness check, journal, write and reindex. Re-resolve
   and span-hash have to move inside it.
4. **A crash leaves a transaction OPEN.** `recover` drops unfinished steps without closing the transaction
   row, so every later session is blocked until someone commits or reverts. The durability requirement
   missed this entirely.
5. ~~**There is no single canonical workspace root.**~~ REJECTED while building Phase 1. The four resolvers
   answer different questions in different processes, and a devcontainer REQUIRES the plugin's path and the
   host's path to differ. The real rule is about space, not a value; see Phase 1.
6. **The default tree holds `.env`, `.git` and `node_modules`,** with no exclusion, no redaction and no
   audit trail. `.env` carries `HOST_WS_TOKEN` and federation tokens.
7. **An expected source hash does not make a mutation idempotent.** A repeated copy succeeds again, and
   delete or move can act on a recreated file with identical bytes, because a content hash binds no file
   identity. Destination preconditions are required, not optional.
8. **Hardlinks defeat path confinement,** since a name inside the root can reach an inode whose other name
   is outside, and `realpath` does not see it.
9. **Platform namespace escapes are unnamed:** case folding, Windows short names and alternate data
   streams, trailing dots and spaces, junctions.
10. **Special and unstable files are unbounded.** `refFile :: loadRefFile` already refuses non-regular files
    and caps at 8 MB; the new plane must reuse those rules rather than reinvent them.
11. **SharedPreferences is the wrong store for a code draft.** `RunbookManager :: commit` serialises a whole
    library into one preferences string. A draft belongs in a file under `filesDir`, written atomically.
12. **Gateway-scoped phone helpers cannot key session-scoped windows.** `GatewayReadFence` and
    `GatewayRegistry` key by Gateway, so two sessions on one Gateway collide.
13. **The plan named no ops class,** which would land the tap rules, the refresh rule and the two save roads
    inside Composables, where this project's own rule forbids them and no gate can see them.
14. **Nothing built the raw whole-file editor,** though the tree's sheet offers it.
15. **Agent Apply carries no exactness guarantee in Release 1.** Without the compare-and-swap an agent can
    resolve a renumbered occurrence and write the wrong span. It must compare the original text it was sent
    and refuse a mismatch, which is a check at human pace rather than under a lock.
16. **Reads were scheduled before confinement defined them.**

## Rejected

- That the 49-declaration figure is unverified. Lexicon's own `outline_module` answered it. The auditor
  could not reproduce it, which is not the same thing.
- Finding 5, the disagreeing workspace roots. Rejected while building Phase 1, where the code showed the
  resolvers answer different questions. Recorded because acting on a confident finding without checking it
  would have produced a unification that breaks every devcontainer.

## Two artifacts that mislead every reader, agent or human

Both of these produced wrong claims in this plan before they were caught, mine included.

**`git describe` lies about Lexicon's version.** Tags in `nyaa-lexicon` stopped at `v3.0.2`, while
`package.json` walked on to 3.7.x. So `git describe` answers `v3.0.2-119-g7077be2` for a 3.7.0 checkout. Two
auditors and this plan all misread the gap from it. The version lives in `package.json`; a revision is the
only thing `git describe` is good for here. Upstream fix belongs to `nyaa-lexicon` and is the owner's call.

**No resolver name says whose space it answers in.** `workspaceRoot`, `findProjectPath`, `resolveProject`,
`resolveHostWorkdir` and `PROJECT_HOST_PATH` read as five spellings of one question. Nothing in the names or
their comments separates container space from host space, which is what produced the rejected finding above.
Carried to crust collection rather than renamed mid-phase.

# Codebase Facts

Read out of both repos 2026-09-12.

## Lexicon

- The refactor transaction is SQLite-backed, one per workspace, survives a daemon restart, and has no
  owner, capability, or lease. Any session can undo, revert, or commit it. `TransactionManager`.
- `refactor_replace` takes `symbolId` or `factId` plus `newText`. Before writing it checks the address
  exists, the module is on disk, the index is current, the span is valid, the replacement parses, a
  provider owns the file, and the declaration was not renamed. `planReplacement`.
- The staleness check is the WHOLE FILE hash, `baseHash: hashContent(before)`, rechecked inside the
  writer gate before journaling. So the gated compare already exists; what is missing is hashing the
  SPAN and accepting an expected hash from the caller.
- `WorkspaceGate.exclusive` is a FIFO exclusive writer gate. Plans run outside it, journal and write
  and reindex run inside. A span compare-and-swap has to happen inside.
- There is no filesystem compare-and-swap. An external writer after the last check can still race the
  temp-write and rename. Pre-existing.
- `symbol_source` answers `{found, module, name, kind, range, text, contentHash}` where `contentHash`
  is the whole file. Stale answers `{found: false, reason, stale: true}` and refuses to slice.
- Ranges are line and column, zero-based lines and UTF-16 code-unit columns, LSP style. Not byte
  offsets.
- `Declaration.range` spans the whole declaration INCLUDING comments and body; `selectionRange` is the
  name alone. TypeScript deliberately grows the range to swallow a touching doc comment, so
  documentation can sit inside the editable span.
- No batch `symbol_source`. The MCP `queries` array is serial adapter-level repetition.
- `insideWorkspace` is the strong check, used only on the write road: relative containment plus
  `realpathSync` of the root and the nearest existing parent. Still check-then-use, with no
  directory-handle confinement.
- Watching is `node:fs.watch`, debounced, invalidating on a content-hash comparison. Its events never
  cross the daemon wire, the client, or MCP. The wire carries requests, responses, and heartbeats
  only. Live invalidation is a protocol change.
- The daemon is one newline-delimited JSON object per line over an ephemeral loopback TCP socket, one
  daemon per workspace, published in `daemon.json` and claimed with a token.
- Daemon methods are schema-driven from one table; the MCP tool catalogue is hand-written.

## Switchboard

- The Gateway container mounts only its log and data volumes. It cannot see a project file and cannot
  reach a loopback Lexicon daemon.
- Every session's MCP plugin dials out to the Gateway's bridge endpoint and holds the socket,
  registering `sessionToken`, `projectPath`, `cwdName`, and the Claude session id. `connectToRouter`.
- Seven delivery op kinds, thirty-one value op kinds. Delivery ops get a durable Router ledger,
  session-address target binding, durable gateway claims keyed by address, sequence and delivery
  epoch, and retry. Value ops get a transient waiter map and a 70 second timeout, settled on
  conversation, op and connection id.
- A value op's `opId` is NOT a durable idempotency key. A duplicate frame can invoke the handler
  twice. Mitigation for a write is an expected-hash precondition, which makes the second attempt fail
  rather than repeat.
- `parseQualifiedTarget` accepts a qualified session or a qualified spawn point. Session-record ops
  refuse a spawn point; terminal ops accept one by deriving the default session.
- Relay frames cap at 8,000,000 bytes. The blob road caps at 500,000,000 plaintext in 1 MiB sealed
  chunks, uploaded with `blob_begin` and `blob_chunk` and read with `blob_fetch`.
- `list_dirs` runs phone, owner op, Router, `composeRouterFrames :: valueOp`, `consoleHandler`,
  `consoleTerminal :: listDirs`, `relayToHost`, host daemon, `listHostDirs`. The host daemon performs
  the readdir; Windows shells out to PowerShell.
- `isSpawnWorkdirPath` validates SPELLING only. No canonicalization, no symlink resolution, no root
  comparison. It would accept a path outside the project. Fine for listing, unusable for writing.
- `resolveSpawnWorkdir` is the single spawn resolver. Roots are configured, project membership is
  discovered from `.devcontainer/devcontainer.json`.
- Host ops today: `peek`, `sendText`, `sendKey`, `createSession`, `listDirs`, `reloadPlugins`,
  `killSession`. Correlated by an 8-byte hex request id with a 20 second timeout.
- The host daemon presents `HOST_WS_TOKEN` and the Gateway checks it. The host daemon does not
  authenticate the Gateway back, and local-only binding is not enforced.
- The phone ALREADY has a syntax-highlighted code viewer: `ReferenceViewer`, a full-screen WebView
  with line numbers, a highlighted range, a degradation banner, and vendored highlight.js. Read-only
  and snapshot-bound.
- Ref snapshots are taken at send time into blob-plane attachments tagged `role: "ref-snapshot"`,
  capped at 256 KB each and 2 MB total, and `refResolve :: resolveOne` already hash-checks Lexicon's
  answer against the file bytes and can await indexing or reread once.
- A tab costs about ten files. Policies is the reference: ops class, screen, editor, draft, read
  fence, registry, console client, repository host, repository, and routing.
- An edit in progress lives in the ops class, not Compose state, because the repository outlives the
  activity.
- Tabs are pull-based. Entering a screen or a gateway incarnation change triggers a concurrent read.
- A directory browser already exists for picking a session's working directory: `DirectoryField`,
  `SessionOps :: listDirs`, `DirListing`. No project tree or file browser.
- The runbook body editor is a plain Compose text field. No code editor anywhere outside the ref
  viewer's WebView.

# Plan

Two releases, settled in Question 20, and rewritten after the audit lap. Eleven phases. Nothing in the first
release touches Lexicon, so the Lexicon patch is never on the critical path.

**Agent Apply belongs in the first release,** because the agent writes through its own Lexicon tools. The
phone only composes a message carrying the window's identity and the owner's text. No write plane, no
descriptor to verify, no Lexicon change. The audit's caveat is kept rather than buried: without the
compare-and-swap it is best-effort, so the agent compares the original text it was sent and refuses a
mismatch.

So the first release reads everything and can change anything through the agent. The second removes the
agent from the loop and makes the exactness a guarantee.

Ordering changed after the audit. Confinement and the canonical root now come BEFORE anything serves a read,
since reads were previously scheduled against a root four resolvers could disagree about.

# Release 1 - Reading, and Agent Apply

## Phase 1 - One canonical workspace root ✅

**Pin:** `6d451f7`, version 3.7.1, on `origin/main` so CI can reach it. Green on biome, tsc, 2730 tests,
`check:boot`, module residue, Kotlin codegen drift, fixtures and pinning.

Also checked at source level, since `occurrences.ts` and `symbolId.ts` are in those seven commits and this
feature rests on id stability. Every change there swaps `...(x === undefined ? {} : { k: x })` for
`...defined({ k: x })`. Identical semantics. Id composition and occurrence numbering are untouched.

**The audit's "four disagreeing resolvers" finding is REJECTED.** They answer different questions in
different processes:

| Resolver | Question | Whose space |
|---|---|---|
| `refWorkspace :: workspaceRoot` | what is THIS process's workspace root | the plugin's |
| `hostResolve :: findProjectPath` | which host directory holds the project called X | the host's |
| `hostDaemon :: resolveProject` | same, host-side | the host's |
| `PROJECT_HOST_PATH` | what the HOST calls this project | the host's |

A devcontainer REQUIRES them to differ: `/workspaces/switchboard` inside, `/home/nyaarium/projects/switchboard`
outside. One value would be wrong for one of them.

The rule is about space, not a value:

**The plane serves paths in the PLUGIN's own space, the space Lexicon indexes. A host path never enters this
road.** `workspaceRoot()` already owns that answer, cached and admitted through `classifyWorkspaceRoot`.

`workspaceRoot()` sits under `references/` behind a residue test fencing that directory. It is extracted in
Phase 3, where the second consumer exists.

## Phase 2 - Confinement ✅ `src/mcp/workspace/confine.ts`

`src/mcp/workspace/confine.ts`, a pure module, with 38 behaviour tests. A mistake boundary, not a security
boundary: the session can already run commands, so the check buys an honest tree and a refused mis-tap and
claims nothing more.

It takes the root as an ARGUMENT rather than importing a resolver. That dissolves the extraction Phase 1
deferred: nothing reaches into `references/`, and the rule is testable against a fixture tree.

`confine` answers in five stages, the filesystem only touched by the last two:

1. **Lexical.** Refuses an absolute path, a drive-letter path, and any `..` walk.
2. **Spelling.** Control characters anywhere. On Windows only, alternate data streams and reserved device
   names, the base trimmed of trailing dots and spaces first since Windows drops them and `CON ` reaches the
   device.
3. **Withheld, as written.** `.git` as a whole segment at any depth, `.env` and the suffixes it prefixes as a
   leaf, matched lowercased because a case-folding filesystem aliases them.
4. **Canonical containment.** `realpath` of the root against `realpath` of the target, or of its nearest
   existing ancestor when it is being created.
5. **Withheld, as resolved.** Stage 3 again on the resolved path, so a link cannot launder a withheld file.

`fileIdentity` and `sameFile` compare dev and ino, the hole `realpath` cannot see: a hardlink gives one inode
two names that both resolve inside the root.

**Windows rules are platform-gated, not universal.** The first draft applied them everywhere, reasoning that
one rule beats a branch and a path might describe a Windows host. That was wrong, and Phase 1 is why: the
plugin serves its OWN filesystem, so no path on this road describes another machine. Ungated, it refused
`aux.ts` and any name holding a colon, both legal off Windows. The platform is a parameter so a test can
drive either.

**Short names, trailing dots and junctions are NOT refused as spellings.** Each RESOLVES, so stages 4 and 5
cover them, and refusing their spellings would reject real files. Only the alternate data stream is a genuine
escape, since it names different bytes beside a file that resolves the same.

**`node_modules` is hidden, not withheld.** It is bulk rather than secrets, so `listable` keeps it out of a
tree while a named file under it is served. `.git` and `.env` stay refused by both, and the segment rules
still apply inside it, so `node_modules/pkg/.env.production` is refused.

**`.env.example`, `.env.sample` and `.env.template` are served.** Committed and secretless, and refusing them
was a wrong refusal the audit caught.

The canonical stage was mutation-tested: disabling it admits the symlink escape and exactly one test fails.

### Bug Classes

**Mechanism:** path resolution in `confine`.
**Defect class:** a rule applied to the name as WRITTEN rather than to what it resolves to.

Patched twice, which makes it a design bug rather than bad luck:

1. Containment checked the written path, so a symlink whose parent pointed outside the root was admitted.
   Patched by adding the canonical stage.
2. Exclusion checked the written path, so `.env.example` symlinked to `.env` was admitted and a read would
   have served the secret. Any innocent name linking to a withheld one did the same.

The structural fix rather than a third patch: `withheld` is now one function run over both the written and the
resolved segments, and the resolved pass is not optional. A future rule added to `withheld` gets both passes
for free, so the class cannot return through a new rule.

**Mechanism:** the same resolution, asked twice.
**Defect class:** two filesystem calls deciding one fact, which can disagree.

An `existsSync` call decided whether to apply the leaf rule, and a separate `realpath` decided what the path
was. A link created between them was admitted, because the stale answer suppressed the rule. Not a mistake
the owner could make by tapping, but the fix removes the window rather than bounding it: `resolveTarget` makes
one resolution answer the real path, whether it exists, and whether it is a directory. They cannot disagree
because they are one answer.

### Accepted limits

- **A read does not compare inode identity.** A hardlink inside the root to an inode outside it is admitted,
  and `realpath` cannot see it since a hardlink has no target to resolve. The only available signal is
  `nlink > 1`, which would refuse legitimate links. Mutation compares identity; a read does not.
- **A listing can show what a read then refuses.** `listable` judges a name and `confine` judges a resolved
  path, so a symlink to a withheld file appears in the tree and is refused on open. Closing it would mean
  statting every entry while listing. Showing then refusing is the right direction to fail.
- **A directory is judged by what it is, not by its name.** `.env.d` as a directory is served so a tree can
  list it; the same name as a FILE is withheld. The leaf rule asks the resolution, not the spelling.

**Moved to Phase 3:** regular-files-only and the size cap. Those belong at load time, and `loadRefFile`
already owns them. Reusing it from here would reach into `references/`, so Phase 3 lifts that loader into a
shared module instead of either importing across features or writing a second copy.

`isSpawnWorkdirPath` validates spelling only and is the basis for none of this.

## Phase 3 - The bridge plane, reads only ✅

A request and response protocol on the socket each session's plugin already dials out and holds. This is
the whole reach: no new listener, no inbound hole, and it works identically for a host session and a
devcontainer one. The plugin answers without the agent taking a turn, because the socket callback and the
agent's work share a process but not a thread of control.

Bigger than "one frame kind". The plugin handles only `channel_push`, `response_push`, handshake and
registration today, so this needs:

- A frame pair and a dispatch on the plugin side.
- Reply correlation. `hostOpCoordinator` and `connector :: invokeOnClient` are the two existing patterns to
  copy; the bridge socket has neither.
- A pending-request map with a generation fence, since a reconnect today would lose an in-flight request
  silently and a retry could answer into a replacement socket.
- One socket per session chosen deliberately. A session can hold several plugin sockets, keyed team then
  `subId`. `isMainOrLead` rides the register message and `resolveLiveIncarnation` already picks a canonical
  one; use them rather than broadcasting.
- A per-request idempotency key with a short-lived completed map on the plugin, so a replayed frame answers
  the first result instead of acting twice. This is what settles the durable-road question: the plane is
  neither a transient value op nor the Router's delivery ledger, so at-most-once is defined here.

Reads in this release: tree listing, whole-file read, outline, symbol source, symbol knowledge.

### Done

- **The loader is lifted.** `src/mcp/workspace/loadFile.ts` holds regular-files-only, the 8 MB cap sized
  before the read, and the text-or-nothing decode. Refs and the plane both call it. Nothing read the
  loader's own path field, so no wire change was needed and `refPath` stays in the channel file schema.
- **The wire vocabulary.** `src/shared/workspace-op.ts`, beside `host-op.ts` for the same reason: it is
  vocabulary shared between the Gateway and an MCP-side process, and it never reaches Kotlin. Five read
  ops, one answer per op, and a failure union that keeps `refused` apart from `failed` so a withheld file
  never reads as a dropped socket.
- **Correlation, with the fence the host coordinator lacks.** `WorkspaceOpCoordinator` remembers the
  socket generation a request was issued on, so a late answer from a replaced socket cannot settle its
  successor's request. `failGeneration` settles only what one dropped socket carried, leaving another
  session's waits alone. Mutation-tested: removing the generation comparison fails exactly one test.
- **At-most-once, on the answering side.** `createOpDedupe` replays a settled answer for a repeated key
  AND joins a flight already open, which is the case a settled-only map misses: a replay arriving before
  the first answer would otherwise do the work twice. A thrown op is not held, since nothing was
  answered. Mutation-tested: removing the in-flight join fails exactly one test.

- **The frame pair and both ends.** The plugin dispatches `workspace_op` beside its `channel_push` branch
  and answers on the same socket, off the agent's turn. `createWorkspacePlane` picks the socket, sends,
  and awaits; `websocket.ts` settles `workspace_op_reply` for any session rather than only `host`.
- **Socket selection is `resolveLiveIncarnation`, not a new rule.** It already prefers a
  handshake-confirmed socket, falls back through the session store alias, and then to the first live one.
  Writing a second selector would have been the duplication the plan warned about. Nothing broadcasts.
- **The five read handlers.** Every path through `confine`, every byte through the lifted loader, and the
  Lexicon session INJECTED rather than imported, so the handlers never reach into `references/`. A tree
  sorts directories first and pages at `MAX_TREE_ENTRIES` rather than truncating silently. An outline
  renumbers Lexicon's zero-based lines to what an editor shows. `symbolSource` hashes the SPAN, not the
  whole file the daemon hands back, which is the whole point of the window binding.
- **A closing socket strands its waits at once** rather than leaving each to time out.

Verified on lint, tsc, 2810 tests and `check:boot`, which boots the real gateway and MCP with the plane
wired.

### A gate caught a real violation

`ws-send-residue.test.ts` refused a raw `socket.send` in the new plane: every socket write goes through
`wsSend :: sendOn`. Fixing it was better than the original, since a refused write now settles the waiter
at once instead of leaving it to time out saying nothing more.

### What the audit caught, and what it got wrong

Four real findings, fixed:

1. **A symbol id bypassed confinement entirely.** `symbolSource` and `symbolKnowledge` take an id, not a
   path, and an id EMBEDS its module. Lexicon checks only lexical containment and knows nothing of what
   this plane withholds, so an indexed `.env` would have answered. Both now parse the id and run its
   module through `confine`. Mutation-tested: removing the check fails exactly the two tests for it.
2. **A tree's `statSync` followed a symlink**, reporting an outside file's size for a child that
   `confine` would refuse. `lstatSync` reports the link itself. A Dirent from `withFileTypes` calls a
   symlink a file rather than a directory, which is why the stat was reached at all.
3. **A replaced socket stranded its waits.** `close` returns early for a stale socket, and the drop
   call sat after that return, so a replaced socket's requests waited out the full timeout. The drop
   now runs first: a replaced socket can never answer what it was carrying.
4. **The plane's timeout was shorter than Lexicon's patience.** A cold daemon could finish after the
   Gateway gave up, so the owner saw a timeout while the work completed. The index-backed handlers now
   run under a budget at three quarters of the plane's, answering with a cause instead.

   The FIRST attempt at this was itself wrong, and the re-audit caught it: a budget per CALL let an
   outline spend the full budget twice, once opening the session and once asking, which together outlast
   the plane's timeout and reinstate the blind timeout being fixed. It is now ONE deadline for the whole
   op, the shape `refResolve` already uses. The budget is injectable so the test proving it runs in
   200 ms rather than 15 seconds.

   The test for it did not bite on the first try either: a fast fake session left only one slow call, so
   per-call and shared behaved alike. Both calls have to be slow for the difference to show.

Also taken: measuring an answer's text rather than serialising the whole answer to weigh it, which
avoided a second full copy of a large file.

Rejected, because they are the Phase 2 decision rather than defects:

- That `node_modules/...` is readable by direct path. It is unlisted, not withheld, deliberately, so a
  named dependency file can be read while the tree stays navigable.
- That an outline of a path under `node_modules` is reachable. Same decision.

Accepted and recorded rather than fixed:

- **An in-flight read survives a reconnect** and its answer is discarded by the generation fence. Safe
  only because a read has no side effects. Phase 10 adds mutation and must revisit it.
- **A file under the loader's 8 MB cap can exceed the plane's 4 MB answer cap**, so it is readable and
  not servable. Intended, since a truncated answer would be saved back truncated, but it is a second
  effective read limit and the phone has to say so.

### Bug Classes

**Mechanism:** the timeouts bounding one read.
**Defect class:** related bounds with no single owner, which must be ordered and are not.

Three bounds now sit on one logical read, and they only work if ordered correctly:

| Bound | Value | Owner |
|---|---|---|
| The plane's wait | 20 s | `workspace-op.ts` |
| The handlers' index budget | 15 s | `handlers.ts`, derived from the plane's |
| Lexicon's own patience | 45 s | `attachRefs.ts`, set for refs |

Getting the order wrong produces a blind timeout: the Gateway gives up while the work completes, and the
owner is told nothing happened when something did. This phase produced that twice, once by having no
budget at all and once by applying the budget per CALL so two calls outlasted the plane.

Only the second is derived; the other two are independent numbers in different features for different
reasons. Nothing asserts `handler budget < plane wait`, and nothing relates either to Lexicon's patience.
The structural answer is one owner deriving all three from the outermost, with a test pinning the
ordering. Raised to crust rather than built now, since Phase 8 adds a save with its own bound and that is
the right moment to own all four at once.

### Left

- Nothing in this phase. The ops are reachable from the Gateway; the phone surface that calls them is
  Phase 4.

## Phase 4 - WindowOps and the phone surface ✅

An ops class first, because this project's own rule is that a decision the phone makes lives beside its ops
class and never inside a Composable, since there is no instrumentation test source set. `WindowOps` owns the
tap rules, the refresh rule, the two save roads, the open-window set and the drafts. The screens render and
call it.

Keyed by SESSION, not by Gateway. `GatewayReadFence` and `GatewayRegistry` key by Gateway and would collide
on two sessions of one Gateway, so windows need their own fence keyed by session address.

Five screens, mockups in `plans/lexicon-phone-editing/`:

- The tree with its long-press sheet, read-only operations live.
- A file's outline, with kind chips and the prose box.
- A symbol's detail: source, documentation, knowledge, `Open Window`.
- The window view: read-only context and, in this release, read-only spans plus `Agent Apply`.
- The ref viewer with `Open File` and `Open Window`.

No WebView in the window view. Read-only context is Compose rows and an editable span is a Compose text
field, which sidesteps `contenteditable` over syntax spans and its selection, undo, IME and extraction
problems. The WebView stays where it already works, in the ref viewer, whose document moves onto the app's
Material surfaces keeping only the blue band and the amber mark.

A draft persists to a file under `filesDir`, written atomically. NOT the runbook store: `RunbookManager ::
commit` serialises a whole library into one preferences string, which a code span can overrun and which
rewrites everything on every keystroke-batch.

### Done

- **The phone can reach the plane.** Five console ops, one per read, because a nested union generated an
  opaque payload the phone would have to build by hand and every other feature uses one kind each. Each
  names a SESSION, never a spawn point.
- **The answer shapes became Zod.** They were plain interfaces on the stated premise that they never reach
  Kotlin, and the phone reading them makes that false. `schemasWorkspace.ts` owns them, the codegen lists
  it, and `Protocol.kt` carries seven real data classes rather than a `JsonElement`.
- **`ConsoleClientWorkspace.kt`** keeps three outcomes apart: read, refused with the gateway's reason, and
  unreachable. Collapsing the last two would draw a withheld file as a dropped connection.
- **`WindowRules.kt`** holds every rule: the session-scoped target key, the descriptor carrying the span
  hash, the refresh rule, the two submit roads, the accumulating window set, what an agent request must
  carry, the numbered lines a card draws and the outline's chips. `*Ops` is this codebase's name for the
  STATEFUL class (`RoutineText`/`RoutineOps`), so the pure half took the other name.
- **`WindowOps.kt`** is that stateful class, over a `WorkspaceGateway` port: the open windows, the drafts,
  a per-module context cache, the fence, the foreground re-check and the banner's adopt. Its held state
  has ONE road in, `apply`, which hands a transform what is held now and writes what it returns. A
  decision made from a value read before a network wait therefore cannot be written back, which is the
  class that recurred twice in this phase. `ReadSlot` is a sealed type, so a fence key cannot be invented
  by a caller. Twenty-six JVM tests drive it with no socket.
- **The fence needed no new class.** `GatewayReadFence` already keys by an opaque string; only its parameter
  name said gateway. Renaming that one word removed the lie without touching a call site, so windows key the
  same fence by session address.
- **`WindowDraftStore.kt`** writes ONE FILE PER DRAFT under `filesDir`, write-then-rename, keyed by a hash
  of session and symbol id. Eleven tests, and session scoping is mutation-tested.
- **Four screens behind one Back stack**, in `workspace/`, plus `WorkspaceNav.kt` for the stack, the title,
  the child path and which sessions hold a workspace. Nothing decides anything inside a Composable.
- **`SandboxWorkspaceGateway`** answers as a session's plugin would, which is the only reason all four
  screens could be looked at at all. One seeded session refuses everything, so the refusal notice is
  reachable, following the rule that each seeded Gateway answers differently.

Green on lint, tsc, `check:boot`, 1371 Kotlin tests, and `kotlin-gate.sh`, which CI does not run. Every
screen was walked on the emulator.

### Bug Classes

- **A default that invents data hides the bug that needed it.** `windowLines` asked the file for context
  lines either side and read them through `getOrElse { "" }`, so a span near the top of a short file drew
  blank rows numbered for lines the file does not have. Indexing directly, with the range clamped to the
  file, made the same mistake throw instead. The mechanism is the display builder; the class is a lenient
  accessor standing in for a bound.
- **A layout slot that does not carry its caller's weight.** `WorkspaceAnswerBox` passed its modifier to
  the loading and refusal branches but not to the answer, so a content `fillMaxSize` pushed the outline's
  Raw button off screen. No gate here compiles a layout; the emulator found it.
- **A fixture that contradicts itself proves nothing.** Both Kotlin test files built a symbol answer
  claiming lines 4 to 9 over one line of text, which is why the first edge-case test asserted something
  misleading and still passed. The range is now derived from the text. The mechanism is the test fixture;
  the class is a hand-written invariant that nothing enforces.
- **An ordering applied after a cap.** `treeOf` sliced to `MAX_TREE_ENTRIES` and sorted what survived, so
  an over-cap directory answered an arbitrary thousand of itself. Sorting before the slice is the fix, and
  the same shape is worth checking wherever a cap and an order meet.
- **A fence key that does not name what the read is for.** TWICE in this phase, in `GatewayReadFence` as
  `WindowOps` uses it. Round one keyed every read of a session alike, so a symbol's source and its
  knowledge cancelled each other and the detail screen drew one pane as unreachable. Round two was the
  window's context read, which fills a per-module cache and has nothing to overwrite, so fencing it let an
  unrelated tap strip that file's context with nothing to retry. The rule the mechanism was missing: a
  fence key names the SLOT a read fills, and a read that fills no slot is not fenced at all. `GatewayReads.kt`
  says the key is "whatever the holder scopes by", which is true and is not enough to choose one.
  CLOSED by `ReadSlot`, a sealed type with one case per slot, so there is no string for a caller to invent.
- **A snapshot outliving the await that made it stale.** The recheck sweep read its windows once and judged
  each gateway answer against that snapshot, so typing during the sweep was overwritten. The same shape
  was patched once before in this phase, as the save that checked `holdsDraft` outside the lock it needed.
  Both are a decision made from a value read before a suspension point.
  CLOSED in two rounds, the second because a red team broke the first. `apply` is the one road into held
  state and hands a transform what is held NOW. That alone was not enough: a symbol id names which span,
  not which OPENING of it, so a sweep begun before a close and reopen still landed on the window that
  replaced the one it read, an open in flight during a close resurrected it, and an open in flight during
  a re-provision brought back the previous owner's code. A window now carries an incarnation minted at
  open, and the set an epoch that moves on every close and on the wipe; work reads one at the start and
  lands nothing if it moved. Each guard is mutation tested.
- **A control byte written into source.** A unicode escape passed to an editing tool landed as the byte in
  three files. It compiles, so every gate here was green, while `grep` treated the files as binary and
  Lexicon would not index them. Two separate audit rounds reported it and the first was dismissed as a
  hallucination. The separator is constructed rather than written now, and `control-byte-residue.test.ts`
  reads every tracked Kotlin and TypeScript file for the class.
- **Draft persistence, patched twice.** Round one: a failed rename deleted the previous draft to make room.
  Round two: concurrent writes shared one temp path and could land out of order. The mechanism is
  `WindowDraftStore` plus its callers; both rounds were the same class, a write path that is atomic in one
  step and not across its callers. A mutex owns the ordering now.

### What the audits found

Five alignment agents, a comment audit and a test audit ran over the phase. Fixed: the tree's cap, the
amber mark never being applied, a draft save landing after the clear meant to discard it, a failed rename
deleting the previous draft, the gap row counting lines both cards draw, the outline not indenting under
its container, the sandbox keying its refusal by Gateway rather than session, four decisions sitting inside
Composables, and the test fixtures above.

Rejected, with the reason:

- **The window has no editable span, no `Agent Apply` and no `Save`.** Those are Phases 5 and 8. The
  mockups show the end state of the feature, not the end state of this phase.
- **The tree sheet has no Move, Rename, Duplicate, Delete or Send to agent, and Raw is read-only.** Phases
  9 and 10.
- **`WorkspaceTarget` keys by Gateway and session together.** A session address already names its own
  Gateway, so the pair carries one fact, not two that can disagree. The Gateway is kept because a call
  needs to know which machine to post to, which a cross-Domain address does not answer.
- **The tree has no parent row.** Back is the parent row, and the header carries the path.
- **Every card has a Close the mockup does not show.** Windows accumulate, so closing one is not optional.
- **The empty state chooses its own wording inside a Composable.** Every sibling tab does the same, and the
  audit found them itself. Changing one screen alone would make the codebase less consistent, not more.

Still open, recorded rather than fixed:

- **The prose road is in no phase.** The owner asking for windows in prose, and an agent minting them, is
  half of Q12's answer and no phase owns it. It needs the session to push a window set to the phone, which
  is new machinery. Recorded on the board.
- **An open window does not survive the process, only its draft does.** Reopening the symbol restores the
  typing; the window set itself is memory.
- **A failed draft write is silent.** `save` swallows its failure, so a full disk loses the only restart
  copy without saying so.
- **A renumbered id restores a draft onto the wrong span.** An occurrence-numbered id moves when a
  same-named sibling is inserted above it, and a draft is keyed by that id. Name and module do not
  disambiguate, since the sibling shares both. Phase 7's compare-and-swap is where this gets an answer.
- **The gateway collapses three read outcomes into two.** `workspaceReadOf` throws, and the frame layer
  turns every throw into a refusal, so a dropped plugin socket reaches the phone as a refusal. The owner
  reads the truth because the failure word rides in the message, but the code's distinction is lost.
- **A whole file is pulled for two lines of context.** There is no ranged read, so a window in a large
  module transfers the module. Cached per module and dropped when its last window closes.
- **`GatewayReadFence` still takes a plain string.** `WindowOps` cannot pass a wrong key, since `ReadSlot`
  is sealed, but the primitive is shared and its other callers join a gateway id and a record id with a
  slash. A gateway id holding a slash would collide two rows onto one counter. Not this feature's to
  change, and no gateway id can hold one today.

### What the architecture pass decided

Five agents assessed the two recurring classes and the shape around them. Two changes landed, and they
are the reason the classes are now unwritable rather than merely patched: the single `apply` road into
held state, and `ReadSlot` as a sealed type. Both are local to `WindowOps`.

Three were considered and deliberately not done:

- **A workspace read catalog**, one registration replacing the eleven files an added read touches today.
  Real, and the count is right. It is infrastructure shared with every console op, not this feature's, so
  it belongs to its own plan. Phase 6 adds a field to an existing answer and Phase 8 adds a write, so the
  cost is felt twice more before it would pay for itself.
- **A timeout contract** owning the ordering of the plane's wait, the handler's budget and Lexicon's
  patience. The pass ranked it first on its angle and named the same condition Phase 3 already recorded:
  Phase 8 adds the fourth number, and owning three of four now would be guessing at the fourth.
- **A `WindowManager` beside `WindowOps`**, matching `RunbookManager`. That split exists because a runbook
  library is durable and shared across Gateways. Windows are memory plus one draft file per span. Copying
  the shape without the pressure that earned it would add a layer, not remove one.

### Left

- The ref viewer's two exits, which need the span hash refs do not carry yet. They move to Phase 6, where
  that hash is added.
- The detail screen's per-question knowledge, its badges and its facts rows. The plane answers
  `describe_symbol` as one block of text, and parsing that on the phone would be a twin of Lexicon's own
  formatter. A structured knowledge answer is its own phase, recorded on the board.

## Phase 5 - Agent Apply

The phone sends the owner's text as an ordinary `send`, which already carries arbitrary body text to a
session's conversation under an 8 MB relay cap. No write plane, no descriptor to verify, no Lexicon change.

The message must carry the full symbol id, the module, and the ORIGINAL span text the owner was shown,
because a bare name is refused as ambiguous and an occurrence-numbered id can renumber. The agent compares
the original against what it reads now and refuses on a mismatch rather than writing blind.

That comparison runs at human pace, not under a lock, so Release 1's Agent Apply is best-effort. Phase 7
makes it a guarantee.

The agent's `channel_reply` already reaches the owner, so the result is visible as a normal reply. Nothing
marks it as an apply result or refreshes the window; the foreground re-check covers it.

## Phase 6 - Refs carry a span hash

Slice the resolved range, hash the slice, and add it as one new optional field on `RefKeyMetaSchema`. That is
what lets the viewer say `Changed since sent` and offer Sent against Now.

`resolveOne` hashes the WHOLE file transiently and the metadata keeps no hash, so this is new work rather than
retention. `sliceRange` and `hashContent` are the primitives.

# Release 2 - Saving without the agent

## Phase 7 - Lexicon span compare-and-swap

A replace accepting an expected span hash, re-resolving the id and hashing the span it now covers, inside
the writer gate, in one step.

This needs the gate restructured, not just a new argument. `journaledStep` wraps the staleness check, the
journal, the write and the reindex; planning runs outside it. The re-resolve and the span hash have to move
in, which means either a gated validation phase or moving `planReplacement` wholesale, candidate parsing
included.

Hash the exact `sliceRange` text, since ranges are zero-based lines and UTF-16 columns, and a TypeScript
declaration range swallows a touching doc comment, so "the span" includes documentation.

Also close the crash hazard this feature exposes: `recover` drops unfinished steps without closing the
transaction row, so a crash leaves it open and blocks every later session. A phone save makes that reachable
far more often than an agent's refactor does.

Then move the pin again.

## Phase 8 - The window descriptor and Save

The descriptor is `(symbolId, range, spanHash)` and carries no capability, so it needs no key, no issuer and
no expiry. Authority is the owner's already-signed console op, and a wrong descriptor either fails the hash
or names another symbol. Stateless, so a restart costs nothing.

Save: start a transaction if none is open, join one if it is, commit ONLY if it opened it, as `joinCreate`
does in the wake service. A commit the phone's own transaction cannot close is forced, with the issues
reported in the answer rather than blocking, though the audit found that path is rarer than assumed since
`impactOf` raises an issue only for newly dangling references.

Refresh silently whenever nothing of the owner's is lost; show the stale banner only when a refresh would
discard their typing.

## Phase 9 - The raw whole-file editor

The tree's sheet offers `Edit raw` and nothing built it. A whole-file read into a Compose field, its own
draft under `filesDir`, and a Save that goes through Phase 10's preconditions.

The relay cap is 8 MB and the read cap is lower. A file past the cap opens read-only and says so, rather than
loading a truncated body a Save would write back.

## Phase 10 - Whole-file mutation

Write, create, delete, move and copy over the plane as plain file work, never through Lexicon.

Preconditions per operation, because an expected SOURCE hash alone is not idempotency. A repeated copy
succeeds again; delete and move can act on a recreated file with identical bytes, since a content hash binds
no file identity.

- Write: expected source hash.
- Create: expected destination absence.
- Copy and move: expected source hash, expected destination state, and explicit overwrite rather than
  implied.
- Delete: expected source hash plus the resolved file identity.
- Atomic semantics named per operation, and directory cases decided rather than inherited.

Destructive operations are armed on the phone, not one-tap, and an answer the phone never received is
reconciled by re-reading rather than retried blind.

## Phase 11 - The awareness notice

A raw edit banks a `no_act` `RidingAwareness` naming the file, so the agent's model of it is corrected by the
next message it was going to get anyway. No push, no acknowledgement.

# Painpoints

## Asking where a project lives takes four functions and three processes

`workspaceRoot`, `findProjectPath`, `resolveProject`, `resolveHostWorkdir` and `PROJECT_HOST_PATH` read as
five spellings of one question. They are not. Two answer in the plugin's space and three in the host's, and
nothing in a name or a comment says which. Working that out cost a read of all of them, and two auditors
never did, which is what produced the rejected disagreeing-roots finding.

## The obvious version command lies

`git describe` in `lexicon/` answers a `v3.0.2` tag for a 3.7.x package, because tags there stopped. It is
the first thing anyone reaches for and it reads as years of drift. It put a wrong fact in front of the owner.

## These phases are not sized for a twelve-step audit lap

Phase 1 was a submodule pointer and a plan correction, and the lap spent ten steps finding nothing to do.
Phase 6 is one optional schema field and will be the same. Either those fold into their neighbours, or a lap
covers a release rather than a phase. Worth settling before the remaining laps, not during them.

## Three near-miss path checks, none reusable

Writing confinement from scratch was right, and that is the complaint. `refWorkspace :: classifyPath` does
lexical containment and module spelling. `isSpawnWorkdirPath` does shape. Lexicon's `insideWorkspace` does
containment with a realpath. Each is adjacent, none composes, and two of them are the wrong strength for a
write. A fourth now exists. Nothing forces a new path rule to land in one place, so a fifth is likely.

## Nothing marks a comment as load-bearing

A prose agent asked to enforce a four-word rule proposed gutting the comments that document the leaks
this lap closed, because nothing distinguishes a comment carrying a rule from one narrating. Its
replacement for the symbol-id confinement note was "Confinement precedes lookup", which loses the entire
reason and invites the next reader to delete the check. The codebase has no convention for this, and a
word-count rule applied without one actively erodes the comments worth keeping.

## A socket's identity had nowhere to live

The plane needs to know which incarnation of a session's socket a request went to. `WsData` carries
`subId`, `handshakeConfirmed` and `isStale` but nothing generational, and adding a field there means
touching a type every socket construction site shares. A `WeakMap` keyed by the socket object works and is
local, but it means the answer to "which incarnation is this" lives in whichever feature asked first. The
second feature to need it will build a second one.

## The cycle runner's phase text freezes at start

The runner still replays Phase 1's original wording, including the premise this lap rejected. The plan moved
and the spec shown each step did not. Nothing warns about it, so a later lap could audit against text that no
longer describes the intent. Read the plan file, never the runner's copy.

## The emulator is the only gate for a screen, and it is driven by pixels

Two real defects this lap were invisible to lint, tsc, 2820 TypeScript tests and the Kotlin gate: a layout
slot that did not carry its caller's weight, so a footer button went off screen, and a view that composed one
row per line before drawing anything. Both needed a screenshot.

The loop to get one is a build, an install, a scripted tap sequence and a screencap, and the tap sequence is
hardcoded pixel coordinates. Those shift the moment a row appears above them, so the script silently taps the
wrong thing and the screenshot still looks plausible. I lost a round to exactly that when the header gained a
Back button. There is no deep link into a tab, so every check re-navigates from the top.

## The sandbox cannot reproduce a race, and nothing says so

`SandboxWorkspaceGateway` answers inline with no suspension. That makes it a fine rendering fixture and a
useless behavioural one: the worst bug of this phase, two fenced reads of one session cancelling each other,
is invisible there and appears immediately in a JVM test with an explicit hold. `AGENTS.md` describes the
sandbox as what makes a refusal screen reachable, which is true, and says nothing about what it cannot show.
A reader who smoke tests on the emulator and sees green has tested rendering only.

## A cached test task reported a green that was not run

While mutation testing, `./gradlew :app:testDebugUnitTest --tests ...` answered `FROM-CACHE` and
`BUILD SUCCESSFUL` after a production source change. A mutation that should have failed a test appeared to
pass. `--rerun-tasks` is needed for this work and nothing says so; `kotlin-gate.sh` passes through to the
cached task too. A gate that can answer for a build it did not run is the same class as a gate that cannot
see a failure.

## An editing tool writes a unicode escape as the byte

Asking for a separator character put a raw NUL into three source files. They compiled, so every gate stayed
green, while `grep` treated the files as binary and Lexicon would not index them. Two audit rounds reported
it and the first was dismissed. The tool gives no way to ask for the escape text, so the construction has to
avoid the literal entirely: `Char(0x1e)` in Kotlin, `String.fromCharCode` in a test. `control-byte-residue.test.ts`
now fences it, but the trap remains for anyone writing a string.
