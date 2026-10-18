import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRulesStore } from "../gateway/assistant/rulesStore.js";
import type { PollAnswer, Watcher, WatcherEvent } from "../gateway/assistant/watcher.js";
import { type AssistantVault, composeAssistant } from "../gateway/compose/composeAssistant.js";
import { processAmbient } from "../shared/ambient.js";
import { DurableStore } from "../shared/durable-store.js";
import { type AssistantRule, type AssistantWatcherRules, decideEvent } from "../shared/schemasAssistantRules.js";
import { SessionStore } from "../shared/session-store.js";
import { type FakeAmbient, fakeAmbient } from "../testing/fakeAmbient.js";

const T0 = 1_800_000_000_000;
const FIELDS = ["reason", "repository"];

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const freshDir = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-rules-"));
	dirs.push(dir);
	return dir;
};

const rule = (
	id: string,
	value: string,
	action: AssistantRule["action"],
	extra: Partial<AssistantRule> = {},
): AssistantRule => ({ id, conditions: [{ field: "reason", test: "is", value }], action, revision: 0, ...extra });

const event = (sourceId: string, reason: string): WatcherEvent => ({
	sourceId,
	at: 1,
	title: `${reason} ${sourceId}`,
	fields: { reason, repository: "atelier/app" },
});

/** Next batch per poll. */
function feed(batches: WatcherEvent[][]): Watcher {
	return {
		id: "github",
		fields: FIELDS,
		pingDefault: false,
		poll: async (): Promise<PollAnswer> => ({
			kind: "events",
			events: batches.shift() ?? [],
			cursor: "c",
			nextPollMs: 60_000,
		}),
	};
}

function stage(dataDir: string, watcher: Watcher, ambient: FakeAmbient) {
	const store = new SessionStore({ ambient: processAmbient() });
	const grants = new Map<string, string[]>();
	const vault: AssistantVault = {
		watcherGrants: (id) => grants.get(id) ?? [],
		setWatcherGrants: (id, entryIds) => void grants.set(id, entryIds),
		readForWatcher: async () => ({ kind: "released", value: "token" }),
	};
	return composeAssistant({
		dataDir,
		ambient,
		sessions: { sessionStore: store, presence: store } as never,
		saveSessions: () => {},
		vault,
		fetch: async () => new Response(null, { status: 304 }),
		watchers: [watcher],
	});
}

function rulesStore(dir = freshDir(), store?: DurableStore) {
	const changes: string[] = [];
	const rules = createRulesStore({
		store: store ?? new DurableStore(dir, "assistant-rules"),
		fieldsOf: (watcherId) => (watcherId === "github" ? FIELDS : undefined),
		onChanged: (watcherId) => void changes.push(watcherId),
	});
	return { rules, changes };
}

/** Polls the feed once, then stops the stage. */
async function polledOnce(dir: string, watcher: Watcher, ambient: FakeAmbient, setup: (a: Stage) => Promise<void>) {
	const assistant = stage(dir, watcher, ambient);
	await assistant.console.place("~/notes");
	await setup(assistant);
	assistant.start();
	await ambient.advance(0);
	return assistant;
}

type Stage = ReturnType<typeof stage>;

async function stopped(assistant: Stage, ambient: FakeAmbient) {
	const done = assistant.stop();
	await ambient.advance(5_000);
	await done;
}

