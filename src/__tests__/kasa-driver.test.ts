import { createServer, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { DeviceDriverFailure, type DeviceOperationContext } from "../gateway/devices/driver.js";
import { frame } from "../gateway/devices/kasa/codec.js";
import { createKasaDriver } from "../gateway/devices/kasa/kasaDriver.js";
import { createKasaTransport, KASA_MAX_ANSWER_BYTES } from "../gateway/devices/kasa/transport.js";
import { linkedSignal } from "../shared/ambient.js";
import type { DeviceRecord } from "../shared/schemasDevices.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";
import { createFakeKasaPlug, type FakeKasaPlugOptions } from "../testing/fakeKasaPlug.js";

const DEVICE_MAC = "aa:bb:cc:dd:ee:ff";

function record(): DeviceRecord {
	return {
		id: DEVICE_MAC,
		name: "Desk Plug",
		kind: "switch",
		driver: "kasa",
		address: "127.0.0.1",
		revision: 1,
	};
}

async function withContext<T>(work: (ctx: DeviceOperationContext) => Promise<T>, ms = 500): Promise<T> {
	const ambient = fakeAmbient({ drive: "real" });
	const linked = linkedSignal(ambient, { ms, reason: "test deadline" });
	try {
		return await work({ ambient, signal: linked.signal });
	} finally {
		linked.dispose();
	}
}

async function withPlug<T>(
	options: FakeKasaPlugOptions,
	work: (
		plug: Awaited<ReturnType<typeof createFakeKasaPlug>>,
		driver: ReturnType<typeof createKasaDriver>,
	) => Promise<T>,
): Promise<T> {
	const plug = await createFakeKasaPlug(options);
	try {
		return await work(plug, createKasaDriver({ port: plug.port }));
	} finally {
		await plug.close();
	}
}

async function failureOf(work: () => Promise<unknown>) {
	try {
		await work();
		throw new Error("expected a device driver failure");
	} catch (error) {
		expect(error).toBeInstanceOf(DeviceDriverFailure);
		return (error as DeviceDriverFailure).failure;
	}
}

function commandNames(plug: Awaited<ReturnType<typeof createFakeKasaPlug>>): string[] {
	return plug.received().map((row) => row.command);
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		const failed = (error: Error) => reject(error);
		server.once("error", failed);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", failed);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Test server did not bind");
	return address.port;
}

