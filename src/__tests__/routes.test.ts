import { describe, expect, it } from "vitest";
import { createRoutes, type RoutesDeps } from "../arbiter/routes.js";
import { Mutex } from "../shared/mutex.js";

function makeCtx(overrides: Partial<RoutesDeps> = {}): RoutesDeps {
	const registry = overrides.registry || (new Map() as RoutesDeps["registry"]);
	const pendingCallbacks = overrides.pendingCallbacks || new Map();
	const targetLocks = new Map<string, Mutex>();
	const getMutexFn = ((team: string) => {
		if (!targetLocks.has(team)) targetLocks.set(team, new Mutex());
		return targetLocks.get(team)!;
	}) as RoutesDeps["getMutex"];
	getMutexFn.peek = (team: string) => targetLocks.get(team);
	return {
		registry,
		pendingCallbacks,
		getMutex: getMutexFn,
		config: { LOG_PATH: "/tmp/test-debug.log", RESPONSE_TIMEOUT_MS: 500 },
	};
}

describe("routes", () => {
	describe("/pending", () => {
		it("returns empty array when no callbacks", async () => {
			const ctx = makeCtx();
			const { pending } = createRoutes(ctx);
			const res = pending();
			expect(await res.json()).toEqual([]);
		});

		it("returns session_id, from, to for each pending callback", async () => {
			const pendingCallbacks = new Map();
			pendingCallbacks.set("sess-1", { resolve: () => {}, timer: null, from: "a", to: "b" });
			const ctx = makeCtx({ pendingCallbacks });
			const { pending } = createRoutes(ctx);
			const res = pending();
			expect(await res.json()).toEqual([{ session_id: "sess-1", from: "a", to: "b" }]);
		});
	});

	describe("/teams", () => {
		it("returns empty array when registry empty", async () => {
			const ctx = makeCtx();
			const { teams } = createRoutes(ctx);
			const res = teams();
			expect(await res.json()).toEqual([]);
		});

		it("returns team info with queue_depth", async () => {
			const registry = new Map();
			registry.set("team-x", { readyState: 1 });
			const ctx = makeCtx({ registry: registry as RoutesDeps["registry"] });
			const mutex = ctx.getMutex("team-x");
			await mutex.acquire("id-1");

			const { teams } = createRoutes(ctx);
			const res = teams();
			expect(await res.json()).toEqual([{ team: "team-x", status: "active", queue_depth: 1 }]);
		});
	});

	describe("/respond", () => {
		it("returns 400 when session_id missing", async () => {
			const ctx = makeCtx();
			const { respond } = createRoutes(ctx);
			const res = respond(new Request("http://localhost/respond", { method: "POST" }), {});
			expect(res.status).toBe(400);
		});

		it("returns 404 when no pending callback", async () => {
			const ctx = makeCtx();
			const { respond } = createRoutes(ctx);
			const res = respond(new Request("http://localhost/respond", { method: "POST" }), { session_id: "nope" });
			expect(res.status).toBe(404);
		});

		it("resolves pending callback and returns delivered", async () => {
			const pendingCallbacks = new Map();
			let resolved: Record<string, unknown> | null = null;
			pendingCallbacks.set("sess-1", {
				resolve: (v: unknown) => {
					resolved = v as Record<string, unknown>;
				},
				timer: setTimeout(() => {}, 10000),
				from: "a",
				to: "b",
			});
			const ctx = makeCtx({ pendingCallbacks });
			const { respond } = createRoutes(ctx);
			const res = respond(new Request("http://localhost/respond", { method: "POST" }), {
				session_id: "sess-1",
				status: "completed",
				response: "done",
			});
			expect(await res.json()).toEqual({ delivered: true });
			expect(resolved).toEqual({ status: "completed", response: "done" });
			expect(pendingCallbacks.has("sess-1")).toBe(false);
		});
	});

	describe("/health", () => {
		it("returns ok with counts", async () => {
			const registry = new Map();
			registry.set("a", {});
			const pendingCallbacks = new Map();
			pendingCallbacks.set("s1", {});
			const ctx = makeCtx({ registry: registry as RoutesDeps["registry"], pendingCallbacks });
			const { health } = createRoutes(ctx);
			const res = health();
			expect(await res.json()).toEqual({ ok: true, teams: 1, pending_callbacks: 1 });
		});
	});

	describe("/send", () => {
		it("returns 404 when target not in registry", async () => {
			const ctx = makeCtx();
			const { send } = createRoutes(ctx);
			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b",
				body: "hi",
			});
			expect(res.status).toBe(404);
			expect((await res.json()).error).toContain("not connected");
		});

		it("returns 404 when target ws.readyState !== 1", async () => {
			const registry = new Map();
			registry.set("b", { readyState: 3 });
			const ctx = makeCtx({ registry: registry as RoutesDeps["registry"] });
			const { send } = createRoutes(ctx);
			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b",
				body: "hi",
			});
			expect(res.status).toBe(404);
		});

		it("sends inject payload and returns response when resolved", async () => {
			const sent: Record<string, unknown>[] = [];
			const fakeWs = {
				readyState: 1,
				send(data: string) {
					sent.push(JSON.parse(data));
				},
			};
			const registry = new Map();
			registry.set("b", fakeWs);
			const ctx = makeCtx({ registry: registry as RoutesDeps["registry"] });
			const { send } = createRoutes(ctx);

			const promise = send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b",
				type: "question",
				body: "hi",
			});

			await new Promise((r) => setTimeout(r, 10));

			const [sessionId] = [...ctx.pendingCallbacks.keys()];
			const entry = ctx.pendingCallbacks.get(sessionId)!;
			clearTimeout(entry.timer);
			ctx.pendingCallbacks.delete(sessionId);
			entry.resolve({ session_id: sessionId, status: "completed", response: "answer" });

			const res = await promise;
			const json = await res.json();

			expect(sent.length).toBe(1);
			expect(sent[0].type).toBe("inject");
			expect(sent[0].from).toBe("a");
			expect(json.status).toBe("completed");
			expect(json.response).toBe("answer");
		});

		it("includes debug fields when debug=true", async () => {
			const fakeWs = { readyState: 1, send() {} };
			const registry = new Map();
			registry.set("b", fakeWs);
			const ctx = makeCtx({ registry: registry as RoutesDeps["registry"] });
			const { send } = createRoutes(ctx);

			const promise = send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b",
				body: "hi",
				debug: true,
			});
			await new Promise((r) => setTimeout(r, 10));

			const [sessionId] = [...ctx.pendingCallbacks.keys()];
			const entry = ctx.pendingCallbacks.get(sessionId)!;
			clearTimeout(entry.timer);
			ctx.pendingCallbacks.delete(sessionId);
			entry.resolve({ session_id: sessionId, status: "completed" });

			const res = await promise;
			const json = await res.json();

			expect(json.session_id).toBeDefined();
			expect(json.from).toBe("a");
			expect(json.to).toBe("b");
		});

		it("returns timeout when no response in time", async () => {
			const fakeWs = { readyState: 1, send() {} };
			const registry = new Map();
			registry.set("b", fakeWs);
			const ctx = makeCtx({ registry: registry as RoutesDeps["registry"] });
			ctx.config.RESPONSE_TIMEOUT_MS = 50;
			const { send } = createRoutes(ctx);

			const res = await send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b",
				body: "hi",
			});
			const json = await res.json();

			expect(json.status).toBe("timeout");
		}, 10000);
	});
});
