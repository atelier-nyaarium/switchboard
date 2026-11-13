import { describe, expect, it } from "vitest";
import { createSessionRegistryReporter, SESSION_REGISTRY_RETRY_MS } from "../gateway/router/sessionRegistryReporter.js";
import { processAmbient } from "../shared/ambient.js";
import { SessionStore } from "../shared/session-store.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const flush = () => new Promise((resolve) => queueMicrotask(resolve));

describe("session registry reporter", () => {
	it("reports a minted session once", async () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: () => "one" });
		const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action, params) => sent.push({ action, params }),
			incarnation: () => 3,
			localGatewayId: "gateway",
			ambient: fakeAmbient({ drive: "manual" }),
		});
		reporter.attach();
		store.mint({ spawn: "host", harness: "claude", sessionLabel: "Work" });
		await flush();

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ action: "session_upsert", params: { sessionId: "host.one", label: "Work" } });
	});

	it("reports a swept session by its spawn id", async () => {
		let now = 100;
		const store = new SessionStore({ ambient: { now: () => now }, idGen: () => "one" });
		const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action, params) => sent.push({ action, params }),
			incarnation: () => 3,
			localGatewayId: "gateway",
			ambient: fakeAmbient({ drive: "manual" }),
		});
		reporter.attach();
		store.mint({ spawn: "host", harness: "claude" });
		now = 200;
		for (const team of store.sweepable(50)) store.forget(team);
		await flush();

		expect(sent.at(-1)).toMatchObject({ action: "session_forget", params: { sessionId: "host.one" } });
	});

	it("reports a forgotten session after reconnecting", async () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: () => "one" });
		const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
		let incarnation: number | null = 3;
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action, params) => sent.push({ action, params }),
			incarnation: () => incarnation,
			localGatewayId: "gateway",
			ambient: fakeAmbient({ drive: "manual" }),
		});
		reporter.attach();
		const record = store.mint({ spawn: "host", harness: "claude" });
		await flush();
		incarnation = null;
		store.forget(store.teamOf(record));
		incarnation = 4;
		reporter.reconcile();
		await flush();

		expect(sent.filter((entry) => entry.action === "session_forget")).toHaveLength(1);
	});

	it("reports a forget the Router had not confirmed again after a restart, until it is taken", async () => {
		const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
		const make = (store: SessionStore, taken: boolean) =>
			createSessionRegistryReporter({
				sessionStore: store,
				send: async (action, params) => {
					sent.push({ action, params });
					return taken ? { result: { ok: true } } : { result: { ok: false } };
				},
				incarnation: () => 3,
				localGatewayId: "gateway",
				ambient: fakeAmbient({ drive: "manual" }),
			});
		const store = new SessionStore({ ambient: processAmbient(), idGen: () => "one" });
		const first = make(store, false);
		first.attach();
		const record = store.mint({ spawn: "host", harness: "claude" });
		store.forget(store.teamOf(record));
		await flush();
		const saved = JSON.parse(JSON.stringify(first.pendingForgets())) as unknown;
		expect(saved).toEqual(["host.one"]);

		const second = make(new SessionStore({ ambient: processAmbient() }), true);
		second.restoreForgets(saved);
		sent.length = 0;
		second.reconcile();
		await flush();

		expect(sent).toMatchObject([{ action: "session_forget", params: { sessionId: "host.one" } }]);
		expect(second.pendingForgets()).toEqual([]);
	});

	it("retries a rejected tombstone", async () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: () => "one" });
		const sent: string[] = [];
		let incarnation: number | null = 3;
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action) => {
				sent.push(action);
				return { result: { ok: false, error: "x" } };
			},
			incarnation: () => incarnation,
			localGatewayId: "gateway",
			ambient: fakeAmbient({ drive: "manual" }),
		});
		reporter.attach();
		incarnation = null;
		const record = store.mint({ spawn: "host", harness: "claude" });
		store.forget(store.teamOf(record));
		incarnation = 4;
		reporter.reconcile();
		await flush();
		reporter.reconcile();
		await flush();

		expect(sent.filter((action) => action === "session_forget")).toHaveLength(2);
	});

	it("lands a pending forget before the upsert of a session created again under its name", async () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: () => "one" });
		const ambient = fakeAmbient({ drive: "manual" });
		const sent: string[] = [];
		let incarnation: number | null = 3;
		let taken = false;
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action) => {
				sent.push(action);
				return { result: { ok: action !== "session_forget" || taken } };
			},
			incarnation: () => incarnation,
			localGatewayId: "gateway",
			ambient,
		});
		reporter.attach();
		incarnation = null;
		const record = store.mint({ spawn: "host", harness: "claude" });
		store.forget(store.teamOf(record));
		store.mint({ spawn: "host", harness: "claude" });
		incarnation = 4;
		reporter.reconcile();
		await flush();

		expect(sent).toEqual(["session_forget"]);
		expect(reporter.pendingForgets()).toEqual(["host.one"]);

		taken = true;
		await ambient.advance(SESSION_REGISTRY_RETRY_MS);
		await flush();

		expect(sent).toEqual(["session_forget", "session_forget", "session_upsert"]);
		expect(reporter.pendingForgets()).toEqual([]);
	});

	it("reconcile reports records that vanished", async () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: () => "one" });
		const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action, params) => sent.push({ action, params }),
			incarnation: () => 3,
			localGatewayId: "gateway",
			ambient: fakeAmbient({ drive: "manual" }),
		});
		const record = store.mint({ spawn: "host", harness: "claude" });
		reporter.reconcile();
		store.forget(store.teamOf(record));
		reporter.reconcile();
		await flush();

		expect(sent.at(-1)).toMatchObject({ action: "session_forget", params: { sessionId: "host.one" } });
	});

	it("defers the baseline until an incarnation exists", async () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: () => "one" });
		const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
		let incarnation: number | null = null;
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action, params) => sent.push({ action, params }),
			incarnation: () => incarnation,
			localGatewayId: "gateway",
			ambient: fakeAmbient({ drive: "manual" }),
		});
		reporter.attach();
		store.mint({ spawn: "host", harness: "claude" });
		await flush();
		expect(sent).toHaveLength(0);
		incarnation = 4;
		reporter.reconcile();
		await flush();

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ action: "session_upsert", params: { sessionId: "host.one", incarnation: 4 } });
	});

	it("re-sends an upsert the Router refused once the window lifts", async () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: () => "one" });
		const ambient = fakeAmbient({ drive: "manual" });
		const sent: string[] = [];
		let fenced = true;
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action) => {
				sent.push(action);
				return fenced ? { result: { outcome: "refused", reason: "migrating" } } : { result: { ok: true } };
			},
			incarnation: () => 3,
			localGatewayId: "gateway",
			ambient,
		});
		reporter.attach();
		store.mint({ spawn: "host", harness: "claude" });
		await flush();
		fenced = false;
		await ambient.advance(SESSION_REGISTRY_RETRY_MS);
		await ambient.advance(SESSION_REGISTRY_RETRY_MS);

		expect(sent).toEqual(["session_upsert", "session_upsert"]);
	});

	it("re-sends a forget the Router refused, and not the upsert it replaced", async () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: () => "one" });
		const ambient = fakeAmbient({ drive: "manual" });
		const sent: string[] = [];
		let fenced = true;
		const reporter = createSessionRegistryReporter({
			sessionStore: store,
			send: async (action) => {
				sent.push(action);
				return fenced ? { result: { outcome: "refused", reason: "migrating" } } : { result: { ok: true } };
			},
			incarnation: () => 3,
			localGatewayId: "gateway",
			ambient,
		});
		reporter.attach();
		const record = store.mint({ spawn: "host", harness: "claude" });
		await flush();
		store.forget(store.teamOf(record));
		await flush();
		fenced = false;
		await ambient.advance(SESSION_REGISTRY_RETRY_MS);
		await ambient.advance(SESSION_REGISTRY_RETRY_MS);

		expect(sent).toEqual(["session_upsert", "session_forget", "session_forget"]);
	});
});
