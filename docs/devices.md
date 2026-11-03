# Devices

The Gateway controls the owner's smart plugs on the local network with no cloud in the loop. One generic layer holds the records and the actions; a brand driver speaks the plug's protocol. Kasa is the first driver.

## The record

`src/shared/schemasDevices.ts`. A device is `{ id, name, kind, driver, address, revision }`. The id is the plug's MAC in lower-case colon form, the one spelling `normalizeDeviceMac` answers. A name may not normalize to a MAC, so a name can never resolve as another device's id; `deviceNameRefusal` is the one name rule, called by the schema and by the store. The kind is `switch` with the verbs `on`, `off` and `toggle`. The address is mutable: a scan refreshes it.

## The store

`src/gateway/devices/store.ts`, on `openDurable` and `commitChecked`, the sole writer, Gateway-named revisions. Restore refuses the file whole on a duplicate id, an unnormalized MAC, a driver that does not serve the record's kind, or a record ahead of the list's revision. A removed id leaves a tombstone holding its last revision, bounded to the newest 256, so a re-added plug continues its numbering. A repeated add of the same address and name, a repeated removal at the tombstone's revision, and a rename to the held name at the previous revision are lost answers.

## The driver contract

`src/gateway/devices/driver.ts`. A driver takes an operation context: the ambient clock, an abort signal and an effect latch. `identify` returns the MAC an address reports; `read`, `set`, `rename`, `schedule` (read, put) and `settings` (read, put) take a record. A failure is typed: `unreachable` or `timeout` with a detail and, when the transport knows, `sent`; `refused` with the plug's `err_code` and its message; `invalid` with a detail; `wrong_device` when the address reports another MAC, which points the owner at a scan. Any failure after a step landed carries `landed`: `done` of `total` steps.

**Identity before every mutation.** The driver reads `sysinfo`, compares the MAC with the record id and sends nothing on a mismatch, so a reused DHCP address cannot switch the wrong plug. Each mutation opens an attempt on the context's effect latch after the identity passes and before it is written, and denies only that attempt when the plug refuses the command or the transport never wrote it. The latch stays marked while any attempt is undenied, so a later step's refusal cannot hide an earlier step that landed.

## The Kasa driver

`src/gateway/devices/kasa/`. The legacy XOR protocol over TCP 9999: a four-byte length and the autokey from 0xAB (`codec.ts`); one connection per command, closed by the transport itself at the deadline, answers capped at 64 KiB (`transport.ts`). `kasaDriver.ts` covers `get_sysinfo`, `set_relay_state`, `set_dev_alias`, `set_led_off`, the `time` module, the `schedule` module and `cnCloud`. A schedule put carries the schedule its edit began over. The Gateway reads the plug in the same queue turn and refuses `stale` when it differs, since the record revision does not move when the Kasa app edits a rule. It then reconciles against `get_rules` by rule id, matches an id-less rule by content so a replay adds nothing, leaves any rule it cannot represent alone, and reads back; a failure after a step landed carries how many landed (`schedule.ts`). The cloud disconnect unbinds and points the server at a non-cloud value, noting when only the first step landed (`cloud.ts`). A plug on KLAP firmware does not speak this protocol and is not served.

## The road

`src/gateway/devices/road.ts`. Every handler, console or assistant, goes through `createDeviceRoad`, which owns the store, the drivers, the leases, the per-device queue, the close fence, the toggle doubt and the one failure map. A console operation is bound at `CONSOLE_ANSWER_WAIT_MS - CONSOLE_HOP_MARGIN_MS` and an assistant one at `ASSISTANT_WAITS.action`; a listing reads each plug and a scan identifies each moved candidate under a nested bound of its own, and close drains every lease. A turn on a device's queue is raced at its start against the lease, so a turn that never starts answers not started while a started one runs to completion. The deadline gates starting an effect, never committing one that landed: a plug answer that arrives late still commits.

