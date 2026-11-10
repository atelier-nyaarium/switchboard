import { describe, expect, it } from "vitest";
import {
	deliveryOf,
	foldHarness,
	HARNESS,
	launchRefusal,
	mintedIdOf,
	OPENCODE_PIN,
	paneRoad,
	pushesBaseline,
	readHarness,
	resumableId,
	SESSION_HARNESSES,
	type SessionHarness,
	typesDelivery,
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

	it("keeps Copilot out of containers, OpenCode on the host's own shell, and Claude anywhere", () => {
		expect(SESSION_HARNESSES.map((harness) => [harness, refused(harness, false)])).toEqual([
			["claude", []],
			["opencode", ["windows", "container"]],
			["copilot", ["container"]],
		]);
	});

	it("lets only Claude run as the assistant", () => {
		expect(SESSION_HARNESSES.filter((harness) => refused(harness, true).length < places.length)).toEqual([
			"claude",
		]);
	});

	it("names a different reason for each refusal", () => {
		const reasons = [
			launchRefusal("opencode", { place: "container", assistant: false }),
			launchRefusal("opencode", { place: "windows", assistant: false }),
			launchRefusal("opencode", { place: "host", assistant: true }),
		];

		expect(new Set(reasons).size).toBe(3);
		expect(reasons.every((reason) => typeof reason === "string")).toBe(true);
	});
});

describe("how a session CLI is read and driven", () => {
	it("gives each CLI one road for a pushed message", () => {
		expect(SESSION_HARNESSES.map(deliveryOf)).toEqual(["channel", "api", "typed"]);
		expect(SESSION_HARNESSES.filter(typesDelivery)).toEqual(["copilot"]);
	});

	it("has a pane road only for a CLI the daemon reads", () => {
		expect(SESSION_HARNESSES.filter((harness) => paneRoad(harness) !== undefined)).toEqual(["claude", "copilot"]);
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

describe("a compacted session's baseline", () => {
	it("is fetched by the session itself, except Copilot's, which the Gateway pushes", () => {
		expect(SESSION_HARNESSES.map((harness) => HARNESS[harness].baseline)).toEqual([
			"session",
			"session",
			"gateway",
		]);
		expect(SESSION_HARNESSES.filter(pushesBaseline)).toEqual(["copilot"]);
	});
});
