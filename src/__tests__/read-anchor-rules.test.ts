import { describe, expect, it } from "vitest";
import { MAX_STREAMS_PER_OWNER, mergeReadAnchor } from "../shared/read-anchor-rules.js";

const entry = (epoch: number, seq: number, at = 1) => ({ epoch, seq, at });

describe("read anchor rules", () => {
	it("accepts a newer sequence in the same epoch", () => {
		const result = mergeReadAnchor({ owner: { stream: entry(1, 9) } }, "owner", "stream", entry(1, 10));
		expect(result.advanced).toBe(true);
	});

	it("refuses an older sequence in the same epoch", () => {
		const result = mergeReadAnchor({ owner: { stream: entry(1, 9) } }, "owner", "stream", entry(1, 8));
		expect(result.advanced).toBe(false);
	});

	it("accepts a re-minted mailbox whose epoch is numerically smaller", () => {
		const result = mergeReadAnchor({ owner: { stream: entry(900, 9, 5) } }, "owner", "stream", entry(7, 0, 6));
		expect(result.advanced).toBe(true);
	});

	it("refuses a report older than the stored anchor across a re-mint", () => {
		const result = mergeReadAnchor({ owner: { stream: entry(7, 0, 6) } }, "owner", "stream", entry(900, 9, 5));
		expect(result.advanced).toBe(false);
	});

	it("caps only a new stream", () => {
		const shares = Object.fromEntries(
			Array.from({ length: MAX_STREAMS_PER_OWNER }, (_, i) => [`stream-${i}`, entry(1, 0)]),
		);
		const existing = mergeReadAnchor({ owner: shares }, "owner", "stream-0", entry(1, 1));
		const added = mergeReadAnchor(existing.state, "owner", "new-stream", entry(1, 0));
		expect(existing.advanced).toBe(true);
		expect(added.advanced).toBe(false);
	});
});
