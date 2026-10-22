import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ConsolePushEntrySchema } from "../shared/federation-protocol.js";
import { RECORD_SUMMARY_MAX, RECORD_THREADS_MAX } from "../shared/schemasAssistantRecord.js";
import { InboxRowInputSchema, RowKindSchema } from "../shared/schemasInbox.js";

const thread = (threadId: string, extra: Record<string, unknown> = {}) => ({ threadId, outcome: "done", ...extra });
const record = (extra: Record<string, unknown>) => ({
	kind: "assistant_record",
	session_id: "host.assistant",
	...extra,
});
const accepts = (entry: unknown) => ConsolePushEntrySchema.safeParse(entry).success;

describe("an assistant record on the way to the phone", () => {
	it("carries a summary to notify, or nothing an older phone would show to stay quiet", () => {
		expect(accepts(record({ notify: true, body: "Worth a look.", threads: [thread("1")] }))).toBe(true);
		expect(
			accepts(
				record({
					notify: false,
					threads: [thread("1"), thread("2", { title: "v2", url: "https://github.com/a/b" })],
				}),
			),
		).toBe(true);

		expect(accepts(record({ notify: false, body: "hidden", threads: [thread("1")] }))).toBe(false);
		expect(accepts(record({ notify: false, body: "", threads: [thread("1")] }))).toBe(false);
		expect(accepts(record({ notify: true, threads: [thread("1")] }))).toBe(false);
		expect(
			accepts(record({ notify: true, body: "x".repeat(RECORD_SUMMARY_MAX + 1), threads: [thread("1")] })),
		).toBe(false);
		expect(accepts(record({ notify: true, body: "hi", title: "Assistant", threads: [thread("1")] }))).toBe(false);
	});

	it("names each thread once, within the cap, with a known outcome and an https link", () => {
		const many = Array.from({ length: RECORD_THREADS_MAX + 1 }, (_, i) => thread(String(i)));

		expect(accepts(record({ notify: false, threads: [thread("1"), thread("1")] }))).toBe(false);
		expect(accepts(record({ notify: false, threads: many }))).toBe(false);
		expect(accepts(record({ notify: false, threads: [] }))).toBe(false);
		expect(accepts(record({ notify: false, threads: [thread("1", { outcome: "skipped" })] }))).toBe(false);
		expect(accepts(record({ notify: false, threads: [thread("1", { url: "http://github.com/a/b" })] }))).toBe(
			false,
		);
	});

	it("is the only kind with notify or threads, and needs both", () => {
		expect(accepts({ kind: "notice", session_id: "host.x", body: "hi", notify: true })).toBe(false);
		expect(accepts({ kind: "notice", session_id: "host.x", body: "hi", threads: [thread("1")] })).toBe(false);
		expect(accepts({ kind: "notice", session_id: "host.x", body: "hi" })).toBe(true);
		expect(accepts(record({ threads: [thread("1")] }))).toBe(false);
		expect(accepts(record({ notify: false }))).toBe(false);
	});

	it("is a row kind the Router admits from the owner's own Gateway, never from a friend", () => {
		const fixture = JSON.parse(fs.readFileSync("tests/fixtures/protocol/inbox-row.json", "utf8"));
		const peer = {
			envelope: {
				...fixture.envelope,
				origin: { kind: "gateway", domainId: "domain-a", gatewayId: "sakura" },
				epoch: "peer",
				kind: "assistant_record",
			},
			producerSig: fixture.producerSig,
			body: {},
		};
		const kindRefused = InboxRowInputSchema.safeParse(peer).error?.issues.some((issue) =>
			issue.path.includes("kind"),
		);
		const asMessage = InboxRowInputSchema.safeParse({ ...peer, envelope: { ...peer.envelope, kind: "message" } });

		expect(RowKindSchema.safeParse("assistant_record").success).toBe(true);
		expect(kindRefused).toBe(true);
		expect(asMessage.error?.issues.some((issue) => issue.path.includes("kind"))).toBeFalsy();
	});
});
