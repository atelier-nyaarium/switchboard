import { describe, expect, it } from "vitest";
import { type PurgeHoldReaders, purgeHolds } from "../gateway/purgeHolds.js";
import { createPurgeQueue, PURGE_ENTRY_TTL_MS, type PurgeItem } from "../gateway/purgeQueue.js";
import type { HostOp, HostOpResult, HostPurgeOp, PurgeOutcome, TmuxTarget } from "../shared/host-op.js";
import type { SessionRecord } from "../shared/session-store.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const HOST = { kind: "host", workdirHint: "~" } as const;
const BOX = { kind: "devcontainer", project: "recipe-app" } as const;
const BOX_PATH = "/projects/recipe-app";
const PANE: TmuxTarget = { kind: "host", name: "host", sessionName: "work" };
const ID = "123e4567-e89b-42d3-a456-426614174000";

const thread = (threadId: string, place: PurgeItem["place"] = HOST): PurgeItem => ({
	place,
	what: { kind: "thread", backend: "codex", threadId },
});

/** A record as the guard reads it: its name, and the conversation it resumes once it says. */
interface Held {
	team: string;
	conversationId?: string;
}

function rig(options: { answer?: (op: HostPurgeOp) => PurgeOutcome | HostOpResult } = {}) {
	const ambient = fakeAmbient({ drive: "manual" });
	const queue = createPurgeQueue(ambient);
	const asked: HostPurgeOp[] = [];
	let live = true;
	let catalogued = true;
	const records: Held[] = [];
	/** Claude sessions a running run's named thread resumes. */
	const runSessions = new Set<string>();
	const record = (held: Held) =>
		({
			id: held.team.split(".")[1],
			spawn: held.team.split(".")[0],
			harness: "claude",
			claudeSessionId: held.conversationId,
		}) as SessionRecord;
	const readers: PurgeHoldReaders = {
		sessionStore: {
			// Host spawn points share one pane.
			paneOwner: (team) => {
				const id = team.split(".")[1];
				return (
					records.find((held) => held.team === team) ?? records.find((held) => held.team.split(".")[1] === id)
				)?.team;
			},
			getByTeam: (team) => {
				const held = records.find((candidate) => candidate.team === team);
				return held && record(held);
			},
			list: () => records.map(record),
		},
		runSessions: () => runSessions,
	};
	const start = () =>
		queue.start({
			relay: async (op: HostOp) => {
				if (op.kind !== "purge") throw new Error("not a purge");
				asked.push(op);
				const answer = options.answer?.(op) ?? "deleted";
				return typeof answer === "string" ? { ok: true, result: { outcome: answer } } : answer;
			},
			hostLive: () => live,
			holds: (entry) => purgeHolds(entry, readers),
			targetOf: (place) => {
				if (place.kind === "host") return { kind: "host", workdirHint: place.workdirHint };
				return catalogued ? { ...place, hostProjectPath: BOX_PATH } : undefined;
			},
		});
	const threads = () => asked.map((op) => (op.what.kind === "thread" ? op.what.threadId : op.what.kind));
	return {
		ambient,
		queue,
		asked,
		threads,
		start,
		setLive: (value: boolean) => {
			live = value;
		},
		setCatalogued: (value: boolean) => {
			catalogued = value;
		},
		records,
		runSessions,
	};
}

