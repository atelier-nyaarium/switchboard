import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Watcher } from "../gateway/assistant/watcher.js";
import { type AssistantStageDeps, type AssistantVault, composeAssistant } from "../gateway/compose/composeAssistant.js";
import { processAmbient } from "../shared/ambient.js";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import { SessionStore } from "../shared/session-store.js";
import { type FakeAmbient, fakeAmbient } from "../testing/fakeAmbient.js";

const NOTES = "~/projects/notes";
const T0 = 1_800_000_000_000;

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function vault(): AssistantVault {
	const grants = new Map<string, string[]>();
	return {
		watcherGrants: (watcherId) => grants.get(watcherId) ?? [],
		setWatcherGrants: (watcherId, entryIds) => void grants.set(watcherId, entryIds),
		readForWatcher: async () => ({ kind: "released", value: "token" }),
	};
}

/** Stops each poll, counting them. */
function counting(): Watcher & { polls: number } {
	const watcher = {
		id: "github",
		label: "GitHub",
		fieldSpecs: [],
		polls: 0,
		poll: async () => {
			watcher.polls += 1;
			return { kind: "stopped" as const, reason: "test" };
		},
	};
	return watcher;
}

const noRoutes = () => {
	throw new Error("no Domain");
};

function stage(
	store = new SessionStore({ ambient: processAmbient() }),
	watchers?: Watcher[],
	ambient?: FakeAmbient,
	fetch: AssistantStageDeps["fetch"] = async () => {
		throw new Error("no network in tests");
	},
) {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-session-"));
	dirs.push(dataDir);
	const assistant = composeAssistant({
		dataDir,
		ambient: ambient ?? processAmbient(),
		sessions: { sessionStore: store, presence: store } as never,
		saveSessions: () => {},
		vault: vault(),
		routes: noRoutes,
		fetch,
		...(watchers ? { watchers } : {}),
	});
	return { assistant, store, forget: async (team: string) => void store.forget(team) };
}

/** Stop's wait needs manual time. */
async function stopped(assistant: ReturnType<typeof stage>["assistant"], ambient: FakeAmbient) {
	const done = assistant.stop();
	await ambient.advance(5_000);
	await done;
}

