import { describe, expect, it } from "vitest";
import { createHoldFollow } from "../gateway/phone/holdFollow.js";
import { PHONE_HOLD_WINDOW_MS } from "../shared/schemasPhoneHold.js";

describe("the Gateway phone hold follow", () => {
	it("answers none, held, lapsed, and cleared records from its current copy", () => {
		let now = 10_000;
		const follow = createHoldFollow(() => now);
		const none = follow.answer();
		follow.apply({ holder: "phone-a", label: "Pixel", claimedAt: now, version: 1 });
		const held = follow.answer();
		now += PHONE_HOLD_WINDOW_MS + 23;
		const lapsed = follow.answer();
		follow.apply(null);
		const cleared = follow.answer();

		expect([none, held, lapsed, cleared]).toEqual([
			{ kind: "none" },
			{ kind: "held", holder: "phone-a", label: "Pixel", claimedAt: 10_000, remainingMs: PHONE_HOLD_WINDOW_MS },
			{ kind: "lapsed", holder: "phone-a", label: "Pixel", lapsedMs: 23 },
			{ kind: "none" },
		]);
	});
});