describe("Kasa driver", () => {
	it("identifies the plug and reads its live state and schedule", async () => {
		await withPlug({ relayState: 1 }, async (plug, driver) => {
			await withContext(async (ctx) => {
				expect(await driver.identify("127.0.0.1", ctx)).toBe(DEVICE_MAC);
				const answer = await driver.read(record(), ctx);

				expect(answer.state.state).toBe("on");
				expect(answer.schedule).toEqual({ enabled: true, rules: [] });
				expect(commandNames(plug).slice(0, 3)).toEqual(["get_sysinfo", "get_sysinfo", "get_rules"]);
			});
		});
	});

	it("sets on, off, and toggle, then reads each result back", async () => {
		await withPlug({}, async (plug, driver) => {
			await withContext(async (ctx) => {
				expect((await driver.set(record(), "on", ctx)).state).toBe("on");
				expect((await driver.set(record(), "off", ctx)).state).toBe("off");
				expect((await driver.set(record(), "toggle", ctx)).state).toBe("on");
			});
			const writes = plug.received().filter((row) => row.command === "set_relay_state");
			expect(writes.map((row) => row.args.state)).toEqual([1, 0, 1]);
		});
	});

	it("edits, deletes, and adds schedule rules while preserving foreign rules", async () => {
		const storedRules = [
			{
				id: "edit-me",
				name: "Morning",
				stime_opt: 0,
				wday: [1, 0, 0, 0, 0, 0, 0],
				smin: 360,
				enable: 1,
				repeat: 1,
				sact: 1,
			},
			{
				id: "drop-me",
				name: "Evening",
				stime_opt: 0,
				wday: [0, 0, 0, 0, 0, 0, 1],
				smin: 1200,
				enable: 1,
				repeat: 1,
				sact: 0,
			},
			{
				id: "sunrise-rule",
				name: "Sunrise",
				stime_opt: 1,
				wday: [1, 1, 1, 1, 1, 1, 1],
				smin: 0,
				enable: 1,
				repeat: 1,
				sact: 1,
			},
			{
				id: "one-shot-rule",
				name: "One shot",
				stime_opt: 0,
				wday: [0, 0, 0, 0, 0, 0, 0],
				smin: 800,
				enable: 1,
				repeat: 0,
				sact: 1,
			},
		];
		await withPlug({ rules: storedRules }, async (plug, driver) => {
			await withContext(async (ctx) => {
				const answer = await driver.schedule(record(), ctx).put({
					enabled: false,
					rules: [
						{
							id: "edit-me",
							days: [true, true, true, true, true, false, false],
							time: "07:45",
							action: "off",
							enabled: false,
						},
						{
							days: [false, false, false, false, false, false, true],
							time: "19:15",
							action: "on",
							enabled: true,
						},
					],
				});

				expect(answer.enabled).toBe(false);
				expect(answer.rules.map((rule) => rule.id)).toEqual(["edit-me", "fake-rule-1"]);
				expect(answer.rules[0]).toMatchObject({ time: "07:45", action: "off", enabled: false });
			});
			const rows = plug.received();
			expect(rows.some((row) => row.command === "edit_rule" && row.args.id === "sunrise-rule")).toBe(false);
			expect(rows.some((row) => row.command === "delete_rule" && row.args.id === "drop-me")).toBe(true);
			expect(rows.some((row) => row.command === "delete_rule" && row.args.id === "sunrise-rule")).toBe(false);
		});
	});

	it("replays an idless schedule rule without adding it again", async () => {
		await withPlug({}, async (plug, driver) => {
			const schedule = {
				enabled: true,
				rules: [
					{
						days: [true, false, true, false, true, false, true],
						time: "06:15",
						action: "on" as const,
						enabled: true,
					},
				],
			};
			await withContext(async (ctx) => {
				await driver.schedule(record(), ctx).put(schedule);
				const replay = await driver.schedule(record(), ctx).put(schedule);
				expect(replay.rules).toHaveLength(1);
				expect(replay.rules[0]).toMatchObject({ id: "fake-rule-1", time: "06:15", action: "on" });
			});
			expect(plug.received().filter((row) => row.command === "add_rule")).toHaveLength(1);
		});
	});

	it("reports the landed schedule mutations when the operation signal ends", async () => {
		const parent = new AbortController();
		const linked = linkedSignal(fakeAmbient({ drive: "real" }), { parent: parent.signal });
		const mutations: string[] = [];
		const transport = {
			request: async (_address: string, command: object) => {
				const [module] = Object.keys(command);
				const body = (command as Record<string, Record<string, Record<string, unknown>>>)[module!]!;
				const [name] = Object.keys(body);
				if (module === "system" && name === "get_sysinfo") {
					return { system: { get_sysinfo: { mac: DEVICE_MAC, relay_state: 0 } } };
				}
				if (module === "schedule" && name === "get_rules") {
					return { schedule: { get_rules: { rule_list: [], enable: 1 } } };
				}
				if (module === "schedule" && name === "add_rule") {
					mutations.push(name);
					parent.abort("test deadline");
					return { schedule: { add_rule: { err_code: 0, id: "rule-1" } } };
				}
				if (module === "schedule" && name === "set_overall_enable") {
					mutations.push(name);
					return { schedule: { set_overall_enable: { err_code: 0 } } };
				}
				throw new Error(`Unexpected Kasa command ${module}.${name}`);
			},
		};
		const driver = createKasaDriver({ transport });
		try {
			const failure = await failureOf(() =>
				driver.schedule(record(), { ambient: fakeAmbient(), signal: linked.signal }).put({
					enabled: false,
					rules: [
						{
							days: [true, false, false, false, false, false, false],
							time: "07:00",
							action: "on",
							enabled: true,
						},
						{
							days: [false, true, false, false, false, false, false],
							time: "08:00",
							action: "off",
							enabled: true,
						},
					],
				}),
			);
			expect(failure.kind).toBe("timeout");
			if (failure.kind !== "timeout") throw new Error("Expected a schedule timeout");
			expect(failure.detail).toContain("1 of 3 mutations landed");
			expect(failure.detail).toContain("a devices read shows the plug's state");
			expect(mutations).toEqual(["add_rule"]);
		} finally {
			linked.dispose();
		}
	});

	it("reads back LED changes and disconnects cloud access", async () => {
		await withPlug({}, async (plug, driver) => {
			await withContext(async (ctx) => {
				const settings = driver.settings(record(), ctx);
				expect(await settings.put({ driver: "kasa", setting: { key: "led", value: false } })).toMatchObject({
					led: false,
				});
				expect(
					await settings.put({ driver: "kasa", setting: { key: "cloud", value: "disconnected" } }),
				).toMatchObject({ cloud: "disconnected" });
			});
			const rows = plug.received();
			expect(rows.some((row) => row.command === "set_led_off" && row.args.off === 1)).toBe(true);
			expect(rows.map((row) => row.command)).toContain("unbind");
			expect(rows.some((row) => row.command === "set_server_url" && row.args.server === "")).toBe(true);
		});
	});

	it("uses the non-cloud server fallback when an empty server is refused", async () => {
		await withPlug({ refuseEmptyServer: true }, async (plug, driver) => {
			await withContext(async (ctx) => {
				const result = await driver.settings(record(), ctx).put({
					driver: "kasa",
					setting: { key: "cloud", value: "disconnected" },
				});
				expect(result.cloud).toBe("disconnected");
			});
			expect(
				plug
					.received()
					.filter((row) => row.command === "set_server_url")
					.map((row) => row.args.server),
			).toEqual(["", "0.0.0.0"]);
		});
	});

	it("sends no operation after an identity mismatch", async () => {
		await withPlug(
			{
				behavior: (request) =>
					request.command === "get_sysinfo" ? { kind: "differentMac", mac: "00:11:22:33:44:55" } : undefined,
			},
			async (plug, driver) => {
				const failure = await withContext((ctx) => failureOf(() => driver.set(record(), "on", ctx)));
				expect(failure.kind).toBe("unreachable");
				expect(commandNames(plug)).toEqual(["get_sysinfo"]);
			},
		);
	});

	it("stops schedule writes when identity changes after a mutation", async () => {
		await withPlug(
			{
				rules: [
					{
						id: "edit-me",
						name: "Morning",
						stime_opt: 0,
						wday: [1, 0, 0, 0, 0, 0, 0],
						smin: 360,
						enable: 1,
						repeat: 1,
						sact: 1,
					},
					{
						id: "drop-me",
						name: "Evening",
						stime_opt: 0,
						wday: [0, 0, 0, 0, 0, 0, 1],
						smin: 1200,
						enable: 1,
						repeat: 1,
						sact: 0,
					},
				],
				behavior: (request) =>
					request.command === "edit_rule"
						? { kind: "changeMacAfter", command: "edit_rule", mac: "00:11:22:33:44:55" }
						: undefined,
			},
			async (plug, driver) => {
				const failure = await withContext((ctx) =>
					failureOf(() =>
						driver.schedule(record(), ctx).put({
							enabled: false,
							rules: [
								{
									id: "edit-me",
									days: [true, true, true, true, true, false, false],
									time: "07:45",
									action: "off",
									enabled: false,
								},
								{
									days: [false, false, false, false, false, false, true],
									time: "19:15",
									action: "on",
									enabled: true,
								},
							],
						}),
					),
				);

				expect(failure.kind).toBe("unreachable");
				expect(commandNames(plug)).toEqual([
					"get_sysinfo",
					"get_rules",
					"get_sysinfo",
					"edit_rule",
					"get_sysinfo",
				]);
				expect(
					plug
						.received()
						.filter((row) =>
							["edit_rule", "delete_rule", "add_rule", "set_overall_enable"].includes(row.command),
						)
						.map((row) => row.command),
				).toEqual(["edit_rule"]);
			},
		);
	});

	it("answers unreachable when the plug closes without a response", async () => {
		await withPlug(
			{ behavior: (request) => (request.command === "get_rules" ? { kind: "disconnect" } : undefined) },
			async (plug, driver) => {
				const failure = await withContext((ctx) => failureOf(() => driver.read(record(), ctx)));
				expect(failure.kind).toBe("unreachable");
				expect(commandNames(plug)).toEqual(["get_sysinfo", "get_rules"]);
			},
		);
	});

	it("times out when the plug keeps a connection silent", async () => {
		await withPlug({ behavior: () => ({ kind: "silent" }) }, async (plug, driver) => {
			const ambient = fakeAmbient({ drive: "manual", now: () => 1_000 });
			const linked = linkedSignal(ambient, { ms: 25, reason: "test deadline" });
			try {
				const operation = failureOf(() => driver.read(record(), { ambient, signal: linked.signal }));
				await vi.waitFor(() => expect(plug.received()).toHaveLength(1));
				await ambient.advance(25);
				const failure = await operation;
				expect(failure.kind).toBe("timeout");
				expect(plug.openConnections()).toBe(0);
			} finally {
				linked.dispose();
			}
		});
	});

	it("maps a malformed response to unreachable", async () => {
		await withPlug(
			{ behavior: (request) => (request.command === "get_sysinfo" ? { kind: "malformed" } : undefined) },
			async (plug, driver) => {
				const failure = await withContext((ctx) => failureOf(() => driver.identify("127.0.0.1", ctx)));
				expect(failure.kind).toBe("unreachable");
				expect(commandNames(plug)).toEqual(["get_sysinfo"]);
			},
		);
	});

	it("times out after sending and drops a reply that arrives late", async () => {
		await withPlug(
			{ behavior: (request) => (request.command === "set_relay_state" ? { kind: "hold" } : undefined) },
			async (plug, driver) => {
				const ambient = fakeAmbient({ drive: "manual" });
				const linked = linkedSignal(ambient, { ms: 20, reason: "test deadline" });
				try {
					const operation = failureOf(() => driver.set(record(), "on", { ambient, signal: linked.signal }));
					await plug.waitForHeldReply();
					await ambient.advance(20);
					const failure = await operation;
					expect(failure.kind).toBe("timeout");
					expect(commandNames(plug)).toContain("set_relay_state");
					expect(plug.openConnections()).toBe(0);
					plug.releaseHeldReplies();
					expect(plug.lateRepliesDropped()).toBe(1);
					expect(await operation).toEqual(failure);
				} finally {
					linked.dispose();
				}
			},
		);
	});

	it("answers a device refusal with its code", async () => {
		await withPlug(
			{
				behavior: (request) =>
					request.command === "set_relay_state"
						? { kind: "error", command: "set_relay_state", code: -17, message: "relay locked" }
						: undefined,
			},
			async (plug, driver) => {
				const failure = await withContext((ctx) => failureOf(() => driver.set(record(), "on", ctx)));
				expect(failure).toEqual({ kind: "refused", code: -17, message: "relay locked" });
			},
		);
	});

	it("answers not sent when the signal is already aborted", async () => {
		await withPlug({}, async (plug, driver) => {
			const controller = new AbortController();
			controller.abort("test deadline");
			const failure = await failureOf(() =>
				driver.read(record(), { ambient: fakeAmbient(), signal: controller.signal }),
			);
			expect(failure).toMatchObject({ kind: "timeout", sent: false });
			expect(plug.received()).toHaveLength(0);
		});
	});

	it("carries the landed count on a refusal mid-put", async () => {
		await withPlug(
			{
				behavior: (request) =>
					request.command === "set_overall_enable"
						? { kind: "error", command: "set_overall_enable", code: -3, message: "busy" }
						: undefined,
			},
			async (plug, driver) => {
				const failure = await withContext((ctx) =>
					failureOf(() =>
						driver.schedule(record(), ctx).put({
							enabled: true,
							rules: [
								{
									days: [true, false, false, false, false, false, false],
									time: "07:00",
									action: "on",
									enabled: true,
								},
							],
						}),
					),
				);
				expect(failure).toMatchObject({ kind: "refused", code: -3 });
				expect((failure as { message: string }).message).toContain("1 of 2 mutations landed");
				expect(plug.received().filter((row) => row.command === "add_rule")).toHaveLength(1);
			},
		);
	});

	it("leaves a rule it cannot represent alone", async () => {
		await withPlug(
			{
				rules: [
					{
						id: "end-rule",
						stime_opt: 0,
						repeat: 1,
						smin: 60,
						sact: 1,
						enable: 1,
						wday: [1, 1, 1, 1, 1, 1, 1],
						etime_opt: 0,
						emin: 120,
						eact: 0,
					},
				],
			},
			async (plug, driver) => {
				await withContext(async (ctx) => {
					expect((await driver.schedule(record(), ctx).read()).rules).toEqual([]);
					const answer = await driver.schedule(record(), ctx).put({
						enabled: true,
						rules: [
							{
								days: [false, true, true, true, true, true, false],
								time: "08:00",
								action: "off",
								enabled: true,
							},
						],
					});
					expect(answer.rules.map((rule) => rule.time)).toEqual(["08:00"]);
				});
				expect(plug.received().some((row) => row.command === "delete_rule")).toBe(false);
				expect(plug.received().some((row) => row.command === "edit_rule")).toBe(false);
			},
		);
	});

	it("replays a put cut after its rule landed without adding it again", async () => {
		let enables = 0;
		await withPlug(
			{
				behavior: (request) =>
					request.command === "set_overall_enable" && ++enables === 1 ? { kind: "hold" } : undefined,
			},
			async (plug, driver) => {
				const schedule = {
					enabled: false,
					rules: [
						{
							days: [true, true, true, true, true, false, false],
							time: "06:30",
							action: "on" as const,
							enabled: true,
						},
					],
				};
				const ambient = fakeAmbient({ drive: "manual" });
				const linked = linkedSignal(ambient, { ms: 20, reason: "test deadline" });
				try {
					const cut = failureOf(() =>
						driver.schedule(record(), { ambient, signal: linked.signal }).put(schedule),
					);
					await plug.waitForHeldReply();
					await ambient.advance(20);
					const failure = await cut;
					expect(failure).toMatchObject({ kind: "timeout", sent: true });
					expect((failure as { detail: string }).detail).toContain(
						"1 of 2 mutations landed, one more sent with an unknown outcome",
					);
				} finally {
					linked.dispose();
				}
				plug.releaseHeldReplies();
				const replay = await withContext((ctx) => driver.schedule(record(), ctx).put(schedule));
				expect(replay).toMatchObject({ enabled: false });
				expect(replay.rules).toHaveLength(1);
				expect(plug.received().filter((row) => row.command === "add_rule")).toHaveLength(1);
			},
		);
	});

	it("parses a reply sent across many small chunks", async () => {
		let writes = 0;
		const server = createServer((socket: Socket) => {
			socket.once("data", () => {
				const packet = Buffer.from(
					frame(JSON.stringify({ system: { get_sysinfo: { err_code: 0, mac: DEVICE_MAC } } })),
				);
				let offset = 0;
				const sendChunk = () => {
					if (offset === packet.length) {
						socket.end();
						return;
					}
					const end = Math.min(offset + 2, packet.length);
					socket.write(packet.subarray(offset, end));
					offset = end;
					writes += 1;
					setImmediate(sendChunk);
				};
				sendChunk();
			});
		});
		const port = await listen(server);
		try {
			const response = await createKasaTransport(port).request(
				"127.0.0.1",
				{ system: { get_sysinfo: {} } },
				new AbortController().signal,
			);
			expect(writes).toBeGreaterThan(10);
			expect(response).toEqual({ system: { get_sysinfo: { err_code: 0, mac: DEVICE_MAC } } });
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("refuses an oversized reply from its trickled length header", async () => {
		let headerBytesSent = 0;
		let serverClosed: () => void = () => {};
		const closed = new Promise<void>((resolve) => {
			serverClosed = resolve;
		});
		const server = createServer((socket: Socket) => {
			socket.on("close", serverClosed);
			socket.once("data", () => {
				const header = Buffer.alloc(4);
				header.writeUInt32BE(KASA_MAX_ANSWER_BYTES + 1);
				let offset = 0;
				const sendByte = () => {
					if (offset === header.length) return;
					socket.write(header.subarray(offset, offset + 1));
					offset += 1;
					headerBytesSent += 1;
					setImmediate(sendByte);
				};
				sendByte();
			});
		});
		const port = await listen(server);
		try {
			const failure = await failureOf(() =>
				createKasaTransport(port).request(
					"127.0.0.1",
					{ system: { get_sysinfo: {} } },
					new AbortController().signal,
				),
			);
			await closed;
			expect(failure).toMatchObject({ kind: "unreachable" });
			expect(headerBytesSent).toBe(4);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});
