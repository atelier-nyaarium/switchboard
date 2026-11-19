import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { automationActions } from "../gateway/compose/automationActions.js";
import { openAutomationPair } from "../gateway/compose/composeAutomations.js";
import { AUTOMATION_ATTEMPT_MS, composeDevices } from "../gateway/compose/composeDevices.js";
import { type Automations, BACKOFF_MIN_MS } from "../gateway/computed/automations.js";
import { type DeviceDriverError, DeviceDriverFailure } from "../gateway/devices/driver.js";
import { createKasaTransport, KASA_CONNECT_MS } from "../gateway/devices/kasa/transport.js";
import { unknown } from "../shared/expressions.js";
import type { Automation } from "../shared/schemasAutomation.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";
import { createFakeKasaPlug, type FakeKasaPlug } from "../testing/fakeKasaPlug.js";

const LAMP = "aa:bb:cc:dd:ee:01";
const FAN = "aa:bb:cc:dd:ee:02";
const HEATER = "aa:bb:cc:dd:ee:03";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const switched = (device: string, verb: "on" | "toggle" = "on"): Automation => ({
	enabled: true,
	trigger: { kind: "event", source: "github", conditions: [] },
	actions: [{ kind: "device_set", device, verb }],
});

const relays = (plug: FakeKasaPlug) => plug.received().filter((row) => row.command === "set_relay_state").length;

/** Holds its first relay command. */
const holdingOnce = (mac: string) => {
	let silent = true;
	return createFakeKasaPlug({
		mac,
		behavior: (request) => {
			if (request.command !== "set_relay_state" || !silent) return undefined;
			silent = false;
			return { kind: "hold" };
		},
	});
};

/** The lamp and the heater hold their first relay command. */
async function plugs() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automation-devices-"));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	const lamp = await holdingOnce(LAMP);
	const heater = await holdingOnce(HEATER);
	const fan = await createFakeKasaPlug({ mac: FAN });
	cleanups.push(
		() => lamp.close(),
		() => heater.close(),
		() => fan.close(),
	);
	const ports: Record<string, number> = { "10.0.0.1": lamp.port, "10.0.0.2": fan.port, "10.0.0.3": heater.port };
	/** Addresses whose connect never opens. */
	const dead = new Set<string>();
	let dials = 0;
	/** Addresses in the order a relay command was asked of them. */
	const relayOrder: string[] = [];
	const ambient = fakeAmbient({ drive: "manual", now: () => 1_000 });
	const devices = composeDevices({
		dataDir: dir,
		ambient,
		transport: {
			request: (address, command, signal, connectBy) => {
				if (JSON.stringify(command).includes("set_relay_state")) relayOrder.push(address);
				if (!dead.has(address))
					return createKasaTransport(ports[address] as number).request(
						"127.0.0.1",
						command,
						signal,
						connectBy,
					);
				dials++;
				// Mirrors the real transport
				return new Promise((_, reject) => {
					const never = (failure: DeviceDriverError) => () => reject(new DeviceDriverFailure(failure));
					signal.addEventListener("abort", never({ kind: "timeout", detail: "cut", sent: false }));
					connectBy?.addEventListener(
						"abort",
						never({ kind: "unreachable", detail: "never accepted", sent: false }),
					);
				});
			},
		},
		relayToHost: async () => ({ ok: false, errorKind: "daemon_away" }) as never,
	});
	cleanups.push(() => devices.close());
	for (const [mac, address, name] of [
		[LAMP, "10.0.0.1", "Lamp"],
		[FAN, "10.0.0.2", "Fan"],
		[HEATER, "10.0.0.3", "Heater"],
	] as const) {
		expect(await devices.console({ kind: "device_add", mac, address, name })).toMatchObject({ kind: "ok" });
	}
	const actions = automationActions({
		devices: () => devices,
		ifttt: async () => ({ ok: true, status: 200 }),
		vaultReady: () => true,
	});
	let n = 0;
	/** Saves each automation and fires it by name. */
	const automationsOf = (saved: Record<string, Automation>) => {
		const { automations } = openAutomationPair({
			dataDir: dir,
			newIncarnation: () => `a${++n}`,
			now: () => ambient.now(),
			input: () => ({ type: { type: "number", integral: false }, value: unknown("not heard") }),
			automations: { isHome: () => true, eventIssue: () => null, actions },
		});
		// Stops after the devices close, which ends held work.
		cleanups.unshift(() => automations.stop());
		for (const [id, body] of Object.entries(saved)) automations.ownerPut(id, body, 0);
		const fire = (automation: string) =>
			automations.fireEvents([{ automation, key: `event:github:${automation}`, names: {} }], ambient.now());
		return { automations, fire };
	};
	return {
		lamp,
		heater,
		fan,
		ambient,
		devices,
		actions,
		automationsOf,
		kill: (address: string) => dead.add(address),
		dials: () => dials,
		relayOrder,
	};
}

