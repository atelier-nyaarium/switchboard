# Live console

A read-only expression language over Gateway state. A session inspects live state without scripting over state files. Each Gateway answers for itself. Agents use the MCP `console` tool as their door, and the owner uses the phone's Console page; both send the same expressions to the same engine.

## Grammar

`src/shared/live-console-grammar.ts`: lexer, recursive-descent parser and AST. The implementation is pure so the phone can twin the tokenizer.

- Paths and calls: `sensors.read("Freezer").readings[0]`.
- Indexing: `list[0]`, `list[-1]`, `record["key"]`.
- Operators: `== != !` and `+ - * /`. A `-` is always an operator, never part of a number. `5-3` reads as subtraction. A literal or a result that is not finite is refused as `too_big`.
- Literals: numbers, strings in either quote, `true`, `false`, `null`, lists `[a, b]`, dicts `{k: v}`.
- Statements: `;` separates them, at most `CONSOLE_STATEMENTS_MAX`. A new line is whitespace, so an expression wraps. A statement may open with `name =`, which saves its result for the rest of the call; `=` anywhere else is refused. A saved name follows `isConsoleVariableName`, and an entity's name is refused.
- Partial input parses. An open call, index, member, list or dict has `closed: false`, an open string has its token's `closed: false`, and evaluation refuses either. Every node carries a span in UTF-16 code units.
- Caps: `CONSOLE_SOURCE_MAX` characters and `CONSOLE_NODES_MAX` nodes.

## Engine

`src/gateway/liveConsole/`:

- `registry.ts`: entities expose property members with `get` and method members with `params` and `returns`. Each parameter has a Zod schema. Registration refuses malformed names and required parameters after optional ones. `projection(audience)` is the one description: the agent's text (`describe`) renders from it, the phone receives it as data, and `hash` is a hash of it, so any change to a member, a parameter or a builtin moves the hash.
- `builtins.ts`: one table of value methods (`count`, `first`, `take`, `skip`, `keys`, `where`). Evaluation and `describe` read this table.
- `evaluate.ts`: each call walks its statements in order over one step budget, and answers one result per statement. An entity outranks a saved name. A record or a list read from a registry member carries that member's declared type (`take`, `skip` and `where` keep it, `first` and an index unwrap `List<T>`), which is how the phone picks a card; a scalar carries none. Only registry members and builtins are callable, so nothing reflective runs. A handler's answer is cloned once read, so no live value leaves. The step budget, `CONSOLE_STEPS_MAX`, bounds a query on the Gateway's single loop, and every builtin that copies charges a step per item. A member marked `slow` runs once per expression, so a list of listens cannot outrun the route's wait. Every failure has shape `{ code, start, end, message }`.
- `render.ts`: `key: value` lines. Owner-named text and keys use `oneLine` and `neutralizeMarkup`. A whole number under a known instant key (`at`, `heardAt`, `lastAt`, `firedAt`, `readAt`, `lastSuccessAt`, `nextPollAt`) renders as an age and a UTC time. Nesting stops at depth 3. An answer stays within 16 KiB, its note included: a list stops between items with a footer naming the `.skip(n)` that continues it, and a record or an oversized first item stops between lines. An error renders the source with a caret under its span.
- `entities.ts`: what the console reads, every answer a projection.

## Registry

| Entity | Members |
|---|---|
| `gateway` | `id`, `version`, `router`, `temperatureUnit` |
| `devices` | `list`, `get(device)` |
| `sensors` | `list`, `read(device)` (each reading's `value` and `shown` in the owner's unit, its 24-hour low and high), `payloads(device)`, `extremes(device, key)` |
| `thresholds` | `list`, `get(device)`, as the owner set them, in the owner's unit with a `unit` |
| `fields` | `list`, `get(id)` (the record and why invalid), `read(id)` (its value or why unknown, its seq and last transitions) |
| `automations` | `list`, `get(id)` (the record and why invalid), `read(id)` (its checkpoint), `runs`, `queue` |
| `sources` | `list`, `get(id)` (fields, rules with the catch-all last, commands; never its setup text or vault entry ids), `read(id)` (unread, polls, backoff, unexpected values), `test(id, fields)` (the rule an event meets and its action) |
| `bluetooth` | `listen(seconds?)`: host radio sightings for the window, loudest first, at most 256 addresses. Each row names its family, and `unsupported: yes` marks a device never paired. Host sessions only, since a listen outlasts the phone's answer wait. |
| `definitions` | `list`, `get(key)`, `match(advert)`, `decode(key, advert)` |

