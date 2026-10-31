import { describe, expect, it } from "vitest";
// @ts-expect-error - plain JS, no .d.ts
import threadFollow from "../../android/app/src/main/assets/thread/thread-follow.js";

const { followTarget, slideProgress, SLIDE_MS } = threadFollow as {
	followTarget: (input: {
		parked: boolean;
		spanPx: number;
		firstTopPx: number;
		viewportPx: number;
		scrollHeightPx: number;
	}) => { scrollTop: number; follow: boolean } | null;
	slideProgress: (elapsedMs: number) => number;
	SLIDE_MS: number;
};

describe("thread follow", () => {
	const base = { parked: true, viewportPx: 1000, scrollHeightPx: 6000, firstTopPx: 4800 };

	it("holds when the reader was not parked at the bottom", () => {
		expect(followTarget({ ...base, parked: false, spanPx: 200 })).toBeNull();
	});

	it("follows to the bottom when the new rows fit the viewport", () => {
		expect(followTarget({ ...base, spanPx: 1000 })).toEqual({ scrollTop: 5000, follow: true });
		expect(followTarget({ ...base, spanPx: 1008 })).toEqual({ scrollTop: 5000, follow: true });
	});

	it("lands a taller message's top at 5% of the viewport and stops following", () => {
		expect(followTarget({ ...base, spanPx: 1009, firstTopPx: 3000 })).toEqual({ scrollTop: 2950, follow: false });
	});

	it("never scrolls past either end", () => {
		expect(followTarget({ ...base, spanPx: 3000, firstTopPx: 20 })).toEqual({ scrollTop: 0, follow: false });
		expect(followTarget({ ...base, scrollHeightPx: 800, spanPx: 100 })).toEqual({ scrollTop: 0, follow: true });
	});

	it("slides over 0.3 s, eased, and settles at the end", () => {
		expect(SLIDE_MS).toBe(300);
		expect(slideProgress(0)).toBe(0);
		expect(slideProgress(150)).toBeCloseTo(0.5, 5);
		expect(slideProgress(300)).toBe(1);
		expect(slideProgress(900)).toBe(1);
	});
});
