import { describe, expect, it } from "vitest";
import { bringUpLine, resumeArgOf } from "../mcp/launchFacts.js";

const cmdline = (...parts: string[]) => `${parts.join("\0")}\0`;

describe("resumeArgOf", () => {
	it("reads the id --resume asked for, and nothing else off the line", () => {
		expect(
			resumeArgOf(cmdline("claude", "--model", "opus", "--resume", "4b5675d4-d2ed-409b-8b18-712df71a1c37")),
		).toBe("4b5675d4-d2ed-409b-8b18-712df71a1c37");
		expect(resumeArgOf(cmdline("claude", "--model", "opus"))).toBeNull();
	});

	it("refuses a value that is not an id, including a following flag", () => {
		expect(resumeArgOf(cmdline("claude", "--resume", "--model"))).toBeNull();
		expect(resumeArgOf(cmdline("claude", "--resume"))).toBeNull();
		expect(resumeArgOf(cmdline("claude", "--resume", "short"))).toBeNull();
	});
});

describe("bringUpLine", () => {
	const team = "host.567375";
	const old = "4b5675d4-d2ed-409b-8b18-712df71a1c37";
	const fresh = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

	it("names the fork a resume mints, which is what repoints the gateway's record", () => {
		const line = bringUpLine({ team, envPinned: true, sessionId: fresh, resumedFrom: old });
		expect(line).toContain("env-pinned");
		expect(line).toContain(`resumed ${old} as ${fresh} (forked)`);
	});

	it("says derived when no pin survived, which is how a resume lands under a name nobody addresses", () => {
		const line = bringUpLine({ team, envPinned: false, sessionId: fresh, resumedFrom: old });
		expect(line).toContain("derived");
		expect(line).toContain("(forked)");
	});

	it("marks no fork when the resume kept its id, and calls a launch with no resume fresh", () => {
		expect(bringUpLine({ team, envPinned: true, sessionId: old, resumedFrom: old })).not.toContain("forked");
		expect(bringUpLine({ team, envPinned: true, sessionId: fresh, resumedFrom: null })).toContain(`fresh ${fresh}`);
	});

	it("says what it can when the harness reported no session id at all", () => {
		expect(bringUpLine({ team, envPinned: true, sessionId: undefined, resumedFrom: null })).toBe(
			`[bridge] identity ${team} (env-pinned)`,
		);
	});
});