describe("the purge queue", () => {
	it("deletes each entry through the daemon, and forgets it once deleted or already gone", async () => {
		const r = rig({
			answer: (op) => (op.what.kind === "thread" && op.what.threadId === "t2" ? "gone" : "deleted"),
		});
		r.start();

		r.queue.add([thread("t1"), thread("t2"), { place: HOST, what: { kind: "claude", conversationId: ID } }]);
		await r.queue.idle();

		expect(r.threads()).toEqual(["t1", "t2", "claude"]);
		expect(r.queue.size()).toBe(0);
	});

	it("keeps a place that is down, asks it nothing more that pass, and asks again on a kick", async () => {
		let up = false;
		const r = rig({ answer: (op) => (op.target.kind === "devcontainer" && !up ? "place_down" : "deleted") });
		r.start();

		r.queue.add([thread("box-1", BOX), thread("box-2", BOX), thread("host-1")]);
		await r.queue.idle();
		expect(r.threads()).toEqual(["box-1", "host-1"]);
		expect(r.queue.size()).toBe(2);

		up = true;
		r.queue.kick();
		await r.queue.idle();
		expect(r.threads()).toEqual(["box-1", "host-1", "box-1", "box-2"]);
		expect(r.queue.size()).toBe(0);
	});

	it("asks a spawn point's own home, and a home that is down holds no other host entry", async () => {
		const windows = { ...HOST, spawn: "windows" };
		let reached = false;
		const r = rig({ answer: (op) => (op.hostSpawn === "windows" && !reached ? "place_down" : "deleted") });
		r.start();

		r.queue.add([thread("win-1", windows), thread("win-2", windows), thread("host-1", { ...HOST, spawn: "host" })]);
		await r.queue.idle();
		expect(r.asked.map((op) => [op.hostSpawn, op.target])).toEqual([
			["windows", HOST],
			["host", HOST],
		]);

		reached = true;
		r.queue.kick();
		await r.queue.idle();
		expect(r.asked.slice(2).map((op) => op.hostSpawn)).toEqual(["windows", "windows"]);
		expect(r.threads().slice(2)).toEqual(["win-1", "win-2"]);
	});

	it("keeps an entry whose delete failed, or that the daemon answered in a way it cannot read", async () => {
		const r = rig({
			answer: (op) =>
				op.what.kind === "thread" && op.what.threadId === "refused"
					? { ok: false, error: "unknown op" }
					: { ok: true, result: { killed: true } },
		});
		r.start();

		r.queue.add([thread("refused"), thread("misread")]);
		await r.queue.idle();

		expect(r.queue.size()).toBe(2);
	});

	it("asks nothing while no daemon is connected, and drains on the kick after one registers", async () => {
		const r = rig();
		r.setLive(false);
		r.start();
		r.queue.add([thread("t1")]);
		await r.queue.idle();
		expect(r.asked).toEqual([]);

		r.setLive(true);
		r.queue.kick();
		await r.queue.idle();
		expect(r.threads()).toEqual(["t1"]);
		expect(r.queue.size()).toBe(0);
	});

	it("asks again on its own after a failed pass, and drops an entry at thirty days without asking", async () => {
		const r = rig({ answer: () => ({ ok: false, error: "busy" }) });
		r.start();
		r.queue.add([thread("t1")]);
		await r.queue.idle();
		expect(r.threads()).toEqual(["t1"]);

		await r.ambient.advance(2 * 60 * 60_000);
		await r.queue.idle();
		expect(r.asked.length).toBeGreaterThan(1);
		expect(r.queue.size()).toBe(1);

		// Every delete still fails, so only its age can take it out.
		await r.ambient.advance(PURGE_ENTRY_TTL_MS);
		await r.queue.idle();
		expect(r.queue.size()).toBe(0);
	});

	it("keeps a container the daemon's catalog does not name, and asks it by its path once it does", async () => {
		const r = rig();
		r.setCatalogued(false);
		r.start();

		r.queue.add([thread("box-1", BOX), thread("host-1")]);
		await r.queue.idle();
		expect(r.threads()).toEqual(["host-1"]);
		expect(r.queue.size()).toBe(1);

		r.setCatalogued(true);
		r.queue.kick();
		await r.queue.idle();
		expect(r.asked.at(-1)?.target).toEqual({ ...BOX, hostProjectPath: BOX_PATH });
		expect(r.queue.size()).toBe(0);
	});

	it("leaves the pane and the files of a name a new session holds, and the conversation that session took", async () => {
		const entries: PurgeItem[] = [
			{ place: HOST, what: { kind: "claude", conversationId: ID }, pane: PANE },
			{ place: HOST, what: { kind: "files", session: PANE }, pane: PANE },
		];
		const r = rig();
		const holder: Held = { team: "host.work" };
		r.records.push(holder);
		r.start();

		// Not yet registered: the conversation may turn out to be its own.
		r.queue.add(entries);
		await r.queue.idle();
		expect(r.asked).toEqual([]);
		expect(r.queue.snapshot().map((entry) => entry.what.kind)).toEqual(["claude"]);

		holder.conversationId = "another";
		r.queue.kick();
		await r.queue.idle();
		expect(r.asked).toEqual([{ kind: "purge", target: HOST, what: { kind: "claude", conversationId: ID } }]);

		holder.conversationId = ID;
		r.queue.add(entries);
		await r.queue.idle();
		expect(r.asked).toHaveLength(1);
		expect(r.queue.size()).toBe(0);
	});

	it("deletes the files of a name whose pane another host spawn point's session took, and leaves that pane", async () => {
		const pane: TmuxTarget = { kind: "host", name: "windows", sessionName: "work" };
		const r = rig();
		r.records.push({ team: "host.work", conversationId: "another" });
		r.start();

		r.queue.add([{ place: { ...HOST, spawn: "windows" }, what: { kind: "files", session: pane }, pane }]);
		await r.queue.idle();

		expect(r.asked).toEqual([
			{ kind: "purge", target: HOST, what: { kind: "files", session: pane }, hostSpawn: "windows" },
		]);
	});

	it("asks nothing for an entry taken back before its caller returned", async () => {
		const r = rig();
		r.start();

		r.queue.add([thread("kept"), thread("undone")]);
		r.queue.withdraw([thread("undone")]);
		await r.queue.idle();

		expect(r.threads()).toEqual(["kept"]);
	});

	it("leaves a conversation another session resumed into while its delete waited", async () => {
		const r = rig();
		r.setLive(false);
		r.start();
		r.queue.add([{ place: HOST, what: { kind: "claude", conversationId: ID }, pane: PANE }, thread("t1")]);
		await r.queue.idle();

		r.records.push({ team: "host.other", conversationId: ID });
		r.setLive(true);
		r.queue.kick();
		await r.queue.idle();

		expect(r.threads()).toEqual(["t1"]);
		expect(r.queue.size()).toBe(0);
	});

	it("leaves a Claude session a running run's named thread resumes, and no thread of that id", async () => {
		const r = rig();
		r.runSessions.add(ID);
		r.start();

		r.queue.add([{ place: HOST, what: { kind: "claude", conversationId: ID } }, thread(ID)]);
		await r.queue.idle();

		expect(r.threads()).toEqual([ID]);
		expect(r.queue.size()).toBe(0);
	});

	it("takes back only what its own add queued", async () => {
		const r = rig();
		r.setLive(false);
		r.start();

		r.queue.add([thread("shared")]);
		r.queue.withdraw(r.queue.add([thread("shared"), thread("mine")]));

		expect(r.queue.snapshot().map((entry) => (entry.what.kind === "thread" ? entry.what.threadId : ""))).toEqual([
			"shared",
		]);
	});

	it("restores what a snapshot held, drops what it cannot read, and holds one thing once", async () => {
		const first = rig();
		first.setLive(false);
		first.start();
		first.queue.add([thread("t1"), thread("t1"), thread("t2", BOX)]);
		const saved = JSON.parse(JSON.stringify(first.queue.snapshot())) as unknown[];
		expect(saved).toHaveLength(2);

		const second = rig();
		second.queue.restore([...saved, { what: "nonsense" }]);
		second.start();
		await second.queue.idle();

		expect(second.threads()).toEqual(["t1", "t2"]);
		expect(second.queue.size()).toBe(0);
	});

	it("counts a 7 day removal's delete that still found data, and keeps the count across a restore", async () => {
		const r = rig({
			answer: (op) => (op.what.kind === "thread" && op.what.threadId === "left" ? "deleted" : "gone"),
		});
		r.start();

		r.queue.add([{ ...thread("left"), backstop: true }, { ...thread("clean"), backstop: true }, thread("left-2")]);
		await r.queue.idle();
		expect(r.queue.tally()).toMatchObject({ found: 1 });

		// A miss already waiting when the removal names it still counts.
		r.setLive(false);
		r.queue.add([thread("left")]);
		r.queue.add([{ ...thread("left"), backstop: true }]);
		r.setLive(true);
		r.queue.kick();
		await r.queue.idle();
		expect(r.queue.tally()).toMatchObject({ found: 2 });

		r.queue.found(2, "agents");
		r.queue.found(0, "agents");
		const saved = JSON.parse(JSON.stringify(r.queue.tally())) as unknown;
		const next = rig();
		next.queue.restoreTally({ found: "many" });
		expect(next.queue.tally()).toEqual({ found: 0, lastAt: null });
		next.queue.restoreTally(saved);
		expect(next.queue.tally()).toEqual({ found: 4, lastAt: expect.any(Number) });
	});
});
