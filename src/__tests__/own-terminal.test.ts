import { describe, expect, it } from "vitest";
import { ownTerminal } from "../gateway/console/consoleSessionLifecycle.js";
import type { SessionRecord } from "../shared/session-store.js";

const teamOf = (record: SessionRecord) => `${record.spawn}.${record.id}`;

function record(over: Partial<SessionRecord> = {}): SessionRecord {
	return { id: "abc123", spawn: "host", lastSeen: 0, ...over } as SessionRecord;
}

describe("whose terminal a record names", () => {
	it("is this Gateway's while nothing live claims another name", () => {
		expect(ownTerminal(record(), teamOf)).toBe(true);
		expect(ownTerminal(undefined, teamOf)).toBe(true);
	});

	it("is this Gateway's when the live name is the record's own", () => {
		expect(ownTerminal(record({ liveTeam: { team: "host.abc123", subId: "s1" } }), teamOf)).toBe(true);
	});

	// Close refuses this one and forget leaves its terminal running.
	it("is not this Gateway's when the session runs under another name", () => {
		expect(ownTerminal(record({ liveTeam: { team: "host.typed-by-hand", subId: "s1" } }), teamOf)).toBe(false);
	});
});
