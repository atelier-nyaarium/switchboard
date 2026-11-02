import { createServer, type Server, type Socket } from "node:net";
import { frame, unframe } from "../gateway/devices/kasa/codec.js";
import { KASA_MAX_ANSWER_BYTES } from "../gateway/devices/kasa/transport.js";

export interface FakeKasaRequest {
	connection: number;
	module: string;
	command: string;
	args: Record<string, unknown>;
}

export type FakeKasaBehavior =
	| { kind: "silent" }
	| { kind: "disconnect" }
	| { kind: "malformed" }
	| { kind: "hold" }
	| { kind: "error"; code: number; message?: string; command?: string }
	| { kind: "differentMac"; mac: string }
	| { kind: "changeMacAfter"; command: string; mac: string }
	| { kind: "changeRelayStateAfter"; command: string; state: 0 | 1 };

export interface FakeKasaPlugOptions {
	mac?: string;
	alias?: string;
	model?: string;
	hardware?: string;
	firmware?: string;
	relayState?: 0 | 1;
	ledOff?: 0 | 1;
	deviceId?: string;
	onTime?: number;
	rssi?: number;
	rules?: Array<Record<string, unknown>>;
	overallEnable?: 0 | 1;
	cloudServer?: string;
	cloudUsername?: string;
	clock?: { year: number; month: number; mday: number; hour: number; min: number; sec: number };
	timezoneIndex?: number;
	refuseEmptyServer?: boolean;
	behavior?: (request: FakeKasaRequest) => FakeKasaBehavior | undefined;
}

export interface FakeKasaReceived extends FakeKasaRequest {
	value: Record<string, unknown>;
}

