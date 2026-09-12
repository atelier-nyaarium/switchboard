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
to the spawn point's project by default.

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

So the prose request IS the feature's entry point. Direct edit and proposal go through the same door:
a direct edit is the owner sending the span, a proposal is the owner sending words and the agent
sending the span.

## Question 3 - What is the threat model?

Q: How much security work does phone-side writing need?
A: The compromised host is out of scope. Everything else is in.

> But that falls under the /security rule of if their computer was compromised, then it literally
> doesn't matter anyways. So identity with Sol. the REAL security implications for the non pwned case.

Sol's verdict: no new authority class, because `tmux_send` already relays arbitrary text into a
terminal, which is already command execution from the phone. This is a reachability change, not a
power change. Four things do not come for free:

1. **Replay.** Delivery ops get a durable Router ledger, gateway claims, target binding and host
   dedupe. Value ops are transient RPCs with none of it. A write added to the value-op kinds could be
   replayed by the Router with no forgery. Writes need the durable road, which today only addresses
   sessions, so it is real work.
2. **View to write.** `refactor_replace` takes a symbol id plus new text and re-resolves fresh.
   Nothing binds the save to the span the owner was shown.
3. **Path confinement.** `isSpawnWorkdirPath` validates SPELLING only and would accept a path outside
   the project. Fine for listing, useless for writing. Confinement belongs in the host daemon, the
   only part that knows the spawn-to-project mapping. Lexicon's `insideWorkspace` is a better
   starting point but still has a check-to-write race.
4. **Shared transaction.** Lexicon's refactor transaction is one per workspace, has no owner,
   survives daemon restart, and any session can revert it, which deliberately bypasses undo. Phone
   saves must be single-shot, never held across a screen lock.

Also medium: whole-file reads make source and secrets easy to cache in Android state, logs and
backups. Delete, move and copy become one-tap, so they need expected source hashes, expected
destination absence, explicit overwrite and atomic semantics.

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

Split: Lexicon grows a replace taking an expected span hash. Switchboard mints and carries the window
token, and owns the phone surface, the plugin, and the host filesystem operations.

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

One addition to the existing pipeline carries it: the snapshot starts keeping the span hash it was cut
from. `refResolve :: resolveOne` already hash-checks against the file at resolve time, so the hash exists
and is simply discarded; keeping it lets the viewer compare in one step.

That makes ONE hash concept serve both features. The window's freebie rule and the ref's
changed-since-sent strip become the same comparison, so there is a single thing to get right rather than
two that can disagree.

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

A file that moved during the restart fails the span hash and the owner sees the new text. Designed
path, not a break.

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

The evidence against folding them is already on disk: the submodule pin sits at `v3.0.2-119-g7077be2`
while the live project is at 3.7.1. If Switchboard owned the agent's Lexicon tools, the agent would be
limited to whatever Switchboard last shipped, two minor versions stale today, and every Lexicon release
would need a Switchboard release to reach the owner.

One MCP plugin also cannot call another, since they are separate processes, so Switchboard needs its own
Lexicon client regardless. It already has one for refs. Two clients against one daemon is not duplication;
that is what a server is.

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

The property this buys is that the stale banner is never noise. On screen means something is at stake.

Proposing back was declined. Its cost, recorded in case it returns: a new phone-bound row kind naming a
window, carried on the durable `OwnerRowOutbox` road that already pushes to the phone.

# Mockups

Four accepted screens in `plans/lexicon-phone-editing/`, saved beside this plan at the owner's request
because the feature is large enough to need referring back to. Each is a self-contained design card at
phone width, built on REAL Lexicon answers and real directory listings, not invented shapes.

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

Accepted over three rounds on the symbol window and one each on the others.

> that's pretty good.
>
> looks good.

## Terminology: Window

Each span the owner can edit is a Window. Their own word, used in the plural for one file:

> if the file is updated, it needs to invalidation my windows

Not "file", since the other cards stay savable while one is stale. Not "span", which is jargon the
owner never used.

## Every explanatory sentence comes out

The owner cut all three on sight: the label above the prose request, the paragraph in the stale banner,
and the footer line explaining the two buttons. A label plus data stays; a sentence telling the owner
what a control does goes. The stale banner is now a bold title, one line, and an inline action.

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

The real values live in the refview stylesheet as `--band` and `--span`, and they are not alternatives:
`.line.in-range` takes the blue band and `mark.span` takes the amber, so a line-range ref carries both.

- **Blue band**, `rgba(56, 139, 253, 0.20)` dark: these lines are the selection.
- **Amber mark**, `rgba(210, 153, 34, 0.38)` dark: this text is the symbol.
- **Purple accent**, the M3 primary: this is editable.

