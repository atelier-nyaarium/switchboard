import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSocketHandlers, type WsData } from "../arbiter/websocket.js";
import { Mutex } from "../shared/mutex.js";
import type { PendingEntry } from "../shared/types.js";

function createMockWs() {
	return {
		data: { teamName: null, missedPings: 0, isStale: false } as WsData,
		readyState: 1,
		close: vi.fn(),
		ping: vi.fn(),
		send: vi.fn(),
	} as unknown as import("bun").ServerWebSocket<WsData>;
}

describe("createWebSocketHandlers", () => {
	let intervals: ReturnType<typeof setInterval>[] = [];
	afterEach(() => {
		for (const id of intervals) clearInterval(id);
		intervals = [];
	});

	function setup(
		overrides: {
			registry?: Map<string, import("bun").ServerWebSocket<WsData>>;
			pendingCallbacks?: Map<string, PendingEntry>;
			targetLocks?: Map<string, Mutex>;
		} = {},
	) {
		const registry = overrides.registry || new Map();
		const pendingCallbacks = overrides.pendingCallbacks || new Map();
		const targetLocks = overrides.targetLocks || new Map();
		const handlers = createWebSocketHandlers({
			registry,
			pendingCallbacks,
			targetLocks,
			config: { HEARTBEAT_INTERVAL_MS: 100000, MISSED_PINGS_LIMIT: 2 },
		});
		intervals.push(handlers.heartbeatInterval);
		return { handlers, registry, pendingCallbacks, targetLocks };
	}

	it("register message adds team to registry", () => {
		const { handlers, registry } = setup();
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "alpha" }));
		expect(registry.get("alpha")).toBe(ws);
	});

	it("re-registration closes stale socket", () => {
		const { handlers, registry } = setup();
		const ws1 = createMockWs();
		handlers.open(ws1);
		handlers.message(ws1, JSON.stringify({ type: "register", team: "alpha" }));

		const ws2 = createMockWs();
		handlers.open(ws2);
		handlers.message(ws2, JSON.stringify({ type: "register", team: "alpha" }));

		expect(ws1.close).toHaveBeenCalled();
		expect(registry.get("alpha")).toBe(ws2);
	});

	it("disconnect removes team from registry", () => {
		const { handlers, registry } = setup();
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "alpha" }));
		handlers.close(ws);
		expect(registry.has("alpha")).toBe(false);
	});

	it("disconnect cancels pending callbacks for that team", () => {
		const pendingCallbacks = new Map<string, PendingEntry>();
		let resolved: Record<string, unknown> | null = null;
		pendingCallbacks.set("sess-1", {
			resolve: (v: unknown) => {
				resolved = v as Record<string, unknown>;
			},
			timer: setTimeout(() => {}, 10000),
			from: "other",
			to: "alpha",
		});
		const { handlers } = setup({ pendingCallbacks });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "alpha" }));
		handlers.close(ws);
		expect(resolved!.status).toBe("error");
		expect(pendingCallbacks.has("sess-1")).toBe(false);
	});

	it("disconnect force-releases mutex if locked", async () => {
		const targetLocks = new Map<string, Mutex>();
		const mutex = new Mutex();
		await mutex.acquire("id-1");
		targetLocks.set("alpha", mutex);

		const { handlers } = setup({ targetLocks });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "alpha" }));
		handlers.close(ws);
		expect(mutex.locked).toBe(false);
	});

	it("stale close does not remove team from registry", () => {
		const { handlers, registry } = setup();
		const ws1 = createMockWs();
		handlers.open(ws1);
		handlers.message(ws1, JSON.stringify({ type: "register", team: "alpha" }));

		const ws2 = createMockWs();
		handlers.open(ws2);
		handlers.message(ws2, JSON.stringify({ type: "register", team: "alpha" }));

		// ws1 close fires late
		handlers.close(ws1);
		expect(registry.get("alpha")).toBe(ws2);
	});

	it("invalid JSON message is silently ignored", () => {
		const { handlers, registry } = setup();
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, "not json{{{");
		expect(registry.size).toBe(0);
	});
});