export interface FakeKasaPlug {
	port: number;
	received(): FakeKasaReceived[];
	lateRepliesDropped(): number;
	waitForHeldReply(): Promise<void>;
	waitForConnectionsClosed(): Promise<void>;
	releaseHeldReplies(): void;
	openConnections(): number;
	close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function response(request: FakeKasaRequest, value: Record<string, unknown>): Record<string, unknown> {
	return { [request.module]: { [request.command]: { err_code: 0, ...value } } };
}

function failure(request: FakeKasaRequest, behavior: Extract<FakeKasaBehavior, { kind: "error" }>) {
	return {
		[request.module]: {
			[request.command]: {
				err_code: behavior.code,
				err_msg: behavior.message ?? "scripted refusal",
			},
		},
	};
}

function requestOf(value: unknown, connection: number): FakeKasaRequest | null {
	if (!isRecord(value)) return null;
	const [module] = Object.keys(value);
	if (!module || !isRecord(value[module])) return null;
	const [command] = Object.keys(value[module]);
	if (!command || !isRecord(value[module][command])) return null;
	return { connection, module, command, args: value[module][command] };
}

export async function createFakeKasaPlug(options: FakeKasaPlugOptions = {}): Promise<FakeKasaPlug> {
	const receivedRows: FakeKasaReceived[] = [];
	const sockets = new Set<Socket>();
	const heldReplies = new Map<number, { socket: Socket; answer: Record<string, unknown> }>();
	const heldReplyWaiters: Array<() => void> = [];
	let holds = 0;
	let holdsAwaited = 0;
	const connectionClosedWaiters = new Set<() => void>();
	const rules = structuredClone(options.rules ?? []);
	const state = {
		mac: options.mac ?? "aa:bb:cc:dd:ee:ff",
		alias: options.alias ?? "Fake Plug",
		model: options.model ?? "HS103(US)",
		hardware: options.hardware ?? "3.0",
		firmware: options.firmware ?? "1.0.3 Build 230412 Rel.111119",
		relayState: options.relayState ?? 0,
		ledOff: options.ledOff ?? 0,
		deviceId: options.deviceId ?? "fake-device-id",
		onTime: options.onTime ?? 0,
		rssi: options.rssi ?? -44,
		overallEnable: options.overallEnable ?? 1,
		cloudServer: options.cloudServer ?? "devs.tplinkcloud.com",
		cloudUsername: options.cloudUsername ?? "owner@example.test",
		clock: options.clock ?? { year: 2026, month: 11, mday: 2, hour: 12, min: 30, sec: 0 },
		timezoneIndex: options.timezoneIndex ?? 6,
	};
	let connectionCount = 0;
	let nextRuleId = 1;
	let droppedReplies = 0;
	const server: Server = createServer((socket) => {
		const connection = ++connectionCount;
		sockets.add(socket);
		socket.on("close", () => {
			sockets.delete(socket);
			if (sockets.size === 0) {
				for (const resolve of connectionClosedWaiters) resolve();
				connectionClosedWaiters.clear();
			}
		});
		let buffer = Buffer.alloc(0);
		let decoded = false;
		socket.on("data", (chunk: Buffer) => {
			if (decoded) return;
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length < 4) return;
			const length = buffer.readUInt32BE(0);
			if (length > KASA_MAX_ANSWER_BYTES) {
				socket.destroy();
				return;
			}
			if (buffer.length < length + 4) return;
			decoded = true;
			let parsed: unknown;
			try {
				parsed = JSON.parse(unframe(buffer.subarray(0, length + 4)));
			} catch {
				socket.destroy();
				return;
			}
			const request = requestOf(parsed, connection);
			if (!request) {
				socket.destroy();
				return;
			}
			const value = isRecord(parsed) ? parsed : {};
			receivedRows.push({ ...request, value });
			const behavior = options.behavior?.(request);
			if (behavior?.kind === "silent") return;
			if (behavior?.kind === "malformed") {
				const body = Buffer.from("{");
				const header = Buffer.alloc(4);
				header.writeUInt32BE(body.length);
				socket.end(Buffer.concat([header, body]));
				return;
			}
			if (behavior?.kind === "disconnect") {
				socket.end();
				return;
			}
			if (behavior?.kind === "error" && (!behavior.command || behavior.command === request.command)) {
				socket.end(frame(JSON.stringify(failure(request, behavior))));
				return;
			}
			if (behavior?.kind === "hold") {
				heldReplies.set(connection, { socket, answer: answerFor(request) });
				holds += 1;
				heldReplyWaiters.shift()?.();
				return;
			}
			let answer = answerFor(request);
			if (behavior?.kind === "differentMac" && request.command === "get_sysinfo") {
				const info = (answer as { system: { get_sysinfo: Record<string, unknown> } }).system.get_sysinfo;
				answer = { system: { get_sysinfo: { ...info, mac: behavior.mac } } };
			}
			if (behavior?.kind === "changeMacAfter" && behavior.command === request.command) state.mac = behavior.mac;
			if (behavior?.kind === "changeRelayStateAfter" && behavior.command === request.command) {
				state.relayState = behavior.state;
			}
			socket.end(frame(JSON.stringify(answer)));
		});
	});
	const answerFor = (request: FakeKasaRequest): Record<string, unknown> => {
		const { module, command, args } = request;
		if (module === "system" && command === "get_sysinfo") {
			return response(request, {
				alias: state.alias,
				model: state.model,
				hw_ver: state.hardware,
				sw_ver: state.firmware,
				mac: state.mac,
				relay_state: state.relayState,
				led_off: state.ledOff,
				deviceId: state.deviceId,
				on_time: state.onTime,
				rssi: state.rssi,
			});
		}
		if (module === "system" && command === "set_relay_state") {
			state.relayState = args.state === 1 ? 1 : 0;
			return response(request, {});
		}
		if (module === "system" && command === "set_dev_alias") {
			state.alias = typeof args.alias === "string" ? args.alias : state.alias;
			return response(request, {});
		}
		if (module === "system" && command === "set_led_off") {
			state.ledOff = args.off === 1 ? 1 : 0;
			return response(request, {});
		}
		if (module === "time" && command === "get_time") return response(request, state.clock);
		if (module === "time" && command === "get_timezone") return response(request, { index: state.timezoneIndex });
		if (module === "schedule" && command === "get_rules") {
			return response(request, { rule_list: structuredClone(rules), enable: state.overallEnable });
		}
		if (module === "schedule" && command === "add_rule") {
			const id = `fake-rule-${nextRuleId++}`;
			rules.push({ ...structuredClone(args), id });
			return response(request, { id });
		}
		if (module === "schedule" && command === "edit_rule") {
			const index = rules.findIndex((rule) => rule.id === args.id);
			if (index >= 0) rules[index] = { ...rules[index], ...structuredClone(args) };
			return response(request, {});
		}
		if (module === "schedule" && command === "delete_rule") {
			const index = rules.findIndex((rule) => rule.id === args.id);
			if (index >= 0) rules.splice(index, 1);
			return response(request, {});
		}
		if (module === "schedule" && command === "set_overall_enable") {
			state.overallEnable = args.enable === 1 ? 1 : 0;
			return response(request, {});
		}
		if (module === "cnCloud" && command === "get_info") {
			return response(request, {
				server: state.cloudServer,
				username: state.cloudUsername,
				binded: state.cloudUsername.length > 0 ? 1 : 0,
			});
		}
		if (module === "cnCloud" && command === "unbind") {
			state.cloudUsername = "";
			return response(request, {});
		}
		if (module === "cnCloud" && command === "set_server_url") {
			if (args.server === "" && options.refuseEmptyServer) {
				return { cnCloud: { err_code: -1, err_msg: "empty server refused" } };
			}
			state.cloudServer = typeof args.server === "string" ? args.server : state.cloudServer;
			return response(request, {});
		}
		return { [module]: { err_code: -1, err_msg: "module command unsupported" } };
	};
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fake Kasa plug did not receive a TCP port");
	return {
		port: address.port,
		received: () => structuredClone(receivedRows),
		lateRepliesDropped: () => droppedReplies,
		// Waits consume holds.
		waitForHeldReply: () => {
			holdsAwaited += 1;
			if (holds >= holdsAwaited) return Promise.resolve();
			return new Promise<void>((resolve) => heldReplyWaiters.push(resolve));
		},
		waitForConnectionsClosed: () =>
			sockets.size === 0
				? Promise.resolve()
				: new Promise<void>((resolve) => connectionClosedWaiters.add(resolve)),
		releaseHeldReplies: () => {
			for (const [connection, pending] of heldReplies) {
				heldReplies.delete(connection);
				if (pending.socket.destroyed || !pending.socket.writable) {
					droppedReplies += 1;
				} else {
					pending.socket.end(frame(JSON.stringify(pending.answer)));
				}
			}
		},
		openConnections: () => [...sockets].filter((socket) => !socket.destroyed).length,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}
