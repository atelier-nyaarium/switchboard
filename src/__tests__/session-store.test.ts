import { describe, expect, it } from "vitest";
import { agentOperationIdentity } from "../shared/agent-identity.js";
import { PersistedAgentSchema } from "../shared/agent-persisted.js";
import { agentOperationFingerprintOf } from "../shared/agent-record.js";
import { processAmbient } from "../shared/ambient.js";
import { isReservedHostSession } from "../shared/host-op.js";
import { sanitizeLabel, sanitizeWorkdirPath } from "../shared/session-sanitize.js";
import { type PersistedAgentCatalogWriter, resumeIdOf, SessionStore } from "../shared/session-store.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

function scriptedIds(...ids: string[]) {
	let extra = 0;
	return () => ids.shift() ?? `fill${extra++}`;
}

const RESUME_FILE = {
	"host.switchboard": { id: "switchboard", spawn: "host", claudeSessionId: "16aa1d0d-aaaa", lastSeen: 1000 },
	"host.story-telling": { id: "story-telling", spawn: "host", claudeSessionId: "c1fa7689-bbbb", lastSeen: 2000 },
};

const COPILOT_OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const COPILOT_AGENT_ID = "copilot_0123456789abcdef0123456789abcdef";

function requestedCopilotAgent() {
	return PersistedAgentSchema.parse({
		version: 2,
		agentId: COPILOT_AGENT_ID,
		agentState: "creating",
		requestedTarget: { kind: "host", workdirHint: "Work" },
		operations: [
			{
				operationId: COPILOT_OPERATION_ID,
				kind: "start",
				prompt: "Review",
				fingerprint: agentOperationFingerprintOf(
					agentOperationIdentity({ kind: "start", agentId: COPILOT_AGENT_ID, prompt: "Review" }),
				),
				state: "requested",
				createdAt: 10,
				updatedAt: 10,
			},
		],
		turns: [],
		createdAt: 10,
		updatedAt: 10,
	});
}

describe("SessionStore migration", () => {
	it("restores a record from its persisted shape and skips a row with no id", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		store.restore({ ...RESUME_FILE, "host.bare": { claudeSessionId: "16aa1d0d-cccc", lastSeen: 3000 } });
		expect(store.getByTeam("host.switchboard")).toMatchObject({
			id: "switchboard",
			sessionLabel: "switchboard",
			spawn: "host",
			claudeSessionId: "16aa1d0d-aaaa",
			lastSeen: 1000,
		});
		expect(store.size).toBe(2);
	});

	it("a rename survives any number of snapshot/restore round-trips (a loaded record is not re-derived)", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		store.restore(RESUME_FILE);
		expect(store.rename("host.switchboard", "My Main Session")).toBe("My Main Session");

		let snap = store.snapshot();
		for (let boot = 0; boot < 3; boot++) {
			const next = new SessionStore({ ambient: processAmbient() });
			next.restore(snap);
			expect(next.getByTeam("host.switchboard")?.sessionLabel).toBe("My Main Session");
			snap = next.snapshot();
		}
	});

	it("skips keys that were never valid chats (the read-guard)", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		store.restore({
			host: { id: "host", spawn: "host", lastSeen: 1 },
			"host.UPPER": { id: "UPPER", spawn: "host", lastSeen: 1 },
			"host.ok": { lastSeen: 1 },
		});
		expect(store.size).toBe(0);
	});

	it("never restores a live pointer (a stamp cannot outlive its sockets)", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		store.restore(RESUME_FILE);
		store.bindBySegment("host.switchboard", { live: { team: "host.switchboard", subId: "s1" } });
		expect(store.resolveLive("host.switchboard")).toBeDefined();

		const next = new SessionStore({ ambient: processAmbient() });
		next.restore(store.snapshot());
		expect(next.resolveLive("host.switchboard")).toBeUndefined();
	});

	it("re-asserts label safety on restore, so a hand-edited store file cannot smuggle a path", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		store.restore({
			"host.abc123": { id: "abc123", sessionLabel: "../escape", spawn: "host", workdirHint: "a/b", lastSeen: 1 },
		});
		expect(store.getByTeam("host.abc123")).toMatchObject({ sessionLabel: "abc123", workdirHint: undefined });
	});

	it("re-dedups labels on restore, so a hand-edited file with a shared label loads distinct", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		store.restore({
			"host.aaa111": { id: "aaa111", sessionLabel: "dup", spawn: "host", lastSeen: 1 },
			"host.bbb222": { id: "bbb222", sessionLabel: "dup", spawn: "host", lastSeen: 2 },
		});
		const labels = [store.getByTeam("host.aaa111")?.sessionLabel, store.getByTeam("host.bbb222")?.sessionLabel];
		expect(new Set(labels).size).toBe(2);
		store.forget("host.aaa111");
		expect(store.mint({ spawn: "host", harness: "claude", sessionLabel: "dup" }).sessionLabel).not.toBe(
			store.getByTeam("host.bbb222")?.sessionLabel,
		);
	});
});

