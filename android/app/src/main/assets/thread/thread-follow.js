// Following new rows. Pure; thread-follow.test.ts.
(function (root, factory) {
	const api = factory();
	if (typeof window !== "undefined") root.threadFollow = api;
	if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis, function () {
	const TOLERANCE_PX = 8;
	const PARKED_PX = 4;
	const TOP_FRACTION = 0.05;
	const SLIDE_MS = 300;

	function parkedAtBottom(input) {
		const { scrollTop, viewportPx, scrollHeightPx } = input;
		return scrollHeightPx - scrollTop - viewportPx <= PARKED_PX;
	}

	/** Tall spans use 5%. */
	function followTarget(input) {
		const { parked, spanPx, firstTopPx, viewportPx, scrollHeightPx } = input;
		if (!parked) return null;
		const bottom = Math.max(0, scrollHeightPx - viewportPx);
		if (spanPx <= viewportPx + TOLERANCE_PX) return { scrollTop: bottom, follow: true };
		const top = Math.max(0, Math.min(bottom, firstTopPx - viewportPx * TOP_FRACTION));
		return { scrollTop: top, follow: false };
	}

	/** Cubic easing. */
	function slideProgress(elapsedMs) {
		const t = Math.max(0, Math.min(1, elapsedMs / SLIDE_MS));
		return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
	}

	return { followTarget, parkedAtBottom, slideProgress, SLIDE_MS, TOLERANCE_PX, PARKED_PX, TOP_FRACTION };
});
