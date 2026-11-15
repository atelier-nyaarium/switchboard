# Live console

A read-only expression language over Gateway state. A session inspects live state without scripting over state files. Each Gateway answers for itself. Agents use the MCP `console` tool as their door. The phone's Console page is to be the human door over the same engine.

## Grammar

`src/shared/live-console-grammar.ts`: lexer, recursive-descent parser and AST. The implementation is pure so the phone can twin the tokenizer.

- Paths and calls: `sensors.read("Freezer").readings[0]`.
- Indexing: `list[0]`, `list[-1]`, `record["key"]`.
- Operators: `== != !` and `+ - * /`. A `-` is always an operator, never part of a number. `5-3` reads as subtraction. A literal or a result that is not finite is refused as `too_big`.
- Literals: numbers, strings in either quote, `true`, `false`, `null`, lists `[a, b]`, dicts `{k: v}`.
- No assignment: `=` is refused.
- Partial input parses. An open call, index, member, list or dict has `closed: false`, an open string has its token's `closed: false`, and evaluation refuses either. Every node carries a span in UTF-16 code units.
- Caps: `CONSOLE_SOURCE_MAX` characters and `CONSOLE_NODES_MAX` nodes.

## Engine

`src/gateway/liveConsole/`:

- `registry.ts`: entities expose property members with `get` and method members with `params` and `returns`. Each parameter has a Zod schema. Registration refuses malformed names and required parameters after optional ones. `describe(audience)` supplies the text both doors read, with each parameter's description and one line per builtin. `hash` identifies it so a client can cache it.
- `builtins.ts`: one table of value methods (`count`, `first`, `take`, `skip`, `keys`, `where`). Evaluation and `describe` read this table.
- `evaluate.ts`: each call walks a fresh tree. Only registry members and builtins are callable, so nothing reflective runs. A handler's answer is cloned once read, so no live value leaves. The step budget, `CONSOLE_STEPS_MAX`, bounds a query on the Gateway's single loop, and every builtin that copies charges a step per item. A member marked `slow` runs once per expression, so a list of listens cannot outrun the route's wait. Every failure has shape `{ code, start, end, message }`.
- `render.ts`: `key: value` lines. Owner-named text and keys use `oneLine` and `neutralizeMarkup`. A whole number under a known instant key (`at`, `heardAt`, `lastAt`, `firedAt`, `readAt`, `lastSuccessAt`, `nextPollAt`) renders as an age and a UTC time. Nesting stops at depth 3. An answer stays within 16 KiB, its note included: a list stops between items with a footer naming the `.skip(n)` that continues it, and a record or an oversized first item stops between lines. An error renders the source with a caret under its span.
- `entities.ts`: what the console reads, every answer a projection.

## Registry

| Entity | Members |
|---|---|
| `gateway` | `id`, `version`, `router`, `temperatureUnit` |
| `devices` | `list`, `get(device)` |
| `sensors` | `list`, `read(device)` (each reading's `value` and `shown` in the owner's unit, its 24-hour low and high, its thresholds in the owner's unit with a `unit`), `payloads(device)`, `extremes(device, key)` |
| `thresholds` | `list`, `of(device)`, as stored, in each reading's own unit |
| `fields` | `list`, `get(id)`, `value(id)`, `invalid(id)`, `state(id)` |
| `automations` | `list`, `runs`, `queue`, `invalid(id)`, `checkpoint(id)` |
| `watchers` | `list`, `get(id)` (an explicit view of health, rules and actions, never its setup text or vault entry ids), `rules(id)` (the catch-all last), `test(id, fields)` (the rule an event meets and its action) |
| `bluetooth` | `listen(seconds?)`: host radio sightings for the window, loudest first, at most 256 addresses. Each row names its family, and `unsupported: yes` marks a device never paired. Host sessions only, since a listen outlasts the phone's answer wait. |
| `Definition` | `all`, `get(key)`, `match(advert)`, `decode(key, advert)` |

A device is named by id or by name. `Definition` is a catalogue listed under Types in `describe`. The other entities are live services.

**`bluetooth.listen` writes nothing:** the `bleListen` host op holds discovery for the requested window. The default is 120 seconds. `CONSOLE_LISTEN_MAX_S` caps it below the Gateway's 255-second idle cut. It hears only that window and never reads BlueZ's cache, so it holds `DuplicateData` on for the window: a beacon whose advert never changes is still heard. `Scan` is not registered because it refreshes plug addresses.

## Who it serves

`composeLiveConsole` answers `/console/eval` (`SESSION_COMMANDS.console`). The caller's session token selects the session. Host sessions are served. Assistant and container sessions return `not_served`. Each entity declares its audiences. The registry needs one row to serve the assistant and another to serve a container. The plugin registers the tool for a token-bound session outside a container. An older Gateway's 404 means not served yet.

**Read-only is fenced by a test:** the stage test reads every registered member over real device, field, automation and threshold stores and asserts the data directory, the device snapshot and the host ops are untouched. A member added without a row in its table fails it.

**Never readable:** vault values and private text, session credentials and raw session records, the host token, keys and enrollment material, watcher credentials, the inbox page-token key, the assistant home's sealed parts, pane text. The stage receives read seams only. A read that sweeps is a write, so watcher grants come from the vault's non-sweeping `standing()`.
