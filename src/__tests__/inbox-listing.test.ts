import { describe, expect, it } from "vitest";
import { createInboxListing } from "../gateway/assistant/inboxListing.js";
import type { ListQuery, Source, SourceEvent } from "../gateway/assistant/source.js";
import { FRESH_STATE, type SourceState } from "../gateway/assistant/sourceState.js";

const PAGE = 2;

/** Pages by offset, as GitHub does. */
function offsetSource(threads: SourceEvent[]): Source {
	return {
		id: "github",
		label: "GitHub",
		fieldSpecs: [],
		poll: async () => ({ kind: "unchanged", nextPollMs: 60_000 }),
		async list(query: ListQuery) {
			const [offset, since, held]: [number, number, number | null] = query.page
				? JSON.parse(query.page)
				: [0, query.since ?? 0, null];
			const unread = threads.filter((thread) => thread.at > since);
			const events = unread.slice(offset, offset + PAGE);
			const mark = held ?? Math.max(since, ...events.map((event) => event.at));
			const more = offset + PAGE < unread.length;
			return {
				events,
				here: JSON.stringify([offset, since, mark]),
				...(more ? { next: JSON.stringify([offset + PAGE, since, mark]) } : { mark }),
			};
		},
	};
}

describe("the inbox listing", () => {
	it("moves no mark past threads an action shifted off the pages, so the next new read shows them", async () => {
		const threads = [5, 4, 3, 2, 1].map((at) => ({ id: `t${at}`, at, title: `Thread ${at}`, fields: {} }));
		const source = offsetSource(threads);
		let held: SourceState = FRESH_STATE;
		const listing = createInboxListing({
			sources: [source],
			enabled: () => true,
			state: {
				get: () => held,
				put: (_id, next) => {
					held = next;
					return true;
				},
			},
			decide: () => "inbox",
			ambient: { randomBytes: (size) => Buffer.alloc(size, 7) },
			livePage: async (_id, query, _ms, settle) => {
				const read = await source.list?.(query(), new AbortController().signal);
				if (!read) throw new Error("the source lists nothing");
				return settle(read);
			},
		});
		const ids = (list: { items: { id: string }[] } | undefined) => list?.items.map((item) => item.id);

		const [first] = await listing.list("new");
		threads.splice(0, 2);
		listing.acted("github");
		const [last] = await listing.list("new", first?.next);
		const [again] = await listing.list("new");

		expect([ids(first), ids(last), last?.next]).toEqual([["t5", "t4"], ["t1"], undefined]);
		expect(held.mark).toBeUndefined();
		expect(ids(again)).toEqual(["t3", "t2"]);
	});
});
