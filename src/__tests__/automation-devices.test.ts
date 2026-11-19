import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { automationActions } from "../gateway/compose/automationActions.js";
import { openAutomationPair } from "../gateway/compose/composeAutomations.js";
import { composeDevices } from "../gateway/compose/composeDevices.js";
import { type Automations, BACKOFF_MIN_MS } from "../gateway/computed/automations.js";
import { DeviceDriverFailure } from "../gateway/devices/driver.js";
import { createKasaTransport } from "../gateway/devices/kasa/transport.js";
import { AUTOMATION_ATTEMPT_MS, CONNECT_FLOOR_MS } from "../gateway/devices/road.js";
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
			request: (address, command, signal) => {
				if (JSON.stringify(command).includes("set_relay_state")) relayOrder.push(address);
				if (!dead.has(address))
					return createKasaTransport(ports[address] as number).request("127.0.0.1", command, signal);
				dials++;
				// As the transport answers a connect its deadline cut.
				return new Promise((_, reject) =>
					signal.addEventListener("abort", () =>
						reject(new DeviceDriverFailure({ kind: "timeout", detail: "never opened", sent: false })),
					),
				);
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

	it("answers a hold when the queue leaves less than a connect's floor of its bound", async () => {
		const { lamp, ambient, devices, actions } = await plugs();

		const busy = devices.console({ kind: "device_set", id: LAMP, verb: "on" });
		await lamp.waitForHeldReply();
		const queued = actions.deviceSet(LAMP, "on");
		await ambient.advance(AUTOMATION_ATTEMPT_MS - CONNECT_FLOOR_MS + 1);
		lamp.releaseHeldReplies();
		await busy;

		expect(await queued).toHaveProperty("hold");
	});

	it("ends a Toggle at once and retries an On when a plug's connect never opens, leaving the assistant's hold as it was", async () => {
		const { ambient, devices, automationsOf, kill, dials } = await plugs();
		kill("10.0.0.1");
		const { automations, fire } = automationsOf({ flip: switched(LAMP, "toggle"), light: switched(LAMP) });

		/** Waits for the dial, then cuts it. */
		const cut = async (dialed: number) => {
			await vi.waitFor(() => expect(dials()).toBe(dialed));
			await ambient.advance(AUTOMATION_ATTEMPT_MS);
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
		await ambient.advance(60_000);

		expect(outcomes(automations)).toEqual(["flip refused"]);
		expect(await assistant).toMatchObject({ kind: "refused", refusal: { code: "timeout", effect: "none" } });
		expect(await assistant).not.toHaveProperty("refusal.detail");
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

	it("takes another run's first attempt before a silent plug's retry that is already due", async () => {
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
});
