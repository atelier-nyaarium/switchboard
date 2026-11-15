# Live console

A read-only expression language over Gateway state. A session inspects live state without scripting over state files. Each Gateway answers for itself. Agents use the MCP `console` tool as their door, and the owner uses the phone's Console page; both send the same expressions to the same engine.

## Grammar

`src/shared/live-console-grammar.ts`: lexer, recursive-descent parser and AST. The implementation is pure so the phone can twin the tokenizer.

- Paths and calls: `sensors.read("Freezer").readings[0]`.
- Indexing: `list[0]`, `list[-1]`, `record["key"]`.
- Operators, loosest first: `== !=`, then `< > <= >=`, then `+ -`, then `* /`, and `!` and `-` in front. The four ordering operators take two numbers. A `-` is always an operator, never part of a number. `5-3` reads as subtraction. A literal or a result that is not finite is refused as `too_big`.
- Literals: numbers, strings in either quote, `true`, `false`, `null`, lists `[a, b]`, dicts `{k: v}`.
- Statements: `;` separates them, at most `CONSOLE_STATEMENTS_MAX`. A new line is whitespace, so an expression wraps. A statement may open with `name =`, which saves its result for the rest of the call; `=` anywhere else is refused. A saved name follows `isConsoleVariableName`, and an entity's name is refused.
- Partial input parses. An open call, index, member, list or dict has `closed: false`, an open string has its token's `closed: false`, and evaluation refuses either. Every node carries a span in UTF-16 code units.
- Caps: `CONSOLE_SOURCE_MAX` characters and `CONSOLE_NODES_MAX` nodes.

## Engine

`src/gateway/liveConsole/`:

- `registry.ts`: entities expose property members with `get` and method members with `params` and `returns`. Each parameter has a Zod schema. Registration refuses malformed names and required parameters after optional ones. `projection(audience)` is the one description: the agent's text (`describe`) renders from it, the phone receives it as data, and `hash` is a hash of it, so any change to a member, a parameter or a builtin moves the hash.
- `builtins.ts`: one table of value methods (`count`, `first`, `take`, `skip`, `keys`, `where`) and of functions called by their name alone, whose receiver is `none`: `round(x, places?)` and `if(when, then, otherwise)`. `if` is `lazy`: only the branch it chooses is read, so the other may name what does not exist. An entity's name outranks a function's. Evaluation and `describe` read this table.
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
| `sources` | `list`, `get(id)` (fields, whether its events can trigger an automation, commands; never its setup text or vault entry ids), `read(id)` (unread, polls, backoff, unexpected values), `test(id, fields)` (the armed event automations an event with those fields meets, each with its `when`, and whether it wakes) |
| `bluetooth` | `listen(seconds?)`: host radio sightings for the window, loudest first, at most 256 addresses. Each row names its family, and `unsupported: yes` marks a device never paired. Host sessions only, since a listen outlasts the phone's answer wait. |
| `definitions` | `list`, `get(key)`, `match(advert)`, `decode(key, advert)` |

**Verbs:** `list` answers all, `get(x)` one record as set, `read(x)` what it is doing now, as a copy at that moment. A narrower view is a noun (`payloads`, `runs`); a member that computes keeps its verb (`test`, `decode`, `listen`).

A device is named by id or by name. `definitions` is a catalogue listed under Types in `describe`. The other entities are live services. A parameter may declare which live ids complete it (`completes`), so the phone offers them without knowing any entity's name.

**`bluetooth.listen` writes nothing:** the `bleListen` host op holds discovery for the requested window. The default is 120 seconds. `CONSOLE_LISTEN_MAX_S` caps it below the Gateway's 255-second idle cut. It hears only that window and never reads BlueZ's cache, so it holds `DuplicateData` on for the window: a beacon whose advert never changes is still heard. `Scan` is not registered because it refreshes plug addresses.

## The owner's door

`LiveConsoleStage.console` answers three console ops, composed before the router frames so the dispatcher holds only this port:

