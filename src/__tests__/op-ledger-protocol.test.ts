import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeRouter,
	confirmHandshakeRole,
	connectToRouter,
	initBridge,
	opLedgerRefusal,
} from "../mcp/bridge/helpers.js";
import { pluginProfile } from "../mcp/sessionCli.js";
import { OP_LEDGER_PROTOCOL } from "../shared/schemas.js";

const fakeSockets = vi.hoisted(() => ({ instances: [] as Array<{ emit: (event: string, value?: unknown) => void }> }));

vi.mock("ws", () => {
	class FakeSocket {
		private listeners = new Map<string, Array<(value?: unknown) => void>>();
		on(event: string, listener: (value?: unknown) => void): this {
			this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
			return this;
		}
		send(_value: string): void {}
		close(): void {}
		emit(event: string, value?: unknown): void {
			for (const listener of this.listeners.get(event) ?? []) listener(value);
		}
	}
	return {
		default: class extends FakeSocket {
			constructor() {
				super();
				fakeSockets.instances.push(this);
			}
		},
	};
});

const BASE = { routerUrl: "http://localhost:20000", projectName: "host.abc123", profile: pluginProfile("claude") };

afterEach(() => {
	closeRouter();
	fakeSockets.instances = [];
	vi.restoreAllMocks();
});

function connect(profile = BASE.profile): (typeof fakeSockets.instances)[number] {
	initBridge({ ...BASE, profile });
	connectToRouter();
	const socket = fakeSockets.instances.at(-1)!;
	socket.emit("open");
	return socket;
}

describe("op-ledger protocol handshake", () => {
	it("refuses absent and old versions, allows current, and resets after reconnect", () => {
		const socket = connect();
		expect(opLedgerRefusal()).toContain("has not advertised");
		socket.emit("message", JSON.stringify({ type: "register_ok" }));
		expect(opLedgerRefusal()).toContain("has not advertised");
		socket.emit("message", JSON.stringify({ type: "register_ok", opLedgerProtocol: -1 }));
		expect(opLedgerRefusal()).toContain("older");
		socket.emit("message", JSON.stringify({ type: "register_ok", opLedgerProtocol: OP_LEDGER_PROTOCOL }));
		expect(opLedgerRefusal()).toBeNull();
		socket.emit("close");
		expect(opLedgerRefusal()).toContain("has not advertised");
	});

	it("gates the handshake auto-reply until the current version is advertised", async () => {
		vi.useFakeTimers();
		try {
			const bodies: string[] = [];
			const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
				bodies.push(String(init?.body));
				if (bodies.length < 3) throw new Error("offline");
				return new Response("{}");
			});
			const socket = connect();
			socket.emit(
				"message",
				JSON.stringify({ type: "channel_push", from: "gateway", session_id: "hs-old", replyJsonSchema: {} }),
			);
			confirmHandshakeRole("hs-old", true);
			socket.emit(
				"message",
				JSON.stringify({ type: "channel_push", from: "gateway", session_id: "hs-old", replyJsonSchema: {} }),
			);
			await Promise.resolve();
			expect(fetchMock).not.toHaveBeenCalled();

			socket.emit("message", JSON.stringify({ type: "register_ok", opLedgerProtocol: OP_LEDGER_PROTOCOL }));
			socket.emit(
				"message",
				JSON.stringify({ type: "channel_push", from: "gateway", session_id: "hs-new", replyJsonSchema: {} }),
			);
			for (let i = 0; i < 10; i++) await Promise.resolve();
			await vi.advanceTimersByTimeAsync(6_000);
			for (let i = 0; i < 10; i++) await Promise.resolve();
			expect(bodies).toHaveLength(3);
			expect(JSON.parse(bodies[1]).opId).toBe(JSON.parse(bodies[0]).opId);
			expect(JSON.parse(bodies[2]).opId).toBe(JSON.parse(bodies[0]).opId);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("the plugin's CLI on the bridge", () => {
	const handshake = (id: string) =>
		JSON.stringify({ type: "channel_push", from: "gateway", session_id: id, delivery_id: id, replyJsonSchema: {} });

	function registered(agentType: string): (typeof fakeSockets.instances)[number] {
		const socket = connect(pluginProfile(agentType));
		socket.emit("message", JSON.stringify({ type: "register_ok", opLedgerProtocol: OP_LEDGER_PROTOCOL }));
		return socket;
	}

	it("answers a repeat handshake itself or hands it to the CLI, and pushes nothing to a CLI with no transport", async () => {
		const posted: Array<[path: string, id: string]> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			// A reply names its session, a typed row its delivery.
			const body = JSON.parse(String(init?.body)) as { session_id?: string; key?: string };
			posted.push([new URL(String(input)).pathname, body.session_id ?? body.key ?? ""]);
			return Response.json({ typed: true });
		});
		registered("claude").emit("message", handshake("hs-role"));
		confirmHandshakeRole("hs-role", true);
		posted.length = 0;

		registered("claude").emit("message", handshake("hs-claude"));
		const other = registered("cursor");
		other.emit("message", handshake("hs-other"));
		other.emit(
			"message",
			JSON.stringify({ type: "channel_push", from: "recipe-app.work", body: "hi", delivery_id: "plain" }),
		);
		registered("copilot").emit("message", handshake("hs-copilot"));

		await vi.waitFor(() => expect(posted).toHaveLength(3));
		expect(posted).toEqual([
			["/respond", "hs-claude"],
			["/respond", "hs-other"],
			["/session/type", "hs-copilot"],
		]);
	});
});