describe("SessionStore composite keying", () => {
	it("bindBySegment rebinds the resume id onto the same record without duplicating", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		store.adoptById("abc123", { spawn: "host", harness: "claude", claudeSessionId: "t-1" });
		expect(store.getByTeam("host.abc123")).toMatchObject({ id: "abc123", spawn: "host", claudeSessionId: "t-1" });
		store.bindBySegment("host.abc123", { claudeSessionId: "t-2" });
		expect(store.size).toBe(1);
		expect(store.getByTeam("host.abc123")?.claudeSessionId).toBe("t-2");
	});

	it("two spawns sharing a segment stay separate, each resumable by its own transcript", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		store.adoptById("claude", { spawn: "host", harness: "claude", claudeSessionId: "host-tx" });
		store.adoptById("claude", { spawn: "recipe-app", harness: "claude", claudeSessionId: "app-tx" });
		expect(store.size).toBe(2);
		expect(store.getByTeam("host.claude")?.claudeSessionId).toBe("host-tx");
		expect(store.getByTeam("recipe-app.claude")?.claudeSessionId).toBe("app-tx");
		store.forget("host.claude");
		expect(store.getByTeam("host.claude")).toBeUndefined();
		expect(store.getByTeam("recipe-app.claude")?.claudeSessionId).toBe("app-tx");
	});
});