describe("the assistant's session", () => {
	it("is placed by the owner, reserved, and never plainly forgotten", async () => {
		const { assistant, store } = stage();

		const before = assistant.reserves(ASSISTANT_TEAM);
		const placed = await assistant.console.place(NOTES);
		const moved = await assistant.console.place("~/elsewhere");

		expect(before).toBe(false);
		expect(placed).toMatchObject({ workdir: NOTES, team: ASSISTANT_TEAM });
		expect(moved.workdir).toBe("~/elsewhere");
		expect(store.list()).toHaveLength(1);
		expect(assistant.reserves(ASSISTANT_TEAM)).toBe(true);
		expect(assistant.forgetRefusal(ASSISTANT_TEAM)).not.toBeNull();
	});

	it("refuses a folder the host cannot take, and a name a session it did not make holds", async () => {
		const fresh = stage();
		const squatted = new SessionStore({ ambient: processAmbient() });
		squatted.adoptById("assistant", { spawn: "host", sessionLabel: "mine" });
		const held = stage(squatted);

		await expect(fresh.assistant.console.place("relative/notes")).rejects.toThrow();
		await expect(held.assistant.console.place(NOTES)).rejects.toThrow();

		expect(fresh.store.list()).toHaveLength(0);
		expect(squatted.getByTeam(ASSISTANT_TEAM)).toMatchObject({ sessionLabel: "mine", workdirPath: undefined });
		expect(held.assistant.reserves(ASSISTANT_TEAM)).toBe(false);
	});

	it("polls its watchers only while placed, and a release stops them, drops their grants and forgets it", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const watcher = counting();
		const { assistant, forget } = stage(undefined, [watcher], ambient);

		assistant.start();
		await ambient.advance(0);
		const unplaced = watcher.polls;
		await assistant.console.place(NOTES);
		await ambient.advance(0);
		const placed = watcher.polls;
		await assistant.console.setWatcherGrants("github", ["gh-token"]);
		await ambient.advance(0);
		const releasing = assistant.console.release(forget);
		await ambient.advance(5_000);
		const released = await releasing;
		await ambient.advance(24 * 60 * 60 * 1000);
		const regrant = assistant.console.setWatcherGrants("github", ["gh-token"]);
		await stopped(assistant, ambient);

		expect(unplaced).toBe(0);
		expect(placed).toBe(1);
		expect(released).toMatchObject({ workdir: null, team: null });
		expect(released.watchers[0]?.grants).toEqual([]);
		expect(watcher.polls).toBe(2);
		await expect(regrant).rejects.toThrow();
	});

	it("changes nothing when the forget is refused", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const watcher = counting();
		const { assistant } = stage(undefined, [watcher], ambient);
		await assistant.console.place(NOTES);
		await assistant.console.setWatcherGrants("github", ["gh-token"]);
		assistant.start();
		await ambient.advance(0);
		const before = watcher.polls;

		const releasing = assistant.console.release(async () => {
			throw new Error("it is waking");
		});
		await expect(releasing).rejects.toThrow();
		const after = assistant.console.state();
		// Still running, so a retry polls it.
		await assistant.console.setWatcherGrants("github", ["gh-token"]);
		await ambient.advance(0);
		await stopped(assistant, ambient);

		expect(after).toMatchObject({ workdir: NOTES, team: ASSISTANT_TEAM });
		expect(after.watchers[0]?.grants).toEqual(["gh-token"]);
		expect(watcher.polls).toBeGreaterThan(before);
	});

	it("polls a stopped watcher again once the owner grants it a secret, and takes one secret", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const watcher = counting();
		const { assistant } = stage(undefined, [watcher], ambient);
		await assistant.console.place(NOTES);
		assistant.start();
		await ambient.advance(0);

		const granted = await assistant.console.setWatcherGrants("github", ["gh-token"]);
		await ambient.advance(0);
		await stopped(assistant, ambient);

		expect(granted.watchers[0]?.grants).toEqual(["gh-token"]);
		expect(watcher.polls).toBe(2);
		await expect(assistant.console.setWatcherGrants("gmail", [])).rejects.toThrow();
		await expect(assistant.console.setWatcherGrants("github", ["a", "b"])).rejects.toThrow();
	});

	it("keeps nothing a failed save cannot keep: a place rolls back, a release finishes and says so", async () => {
		const store = new SessionStore({ ambient: processAmbient() });
		const held = vault();
		let saves = false;
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-session-"));
		dirs.push(dataDir);
		const assistant = composeAssistant({
			dataDir,
			ambient: processAmbient(),
			sessions: { sessionStore: store, presence: store } as never,
			saveSessions: () => {
				if (!saves) throw new Error("disk full");
			},
			vault: held,
			routes: noRoutes,
			fetch: async () => new Response(null, { status: 304 }),
			watchers: [counting()],
		});
		const forget = async (team: string) => void store.forget(team);

		await expect(assistant.console.place(NOTES)).rejects.toThrow();
		const refusedPlace = store.list().length;
		saves = true;
		await assistant.console.place(NOTES);
		await assistant.console.setWatcherGrants("github", ["gh-token"]);
		saves = false;
		await expect(assistant.console.release(forget)).rejects.toThrow();
		const unsaved = assistant.console.state();
		saves = true;
		const retried = await assistant.console.release(forget);
		await assistant.stop();
		await expect(assistant.console.place("~/elsewhere")).rejects.toThrow();

		expect(refusedPlace).toBe(0);
		expect(unsaved.workdir).toBeNull();
		expect(held.watcherGrants("github")).toEqual([]);
		expect(retried.workdir).toBeNull();
	});

	it("starts a new placement ungranted, and refuses a grant that did not land", async () => {
		const store = new SessionStore({ ambient: processAmbient() });
		const held = vault();
		held.setWatcherGrants("github", ["left-behind"]);
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-session-"));
		dirs.push(dataDir);
		const assistant = composeAssistant({
			dataDir,
			ambient: processAmbient(),
			sessions: { sessionStore: store, presence: store } as never,
			saveSessions: () => {},
			vault: {
				...held,
				setWatcherGrants: (id, entryIds) => entryIds.length === 0 && held.setWatcherGrants(id, []),
			},
			routes: noRoutes,
			fetch: async () => new Response(null, { status: 304 }),
			watchers: [counting()],
		});

		const placed = await assistant.console.place(NOTES);

		expect(placed.watchers[0]?.grants).toEqual([]);
		await expect(assistant.console.setWatcherGrants("github", ["gh-token"])).rejects.toThrow();
	});

	it("asks GitHub nothing until a secret is granted, then asks with it", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const asked: string[] = [];
		const { assistant } = stage(undefined, undefined, ambient, async (_url, init) => {
			asked.push((init.headers as Record<string, string>).Authorization ?? "");
			return new Response(null, { status: 304 });
		});
		await assistant.console.place(NOTES);
		assistant.start();
		await ambient.advance(0);
		const ungranted = assistant.console.state().watchers[0]?.stopped;

		await assistant.console.setWatcherGrants("github", ["gh-token"]);
		await ambient.advance(0);
		await stopped(assistant, ambient);

		expect(ungranted).toBe("needs a secret");
		expect(asked).toEqual(["Bearer token"]);
	});
});
