import { describe, expect, it } from "vitest";
import { GatewayCapabilityRefusal } from "../gateway/assistant/gatewayCapabilityRefusal.js";
import { attemptOf, automationActions } from "../gateway/compose/automationActions.js";
import {
	ATTEMPT_WORDS,
	BACKOFF_MIN_MS,
	backoffMs,
	begun,
	claimed,
	clamped,
	dueAt,
	heard,
	isEnded,
	NATURES,
	outOfTime,
	RETRY_FOR_MS,
	recovered,
	retries,
	type Step,
	timedOut,
	unsent,
} from "../gateway/computed/automationSteps.js";
import type { DeviceDriverError } from "../gateway/devices/driver.js";
import type { Effect } from "../gateway/devices/road.js";
import type { IftttTriggerAnswer } from "../shared/schemasPhoneCapabilities.js";

describe("the backoff", () => {
	it("doubles from the shortest gap to its cap, and after a hold waits the gap its answered attempts earned", () => {
		expect([0, 1, 2, 3, 4, 5, 6, 7].map(backoffMs)).toEqual([
			5_000, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000,
		]);
		const held = (answered: number) =>
			dueAt(begun(unsent(claimed({ attempts: answered, startedAt: 0 }, 0), 1_000), 1_000)) - 1_000;
		expect([held(0), held(4)]).toEqual([BACKOFF_MIN_MS, 40_000]);
	});
});

describe("the nature table", () => {
	it("retries by nature and word alone", () => {
		const table = Object.fromEntries(
			NATURES.map((nature) => [nature, ATTEMPT_WORDS.filter((word) => retries(nature, word))]),
		);

		expect(table).toEqual({ sets: ["unreachable", "no_answer"], sends: ["unreachable"], nudges: [] });
	});

	it("ends a step on a word its nature does not retry, and on a retried word once its time is spent", () => {
		const step: Step = { attempts: 1, startedAt: 0, lastAt: 0, claimed: true };
		const verdicts = NATURES.map((nature) =>
			ATTEMPT_WORDS.map((word) => heard(step, nature, word, 1_000).verdict ?? "retry"),
		);

		expect(verdicts).toEqual([
			["done", "failed", "retry", "retry"],
			["done", "failed", "retry", "failed"],
			["done", "failed", "failed", "failed"],
		]);
		expect(heard(step, "sets", "unreachable", RETRY_FOR_MS)).toMatchObject({
			word: "unreachable",
			verdict: "failed",
		});
	});
});

describe("a step out of its time", () => {
	it("ends with the last word it heard, or unreachable after only holds, and never stretches for a clock that went back", () => {
		const held: Step = { attempts: 0, startedAt: 10 * RETRY_FOR_MS };

		expect(timedOut({ attempts: 2, startedAt: 0, word: "no_answer" }).word).toBe("no_answer");
		expect(timedOut({ attempts: 0, startedAt: 0 }).word).toBe("unreachable");
		expect(outOfTime(held, 0)).toBe(false);
		expect(outOfTime(clamped(held, 0), RETRY_FOR_MS)).toBe(true);
	});
});

describe("a step found at a restart", () => {
	const claimed: Step = { attempts: 1, startedAt: 0, lastAt: 0, claimed: true };
	const between: Step = { attempts: 1, startedAt: 0, lastAt: 0, word: "unreachable" };
	const unbegun: Step = { attempts: 0 };

	/** Ended with a word, or when its next attempt goes. */
	const next = (step: Step, now: number) =>
		isEnded(step) ? `${step.verdict} ${step.word}` : dueAt(begun(step, now)) <= now ? "tries now" : "waits";

	it("is judged by nature when claimed, by its time when between attempts, and not at all when unbegun", () => {
		const late = RETRY_FOR_MS + 1;

		expect(NATURES.map((nature) => next(recovered(claimed, nature, 1_000), 1_000))).toEqual([
			"tries now",
			"failed no_answer",
			"failed no_answer",
		]);
		expect(next(recovered(claimed, "sets", late), late)).toBe("failed timeout");
		expect(NATURES.map((nature) => next(recovered(between, nature, 1_000), 1_000))).toEqual([
			"waits",
			"waits",
			"waits",
		]);
		expect(next(recovered(between, "sends", late), late)).toBe("failed timeout");
		expect(next(recovered(unbegun, "nudges", late), late)).toBe("tries now");
	});

	it("gives a step that only held a whole time again from its next turn", () => {
		const late = 3 * RETRY_FOR_MS;
		const again = begun(recovered({ attempts: 0, startedAt: 0, lastAt: 0 }, "sends", late), late);

		expect([outOfTime(again, late + RETRY_FOR_MS - 1), outOfTime(again, late + RETRY_FOR_MS)]).toEqual([
			false,
			true,
		]);
	});
});

describe("a device's answer", () => {
	it("is a word for every decline, no answer once the effect may have landed, and a hold when nothing started", () => {
		const failures: DeviceDriverError[] = [
			{ kind: "unreachable", detail: "" },
			{ kind: "timeout", detail: "", sent: true },
			{ kind: "refused", code: -1, message: "" },
			{ kind: "invalid", detail: "" },
			{ kind: "wrong_device", detail: "" },
		];
		const words = (effect: Effect) => [
			attemptOf({ ok: false, why: { kind: "refused", code: "not_found", effect } }),
			...failures.map((failure) => attemptOf({ ok: false, why: { kind: "failed", failure, effect } })),
		];

		expect([words("none"), words("unknown")]).toEqual([
			[
				{ word: "refused" },
				{ word: "unreachable" },
				{ word: "unreachable" },
				{ word: "refused" },
				{ word: "refused" },
				{ word: "refused" },
			],
			Array(6).fill({ word: "no_answer" }),
		]);
		expect(attemptOf({ ok: true, value: undefined })).toEqual({ word: "done" });
		expect(attemptOf({ ok: false, why: { kind: "notStarted" } })).toHaveProperty("hold");
	});
});

describe("an IFTTT answer", () => {
	const answered = (answer: IftttTriggerAnswer | GatewayCapabilityRefusal) =>
		automationActions({
			devices: () => undefined,
			ifttt: async () => {
				if (answer instanceof GatewayCapabilityRefusal) throw answer;
				return answer;
			},
			vaultReady: () => true,
		}).iftttTrigger({ event: "bell" });

	it("is a word for each way a post ends, and a hold while the vault cannot answer", async () => {
		const words = await Promise.all([
			answered({ ok: true, status: 200 }),
			answered({ ok: false, status: 0 }),
			answered({ ok: false, status: 401 }),
			answered(new GatewayCapabilityRefusal("timeout")),
			answered(new GatewayCapabilityRefusal("not_granted")),
			answered(new GatewayCapabilityRefusal("not_ready")),
			answered(new GatewayCapabilityRefusal("unreachable")),
		]);

		expect(words).toEqual([
			{ word: "done" },
			{ word: "no_answer" },
			{ word: "refused" },
			{ word: "no_answer" },
			{ word: "refused" },
			{ hold: "its service was not ready" },
			{ word: "unreachable" },
		]);
	});
});