describe("SessionStore mint / adopt", () => {
	it("mints a fresh id, re-rolling past existing records and the injected clash space", () => {
		const store = new SessionStore({
			ambient: processAmbient(),
			clash: (id) => id === "reserved",
			idGen: scriptedIds("taken", "reserved", "fresh1"),
		});
		store.adoptById("taken", { spawn: "host", harness: "claude" });
		const rec = store.mint({ spawn: "host", harness: "claude", sessionLabel: "My Session" });
		expect(rec.id).toBe("fresh1");
		expect(rec.sessionLabel).toBe("My Session");
	});

	it("adopts a caller-supplied free id and refuses a taken or non-slug or reserved one", () => {
		const store = new SessionStore({ ambient: processAmbient(), clash: (id) => id === "host-daemon" });
		expect(store.adoptById("mywork", { spawn: "host", harness: "claude" })?.id).toBe("mywork");
		expect(store.adoptById("mywork", { spawn: "host", harness: "claude" })).toBeNull();
		expect(store.adoptById("host-daemon", { spawn: "host", harness: "claude" })).toBeNull();
		expect(store.adoptById("Bad Name", { spawn: "host", harness: "claude" })).toBeNull();
		expect(store.adoptById("mywork", { spawn: "recipe-app", harness: "claude" })?.id).toBe("mywork");
	});

	it("adoptOrReattach creates fresh, reattaches an existing record, and refuses a reserved id", () => {
		const store = new SessionStore({ ambient: processAmbient(), clash: (id) => id === "host-daemon" });
		const first = store.adoptOrReattach("work", { spawn: "host", harness: "claude", sessionLabel: "Work" });
		expect(first).toMatchObject({ created: true, record: { id: "work", sessionLabel: "Work" } });
		const again = store.adoptOrReattach("work", { spawn: "host", harness: "claude", sessionLabel: "ignored" });
		expect(again).toMatchObject({ created: false, record: { id: "work", sessionLabel: "Work" } });
		expect(store.size).toBe(1);
		expect(store.adoptOrReattach("host-daemon", { spawn: "host", harness: "claude" })).toBeNull();
	});

	it("holds a host name as one pane across every host spawn point, read or not", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		store.restore({ "host.newer": { id: "newer", harness: "no-such-cli", lastSeen: 1 } });
		store.adoptById("foo", { spawn: "host", harness: "claude" });

		expect(store.adoptById("foo", { spawn: "windows", harness: "claude" })).toBeNull();
		expect(store.adoptById("newer", { spawn: "windows", harness: "claude" })).toBeNull();
		expect(store.adoptOrReattach("foo", { spawn: "host", harness: "claude" })).toMatchObject({
			created: false,
			record: { id: "foo", spawn: "host" },
		});
		expect(store.adoptOrReattach("foo", { spawn: "windows", harness: "claude" })).toBeNull();
		expect(store.adoptById("foo", { spawn: "recipe-app", harness: "claude" })?.id).toBe("foo");
	});

	it("holds the second of two stored records sharing a host pane unread, written back untouched", () => {
		const second = { id: "foo", spawn: "windows", harness: "claude", lastSeen: 2 };
		const store = new SessionStore({ ambient: processAmbient() });

		store.restore({
			"host.foo": { id: "foo", spawn: "host", harness: "claude", lastSeen: 1 },
			"windows.foo": second,
		});

		expect(store.list().map((record) => store.teamOf(record))).toEqual(["host.foo"]);
		expect(store.getByTeam("windows.foo")).toBeUndefined();
		expect(store.snapshot()["windows.foo"]).toEqual(second);
	});

	it("re-rolls a minted host id held on another host spawn point", () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: scriptedIds("taken", "fresh1") });
		store.adoptById("taken", { spawn: "windows", harness: "claude" });

		expect(store.mint({ spawn: "host", harness: "claude" }).id).toBe("fresh1");
	});

	it("gives the assistant's name to the assistant alone, and never the daemon's pane", () => {
		const store = new SessionStore({ ambient: processAmbient(), clash: isReservedHostSession });

		expect(store.adoptById("assistant", { spawn: "windows", harness: "claude" })).toBeNull();
		expect(store.adoptById("assistant", { spawn: "host", harness: "claude" })?.id).toBe("assistant");
		expect(store.adoptById("host-daemon", { spawn: "windows", harness: "claude" })).toBeNull();
		expect(store.adoptById("assistant", { spawn: "recipe-app", harness: "claude" })?.id).toBe("assistant");
	});

	it("findByMintedFrom finds a gateway-minted record by its own provenance, scoped to a spawn", () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: scriptedIds("minted1") });
		store.mint({ spawn: "host", harness: "claude", sessionLabel: "Work", mintedFrom: "conv:op1" });
		expect(store.findByMintedFrom("conv:op1", "host")).toMatchObject({ id: "minted1", sessionLabel: "Work" });
		expect(store.findByMintedFrom("conv:op1", "other-spawn")).toBeUndefined();
		expect(store.findByMintedFrom("conv:unrelated", "host")).toBeUndefined();
	});

	it("findByMintedFrom refuses to trust an ambiguous match rather than pick either record", () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: scriptedIds("dup-a", "dup-b") });
		store.mint({ spawn: "host", harness: "claude", sessionLabel: "A", mintedFrom: "conv:op1" });
		store.mint({ spawn: "host", harness: "claude", sessionLabel: "B", mintedFrom: "conv:op1" });
		expect(store.findByMintedFrom("conv:op1", "host")).toBeUndefined();
	});

	it("findByMintedFrom still resolves a record after it has been renamed", () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: scriptedIds("minted1") });
		store.mint({ spawn: "host", harness: "claude", sessionLabel: "Work", mintedFrom: "conv:op1" });
		store.rename("host.minted1", "Renamed");
		expect(store.findByMintedFrom("conv:op1", "host")).toMatchObject({ id: "minted1", sessionLabel: "Renamed" });
	});

	it("mintOrReattach mints fresh on a first call, then reattaches the SAME record for a retry sharing the same provenance", () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: scriptedIds("minted1", "minted2") });
		const first = store.mintOrReattach({
			spawn: "host",
			harness: "claude",
			sessionLabel: "Work",
			mintedFrom: "conv:op1",
		});
		expect(first).toMatchObject({ created: true, record: { id: "minted1", sessionLabel: "Work" } });
		// Matching provenance preserves the label.
		const retry = store.mintOrReattach({
			spawn: "host",
			harness: "claude",
			sessionLabel: "ignored",
			mintedFrom: "conv:op1",
		});
		expect(retry).toMatchObject({ created: false, record: { id: "minted1", sessionLabel: "Work" } });
		expect(store.size).toBe(1);
		const other = store.mintOrReattach({
			spawn: "host",
			harness: "claude",
			sessionLabel: "Other",
			mintedFrom: "conv:op2",
		});
		// Different provenance separates records under one spawn.
		expect(other).toMatchObject({ created: true, record: { id: "minted2", sessionLabel: "Other" } });
		expect(store.size).toBe(2);
	});
});

describe("SessionStore confirm-time binding", () => {
	it("bindResume finds the record holding the transcript, wherever it re-incarnates", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		store.mint({ spawn: "host", harness: "claude", sessionLabel: "phone session", claudeSessionId: "t-99" });
		const live = { team: "host.5f5f5f", subId: "s2" };
		const rec = store.bindResume("t-99", { live });
		expect(rec?.sessionLabel).toBe("phone session");
		expect(rec && store.resolveLive(store.teamOf(rec))).toEqual(live);
		expect(store.bindResume("unknown-transcript")).toBeNull();
	});

	it("clearLive drops only the exact (team, subId) incarnation, not a sibling sharing the team", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		store.adoptById("aaa111", { spawn: "host", harness: "claude" });
		store.adoptById("bbb222", { spawn: "host", harness: "claude" });
		store.bindBySegment("host.aaa111", { live: { team: "host.zzz", subId: "s1" } });
		store.bindBySegment("host.bbb222", { live: { team: "host.zzz", subId: "s2" } });
		store.clearLive("host.zzz", "s1");
		expect(store.resolveLive("host.aaa111")).toBeUndefined();
		expect(store.resolveLive("host.bbb222")).toEqual({ team: "host.zzz", subId: "s2" });
	});

	it("confirm stamps the handshake time on a known team and is a no-op on an unknown one", () => {
		let clock = 500;
		const store = new SessionStore({ ambient: fakeAmbient({ now: () => clock }), idGen: scriptedIds("known1") });
		store.mint({ spawn: "host", harness: "claude" });
		clock = 900;
		expect(store.confirm("host.known1")).toMatchObject({ confirmedAt: 900, lastSeen: 900 });
		expect(store.confirm("host.nosuch")).toBeUndefined();
	});
});