- `console_describe`: the projection and its hash. The phone caches it per Gateway and reads it again when an eval answers with another hash. The projection carries type labels, never schemas: the hash covers exactly what the phone draws, and the Gateway alone validates arguments.
- `console_ids`: what completions may name now (devices with their reading keys, fields, automations, sources, definitions). Never cached, since ids move.
- `console_eval`: one result per statement (the value, its registry type, an entity named alone, the name it was saved under), or the issue. The results share `CONSOLE_VALUE_BYTES`; a printed list is cut between items and says what it left. Both arms carry `registryHash`, so a stale vocabulary is noticed on an error too.

**Variables belong to whoever evaluates.** A save lasts the call on both doors. The phone also keeps each saved value with its type, in memory, for the console session, and a later read sends every saved value its text names anywhere. That is a superset on purpose: the Gateway alone decides what a reference is, so the phone holds no second reading of the grammar, and a value sent and not read costs only its bytes. The held set stays under `CONSOLE_VARIABLES_BYTES`, what one read may carry. A save must be whole: a value that would be cut is refused rather than kept short. An entity itself cannot be saved.

The phone (`android/.../liveconsole/`): `ConsoleTokens.kt` is the tokenizer's twin, pinned by `tests/fixtures/live-console-tokens/vectors.json` (regenerate with `bun scripts/gen-console-token-vectors.ts`; the suite holds the fixture to the generator's case list in `scripts/lib/consoleTokenCases.ts`). `ConsoleAssist.kt` decides completions and the parameter hint from the tokens, the projection and the ids. A completion replaces one slot, the token the cursor touches on either side (`slotAt`); an open string's slot ends at the cursor, since the string has swallowed what follows, a method completed before an existing bracket reuses it, and a cursor against a number has no slot. What was typed inside a string is read as the lexer decodes it, so a name with an escape still matches. The completion kinds are the generated `Protocol.Wire.ConsoleCompletes`, matched without an else branch; `sensors` offers the devices that have readings, so a sensor read never offers a plug. `ConsoleCards.kt` decides which card a result draws as. `ConsoleRules.kt` decides the Gateway it reads (a conversation's own; otherwise the pick, then the assistant's home when reachable, then the first reachable, with the picker offering the reachable ones and the chosen one), the paint (an entity outranks a saved name, as on the Gateway), which saved values travel, and what each history row and the dock draw (`entryDrawn`, `moreLine`, `memberInsert`, `canRun`). `LiveConsoleOps.kt` holds each Gateway's history, vocabulary and saved values outside the screen on a `SlotViews`, as `DeviceOps` does: the vocabulary, the ids and each run are slots, a run appends its row and settles it through one ticket, and a re-provision ends every showing, so a read begun before it lands nothing. A saved name the Gateway now holds as an entity is dropped when the vocabulary lands. A Gateway the roster does not name is asked nothing. A Gateway that refuses the vocabulary reads as one line saying it does not serve the console, since an older build refuses an unknown op with a schema dump; a refused read draws its reason on one line, cut at 160 characters. The input turns autocorrect and capitals off, and a tap that inserts text focuses it. The sandbox (`SandboxLiveConsole.kt`) evaluates nothing: it answers a table of exact reads on the home Gateway, refuses as an older Gateway on the second, and is unreachable on the third. Phone-bound text is not neutralized on the Gateway: `ConsoleCards.kt` collapses a value or a key to one line where it draws it.

## Who it serves

`composeLiveConsole` answers `/console/eval` (`SESSION_COMMANDS.console`) for sessions, printing every statement that is not a save, each under its own source when there are several, and the console ops for the owner, whose audience is `owner`. The caller's session token selects the session. Host sessions are served. Assistant and container sessions return `not_served`. Each entity declares its audiences. The registry needs one row to serve the assistant and another to serve a container. The plugin registers the tool for a token-bound session outside a container. An older Gateway's 404 means not served yet.

**Read-only is fenced by a test:** the stage test reads every registered member over real device, field, automation and threshold stores and asserts the data directory, the device snapshot and the host ops are untouched. A member added without a row in its table fails it.

**Never readable:** vault values and private text, session credentials and raw session records, the host token, keys and enrollment material, source credentials, the inbox page-token key, the assistant home's sealed parts, pane text. The stage receives read seams only. A read that sweeps is a write, so source grants come from the vault's non-sweeping `standing()`.