Three meanings, no overlap, and they compose. A window opened from a line range carries a band, a mark
and an accent without any of them fighting. The amber also names which symbol a window card is on, which
the first draft was missing.

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

# Codebase Facts

Gathered 2026-09-12 by six explorer agents. Kept so a compaction does not cost the refresh.

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

Two releases, settled in Question 20. Nothing in the first touches Lexicon, so the Lexicon patch is never
on the critical path.

A consequence found while splitting them: **Agent Apply belongs in the first release.** The agent writes
through its own Lexicon tools, which already exist, so the phone only has to compose a message naming the
window and carrying the owner's text. No write plane, no token, no Lexicon change. Only the direct
no-agent Save waits for the second release.

So the first release reads everything and can change anything through the agent. The second removes the
agent from the loop.

# Release 1 - Reading, and Agent Apply

## Phase 1 - Move the submodule pin

Bring the `lexicon` submodule from `v3.0.2-119-g7077be2` up to the live project and fix what breaks. Debt
already owed, forced by this feature rather than created by it. Nothing else can be trusted until the pin
and the daemon agree.

## Phase 2 - The bridge plane, reads only

A request and response frame kind on the socket each session's MCP plugin already holds open to the
Gateway. The plugin process answers it without the agent taking a turn. This is the whole reach: no new
listener, no inbound hole, and it works identically for a host session and a devcontainer one.

Reads only in this release: tree listing, whole-file read, outline, symbol source, symbol knowledge.

## Phase 3 - Confinement

Needed even for reads, so the tree cannot wander and a path that escapes the workspace is refused rather
than served. A mistake boundary, not a security boundary: the session it runs in can already run commands,
so the check buys an honest tree and a refused mis-tap, and claims nothing more.

Default root is the workspace, which is also Lexicon's root. Going wider is a deliberate act.
`isSpawnWorkdirPath` validates spelling only and is not the basis for any of it.

## Phase 4 - The phone surface

Five screens, mockups in `plans/lexicon-phone-editing/`:

- The tree with its long-press operations sheet, read-only operations live.
- A file's outline, with kind chips and the prose box.
- A symbol's detail: source, documentation, knowledge, `Open Window`.
- The window view, read-only spans with their context, plus `Agent Apply`.
- The ref viewer with `Open File` and `Open Window`.

The window view starts from `ReferenceViewer`, which already draws highlighted code in a WebView. Its
document moves onto the app's Material surfaces, keeping only the blue band and the amber mark.

A draft persists to disk, not just to its ops class, since the ops class dies with the app process. The
runbook library is the pattern.

## Phase 5 - Refs keep their span hash

`refResolve :: resolveOne` already hash-checks Lexicon's answer against the file and discards the result.
Keep it on the snapshot so the viewer can say `Changed since sent` and offer Sent against Now.

# Release 2 - Saving without the agent

## Phase 6 - Lexicon span compare-and-swap

A replace taking an expected span hash, re-resolving the id and hashing the span it now covers inside the
writer gate in one step. The gated whole-file compare already exists in `planReplacement` and
`refactorReplace`; this changes what is hashed and accepts the expectation from the caller.

Then move the pin again.

## Phase 7 - The window token

Stateless and verifiable by the process that minted it, carrying workspace, module, symbol id, range, span
hash and expiry. A save presents the token and the bound symbol is used, never one supplied anew. Stateless
because Lexicon's transaction is ownerless and restart-surviving, so nothing good comes of storing window
state beside it, and because stored state would invalidate every open window on every update.

## Phase 8 - Save

Start a transaction if none is open, join one if it is, and commit only in the first case. Force a commit
the phone's own transaction cannot close, reporting the issues in the save's answer rather than blocking on
them.

Refresh silently whenever nothing of the owner's is lost; show the stale banner only when a refresh would
discard their typing. In Release 1 that rule is trivially satisfied, since nothing is ever unsaved.

## Phase 9 - Whole-file mutation

Write, create, delete, move, copy over the plane as plain file work, never through Lexicon. Every mutation
carries an expected source hash and, where it creates, expected destination absence.

A value op's `opId` is not a durable idempotency key, so a duplicate frame can invoke a handler twice. The
expected-hash precondition is what makes the second attempt fail rather than repeat.

## Phase 10 - The awareness notice

A raw edit banks a `no_act` `RidingAwareness` naming the file, so the agent's model of it is corrected by
the next message it was going to get anyway. No push, no acknowledgement.