describe("SessionStore establishOnConfirm binding order", () => {
	const live = { team: "host.abc123", subId: "s1" };

	it("tier 1: binds an existing record its segment names, without duplicating", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		store.adoptById("mywork", { spawn: "host", harness: "claude", sessionLabel: "My Work" });
		const rec = store.establishOnConfirm("host.mywork", {
			claudeSessionId: "tx-9",
			harness: "claude",
			live: { team: "host.mywork", subId: "s1" },
		});
		expect(store.size).toBe(1);
		expect(rec).toMatchObject({
			sessionLabel: "My Work",
			claudeSessionId: "tx-9",
			liveTeam: { team: "host.mywork", subId: "s1" },
		});
		expect(rec?.confirmedAt).toBeGreaterThan(0);
	});

	it("tier 2: binds the record holding a matching transcript id, under a fresh segment", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		store.adoptById("orig", { spawn: "host", harness: "claude", claudeSessionId: "tx-7" });
		const rec = store.establishOnConfirm("host.fresh1", {
			claudeSessionId: "tx-7",
			harness: "claude",
			live: { team: "host.fresh1", subId: "s2" },
		});
		expect(store.size).toBe(1);
		expect(rec && store.teamOf(rec)).toBe("host.orig");
		expect(store.getByTeam("host.fresh1")).toBeUndefined();
	});

	it("tier 3: adopts a free segment and labels it by the reported cwd", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		const rec = store.establishOnConfirm("host.abc123", {
			claudeSessionId: "tx-1",
			harness: "claude",
			label: "switchboard",
			live,
		});
		expect(rec).toMatchObject({ id: "abc123", sessionLabel: "switchboard", claudeSessionId: "tx-1" });
	});

	it("tier 4: mints a fresh id when the segment collides with a reserved id", () => {
		const store = new SessionStore({
			ambient: processAmbient(),
			clash: (id) => id === "evie-bot",
			idGen: scriptedIds("minted1"),
		});
		const rec = store.establishOnConfirm("host.evie-bot", { harness: "claude", label: "evie-bot", live });
		expect(store.getByTeam("host.evie-bot")).toBeUndefined();
		expect(rec).toMatchObject({ id: "minted1", sessionLabel: "evie-bot" });
	});

	it("creates no record for a CLI that answers no handshake, or for none it knows", () => {
		const store = new SessionStore({ ambient: processAmbient() });

		expect(store.establishOnConfirm("host.abc123", { harness: "copilot", live })).toBeUndefined();
		expect(store.establishOnConfirm("host.abc123", { harness: null, live })).toBeUndefined();
		expect(store.size).toBe(0);
		expect(store.establishOnConfirm("host.abc123", { harness: "claude", live })).toMatchObject({
			id: "abc123",
			harness: "claude",
		});
	});

	it("a bare spawn-point team establishes no record", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		expect(
			store.establishOnConfirm("someproj", {
				claudeSessionId: "tx-1",
				harness: "claude",
				live: { team: "someproj", subId: "s1" },
			}),
		).toBeUndefined();
		expect(store.size).toBe(0);
	});
});

