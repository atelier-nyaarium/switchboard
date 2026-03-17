import { afterEach, describe, expect, it, vi } from "vitest";
import { WakeCoordinator } from "../arbiter/wake.js";
import { createWebSocketHandlers, type WsData } from "../arbiter/websocket.js";
import { Mutex } from "../shared/mutex.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import type { ResponsePayload } from "../shared/types.js";

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
			store?: PendingJobStore<ResponsePayload>;
			targetLocks?: Map<string, Mutex>;
			knownTeamPaths?: Map<string, string>;
			offlineCatalog?: Map<string, string>;
			wakeCoordinator?: WakeCoordinator;
		} = {},
	) {
		const registry = overrides.registry || new Map();
		const store = overrides.store || new PendingJobStore<ResponsePayload>();
		const targetLocks = overrides.targetLocks || new Map();
		const knownTeamPaths = overrides.knownTeamPaths || new Map();
		const offlineCatalog = overrides.offlineCatalog || new Map();
		const wakeCoordinator = overrides.wakeCoordinator || new WakeCoordinator();
		const handlers = createWebSocketHandlers({
			registry,
			store,
			targetLocks,
			config: { HEARTBEAT_INTERVAL_MS: 100000, MISSED_PINGS_LIMIT: 2 },
			knownTeamPaths,
			offlineCatalog,
			wakeCoordinator,
		});
		intervals.push(handlers.heartbeatInterval);
		return { handlers, registry, store, targetLocks, knownTeamPaths, offlineCatalog, wakeCoordinator };
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

	it("disconnect delivers error to pending jobs for that team", async () => {
		const store = new PendingJobStore<ResponsePayload>();
		store.create("sess-1", "other", "alpha");

		let waitResult: { delivered: boolean; result?: ResponsePayload } | null = null;
		const waitPromise = store.waitForResult("sess-1", 10_000).then((r) => {
			waitResult = r;
		});

		const { handlers } = setup({ store });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "alpha" }));
		handlers.close(ws);

		await waitPromise;
		expect(waitResult!.delivered).toBe(true);
		expect(waitResult!.result!.status).toBe("error");
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

	it("catalog from __host__ populates offlineCatalog", () => {
		const { handlers, offlineCatalog } = setup();
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "__host__" }));
		handlers.message(
			ws,
			JSON.stringify({
				type: "catalog",
				projects: [
					{ team: "proj-a", projectPath: "/home/user/proj-a" },
					{ team: "proj-b", projectPath: "/home/user/proj-b" },
				],
			}),
		);
		expect(offlineCatalog.size).toBe(2);
		expect(offlineCatalog.get("proj-a")).toBe("/home/user/proj-a");
	});

	it("catalog from non-host is ignored", () => {
		const { handlers, offlineCatalog } = setup();
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "some-team" }));
		handlers.message(
			ws,
			JSON.stringify({
				type: "catalog",
				projects: [{ team: "proj-a", projectPath: "/home/user/proj-a" }],
			}),
		);
		expect(offlineCatalog.size).toBe(0);
	});

	it("host disconnect clears offlineCatalog", () => {
		const { handlers, offlineCatalog } = setup();
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "__host__" }));
		handlers.message(
			ws,
			JSON.stringify({
				type: "catalog",
				projects: [{ team: "proj-a", projectPath: "/home/user/proj-a" }],
			}),
		);
		expect(offlineCatalog.size).toBe(1);
		handlers.close(ws);
		expect(offlineCatalog.size).toBe(0);
	});

	it("catalog populates knownTeamPaths only for new teams", () => {
		const knownTeamPaths = new Map<string, string>();
		knownTeamPaths.set("proj-a", "/existing/path");
		const { handlers } = setup({ knownTeamPaths });
		const ws = createMockWs();
		handlers.open(ws);
		handlers.message(ws, JSON.stringify({ type: "register", team: "__host__" }));
		handlers.message(
			ws,
			JSON.stringify({
				type: "catalog",
				projects: [
					{ team: "proj-a", projectPath: "/catalog/proj-a" },
					{ team: "proj-b", projectPath: "/catalog/proj-b" },
				],
			}),
		);
		expect(knownTeamPaths.get("proj-a")).toBe("/existing/path");
		expect(knownTeamPaths.get("proj-b")).toBe("/catalog/proj-b");
	});
});
