// Following new rows. Pure; thread-follow.test.ts.
(function (root, factory) {
	const api = factory();
	if (typeof window !== "undefined") root.threadFollow = api;
	if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis, function () {
	const TOLERANCE_PX = 8;
	const TOP_FRACTION = 0.05;
	const SLIDE_MS = 300;

	/** Fit follows; taller lands at 5%. */
	function followTarget(input) {
		const { parked, spanPx, firstTopPx, viewportPx, scrollHeightPx } = input;
		if (!parked) return null;
		const bottom = Math.max(0, scrollHeightPx - viewportPx);
		if (spanPx <= viewportPx + TOLERANCE_PX) return { scrollTop: bottom, follow: true };
		const top = Math.max(0, Math.min(bottom, firstTopPx - viewportPx * TOP_FRACTION));
		return { scrollTop: top, follow: false };
	}

	/** Ease in and out over the slide. */
	function slideProgress(elapsedMs) {
		const t = Math.max(0, Math.min(1, elapsedMs / SLIDE_MS));
		return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
	}

	return { followTarget, slideProgress, SLIDE_MS, TOLERANCE_PX, TOP_FRACTION };
});
