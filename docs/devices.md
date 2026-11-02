# Devices

The Gateway controls the owner's smart plugs on the local network with no cloud in the loop. One generic layer holds the records and the actions; a brand driver speaks the plug's protocol. Kasa is the first driver.

## The record

`src/shared/schemasDevices.ts`. A device is `{ id, name, kind, driver, address, revision }`. The id is the plug's MAC in lower-case colon form, the one spelling `normalizeDeviceMac` answers. A name may not normalize to a MAC, so a name can never resolve as another device's id; `deviceNameRefusal` is the one name rule, called by the schema and by the store. The kind is `switch` with the verbs `on`, `off` and `toggle`. The address is mutable: a scan refreshes it.

## The store

`src/gateway/devices/store.ts`, on `openDurable` and `commitChecked`, the sole writer, Gateway-named revisions. Restore refuses the file whole on a duplicate id, an unnormalized MAC, a driver that does not serve the record's kind, or a record ahead of the list's revision. A removed id leaves a tombstone holding its last revision, bounded to the newest 256, so a re-added plug continues its numbering. A repeated add of the same address and name, a repeated removal at the tombstone's revision, and a rename to the held name at the previous revision are lost answers.

## The driver contract

`src/gateway/devices/driver.ts`. A driver takes an operation context: the ambient clock, an abort signal and an effect latch. `identify` answers the MAC an address answers with; `read`, `set`, `rename`, `schedule` (read, put) and `settings` (read, put) take a record. A failure is typed: `unreachable` or `timeout` with a detail and, when the transport knows, `sent`; `refused` with the plug's `err_code`, its message and a landing `note`.

**Identity before every mutation.** The driver reads `sysinfo`, compares the MAC with the record id and sends nothing on a mismatch, so a reused DHCP address cannot switch the wrong plug. It marks the context's effect latch after the identity passes and before the mutation is written, and clears it when the plug refuses that command or the transport never wrote it, so a failure afterwards says whether an effect may have landed.

## The Kasa driver

`src/gateway/devices/kasa/`. The legacy XOR protocol over TCP 9999: a four-byte length and the autokey from 0xAB (`codec.ts`); one connection per command, closed by the transport itself at the deadline, answers capped at 64 KiB (`transport.ts`). `kasaDriver.ts` covers `get_sysinfo`, `set_relay_state`, `set_dev_alias`, `set_led_off`, the `time` module, the `schedule` module and `cnCloud`. A schedule put reconciles against `get_rules` by rule id, matches an id-less rule by content so a replay adds nothing, leaves any rule it cannot represent alone, and reads back; a failure after a step landed carries how many landed (`schedule.ts`). The cloud disconnect unbinds and points the server at a non-cloud value, noting when only the first step landed (`cloud.ts`). A plug on KLAP firmware does not speak this protocol and is not served.

## The road

`src/gateway/devices/road.ts`. Every handler, console or assistant, goes through `createDeviceRoad`, which owns the store, the drivers, the leases, the per-device queue, the close fence, the toggle doubt and the one failure map. A console operation is bound at `CONSOLE_ANSWER_WAIT_MS - CONSOLE_HOP_MARGIN_MS` and an assistant one at `ASSISTANT_WAITS.action`; a listing reads each plug and a scan identifies each moved candidate under a nested bound of its own, and close drains every lease. A turn on a device's queue is raced at its start against the lease, so a turn that never starts answers not started while a started one runs to completion. The deadline gates starting an effect, never committing one that landed: a plug answer that arrives late still commits.

A handler receives a `Slot` (the record, the store's writes for that id, `drive`, `attempt` for compensation, `identify`, `expect`) or a `Plug` (a held record and its driver), and declines through one `Declined` value that `shapes.ts` projects into each wire shape. `src/gateway/compose/composeDevices.ts` holds only the handler bodies, which `device-road-residue.test.ts` enforces.

**The toggle doubt.** A toggle whose relay command may have landed without confirmation is remembered per device, and the next toggle is refused until a read, a listing or an explicit on or off confirms the state, or the device is removed. A refusal from the plug, or a command that was never written, records no doubt.

## The scan

`src/mcp/devcontainer/kasaScan.ts` in the host daemon, behind the closed `kasaScan` host op: no caller input, the legacy discovery payload broadcast on every non-loopback IPv4 interface's broadcast address, a four-second window under the host bound, datagrams over 4 KiB dropped before decrypting, a stop after 1024, typed candidates capped at the device limit. One failed send does not end a scan; every send failing does. `src/gateway/devices/scan.ts` relays it and answers a daemon that is down or late as `daemon_away` or `timeout`, never as an empty list. The Gateway's scan handler then identifies each moved paired candidate at its new address before refreshing the record, and a scan whose later refreshes miss the deadline still answers its candidates.

## The assistant

`devices` is a `read` and `device_set` an `act`, both answered on the Gateway behind `list_actions` and `run_action`. `devices` answers the inventory with live state, reading each plug under its own bound so one silent plug cannot time out the answer. `device_set` takes the record id or a name that matches one paired device exactly, the id in any MAC spelling, else refuses with the candidates and sends nothing. The assistant sees a plug's `err_code` and never its text. `docs/assistant.md` holds the action road.

## Deploying

The daemon ships the scan op, the plugin the actions, the Gateway the store and the road. Readers first: `./start-host-daemon.sh`, then the plugin build and the assistant's MCP restart, then the Gateway. The phone's page is Phase 2.5b of `plans/assistant-phone-road.md`.
