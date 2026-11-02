import { describe, expect, it } from "vitest";
import { createAssistantRoutes } from "../gateway/assistant/assistantRoutes.js";
import { createStatusMemo } from "../gateway/assistant/statusMemo.js";
import { listingText, phoneText } from "../mcp/assistant/actionFront.js";
import type { HoldAnswer } from "../shared/assistant-hold.js";
import {
	ACTION_FRONT_LEGACY_ROUTES,
	ACTION_FRONT_ROUTES,
	ActionListAnswerSchema,
	actionListings,
} from "../shared/schemasActionFront.js";
import { ASSISTANT_ACTION_KEYS } from "../shared/schemasAssistantActions.js";
import { PHONE_CAPABILITY_KEYS } from "../shared/schemasPhoneCapabilities.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

describe("action listings", () => {
	it("lists both registries with params schemas and current phone availability", () => {
		const actions = actionListings(null);

		expect(actions.map(({ id }) => id)).toEqual([
			...PHONE_CAPABILITY_KEYS.map((key) => `phone/${key}`),
			...ASSISTANT_ACTION_KEYS.map((key) => `watcher/${key}`),
		]);
		for (const action of actions) {
			expect(action.params).toMatchObject({ type: "object" });
			expect(action.params.$ref).toBeUndefined();
		}
		expect(actions.find(({ id }) => id === "watcher/github_done")?.params).toMatchObject({
			type: "object",
			required: ["ids"],
		});
		expect(actions.find(({ id }) => id === "phone/ifttt_trigger")).toMatchObject({
			available: null,
			where: "gateway",
			label: "Fire an IFTTT event",
			needs: [],
		});
		expect(actions.find(({ id }) => id === "phone/ifttt_trigger")?.usage).toContain("Runs on the Gateway.");

		const status = new Map([
			["torch", { available: false, reason: "not_supported" as const }],
			["status", { available: true }],
		]);
		const updated = actionListings(status);
		expect(ActionListAnswerSchema.safeParse({ kind: "listed", actions }).success).toBe(true);
		expect(ActionListAnswerSchema.safeParse({ kind: "listed", actions: updated }).success).toBe(true);
		const foreign = { ...actions[0], id: "phone/camera", kind: "guarded", reason: "later" };
		expect(ActionListAnswerSchema.safeParse({ kind: "listed", actions: [foreign] }).success).toBe(true);

		expect(updated.find(({ id }) => id === "phone/torch")).toMatchObject({
			available: false,
			reason: "not_supported",
		});
		expect(updated.find(({ id }) => id === "phone/status")).toMatchObject({ available: true });
	});
});