const outcomes = (automations: Automations) => automations.runs().map((run) => `${run.automation} ${run.outcome}`);

describe("automations on real plugs", () => {
	it("answers a hold when the attempt's bound passes in the device's queue, and no answer once the command was written", async () => {
		const { lamp, ambient, devices, actions } = await plugs();

		const busy = devices.console({ kind: "device_set", id: LAMP, verb: "on" });
		await lamp.waitForHeldReply();
		const queued = actions.deviceSet(LAMP, "on");
		await ambient.advance(AUTOMATION_ATTEMPT_MS);
		const behind = await queued;
		lamp.releaseHeldReplies();
		await busy;

		const { lamp: silent, ambient: later, actions: again } = await plugs();
		const written = again.deviceSet(LAMP, "on");
		await silent.waitForHeldReply();
		await later.advance(AUTOMATION_ATTEMPT_MS);

		expect(behind).toHaveProperty("hold");
		expect(await written).toEqual({ word: "no_answer" });
	});

	it("starts an effect only with its floor of the bound left: three seconds lands, a third of a second holds unwritten", async () => {
		const { lamp, ambient, devices, actions } = await plugs();
		const busy = devices.console({ kind: "device_set", id: LAMP, verb: "on" });
		await lamp.waitForHeldReply();
		const roomy = actions.deviceSet(LAMP, "on");
		await ambient.advance(AUTOMATION_ATTEMPT_MS - 3_000);
		lamp.releaseHeldReplies();
		await busy;
		const landed = await roomy;

		const { lamp: blocker, ambient: later, devices: again, actions: then } = await plugs();
		const held = again.console({ kind: "device_set", id: LAMP, verb: "toggle" });
		await blocker.waitForHeldReply();
		const tight = then.deviceSet(LAMP, "toggle");
		await later.advance(AUTOMATION_ATTEMPT_MS - 300);
		blocker.releaseHeldReplies();
		await held;
		const skipped = await tight;
		const written = relays(blocker);

		expect(landed).toEqual({ word: "done" });
		expect([skipped, written]).toEqual([{ hold: "nothing was sent in time" }, 1]);
		expect(await then.deviceSet(LAMP, "toggle")).toEqual({ word: "done" });
	});

	it("reads a plug that never accepts as unreachable in the assistant's device list", async () => {
		const { ambient, devices, kill, dials } = await plugs();
		kill("10.0.0.1");
		const listing = devices.assistant({ kind: "device_list" });
		await vi.waitFor(() => expect(dials()).toBe(1));
		await ambient.advance(KASA_CONNECT_MS);

		const answer = await listing;
		const states =
			answer.kind === "ok"
				? answer.devices.map((device) => [device.id, "state" in device ? device.state : null])
				: answer;
		expect(states).toEqual(
			expect.arrayContaining([
				[LAMP, "unreachable"],
				[FAN, "off"],
				[HEATER, "off"],
			]),
		);
	});

	it("holds a dead plug's turn that the bound cuts before its connect gives up", async () => {
		const { lamp: blocker, ambient: later, devices: again, actions: then, kill, dials } = await plugs();
		const held = again.console({ kind: "device_set", id: LAMP, verb: "on" });
		await blocker.waitForHeldReply();
		const cut = then.deviceSet(LAMP, "on");
		await later.advance(AUTOMATION_ATTEMPT_MS - 2_000 - KASA_CONNECT_MS);
		kill("10.0.0.1");
		blocker.releaseHeldReplies();
		// Read back dials it
		await vi.waitFor(() => expect(dials()).toBe(1));
		await later.advance(KASA_CONNECT_MS);
		await held;
		await vi.waitFor(() => expect(dials()).toBe(2));
		await later.advance(2_000);

		expect(await cut).toHaveProperty("hold");
	});

	it("ends a Toggle at once and retries an On when a plug never accepts, and tells the assistant unreachable at the connect bound", async () => {
		const { ambient, devices, automationsOf, kill, dials } = await plugs();
		kill("10.0.0.1");
		const { automations, fire } = automationsOf({ flip: switched(LAMP, "toggle"), light: switched(LAMP) });

		/** Waits for the dial. */
		const cut = async (dialed: number) => {
			await vi.waitFor(() => expect(dials()).toBe(dialed));
			await ambient.advance(KASA_CONNECT_MS);
			await automations.settled();
		};

		fire("flip");
		await cut(1);
		fire("light");
		await cut(2);
		await ambient.advance(BACKOFF_MIN_MS);
		automations.tick();
		await cut(3);
		const assistant = devices.assistant({ kind: "device_set", id: LAMP, verb: "on" });
		await vi.waitFor(() => expect(dials()).toBe(4));
		await ambient.advance(KASA_CONNECT_MS);

		expect(outcomes(automations)).toEqual(["flip refused"]);
		expect(await assistant).toMatchObject({ kind: "refused", refusal: { code: "unreachable", effect: "none" } });
		expect(JSON.stringify(await assistant)).not.toContain("never accepted");
	});

	it("lands another automation's effect while a silent plug's run backs off", async () => {
		const { lamp, fan, ambient, automationsOf } = await plugs();
		const { automations, fire } = automationsOf({ slow: switched(LAMP), fast: switched(FAN) });

		fire("slow");
		await lamp.waitForHeldReply();
		fire("fast");
		const queued = relays(fan);
		await ambient.advance(AUTOMATION_ATTEMPT_MS);
		await vi.waitFor(() => expect(relays(fan)).toBe(1));
		const inBackoff = relays(lamp);
		await ambient.advance(BACKOFF_MIN_MS);
		automations.tick();
		await vi.waitFor(() => expect(relays(lamp)).toBe(2));
		await automations.settled();

		expect([queued, inBackoff]).toEqual([0, 1]);
		expect(outcomes(automations)).toEqual(["fast ran", "slow ran"]);
	});

	it("takes whichever step fell due first: a run whose turn came before a silent plug's retry fell due goes ahead of it", async () => {
		const { lamp, heater, ambient, automationsOf, relayOrder } = await plugs();
		const { automations, fire } = automationsOf({
			slow: switched(LAMP),
			warm: switched(HEATER),
			fast: switched(FAN),
		});

		fire("slow");
		await lamp.waitForHeldReply();
		fire("warm");
		await ambient.advance(AUTOMATION_ATTEMPT_MS);
		await heater.waitForHeldReply();
		fire("fast");
		await ambient.advance(AUTOMATION_ATTEMPT_MS);
		await vi.waitFor(() => expect(relays(lamp)).toBe(2));
		await automations.settled();

		expect(relayOrder).toEqual(["10.0.0.1", "10.0.0.3", "10.0.0.2", "10.0.0.1"]);
	});

	it("takes a retry that fell due before a later run's turn came, though it is barely overdue", async () => {
		const { lamp, heater, fan, ambient, automationsOf, relayOrder } = await plugs();
		const { automations, fire } = automationsOf({
			slow: switched(LAMP),
			warm: switched(HEATER),
			fast: switched(FAN),
		});

		fire("slow");
		await lamp.waitForHeldReply();
		fire("warm");
		await ambient.advance(AUTOMATION_ATTEMPT_MS);
		await heater.waitForHeldReply();
		// Lamp retry already due.
		await ambient.advance(BACKOFF_MIN_MS + 2_000);
		fire("fast");
		await ambient.advance(AUTOMATION_ATTEMPT_MS - BACKOFF_MIN_MS - 2_000);
		await vi.waitFor(() => expect(relays(fan)).toBe(1));
		await automations.settled();

		expect(relays(lamp)).toBe(2);
		expect(relayOrder).toEqual(["10.0.0.1", "10.0.0.3", "10.0.0.1", "10.0.0.2"]);
	});
});
