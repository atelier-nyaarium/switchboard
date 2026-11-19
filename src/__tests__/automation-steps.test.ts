import { describe, expect, it } from "vitest";
import { GatewayCapabilityRefusal } from "../gateway/assistant/gatewayCapabilityRefusal.js";
import { automationActions, deviceAttempt } from "../gateway/compose/automationActions.js";
import {
	ATTEMPT_WORDS,
	attemptDue,
	BACKOFF_MIN_MS,
	backoffMs,
	begun,
	clamped,
	heard,
	isEnded,
	KEEP_TRYING_MS,
	NATURES,
	outOfTime,
	recovered,
	retries,
	type Step,
	timedOut,
} from "../gateway/computed/automationSteps.js";
import { DEVICE_REFUSAL_CODES } from "../shared/schemasDevices.js";
import type { IftttTriggerAnswer } from "../shared/schemasPhoneCapabilities.js";

describe("the backoff", () => {
	it("doubles from the shortest gap to its cap, and waits the shortest gap after a hold", () => {
		expect([0, 1, 2, 3, 4, 5, 6, 7].map(backoffMs)).toEqual([
			5_000, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000,
		]);
		const afterHold: Step = { attempts: 0, startedAt: 0, lastAt: 0 };
		expect([attemptDue(afterHold, BACKOFF_MIN_MS - 1), attemptDue(afterHold, BACKOFF_MIN_MS)]).toEqual([
			false,
			true,
		]);
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
		expect(heard(step, "sets", "unreachable", KEEP_TRYING_MS)).toMatchObject({
			word: "unreachable",
			verdict: "failed",
		});
	});
});

describe("a step out of its time", () => {
	it("ends with the last word it heard, or unreachable after only holds, and never stretches for a clock that went back", () => {
		const held: Step = { attempts: 0, startedAt: 10 * KEEP_TRYING_MS };

		expect(timedOut({ attempts: 2, startedAt: 0, word: "no_answer" }).word).toBe("no_answer");
		expect(timedOut({ attempts: 0, startedAt: 0 }).word).toBe("unreachable");
		expect(outOfTime(held, 0)).toBe(false);
		expect(outOfTime(clamped(held, 0), KEEP_TRYING_MS)).toBe(true);
	});
});

describe("a step found at a restart", () => {
	const claimed: Step = { attempts: 1, startedAt: 0, lastAt: 0, claimed: true };
	const between: Step = { attempts: 1, startedAt: 0, lastAt: 0, word: "unreachable" };
	const unbegun: Step = { attempts: 0 };

	/** Ended with a word, or when its next attempt goes. */
	const next = (step: Step, now: number) =>
		isEnded(step) ? `${step.verdict} ${step.word}` : attemptDue(step, now) ? "tries now" : "waits";

	it("is judged by nature when claimed, by its time when between attempts, and not at all when unbegun", () => {
		const late = KEEP_TRYING_MS + 1;

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
		const late = 3 * KEEP_TRYING_MS;
		const again = begun(recovered({ attempts: 0, startedAt: 0, lastAt: 0 }, "sends", late), late);

		expect([outOfTime(again, late + KEEP_TRYING_MS - 1), outOfTime(again, late + KEEP_TRYING_MS)]).toEqual([
			false,
			true,
		]);
	});
});

describe("a device's answer", () => {
	it("is a word for every refusal code, and no answer once the effect may have landed", () => {
		const words = DEVICE_REFUSAL_CODES.map((code) => [
			code,
			deviceAttempt({ kind: "refused", refusal: { code, effect: "none" } }),
			deviceAttempt({ kind: "refused", refusal: { code, effect: "unknown" } }),
		]);

		expect(words).toEqual([
			["not_found", { word: "refused" }, { word: "no_answer" }],
			["stale", { word: "refused" }, { word: "no_answer" }],
			["exists", { word: "refused" }, { word: "no_answer" }],
			["full", { word: "refused" }, { word: "no_answer" }],
			["invalid", { word: "refused" }, { word: "no_answer" }],
			["wrong_device", { word: "refused" }, { word: "no_answer" }],
			["not_supported", { word: "refused" }, { word: "no_answer" }],
			["toggle_unknown", { word: "refused" }, { word: "no_answer" }],
			["unreachable", { word: "unreachable" }, { word: "no_answer" }],
			["timeout", { word: "unreachable" }, { word: "no_answer" }],
			["device_error", { word: "refused" }, { word: "no_answer" }],
			["write_failed", { word: "refused" }, { word: "no_answer" }],
			["daemon_away", { word: "unreachable" }, { word: "no_answer" }],
			["scan_failed", { word: "unreachable" }, { word: "no_answer" }],
			["no_radio", { word: "unreachable" }, { word: "no_answer" }],
		]);
		expect(deviceAttempt("not_started")).toHaveProperty("hold");
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
