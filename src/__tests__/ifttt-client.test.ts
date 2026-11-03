import { describe, expect, it } from "vitest";
import { createIftttClient } from "../gateway/assistant/iftttClient.js";
import { createPhoneDispatch } from "../gateway/assistant/phoneDispatch.js";
import type { VaultRelease } from "../gateway/vault/vaultUse.js";
import {
	type IftttTriggerAnswer,
	type IftttTriggerRequest,
	PHONE_CAPABILITIES,
} from "../shared/schemasPhoneCapabilities.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const params: IftttTriggerRequest = { event: "owner_event", value1: "one", value2: "two", value3: "three" };

function client(options: {
	ambient?: ReturnType<typeof fakeAmbient>;
	entryId?: string;
	readForWatcher?: () => Promise<VaultRelease>;
	fetch: (url: string, init: RequestInit) => Promise<Response>;
}) {
	return createIftttClient({
		fetch: options.fetch,
		vault: {
			entryId: () => options.entryId,
			readForWatcher: options.readForWatcher ?? (async () => ({ kind: "released", value: "webhook-key" })),
		},
		ambient: options.ambient ?? fakeAmbient({ drive: "manual" }),
	});
}

function dispatchFor(
	trigger: (request: IftttTriggerRequest) => Promise<IftttTriggerAnswer>,
	ambient = fakeAmbient({ drive: "manual" }),
) {
	return createPhoneDispatch({
		ambient,
		approveEverySend: () => false,
		hold: () => ({
			kind: "held",
			holder: "phone-a",
			label: "Phone",
			claimedAt: 0,
			remainingMs: 60_000,
		}),
		phone: {
			open: async () => {
				throw new Error("unexpected phone request");
			},
		} as never,
		act: {
			run: async () => {
				throw new Error("unexpected phone act");
			},
		} as never,
		gateways: {
			ifttt_trigger: trigger,
		},
	});
}

describe("IFTTT trigger client", () => {
	it("validates event path segments and value sizes", () => {
		const request = PHONE_CAPABILITIES.ifttt_trigger.request;

		expect(request.safeParse(params).success).toBe(true);
		expect(request.safeParse({ event: "bad/event" }).success).toBe(false);
		expect(request.safeParse({ event: "x".repeat(81) }).success).toBe(false);
		expect(request.safeParse({ event: "okay", value1: "x".repeat(501) }).success).toBe(false);
	});

	it("posts the event and values, then answers the HTTP status", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const trigger = client({
			entryId: "webhook-entry",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return new Response(null, { status: 200 });
			},
		});
		const dispatch = dispatchFor((request) => trigger.trigger(request));

		const answer = await dispatch({ key: "ifttt_trigger", callId: "ifttt-call-200", params });

		expect(answer).toMatchObject({ kind: "ok", answer: { status: 200, ok: true } });
		expect(new URL(calls[0]!.url).pathname.split("/")).toEqual([
			"",
			"trigger",
			"owner_event",
			"with",
			"key",
			"webhook-key",
		]);
		expect(calls[0]!.init.method).toBe("POST");
		expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ value1: "one", value2: "two", value3: "three" });
	});

	it("answers a rejected HTTP status without exposing the key", async () => {
		const trigger = client({
			entryId: "webhook-entry",
			fetch: async () => new Response(null, { status: 401 }),
		});

		expect(await trigger.trigger(params)).toEqual({ status: 401, ok: false });
	});

	it("answers not granted without posting", async () => {
		let reads = 0;
		let posts = 0;
		const trigger = client({
			entryId: "webhook-entry",
			readForWatcher: async () => {
				reads += 1;
				return { kind: "unusable", reason: "no grant", status: 403 };
			},
			fetch: async () => {
				posts += 1;
				return new Response(null, { status: 200 });
			},
		});
		const dispatch = dispatchFor((request) => trigger.trigger(request));

		const answer = await dispatch({ key: "ifttt_trigger", callId: "ifttt-call-none", params });

		expect(answer).toEqual({ kind: "unavailable", reason: "not_granted" });
		expect(reads).toBe(1);
		expect(posts).toBe(0);
	});

	it.each(["unready", "unopened"] as const)("answers vault %s as not ready", async (kind) => {
		const trigger = client({
			entryId: "webhook-entry",
			readForWatcher: async () =>
				kind === "unready" ? { kind: "unready", reason: "Router unavailable" } : { kind: "unopened" },
			fetch: async () => {
				throw new Error("unexpected post");
			},
		});
		const dispatch = dispatchFor((request) => trigger.trigger(request));

		expect(await dispatch({ key: "ifttt_trigger", callId: `ifttt-call-${kind}`, params })).toEqual({
			kind: "unavailable",
			reason: "not_ready",
		});
	});

	it("posts without a phone hold, since the grant is the authority", async () => {
		let posts = 0;
		const trigger = client({
			entryId: "webhook-entry",
			fetch: async () => {
				posts += 1;
				return new Response(null, { status: 200 });
			},
		});
		const dispatch = createPhoneDispatch({
			ambient: fakeAmbient({ drive: "manual" }),
			approveEverySend: () => false,
			hold: () => ({ kind: "none" }),
			phone: {
				open: async () => {
					throw new Error("unexpected phone request");
				},
			} as never,
			act: {
				run: async () => {
					throw new Error("unexpected phone act");
				},
			} as never,
			gateways: {
				ifttt_trigger: (request) => trigger.trigger(request),
			},
		});

		expect(await dispatch({ key: "ifttt_trigger", callId: "ifttt-call-no-hold", params })).toMatchObject({
			kind: "ok",
			answer: { status: 200, ok: true },
		});
		expect(posts).toBe(1);
	});

	it("answers timeout when the post exceeds its bound", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => 10_000 });
		let started!: () => void;
		const requestStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const trigger = client({
			ambient,
			entryId: "webhook-entry",
			fetch: async (_url, init) => {
				started();
				return new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
						once: true,
					});
				});
			},
		});
		const dispatch = dispatchFor((request) => trigger.trigger(request), ambient);
		const answer = dispatch({ key: "ifttt_trigger", callId: "ifttt-call-timeout", params });

		await requestStarted;
		await ambient.advance(15_000);

		expect(await answer).toEqual({ kind: "unavailable", reason: "timeout" });
	});
});