A handler receives a `Slot` (the record, the store's writes for that id, `drive`, `attempt` for compensation, `identify`, `expect`) or a `Plug` (a held record and its driver), and declines through one `Declined` value that `shapes.ts` projects into each wire shape. `src/gateway/compose/composeDevices.ts` holds only the handler bodies, which `device-road-residue.test.ts` enforces.

**The toggle doubt.** A toggle whose relay command may have landed without confirmation is remembered per device, and the next toggle is refused until a read, a listing or an explicit on or off confirms the state, or the device is removed. A refusal from the plug, or a command that was never written, records no doubt.

## Answers

Each console op is declared once in `schemasDevices.ts`: its request is the `ConsoleOp` member (`DEVICE_CONSOLE_REQUESTS`) and its result sits beside it in `DEVICE_CONSOLE_RESULTS`, which the compiler holds to one per request. The console handler routes every device op through `isDeviceConsoleOp` to the stage's one `DeviceConsole` function.

Every result is `{ kind: "ok", ... }` or `{ kind: "refused", refusal }`, generated into Kotlin as a sealed class. A refusal carries a closed `code`, an `effect` (`none` when the plug cannot have changed, `unknown` when it may have), how many steps `landed` when a multi-step write was cut short, a bounded `detail`, and the held `record` when the refusal concerns one. A never-started op answers `timeout` with effect `none`. A reader decides from the code and the effect and never parses the detail. A read answers its settings only when their own read succeeded, so one failed settings call cannot hide a relay state and schedule already read. `tests/fixtures/protocol/` holds device requests and results both runtimes replay.

## The scan

`src/mcp/devcontainer/kasaScan.ts` in the host daemon, behind the closed `kasaScan` host op: no caller input, the legacy discovery payload broadcast on every non-loopback IPv4 interface's broadcast address, a four-second window under the host bound, datagrams over 4 KiB dropped before decrypting, a stop after 1024, typed candidates capped at the device limit. One failed send does not end a scan; every send failing does. `src/gateway/devices/scan.ts` relays it and answers a daemon that is down or late as `daemon_away` or `timeout`, never as an empty list. The Gateway's scan handler then identifies each moved paired candidate at its new address before refreshing the record, and a scan whose later refreshes miss the deadline still answers its candidates.

## The assistant

`devices` is a `read` and `device_set` an `act`, both answered on the Gateway behind `list_actions` and `run_action`. `devices` answers the inventory with live state, reading each plug under its own bound so one silent plug cannot time out the answer. `device_set` takes the record id or a name that matches one paired device exactly, the id in any MAC spelling, else refuses with the candidates and sends nothing. The assistant sees a plug's `err_code` and never its text, nor a reused address. A failure after a step landed tells it how many landed and that the last command's outcome is unknown. The rules for both live in their listing descriptions; the instructions name no action's rules. `docs/assistant.md` holds the action road.

## Deploying

The daemon ships the scan op, the plugin the actions, the Gateway the store and the road. Readers first: `./start-host-daemon.sh`, then the plugin build and the assistant's MCP restart, then the Gateway, then the phone, whose device pages read and send the console ops together. The Router needs nothing, since a device op rides `gateway_value` sealed.

## The phone

`DeviceOps.kt` holds every device operation and lands each answer through a typed slot (`DeviceSlots.kt`) over `PublishedViews` (`SlotViews.kt`): the list, the scan, a plug's write claim, and per plug its live state, schedule part (with the owner's edit and the schedule it began over) and settings part. A per-plug slot is owned only while the plug is listed at the incarnation its ticket was minted for, so a late answer for a removed or re-added plug lands nothing. A Gateway the roster does not name is asked nothing, and the workspace's re-provision generation is shared. `DeviceRules.kt` holds what the pages decide. `AssistantIntegrationsPage` and `AssistantDevicePage` only draw and call. `SandboxDevices.kt` answers as a Gateway in the emulator build.

## The catalogue

Every brand, service and protocol is declared once, in `src/shared/schemasIntegrations.ts`: its group (protocol, service, brand, which is also the Add page's order), label, blurb, how it is discovered (`scan`, `listen`, `none`), what it needs (fields, today one `secret` kind), what it yields (devices or actions), the device capabilities it supports (`switch`, `schedule`, `led`, `clock`, `cloud`) and its acts, each with a tier (`act` or `danger`). `scripts/codegen-kotlin.ts` generates `IntegrationRegistry.kt` from it as Kotlin enums and a list, so a group, a discovery mode, a need kind or a capability the phone has no renderer for fails to compile rather than drawing an empty section. Device drivers and the grant-bearing service ids derive from the catalogue; a driver with no entry does not compile.

The Gateway answers `offered`, the catalogue ids it serves, on the assistant state. The phone draws Add from the compiled catalogue filtered by that answer, so an older Gateway hides an entry rather than showing a dead page, and an older phone ignores the field.

On the phone, `IntegrationRules.kt` holds the decisions: the offered entries, the Add page's groups and search, when a service counts as added (it holds a grant), a device row's brand line and its trouble line (shown only while the switch cannot say the state), the capabilities and acts of a record's brand, and the settings index's counts per type. `IntegrationAddPage` is the catalogue; `IntegrationEntryPage` is one entry, decided by its discovery: a scan entry has Scan in the bar, Found with Add per row and Paired rows that open the device page, and a service entry is a form of its needs, granting a secret from the vault, with Remove once added. The device page draws its brand's section one renderer per declared capability, and an act by its tier: a danger act is red and confirms.