describe("SessionStore labels and paths", () => {
	it("dedups labels per spawn with a -# suffix; other spawns may reuse the label", () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: scriptedIds("id1", "id2", "id3") });
		expect(store.mint({ spawn: "host", harness: "claude", sessionLabel: "switchboard" }).sessionLabel).toBe(
			"switchboard",
		);
		expect(store.mint({ spawn: "host", harness: "claude", sessionLabel: "switchboard" }).sessionLabel).toBe(
			"switchboard-2",
		);
		expect(store.mint({ spawn: "recipe-app", harness: "claude", sessionLabel: "switchboard" }).sessionLabel).toBe(
			"switchboard",
		);
	});

	it("frees a label on forget so it can be reused without a suffix", () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: scriptedIds("id1", "id2") });
		store.mint({ spawn: "host", harness: "claude", sessionLabel: "alpha" });
		expect(store.mint({ spawn: "host", harness: "claude", sessionLabel: "alpha" }).sessionLabel).toBe("alpha-2");
		store.forget("host.id1");
		expect(store.mint({ spawn: "host", harness: "claude", sessionLabel: "alpha" }).sessionLabel).toBe("alpha");
	});

	it("rename applies sanitization + dedup and reports the label actually applied", () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: scriptedIds("id1", "id2") });
		store.mint({ spawn: "host", harness: "claude", sessionLabel: "alpha" });
		store.mint({ spawn: "host", harness: "claude", sessionLabel: "beta" });
		expect(store.rename("host.id2", "alpha")).toBe("alpha-2");
		expect(store.rename("host.id2", "../escape")).toBeNull();
		expect(store.getByTeam("host.id2")?.sessionLabel).toBe("alpha-2");
	});

	it("sanitizes labels into usable session state", () => {
		const inputs = [
			"  My Cool Session!  ",
			"chat \u{1F600}",
			"a/b",
			"a\\b",
			"..",
			"tab\there",
			"\u200b\u200b\u200b",
			"abc\u202edef",
			"x\u0085y",
			"",
			"x".repeat(200),
			`${"x".repeat(63)}\u{1F600}`,
		];
		expect(inputs.map(sanitizeLabel)).toEqual([
			"My Cool Session!",
			"chat \u{1F600}",
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			"x".repeat(64),
			`${"x".repeat(63)}\u{1F600}`,
		]);
	});

	it("mint falls back to safe defaults when the supplied label and hint are unsafe", () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: scriptedIds("safe01") });
		const rec = store.mint({ spawn: "host", harness: "claude", sessionLabel: "../evil", workdirHint: "a/b" });
		expect(rec.sessionLabel).toBe("safe01");
		expect(rec.workdirHint).toBeUndefined();
	});

	it("hostWorkdirHint pins the workdir to the original label across a rename, else falls back to the label", () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: scriptedIds("id1", "id2") });
		const rec = store.mint({ spawn: "host", harness: "claude", sessionLabel: "app", workdirHint: "app" });
		// Rename changes only the label.
		store.rename("host.id1", "renamed");
		expect(rec.sessionLabel).toBe("renamed");
		// Original workdir stays pinned.
		expect(store.hostWorkdirHint(rec)).toBe("app");
		const bare = store.mint({ spawn: "host", harness: "claude", sessionLabel: "solo" });
		expect(bare.workdirHint).toBeUndefined();
		// No hint uses the current label.
		expect(store.hostWorkdirHint(bare)).toBe("solo");
	});

	it("a picked workdirPath wins hostWorkdirHint over the label hint and survives a restore", () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: scriptedIds("id1") });
		const rec = store.mint({
			spawn: "host",
			harness: "claude",
			sessionLabel: "app",
			workdirHint: "app",
			workdirPath: "~/deep/dir",
		});
		expect(store.hostWorkdirHint(rec)).toBe("~/deep/dir");

		const next = new SessionStore({ ambient: processAmbient() });
		next.restore(store.snapshot());
		const loaded = next.getByTeam("host.id1");
		expect(loaded?.workdirPath).toBe("~/deep/dir");
		expect(next.hostWorkdirHint(loaded as NonNullable<typeof loaded>)).toBe("~/deep/dir");
	});

	it("sanitizes workdir paths into safe persisted state", () => {
		const inputs = [
			"/data/media",
			"  ~/projects/app  ",
			"~",
			"relative/dir",
			"~elsewhere",
			"/it's",
			'/a"b',
			"/a`b",
			"/a$b",
			"/a\\b",
			`/${"x".repeat(600)}`,
			"",
		];
		expect(inputs.map(sanitizeWorkdirPath)).toEqual([
			"/data/media",
			"~/projects/app",
			"~",
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
		]);
	});

	it("restore drops a hand-edited workdirPath that fails the path rules", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		store.restore({
			"host.abc123": { id: "abc123", sessionLabel: "app", spawn: "host", workdirPath: "$(pwn)", lastSeen: 1 },
		});
		expect(store.getByTeam("host.abc123")?.workdirPath).toBeUndefined();
	});
});