**Verbs:** `list` answers all, `get(x)` one record as set, `read(x)` what it is doing now, as a copy at that moment. A narrower view is a noun (`payloads`, `runs`); a member that computes keeps its verb (`test`, `decode`, `listen`). `sources` reads today's watchers under the word that replaces them.

A device is named by id or by name. `definitions` is a catalogue listed under Types in `describe`. The other entities are live services. A parameter may declare which live ids complete it (`completes`), so the phone offers them without knowing any entity's name.

**`bluetooth.listen` writes nothing:** the `bleListen` host op holds discovery for the requested window. The default is 120 seconds. `CONSOLE_LISTEN_MAX_S` caps it below the Gateway's 255-second idle cut. It hears only that window and never reads BlueZ's cache, so it holds `DuplicateData` on for the window: a beacon whose advert never changes is still heard. `Scan` is not registered because it refreshes plug addresses.

## The owner's door

`LiveConsoleStage.console` answers three console ops, composed before the router frames so the dispatcher holds only this port:

- `console_describe`: the projection and its hash. The phone caches it per Gateway and reads it again when an eval answers with another hash. The projection carries type labels, never schemas: the hash covers exactly what the phone draws, and the Gateway alone validates arguments.
- `console_ids`: what completions may name now (devices with their reading keys, fields, automations, sources, definitions). Never cached, since ids move.
- `console_eval`: one result per statement (the value, its registry type, an entity named alone, the name it was saved under), or the issue. The results share `CONSOLE_VALUE_BYTES`; a printed list is cut between items and says what it left. Both arms carry `registryHash`, so a stale vocabulary is noticed on an error too.

**Variables belong to whoever evaluates.** A save lasts the call on both doors. The phone also keeps each saved value with its type, in memory, for the console session, and a later read sends only the saved values its expression reads (never a member, a key or a save target of the same name). A save must be whole: a value that would be cut is refused rather than kept short. An entity itself cannot be saved.

The phone (`android/.../liveconsole/`): `ConsoleTokens.kt` is the tokenizer's twin, pinned by `tests/fixtures/live-console-tokens/vectors.json` (regenerate with `bun scripts/gen-console-token-vectors.ts`). `ConsoleAssist.kt` decides completions and the parameter hint from the tokens, the projection and the ids. `ConsoleCards.kt` decides which card a result draws as. `ConsoleRules.kt` decides the Gateway read, the paint, and which saved values travel. `LiveConsoleOps.kt` holds each Gateway's history, vocabulary and saved values outside the screen, so an answer lands on its own entry after Back; a Gateway's refusal is shown as its own word, never as silence. Phone-bound text is not neutralized on the Gateway: `ConsoleCards.kt` collapses a value or a key to one line where it draws it.

## Who it serves

`composeLiveConsole` answers `/console/eval` (`SESSION_COMMANDS.console`) for sessions, printing every statement that is not a save, each under its own source when there are several, and the console ops for the owner, whose audience is `owner`. The caller's session token selects the session. Host sessions are served. Assistant and container sessions return `not_served`. Each entity declares its audiences. The registry needs one row to serve the assistant and another to serve a container. The plugin registers the tool for a token-bound session outside a container. An older Gateway's 404 means not served yet.

**Read-only is fenced by a test:** the stage test reads every registered member over real device, field, automation and threshold stores and asserts the data directory, the device snapshot and the host ops are untouched. A member added without a row in its table fails it.

**Never readable:** vault values and private text, session credentials and raw session records, the host token, keys and enrollment material, watcher credentials, the inbox page-token key, the assistant home's sealed parts, pane text. The stage receives read seams only. A read that sweeps is a write, so watcher grants come from the vault's non-sweeping `standing()`.
