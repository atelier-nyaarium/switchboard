import { describe, expect, it } from "vitest";
import {
	foldHarness,
	HARNESS,
	launchRefusal,
	mintedIdOf,
	OPENCODE_PIN,
	readHarness,
	resumableId,
	SESSION_HARNESSES,
	type SessionHarness,
	UNPICKED_WORD,
	versionRefusal,
} from "../shared/session-harness.js";

describe("a session CLI named on the wire", () => {
	it("reads an absent word as unnamed Claude, a known one as named, `unpicked` as none chosen, and any other as unknown", () => {
		expect([readHarness(undefined), readHarness(null)]).toEqual([
			{ read: "unnamed", assumed: "claude" },
			{ read: "unnamed", assumed: "claude" },
		]);
		expect(readHarness("copilot")).toEqual({ read: "named", harness: "copilot" });
		expect(readHarness(UNPICKED_WORD)).toEqual({ read: "unpicked" });
		expect(readHarness("no-such-cli")).toEqual({ read: "unknown", word: "no-such-cli" });
	});

	it("hands each reading to its own case", () => {
		const told = (value: unknown) =>
			foldHarness(readHarness(value), {
				named: (harness) => `named ${harness}`,
				unnamed: (assumed) => `unnamed ${assumed}`,
				unpicked: () => "unpicked",
				unknown: (word) => `unknown ${word}`,
			});

		expect([told("copilot"), told(undefined), told(UNPICKED_WORD), told("no-such-cli")]).toEqual([
			"named copilot",
			"unnamed claude",
			"unpicked",
			"unknown no-such-cli",
		]);
	});
});

describe("a session id the Gateway mints", () => {
	const uuid = "0f8b2a4c-1d3e-4f5a-9b6c-7d8e9f0a1b2c";
	const opencode = "ses_sb0f8b2a4c1d3e4f5a9b6c7d8e9f0a1b2c";

	it("is read only for a CLI that takes one, and only in its shape", () => {
		expect(mintedIdOf("copilot", uuid)).toBe(uuid);
		expect([mintedIdOf("copilot", "nope"), mintedIdOf("copilot", undefined)]).toEqual([undefined, undefined]);
		expect(mintedIdOf("claude", uuid)).toBeUndefined();
		expect([mintedIdOf("opencode", opencode), mintedIdOf("opencode", uuid)]).toEqual([opencode, undefined]);
	});

	it("is minted in the shape its own CLI reads back", () => {
		const minted = SESSION_HARNESSES.flatMap((harness) => {
			const policy = HARNESS[harness].sessionId;
			return policy.minted ? [[harness, policy.mint(() => uuid)] as const] : [];
		});

		expect(minted).toEqual([
			["opencode", opencode],
			["copilot", uuid],
		]);
		for (const [harness, id] of minted) expect(mintedIdOf(harness, id), harness).toBe(id);
	});

	it("resumes only under an id of that CLI's shape", () => {
		expect(resumableId("opencode", opencode)).toBe(opencode);
		expect([
			resumableId("opencode", uuid),
			resumableId("copilot", opencode),
			resumableId("claude", undefined),
		]).toEqual([undefined, undefined, undefined]);
		expect(resumableId("claude", "12345678")).toBe("12345678");
	});
});

describe("where a session CLI may launch", () => {
	const places = ["host", "windows", "container"] as const;
	const refused = (harness: SessionHarness, assistant: boolean) =>
		places.filter((place) => launchRefusal(harness, { place, assistant }) !== null);

	it("keeps OpenCode off the Windows shell, and Claude and Copilot anywhere", () => {
		expect(SESSION_HARNESSES.map((harness) => [harness, refused(harness, false)])).toEqual([
			["claude", []],
			["opencode", ["windows"]],
			["copilot", []],
		]);
	});

	it("lets only Claude run as the assistant", () => {
		expect(SESSION_HARNESSES.filter((harness) => refused(harness, true).length < places.length)).toEqual([
			"claude",
		]);
	});
});

describe("the versions a launch accepts", () => {
	it("accepts any version of a CLI that pins none", () => {
		expect([versionRefusal("claude", undefined), versionRefusal("copilot", "0.0.1")]).toEqual([null, null]);
	});

	it("accepts OpenCode's pin and refuses another version by its number, or none read", () => {
		expect(versionRefusal("opencode", OPENCODE_PIN)).toBeNull();
		expect(versionRefusal("opencode", "9.9.9")).toContain("9.9.9");
		expect(typeof versionRefusal("opencode", undefined)).toBe("string");
	});
});