describe("SessionStore TTL", () => {
	it("sweeps stale records while touch-refreshed (live) ones survive", () => {
		let clock = 0;
		const store = new SessionStore({
			ambient: fakeAmbient({ now: () => clock }),
			idGen: scriptedIds("live01", "stale1"),
		});
		store.mint({ spawn: "host", harness: "claude", sessionLabel: "live" });
		store.mint({ spawn: "host", harness: "claude", sessionLabel: "stale" });

		clock = 100;
		store.touchLive("host.live01");
		// Returns removed names.
		expect(store.sweep(50)).toEqual(["host.stale1"]);
		expect(store.getByTeam("host.live01")).toBeDefined();
		expect(store.getByTeam("host.stale1")).toBeUndefined();
	});

	it("sweep returns nothing when nothing was old enough to remove", () => {
		let clock = 0;
		const store = new SessionStore({ ambient: fakeAmbient({ now: () => clock }), idGen: scriptedIds("fresh1") });
		store.mint({ spawn: "host", harness: "claude", sessionLabel: "fresh" });
		clock = 10;
		expect(store.sweep(1_000)).toEqual([]);
		expect(store.getByTeam("host.fresh1")).toBeDefined();
	});

	it("evicts least-recently-seen down to the cap, keeping live records past it", () => {
		let clock = 0;
		const store = new SessionStore({
			ambient: fakeAmbient({ now: () => clock }),
			idGen: scriptedIds("oldest", "middle", "newest", "livest"),
		});
		for (const label of ["oldest", "middle", "newest", "livest"]) {
			store.mint({ spawn: "host", harness: "claude", sessionLabel: label });
			clock += 10;
		}
		store.touchLive("host.livest");

		const removed = store.sweep(1_000_000, { cap: { maxEntries: 2, isLive: (team) => team === "host.oldest" } });

		expect(removed).toEqual(["host.middle", "host.newest"]);
		expect(store.getByTeam("host.oldest")).toBeDefined();
		expect(store.getByTeam("host.livest")).toBeDefined();
	});

	it("leaves the cap alone when the store is within it", () => {
		const store = new SessionStore({ ambient: fakeAmbient({ now: () => 0 }), idGen: scriptedIds("only01") });
		store.mint({ spawn: "host", harness: "claude", sessionLabel: "only" });
		expect(store.sweep(1_000, { cap: { maxEntries: 8, isLive: () => false } })).toEqual([]);
		expect(store.getByTeam("host.only01")).toBeDefined();
	});

	it("keeps every record when the cap cannot be met without evicting a live one", () => {
		const store = new SessionStore({
			ambient: fakeAmbient({ now: () => 0 }),
			idGen: scriptedIds("live001", "live002"),
		});
		store.mint({ spawn: "host", harness: "claude", sessionLabel: "one" });
		store.mint({ spawn: "host", harness: "claude", sessionLabel: "two" });
		expect(store.sweep(1_000, { cap: { maxEntries: 1, isLive: () => true } })).toEqual([]);
		expect(store.list()).toHaveLength(2);
	});

	it("keeps a reserved record past both its age and the cap", () => {
		let clock = 0;
		const store = new SessionStore({
			ambient: fakeAmbient({ now: () => clock }),
			idGen: scriptedIds("kept01", "stale1", "other1"),
		});
		for (const label of ["kept", "stale", "other"])
			store.mint({ spawn: "host", harness: "claude", sessionLabel: label });
		clock = 100;
		store.touchLive("host.other1");

		const removed = store.sweep(50, {
			cap: { maxEntries: 0, isLive: () => false },
			isReserved: (team) => team === "host.kept01",
		});

		expect(removed).toEqual(["host.stale1", "host.other1"]);
		expect(store.list().map((record) => store.teamOf(record))).toEqual(["host.kept01"]);
	});

	it("forget removes the record and returns whether it existed", () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: scriptedIds("gone12") });
		store.mint({ spawn: "host", harness: "claude" });
		expect(store.forget("host.gone12")).toBe(true);
		expect(store.forget("host.gone12")).toBe(false);
		expect(store.getByTeam("host.gone12")).toBeUndefined();
	});
});

describe("SessionStore session binding", () => {
	it("creates a token only when a launched session needs one", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		const record = store.mint({ spawn: "recipe-app", harness: "claude" });

		expect(record.bindToken).toBeUndefined();
		const first = store.ensureBindToken(record);
		expect(store.ensureBindToken(record)).toBe(first);
		expect(store.recordByBindToken(first)).toEqual(record);
		expect(store.recordByBindToken("not-a-real-token")).toBeUndefined();
	});

	it("restores the binding for its owner and leaves tokenless records tokenless", () => {
		const store = new SessionStore({ ambient: processAmbient() });
		const record = store.mint({ spawn: "recipe-app", harness: "claude" });
		const token = store.ensureBindToken(record);
		store.mint({ spawn: "recipe-app", harness: "claude" });

		const restored = new SessionStore({ ambient: processAmbient() });
		restored.restore(JSON.parse(JSON.stringify(store.snapshot())));

		expect(restored.recordByBindToken(token)?.id).toBe(record.id);
		expect(restored.list().filter((item) => !item.bindToken)).toHaveLength(1);
	});
});

