import { describe, expect, it } from "vitest";
import { createHoldFollow } from "../gateway/phone/holdFollow.js";
import { PHONE_HOLD_WINDOW_MS } from "../shared/schemasPhoneHold.js";

describe("the Gateway phone hold follow", () => {
	it("keeps the last claim after a null update", () => {
		let now = 10_000;
		const follow = createHoldFollow(() => now);
		const none = follow.answer();
		follow.apply({ holder: "phone-a", label: "Pixel", claimedAt: now, version: 1 });
		const held = follow.answer();
		now += PHONE_HOLD_WINDOW_MS + 23;
		const lapsed = follow.answer();
		follow.apply(null);
		const afterNull = follow.answer();

		expect([none, held, lapsed, afterNull]).toEqual([
			{ kind: "none" },
			{ kind: "held", holder: "phone-a", label: "Pixel", claimedAt: 10_000, remainingMs: PHONE_HOLD_WINDOW_MS },
			{ kind: "lapsed", holder: "phone-a", label: "Pixel", lapsedMs: 23 },
			{ kind: "lapsed", holder: "phone-a", label: "Pixel", lapsedMs: 23 },
		]);
	});

	it("answers lapsed after a null update inside the window", () => {
		const now = 10_000;
		const follow = createHoldFollow(() => now);
		follow.apply({ holder: "phone-a", label: "Pixel", claimedAt: now, version: 1 });
		const held = follow.answer();
		follow.apply(null);
		const swept = follow.answer();
		follow.apply({ holder: "phone-b", label: "Pixel 2", claimedAt: now, version: 2 });
		const reclaimed = follow.answer();

		expect([held, swept, reclaimed]).toEqual([
			{ kind: "held", holder: "phone-a", label: "Pixel", claimedAt: now, remainingMs: PHONE_HOLD_WINDOW_MS },
			{ kind: "lapsed", holder: "phone-a", label: "Pixel", lapsedMs: 0 },
			{ kind: "held", holder: "phone-b", label: "Pixel 2", claimedAt: now, remainingMs: PHONE_HOLD_WINDOW_MS },
		]);
	});
});