describe("a watcher's rules", () => {
	it("decide by the first rule whose every condition holds, case aside, and anything else takes the fallback", () => {
		const rules: AssistantWatcherRules = {
			rules: [
				rule("a", "Review_Requested", "wake", { ping: true }),
				{
					id: "b",
					conditions: [
						{ field: "reason", test: "is_not", value: "subscribed" },
						{ field: "repository", test: "contains", value: "atelier" },
					],
					action: "inbox",
					revision: 1,
				},
				rule("c", "subscribed", "drop"),
			],
			otherwise: { action: "drop", revision: 1 },
			revision: 4,
		};

		expect(decideEvent(rules, { reason: "review_requested", repository: "x/y" }, false)).toEqual({
			action: "wake",
			ping: true,
			rulesRevision: 4,
		});
		expect(decideEvent(rules, { reason: "mention", repository: "atelier/app" }, false).action).toBe("inbox");
		expect(decideEvent(rules, { reason: "subscribed", repository: "atelier/app" }, false).action).toBe("drop");
		// A drop never pings, whatever the default.
		expect(decideEvent(rules, { reason: "mention", repository: "x/y" }, true)).toMatchObject({
			action: "drop",
			ping: false,
		});
	});

	it("store one rule at a time, each at its own revision, and refuse a stale edit with the held rules", () => {
		const { rules, changes } = rulesStore();
		rules.putRule("github", rule("a", "mention", "wake"));
		rules.putRule("github", rule("b", "subscribed", "drop"));

		// Both opened at list revision 2; edits to two rules do not collide.
		const editA = rules.putRule("github", rule("a", "mention", "inbox", { revision: 1 }));
		const editB = rules.putRule("github", rule("b", "subscribed", "inbox", { revision: 1 }));
		const staleA = rules.putRule("github", rule("a", "mention", "drop", { revision: 1 }));

		expect(editA.stored && editB.stored).toBe(true);
		expect(staleA).toMatchObject({ stored: false, rules: { revision: 4 } });
		expect(staleA.rules.rules.map((held) => [held.id, held.action, held.revision])).toEqual([
			["a", "inbox", 2],
			["b", "inbox", 2],
		]);
		expect(changes).toHaveLength(4);
	});

	it("answer a retry whose first answer was lost as stored, without writing again", () => {
		const { rules, changes } = rulesStore();
		const added = rule("a", " subscribed ", "drop", { ping: true });

		rules.putRule("github", added);
		const retried = rules.putRule("github", added);
		const other = rules.putRule("github", rule("a", "mention", "drop"));

		expect(retried).toMatchObject({ stored: true, rules: { revision: 1 } });
		expect(other.stored).toBe(false);
		expect(changes).toHaveLength(1);
		// Trimmed, and a drop keeps no ping.
		expect(rules.get("github").rules).toEqual([
			{
				id: "a",
				conditions: [{ field: "reason", test: "is", value: "subscribed" }],
				action: "drop",
				revision: 1,
			},
		]);
	});

	it("keep a deleted rule deleted, and answer a repeated delete as done", () => {
		const { rules } = rulesStore();
		rules.putRule("github", rule("a", "mention", "wake"));

		const deleted = rules.deleteRule("github", "a", 1);
		const again = rules.deleteRule("github", "a", 1);
		const revived = rules.putRule("github", rule("a", "mention", "wake"));
		const edited = rules.putRule("github", rule("a", "mention", "wake", { revision: 1 }));

		expect(deleted.stored && again.stored).toBe(true);
		expect(revived.stored || edited.stored).toBe(false);
		expect(rules.get("github").rules).toEqual([]);
	});

	it("move a rule over the list it was drawn from, answer a repeat as done, and refuse a stale order", () => {
		const { rules, changes } = rulesStore();
		for (const id of ["a", "b", "c"]) rules.putRule("github", rule(id, id, "inbox"));

		rules.moveRule("github", "c", "a", 3);
		const repeat = rules.moveRule("github", "c", "a", 3);
		// Drawn before the move landed.
		const stale = rules.moveRule("github", "b", "c", 3);
		const gone = rules.moveRule("github", "b", "zzz", 4);

		expect(rules.get("github").rules.map((held) => held.id)).toEqual(["c", "a", "b"]);
		expect(repeat.stored).toBe(true);
		expect(stale).toMatchObject({ stored: false, rules: { revision: 4 } });
		expect(gone.stored).toBe(false);
		expect(changes).toHaveLength(4);
	});

	it("refuse a rule on a field the watcher lacks, an unknown watcher, and a write that fails", () => {
		let fail = false;
		const dir = freshDir();
		const disk = new DurableStore(dir, "assistant-rules");
		const flaky = Object.assign(Object.create(disk), {
			saveChecked(state: unknown) {
				if (fail) throw new Error("disk full");
				disk.saveChecked(state);
			},
		}) as DurableStore;
		const { rules, changes } = rulesStore(dir, flaky);
		const label: AssistantRule = {
			...rule("a", "x", "drop"),
			conditions: [{ field: "label", test: "is", value: "x" }],
		};

		fail = true;
		const failed = rules.putRule("github", rule("a", "x", "drop"));

		expect(rules.putRule("github", label).stored).toBe(false);
		expect(rules.putRule("gitlab", rule("a", "x", "drop")).stored).toBe(false);
		expect(failed).toMatchObject({ stored: false, rules: { revision: 0 } });
		expect(changes).toEqual([]);
	});

	it("start fresh over a file that names one rule id twice", () => {
		const dir = freshDir();
		const twice = {
			id: "a",
			conditions: [{ field: "reason", test: "is", value: "x" }],
			action: "drop",
			revision: 1,
		};
		new DurableStore(dir, "assistant-rules").saveChecked({
			v: 1,
			watchers: { github: { rules: [twice, twice], otherwise: { action: "inbox", revision: 0 }, revision: 2 } },
		});

		expect(rulesStore(dir).rules.get("github").rules).toEqual([]);
	});

	it("sort each event as it lands, and a save replays the kept drops it now catches", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const assistant = await polledOnce(
			freshDir(),
			feed([[event("1", "subscribed"), event("2", "mention")]]),
			ambient,
			async (a) => {
				await a.console.putRule("github", rule("drops", "subscribed", "drop"));
			},
		);
		const sorted = assistant.console.state().watchers[0];
		const atelier: AssistantRule = {
			id: "atelier",
			conditions: [{ field: "repository", test: "contains", value: "ATELIER" }],
			action: "wake",
			revision: 0,
		};
		const last = assistant.console.previewRule("github", atelier);

		const freed = await assistant.console.deleteRule("github", "drops", 1);
		await stopped(assistant, ambient);

		expect(sorted).toMatchObject({ unread: 1, dropped: 1 });
		// After the drop rule, it decides only what that rule leaves.
		expect(last).toMatchObject({ decided: 1, shadowed: 1, of: 2, titles: ["mention 2"] });
		expect(freed.stored).toBe(true);
		expect(assistant.console.state().watchers[0]).toMatchObject({ unread: 2, dropped: 0, rules: { revision: 2 } });
		expect(() =>
			assistant.console.previewRule("github", {
				...atelier,
				conditions: [{ field: "label", test: "is", value: "x" }],
			}),
		).toThrow();
		// The deleted rule refuses a preview as its put would.
		expect(() =>
			assistant.console.previewRule("github", rule("drops", "subscribed", "drop", { revision: 1 })),
		).toThrow();
	});

	it("catch up at start when a crash left the inbox behind the rules", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const dir = freshDir();
		const first = await polledOnce(dir, feed([[event("1", "subscribed")]]), ambient, async (a) => {
			await a.console.putRule("github", rule("drops", "subscribed", "drop"));
		});
		await stopped(first, ambient);
		// Crash before the resort.
		createRulesStore({
			store: new DurableStore(dir, "assistant-rules"),
			fieldsOf: () => FIELDS,
			onChanged: () => {},
		}).deleteRule("github", "drops", 1);

		const second = stage(dir, feed([]), ambient);

		expect(second.console.state().watchers[0]).toMatchObject({ unread: 1, dropped: 0 });
	});

	it("sort again under the defaults when the rules file starts fresh", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const dir = freshDir();
		const first = await polledOnce(dir, feed([[event("1", "subscribed")]]), ambient, async (a) => {
			await a.console.putRule("github", rule("drops", "subscribed", "drop"));
		});
		await stopped(first, ambient);
		fs.rmSync(path.join(dir, "assistant-rules.json"));

		const second = stage(dir, feed([]), ambient);

		expect(second.console.state().watchers[0]).toMatchObject({ unread: 1, dropped: 0, rules: { revision: 0 } });
	});
});