describe("SessionStore Copilot catalogs", () => {
	it("commits an agent, snapshots it, and restores it under its session", () => {
		let writer!: PersistedAgentCatalogWriter;
		const store = new SessionStore({
			ambient: processAmbient(),
			agentCatalogPersistence: {
				persistChecked: () => {},
				receiveWriter: (backend, received) => {
					if (backend === "copilot") writer = received;
				},
			},
		});
		const owner = store.mint({ spawn: "host", harness: "claude", sessionLabel: "Work" });
		const agent = requestedCopilotAgent();

		const result = writer.commit(owner, 0, [agent]);
		const restored = new SessionStore({ ambient: processAmbient() });
		restored.restore(store.snapshot());
		const restoredOwner = restored.getByTeam(store.teamOf(owner));

		expect(result).toMatchObject({ committed: true, catalog: { revision: 1, agents: [agent] } });
		expect(store.snapshot()[store.teamOf(owner)]?.agentCatalogs?.copilot).toEqual({
			version: 1,
			revision: 1,
			agents: [agent],
		});
		expect(restored.listAgents(restoredOwner!, "copilot")).toEqual([
			{ ...agent, turnMarks: { collected: [], notified: [] } },
		]);
	});

	it("keeps a catalog unconfirmed when its snapshot landed without directory confirmation", () => {
		let writer!: PersistedAgentCatalogWriter;
		const store = new SessionStore({
			ambient: processAmbient(),
			agentCatalogPersistence: {
				persistChecked: () => false,
				receiveWriter: (backend, received) => {
					if (backend === "copilot") writer = received;
				},
			},
		});
		const owner = store.mint({ spawn: "host", harness: "claude", sessionLabel: "Work" });
		const agent = requestedCopilotAgent();

		expect(writer.commit(owner, 0, [agent])).toMatchObject({
			committed: false,
			reason: "unconfirmed",
			catalog: { revision: 1, agents: [{ agentId: agent.agentId }] },
		});
		expect(writer.isDurable(owner, 1)).toBe(false);
		expect(writer.checkpoint(owner, 1)).toEqual({ confirmed: false, reason: "unconfirmed" });
	});

	it("restores a legacy Copilot catalog and drops a damaged sibling", () => {
		const requested = requestedCopilotAgent();
		const healthy = {
			...requested,
			version: 1,
			agentState: "working",
			resolvedTarget: { kind: "host", targetId: "host", cwd: "/work" },
			sessionId: "session-1",
			activeTurnId: "turn-2",
			operations: [
				{
					...requested.operations[0]!,
					state: "accepted",
					turnId: "turn-1",
					sessionId: "session-1",
					delivery: "started",
					updatedAt: 20,
				},
				{
					operationId: "123e4567-e89b-42d3-a456-426614174001",
					kind: "message",
					prompt: "Continue",
					fingerprint: agentOperationFingerprintOf(
						agentOperationIdentity({
							kind: "message",
							agentId: COPILOT_AGENT_ID,
							prompt: "Continue",
						}),
					),
					state: "accepted",
					turnId: "turn-2",
					sessionId: "session-1",
					delivery: "followup",
					createdAt: 30,
					updatedAt: 35,
				},
			],
			turns: [
				{ id: "turn-1", state: "completed", activities: [], finalResponse: "Done", updatedAt: 25 },
				{ id: "turn-2", state: "inProgress", activities: [], updatedAt: 35 },
			],
			createdAt: 10,
			updatedAt: 35,
		};
		const store = new SessionStore({ ambient: processAmbient() });

		store.restore({
			"host.owner": {
				id: "owner",
				sessionLabel: "Owner",
				spawn: "host",
				lastSeen: 10,
				copilotCatalog: { version: 1, revision: 7, agents: [healthy, { broken: true }] },
			},
		});

		const owner = store.getByTeam("host.owner");
		expect(store.agentCatalog(owner!, "copilot")).toEqual({
			version: 1,
			revision: 7,
			agents: [
				{
					...healthy,
					version: 2,
					operations: healthy.operations.map((operation) =>
						operation.delivery === "followup" ? { ...operation, delivery: "started" } : operation,
					),
					turnMarks: { collected: ["turn-1"], notified: ["turn-1"] },
				},
			],
		});
	});
});

