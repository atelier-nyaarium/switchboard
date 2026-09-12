# Artifact references

`ref://` links in a reply become code snapshots the console can open.

Only `full` on `channel_reply` and `notify_human` scans markdown links. Other fields, crosstalk, code
fences, and inline code do not.

**Path:** bare means the project root, `/x` the filesystem root, `~/x` home.

**Chain:** colon-separated scope and name segments. `[n]` selects the nth same-named declaration.
`arguments` selects a parameter list; `arguments:name` selects one parameter.

The project root comes from `REFERENCE_ROOT`, the host's first `roots/list` answer, or the server
start directory, each resolved to its git toplevel. A plugin-directory cwd falls back to shell `PWD`.
Root discovery is bounded by `HOST_ROOTS_TIMEOUT_MS`.

**Text:** `#text` searches the chain's declaration, or the whole file without a chain. `#from..to`
selects a range. `#text@before:anchor` and `#text@after:anchor` select the nearest occurrence.

Escape spaces and closing parentheses, or use angle brackets. Percent-encode literal `..` and
`@after:`.

One worked example per matcher. A test pins them:

    [chain](ref://src/App.tsx:App:render)
    [text](ref://src/cart.ts:Shop:Cart:add#this.count)
    [range](ref://src/cart.ts:Shop:Cart:add#this.items..reset)
    [before](ref://src/cart.ts:Shop:Cart:add#this.count@before:reset)
    [after](ref://src/cart.ts:Shop:Cart:add#this.count@after:reset)

**Two exits.** A snapshot's viewer opens the file's outline, and the declaration's editable span when
the ref resolved to one. What the ref carries decides which are offered, so a path with no chain shows
the file alone.

**What a resolved key carries:** its canonical key, the lines, an optional character span, the quality
and its reason, the hash of those lines, and the symbol id the chain resolved to. The hash is of the
LINES, so an edit elsewhere in the file is not a change to what the reader was shown. A key the schema
would refuse is dropped rather than sent, since one refused key fails the whole snapshot's metadata.

**Refused, naming the fix:** outside-root chain, missing or ambiguous name, or no matcher result.
`exact` requires one hash-verified declaration.

**Degraded to `fuzzy` or `unresolved` with a notice:** only when the lexicon cannot answer because it
is absent, incompatible, warming, dead, or refuses the workspace or file.