describe("action routes", () => {
	it("lists for the assistant and routes watcher and phone ids", async () => {
		const dispatched: unknown[] = [];
		const phoneCalls: unknown[] = [];
		let listed = 0;
		const actions = actionListings(null);
		const routes = createAssistantRoutes({
			caller: (req) => (req.headers.get("x-caller") === "assistant" ? "assistant" : "not_assistant"),
			list: async () => [],
			listActions: () => {
				listed += 1;
				return actions;
			},
			dispatch: async (request) => {
				dispatched.push(request);
				return { kind: "ran", answer: { threads: [] }, recorded: true };
			},
			phone: async (request) => {
				phoneCalls.push(request);
				return { kind: "ok", answer: { on: true, levels: 1 } };
			},
			sender: () => null,
			guard: {} as never,
			hold: () => ({ kind: "not_assistant" }),
			ambient: fakeAmbient(),
		});
		const invoke = (path: string, body: unknown, caller = "assistant") => {
			const route = routes.get(path);
			if (!route) throw new Error(`missing route ${path}`);
			return route(new Request("http://gateway/", { headers: { "x-caller": caller } }), body);
		};

		const watcher = await invoke(ACTION_FRONT_ROUTES.run, {
			id: "watcher/github_done",
			callId: "watcher-call-1",
			params: { ids: ["1"] },
		});
		expect(await watcher.json()).toEqual({ kind: "ok", answer: { threads: [] }, recorded: true });
		expect(dispatched).toEqual([{ action: "github_done", callId: "watcher-call-1", params: { ids: ["1"] } }]);

		const phone = await invoke(ACTION_FRONT_ROUTES.run, {
			id: "phone/torch",
			callId: "phone-call-1",
			params: { on: true },
		});
		expect(await phone.json()).toEqual({
			kind: "ok",
			answer: { on: true, levels: 1 },
		});
		expect(phoneCalls).toEqual([{ key: "torch", callId: "phone-call-1", params: { on: true } }]);

		const unknown = await invoke(ACTION_FRONT_ROUTES.run, {
			id: "phone/missing",
			callId: "unknown-call-1",
			params: {},
		});
		expect(unknown.status).toBe(400);

		const refused = await invoke(
			ACTION_FRONT_ROUTES.run,
			{ id: "watcher/github_done", callId: "stranger-call-1", params: { ids: ["1"] } },
			"stranger",
		);
		expect(await refused.json()).toEqual({ kind: "not_assistant" });

		const answer = await invoke(ACTION_FRONT_ROUTES.list, {}, "assistant");
		expect(await answer.json()).toEqual({ kind: "listed", actions });
		const hidden = await invoke(ACTION_FRONT_ROUTES.list, {}, "stranger");
		expect(await hidden.json()).toEqual({ kind: "not_assistant" });
		expect(listed).toBe(1);

		const oldWatcher = await invoke(ACTION_FRONT_LEGACY_ROUTES.action, {
			action: "github_done",
			callId: "watcher-call-2",
			params: { ids: ["2"] },
		});
		expect(await oldWatcher.json()).toEqual({ kind: "ran", answer: { threads: [] }, recorded: true });
		const oldPhone = await invoke(ACTION_FRONT_LEGACY_ROUTES.phone, {
			key: "torch",
			callId: "phone-call-2",
			params: {},
		});
		expect(await oldPhone.json()).toMatchObject({ kind: "ok" });
		expect(dispatched).toHaveLength(2);
		expect(phoneCalls).toHaveLength(2);
	});
});

describe("status memo", () => {
	it("answers only while the status holder still holds, and folds later answers per key", () => {
		const held = (holder: string): HoldAnswer => ({
			kind: "held",
			holder,
			label: holder,
			claimedAt: 1,
			remainingMs: 1,
		});
		let hold: HoldAnswer = held("phone-a");
		const memo = createStatusMemo(() => hold);
		const status = (holder: string | null) => ({
			kind: "ok" as const,
			answer: { holder, keys: [{ key: "torch", available: true, needs: [] }] },
		});

		memo.note("status", status("Phone A"));
		expect([...(memo.read() ?? [])]).toEqual([["torch", { available: true }]]);
		memo.note("torch", { kind: "unavailable", reason: "disabled" });
		expect(memo.read()?.get("torch")).toEqual({ available: false, reason: "disabled" });
		memo.note("torch", { kind: "ok", answer: { on: true, levels: 1 } });
		expect(memo.read()?.get("torch")).toEqual({ available: true });

		hold = held("phone-b");
		expect(memo.read()).toBeNull();
		hold = { kind: "lapsed", holder: "phone-a", label: "Phone A", lapsedMs: 1 };
		expect(memo.read()).toBeNull();

		hold = held("phone-a");
		memo.note("status", status(null));
		expect(memo.read()).toBeNull();
		memo.note("status", status("Phone A"));
		memo.note("torch", { kind: "unavailable", reason: "no_holder" });
		expect(memo.read()).toBeNull();
	});
});

describe("action text", () => {
	it("shows unavailable reasons, needs, and details on single lines", () => {
		const actions = actionListings(new Map([["torch", { available: false, reason: "not_supported" }]]));
		const listing = listingText(actions);
		const availability = listing.split("\n").find((line) => line.includes("unavailable"));

		expect(availability).toContain("not_supported");
		expect(listing).toContain("notifications");
		const denied = phoneText(
			{ kind: "unavailable", reason: "not_granted", needs: ["contacts"], detail: "Allow contacts" },
			undefined,
		);
		expect(denied.split("\n")).toHaveLength(1);
		for (const part of ["not_granted", "contacts", "Allow contacts"]) expect(denied).toContain(part);
	});
});