describe("a session record's harness", () => {
	const uuid = "0f8b2a4c-1d3e-4f5a-9b6c-7d8e9f0a1b2c";

	it("mints a Copilot session's id at create and keeps it across a restart", () => {
		const store = new SessionStore({ ambient: processAmbient(), uuidGen: () => uuid });
		const record = store.mint({ spawn: "host", sessionLabel: "cop", harness: "copilot" });
		const plain = store.mint({ spawn: "host", harness: "claude", sessionLabel: "plain", claudeSessionId: "tx-1" });
		const restored = new SessionStore({ ambient: processAmbient() });

		restored.restore(store.snapshot());

		expect(record).toMatchObject({ harness: "copilot", mintedSessionId: uuid });
		expect(restored.getByTeam(store.teamOf(record))).toMatchObject({ harness: "copilot", mintedSessionId: uuid });
		expect(plain.mintedSessionId).toBeUndefined();
		expect([resumeIdOf(record), resumeIdOf(plain)]).toEqual([uuid, "tx-1"]);
	});

	it("snapshots a Copilot session's id under both field names, and neither for Claude", () => {
		const store = new SessionStore({
			ambient: processAmbient(),
			idGen: scriptedIds("cop", "plain"),
			uuidGen: () => uuid,
		});
		store.mint({ spawn: "host", harness: "copilot" });
		store.mint({ spawn: "host", harness: "claude" });

		const snap = store.snapshot();

		expect(snap["host.cop"]).toMatchObject({ mintedSessionId: uuid, copilotSessionId: uuid });
		expect([snap["host.plain"]?.mintedSessionId, snap["host.plain"]?.copilotSessionId]).toEqual([
			undefined,
			undefined,
		]);
	});

	it("restores an id stored under the older field name", () => {
		const store = new SessionStore({ ambient: processAmbient() });

		store.restore({ "host.cop": { id: "cop", harness: "copilot", copilotSessionId: uuid, lastSeen: 1 } });

		expect(store.getByTeam("host.cop")).toMatchObject({ harness: "copilot", mintedSessionId: uuid });
	});

	it("names a pending create's CLI once, minting the id that CLI takes", () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: scriptedIds("p1"), uuidGen: () => uuid });
		const pending = store.mint({ spawn: "fixture-app", sessionLabel: "first" }).harness;

		const named = store.resolvePick("fixture-app.p1", "copilot");
		const again = store.resolvePick("fixture-app.p1", "claude");

		expect(pending).toBeUndefined();
		expect(named).toMatchObject({ harness: "copilot", mintedSessionId: uuid });
		expect(again).toBeNull();
		expect(store.getByTeam("fixture-app.p1")?.harness).toBe("copilot");
	});

	it("keeps the id the daemon launched under, and mints its own for one that does not fit", () => {
		const launched = "11111111-2222-4333-8444-555555555555";
		const store = new SessionStore({
			ambient: processAmbient(),
			idGen: scriptedIds("p1", "p2"),
			uuidGen: () => uuid,
		});
		store.mint({ spawn: "fixture-app", sessionLabel: "first" });
		store.mint({ spawn: "fixture-app", sessionLabel: "second" });

		const kept = store.resolvePick("fixture-app.p1", "copilot", launched);
		const minted = store.resolvePick("fixture-app.p2", "copilot", "not-an-id");

		expect(kept?.mintedSessionId).toBe(launched);
		expect(minted?.mintedSessionId).toBe(uuid);
	});

	it("keeps a pending create pending across a restart", () => {
		const store = new SessionStore({ ambient: processAmbient(), idGen: scriptedIds("p1") });
		store.mint({ spawn: "fixture-app", sessionLabel: "first" });
		const restored = new SessionStore({ ambient: processAmbient() });

		restored.restore(store.snapshot());

		expect(restored.getByTeam("fixture-app.p1")?.harness).toBeUndefined();
	});

	it("restores a record stored with no harness as Claude, holding no minted id", () => {
		const store = new SessionStore({ ambient: processAmbient() });

		store.restore(RESUME_FILE);
		const record = store.getByTeam("host.switchboard");

		expect(record?.harness).toBe("claude");
		expect(record?.mintedSessionId).toBeUndefined();
	});

	it("holds a stored record naming a CLI this build does not know: unread, its name taken, written back untouched", () => {
		const stored = {
			id: "newer",
			harness: "no-such-cli",
			later: { field: [1, "two"] },
			sessionLabel: "../kept",
			lastSeen: 1,
		};
		const store = new SessionStore({ ambient: processAmbient() });

		store.restore({ ...RESUME_FILE, "host.newer": stored });

		expect(store.getByTeam("host.newer")).toBeUndefined();
		expect(store.adoptById("newer", { spawn: "host", harness: "claude" })).toBeNull();
		expect(JSON.stringify(store.snapshot()["host.newer"])).toBe(JSON.stringify(stored));
	});

	it("keeps a stored Copilot record whose session id is missing or not a UUID, under a fresh one", () => {
		const store = new SessionStore({ ambient: processAmbient() });

		store.restore({
			"host.bad": { id: "bad", harness: "copilot", copilotSessionId: "nope", lastSeen: 1 },
			"host.none": { id: "none", harness: "copilot", lastSeen: 1 },
		});

		for (const team of ["host.bad", "host.none"]) {
			const record = store.getByTeam(team);
			expect(record?.harness, team).toBe("copilot");
			expect(record?.mintedSessionId, team).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
			);
		}
	});
});
