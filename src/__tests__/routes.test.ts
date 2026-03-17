import { describe, expect, it } from "vitest";
import { createRoutes, type RoutesDeps } from "../arbiter/routes.js";
import { Mutex } from "../shared/mutex.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import type { ResponsePayload } from "../shared/types.js";

function makeCtx(overrides: Partial<RoutesDeps> = {}): RoutesDeps {
	const registry = overrides.registry || (new Map() as RoutesDeps["registry"]);
	const store = overrides.store || new PendingJobStore<ResponsePayload>();
	const targetLocks = new Map<string, Mutex>();
	const getMutexFn = ((team: string) => {
		if (!targetLocks.has(team)) targetLocks.set(team, new Mutex());
		return targetLocks.get(team)!;
	}) as RoutesDeps["getMutex"];
	getMutexFn.peek = (team: string) => targetLocks.get(team);
	return {
		registry,
		store,
		getMutex: getMutexFn,
		config: { LOG_PATH: "/tmp/test-debug.log", RESPONSE_TIMEOUT_MS: 500 },
	};
}

describe("routes", () => {
	describe("/pending", () => {
		it("returns empty array when no jobs", async () => {
			const ctx = makeCtx();
			const { pending } = createRoutes(ctx);
			const res = pending();
			expect(await res.json()).toEqual([]);
		});

		it("returns session_id, from, to, state for each pending job", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("sess-1", "a", "b");
			const ctx = makeCtx({ store });
			const { pending } = createRoutes(ctx);
			const res = pending();
			expect(await res.json()).toEqual([{ session_id: "sess-1", from: "a", to: "b", state: "waiting" }]);
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

		it("returns 404 when no pending job", async () => {
			const ctx = makeCtx();
			const { respond } = createRoutes(ctx);
			const res = respond(new Request("http://localhost/respond", { method: "POST" }), { session_id: "nope" });
			expect(res.status).toBe(404);
		});

		it("delivers result to waiting job and returns delivered", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("sess-1", "a", "b");

			let waitResult: unknown = null;
			const waitPromise = store.waitForResult("sess-1", 10_000).then((r) => {
				waitResult = r;
			});

			const ctx = makeCtx({ store });
			const { respond } = createRoutes(ctx);
			const res = respond(new Request("http://localhost/respond", { method: "POST" }), {
				session_id: "sess-1",
				status: "completed",
				response: "done",
			});

			await waitPromise;
			expect(await res.json()).toEqual({ delivered: true });
			expect(waitResult).toEqual({ delivered: true, result: { status: "completed", response: "done" } });
		});
	});

	describe("/poll", () => {
		it("returns 400 when session_id missing", async () => {
			const ctx = makeCtx();
			const { poll } = createRoutes(ctx);
			const res = poll(new Request("http://localhost/poll", { method: "POST" }), {});
			expect(res.status).toBe(400);
		});

		it("returns 404 when no pending job", async () => {
			const ctx = makeCtx();
			const { poll } = createRoutes(ctx);
			const res = poll(new Request("http://localhost/poll", { method: "POST" }), { session_id: "nope" });
			expect(res.status).toBe(404);
		});

		it("returns running when job is timed out but no result yet", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("sess-1", "a", "b");
			await store.waitForResult("sess-1", 1); // 1ms timeout
			await new Promise((r) => setTimeout(r, 10)); // let timeout fire

			const ctx = makeCtx({ store });
			const { poll } = createRoutes(ctx);
			const res = poll(new Request("http://localhost/poll", { method: "POST" }), { session_id: "sess-1" });
			const json = await res.json();
			expect(json.status).toBe("running");
		});

		it("returns stored result after late delivery", async () => {
			const store = new PendingJobStore<ResponsePayload>();
			store.create("sess-1", "a", "b");
			await store.waitForResult("sess-1", 1);
			await new Promise((r) => setTimeout(r, 10));

			store.deliver("sess-1", { session_id: "sess-1", status: "completed", response: "late answer" });

			const ctx = makeCtx({ store });
			const { poll } = createRoutes(ctx);
			const res = poll(new Request("http://localhost/poll", { method: "POST" }), { session_id: "sess-1" });
			const json = await res.json();
			expect(json.status).toBe("completed");
			expect(json.response).toBe("late answer");
		});
	});

	describe("/health", () => {
		it("returns ok with counts", async () => {
			const registry = new Map();
			registry.set("a", {});
			const store = new PendingJobStore<ResponsePayload>();
			store.create("s1", "a", "b");
			const ctx = makeCtx({ registry: registry as RoutesDeps["registry"], store });
			const { health } = createRoutes(ctx);
			const res = health();
			expect(await res.json()).toEqual({ ok: true, teams: 1, pending_jobs: 1 });
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

		it("sends inject payload and returns response when delivered inline", async () => {
			const sent: Record<string, unknown>[] = [];
			const fakeWs = {
				readyState: 1,
				send(data: string) {
					sent.push(JSON.parse(data));
				},
			};
			const registry = new Map();
			registry.set("b", fakeWs);
			const store = new PendingJobStore<ResponsePayload>();
			const ctx = makeCtx({ registry: registry as RoutesDeps["registry"], store });
			const { send } = createRoutes(ctx);

			const promise = send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b",
				type: "question",
				body: "hi",
			});

			await new Promise((r) => setTimeout(r, 10));

			// Deliver via the store (simulating /respond)
			const jobs = store.listAll();
			expect(jobs.length).toBe(1);
			store.deliver(jobs[0].id, { session_id: jobs[0].id, status: "completed", response: "answer" });

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
			const store = new PendingJobStore<ResponsePayload>();
			const ctx = makeCtx({ registry: registry as RoutesDeps["registry"], store });
			const { send } = createRoutes(ctx);

			const promise = send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b",
				body: "hi",
				debug: true,
			});
			await new Promise((r) => setTimeout(r, 10));

			const jobs = store.listAll();
			store.deliver(jobs[0].id, { session_id: jobs[0].id, status: "completed" });

			const res = await promise;
			const json = await res.json();

			expect(json.session_id).toBeDefined();
			expect(json.from).toBe("a");
			expect(json.to).toBe("b");
		});

		it("returns running when no response in time", async () => {
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

			expect(json.status).toBe("running");
			expect(json.session_id).toBeDefined();
		}, 10000);

		it("late delivery is stored and pollable after timeout", async () => {
			const fakeWs = { readyState: 1, send() {} };
			const registry = new Map();
			registry.set("b", fakeWs);
			const store = new PendingJobStore<ResponsePayload>();
			const ctx = makeCtx({ registry: registry as RoutesDeps["registry"], store });
			ctx.config.RESPONSE_TIMEOUT_MS = 50;
			const routes = createRoutes(ctx);

			const sendRes = await routes.send(new Request("http://localhost/send", { method: "POST" }), {
				from: "a",
				to: "b",
				body: "hi",
			});
			const sendJson = await sendRes.json();
			expect(sendJson.status).toBe("running");

			// Late delivery
			store.deliver(sendJson.session_id, {
				session_id: sendJson.session_id,
				status: "completed",
				response: "late answer",
			});

			// Poll should return the stored result
			const pollRes = routes.poll(new Request("http://localhost/poll", { method: "POST" }), {
				session_id: sendJson.session_id,
			});
			const pollJson = await pollRes.json();
			expect(pollJson.status).toBe("completed");
			expect(pollJson.response).toBe("late answer");
		}, 10000);
	});
});
